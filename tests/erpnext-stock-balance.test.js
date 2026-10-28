'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { erpnextStockBalance, normalizeFilters } = require('../src/web/erpnext-stock-balance');
const { permissionCheck } = require('../src/authorize');
const { renderView } = require('./helpers/render-view');
const { stockBalanceExcel, stockBalancePdf } = require('../src/web/stock-balance-download');

const admin = { role: 'admin' };
const keys = ['ERPNEXT_URL', 'ERPNEXT_USERNAME', 'ERPNEXT_PASSWORD'];
let previous, originalFetch, calls;
test.beforeEach(() => {
  originalFetch = global.fetch;
  previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === 'ERPNEXT_URL' ? 'https://erp.example' : 'private-test-value'; });
  calls = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname.endsWith('/login')) return { ok: true, headers: { getSetCookie: () => ['sid=test; HttpOnly'] } };
    let data;
    if (parsed.pathname.endsWith('/Warehouse')) data = [{ name: 'Main & Shop' }, { name: 'Store' }];
    else if (parsed.pathname.endsWith('/Item')) data = [{ name: 'ITEM-001', cost: 12.125 }, { name: 'ITEM-002', cost: null, last_purchase_rate: 3.5 }];
    else data = [
      { name: 'BIN-1', item_code: 'ITEM-001', actual_qty: 10, stock_value: 160 },
      { name: 'BIN-2', item_code: 'ITEM-001', actual_qty: 5, stock_value: 80 },
      { name: 'BIN-3', item_code: 'ITEM-002', actual_qty: -2, stock_value: -7 },
      ...Array.from({ length: 49 }, (_, i) => ({ name: `BIN-${i + 4}`, item_code: `ITEM-${String(i + 3).padStart(3, '0')}`, actual_qty: 1, stock_value: 1 })),
    ];
    return { ok: true, json: async () => ({ data }) };
  };
});
test.afterEach(() => {
  global.fetch = originalFetch;
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
});

test('warehouse filters accept one or multiple selections and reject malformed or excessive input', () => {
  assert.deepEqual(normalizeFilters({ warehouse: [' Main & Shop ', 'Store', 'Store', ''] }).warehouses, ['Main & Shop', 'Store']);
  assert.deepEqual(normalizeFilters({ warehouse: 'Store', page: '-2' }).warehouses, ['Store']);
  assert.equal(normalizeFilters({ page: '-2' }).page, 1);
  for (const warehouse of [{ name: 'Store' }, ['x'.repeat(141)], Array(101).fill('Store')]) {
    assert.throws(() => normalizeFilters({ warehouse }), { status: 400 });
  }
});

test('ERPNext balances use selected warehouses, grouped quantities and values, item costs, and full filtered totals', async () => {
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'], q: 'ITEM' }, admin);
  assert.deepEqual(report.rows.slice(0, 2), [
    { item_code: 'ITEM-001', quantity: 15, stock_value: 240, cost: 12.125, valuation_rate: 16 },
    { item_code: 'ITEM-002', quantity: -2, stock_value: -7, cost: 3.5, valuation_rate: 3.5 },
  ]);
  assert.deepEqual(report.summary, { total: 51, quantity: 62, stock_value: 282 });
  const binCalls = calls.filter(call => call.url.pathname.endsWith('/Bin'));
  for (const call of binCalls) {
    assert.deepEqual(JSON.parse(call.url.searchParams.get('filters')), [
      ['warehouse', 'in', ['Main & Shop', 'Store']], ['actual_qty', '!=', 0], ['item_code', 'like', '%ITEM%'],
    ]);
    assert.equal(call.options.headers.cookie, 'sid=test');
  }
  assert.equal(binCalls.length, 1);
  assert.equal(binCalls[0].url.searchParams.get('limit_start'), '0');
  assert.equal(binCalls[0].url.searchParams.get('limit_page_length'), '500');
  assert.equal(binCalls[0].url.searchParams.has('group_by'), false);
  const next = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'], page: '2' }, admin);
  assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].item_code, 'ITEM-051');
  assert.equal(next.pagination.start, 51);
  assert.deepEqual(new URLSearchParams(report.query).getAll('warehouse'), ['Main & Shop', 'Store']);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/Item')).length, 2);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('empty selection never queries stock, denied selections fail before contacting ERPNext, and unknown warehouses fail closed', async () => {
  const report = await erpnextStockBalance({}, admin);
  assert.equal(report.rows.length, 0);
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/Bin')));
  calls = [];
  await assert.rejects(() => erpnextStockBalance({ warehouse: ['Store', 'Secret'] }, {
    role: 'privileged', scopes: { warehouses: { mode: 'selected', values: ['Store'] } },
  }), { status: 403 });
  assert.equal(calls.length, 0);
  await assert.rejects(() => erpnextStockBalance({ warehouse: 'Unknown' }, admin), { status: 400 });
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/Bin')));
});

test('warehouse options honor named assignments, grants and denials in both API filters and returned names', async () => {
  const user = { role: 'privileged', record_access: { warehouse: 'Store' },
    permission_grants: ['warehouse.view:Main & Shop'], permission_denials: ['warehouse.view:Main & Shop'] };
  const report = await erpnextStockBalance({}, user);
  assert.deepEqual(report.warehouses, ['Store']);
  const warehouse = calls.find(call => call.url.pathname.endsWith('/Warehouse'));
  assert.deepEqual(JSON.parse(warehouse.url.searchParams.get('filters')), [
    ['disabled', '=', 0], ['name', 'in', ['Store']], ['name', 'not in', ['Main & Shop']],
  ]);
});

test('all warehouse-option pages are loaded and an empty allowed scope makes no resource reads', async () => {
  const mock = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/Warehouse')) {
      calls.push({ url: parsed, options });
      const data = parsed.searchParams.get('limit_start') === '0'
        ? Array.from({ length: 500 }, (_, i) => ({ name: `Store-${i}` })) : [{ name: 'Last Store' }];
      return { ok: true, json: async () => ({ data }) };
    }
    return mock(url, options);
  };
  assert.equal((await erpnextStockBalance({}, admin)).warehouses.length, 501);
  assert.ok(calls.some(call => call.url.searchParams.get('limit_start') === '500'));
  calls = [];
  assert.deepEqual((await erpnextStockBalance({}, { role: 'privileged', scopes: { warehouses: { mode: 'selected', values: [] } } })).warehouses, []);
  assert.equal(calls.length, 1); // authentication only
});

test('zero combined quantity has no valuation rate, missing cost stays unavailable, and page is clamped', async () => {
  const mock = global.fetch;
  global.fetch = async (url, options) => {
    if (url.includes('/Bin?')) {
      return { ok: true, json: async () => ({ data: [
        { item_code: 'MISSING', actual_qty: 2, stock_value: 6 },
        { item_code: 'MISSING', actual_qty: -2, stock_value: -3 },
      ] }) };
    }
    return mock(url, options);
  };
  const report = await erpnextStockBalance({ warehouse: 'Store', page: '99' }, admin);
  assert.equal(report.filters.page, 1);
  assert.equal(report.rows[0].valuation_rate, null);
  assert.equal(report.rows[0].cost, null);
});

test('stock totals include every Bin page and combine the same item across page boundaries', async () => {
  const mock = global.fetch;
  const starts = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/Bin')) return mock(url, options);
    const start = parsed.searchParams.get('limit_start');
    starts.push(start);
    const data = start === '0'
      ? Array.from({ length: 500 }, () => ({ item_code: 'ITEM-001', actual_qty: 0.5, stock_value: 4 }))
      : [{ item_code: 'ITEM-001', actual_qty: 2, stock_value: 16 }];
    return { ok: true, json: async () => ({ data }) };
  };
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'] }, admin);
  assert.deepEqual(starts, ['0', '500']);
  assert.deepEqual(report.summary, { total: 1, quantity: 252, stock_value: 2016 });
  assert.equal(report.rows[0].valuation_rate, 8);
});

test('missing credentials, denied ERPNext reads, invalid data, and network failures produce safe source errors', async () => {
  delete process.env.ERPNEXT_URL;
  await assert.rejects(() => erpnextStockBalance({}, admin), { status: 503, code: 'ERPNEXT_STOCK_UNAVAILABLE' });
  assert.equal(calls.length, 0);
  process.env.ERPNEXT_URL = 'https://erp.example';
  const mock = global.fetch;
  for (const response of [{ ok: false, status: 403 }, { ok: true, json: async () => ({ data: {} }) }]) {
    global.fetch = (url, options) => url.endsWith('/login') ? mock(url, options) : response;
    await assert.rejects(() => erpnextStockBalance({}, admin), { status: 503, code: 'ERPNEXT_STOCK_UNAVAILABLE' });
  }
  global.fetch = async () => { throw new Error('private connection detail'); };
  await assert.rejects(() => erpnextStockBalance({}, admin), error => error.status === 503
    && !error.message.includes('private connection detail') && !error.message.includes('private-test-value'));
});

test('ERPNext tab requires stock Read and has no mutation route permissions', () => {
  const allowed = (method, permissions, suffix = '') => permissionCheck({ method,
    path: `/stock/erpnext${suffix}`, currentUser: { role: 'privileged', permissions } });
  assert.equal(allowed('GET', ['vouchers.stock.view']), true);
  assert.equal(allowed('GET', []), false);
  assert.equal(allowed('POST', ['vouchers.stock.view']), false);
  assert.equal(allowed('GET', ['vouchers.stock.view'], '/extra'), false);
  assert.equal(allowed('GET', ['vouchers.stock.view'], '/export'), true);
  assert.equal(allowed('GET', [], '/export'), false);
  assert.equal(allowed('POST', ['vouchers.stock.view'], '/export'), false);
  assert.equal(allowed('GET', ['vouchers.stock.view'], '/export/extra'), false);
});

test('downloads ignore the display page and batch costs for all matching grouped items', async () => {
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'], page: '2' }, admin, { allRows: true });
  assert.equal(report.rows.length, 51);
  assert.equal(report.rows[0].item_code, 'ITEM-001');
  assert.equal(report.rows[50].item_code, 'ITEM-051');
  assert.equal(report.rows[0].quantity, 15);
  const batches = calls.filter(call => call.url.pathname.endsWith('/Item'));
  assert.deepEqual(batches.map(call => JSON.parse(call.url.searchParams.get('filters'))[0][2].length), [50, 1]);
  calls = [];
  await assert.rejects(() => erpnextStockBalance({}, admin, { allRows: true }), { status: 400 });
  assert.equal(calls.length, 0);
  await assert.rejects(() => erpnextStockBalance({ warehouse: 'Denied' }, {
    role: 'standard', scopes: { warehouses: { mode: 'selected', values: [] } },
  }, { allRows: true }), { status: 403 });
});

test('Excel preserves all rows, numeric quantities and rates, safe item text, filters, and totals', async () => {
  const ExcelJS = require('exceljs');
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'] }, admin, { allRows: true });
  report.rows[0].item_code = '=SUM(1,2)';
  const buffer = await stockBalanceExcel(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Stock Balance');
  assert.deepEqual(sheet.getRow(4).values.slice(1), ['Item', 'Qty', 'Cost', 'Valuation rate', 'Stock value']);
  assert.equal(sheet.getCell('A5').value, '=SUM(1,2)');
  assert.equal(sheet.getCell('B5').value, 15);
  assert.equal(sheet.getCell('C5').value, 12.125);
  assert.equal(sheet.getCell('D5').value, 16);
  assert.equal(sheet.getCell('B6').value, -2);
  assert.equal(sheet.getCell('A55').value, 'ITEM-051');
  assert.equal(sheet.getCell('A56').value, 'Total');
  assert.equal(sheet.getCell('B56').value, report.summary.quantity);
  assert.equal(sheet.getCell('E56').value, report.summary.stock_value);
  assert.equal(sheet.getCell('C55').value, null);
  const filterValues = workbook.getWorksheet('Filters').getSheetValues().flat();
  assert.ok(filterValues.includes('Main & Shop'));
  assert.ok(filterValues.includes('Store'));
});

test('PDF handles all grouped rows, long item codes, negative balances, and empty results', async () => {
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'] }, admin, { allRows: true });
  report.rows[0].item_code = 'Very-long-item-code-'.repeat(7);
  for (const rows of [[], [...report.rows, ...report.rows, ...report.rows]]) {
    const buffer = await stockBalancePdf({ ...report, rows });
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    const pages = (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.ok(rows.length ? pages > 1 : pages === 1);
  }
});

test('download route returns attachments for all rows and rejects unsupported formats before reading ERPNext', async () => {
  const handler = require('../src/web/routes/stock').stack.find(layer => layer.route?.path === '/erpnext/export').route.stack[0].handle;
  const response = () => ({ headers: {}, set(name, value) { this.headers[name] = value; return this; },
    attachment(value) { this.filename = value; return this; }, type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; }, status(value) { this.statusCode = value; return this; } });
  for (const format of ['xlsx', 'pdf']) {
    const res = response();
    await handler({ query: { warehouse: ['Main & Shop', 'Store'], page: '2', format }, currentUser: admin }, res, err => { throw err; });
    assert.equal(res.filename, `erpnext-stock-balance.${format}`);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.ok(Buffer.isBuffer(res.body));
    assert.match(res.contentType, format === 'xlsx' ? /spreadsheetml/ : /application\/pdf/);
  }
  calls = [];
  const res = response();
  await handler({ query: { format: 'csv' }, currentUser: admin }, res, err => { throw err; });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('ERPNext screen renders requested columns, multiple selections, escaped codes, and complete page links', async () => {
  const report = await erpnextStockBalance({ warehouse: ['Main & Shop', 'Store'] }, admin);
  report.rows[0].item_code = '<ITEM>';
  report.rows[0].valuation_rate = -12.123456789;
  const shared = { assetVersion: 'test', currentUser: admin, can: () => true, availableReports: [], money: value => `Ugx ${value}` };
  const html = await renderView(path.join(__dirname, '..', 'views', 'erpnext-stock-balance.ejs'), { ...shared, report });
  for (const label of ['Item', 'Qty', 'Cost', 'Valuation rate', 'Stock value']) assert.match(html, new RegExp(`>${label}</th>`));
  assert.match(html, /type="checkbox" name="warehouse"/);
  assert.match(html, /value="Store" checked/);
  assert.match(html, /2 selected/);
  assert.match(html, /Stock balances grouped by item/);
  assert.match(html, /formaction="\/stock\/erpnext\/export"/);
  assert.match(html, /value="xlsx"/);
  assert.match(html, /value="pdf"/);
  assert.doesNotMatch(html, /value="csv"/);
  assert.match(html, /&lt;ITEM&gt;/);
  assert.match(html, /Ugx -12\.123457/);
  assert.match(html, /warehouse=Main\+%26\+Shop&amp;warehouse=Store/);
  const empty = await erpnextStockBalance({}, admin);
  const emptyHtml = await renderView(path.join(__dirname, '..', 'views', 'erpnext-stock-balance.ejs'), { ...shared, report: empty });
  assert.match(emptyHtml, /Choose one or more warehouses and generate/);
});
