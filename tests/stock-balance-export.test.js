'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { permissionCheck } = require('../src/authorize');

test('stock balance download requires stock read and only accepts GET', () => {
  const allowed = (path, method, permissions) => permissionCheck({ path, method, body: {},
    currentUser: { role: 'standard', permissions } });
  assert.equal(allowed('/stock/export', 'GET', ['vouchers.stock.view']), true);
  assert.equal(allowed('/stock/export', 'GET', []), false);
  assert.equal(allowed('/stock/export', 'POST', ['vouchers.stock.view']), false);
  assert.equal(allowed('/stock/export/extra', 'GET', ['vouchers.stock.view']), false);
});

test('stock balance CSV exports every filtered page with safe text and numeric values', async () => {
  const store = require('../src/store');
  const original = store.stockBalances;
  const routePath = require.resolve('../src/web/routes/stock');
  const calls = [];
  store.stockBalances = async (options) => {
    calls.push(options);
    return Array.from({ length: options.page === 1 ? 200 : 1 }, () => ({
      item_code: '=SUM(1,2)', warehouse: 'Main "Store"', quantity: -2,
      valuation_rate: 12.5, stock_value: -25,
    }));
  };
  delete require.cache[routePath];
  try {
    const router = require(routePath);
    const handler = router.stack.find((layer) => layer.route?.path === '/export').route.stack[0].handle;
    const res = new EventEmitter();
    let output = '';
    res.set = (headers) => { res.headers = headers; };
    res.write = (chunk) => { output += chunk; return true; };
    res.end = () => { res.ended = true; };
    await handler({ query: { q: 'item', warehouse: 'Main', page: '8', page_size: '1' } }, res,
      (error) => { throw error; });
    assert.deepEqual(calls, [1, 2].map((page) => ({ search: 'item', warehouse: 'Main', page_size: 200, page })));
    assert.equal(output.split('\r\n').length, 203);
    assert.ok(output.startsWith('\uFEFF"Item Code","Warehouse","Quantity","Valuation Rate","Stock Value"\r\n'));
    assert.ok(output.includes('"\'=SUM(1,2)","Main ""Store""",-2,12.5,-25\r\n'));
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="stock-balance.csv"');
    assert.equal(res.ended, true);
  } finally {
    store.stockBalances = original;
    delete require.cache[routePath];
  }
});
