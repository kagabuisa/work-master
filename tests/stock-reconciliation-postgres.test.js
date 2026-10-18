'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

test('stock cancellation ignores purchase and invoice reversals with the same numeric ID', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    await pool.query(`
      INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES ('COLLISION-SUP','Supplier');
      INSERT INTO app_master_items(item_code,item_name) VALUES ('COLLISION-ITEM','Item');
      INSERT INTO app_master_warehouses(warehouse) VALUES ('Collision Warehouse');
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active)
        VALUES ('Collision Buying','UGX','buying',1);
    `);
    const item = { item_code: 'COLLISION-ITEM', item_name: 'Item', warehouse: 'Collision Warehouse',
      quantity: 10, valuation_rate: 50, unit_price: 100 };
    const stockId = await store.createStockEntry({ entry_type: 'opening', posting_date: FIXED.date, items: [item] });
    const purchases = require('../src/purchases');
    const purchaseId = await purchases.createPurchase({ posting_date: FIXED.date,
      supplier_id: 'COLLISION-SUP', price_list: 'Collision Buying', items: [item] });
    assert.equal(Number(purchaseId), Number(stockId));
    await purchases.submitPurchase(purchaseId);
    await purchases.cancelPurchase(purchaseId);
    const invoiceId = await store.createInvoice({ invoice_date: FIXED.date,
      customer_name: 'Collision Customer', items: [{ ...item, quantity: 1 }] });
    assert.equal(Number(invoiceId), Number(stockId));
    await store.submitInvoice(invoiceId);
    await store.cancelInvoice(invoiceId);
    const foreignReversals = (await pool.query(`SELECT voucher_type FROM app_stock_ledger
      WHERE reversal_of_voucher_id=$1 AND is_reversal AND voucher_type NOT LIKE 'stock_%'`, [stockId])).rows;
    assert.ok(foreignReversals.some(row => row.voucher_type === 'purchase'));
    assert.ok(foreignReversals.some(row => row.voucher_type === 'invoice'));
    await store.cancelStockEntry(stockId, { posting_date: new Date().toISOString().slice(0, 10) });
    assert.equal((await store.loadStockEntry(stockId)).entry.docstatus, 'cancelled');
    assert.equal((await pool.query(`SELECT quantity::float FROM app_stock_balances
      WHERE item_code=$1 AND warehouse=$2`, [item.item_code, item.warehouse])).rows[0].quantity, 0);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM app_stock_ledger
      WHERE voucher_type='stock_opening' AND reversal_of_voucher_id=$1 AND is_reversal`, [stockId])).rows[0].n, 1);
    await assert.rejects(store.cancelStockEntry(stockId), /Only submitted/);
  } finally { await store.closeStore(); }
});

test('reconciliation draft posts the counted difference and reverses cleanly', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query(`INSERT INTO app_master_items (item_code, item_name)
      VALUES ('COUNTED-EXTRA-001', 'Found during count'),
        ('COUNTED-MATCH-001', 'Matching count'), ('COUNTED-ZERO-001', 'Matching zero count')`);
    await store.createStockEntry({ entry_type: 'opening', posting_date: FIXED.date,
      items: [{ item_code: 'COUNTED-MATCH-001', item_name: 'Matching count',
        warehouse: FIXED.warehouse, quantity: 5, valuation_rate: 20 }] });

    const draftId = await store.createStockEntry({
      entry_type: 'reconciliation', action: 'save_draft', posting_date: FIXED.date,
      remarks: 'Physical count', items: [
        { item_code: FIXED.itemCode, item_name: FIXED.itemName,
          warehouse: FIXED.warehouse, quantity: 7, valuation_rate: 50 },
        { item_code: 'COUNTED-EXTRA-001', item_name: 'Found during count',
          warehouse: FIXED.warehouse, quantity: 2, valuation_rate: 30 },
        { item_code: 'COUNTED-MATCH-001', item_name: 'Matching count',
          warehouse: FIXED.warehouse, quantity: 5, valuation_rate: 20 },
        { item_code: 'COUNTED-ZERO-001', item_name: 'Matching zero count',
          warehouse: FIXED.warehouse, quantity: 0, valuation_rate: 0 },
      ],
    });
    const draft = await store.loadStockEntry(draftId);
    assert.match(draft.entry.entry_no, /^REC-/);
    assert.equal(draft.entry.docstatus, 'draft');
    assert.deepEqual(draft.items.map((item) => item.quantity), [7, 2, 5, 0]);
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
    assert.deepEqual(submitted.items.map((item) => item.quantity), [7, 2, 5, 0]);
    assert.deepEqual(submitted.items.map((item) => item.quantity_change), [7 - before, 2, 0, 0]);
    assert.deepEqual(submitted.items.slice(2).map((item) => item.value_change), [0, 0]);
    assert.deepEqual((await pool.query(`SELECT item_code, quantity::float, counted_quantity::float
      FROM app_stock_entry_items WHERE stock_entry_id = $1 ORDER BY line_no`, [draftId])).rows,
    [{ item_code: FIXED.itemCode, quantity: 7 - before, counted_quantity: 7 },
      { item_code: 'COUNTED-EXTRA-001', quantity: 2, counted_quantity: 2 },
      { item_code: 'COUNTED-MATCH-001', quantity: 0, counted_quantity: 5 },
      { item_code: 'COUNTED-ZERO-001', quantity: 0, counted_quantity: 0 }]);
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
    assert.equal((await pool.query(`SELECT quantity::float FROM app_stock_balances
      WHERE item_code = 'COUNTED-MATCH-001' AND warehouse = $1`, [FIXED.warehouse])).rows[0].quantity, 5);
    assert.equal((await store.loadStockEntry(draftId)).items.length, 4);
    const unchangedId = await store.createStockEntry({ entry_type: 'reconciliation', action: 'submit',
      posting_date: FIXED.date, items: submitted.items.slice(2).map((item) => ({ ...item, id: undefined })) });
    const unchanged = await store.loadStockEntry(unchangedId);
    assert.equal(unchanged.entry.docstatus, 'submitted');
    assert.deepEqual(unchanged.items.map((item) => [item.quantity, item.quantity_change, item.value_change]), [[5, 0, 0], [0, 0, 0]]);
    for (const table of ['app_stock_ledger', 'app_gl_entries']) {
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}
        WHERE voucher_type='stock_reconciliation' AND voucher_id=$1`, [unchangedId])).rows[0].count, 0);
    }
    await store.cancelStockEntry(unchangedId, { posting_date: FIXED.date, reason: 'Matching count voided' });
    const cancelled = await store.loadStockEntry(unchangedId);
    assert.equal(cancelled.entry.docstatus, 'cancelled');
    assert.equal(cancelled.items.length, 2);

  } finally {
    await store.closeStore();
  }
});

test('named stock transfers preserve quantity and value, reject insufficient stock, and reverse cleanly', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES ('Transfer Target') ON CONFLICT DO NOTHING");
    const balances = async () => (await pool.query(`SELECT warehouse,quantity::float,stock_value::float
      FROM app_stock_balances WHERE item_code=$1 AND warehouse=ANY($2::text[]) ORDER BY warehouse`,
    [FIXED.itemCode, [FIXED.warehouse, 'Transfer Target']])).rows;
    const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field]), 0);
    for (const type of require('../src/constants').STOCK_TRANSFER_TYPES) {
      const before = await balances();
      const payload = { entry_type: type, action: 'save_draft', posting_date: FIXED.date,
        items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse,
          target_warehouse: 'Transfer Target', quantity: 2, valuation_rate: 999999 }] };
      const id = await store.createStockEntry(payload);
      assert.deepEqual(await balances(), before);
      const draft = await store.loadStockEntry(id);
      await store.updateStockEntry(id, { ...payload, action: 'submit', items: draft.items });
      const moved = await balances();
      assert.equal(sum(moved, 'quantity'), sum(before, 'quantity'));
      assert.ok(Math.abs(sum(moved, 'stock_value') - sum(before, 'stock_value')) < 0.01);
      const rows = (await pool.query('SELECT warehouse,qty_change::float,stock_value_change::float,voucher_type FROM app_stock_ledger WHERE voucher_id=$1 AND is_reversal=false ORDER BY id', [id])).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => row.qty_change), [-2, 2]);
      assert.ok(rows.every(row => row.voucher_type === `stock_${type}`));
      assert.equal(rows[0].stock_value_change + rows[1].stock_value_change, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_gl_entries WHERE voucher_id=$1 AND voucher_type LIKE $2', [id, 'stock_%'])).rows[0].n, 0);
      const filtered = await store.listStockEntries({ entry_type: type });
      assert.ok(filtered.rows.some(row => Number(row.id) === Number(id)));
      await store.cancelStockEntry(id, { posting_date: FIXED.date, reason: 'Transfer test' });
      const restored = await balances();
      assert.equal(sum(restored, 'quantity'), sum(before, 'quantity'));
      assert.ok(Math.abs(sum(restored, 'stock_value') - sum(before, 'stock_value')) < 0.01);
      assert.equal(restored.find(row => row.warehouse === 'Transfer Target').quantity, 0);
      const failed = await store.createStockEntry({ ...payload, items: [{ ...payload.items[0], quantity: 999999 }] });
      const saved = await store.loadStockEntry(failed);
      await assert.rejects(store.updateStockEntry(failed, { ...payload, action: 'submit', items: saved.items }), error => error.code === 'INSUFFICIENT_STOCK');
      assert.deepEqual(await balances(), restored);
      assert.equal((await store.loadStockEntry(failed)).entry.docstatus, 'draft');
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_id=$1', [failed])).rows[0].n, 0);
    }
  } finally { await store.closeStore(); }
});

test('transfers use posting-date/time stock, protect later balances, and serialize competing submissions', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const itemCode = 'ASOF-TRANSFER-ITEM'; const source = 'As-of Source'; const target = 'As-of Target';
    await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$1)', [itemCode]);
    await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1),($2)', [source,target]);
    const line = (quantity, warehouse = source) => ({ item_code: itemCode, item_name: itemCode, warehouse,
      target_warehouse: target, quantity, valuation_rate: 50 });
    const opening = (date,time,quantity) => store.createStockEntry({entry_type:'opening',posting_date:date,posting_time:time,items:[line(quantity)]});
    await opening('2026-02-01','09:00',10);
    await opening('2026-02-01','15:00',20);
    const makeDraft = (time,quantity=11,type='order',date='2026-02-01',items=null) => store.createStockEntry({
      entry_type:type,action:'save_draft',posting_date:date,posting_time:time,items:items||[line(quantity)] });
    const submit = async id => { const saved=await store.loadStockEntry(id); return store.updateStockEntry(id,{
      ...saved.entry,action:'submit',items:saved.items }); };
    const assertUnposted = async id => {
      assert.equal((await store.loadStockEntry(id)).entry.docstatus,'draft');
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_id=$1',[id])).rows[0].n,0);
    };
    for(const type of require('../src/constants').STOCK_TRANSFER_TYPES) {
      const id=await makeDraft('10:00',11,type);
      await assert.rejects(submit(id),error=>error.code==='INSUFFICIENT_STOCK'&&/2026-02-01 10:00/.test(error.message));
      await assertUnposted(id);
    }
    const beforeDay=await makeDraft('23:00',1,'order','2026-01-31');
    await assert.rejects(submit(beforeDay),error=>error.code==='INSUFFICIENT_STOCK');await assertUnposted(beforeDay);
    const beforeHour=await makeDraft('08:59',1);await assert.rejects(submit(beforeHour),error=>error.code==='INSUFFICIENT_STOCK');
    // A later outgoing movement reserves stock even though current stock was replenished.
    const later=await makeDraft('11:00',8);await submit(later);
    const early=await makeDraft('10:00',3);
    await assert.rejects(submit(early),error=>error.code==='INSUFFICIENT_STOCK'&&/later transactions/.test(error.message));await assertUnposted(early);
    // Repeated lines must be counted together, and the whole attempted submission rolls back.
    const repeated=await makeDraft('10:00',0,'ddr_excess','2026-02-01',[line(1.5),line(1.5)]);
    await assert.rejects(submit(repeated),error=>error.code==='INSUFFICIENT_STOCK');await assertUnposted(repeated);
    const competing=await Promise.all([makeDraft('10:00',2,'ddr_shortage'),makeDraft('10:00',2,'taff_kla_order')]);
    const results=await Promise.allSettled(competing.map(submit));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_STOCK');
    const { transferStockAvailability } = require('../src/stock-transfer-availability');
    const beforeReceipt=await transferStockAvailability(pool,itemCode,source,'2026-02-01','14:59');
    assert.equal(beforeReceipt.quantity,0);
    const afterReceipt=await transferStockAvailability(pool,itemCode,source,'2026-02-01','15:00');
    assert.equal(afterReceipt.quantity,20);
    const enough=await makeDraft('15:00',20,'ddr_excess');await submit(enough);
    assert.equal(Number((await store.localStockQuantity(itemCode,source)).quantity),0);
    // Safe posting-time changes on drafts use their new timestamp at submission.
    const changed=await makeDraft('10:00',1);await store.updateVoucherPostingTime('stock',changed,'16:00');
    await assert.rejects(submit(changed),error=>error.code==='INSUFFICIENT_STOCK');await assertUnposted(changed);
  } finally { await store.closeStore(); }
});

test('sales cannot consume a later reconciliation or leave later stock negative', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const code = 'ASOF-SALE-ITEM';
    await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$1)', [code]);
    const line = quantity => ({ item_code: code, item_name: code, warehouse: FIXED.warehouse,
      quantity, valuation_rate: 50, unit_price: 100 });
    await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-02-01',
      posting_time: '09:00', items: [line(10)] });
    await store.createStockEntry({ entry_type: 'reconciliation', posting_date: '2026-02-02',
      posting_time: '12:00', items: [line(100)] });
    const historicalItems = (date, time) => store.masterItemsWithStock({ search: code,
      warehouse: FIXED.warehouse, postingDate: date, postingTime: time });
    assert.equal((await historicalItems('2026-02-01', '08:59')).length, 0);
    assert.equal((await historicalItems('2026-02-01', '10:00'))[0].stock_balance, 10);
    assert.equal((await historicalItems('2026-02-02', '11:59'))[0].stock_balance, 10);
    assert.equal((await historicalItems('2026-02-02', '12:00'))[0].stock_balance, 100);
    const draft = (date, time, quantities) => store.createInvoice({ invoice_date: date,
      due_date: date, posting_time: time, customer_id: FIXED.customerId,
      customer_name: FIXED.customerName, payments: [], items: quantities.map(line) });
    const reject = async (date, time, quantities) => {
      const id = await draft(date, time, quantities);
      await assert.rejects(store.submitInvoice(id), error => error.code === 'INSUFFICIENT_STOCK');
      assert.equal((await pool.query('SELECT docstatus FROM app_invoices WHERE id=$1', [id])).rows[0].docstatus, 'draft');
      assert.equal((await pool.query("SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [id])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT quantity::float n FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2', [code, FIXED.warehouse])).rows[0].n, 100);
    };
    await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES('As-of Sales Target')");
    for (const type of [...require('../src/constants').STOCK_TRANSFER_TYPES, 'adjustment', 'cancel', 'reconciliation']) {
      const id = await store.createStockEntry({ entry_type: type, action: 'save_draft',
        posting_date: '2026-02-01', posting_time: '10:00',
        items: [{ ...line(type === 'adjustment' ? -11 : type === 'reconciliation' ? 89 : 11),
          target_warehouse: 'As-of Sales Target' }] });
      const saved = await store.loadStockEntry(id);
      await assert.rejects(store.updateStockEntry(id, { ...saved.entry, action: 'submit', items: saved.items }),
        error => error.code === 'INSUFFICIENT_STOCK');
      assert.equal((await store.loadStockEntry(id)).entry.docstatus, 'draft');
      assert.equal((await pool.query("SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_type=$1 AND voucher_id=$2", [`stock_${type}`, id])).rows[0].n, 0);
    }
    await reject('2026-02-01', '10:00', [11]);
    await reject('2026-02-02', '11:59', [11]);
    await reject('2026-02-01', '10:00', [6, 5]);
    const later = await draft('2026-02-02', '12:00', [95]);
    await store.submitInvoice(later);
    const early = await draft('2026-02-01', '10:00', [6]);
    await assert.rejects(store.submitInvoice(early), /later transactions/);
    const valid = await draft('2026-02-01', '10:00', [5]);
    await store.submitInvoice(valid);
    assert.equal((await pool.query('SELECT quantity::float n FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2', [code, FIXED.warehouse])).rows[0].n, 0);
    assert.equal((await historicalItems('2026-02-01', '10:00'))[0].stock_balance, 5,
      'items with historical stock remain searchable even when current stock is zero');
  } finally {
    await store.closeStore();
  }
});
