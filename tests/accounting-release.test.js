'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

async function glLines(pool, voucherType, voucherId) {
  const { rows } = await pool.query(`
    SELECT account.account_code, gl.debit::float AS debit, gl.credit::float AS credit
    FROM app_gl_entries gl
    JOIN app_accounts account ON account.id = gl.account_id
    WHERE gl.voucher_type = $1 AND gl.voucher_id = $2
    ORDER BY account.account_code
  `, [voucherType, voucherId]);
  return rows;
}

test('invoice, cash sale, payment, stock and journal postings reconcile', {
  skip: process.env.ACCOUNTING_TEST_POSTGRES !== '1',
}, async () => {
  try {
    const seed = await seedGoldenData();
    const pool = store.getPostgresPool();
    const previousInvoice = (await pool.query(
      'SELECT docstatus, amount_paid::float AS amount_paid FROM app_invoices WHERE id = $1', [seed.invoiceId],
    )).rows[0];
    assert.deepEqual(previousInvoice, { docstatus: 'submitted', amount_paid: 200 });
    const previousPayment = (await pool.query(
      'SELECT journal_entry_id FROM app_invoice_payments WHERE invoice_id = $1', [seed.invoiceId],
    )).rows[0];
    assert(previousPayment.journal_entry_id, 'invoice payment has a posted journal');
    assert.equal((await glLines(pool, 'sales_invoice', seed.invoiceId)).length, 5);
    assert.equal((await glLines(pool, 'payment_journal', previousPayment.journal_entry_id)).length, 2);

    const cashAccount = (await pool.query(
      "SELECT account_id FROM app_accounting_settings WHERE setting_key = 'cash'",
    )).rows[0].account_id;
    const payload = {
      invoice_date: FIXED.date, due_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      tax_amount: 0, discount_amount: 0,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 2, unit_price: 180 }],
    };
    const payment = { payment_date: FIXED.date, amount: 360, method: 'cash', account_id: cashAccount };
    const cashSaleId = await store.createCashSaleInvoice(payload, payment);
    const invoice = (await pool.query(`
      SELECT docstatus, is_cash_sale, total::float AS total, amount_paid::float AS amount_paid, status
      FROM app_invoices WHERE id = $1
    `, [cashSaleId])).rows[0];
    assert.deepEqual(invoice, {
      docstatus: 'submitted', is_cash_sale: true, total: 360, amount_paid: 360, status: 'paid',
    });
    const cost = Number((await pool.query(
      'SELECT cost_amount FROM app_invoice_items WHERE invoice_pk = $1', [cashSaleId],
    )).rows[0].cost_amount);
    assert(cost > 0);
    assert.deepEqual(await glLines(pool, 'sales_invoice', cashSaleId), [
      { account_code: '1100', debit: 360, credit: 0 },
      { account_code: '1200', debit: 0, credit: cost },
      { account_code: '4000', debit: 0, credit: 360 },
      { account_code: '5000', debit: cost, credit: 0 },
    ]);
    const journals = (await pool.query(`
      SELECT id, journal_type, total_debit::float AS debit, total_credit::float AS credit
      FROM app_journal_entries WHERE reference_no = (SELECT invoice_no FROM app_invoices WHERE id = $1)
      ORDER BY journal_type
    `, [cashSaleId])).rows;
    assert.deepEqual(journals.map((row) => row.journal_type), ['payment_journal', 'sales_invoice']);
    assert.deepEqual(await glLines(pool, 'payment_journal', journals[0].id), [
      { account_code: '1100', debit: 0, credit: 360 },
      { account_code: '1110', debit: 360, credit: 0 },
    ]);
    for (const journal of journals) assert.equal(journal.debit, journal.credit);
    const stock = (await pool.query(`
      SELECT quantity::float AS quantity FROM app_stock_balances
      WHERE item_code = $1 AND warehouse = $2
    `, [FIXED.itemCode, FIXED.warehouse])).rows[0];
    assert.equal(stock.quantity, 10);

    await assert.rejects(store.createCashSaleInvoice(payload, { ...payment, account_id: 999999 }),
      { status: 400 });
    assert.equal(Number((await pool.query('SELECT count(*) FROM app_invoices')).rows[0].count), 2);
    assert.equal(Number((await pool.query(`
      SELECT quantity FROM app_stock_balances WHERE item_code = $1 AND warehouse = $2
    `, [FIXED.itemCode, FIXED.warehouse])).rows[0].quantity), 10);
    const imbalance = (await pool.query(`
      SELECT COALESCE(SUM(debit - credit), 0)::float AS amount FROM app_gl_entries
    `)).rows[0].amount;
    assert.equal(imbalance, 0);
  } finally {
    await store.closeStore();
  }
});
