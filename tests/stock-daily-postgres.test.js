'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { seedGoldenData } = require('./helpers/golden-seed');
const { clearReadCaches } = require('../src/read-cache');

test('stock movement daily summary stays transactional and preserves filtered report results', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
  timeout: 60000,
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const reconcile = async () => {
      const { rows } = await pool.query(`
        WITH expected AS (
          SELECT warehouse, item_code, item_name, posting_date,
            count(*)::bigint AS movement_count,
            sum(qty_change) AS qty_change,
            sum(CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END) AS in_qty,
            sum(CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END) AS out_qty,
            sum(stock_value_change) AS stock_value_change
          FROM app_stock_ledger
          GROUP BY warehouse, item_code, item_name, posting_date
        ), actual AS (
          SELECT warehouse, item_code, item_name, posting_date,
            movement_count, qty_change, in_qty, out_qty, stock_value_change
          FROM wm_stock_daily
        )
        SELECT count(*)::int AS differences
        FROM ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
          UNION ALL
          (SELECT * FROM actual EXCEPT SELECT * FROM expected)) mismatch`);
      assert.equal(rows[0].differences, 0);
    };
    await reconcile();

    const triggers = (await pool.query(`SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE tgrelid='app_stock_ledger'::regclass AND tgname LIKE 'wm_stock_daily_%'
      ORDER BY tgname`)).rows;
    assert.deepEqual(triggers.map(row => row.tgname), [
      'wm_stock_daily_delete',
      'wm_stock_daily_insert',
      'wm_stock_daily_truncate',
      'wm_stock_daily_update',
    ]);
    assert.ok(triggers.every(row => row.tgenabled === 'O'));

    await pool.query(`INSERT INTO app_stock_ledger
      (posting_date,item_code,item_name,warehouse,voucher_type,voucher_no,
       qty_change,stock_value_change,qty_after_transaction,stock_value_after_transaction)
      VALUES
        ('2026-01-01','DAILY-A','Daily A','Daily Warehouse','stock_daily_test','DAILY-A-1',10,100,999,999),
        ('2026-01-05','DAILY-A','Daily A','Daily Warehouse','stock_daily_test','DAILY-A-2',-3,-30,0,0),
        ('2026-01-10','DAILY-A','Daily A','Daily Warehouse','stock_daily_test','DAILY-A-3',2,20,0,0),
        ('2026-01-20','DAILY-A','Daily A','Daily Warehouse','stock_daily_test','DAILY-A-4',-1,-10,0,0),
        ('2026-01-01','DAILY-B','Daily B','Daily Warehouse','stock_daily_test','DAILY-B-1',4,40,0,0),
        ('2026-01-20','DAILY-B','Daily B','Daily Warehouse','stock_daily_test','DAILY-B-2',-1,-10,0,0)`);
    await reconcile();
    clearReadCaches();
    const report = await store.stockMovementReport({
      warehouse: 'Daily Warehouse', from: '2026-01-05', to: '2026-01-10', page_size: 50,
    });
    assert.deepEqual(report.rows.map(row => ({
      item_code: row.item_code,
      opening_qty: row.opening_qty,
      in_qty: row.in_qty,
      out_qty: row.out_qty,
      value_change: row.value_change,
      closing_qty: row.closing_qty,
      closing_value: row.closing_value,
    })), [
      { item_code: 'DAILY-A', opening_qty: 10, in_qty: 2, out_qty: 3, value_change: -10, closing_qty: 9, closing_value: 90 },
      { item_code: 'DAILY-B', opening_qty: 4, in_qty: 0, out_qty: 0, value_change: 0, closing_qty: 4, closing_value: 40 },
    ]);
    assert.deepEqual(report.summary, {
      opening_qty: 14, in_qty: 2, out_qty: 3, closing_qty: 13,
      opening_value: 140, value_change: -10, closing_value: 130,
    });

    clearReadCaches();
    const searched = await store.stockMovementReport({
      warehouse: 'Daily Warehouse', from: '2026-01-05', to: '2026-01-10',
      search: 'DAILY-A', page_size: 50,
    });
    assert.deepEqual(searched.rows.map(row => ({
      item_code: row.item_code,
      opening_qty: row.opening_qty,
      in_qty: row.in_qty,
      out_qty: row.out_qty,
      closing_qty: row.closing_qty,
    })), [{ item_code: 'DAILY-A', opening_qty: 10, in_qty: 2, out_qty: 3, closing_qty: 9 }]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO app_stock_ledger
        (posting_date,item_code,item_name,warehouse,voucher_type,voucher_no,
         qty_change,stock_value_change,qty_after_transaction,stock_value_after_transaction)
        VALUES ('2026-01-06','DAILY-A','Daily A','Daily Warehouse',
          'stock_daily_test','DAILY-ROLLBACK',5,50,0,0)`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await reconcile();

    await pool.query('TRUNCATE app_stock_ledger');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM wm_stock_daily')).rows[0].count, 0);
  } finally {
    await store.closeStore();
  }
});
