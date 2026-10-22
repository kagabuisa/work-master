'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const auth = require('../src/auth');
const math = require('../src/shared/invoice-math');
const { runWithAuditUser } = require('../src/audit');
const { currentPostingDate, currentPostingTime } = require('../src/posting-time');
const { resetGoldenSchema } = require('./helpers/golden-seed');

for (const controlled of [false, true]) {
  test(`exact invoices, cash receipts, stock depletion, transfers and reversals (${controlled ? 'controlled' : 'legacy'} inventory)`, {
    skip: process.env.ACCOUNTING_TEST_POSTGRES !== '1',
  }, async () => {
    try {
      await resetGoldenSchema();
      const pool = store.getPostgresPool();
      const admin = await auth.createUser('money-review', 'MoneyRegression123!', { role: 'admin' });
      await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES('Money Main'),('Money Target'),('Money Residual')");
      for (const code of ['RATE', 'HALF', 'CASH', 'DRIFT', 'CANCEL', 'CANCEL-NEGATIVE', 'ROLLBACK', 'GHOST']) {
        await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$1)', [code]);
      }
      // Model a historical residual without changing an existing posted row.
      await pool.query("INSERT INTO app_stock_balances(item_code,item_name,warehouse,quantity,stock_value) VALUES('GHOST','GHOST','Money Residual',0,1)");
      const ghost = (await pool.query(`INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,qty_change,stock_value_change,qty_after_transaction,stock_value_after_transaction,movement_at)
        VALUES($1,'GHOST','GHOST','Money Residual','stock_opening',987,0,1,0,1,clock_timestamp()) RETURNING id`, [currentPostingDate()])).rows[0];
      const mapping = Object.fromEntries((await pool.query("SELECT setting_key,account_id FROM app_accounting_settings WHERE setting_key IN('inventory','opening_equity')")).rows.map(row => [row.setting_key, row.account_id]));
      await store.createJournalEntry({ journal_type: 'journal_entry', posting_date: currentPostingDate(), lines: [
        { account_id: mapping.inventory, debit: 1 }, { account_id: mapping.opening_equity, credit: 1 },
      ] });
      if (controlled) await pool.query('SELECT wm_inventory_activate()');
      await runWithAuditUser(admin, async () => {
        const stamp = () => ({ posting_date: currentPostingDate(), posting_time: currentPostingTime() });
        const item = (code, quantity, extra = {}) => ({ item_code: code, item_name: code, warehouse: 'Money Main', quantity, ...extra });
        const receipt = (code, quantity, rate) => store.createStockEntry({ ...stamp(), entry_type: 'opening', items: [item(code, quantity, { valuation_rate: rate })] });
        const payload = (items, extra = {}) => ({ invoice_date: currentPostingDate(), posting_time: currentPostingTime(), customer_name: 'Money customer', items, ...extra });
        const balance = async (code, warehouse = 'Money Main') => {
          const row = (await pool.query('SELECT quantity,stock_value FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2', [code, warehouse])).rows[0];
          return { quantity: Number(row.quantity), value: Number(row.stock_value) };
        };
        const sell = async (items, extra = {}) => {
          const id = await store.createInvoice(payload(items, extra));
          await store.submitInvoice(id);
          return id;
        };

        if (controlled) {
          const { countAction } = require('../src/inventory-counts');
          let count = await countAction(admin, 'start', { warehouse: 'Money Residual', readiness: 'Physical movements stopped; reviewed legacy stock residual.' });
          count = await countAction(admin, 'save', { id: count.id, revision: count.revision,
            lines: [{ item_code: 'GHOST', counted_qty: 0, valuation_rate: 0, explanation: 'Reviewed zero-quantity legacy value residual.' }] });
          count = await countAction(admin, 'review', { id: count.id, revision: count.revision });
          count = await countAction(admin, 'approve', { id: count.id, revision: count.revision });
          await countAction(admin, 'submit', { id: count.id, revision: count.revision });
        } else {
          await store.createStockEntry({ ...stamp(), entry_type: 'reconciliation', items: [item('GHOST', 0, { warehouse: 'Money Residual', valuation_rate: 0 })] });
        }
        assert.deepEqual(await balance('GHOST', 'Money Residual'), { quantity: 0, value: 0 });
        assert.equal(Number((await pool.query('SELECT stock_value_change FROM app_stock_ledger WHERE id=$1', [ghost.id])).rows[0].stock_value_change), 1, 'original history remains intact');

        await receipt('RATE', 2000, 5);
        const precise = await sell([item('RATE', 1000, { unit_price: '1.234567' })], { discount_amount: '0.49', tax_amount: '0.50' });
        const invoice = await store.findInvoice(precise);
        assert.equal(invoice.items[0].unit_price, '1.234567');
        assert.equal(invoice.items[0].line_total, 1235);
        assert.deepEqual([invoice.subtotal, invoice.discount_amount, invoice.tax_amount, invoice.total], [1235, 0, 1, 1236]);
        assert.equal((await pool.query('SELECT unit_price::text rate FROM app_invoice_items WHERE invoice_pk=$1', [precise])).rows[0].rate, '1.234567');

        await receipt('HALF', 10, 100);
        const half = await sell([item('HALF', '1.005', { unit_price: 100 })]);
        assert.equal((await store.findInvoice(half)).total, 101);
        assert.equal(Number((await pool.query('SELECT cost_amount FROM app_invoice_items WHERE invoice_pk=$1', [half])).rows[0].cost_amount), 101);

        await receipt('CASH', 1, 100);
        const cash = payload([item('CASH', '0.005', { unit_price: 100 }), item('CASH', '0.005', { unit_price: 100 })]);
        const payment = { payment_date: currentPostingDate(), amount: math.grandTotal(cash.items, 0, 0), method: 'cash' };
        assert.equal(payment.amount, 2);
        const cashId = await store.createCashSaleInvoice(cash, payment);
        const paid = await store.findInvoice(cashId);
        assert.deepEqual([paid.total, paid.amount_paid, paid.status], [2, 2, 'paid']);
        const beforeBadCash = await balance('CASH');
        for (const amount of [1, 3]) {
          await assert.rejects(store.createCashSaleInvoice(cash, { ...payment, amount }), /must equal/);
          assert.deepEqual(await balance('CASH'), beforeBadCash, 'failed cash sale rolls back stock');
        }

        await receipt('DRIFT', 1, 100);
        await receipt('DRIFT', 2, 101);
        const first = await sell([item('DRIFT', 1, { unit_price: 200 })]);
        assert.deepEqual(await balance('DRIFT'), { quantity: 2, value: 201 });
        const transfer = await store.createStockEntry({ ...stamp(), entry_type: 'transfer', items: [item('DRIFT', 2, { target_warehouse: 'Money Target' })] });
        assert.deepEqual(await balance('DRIFT'), { quantity: 0, value: 0 });
        assert.deepEqual(await balance('DRIFT', 'Money Target'), { quantity: 2, value: 201 });
        await store.cancelStockEntry(transfer, { posting_date: currentPostingDate(), reason: 'Exact transfer reversal' });
        assert.deepEqual(await balance('DRIFT'), { quantity: 2, value: 201 });
        assert.deepEqual(await balance('DRIFT', 'Money Target'), { quantity: 0, value: 0 });
        const depletion = await sell([item('DRIFT', 2, { unit_price: 200 })]);
        assert.deepEqual(await balance('DRIFT'), { quantity: 0, value: 0 });
        await store.cancelInvoice(depletion);
        await store.cancelInvoice(first);
        assert.deepEqual(await balance('DRIFT'), { quantity: 3, value: 302 });
        const all = await sell([item('DRIFT', 3, { unit_price: 200 })]);
        assert.deepEqual(await balance('DRIFT'), { quantity: 0, value: 0 });
        assert.equal(Number((await pool.query('SELECT cost_amount FROM app_invoice_items WHERE invoice_pk=$1', [all])).rows[0].cost_amount), 302);

        await receipt('CANCEL', 1, 100);
        const cancel = await receipt('CANCEL', 2, 101);
        await store.cancelStockEntry(cancel, { posting_date: currentPostingDate(), reason: 'Reverse exact receipt value' });
        assert.deepEqual(await balance('CANCEL'), { quantity: 1, value: 100 });

        await receipt('CANCEL-NEGATIVE', 2, 1);
        const expensive = await receipt('CANCEL-NEGATIVE', 1, 200);
        await sell([item('CANCEL-NEGATIVE', 1, { unit_price: 300 })]);
        const beforeReversal = await balance('CANCEL-NEGATIVE');
        await assert.rejects(store.cancelStockEntry(expensive, { posting_date: currentPostingDate(), reason: 'Reject negative remaining inventory value' }), /stock value/);
        assert.deepEqual(await balance('CANCEL-NEGATIVE'), beforeReversal);

        await receipt('ROLLBACK', 1, 100);
        const broken = await store.createInvoice(payload([item('ROLLBACK', 1, { unit_price: 100 })], { tax_amount: 1 }));
        await pool.query('UPDATE app_invoices SET total=100 WHERE id=$1', [broken]);
        await assert.rejects(store.submitInvoice(broken), /not balanced/);
        assert.deepEqual(await balance('ROLLBACK'), { quantity: 1, value: 100 });
        assert.equal((await store.findInvoice(broken)).docstatus, 'draft');
        assert.equal((await store.findInvoice(broken)).total, 100, 'hydration preserves the saved total');
        assert.equal((await pool.query("SELECT count(*)::int n FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1", [broken])).rows[0].n, 0);
        assert.equal(Number((await pool.query('SELECT sum(debit-credit) amount FROM app_gl_entries')).rows[0].amount), 0);
        assert.equal((await pool.query(`SELECT count(*)::int n FROM app_stock_ledger r JOIN app_stock_ledger s ON s.id=r.reversal_of_ledger_id
          WHERE r.stock_value_change<>-s.stock_value_change OR r.qty_change<>-s.qty_change`)).rows[0].n, 0);
        const audit = require('node:child_process').spawnSync(process.execPath, ['scripts/audit-money.js'], {
          cwd: require('node:path').join(__dirname, '..'), env: process.env, encoding: 'utf8',
        });
        assert.equal(audit.status, 0, audit.stderr);
        assert.deepEqual(JSON.parse(audit.stdout).checks, { zero_quantity_with_value: 0, negative_stock_values: 0,
          inconsistent_invoice_headers: 0, inconsistent_invoice_lines: 0, unbalanced_gl_vouchers: 0 });
      });
    } finally { await store.closeStore(); }
  });
}
