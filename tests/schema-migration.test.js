'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)');
    await pool.query("INSERT INTO wm_schema_version (version, name) VALUES (1, 'baseline')");

    await store.initStore();
    assert.deepEqual((await pool.query('SELECT version FROM wm_schema_version ORDER BY version')).rows,
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }]);
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (5, 6, 7, 8, 9, 10, 11, 12, 13, 14)');

    await store.initStore();
    const snapshot = await pool.query(`SELECT item_category, source, cost::float
      FROM app_invoice_items WHERE item_code = $1 LIMIT 1`, [FIXED.itemCode]);
    assert.deepEqual(snapshot.rows[0], { item_category: 'Hardware', source: 'Import', cost: 42 });
    const id = await store.createInvoice({ invoice_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 180 }] });
    assert.equal((await store.findInvoice(id)).items[0].item_category, 'Hardware');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, 14);
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
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (9, 10, 11, 12, 13, 14)');

    await store.initStore();

    const activityColumn = await pool.query(`SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'app_user_sessions' AND column_name = 'last_activity_at'`);
    assert.equal(activityColumn.rows[0].is_nullable, 'NO');
    assert.equal(activityColumn.rows[0].column_default, 'now()');
    assert.equal((await pool.query('SELECT MAX(version)::int AS version FROM wm_schema_version')).rows[0].version, 14);
  } finally {
    await store.closeStore();
  }
});
