'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

test('reconciliation draft posts the counted difference and reverses cleanly', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query(`INSERT INTO app_master_items (item_code, item_name)
      VALUES ('COUNTED-EXTRA-001', 'Found during count')`);

    const draftId = await store.createStockEntry({
      entry_type: 'reconciliation', action: 'save_draft', posting_date: FIXED.date,
      remarks: 'Physical count', items: [
        { item_code: FIXED.itemCode, item_name: FIXED.itemName,
          warehouse: FIXED.warehouse, quantity: 7, valuation_rate: 50 },
        { item_code: 'COUNTED-EXTRA-001', item_name: 'Found during count',
          warehouse: FIXED.warehouse, quantity: 2, valuation_rate: 30 },
      ],
    });
    const draft = await store.loadStockEntry(draftId);
    assert.match(draft.entry.entry_no, /^REC-/);
    assert.equal(draft.entry.docstatus, 'draft');
    assert.deepEqual(draft.items.map((item) => item.quantity), [7, 2]);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM app_stock_ledger
      WHERE voucher_type = 'stock_reconciliation' AND voucher_id = $1`, [draftId])).rows[0].count, 0);

    await store.createStockEntry({ entry_type: 'opening', posting_date: FIXED.date,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 2, valuation_rate: 50 }] });
    const before = (await pool.query(`SELECT quantity::float FROM app_stock_balances
      WHERE item_code = $1 AND warehouse = $2`, [FIXED.itemCode, FIXED.warehouse])).rows[0].quantity;

    await store.updateStockEntry(draftId, {
      entry_type: 'reconciliation', action: 'submit', posting_date: FIXED.date,
      items: draft.items.map((item) => ({ ...item, warehouse: FIXED.warehouse })),
    });
    const submitted = await store.loadStockEntry(draftId);
    assert.equal(submitted.entry.docstatus, 'submitted');
    assert.deepEqual(submitted.items.map((item) => item.quantity), [7, 2]);
    assert.deepEqual(submitted.items.map((item) => item.quantity_change), [7 - before, 2]);
    assert.deepEqual((await pool.query(`SELECT item_code, quantity::float, counted_quantity::float
      FROM app_stock_entry_items WHERE stock_entry_id = $1 ORDER BY line_no`, [draftId])).rows,
    [{ item_code: FIXED.itemCode, quantity: 7 - before, counted_quantity: 7 },
      { item_code: 'COUNTED-EXTRA-001', quantity: 2, counted_quantity: 2 }]);
    assert.deepEqual((await pool.query(`SELECT item_code, qty_change::float, qty_after_transaction::float
      FROM app_stock_ledger WHERE voucher_type = 'stock_reconciliation'
      AND voucher_id = $1 AND is_reversal = false ORDER BY id`, [draftId])).rows,
    [{ item_code: FIXED.itemCode, qty_change: 7 - before, qty_after_transaction: 7 },
      { item_code: 'COUNTED-EXTRA-001', qty_change: 2, qty_after_transaction: 2 }]);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM app_gl_entries
      WHERE voucher_type = 'stock_reconciliation' AND voucher_id = $1`, [draftId])).rows[0].count, 2);

    await store.cancelStockEntry(draftId, { posting_date: FIXED.date, reason: 'Count voided' });
    assert.equal((await pool.query(`SELECT quantity::float FROM app_stock_balances
      WHERE item_code = $1 AND warehouse = $2`, [FIXED.itemCode, FIXED.warehouse])).rows[0].quantity, before);
    assert.equal((await pool.query(`SELECT quantity::float FROM app_stock_balances
      WHERE item_code = 'COUNTED-EXTRA-001' AND warehouse = $1`, [FIXED.warehouse])).rows[0].quantity, 0);
  } finally {
    await store.closeStore();
  }
});
