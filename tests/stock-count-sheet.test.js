'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createCountSheet, readCountSheet, countSheetFilename, unknownCountItemsError, MAX_COUNT_FILE_BYTES, MAX_COUNT_ROWS } = require('../src/stock-count-sheet');
const { permissionCheck, scopeCheck } = require('../src/authorize');

async function file(rows, headers = ['Warehouse', 'Item Code', 'Item Name', 'Book Qty', 'Counted Qty']) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Count Sheet');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('Excel template preserves text codes and blank counts and round trips zero and decimal physical counts', async () => {
  const buffer = await createCountSheet('Main', [
    { item_code: '00123', item_name: '=FORMULA()', quantity: 5, valuation_rate: 32000 },
    { item_code: 'OTHER', item_name: 'Other', quantity: 2.125, valuation_rate: 5000.5 },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Count Sheet');
  assert.equal(sheet.getCell('B2').value, '00123');
  assert.equal(sheet.getCell('C2').value, '=FORMULA()');
  assert.equal(sheet.getCell('E2').value, null);
  assert.equal(sheet.getCell('E3').value, null);
  assert.equal(sheet.getCell('F1').value, 'Valuation Rate');
  assert.equal(sheet.getCell('F2').value, 32000);
  assert.equal(sheet.getCell('F3').value, 5000.5);
  assert(workbook.getWorksheet('Instructions'));
  await assert.rejects(readCountSheet(buffer, 'Main'), /No counts found/);
  sheet.getCell('E2').value = 0;
  sheet.getCell('E3').value = 1.001;
  const imported = await readCountSheet(Buffer.from(await workbook.xlsx.writeBuffer()), 'Main');
  assert.deepEqual(imported.map((row) => [row.item_code, row.quantity]), [['00123', 0], ['OTHER', 1.001]]);
});

test('count upload ignores blank counts and validates all counted rows before returning data', async () => {
  const rows = [ ['Main', 'A', 'A', 99, 0], ['Main', 'B', 'B', 100, '2.125'], ['Main', 'C', 'C', 10, ''] ];
  assert.deepEqual((await readCountSheet(await file(rows), 'Main')).map((row) => row.quantity), [0, 2.125]);
  await assert.rejects(readCountSheet(await file([...rows, ['Main', 'A', '', 0, 2]]), 'Main'), (error) => {
    assert.equal(error.message, 'Item A appears more than once on rows 2 and 5. Remove the extra counted rows, then upload the sheet again.');
    return true;
  });
  await assert.rejects(readCountSheet(await file([['Other', 'A', '', 0, 2]]), 'Main'), /warehouse must be Main/);
  for (const value of [-1, 1.0001, 'wrong', '1,200', { formula: '1+1', result: 2 }, true]) {
    await assert.rejects(readCountSheet(await file([['Main', 'A', '', 0, value]]), 'Main'), /Counted Qty/);
  }
  await assert.rejects(readCountSheet(await file([['Main', '', '', 0, 2]]), 'Main'), /Item Code/);
  await assert.rejects(readCountSheet(await file([], ['Item Code']), 'Main'), /Missing Warehouse/);
  await assert.rejects(readCountSheet(Buffer.from('invalid'), 'Main'), /not a valid Excel/);
  await assert.rejects(readCountSheet(Buffer.alloc(MAX_COUNT_FILE_BYTES + 1), 'Main'), /5 MB/);
  await assert.rejects(createCountSheet('Main', Array(MAX_COUNT_ROWS + 1)), /item rows/);
  await assert.rejects(readCountSheet(await file(Array.from({ length: MAX_COUNT_ROWS + 1 }, () => ['Main', 'A', '', 0, null])), 'Main'), /item rows/);
});

test('count upload reports every duplicated item and every counted row in one response', async () => {
  const rows = [
    ['Main', 'BRAKE SHOE TAFF(BLACK)-BM100', '', 10, 1],
    ['Main', 'B', '', 10, 2],
    ['Main', 'BRAKE SHOE TAFF(BLACK)-BM100', '', 10, 3],
    ['Main', 'C', '', 10, 4],
    ['Main', 'B', '', 10, 5],
    ['Main', 'BRAKE SHOE TAFF(BLACK)-BM100', '', 10, 6],
    ['Main', 'D', '', 10, ''],
    ['Main', 'D', '', 10, ''],
  ];
  await assert.rejects(readCountSheet(await file(rows), 'Main'), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /^Duplicate items:/);
    assert.match(error.message, /item BRAKE SHOE TAFF\(BLACK\)-BM100 appears more than once on rows 2, 4 and 7/);
    assert.match(error.message, /item B appears more than once on rows 3 and 6/);
    assert.doesNotMatch(error.message, /item C/);
    assert.doesNotMatch(error.message, /item D/);
    return true;
  });
});

test('count upload summarises duplicate lists that exceed the report limits', async () => {
  const rows = [];
  for (let index = 0; index < 13; index += 1) rows.push(['Main', 'MANY', '', 0, index]);
  for (let index = 0; index < 23; index += 1) rows.push(['Main', `D${index}`, '', 0, 1], ['Main', `D${index}`, '', 0, 2]);
  await assert.rejects(readCountSheet(await file(rows), 'Main'), (error) => {
    assert.match(error.message, /^Duplicate items:/);
    assert.match(error.message, /item MANY appears more than once on rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 and 1 more row/);
    assert.match(error.message, /4 more duplicated items are not listed/);
    assert.doesNotMatch(error.message, /item D19/);
    return true;
  });
});

test('count upload reports unknown sheet items with their rows', () => {
  const single = unknownCountItemsError([{ item_code: 'MISSING-1', sheet_row: 87 }]);
  assert.equal(single.status, 400);
  assert.equal(single.message, 'Unknown item: MISSING-1 on row 87. Check the item code, then upload the sheet again.');
  const multiple = unknownCountItemsError([
    { item_code: 'MISSING-1', sheet_row: 2 },
    { item_code: 'MISSING-2', sheet_row: 6 },
    { item_code: 'MISSING-1', sheet_row: 4 },
  ]);
  assert.equal(multiple.status, 400);
  assert.equal(multiple.message, 'Unknown items: MISSING-1 on rows 2 and 4; MISSING-2 on row 6. Check the item codes, then upload the sheet again.');
});

test('count sheet actions require stock permissions and retain supplier restrictions without a multipart body', async () => {
  const allowed = (path, method, permissions) => permissionCheck({ path, method, currentUser: { role: 'staff', permissions } });
  const template = '/stock/reconciliations/count-sheet-template';
  const upload = '/stock/reconciliations/count-sheet-upload';
  assert.equal(allowed(template, 'GET', ['vouchers.stock.view']), true);
  assert.equal(allowed(template, 'GET', ['vouchers.stock.create']), true);
  assert.equal(allowed(template, 'POST', ['vouchers.stock.view']), false);
  assert.equal(allowed(upload, 'POST', ['vouchers.stock.view']), false);
  assert.equal(allowed(upload, 'POST', ['vouchers.stock.create']), true);
  assert.equal(allowed(upload, 'POST', ['vouchers.stock.edit']), true);
  assert.equal(allowed(upload + '/extra', 'POST', ['vouchers.stock.create']), false);
  assert.equal(await scopeCheck({ path: upload, method: 'POST', currentUser: { role: 'staff', scopes: {} } }), true);
  assert.equal(await scopeCheck({ path: upload, method: 'POST', currentUser: { role: 'staff', scopes: { suppliers: { mode: 'selected', values: ['Supplier'] } } } }), false);
});

test('count-sheet routes enforce warehouse, draft and item validation without saving stock', async () => {
  const express = require('express');
  const store = require('../src/store');
  const originalPool = store.getPostgresPool;
  const originalLoad = store.loadStockEntry;
  const routePath = require.resolve('../src/web/routes/stock');
  const queries = [];
  let docstatus = 'draft';
  store.getPostgresPool = () => ({ async query(sql) {
    queries.push(sql);
    if (sql.includes('app_master_warehouses')) return { rows: [{ valid: 1 }] };
    if (sql.includes('app_master_items')) return { rows: [{ item_code: 'A', item_name: 'Actual Name', book: 5, rate: 10, quantity: 5, valuation_rate: 10 }] };
    throw new Error('Unexpected write or query');
  } });
  store.loadStockEntry = async () => ({ entry: { id: 1, entry_no: 'REC-000001', entry_type: 'reconciliation', docstatus }, items: [{ id: 4, item_code: 'A', warehouse: 'Main', valuation_rate: 12 }] });
  delete require.cache[routePath];
  const app = express();
  app.use((req, res, next) => {
    req.currentUser = { role: 'staff', permissions: ['vouchers.stock.create', 'vouchers.stock.edit'], scopes: { warehouses: { mode: 'selected', values: ['Main'] } } };
    next();
  });
  app.use('/stock', require(routePath));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}/stock/reconciliations`;
  async function upload(buffer, warehouse = 'Main', voucher = '') {
    const body = new FormData();
    body.append('count_sheet', new Blob([buffer]), 'counts.xlsx');
    body.append('warehouse', warehouse);
    if (voucher) body.append('voucher_id', voucher);
    const response = await fetch(root + '/count-sheet-upload', { method: 'POST', body });
    return { status: response.status, body: await response.json() };
  }
  try {
    const buffer = await file([['Main', 'A', 'Forged Name', 999, 2]]);
    const imported = await upload(buffer, 'Main', '1');
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body.items[0], { code: 'A', name: 'Actual Name', book: 5, counted: 2, rate: 12, bookRate: 10 });
    assert.equal((await upload(buffer, 'Other')).status, 403);
    assert.equal((await upload(await file([['Main', 'UNKNOWN', '', 0, 1]]))).status, 400);
    const duplicates = await upload(await file([
      ['Main', 'A', '', 0, 1], ['Main', 'B', '', 0, 2], ['Main', 'A', '', 0, 3], ['Main', 'B', '', 0, 4],
    ]));
    assert.equal(duplicates.status, 400);
    assert.match(duplicates.body.error, /item A appears more than once on rows 2 and 4/);
    assert.match(duplicates.body.error, /item B appears more than once on rows 3 and 5/);
    docstatus = 'submitted';
    assert.equal((await upload(buffer, 'Main', '1')).status, 403);
    const downloaded = await fetch(root + '/count-sheet-template?warehouse=Main');
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-type'), /spreadsheetml/);
    assert.match(downloaded.headers.get('content-disposition'), /new-reconciliation-Main-count-sheet\.xlsx/);
    const savedDownload = await fetch(root + '/count-sheet-template?warehouse=Main&voucher_id=1');
    assert.equal(savedDownload.status, 200);
    assert.match(savedDownload.headers.get('content-disposition'), /REC-000001-Main-count-sheet\.xlsx/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await downloaded.arrayBuffer()));
    assert.equal(workbook.getWorksheet('Count Sheet').getCell('D2').value, 5);
    assert.equal(workbook.getWorksheet('Count Sheet').getCell('F2').value, 10);
    assert(queries.every((sql) => /^SELECT/.test(sql)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.getPostgresPool = originalPool;
    store.loadStockEntry = originalLoad;
    delete require.cache[routePath];
  }
});


test('count sheet filenames include reconciliation number and safe warehouse names', () => {
  assert.equal(countSheetFilename('REC-000001', 'Main Store'), 'REC-000001-Main-Store-count-sheet.xlsx');
  assert.equal(countSheetFilename('', 'Main Store'), 'new-reconciliation-Main-Store-count-sheet.xlsx');
  assert.equal(countSheetFilename('../REC/1', 'Main\r\nStore/West'), 'REC-1-Main-Store-West-count-sheet.xlsx');
});

test('controlled sheets bind to the frozen count revision and reject another session or revision',async()=>{
 const session={id:7,revision:2,cutoff:'2026-10-17T10:00:00.000Z'};
 const buffer=await createCountSheet('Main',[{item_code:'A',item_name:'Item A',quantity:10,valuation_rate:25}],session);
 const workbook=new (require('exceljs').Workbook)();await workbook.xlsx.load(buffer);
 assert.equal(workbook.getWorksheet('Count Sheet').getCell('F2').value,25);
 workbook.getWorksheet('Count Sheet').getRow(2).getCell(5).value=8;
 const counted=Buffer.from(await workbook.xlsx.writeBuffer());
 assert.equal((await readCountSheet(counted,'Main',session))[0].quantity,8);
 await assert.rejects(readCountSheet(counted,'Main',{...session,revision:3}),/stale revision/);
 await assert.rejects(readCountSheet(counted,'Main',{...session,id:8}),/different count/);
});
