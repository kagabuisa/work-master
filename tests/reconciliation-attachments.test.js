'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScans, saveAttachments, listAttachments, findAttachment, deleteAttachment, MAX_SCAN_BYTES } = require('../src/reconciliation-attachments');
const { permissionCheck } = require('../src/authorize');
const pdf = (name = 'count.pdf') => ({ originalname: name, buffer: Buffer.from('%PDF-1.7\nphysical count') });

test('scanned sheets validate content, size and batch before writing', async () => {
  assert.equal(validateScans([pdf('../count.pdf')])[0].name, 'count.pdf');
  assert.equal(validateScans([pdf()])[0].type, 'application/pdf');
  assert.equal(validateScans([{ originalname: 'scan.jpg', buffer: Buffer.from([255,216,255,0]) }])[0].type, 'image/jpeg');
  assert.equal(validateScans([{ originalname: 'scan.png', buffer: Buffer.from([137,80,78,71,13,10,26,10]) }])[0].type, 'image/png');
  assert.equal(validateScans([{ originalname: 'count.csv', buffer: Buffer.from('Item,Count\nITEM-1,3') }])[0].type, 'text/csv');
  assert.equal(validateScans([{ originalname: 'count.xls', buffer: Buffer.from([208,207,17,224,161,177,26,225]) }])[0].type, 'application/vnd.ms-excel');
  assert.throws(() => validateScans([pdf('count.xlsx')]), /matching file content/);
  assert.throws(() => validateScans([{ originalname: 'count.csv', buffer: Buffer.from([0,1,2]) }]), /matching file content/);
  assert.throws(() => validateScans([]), /at least one/);
  assert.throws(() => validateScans([pdf(), pdf(), pdf(), pdf()]), /three/);
  assert.throws(() => validateScans([{ ...pdf(), buffer: Buffer.alloc(MAX_SCAN_BYTES + 1) }]), /10 MB/);
  assert.throws(() => validateScans([pdf('scan.jpg')]), /matching file content/);
  let queries = 0;
  await assert.rejects(saveAttachments({ query: async () => { queries++; } }, 1, [pdf(), pdf('bad.exe')], {}), /matching file content/);
  assert.equal(queries, 0);
});

test('Excel workbook attachments accept generated workbook content', async () => {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Count').addRow(['Item', 'Count']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.equal(validateScans([{ originalname: 'count.xlsx', buffer }])[0].type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('scanned sheet access follows stock view and edit permissions', () => {
  const check = (path, method, permissions) => permissionCheck({ path, method, currentUser: { role: 'standard', permissions } });
  const base = '/stock/reconciliations/12/attachments';
  assert.equal(check(base, 'GET', ['vouchers.stock.view']), true);
  assert.equal(check(`${base}/1`, 'GET', ['vouchers.stock.view']), true);
  assert.equal(check(base, 'POST', ['vouchers.stock.view']), false);
  assert.equal(check(base, 'POST', ['vouchers.stock.edit']), true);
  assert.equal(check(`${base}/1/delete`, 'POST', ['vouchers.stock.view']), false);
  assert.equal(check(`${base}/1/delete`, 'POST', ['vouchers.stock.edit']), true);
  assert.equal(check(`${base}/1/delete`, 'GET', ['vouchers.stock.edit']), false);
  assert.equal(check(base, 'GET', []), false);
});

test('scanned sheets persist with the voucher and cannot cross voucher boundaries', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { FIXED, seedGoldenData } = require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    await pool.query(`ALTER TABLE app_stock_reconciliation_attachments
      DROP CONSTRAINT app_stock_reconciliation_attachments_content_type_check,
      ADD CONSTRAINT app_stock_reconciliation_attachments_content_type_check
        CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png'))`);
    await pool.query('DELETE FROM wm_schema_version WHERE version = 12');
    await store.initStore();
    await store.initStore();
    const create = () => store.createStockEntry({ entry_type: 'reconciliation', action: 'save_draft', posting_date: FIXED.date,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 5, valuation_rate: 50 }] });
    const id = await create();
    const otherId = await create();
    const before = (await pool.query('SELECT COUNT(*)::int AS count FROM app_stock_ledger')).rows[0].count;
    for (const status of ['draft', 'submitted', 'cancelled']) {
      await pool.query('UPDATE app_stock_entries SET docstatus=$2 WHERE id=$1', [id, status]);
      assert.equal(await store.withPostgresTransaction(client => saveAttachments(client, id, [pdf(`${status}.pdf`)], { id: 1, username: 'counter' })), 1);
    }
    const files = await listAttachments(pool, id);
    assert.equal(files.length, 3);
    assert.equal(files[0].uploaded_by, 'counter');
    assert.equal((await findAttachment(pool, id, files[0].id)).content.toString(), pdf().buffer.toString());
    await assert.rejects(findAttachment(pool, otherId, files[0].id), { status: 404 });
    await assert.rejects(deleteAttachment(pool, otherId, files[0].id), { status: 404 });
    assert.equal((await listAttachments(pool, id)).length, 3);
    await deleteAttachment(pool, id, files[0].id);
    assert.equal((await listAttachments(pool, id)).length, 2);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_stock_ledger')).rows[0].count, before);
    assert.equal((await store.loadStockEntry(id)).items.length, 1);
    const express = require('express');
    const app = express();
    app.use((req, res, next) => {
      req.currentUser = { role: 'admin', id: 1, username: 'counter' };
      res.locals.formatTimestamp = value => String(value);
      next();
    });
    app.use('/stock', require('../src/web/routes/stock'));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/stock/reconciliations/${id}/attachments`;
      const form = new FormData();
      for (let i = 0; i < 3; i++) form.append('scans', new Blob([pdf().buffer], { type: 'application/pdf' }), `sheet-${i}.pdf`);
      const response = await fetch(endpoint, { method: 'POST', body: form, headers: { Accept: 'application/json' } });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).uploaded, 3);
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Count').addRow(['Item', 'Count']);
      const spreadsheets = new FormData();
      spreadsheets.append('scans', new Blob(['Item,Count\nITEM-1,3']), 'count.csv');
      spreadsheets.append('scans', new Blob([await workbook.xlsx.writeBuffer()]), 'count.xlsx');
      spreadsheets.append('scans', new Blob([Buffer.from([208,207,17,224,161,177,26,225])]), 'count.xls');
      const sheetResponse = await fetch(endpoint, { method: 'POST', body: spreadsheets, headers: { Accept: 'application/json' } });
      assert.equal(sheetResponse.status, 200, await sheetResponse.clone().text());
      assert.equal((await sheetResponse.json()).uploaded, 3);
      const listing = await (await fetch(endpoint)).json();
      assert.equal(listing.length, 8);
      const download = await fetch(`${endpoint}/${listing[0].id}`);
      assert.match(download.headers.get('content-disposition'), /^attachment;/);
      assert.equal(await download.text(), pdf().buffer.toString());
      const removed = await fetch(`${endpoint}/${listing[0].id}/delete`, { method: 'POST', headers: { Accept: 'application/json' } });
      assert.equal(removed.status, 200);
    } finally { await new Promise(resolve => server.close(resolve)); }
    await pool.query('DELETE FROM app_stock_entries WHERE id=$1', [id]);
    assert.equal((await listAttachments(pool, id)).length, 0);
  } finally { await store.closeStore(); }
});

test('proxy HTML 413 responses explain the upload size limit', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const status = { hidden: true, textContent: '', classList: { toggle() {} } };
  const section = { dataset: { voucherId: '12', canManage: 'false' },
    querySelector: selector => selector === '[data-scan-status]' ? status : null };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/reconciliation-attachments.js'), 'utf8'), {
    document: { querySelector: () => section },
    fetch: async () => ({ status: 413, headers: { get: () => 'text/html' } }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(status.textContent, /request is too large/);
  assert.match(status.textContent, /server upload limit/);
  assert.equal(status.hidden, false);
});
