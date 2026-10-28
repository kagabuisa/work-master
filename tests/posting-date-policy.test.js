'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPostingDate, currentPostingDate } = require('../src/posting-time');
const store = require('../src/store');
const { seedGoldenData, FIXED } = require('./helpers/golden-seed');

test('posting date validation accepts today and the past and rejects future dates', () => {
  assert.equal(assertPostingDate(currentPostingDate()), currentPostingDate());
  assert.equal(assertPostingDate('2020-01-01'), '2020-01-01');
  assert.throws(() => assertPostingDate('2999-01-01'), { code: 'future_posting_date', status: 400 });
  assert.throws(() => assertPostingDate('2026-02-30'), { code: 'invalid_posting_date' });
});

test('future-date boundary follows Kampala midnight rather than UTC midnight', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T20:59:59Z') });
  assert.equal(currentPostingDate(), '2026-10-17');
  assert.equal(require('../src/web/format').todayString(), '2026-10-17');
  assert.throws(() => assertPostingDate('2026-10-18'), { code: 'future_posting_date' });
  t.mock.timers.setTime(new Date('2026-10-17T21:00:00Z').getTime());
  assert.equal(currentPostingDate(), '2026-10-18');
  assert.equal(require('../src/web/format').todayString(), '2026-10-18');
  assert.equal(assertPostingDate('2026-10-18'), '2026-10-18');
});

test('all posted voucher and ledger types reject future dates; invoice drafts remain editable', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const tables = {
      app_invoices: 'invoice_date', app_invoice_payments: 'payment_date',
      app_purchases: 'posting_date', app_purchase_payments: 'payment_date',
      app_purchase_orders: 'posting_date', app_stock_entries: 'posting_date',
      app_journal_entries: 'posting_date', app_hr_money: 'posting_date',
      app_hr_runs: 'posting_date', app_hr_payments: 'posting_date',
      app_hr_attendance: 'attendance_date',
    };
    for (const [table, column] of Object.entries(tables)) {
      // BEFORE triggers must reject even vouchers with no financial lines.
      await assert.rejects(pool.query(`INSERT INTO ${table} (${column},docstatus) VALUES ('2999-01-01','submitted')`), /future_posting_date/, table);
    }
    for (const table of ['app_gl_entries', 'app_stock_ledger']) {
      await assert.rejects(pool.query(`INSERT INTO ${table} (posting_date) VALUES ('2999-01-01')`), /future_posting_date/, table);
    }
    const id = await store.createInvoice({ invoice_date: '2999-01-01', due_date: '2999-02-01',
      customer_id: FIXED.customerId, customer_name: FIXED.customerName, payments: [],
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 1, unit_price: 100 }] });
    await assert.rejects(store.submitInvoice(id), { code: 'future_posting_date', status: 400 });
    assert.equal((await pool.query('SELECT docstatus FROM app_invoices WHERE id=$1', [id])).rows[0].docstatus, 'draft');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1", [id])).rows[0].n, 0);
    await pool.query('UPDATE app_invoices SET invoice_date=$2 WHERE id=$1', [id, FIXED.date]);
    await store.submitInvoice(id);
    assert.equal((await pool.query('SELECT invoice_date::text FROM app_invoices WHERE id=$1', [id])).rows[0].invoice_date, FIXED.date);
  } finally { await store.closeStore(); }
});
