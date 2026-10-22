'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { SCHEMA_VERSION } = require('../src/migrate');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

test('v46 money upgrade preserves posted history and guarded function privileges', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const fs = require('node:fs'), path = require('node:path');
    const old = fs.readFileSync(path.join(__dirname, '../src/sql/inventory-control.sql'), 'utf8')
      .match(/CREATE FUNCTION wm_inventory_apply\(m jsonb\)[\s\S]+?END \$\$;/)[0];
    await pool.query(old.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/sql/inventory-document-rules.sql'), 'utf8'));
    await pool.query(`ALTER TABLE app_invoice_items ALTER COLUMN unit_price TYPE numeric(14,2);
      ALTER TABLE app_stock_ledger DROP COLUMN reversal_of_ledger_id;
      DELETE FROM wm_schema_version WHERE version>=47`);
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoices i) invoices,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoice_items i) items,
      (SELECT jsonb_agg(to_jsonb(l)-'reversal_of_ledger_id' ORDER BY id) FROM app_stock_ledger l) stock,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY item_code,warehouse) FROM app_stock_balances b) balances,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) gl,
      (SELECT jsonb_build_object('oid',oid::text,'owner',proowner,'acl',proacl,'security_definer',prosecdef,'config',proconfig)
        FROM pg_proc WHERE oid='wm_inventory_apply(jsonb)'::regprocedure) guarded_function`)).rows[0];
    const before = await snapshot();
    await store.initStore();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await pool.query("SELECT format_type(atttypid,atttypmod) type FROM pg_attribute WHERE attrelid='app_invoice_items'::regclass AND attname='unit_price'")).rows[0].type, 'numeric(18,6)');
    assert.match((await pool.query("SELECT pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure) definition")).rows[0].definition, /exact_stock_values/);
    await store.initStore();
    assert.deepEqual(await snapshot(), before);
  } finally { await store.closeStore(); }
});

test('history optimisations upgrade v42/v43/v44 without rewriting stock, accounting or helper privileges', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();const pool=store.getPostgresPool();
    const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/sql/inventory-document-rules.sql'),'utf8');
    const snapshot=async()=> (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoices i) invoices,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) stock,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY item_code,warehouse) FROM app_stock_balances b) balances,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) accounting,
      (SELECT jsonb_build_object('oid',oid::text,'owner',proowner,'acl',proacl,'security_definer',prosecdef,'config',proconfig)
        FROM pg_proc WHERE oid='wm_inventory_check_history(wm_inventory_events,jsonb)'::regprocedure) helper`)).rows[0];
    for (const version of [42,43,44]) {
      if(version===42)await pool.query(sql.match(/CREATE OR REPLACE FUNCTION wm_inventory_check_history[\s\S]+?END \$\$;/)[0]);
      else await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/sql/inventory-history-suffix.sql'),'utf8'));
      if(version===44)await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/sql/inventory-history-source-lookups.sql'),'utf8'));
      await pool.query('DELETE FROM wm_schema_version WHERE version>$1',[version]);
      const before=await snapshot();
      await store.initStore();
      assert.deepEqual(await snapshot(),before);
      assert.equal((await pool.query("SELECT has_function_privilege('public','wm_inventory_check_history(wm_inventory_events,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
      assert.equal((await pool.query('SELECT max(version)::int version FROM wm_schema_version')).rows[0].version,SCHEMA_VERSION);
      await store.initStore();assert.deepEqual(await snapshot(),before);
    }
  } finally {await store.closeStore();}
});

test('read/write sharing migration preserves existing read-only shares and financial records', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const users = (await pool.query(`INSERT INTO app_users(username,password_hash)
      VALUES ('share-upgrade-owner','unused'),('share-upgrade-recipient','unused') RETURNING id`)).rows;
    const id = (await pool.query("SELECT id FROM app_stock_entries WHERE entry_type <> 'reconciliation' ORDER BY id LIMIT 1")).rows[0].id;
    await pool.query('INSERT INTO app_stock_entry_shares(stock_entry_id,user_id,granted_by_user_id) VALUES ($1,$2,$3)', [id, users[1].id, users[0].id]);
    await pool.query('ALTER TABLE app_stock_entry_shares DROP COLUMN permission');
    await pool.query('DELETE FROM wm_schema_version WHERE version>=40');
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app_stock_entries s) AS documents,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) AS stock,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) AS accounting,
      (SELECT jsonb_agg(to_jsonb(s)-'permission' ORDER BY user_id) FROM app_stock_entry_shares s) AS shares`)).rows[0];
    const before = await snapshot();
    await store.initStore();
    assert.equal((await pool.query('SELECT permission FROM app_stock_entry_shares WHERE stock_entry_id=$1 AND user_id=$2', [id, users[1].id])).rows[0].permission, 'read');
    assert.deepEqual(await snapshot(), before);
    await store.initStore();
    assert.deepEqual(await snapshot(), before);
  } finally { await store.closeStore(); }
});

test('master names are unique across case and surrounding whitespace without changing master IDs', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    for (const [table, id, name] of [
      ['app_master_employees', 'employee_id', 'employee_name'],
      ['app_master_cost_centers', 'cost_center', 'cost_center_name'],
    ]) {
      await pool.query(`INSERT INTO ${table}(${id},${name}) VALUES ('NAME-ONE','Unique Name'),('NAME-TWO','Other Name')`);
      await assert.rejects(pool.query(`INSERT INTO ${table}(${id},${name}) VALUES ('NAME-THREE',' unique name ')`), { code: '23505' });
      await assert.rejects(pool.query(`UPDATE ${table} SET ${name}='UNIQUE NAME' WHERE ${id}='NAME-TWO'`), { code: '23505' });
      assert.deepEqual((await pool.query(`SELECT ${id} AS id FROM ${table} ORDER BY ${id}`)).rows.map(row => row.id), ['NAME-ONE', 'NAME-TWO']);
    }
    const account = (await pool.query('SELECT account_name FROM app_accounts ORDER BY id LIMIT 1')).rows[0];
    await assert.rejects(pool.query(`INSERT INTO app_accounts(account_code,account_name,account_type,normal_balance)
      VALUES ('NAME-TEST',$1,'asset','debit')`, [` ${account.account_name.toUpperCase()} `]), { code: '23505' });
    await store.initStore();
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, SCHEMA_VERSION);
  } finally { await store.closeStore(); }
});

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
      DELETE FROM wm_schema_version WHERE version>=19`);
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
      DELETE FROM wm_schema_version WHERE version IN (18,19,20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47)`);
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47)');
    await pool.query("INSERT INTO wm_schema_version (version, name) VALUES (1, 'baseline')");

    await store.initStore();
    assert.deepEqual((await pool.query('SELECT version FROM wm_schema_version ORDER BY version')).rows,
      Array.from({ length: SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47)');

    await store.initStore();
    const snapshot = await pool.query(`SELECT item_category, source, cost::float
      FROM app_invoice_items WHERE item_code = $1 LIMIT 1`, [FIXED.itemCode]);
    assert.deepEqual(snapshot.rows[0], { item_category: 'Hardware', source: 'Import', cost: 42 });
    const id = await store.createInvoice({ invoice_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 180 }] });
    assert.equal((await store.findInvoice(id)).items[0].item_category, 'Hardware');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, SCHEMA_VERSION);
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47)');

    await store.initStore();

    const activityColumn = await pool.query(`SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'app_user_sessions' AND column_name = 'last_activity_at'`);
    assert.equal(activityColumn.rows[0].is_nullable, 'NO');
    assert.equal(activityColumn.rows[0].column_default, 'now()');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, SCHEMA_VERSION);
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (16,17,18,19,20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47)');
    await store.initStore();
    const rows=(await pool.query("SELECT employee_id,status,disabled FROM app_master_employees WHERE employee_id LIKE 'STATUS-%' ORDER BY employee_id")).rows;
    assert.deepEqual(rows,[{employee_id:'STATUS-A',status:'Active',disabled:false},{employee_id:'STATUS-BLANK',status:null,disabled:false},{employee_id:'STATUS-L',status:'Left',disabled:true},{employee_id:'STATUS-OLD',status:'Left',disabled:true}]);
  } finally { await store.closeStore(); }
});


test('posting-event lookup upgrades v37 without changing postings and recovers an invalid concurrent build', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const metadata = async () => (await pool.query(`SELECT i.indexrelid::text AS oid,
      i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i WHERE i.indexrelid=to_regclass('app_stock_ledger_posting_event_idx')`)).rows[0];
    const assertLookup = async () => {
      const index = await metadata();
      assert.equal(index?.indisvalid, true);
      assert.equal(index.indisready, true);
      assert.match(index.definition, /ON public.app_stock_ledger USING btree \(posting_event_id\)/);
      assert.match(index.definition, /WHERE \(posting_event_id IS NOT NULL\)/);
      return index.oid;
    };
    // A fresh installation must include the same valid lookup.
    await assertLookup();
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoices i) invoices,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) gl,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) stock,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY item_code,warehouse) FROM app_stock_balances b) balances`)).rows[0];
    const before = await snapshot();
    await pool.query('DROP INDEX app_stock_ledger_posting_event_idx');
    await pool.query('DELETE FROM wm_schema_version WHERE version>=38');
    await store.initStore();
    const oid = await assertLookup();
    assert.deepEqual(await snapshot(), before);
    await store.initStore();
    assert.equal(await assertLookup(), oid);

    // A failed concurrent build leaves a named invalid index; retry must repair
    // it rather than silently skipping it with CREATE ... IF NOT EXISTS.
    await pool.query('DROP INDEX app_stock_ledger_posting_event_idx');
    await assert.rejects(pool.query(`CREATE UNIQUE INDEX CONCURRENTLY
      app_stock_ledger_posting_event_idx ON app_stock_ledger(warehouse)`), { code: '23505' });
    assert.equal((await metadata()).indisvalid, false);
    await pool.query('DELETE FROM wm_schema_version WHERE version>=38');
    await store.initStore();
    await assertLookup();
    assert.equal((await pool.query('SELECT max(version)::int version FROM wm_schema_version')).rows[0].version, SCHEMA_VERSION);
    assert.deepEqual(await snapshot(), before);
  } finally { await store.closeStore(); }
});

test('balance covering index upgrades v45 without changing verification, repairs interrupted builds and rejects a wrong definition', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool=store.getPostgresPool();
    const name='app_stock_ledger_balance_cover_idx';
    const metadata=async()=>(await pool.query(`SELECT indexrelid::text oid,indisvalid,indisready,
      pg_get_indexdef(indexrelid) definition FROM pg_index WHERE indexrelid=to_regclass($1)`,[name])).rows[0];
    const check=async()=>{
      const index=await metadata();assert.equal(index?.indisvalid,true);assert.equal(index.indisready,true);
      assert.match(index.definition,/\(item_code, warehouse\) INCLUDE \(qty_change, stock_value_change\)/);
      return index.oid;
    };
    await check();
    const snapshot=async()=>(await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoices i) invoices,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) accounting,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) stock,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY item_code,warehouse) FROM app_stock_balances b) balances,
      pg_get_functiondef('wm_inventory_balance_check()'::regprocedure) checker,
      (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='wm_inventory_balance_check') trigger,
      (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig)
       FROM pg_proc WHERE oid='wm_inventory_balance_check()'::regprocedure) privileges`)).rows[0];
    const before=await snapshot();
    await pool.query(`DROP INDEX ${name}`);await pool.query('DELETE FROM wm_schema_version WHERE version>=46');
    await store.initStore();const oid=await check();assert.deepEqual(await snapshot(),before);
    await store.initStore();assert.equal(await check(),oid);

    const client=await pool.connect();
    try {
      await client.query('BEGIN');await client.query('SET LOCAL enable_seqscan=off');
      const plan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON)
        SELECT sum(qty_change),sum(stock_value_change) FROM app_stock_ledger WHERE item_code=$1 AND warehouse=$2`,[FIXED.itemCode,FIXED.warehouse])).rows[0]['QUERY PLAN'];
      assert.match(JSON.stringify(plan),/Index Only Scan/);assert.match(JSON.stringify(plan),/app_stock_ledger_balance_cover_idx/);
    } finally {await client.query('ROLLBACK');client.release();}

    await pool.query(`DROP INDEX ${name}`);
    await assert.rejects(pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${name} ON app_stock_ledger(warehouse)`),{code:'23505'});
    assert.equal((await metadata()).indisvalid,false);
    await pool.query('DELETE FROM wm_schema_version WHERE version>=46');await store.initStore();await check();
    assert.deepEqual(await snapshot(),before);

    await pool.query(`DROP INDEX ${name}`);await pool.query(`CREATE INDEX ${name} ON app_stock_ledger(warehouse)`);
    await pool.query('DELETE FROM wm_schema_version WHERE version>=46');
    await assert.rejects(store.initStore(),/unexpected definition/);
    assert.equal((await pool.query('SELECT max(version)::int version FROM wm_schema_version')).rows[0].version,45);
    await pool.query(`DROP INDEX ${name}`);await store.initStore();await check();
    assert.deepEqual(await snapshot(),before);

    await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING',[FIXED.warehouse]);
    await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[FIXED.itemCode,FIXED.itemName]);
    await pool.query('SELECT wm_inventory_activate()');
    // Both quantity and value corruption must still fail the deferred check.
    for(const column of ['quantity','stock_value']) {
      const c=await pool.connect();
      try {
        await c.query('BEGIN');await c.query(`UPDATE app_stock_balances SET ${column}=${column}+1 WHERE item_code=$1 AND warehouse=$2`,[FIXED.itemCode,FIXED.warehouse]);
        await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),/inventory_balance_mismatch/);
      } finally {await c.query('ROLLBACK');c.release();}
    }
    assert.deepEqual(await snapshot(),before);
    assert.equal((await pool.query('SELECT max(version)::int version FROM wm_schema_version')).rows[0].version,SCHEMA_VERSION);
  } finally {await store.closeStore();}
});
