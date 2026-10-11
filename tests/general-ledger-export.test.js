'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendGeneralLedgerExport } = require('../src/web/general-ledger-export');
const report = { filters: { from: '2026-10-01', to: '2026-10-08', account: 'Cash' }, summary: { debit: 10, credit: 2, balance: 8 }, rows: Array.from({ length: 205 }, (_,index) => ({ posting_date: '2026-10-08', account_code: '=SUM(1,2)', account_name: 'Cash "Desk"', debit: 10, credit: 2, running_balance: index * 8, voucher_type: 'journal_entry', voucher_no: `JE-${index}`, party_name: 'Counter', remarks: 'Count\nchecked' })) };
const response = () => {
  const { Writable } = require('node:stream');
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.headers = {};
  res.set = (name, value) => { res.headers[name] = value; };
  res.attachment = name => { res.filename = name; };
  res.type = value => { res.contentType = value; };
  Object.defineProperty(res, 'body', { get() {
    const buffer = Buffer.concat(chunks);
    return res.contentType === 'text/csv' ? buffer.toString() : buffer;
  } });
  return res;
};
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
  const jobs = require('../src/web/ledger-export-jobs');
  const original = jobs.sendGeneralLedgerDownload;
  const modulePath = require.resolve('../src/web/routes/reports');
  const calls = [];
  jobs.sendGeneralLedgerDownload = async (req, res, filters, access, format) => {
    calls.push({ filters, access, format });
    await sendGeneralLedgerExport(res, report, format);
  };
  delete require.cache[modulePath];
  try {
    const handler = require(modulePath).stack.find(layer => layer.route?.path === '/general-ledger').route.stack[0].handle;
    const user = { role: 'standard', id: 33, permissions: ['reports.general-ledger.view'], scopes: {}, record_access: {} };
    const res = response();
    await handler({ query: { format: 'csv', account: 'Cash', q: 'Counter', from: '2026-10-01', page: '5' }, currentUser: user }, res, error => { throw error; });
    assert.equal(calls[0].format, 'csv');
    assert.equal(calls[0].access.ownerId, '33');
    assert.equal(calls[0].filters.account, 'Cash');
    assert.equal(calls[0].filters.search, 'Counter');
    assert.match(res.body, /JE-204/);
  } finally { jobs.sendGeneralLedgerDownload = original; delete require.cache[modulePath]; }
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

test('export queue bounds workers, cancels queued work and limits PDF workers', async () => {
  const { ExportQueue } = require('../src/web/ledger-export-jobs');
  const queue = new ExportQueue({ workers: 2, pdfWorkers: 1, queue: 1, waitMs: 1000 });
  const pdf = await queue.acquire('pdf');
  const cancelled = new AbortController();
  const waitingPdf = queue.acquire('pdf', cancelled.signal);
  await assert.rejects(queue.acquire('pdf'), { status: 429 });
  cancelled.abort(new Error('closed'));
  await assert.rejects(waitingPdf, /closed/);
  const csv = await queue.acquire('csv');
  assert.equal(queue.active, 2);
  const waiting = queue.acquire('xlsx');
  csv();
  const xlsx = await waiting;
  assert.equal(queue.active, 2);
  xlsx(); pdf(); pdf();
  assert.equal(queue.active, 0);
  assert.equal(queue.pdfActive, 0);
});

test('export queue expires queued downloads and releases their place', async () => {
  const { ExportQueue } = require('../src/web/ledger-export-jobs');
  const queue = new ExportQueue({ workers: 1, pdfWorkers: 1, queue: 1, waitMs: 10 });
  const release = await queue.acquire('csv');
  await assert.rejects(queue.acquire('xlsx'), { status: 429 });
  assert.equal(queue.waiting.length, 0);
  release();
  (await queue.acquire('pdf'))();
});

test('streamed ledger snapshot retains balances across batches and releases its cursor after failures', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { withGeneralLedgerExport } = require('../src/domain/ledger');
  const { seedGoldenData } = require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const account = (await pool.query('SELECT id FROM app_accounts ORDER BY id LIMIT 1')).rows[0].id;
    await pool.query(`INSERT INTO app_gl_entries (posting_date, account_id, debit, credit, voucher_type, voucher_id, voucher_no, line_no)
      SELECT '2026-10-08', $1, 10, 0, 'stream_test', sequence, 'STREAM-' || sequence, 1 FROM generate_series(1,12) sequence`, [account]);
    const filters = { voucher_type: 'stream_test', page: 5, page_size: 1 };
    const expected = await store.generalLedgerReport(filters, { exportAll: true });
    await withGeneralLedgerExport(filters, {}, async report => {
      assert.deepEqual(report.summary, expected.summary);
      const rows = [];
      for await (const row of report.rows) {
        rows.push(row);
        // This concurrent insert must not change either the rows or the totals.
        if (rows.length === 1) await pool.query(`INSERT INTO app_gl_entries
          (posting_date,account_id,debit,credit,voucher_type,voucher_no,line_no)
          VALUES ('2026-10-08',$1,99,0,'stream_test','LATE',1)`, [account]);
      }
      assert.deepEqual(rows, expected.rows);
    }, { batchSize: 3 });
    for (const access of [{ allowedAccounts: [] }, { deniedAccounts: [String(account)] }, { ownerId: '99999' }]) {
      await withGeneralLedgerExport(filters, access, async report => {
        const rows = []; for await (const row of report.rows) rows.push(row);
        assert.equal(rows.length, 0); assert.equal(report.pagination.total, 0);
      }, { batchSize: 2 });
    }
    await assert.rejects(withGeneralLedgerExport(filters, {}, async report => {
      for await (const row of report.rows) { assert.ok(row); throw new Error('output failed'); }
    }), /output failed/);
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
  } finally { await store.closeStore(); }
});

test('download workers generate files and clean up after completion or cancellation', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const { EventEmitter } = require('node:events');
  const { sendGeneralLedgerDownload } = require('../src/web/ledger-export-jobs');
  const store = require('../src/store');
  const { seedGoldenData } = require('./helpers/golden-seed');
  const fs = require('node:fs');
  const os = require('node:os');
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('wm-ledger-export-'));
  try {
    await seedGoldenData();
    const before = leftovers();
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const req = new EventEmitter();
      const res = response();
      await sendGeneralLedgerDownload(req, res, {}, {}, format);
      assert.ok(res.body.length);
      assert.equal(res.writableFinished, true);
      assert.deepEqual(leftovers(), before);
    }
    const req = new EventEmitter();
    const res = response();
    const pending = sendGeneralLedgerDownload(req, res, {}, {}, 'pdf');
    await new Promise(resolve => setTimeout(resolve, 20));
    req.emit('aborted');
    await pending;
    assert.deepEqual(leftovers(), before);
    const jobsPath = require.resolve('../src/web/ledger-export-jobs');
    const original = process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS;
    const previousModule = require.cache[jobsPath];
    process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS = '5';
    delete require.cache[jobsPath];
    try {
      const { sendGeneralLedgerDownload: timedDownload } = require(jobsPath);
      await assert.rejects(timedDownload(new EventEmitter(), response(), {}, {}, 'pdf'), { status: 503 });
      assert.deepEqual(leftovers(), before);
    } finally {
      if (original === undefined) delete process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS;
      else process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS = original;
      require.cache[jobsPath] = previousModule;
    }
  } finally { await store.closeStore(); }
});
