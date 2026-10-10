'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendGeneralLedgerExport } = require('../src/web/general-ledger-export');
const report = { filters: { from: '2026-10-01', to: '2026-10-08', account: 'Cash' }, summary: { debit: 10, credit: 2, balance: 8 }, rows: Array.from({ length: 205 }, (_,index) => ({ posting_date: '2026-10-08', account_code: '=SUM(1,2)', account_name: 'Cash "Desk"', debit: 10, credit: 2, running_balance: index * 8, voucher_type: 'journal_entry', voucher_no: `JE-${index}`, party_name: 'Counter', remarks: 'Count\nchecked' })) };
const response = () => ({ headers: {}, set(name,value) { this.headers[name] = value; }, attachment(name) { this.filename = name; }, type(value) { this.contentType = value; }, send(value) { this.body = value; } });
test('General Ledger CSV includes all entries, safe text, totals and numeric negatives', async () => {
  const res = response();
  await sendGeneralLedgerExport(res, report, 'csv');
  assert.match(res.body, /JE-204/);
  assert.match(res.body, /'\=SUM/);
  assert.match(res.body, /Cash ""Desk""/);
  assert.match(res.body, /"Total","10","2","8"/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('General Ledger Excel preserves numeric amounts and all rows', async () => {
  const ExcelJS = require('exceljs');
  const res = response(); await sendGeneralLedgerExport(res, report, 'xlsx');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(res.body);
  const sheet = workbook.getWorksheet('General Ledger');
  assert.equal(sheet.rowCount, 207);
  assert.equal(sheet.getCell('D2').value, 10);
  assert.equal(sheet.getCell('B2').value, '=SUM(1,2)');
  assert.equal(sheet.getCell('H206').value, 'JE-204');
  assert.equal(sheet.getCell('F207').value, 8);
  assert.match(workbook.getWorksheet('Report Details').getCell('B2').value, /account: Cash/);
});
test('General Ledger PDF handles multiple pages and empty reports', async () => {
  for (const rows of [report.rows, [{ ...report.rows[0], remarks: 'Detailed count confirmation. '.repeat(600) }], []]) {
    const res = response(); await sendGeneralLedgerExport(res, { ...report, rows }, 'pdf');
    assert.equal(res.body.subarray(0,5).toString(), '%PDF-');
    assert.match(res.body.toString('latin1'), /\/Type \/Page/);
    if (rows.length) assert.ok((res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
    else assert.equal((res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  }
});

test('General Ledger exports use the same filters and access options without pagination', async () => {
  const store = require('../src/store');
  const original = store.generalLedgerReport;
  const optionsOriginal = store.generalLedgerFilterOptions;
  const modulePath = require.resolve('../src/web/routes/reports');
  const calls = [];
  store.generalLedgerReport = async (filters, access) => { calls.push({filters,access}); return report; };
  store.generalLedgerFilterOptions = async () => ({});
  delete require.cache[modulePath];
  try {
    const handler = require(modulePath).stack.find(layer => layer.route?.path === '/general-ledger').route.stack[0].handle;
    const user = { role: 'standard', id: 33, permissions: ['reports.general-ledger.view'], scopes: {}, record_access: {} };
    const res = response();
    await handler({ query: { format: 'csv', account: 'Cash', q: 'Counter', from: '2026-10-01', page: '5' }, currentUser: user }, res, error => { throw error; });
    assert.equal(calls[0].access.exportAll, true);
    assert.equal(calls[0].access.ownerId, '33');
    assert.equal(calls[0].filters.account, 'Cash');
    assert.equal(calls[0].filters.search, 'Counter');
    assert.match(res.body, /JE-204/);
  } finally { store.generalLedgerReport = original; store.generalLedgerFilterOptions = optionsOriginal; delete require.cache[modulePath]; }
});

test('General Ledger database export removes the page limit and retains access restrictions', { skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1' }, async () => {
  const store = require('../src/store');
  const { seedGoldenData } = require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const account = (await pool.query('SELECT id FROM app_accounts ORDER BY id LIMIT 1')).rows[0].id;
    await pool.query(`INSERT INTO app_gl_entries (posting_date, account_id, debit, credit, voucher_type, voucher_id, voucher_no, line_no)
      SELECT '2026-10-08', $1, 10, 0, 'export_test', sequence, 'EXPORT-' || sequence, 1 FROM generate_series(1,205) sequence`, [account]);
    const filters = { voucher_type: 'export_test', page: 4, page_size: 50 };
    const paged = await store.generalLedgerReport(filters);
    assert.equal(paged.rows.length, 50);
    const all = await store.generalLedgerReport(filters, { exportAll: true });
    assert.equal(all.rows.length, 205);
    assert.equal(all.rows[204].running_balance, 2050);
    assert.deepEqual(all.summary, paged.summary);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, allowedAccounts: [] })).rows.length, 0);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, deniedAccounts: [String(account)] })).rows.length, 0);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, ownerId: '99999' })).rows.length, 0);
  } finally { await store.closeStore(); }
});
