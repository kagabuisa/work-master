'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { seedGoldenData, FIXED } = require('./helpers/golden-seed');
test('batched invoice costs preserve repeated-item valuation, rollback and concurrent stock protection', {
  skip: process.env.GOLDEN_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const create = quantities => store.createInvoice({ invoice_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName, payments: [],
      items: quantities.map(quantity => ({ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity, unit_price: 180 })) });
    const balance = async () => (await pool.query('SELECT quantity,stock_value,valuation_rate FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2', [FIXED.itemCode,FIXED.warehouse])).rows[0];
    const initial = await balance();
    const id = await create([2,3]); await store.submitInvoice(id);
    const lines = (await pool.query('SELECT * FROM app_invoice_items WHERE invoice_pk=$1 ORDER BY line_no',[id])).rows;
    assert.deepEqual(lines.map(r => Number(r.stock_at_sale)), [Number(initial.quantity),Number(initial.quantity)-2]);
    for (const line of lines) {
      assert.equal(Number(line.cost_amount),Number(line.quantity)*Number(line.cost_rate));
      assert.equal(Number(line.gross_profit),Number(line.line_total)-Number(line.cost_amount));
    }
    const beforeFailure = await balance();
    const failedId = await create([1,1000]);
    await assert.rejects(store.submitInvoice(failedId), error => error.code === 'INSUFFICIENT_STOCK');
    assert.deepEqual(await balance(),beforeFailure);
    assert.equal((await pool.query("SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1",[failedId])).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1",[failedId])).rows[0].n,0);
    assert.equal((await pool.query('SELECT docstatus FROM app_invoices WHERE id=$1',[failedId])).rows[0].docstatus,'draft');
    const quantity = Number(beforeFailure.quantity);
    const ids = await Promise.all([create([quantity]),create([quantity])]);
    const outcomes = await Promise.allSettled(ids.map(id => store.submitInvoice(id)));
    assert.equal(outcomes.filter(r => r.status==='fulfilled').length,1);
    assert.equal(outcomes.find(r => r.status==='rejected').reason.code,'INSUFFICIENT_STOCK');
    assert.equal(Number((await balance()).quantity),0);
    assert.equal(Number((await pool.query('SELECT sum(debit-credit) delta FROM app_gl_entries')).rows[0].delta),0);
  } finally { await store.closeStore(); }
});

test('batch creation preserves 100 line snapshots, rounding and per-row audit identity', {
  skip: process.env.GOLDEN_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query(`INSERT INTO app_master_items(item_code,item_name,category,source,unit_cost)
      VALUES ($1,$2,'Batch category','Batch source',42.25)
      ON CONFLICT(item_code) DO UPDATE SET category=EXCLUDED.category,source=EXCLUDED.source,unit_cost=EXCLUDED.unit_cost`,
    [FIXED.itemCode, FIXED.itemName]);
    const items = Array.from({ length: 100 }, (_, index) => ({
      item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse,
      quantity: 1 + index / 1000, unit_price: '180.25', stock_at_sale: 500,
      item_category: 'Forged', source: 'Forged', cost: 999,
    }));
    const id = await require('../src/audit').runWithAuditUser({ id: 'batch-auditor', username: 'Batch auditor' },
      () => store.createInvoice({ invoice_date: FIXED.date, customer_id: FIXED.customerId,
        customer_name: FIXED.customerName, payments: [], items }));
    const rows = (await pool.query('SELECT * FROM app_invoice_items WHERE invoice_pk=$1 ORDER BY line_no', [id])).rows;
    assert.equal(rows.length, 100);
    rows.forEach((row, index) => {
      assert.equal(Number(row.line_no), index + 1);
      assert.equal(Number(row.quantity), items[index].quantity);
      assert.equal(Number(row.unit_price), 180);
      assert.equal(Number(row.line_total), Math.round(items[index].quantity * 180));
      assert.equal(Number(row.stock_at_sale), 500);
      assert.equal(row.item_category, 'Batch category'); assert.equal(row.source, 'Batch source');
      assert.equal(Number(row.cost), 42.25);
      assert.equal(row.created_by, 'Batch auditor'); assert.equal(row.created_by_user_id, 'batch-auditor');
      assert.equal(row.updated_by, 'Batch auditor'); assert.ok(row.created_at);
    });
    const header = (await pool.query('SELECT subtotal FROM app_invoices WHERE id=$1', [id])).rows[0];
    assert.equal(Number(header.subtotal), rows.reduce((sum, row) => sum + Math.round(Number(row.line_total) * 100), 0) / 100);
  } finally { await store.closeStore(); }
});
