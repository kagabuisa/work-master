'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { postGlEntry } = require('../src/domain/posting');
const { resetGoldenSchema } = require('./helpers/golden-seed');

test('multiple customer references allocate, validate and reverse each invoice independently', {
  skip: process.env.JOURNAL_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    const settings = (await pool.query('SELECT setting_key, account_id FROM app_accounting_settings')).rows;
    const account = (key) => Number(settings.find((row) => row.setting_key === key).account_id);
    for (const [reference, amount] of [['INV-MULTI-A', 100], ['INV-MULTI-B', 200]]) {
      const { rows } = await pool.query(`INSERT INTO app_invoices
        (invoice_no, invoice_date, customer_id, customer_name, subtotal, total, docstatus)
        VALUES ($1, '2026-10-01', 'CUST-MULTI', 'Customer Multi', $2, $2, 'submitted') RETURNING id`, [reference, amount]);
      await postGlEntry(pool, { posting_date: '2026-10-01', voucher_type: 'sales_invoice', voucher_id: rows[0].id,
        voucher_no: reference, party_type: 'customer', party_id: 'CUST-MULTI', party_name: 'Customer Multi',
        lines: [{ account_id: account('accounts_receivable'), debit: amount }, { account_id: account('sales_income'), credit: amount }] });
    }
    const payload = { journal_type: 'cash_receipt', party_type: 'customer', party_id: 'CUST-MULTI', party_name: 'Customer Multi', posting_date: '2026-10-02', lines: [
      { account_id: account('accounts_receivable'), credit: 100, reference_no: 'INV-MULTI-A' },
      { account_id: account('accounts_receivable'), credit: 150, reference_no: 'INV-MULTI-B' },
      { account_id: account('bank'), debit: 250 },
    ] };
    payload.lines.unshift({});
    const references = () => store.journalReferenceOptions({ party_type: 'customer', party_id: 'CUST-MULTI' });
    const balances = async () => (await references()).filter((row) => row.type === 'Invoice').sort((a, b) => a.reference.localeCompare(b.reference)).map((row) => Number(row.balance));
    const id = await store.createJournalEntry(payload, { submit: false });
    const draft = await store.findJournalEntry(id);
    await store.updateJournalEntry(id, { ...payload, lines: draft.lines });
    assert.deepEqual(draft.lines.map((line) => line.reference_no), ['INV-MULTI-A', 'INV-MULTI-B', null]);
    assert.deepEqual(await balances(), [100, 200]);
    await store.submitJournalEntry(id);
    assert.deepEqual(await balances(), [0, 50]);
    const invoices = await store.paginatedInvoices({ page_size: 20 });
    assert.deepEqual(invoices.rows.sort((a, b) => a.invoice_no.localeCompare(b.invoice_no)).map((invoice) => Number(invoice.amount_paid)), [100, 150]);
    const detail = await store.findInvoice(invoices.rows[0].id);
    assert(detail.payments.some((payment) => Number(payment.journal_id) === id || Number(payment.journal_entry_id) === id));
    const { invoiceReport } = require('../src/web/invoice-report');
    const invoiceRows = await invoiceReport({});
    assert.deepEqual(invoiceRows.rows.sort((a, b) => a.invoice_no.localeCompare(b.invoice_no)).map((invoice) => Number(invoice.amount_paid)), [100, 150]);
    const report = await store.debtorReport({ customer: 'CUST-MULTI' });
    assert.equal(Number(report.statement.at(-1).balance), 50);
    await assert.rejects(store.createJournalEntry(payload), /exceed/);
    await assert.rejects(store.createJournalEntry({ ...payload, party_id: 'OTHER' }), /belong/);
    await assert.rejects(store.createJournalEntry({ ...payload, posting_date: '2026-09-30' }), /posting date/);
    await assert.rejects(store.createJournalEntry({ ...payload, lines: payload.lines.map((line) => line.reference_no ? { ...line, account_id: account('sales_income') } : line) }), /Accounts Receivable/);
    await store.cancelJournalEntry(id);
    assert.deepEqual(await balances(), [100, 200]);
    const cancelled = await store.debtorReport({ customer: 'CUST-MULTI' });
    assert.equal(Number(cancelled.statement.at(-1).balance), 300);
    const legacy = await store.createJournalEntry({ ...payload, reference_no: 'INV-MULTI-B', lines: [
      { account_id: account('accounts_receivable'), credit: 25 }, { account_id: account('bank'), debit: 25 },
    ] });
    assert.deepEqual(await balances(), [100, 175]);
    await store.cancelJournalEntry(legacy);
    assert.deepEqual(await balances(), [100, 200]);
  } finally { await store.closeStore(); }
});
