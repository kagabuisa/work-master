'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

test('version 18 retry audit upgrade retains saved responses and financial records', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    const { invoiceId } = await seedGoldenData();
    const pool = store.getPostgresPool();
    const user = await require('../src/auth').createUser('retry-upgrade', 'UpgradePass123!', { role: 'standard' });
    const before = (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app_invoice_payments p) AS payments,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM app_gl_entries g) AS ledger`)).rows[0];
    await pool.query(`ALTER TABLE wm_api_idempotency DROP COLUMN resource_type;
      ALTER TABLE wm_api_idempotency DROP COLUMN resource_id;
      DELETE FROM wm_schema_version WHERE version=19`);
    const body = { data: { id: String(invoiceId) } };
    await pool.query(`INSERT INTO wm_api_idempotency(actor_id,operation,resource_path,key,payload_hash,response,status,expires_at)
      VALUES ($1,'invoice.submit',$2,'old-key','old-hash',$3::jsonb,200,now()+interval '1 day')`, [user.id, `/invoices/${invoiceId}/submit`, JSON.stringify(body)]);
    await store.initStore();
    const result = (await pool.query("SELECT response,status,resource_type,resource_id FROM wm_api_idempotency WHERE key='old-key'")).rows[0];
    assert.deepEqual(result, { response: body, status: 200, resource_type: 'invoice', resource_id: String(invoiceId) });
    assert.deepEqual((await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app_invoice_payments p) AS payments,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM app_gl_entries g) AS ledger`)).rows[0], before);
    await store.initStore();
    assert.deepEqual((await pool.query("SELECT response FROM wm_api_idempotency WHERE key='old-key'")).rows[0].response, body);
  } finally { await store.closeStore(); }
});

test('version 17 API upgrade preserves existing financial rows and ordinary users', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const user = await require('../src/auth').createUser('upgrade-user', 'UpgradePass123!', { role: 'standard' });
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app_invoice_payments p) AS payments,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM app_gl_entries g) AS ledger,
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM app_journal_entries j) AS journals`)).rows[0];
    const before = await snapshot();
    await pool.query(`DROP TABLE wm_api_refresh_tokens,wm_api_sessions,wm_api_credentials,
      wm_api_audit,wm_api_idempotency,wm_api_payment_references,wm_api_rate_limits;
      ALTER TABLE app_users DROP COLUMN api_service_account;
      DELETE FROM wm_schema_version WHERE version IN (18,19)`);
    await store.initStore();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await pool.query('SELECT api_service_account FROM app_users WHERE id=$1', [user.id])).rows[0].api_service_account, false);
    assert(await require('../src/auth').authenticate(user.username, 'UpgradePass123!'));
    await store.initStore();
    assert.deepEqual(await snapshot(), before);
  } finally { await store.closeStore(); }
});

test('version 1 upgrades once without duplicating accounting postings', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const before = (await pool.query(`
      SELECT (SELECT count(*)::int FROM app_gl_entries) AS gl,
        (SELECT count(*)::int FROM app_journal_entries) AS journals
    `)).rows[0];
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19)');
    await pool.query("INSERT INTO wm_schema_version (version, name) VALUES (1, 'baseline')");

    await store.initStore();
    assert.deepEqual((await pool.query('SELECT version FROM wm_schema_version ORDER BY version')).rows,
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }]);
    const journalReferenceIndex = await pool.query(`SELECT 1 FROM pg_indexes
      WHERE tablename = 'app_journal_entries'
        AND indexname = 'app_journal_entries_invoice_reference_idx'`);
    assert.equal(journalReferenceIndex.rowCount, 1);
    const costCenterColumns = await pool.query(`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'cost_center'
        AND table_name IN ('app_purchases', 'app_purchase_orders', 'app_stock_entries',
          'app_gl_entries', 'app_journal_entries')
      ORDER BY table_name
    `);
    assert.deepEqual(costCenterColumns.rows.map((row) => row.table_name),
      ['app_gl_entries', 'app_journal_entries', 'app_purchase_orders',
        'app_purchases', 'app_stock_entries']);
    const reportColumns = await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'app_users' AND column_name = 'invoice_report_columns'`);
    assert.equal(reportColumns.rowCount, 1);
    const voucherReportColumns = await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'app_users' AND column_name IN
        ('purchase_report_columns', 'purchase_order_report_columns', 'journal_report_columns')
      ORDER BY column_name`);
    assert.deepEqual(voucherReportColumns.rows.map((row) => row.column_name),
      ['journal_report_columns', 'purchase_order_report_columns', 'purchase_report_columns']);
    const accessColumn = await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'app_users' AND column_name = 'record_access'`);
    assert.equal(accessColumn.rowCount, 1);
    const activityColumn = await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'app_user_sessions' AND column_name = 'last_activity_at'`);
    assert.equal(activityColumn.rowCount, 1);
    await store.initStore();
    const after = (await pool.query(`
      SELECT (SELECT count(*)::int FROM app_gl_entries) AS gl,
        (SELECT count(*)::int FROM app_journal_entries) AS journals
    `)).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await store.closeStore();
  }
});

test('version 4 databases gain missing invoice item snapshot columns', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query(`INSERT INTO app_master_items (item_code, item_name, category, source, unit_cost)
      VALUES ($1, $2, 'Hardware', 'Import', 42)
      ON CONFLICT (item_code) DO UPDATE SET category = EXCLUDED.category,
        source = EXCLUDED.source, unit_cost = EXCLUDED.unit_cost`, [FIXED.itemCode, FIXED.itemName]);
    for (const column of ['item_category', 'source', 'cost']) {
      await pool.query(`ALTER TABLE app_invoice_items DROP COLUMN ${column}`);
    }
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19)');

    await store.initStore();
    const snapshot = await pool.query(`SELECT item_category, source, cost::float
      FROM app_invoice_items WHERE item_code = $1 LIMIT 1`, [FIXED.itemCode]);
    assert.deepEqual(snapshot.rows[0], { item_category: 'Hardware', source: 'Import', cost: 42 });
    const id = await store.createInvoice({ invoice_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 180 }] });
    assert.equal((await store.findInvoice(id)).items[0].item_category, 'Hardware');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, 19);
  } finally {
    await store.closeStore();
  }
});

test('version 8 databases gain the session activity column', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query('ALTER TABLE app_user_sessions DROP COLUMN IF EXISTS last_activity_at');
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19)');

    await store.initStore();

    const activityColumn = await pool.query(`SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'app_user_sessions' AND column_name = 'last_activity_at'`);
    assert.equal(activityColumn.rows[0].is_nullable, 'NO');
    assert.equal(activityColumn.rows[0].column_default, 'now()');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, 19);
  } finally {
    await store.closeStore();
  }
});


test('version 14 profiles gain personal details without losing employment dates', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const pool = store.getPostgresPool();
  try {
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_hr_test$/);
    await store.initStore();
    await pool.query("INSERT INTO app_master_employees(employee_id,employee_name) VALUES('MIGRATION-DETAILS','Migration details') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO app_hr_profiles(employee_id,joining_date) VALUES('MIGRATION-DETAILS','2026-01-01') ON CONFLICT(employee_id) DO UPDATE SET joining_date=EXCLUDED.joining_date");
    await pool.query('ALTER TABLE app_hr_profiles DROP COLUMN details');
    await pool.query('DELETE FROM wm_schema_version WHERE version>=15');
    await store.initStore();
    const profile=(await pool.query("SELECT joining_date::text,details FROM app_hr_profiles WHERE employee_id='MIGRATION-DETAILS'")).rows[0];
    assert.deepEqual(profile,{joining_date:'2026-01-01',details:{}});
    await pool.query("UPDATE app_hr_profiles SET details='{\"nationality\":\"Ugandan\"}'::jsonb WHERE employee_id='MIGRATION-DETAILS'");
    await store.initStore();
    assert.equal((await pool.query("SELECT details FROM app_hr_profiles WHERE employee_id='MIGRATION-DETAILS'")).rows[0].details.nationality,'Ugandan');
  } finally { await store.closeStore(); }
});


test('version 15 employee statuses reconcile legacy flags', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await store.initStore();
    const pool=store.getPostgresPool();
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_hr_test$/);
    await pool.query("INSERT INTO app_master_employees(employee_id,employee_name,status,disabled) VALUES ('STATUS-A','A','Active',true),('STATUS-L','L','Left',false),('STATUS-OLD','Old',NULL,true),('STATUS-BLANK','Blank',NULL,false)");
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (16,17,18,19)');
    await store.initStore();
    const rows=(await pool.query("SELECT employee_id,status,disabled FROM app_master_employees WHERE employee_id LIKE 'STATUS-%' ORDER BY employee_id")).rows;
    assert.deepEqual(rows,[{employee_id:'STATUS-A',status:'Active',disabled:false},{employee_id:'STATUS-BLANK',status:null,disabled:false},{employee_id:'STATUS-L',status:'Left',disabled:true},{employee_id:'STATUS-OLD',status:'Left',disabled:true}]);
  } finally { await store.closeStore(); }
});
