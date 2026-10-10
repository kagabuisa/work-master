'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendCustomerStatementPdf } = require('../src/web/customer-statement-pdf');
const response = () => ({ locals: { formatDate: value => `Formatted ${value}` }, headers: {}, set(name, value) { this.headers[name] = value; }, attachment(value) { this.filename = value; }, type(value) { this.contentType = value; }, send(value) { this.body = value; }, status(value) { this.statusCode = value; return this; } });
const report = { selected: { customer_name: 'Acme / Traders', customer_id: 'C-001' }, filters: { customer: 'C-001', statement_from: '2026-10-01', statement_to: '2026-10-08' }, statementBalance: 1000, statement: [] };
test('Customer statement PDFs handle empty, multiple pages and long descriptions', async () => {
  const entry = { date: '2026-10-08', type: 'Invoice', reference: 'INV-001', description: 'Goods supplied', debit: 1000, credit: 0, balance: 1000 };
  for (const statement of [[], Array.from({ length: 205 }, () => entry), [{ ...entry, description: 'Detailed description '.repeat(1000) }]]) {
    const res = response();
    const dates = [];
    await sendCustomerStatementPdf(res, { ...report, statement }, { name: 'Test Company', address: 'Kampala', phone: '123' }, value => { dates.push(value); return value; });
    assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal(res.filename, 'Acme-Traders-statement.pdf');
    assert.equal(res.contentType, 'application/pdf');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    const pages = (res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.ok(statement.length ? pages > 1 : pages === 1);
    assert.ok(dates.includes('2026-10-01'));
    assert.ok(dates.includes('2026-10-08'));
  }
});
test('PDF downloads reuse debtor filters and reject unavailable customers', async () => {
  const store = require('../src/store');
  const originalReport = store.debtorReport;
  const originalCompany = store.getCompanyInformation;
  const modulePath = require.resolve('../src/web/routes/reports');
  const calls = [];
  store.debtorReport = async filters => { calls.push(filters); return filters.customer === 'C-001' ? report : { ...report, selected: null }; };
  store.getCompanyInformation = async () => ({ name: 'Test Company' });
  delete require.cache[modulePath];
  try {
    const handler = require(modulePath).stack.find(layer => layer.route?.path === '/debtors').route.stack[0].handle;
    const res = response();
    await handler({ query: { format: 'pdf', customer: 'C-001', q: 'Acme', from: '2026-09-01', statement_from: '2026-10-01', statement_to: '2026-10-08' } }, res, error => { throw error; });
    assert.equal(res.contentType, 'application/pdf');
    assert.equal(calls[0].customer, 'C-001');
    assert.equal(calls[0].search, 'Acme');
    assert.equal(calls[0].from, '2026-09-01');
    assert.equal(calls[0].statementFrom, '2026-10-01');
    assert.equal(calls[0].statementTo, '2026-10-08');
    for (const customer of ['', 'missing']) {
      const missing = response();
      await handler({ query: { format: 'pdf', customer } }, missing, error => { throw error; });
      assert.equal(missing.statusCode, 404);
    }
  } finally {
    store.debtorReport = originalReport;
    store.getCompanyInformation = originalCompany;
    delete require.cache[modulePath];
  }
});
