'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { permissionCheck } = require('../src/authorize');
const { invoiceStockBalances } = require('../src/invoice-stock-balances');

function routeHarness() {
  const filename = path.join(__dirname, '../src/web/routes/api.js');
  const realRequire = createRequire(filename), module = { exports: {} }, calls = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, console,
    require: name => name === '../../invoice-stock-balances' ? {
      invoiceStockBalances: async (_, pairs, ...posting) => {
        calls.push({ pairs, posting });
        return pairs.map(pair => ({ ...pair, quantity: 4.123, available_quantity: 3.125 }));
      },
    } : name === '../../store' ? { ...realRequire(name), getPostgresPool: () => ({}) } : realRequire(name),
  }, { filename });
  const handler = module.exports.stack.find(layer => layer.route?.path === '/invoice-stock-balances').route.stack[0].handle;
  return { calls, async request(body, user = { role: 'admin' }) {
    const result = { status: 200 };
    const res = { set(key, value) { result[key] = value; }, status(code) { result.status = code; return this; },
      json(value) { result.body = JSON.parse(JSON.stringify(value)); return this; } };
    await handler({ body, currentUser: user }, res, error => { throw error; });
    return result;
  } };
}
const pair = (item_code = 'A', warehouse = 'Main') => ({ item_code, warehouse });

test('batch lookup validates raw bounds and dates, deduplicates exact pairs and checks every warehouse before reading', async () => {
  const h = routeHarness();
  for (const body of [undefined, {}, { items: [] }, { items: Array(201).fill(pair()) },
    { items: [null] }, { items: [pair(123)] }, { items: [pair('  ')] }, { items: [pair('A', {})] },
    { items: [pair()], posting_date: '2026-02-30', posting_time: '10:00' },
    { items: [pair()], posting_date: '2026-02-01' },
    { items: [pair()], posting_date: '2026-02-01', posting_time: '25:00' },
    { items: [pair()], posting_time: '10:00' }]) assert.equal((await h.request(body)).status, 400);
  assert.equal(h.calls.length, 0);
  const user = { role: 'standard', scopes: { warehouses: { mode: 'selected', values: ['Main'] } } };
  assert.equal((await h.request({ items: [pair(), pair('B', 'Secret')] }, user)).status, 403);
  assert.equal(h.calls.length, 0);
  const response = await h.request({ items: [pair(' A '), pair(), pair('A', 'Other'), pair('B')],
    posting_date: '2026-02-01', posting_time: '10:00' });
  assert.equal(response.status, 200); assert.equal(response['Cache-Control'], 'no-store');
  assert.equal(response.body.length, 3); assert.equal(response.body[0].available_quantity, 3.125);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { pairs: [pair(), pair('A', 'Other'), pair('B')], posting: ['2026-02-01', '10:00'] });
  assert.equal((await h.request({ items: Array.from({ length: 200 }, (_, i) => pair(String(i))) })).body.length, 200);
});

test('batch endpoint preserves existing stock lookup permissions and restricts the method', () => {
  for (const permissions of [[], ['vouchers.sales.create'], ['vouchers.sales.edit'], ['masters.warehouses.view'],
    ['vouchers.purchases.create'], ['vouchers.purchase-orders.edit'], ['vouchers.stock.edit']]) {
    const currentUser = { role: 'standard', permissions };
    const allowed = (path, method) => permissionCheck({ currentUser, path, method, body: {} });
    assert.equal(allowed('/api/invoice-stock-balances', 'POST'), allowed('/api/stock-balance', 'GET'));
    assert.equal(allowed('/api/invoice-stock-balances', 'GET'), false);
    assert.equal(allowed('/api/invoice-stock-balances/extra', 'POST'), false);
  }
});

function browserHarness(lines, enabled = true) {
  const source = fs.readFileSync(path.join(__dirname, '../public/invoice.js'), 'utf8');
  const requests = [], cells = lines.map((_, i) => ({ dataset: { stockIndex: String(i) }, textContent: '' }));
  let renders = 0;
  const fields = { '#invoice-date': { value: '2026-02-01' }, '#invoice-posting-time': { value: '10:00' } };
  const context = vm.createContext({ items: lines, URLSearchParams, AbortController, setTimeout: () => 1, clearTimeout() {},
    form: { addEventListener() {} }, window: { inventoryControlState: { enabled }, addEventListener() {} },
    document: { querySelector: s => fields[s], addEventListener() {} },
    tbody: { querySelectorAll() { renders++; return cells; } }, warehouseSelect: { value: 'Main' }, formatQuantity: String,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  vm.runInContext(source.slice(source.indexOf('let stockRefreshTimer;'), source.indexOf('let itemTimer;')), context);
  return { requests, cells, context, fields, renders: () => renders,
    refresh: () => vm.runInContext('refreshInvoiceStock()', context),
    reply(index, transform = rows => rows) {
      const rows = JSON.parse(requests[index].options.body).items.map(p => ({ ...p, quantity: 10, available_quantity: 8 }));
      requests[index].resolve({ ok: true, json: async () => transform(rows) });
    } };
}

test('ten invoice lines use one request and one render; duplicate pairs share results without subtracting draft quantity', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ ...pair(String(i)), quantity: 500 }));
  lines.push({ ...lines[0] }, pair('0', 'Other'));
  const h = browserHarness(lines), pending = h.refresh();
  assert.equal(h.requests.length, 1);
  const body = JSON.parse(h.requests[0].options.body);
  assert.equal(body.items.length, 11); assert.equal(body.posting_date, undefined);
  h.reply(0, rows => rows.reverse()); await pending;
  assert.ok(h.cells.every(c => c.textContent === '10; available: 8'));
  assert.equal(h.renders(), 1); assert.equal(lines[0].live_stock, 10);
});

test('large invoices chunk at 200 and empty invoices make no request', async () => {
  const empty = browserHarness([]); await empty.refresh(); assert.equal(empty.requests.length, 0);
  const h = browserHarness(Array.from({ length: 201 }, (_, i) => pair(String(i)))), pending = h.refresh();
  assert.equal(JSON.parse(h.requests[0].options.body).items.length, 200);
  h.reply(0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].options.body).items.length, 1);
  assert.equal(h.renders(), 0); h.reply(1); await pending;
  assert.equal(h.renders(), 1); assert.ok(h.cells.every(c => c.textContent.startsWith('10;')));
});

test('missing, malformed and failed batch results display unavailable instead of zero', async () => {
  for (const transform of [() => [], () => ({}), rows => [{ ...rows[0], quantity: null }],
    rows => [{ ...rows[0], available_quantity: '8' }], rows => [rows[0], rows[0]],
    rows => [{ ...rows[0], warehouse: 'Wrong' }]]) {
    const h = browserHarness([pair()]), pending = h.refresh(); h.reply(0, transform); await pending;
    assert.match(h.cells[0].textContent, /Unavailable/);
  }
  const h = browserHarness([pair(), pair('B')]), pending = h.refresh();
  h.reply(0, rows => rows.slice(0, 1)); await pending;
  assert.equal(h.cells[0].textContent, '10; available: 8'); assert.match(h.cells[1].textContent, /Unavailable/);
});

test('changed item, warehouse, timestamp, control mode or removed lines cannot receive stale results', async () => {
  for (const change of [h => { h.context.items[0].item_code = 'B'; },
    h => { h.context.items[0].warehouse = 'Other'; }, h => { h.context.warehouseSelect.value = 'Other'; },
    h => { h.fields['#invoice-posting-time'].value = '11:00'; },
    h => { h.context.window.inventoryControlState.enabled = true; }, h => { h.context.items.length = 0; }]) {
    const h = browserHarness([pair()], false), pending = h.refresh();
    change(h); h.reply(0); await pending; assert.equal(h.renders(), 0);
  }
  const h = browserHarness([pair()]), old = h.refresh();
  vm.runInContext('scheduleStockRefresh()', h.context);
  h.reply(0); await old; assert.equal(h.cells[0].textContent, 'Checking…');
});

test('removing a line cancels the old batch and schedules fresh stock for the remaining lines', async () => {
  const h = browserHarness([pair(), pair('B')]);
  const source = fs.readFileSync(path.join(__dirname, '../public/invoice.js'), 'utf8');
  const remove = { dataset: { remove: '0' }, addEventListener(_, handler) { this.click = handler; } };
  Object.assign(h.context, { InvoiceMath: require('../src/shared/invoice-math'), normalizeQuantity: Number, roundMoney: Number, escapeHtml: String,
    formatMoney: String, renderTotals() {} });
  h.context.tbody.querySelectorAll = selector => selector === '[data-remove]' ? [remove]
    : selector === 'input' ? [] : h.cells;
  vm.runInContext(source.slice(source.indexOf('function editableRate(value) {')), h.context);
  vm.runInContext(source.slice(source.indexOf('function renderItems() {'), source.indexOf('function addPaymentFromForm() {')), h.context);
  vm.runInContext('renderItems()', h.context);
  const old = h.refresh(); remove.click();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.context.items.length, 1); assert.equal(h.cells[0].textContent, 'Checking…');
  h.reply(0); await old;
  const fresh = h.refresh();
  assert.deepEqual(JSON.parse(h.requests[1].options.body).items, [pair('B')]);
  h.reply(1); await fresh; assert.equal(h.cells[0].textContent, '10; available: 8');
});

test('batch current and historical reads match scalar lookups, preserve future shortfalls and never write', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { seedGoldenData, FIXED } = require('./helpers/golden-seed');
  const { transferStockAvailability } = require('../src/stock-transfer-availability');
  try {
    const ids = await seedGoldenData(), pool = store.getPostgresPool();
    await pool.query(`UPDATE app_stock_entries SET posting_time='09:00'; UPDATE app_invoices SET posting_time='11:00'`);
    const purchase = (await pool.query(`INSERT INTO app_purchases(posting_date,posting_time,supplier_id,supplier_name)
      VALUES('2026-01-15','10:00','BATCH-S','Batch supplier') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,
      qty_change,qty_after_transaction,stock_value_after_transaction,is_reversal,created_at)
      VALUES ('2026-01-15','A','A','Main','stock_opening',$1,20,0,0,false,'2026-01-15 00:00+03'),
        ('2026-01-15','A','A','Main','invoice',$2,-15,0,0,false,'2026-01-15 00:00+03'),
        ('2026-01-16','A','A','Main','purchase',$3,100,0,0,false,'2026-01-16 00:00+03'),
        ('2026-01-15','B','B','Other','purchase',$3,2.125,0,0,false,'2026-01-15 00:00+03'),
        ('2026-01-15','B','B','Other','purchase',$3,-1.125,0,0,true,'2026-01-15 10:30:59+03'),
        ('2026-01-15','B','B','Other','unlinked',NULL,0.125,0,0,false,'2026-01-15 00:00+03')`,
    [ids.openingId, ids.invoiceId, purchase]);
    await pool.query(`INSERT INTO app_stock_balances(item_code,item_name,warehouse,quantity)
      VALUES('A','A','Main',105),('B','B','Other',1.125)`);
    const pairs = [pair(), pair('B', 'Other'), pair('A', 'Other'), pair('Missing'), pair(FIXED.itemCode, FIXED.warehouse)];
    const footprint = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(b ORDER BY item_code,warehouse) FROM app_stock_balances b) balances,
      (SELECT count(*) FROM app_stock_ledger) stock,(SELECT count(*) FROM app_gl_entries) gl,
      (SELECT count(*) FROM wm_inventory_events) events`)).rows[0];
    const before = await footprint(); let queries = 0;
    const client = { query(...args) { queries++; return pool.query(...args); } };
    const current = await invoiceStockBalances(client, [...pairs, pairs[0]]); assert.equal(queries, 1);
    assert.equal(current.length, pairs.length);
    for (const row of current) assert.equal(row.quantity, (await store.localStockQuantity(row.item_code, row.warehouse)).quantity);
    for (const [date, time] of [['2026-01-14', '23:59'], ['2026-01-15', '00:00'], ['2026-01-15', '09:00'],
      ['2026-01-15', '10:00'], ['2026-01-15', '10:30'], ['2026-01-15', '11:00'], ['2026-01-16', '23:59']]) {
      queries = 0;
      const rows = await invoiceStockBalances(client, [...pairs, pairs[0]], date, time); assert.equal(queries, 1);
      for (const row of rows) {
        const scalar = await transferStockAvailability(pool, row.item_code, row.warehouse, date, time);
        assert.deepEqual({ quantity: row.quantity, available_quantity: row.available_quantity }, scalar);
      }
      if (date === '2026-01-15' && time === '09:00') {
        const a = rows.find(r => r.item_code === 'A' && r.warehouse === 'Main');
        assert.equal(a.quantity, 20); assert.equal(a.available_quantity, 5);
      }
    }
    assert.deepEqual(await footprint(), before);
    // Exercise real server-timestamp movements on a clean, consistent fixture, too.
    await seedGoldenData();
    const controlledPool = store.getPostgresPool();
    await controlledPool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [FIXED.itemCode, FIXED.itemName]);
    await controlledPool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING', [FIXED.warehouse]);
    const auth = require('../src/auth'), actor = await auth.createUser('batch-admin', 'BatchPreview123!', { role: 'admin' });
    await controlledPool.query('SELECT wm_inventory_activate()');
    await require('../src/audit').runWithAuditUser(actor, () => store.createStockEntry({ entry_type: 'opening',
      posting_date: require('../src/posting-time').currentPostingDate(), posting_time: '00:00',
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 2, valuation_rate: 50 }] }));
    for (const time of ['00:00', '23:59']) {
      const date = require('../src/posting-time').currentPostingDate();
      const [row] = await invoiceStockBalances(controlledPool, [pairs[4]], date, time);
      assert.deepEqual({ quantity: row.quantity, available_quantity: row.available_quantity },
        await transferStockAvailability(controlledPool, row.item_code, row.warehouse, date, time));
    }
  } finally { await store.closeStore(); }
});
