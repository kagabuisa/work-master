'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { normalizeStockEntryItems, applyPostgresStockMovement, stockEntryGlLines } = require('../src/domain/posting');
const { scriptJson } = require('../src/web/script-json');
const { permissionCheck } = require('../src/authorize');
const { applyReconciliationRatePolicy } = require('../src/web/reconciliation-rates');

test('reconciliation voucher routes require stock permissions', () => {
  const allowed = (path, method, permissions, body = {}) => permissionCheck({ path, method, body,
    currentUser: { role: 'standard', permissions } });
  assert.equal(allowed('/stock/reconciliations/new', 'GET', ['vouchers.stock.create']), true);
  assert.equal(allowed('/stock/reconciliations/warehouse-stock', 'GET', ['vouchers.stock.create']), true);
  assert.equal(allowed('/stock/reconciliations', 'POST', ['vouchers.stock.create'], { action: 'submit' }), false);
  assert.equal(allowed('/stock/reconciliations', 'POST', ['vouchers.stock.create', 'vouchers.stock.submit'], { action: 'submit' }), true);
  assert.equal(allowed('/stock/reconciliations/1', 'GET', ['vouchers.stock.view']), true);
  assert.equal(allowed('/stock/reconciliations/1/submit', 'POST', ['vouchers.stock.view']), false);
  assert.equal(allowed('/stock/reconciliations/1/submit', 'POST', ['vouchers.stock.submit']), true);
  assert.equal(allowed('/stock/reconciliations/1/cancel', 'POST', ['vouchers.stock.edit']), false);
});

test('reconciliation accepts zero counts and rejects duplicate or invalid counts', () => {
  const line = { item_code: 'ITEM-1', warehouse: 'Main', quantity: '0', valuation_rate: '50' };
  assert.deepEqual(normalizeStockEntryItems([line], 'reconciliation').map((item) =>
    [item.quantity, item.counted_quantity]), [[0, 0]]);
  assert.equal(normalizeStockEntryItems([{ ...line, quantity: '1.001' }], 'reconciliation')[0].counted_quantity, 1.001);
  assert.throws(() => normalizeStockEntryItems([line, line], 'reconciliation'), /only once/);
  assert.throws(() => normalizeStockEntryItems([{ ...line, quantity: '-1' }], 'reconciliation'), /valid counted quantity/);
  assert.throws(() => normalizeStockEntryItems([{ ...line, quantity: '1.0001' }], 'reconciliation'), /valid counted quantity/);
  assert.deepEqual(stockEntryGlLines('reconciliation', -100), [
    { account_key: 'stock_adjustment_loss', debit: 100 },
    { account_key: 'inventory', credit: 100 },
  ]);
});

test('only admins can change reconciliation valuation rates', () => {
  const submitted = [{ item_code: 'IN-STOCK', valuation_rate: 999 },
    { item_code: 'SAVED', valuation_rate: 999 }, { item_code: 'EXTRA', valuation_rate: 999 }];
  const balances = [{ item_code: 'IN-STOCK', valuation_rate: 25 }];
  const existing = [{ item_code: 'SAVED', valuation_rate: 40 }];
  assert.deepEqual(applyReconciliationRatePolicy(submitted, { role: 'staff' }, balances, existing)
    .map((item) => item.valuation_rate), [25, 40, 0]);
  assert.equal(applyReconciliationRatePolicy(submitted, { role: 'admin' }, balances, existing), submitted);
});

test('reconciliation posts differences from the locked balance and skips matching counts', async () => {
  const ledger = [];
  const balance = { quantity: 5, stock_value: 50, valuation_rate: 10 };
  const client = { async query(sql, params) {
    if (sql.includes('INSERT INTO app_stock_balances')) {
      assert.match(sql, /ON CONFLICT[\s\S]*DO UPDATE[\s\S]*RETURNING \*/);
      return { rows: [balance] };
    }
    if (sql.includes('UPDATE app_stock_balances')) {
      balance.quantity = params[1]; balance.stock_value = params[2]; balance.valuation_rate = params[3];
      return { rows: [] };
    }
    if (sql.includes('WITH history AS')) return { rows: [{ quantity: balance.quantity, minimum_future_quantity: null }] };
    if (sql.includes('INSERT INTO app_stock_ledger')) { ledger.push(params); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const movement = (count) => ({ posting_date: '2026-10-04', item_code: 'ITEM-1',
    item_name: 'Item', warehouse: 'Main', voucher_type: 'stock_reconciliation',
    voucher_id: 1, target_quantity: count });
  assert.equal((await applyPostgresStockMovement(client, movement(2))).qty_change, -3);
  assert.equal(balance.quantity, 2);
  assert.equal((await applyPostgresStockMovement(client, movement(2))).qty_change, 0);
  assert.equal((await applyPostgresStockMovement(client, movement(4))).qty_change, 2);
  assert.equal(balance.quantity, 4);
  assert.deepEqual(ledger.map((params) => params[7]), [-3, 2]);
  balance.stock_value = 0;
  balance.valuation_rate = 0;
  assert.equal(Math.abs((await applyPostgresStockMovement(client, movement(3))).stock_value_change), 0);
  assert.deepEqual(ledger.map((params) => params[7]), [-3, 2, -1]);
});

test('dedicated stock reconciliation voucher shows counts, differences and save actions', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'stock-reconciliation.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:00', scriptJson,
    today: '2026-10-04', postingTime: '12:00', error: null, entry: null, items: [], warehouse: '',
  });
  assert.doesNotMatch(html, /<h1>New stock reconciliation<\/h1>/);
  assert.doesNotMatch(html, /Count the items in one warehouse/);
  assert.match(html, /Counted Qty/);
  assert.match(html, /Book Qty/);
  assert.match(html, /Net value difference/);
  assert.match(html, /name="cost_center"/);
  assert.match(html, /id="reconciliation-gain-value"/);
  assert.match(html, /id="reconciliation-loss-value"/);
  assert.match(html, /Add an item not stocked in this warehouse/);
  assert.match(html, /value="save_draft" data-voucher-save/);
});

test('saved draft reconciliation supplies current book balances to the count sheet', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'stock-reconciliation.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:00', scriptJson,
    today: '2026-10-04', postingTime: '12:00', error: null,
    entry: { id: 12, entry_no: 'REC-000012', docstatus: 'draft', posting_date: '2026-10-04', cost_center: 'Operations' },
    items: [{ id: 1, item_code: 'ITEM-1', item_name: 'Item', warehouse: 'Main', quantity: 7 }],
    balances: [{ item_code: 'ITEM-1', quantity: 5, valuation_rate: 10 }],
    warehouse: 'Main', readOnly: true,
  });
  assert.match(html, /"balances":\[\{"item_code":"ITEM-1","quantity":5,"valuation_rate":10\}\]/);
  assert.doesNotMatch(html, /<h1>Stock Reconciliation<\/h1>/);
  assert.doesNotMatch(html, /<h1>REC-000012<\/h1>/);
  assert.match(html, /action="\/stock\/reconciliations\/12\/submit"/);
  assert.match(html, /Submit reconciliation/);
  assert.doesNotMatch(html, /name="cost_center"/);
  assert.doesNotMatch(html, /class="invoice-card reconciliation-details"/);
  assert.match(html, /Cost Center: <strong>Operations<\/strong>/);
});

test('stock entry duplication requires Read and Create and only accepts GET', () => {
  for (const permissions of [[], ['vouchers.stock.view'], ['vouchers.stock.create'],
    ['vouchers.stock.view', 'vouchers.stock.create']]) {
    for (const method of ['GET', 'POST']) {
      assert.equal(permissionCheck({ path: '/stock/entries/12/duplicate', method, body: {},
        currentUser: { role: 'standard', permissions } }), method === 'GET' && permissions.length === 2);
    }
  }
});

test('duplicating stock entries opens a new unsaved draft without source identities or audit data', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.join(__dirname, '../src/web/routes/stock.js');
  const realRequire = createRequire(filename);
  let source = { entry: { id: 12, entry_no: 'STK-000012', entry_type: 'transfer',
    docstatus: 'submitted', posting_date: '2020-01-01', posting_time: '01:00',
    cost_center: 'CC', remarks: 'Copy me', supplier_reference: 'OLD-REF', created_by: 'Original' },
    items: [{ id: 99, stock_entry_id: 12, item_code: 'ITEM-1', item_name: 'Item',
      warehouse: 'Main', target_warehouse: 'Shop', quantity: 2, valuation_rate: 500, created_by: 'Original' }] };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === '../../store' ? { ...realRequire(name), loadStockEntry: async () => source }
      : name === '../../posting-time' ? { currentPostingDate: () => '2026-10-16', currentPostingTime: () => '12:34' }
      : realRequire(name), Buffer, console }, { filename });
  const route = module.exports.stack.find(layer => layer.route?.path === '/entries/:id/duplicate').route.stack[0].handle;
  let data; let caught;
  await route({ params: { id: '12' } }, { set() {}, render(view, locals) { assert.equal(view, 'stock-entry'); data = locals; } }, error => { caught = error; });
  assert.equal(caught, undefined);
  assert.equal(data.entry.id, undefined);
  assert.equal(data.entry.created_by, undefined);
  assert.equal(data.entry.docstatus, 'draft');
  assert.equal(data.entry.posting_date, '2026-10-16');
  assert.equal(data.entry.posting_time, '12:34');
  assert.equal(data.entry.supplier_reference, '');
  assert.equal(data.items[0].id, undefined);
  assert.equal(data.items[0].created_by, undefined);
  assert.equal(data.items[0].target_warehouse, 'Shop');
  assert.equal(data.items[0].quantity, 2);
  assert.equal(source.entry.id, 12);
  const html = await renderView(path.join(__dirname, '../views/stock-entry.ejs'), {
    ...data, assetVersion: 'test', currentUser: { role: 'admin' }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:34', scriptJson,
  });
  assert.match(html, /action="\/stock\/entries"/);
  assert.doesNotMatch(html, /action="\/stock\/entries\/12"/);
  assert.match(html, /Copy of <strong>STK-000012<\/strong>/);
  assert.match(html, /New Stock Entry/);
  for (const entry_type of ['cancel', 'reconciliation']) {
    source = { ...source, entry: { ...source.entry, entry_type } };
    caught = null;
    await route({ params: { id: '12' } }, { set() {}, render() { assert.fail('Unsupported copy'); } }, error => { caught = error; });
    assert.equal(caught.status, 400);
  }
});

test('saved stock submission requires Submit and a POST request', () => {
  for (const permissions of [[], ['vouchers.stock.view'], ['vouchers.stock.edit'], ['vouchers.stock.submit']]) {
    for (const method of ['GET', 'POST']) {
      assert.equal(permissionCheck({ path: '/stock/entries/12/submit', method, body: {},
        currentUser: { role: 'standard', permissions } }), method === 'POST' && permissions.includes('vouchers.stock.submit'));
    }
  }
});

test('stock preview and drawer expose Submit only for permitted drafts', async () => {
  for (const file of ['stock-entry', 'stock-entry-drawer']) {
    for (const docstatus of ['draft', 'submitted', 'cancelled']) {
      for (const submit of [false, true]) {
        const html = await renderView(path.join(__dirname, `../views/${file}.ejs`), {
          assetVersion: 'test', currentUser: { role: 'standard' }, can: key => submit && key === 'vouchers.stock.submit',
          availableReports: [], money: String, readOnly: true, error: null, items: [],
          entry: { id: 12, entry_no: 'STK-000012', entry_type: 'transfer', docstatus, posting_date: '2026-10-16' },
        });
        assert.equal(html.includes('action="/stock/entries/12/submit"'), docstatus === 'draft' && submit);
      }
    }
  }
});

test('preview submission posts saved stock values and rejects invalid statuses without editing', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.join(__dirname, '../src/web/routes/stock.js');
  const realRequire = createRequire(filename); const module = { exports: {} };
  let source = { entry: { id: 12, entry_type: 'transfer', docstatus: 'draft', posting_date: '2026-10-16',
    posting_time: '09:30', cost_center: 'CC', remarks: 'Saved remarks' },
    items: [{ id: 20, item_code: 'ITEM-1', warehouse: 'Main', target_warehouse: 'Shop', quantity: 2, valuation_rate: 500 }] };
  const calls = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === '../../store' ? { ...realRequire(name), loadStockEntry: async () => source,
      updateStockEntry: async (id, payload) => { calls.push({ id, payload: JSON.parse(JSON.stringify(payload)) }); return id; } } : realRequire(name),
    Buffer, console }, { filename });
  const route = module.exports.stack.find(layer => layer.route?.path === '/entries/:id/submit').route.stack[0].handle;
  let redirect; let failure;
  const req = { params: { id: '12' }, currentUser: { role: 'standard', permissions: ['vouchers.stock.submit'] },
    body: { quantity: 999, entry_type: 'adjustment', action: 'save_draft', remarks: 'Forged' } };
  const res = { redirect: (status, url) => { redirect = { status, url }; } };
  await route(req, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.deepEqual(redirect, { status: 303, url: '/stock/entries' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.action, 'submit');
  assert.equal(calls[0].payload.entry_type, 'transfer');
  assert.equal(calls[0].payload.remarks, 'Saved remarks');
  assert.equal(calls[0].payload.posting_time, '09:30');
  assert.equal(calls[0].payload.items[0].quantity, 2);
  assert.equal(calls[0].payload.items[0].target_warehouse, 'Shop');
  for (const docstatus of ['submitted', 'cancelled']) {
    source = { ...source, entry: { ...source.entry, docstatus } };
    await route(req, res, error => { throw error; });
    assert.match(redirect.url, /^\/stock\/entries\/12\?error=/);
    assert.equal(calls.length, 1);
  }
  source = { ...source, entry: { ...source.entry, docstatus: 'draft', entry_type: 'cancel' } };
  await route(req, res, error => { failure = error; });
  assert.equal(failure.status, 403);
  assert.equal(calls.length, 1);
});

test('stock entry choices include the four named transfers and preserve legacy types only on existing forms', async () => {
  const { STOCK_ENTRY_CHOICES, STOCK_TRANSFER_TYPES, STOCK_ENTRY_TYPE_LABELS } = require('../src/constants');
  assert.deepEqual(STOCK_ENTRY_CHOICES, ['opening', 'transfer', 'order', 'taff_kla_order', 'ddr_shortage', 'ddr_excess']);
  const locals = { assetVersion: 'test', currentUser: { role: 'admin' }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:00', scriptJson, today: '2026-10-16', error: null,
    entry: null, items: [] };
  const html = await renderView(path.join(__dirname, '../views/stock-entry.ejs'), locals);
  const options = html.match(/<select name="entry_type"[\s\S]*?<\/select>/)[0];
  for (const type of STOCK_ENTRY_CHOICES) assert.match(options, new RegExp(`value="${type}"`));
  for (const type of ['purchase', 'adjustment', 'cancel']) assert.ok(!options.includes(`value="${type}"`));
  for (const type of STOCK_TRANSFER_TYPES) {
    const item = { item_code: 'ITEM', warehouse: 'Source', target_warehouse: 'Target', quantity: 2, valuation_rate: 999 };
    assert.equal(normalizeStockEntryItems([item], type)[0].target_warehouse, 'Target');
    assert.throws(() => normalizeStockEntryItems([{ ...item, target_warehouse: '' }], type), /target warehouse/);
    assert.throws(() => normalizeStockEntryItems([{ ...item, target_warehouse: 'Source' }], type), /different/);
    assert.deepEqual(stockEntryGlLines(type, 100), []);
    const drawer = await renderView(path.join(__dirname, '../views/stock-entry-drawer.ejs'), {
      ...locals, money: String, entry: { id: 12, entry_no: 'STK-12', entry_type: type, docstatus: 'draft', posting_date: '2026-10-16' },
    });
    assert.ok(drawer.includes(STOCK_ENTRY_TYPE_LABELS[type]));
    assert.ok(drawer.includes('/stock/entries/12/duplicate'));
  }
  const legacy = await renderView(path.join(__dirname, '../views/stock-entry.ejs'), {
    ...locals, entry: { id: 12, entry_no: 'STK-12', entry_type: 'purchase', docstatus: 'draft', posting_date: '2026-10-16' },
  });
  assert.match(legacy, /value="purchase" selected/);
});

test('transfer balance lookup returns posting-time quantity and protected availability without changing ordinary lookups', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.join(__dirname, '../src/web/routes/api.js'); const realRequire = createRequire(filename);
  const module = { exports: {} }; const calls = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, console,
    require: name => name === '../../stock-transfer-availability' ? {
      transferStockAvailability: async (...args) => { calls.push(args.slice(1)); return { quantity: 5, available_quantity: 2 }; },
    } : name === '../../store' ? { ...realRequire(name), getPostgresPool: () => ({}),
      localStockQuantity: async () => ({ quantity: 30, valuation_rate: 50, stock_value: 1500 }) } : realRequire(name),
  }, { filename });
  const route = module.exports.stack.find(layer => layer.route?.path === '/stock-balance').route.stack[0].handle;
  let result; let status;
  const res = { set() { return this; }, json(value) { result = value; }, status(code) { status = code; return this; } };
  const req = { currentUser: { role: 'admin' }, query: { item_code: 'ITEM', warehouse: 'Source' } };
  await route(req, res, error => { throw error; }); assert.equal(result.quantity, 30); assert.equal(calls.length, 0);
  req.query.posting_date = '2026-02-01'; req.query.posting_time = '10:00';
  await route(req, res, error => { throw error; });
  assert.equal(result.quantity, 5); assert.equal(result.available_quantity, 2);
  assert.equal(result.valuation_rate, 50); assert.deepEqual(calls[0], ['ITEM','Source','2026-02-01','10:00']);
  req.query.posting_date = 'bad'; await route(req, res, error => { throw error; }); assert.equal(status, 400);
});

test('all stock entry types show posting-time balances and discard stale item lookups', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/stock-entry.js'), 'utf8');
  const fields = { item_code: { value: 'A' }, warehouse: { value: 'Main' }, valuation_rate: { value: '50' } };
  const posting = { posting_date: { value: '2026-02-01' }, posting_time: { value: '10:00' } };
  const balance = { textContent: '', hidden: false };
  const requests = [];
  const row = { isConnected: true, querySelector(selector) {
    return selector.startsWith('[data-balance-field') ? balance : fields[selector.match(/name="([^"]+)"/)[1]];
  } };
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, balanceRequests: new WeakMap(),
    stockEntryForm: { querySelector: selector => posting[selector.match(/name="([^"]+)"/)[1]] },
    stockTransferTypes: new Set(['transfer']), entryType: { value: 'opening' },
    formatQuantity: String, formatRate: String,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })), row,
  });
  vm.runInContext(source.slice(source.indexOf('async function updateBalanceField('), source.indexOf('\nfunction formatRate')), context);
  const old = vm.runInContext("updateBalanceField(row, 'warehouse', 'warehouse_balance', 'A')", context);
  assert.match(requests[0].url, /posting_date=2026-02-01&posting_time=10%3A00/);
  fields.item_code.value = 'B';
  const fresh = vm.runInContext("updateBalanceField(row, 'warehouse', 'warehouse_balance', 'B')", context);
  requests[1].resolve({ ok: true, json: async () => ({ quantity: 8, available_quantity: 5 }) }); await fresh;
  assert.equal(balance.textContent, 'As of: 8; available: 5');
  requests[0].resolve({ ok: true, json: async () => ({ quantity: 99 }) }); await old;
  assert.equal(balance.textContent, 'As of: 8; available: 5');
  assert.equal(requests[0].options.signal.aborted, true);
});

test('reconciliation sub-tabs preserve independent workflow permissions', async () => {
  const allowed = (url, method, permissions) => permissionCheck({path:url,method,body:{},currentUser:{role:'standard',permissions}});
  assert.equal(allowed('/stock/reconciliations/counts/5','GET',['inventory.count.view']),true);
  assert.equal(allowed('/stock/reconciliations/counts/5/approve','POST',['inventory.count.view']),false);
  assert.equal(allowed('/stock/reconciliations/counts/5/approve','POST',['inventory.count.approve']),true);
  assert.equal(allowed('/stock/reconciliations/counts/5/attachments','POST',['vouchers.stock.edit']),false);
  assert.equal(allowed('/stock/reconciliations/corrections/5/submit','POST',['inventory.correction.submit']),true);
  assert.equal(allowed('/stock/reconciliations/corrections','GET',['inventory.count.view']),false);
  const ejs=require('ejs');
  const html=await ejs.renderFile(path.join(__dirname,'../views/stock-reconciliation-tabs.ejs'),{
    activeReconciliationTab:'counts',can:key=>key==='inventory.count.view'
  });
  assert.match(html,/href="\/stock\/reconciliations\/counts" class="active" aria-current="page"/);
  assert.doesNotMatch(html,/href="\/stock\/reconciliations\/corrections"/);
});

test('controlled REC voucher renders its workflow inside reconciliation sub-tabs', async () => {
  const html=await renderView(path.join(__dirname,'../views/inventory-count.ejs'),{
    assetVersion:'test',currentUser:{id:1,role:'admin',scopes:{}},can:()=>true,availableReports:[],
    error:null,stamp:()=> '17/10/2026 10:00',
    count:{id:5,reconciliation_id:12,entry_no:'REC-000012',state:'counting',warehouse:'Main',revision:1,preparer:'Counter',readiness:'Movements stopped'},
    lines:[],audit:[]
  });
  assert.match(html,/<title>REC-000012<\/title>/);
  assert.match(html,/aria-label="Stock Reconciliation"/);
  assert.match(html,/action="\/stock\/reconciliations\/counts\/5\/save"/);
  assert.match(html,/href="\/stock\/reconciliations\/counts\/5\/sheet"/);
  assert.match(html,/data-voucher-form data-prevent-enter-submit/);
  assert.match(html,/data-voucher-save/);
  assert.match(html,/id="found-item-form"/);
  assert.match(html,/id="add-found-item"/);
  assert.ok(html.indexOf('id="found-item-form"') > html.indexOf('Save count revision'));
  assert.ok(html.indexOf('aria-label="Count sheets and supporting documents"') > html.indexOf('id="count-item-rows"'));
  assert.match(html,/ui-voucher-attributes ui-attributes-compact/);
  assert.match(html,/list="found-item-options"/);
  assert.match(html,/data-item-lookup="\/stock\/reconciliations\/counts\/5\/items"/);
  assert.doesNotMatch(html,/action="\/stock\/counts\//);
});

test('count item lookup is read only and requires count view', () => {
  const check=(method,permissions)=>permissionCheck({method,path:'/stock/reconciliations/counts/5/items',body:{},currentUser:{role:'standard',permissions}});
  assert.equal(check('GET',['inventory.count.view']),true);
  assert.equal(check('GET',['vouchers.stock.view']),false);
  assert.equal(check('POST',['inventory.count.save']),false);
  assert.equal(permissionCheck({method:'POST',path:'/stock/reconciliations/counts/5/found-item',body:{},currentUser:{role:'standard',permissions:['inventory.count.save']}}),true);
});

test('Excel count upload stays enabled throughout unfinished counts', async () => {
  for(const state of ['counting','awaiting_review','approved','submitted','abandoned']) {
    const html=await renderView(path.join(__dirname,'../views/inventory-count.ejs'),{
      assetVersion:'test',currentUser:{id:1,role:'admin',scopes:{}},can:()=>true,availableReports:[],error:null,stamp:()=> '17/10/2026 10:00',
      count:{id:5,reconciliation_id:12,entry_no:'REC-000012',state,warehouse:'Main',revision:1,preparer:'Counter',readiness:'Movements stopped'},lines:[],audit:[]
    });
    const form=html.match(/<form id="count-sheet-import"[\s\S]*?<\/form>/)[0];
    assert.match(form,/name="count_sheet"/);
    assert.match(form,/Import counts into table/);
    assert.equal(/<button[^>]*disabled/.test(form),['submitted','abandoned'].includes(state));
    if(['awaiting_review','approved'].includes(state))assert.match(form,/clears any approval/);
  }
});

test('admin can edit and approve their own reviewed reconciliation while other preparers cannot', async () => {
  for(const role of ['admin','standard']){
    const html=await renderView(path.join(__dirname,'../views/inventory-count.ejs'),{
      assetVersion:'test',currentUser:{id:1,role,scopes:{}},can:()=>true,availableReports:[],error:null,stamp:()=> '17/10/2026 10:00',
      count:{id:5,reconciliation_id:12,entry_no:'REC-000012',state:'awaiting_review',warehouse:'Main',revision:1,preparer:'Counter',readiness:'Movements stopped'},
      lines:[],audit:[{actor_id:1,action:'start',username:'Counter',revision:1}]
    });
    assert.equal(/action="\/stock\/reconciliations\/counts\/5\/approve"/.test(html),role==='admin');
    assert.equal(/data-voucher-save/.test(html),role==='admin');
  }
});

test('count effects exclude blanks, count explicit zero and use posting valuation rounding',()=>{
 const effects=require('../public/count-effects');
 const result=effects.summarize([
  {book_qty:999,book_rate:20,counted_qty:null,valuation_rate:30},
  {book_qty:2,book_rate:21.5,counted_qty:0,valuation_rate:100},
  {book_qty:0,book_rate:0,counted_qty:1.125,valuation_rate:10.5}
 ]);
 assert.deepEqual(result,{total:3,counted:2,pending:1,valuationPending:0,qtyGained:1.125,qtyLost:2,qtyNet:-0.875,valueGained:12,valueLost:44,valueNet:-32});
});

test('count losses use book value proportions and clear all value at zero quantity', () => {
 const effects = require('../public/count-effects');
 const line = { book_qty: 3, book_value: 302, book_rate: 101, counted_qty: 0, valuation_rate: 101 };
 assert.equal(effects.lineEffect(line).value, -302);
 assert.equal(effects.lineEffect({ ...line, counted_qty: 2 }).value, -101);
 assert.equal(effects.lineEffect({ book_qty: 0, book_value: 0, book_rate: 0, counted_qty: 1.005, valuation_rate: 100 }).value, 101);
 assert.equal(effects.lineEffect({ book_qty: 0, book_value: 1, book_rate: 0, counted_qty: 0 }).value, -1);
 assert.equal(effects.lineEffect({ book_qty: 0, book_value: -1, book_rate: 0, counted_qty: 0 }).value, 1);
});

test('count effects mark incomplete rates and invalid quantities without inventing stock losses',()=>{
 const effects=require('../public/count-effects');
 const result=effects.summarize([
  {book_qty:10,book_rate:20,counted_qty:'',valuation_rate:20},
  {book_qty:10,book_rate:20,counted_qty:-1,valuation_rate:20},
  {book_qty:10,book_rate:20,counted_qty:14,valuation_rate:''},
  {book_qty:0,counted_qty:0}
 ]);
 assert.equal(result.pending,2);assert.equal(result.valuationPending,1);
 assert.equal(result.qtyGained,4);assert.equal(result.qtyLost,0);
 assert.equal(result.valueNet,0);assert.ok(Number.isFinite(result.valueNet));
 assert.equal(effects.summarize([{book_qty:0,counted_qty:0.1,valuation_rate:10},{book_qty:0,counted_qty:0.2,valuation_rate:10}]).qtyNet,0.3);
});

test('count effect dashboard renders above the table with formatted signed net values',async()=>{
 const html=await renderView(path.join(__dirname,'../views/inventory-count.ejs'),{
  assetVersion:'test',currentUser:{id:1,role:'admin',scopes:{}},can:()=>true,availableReports:[],error:null,stamp:()=> '17/10/2026 10:00',
  count:{id:5,reconciliation_id:12,entry_no:'REC-000012',state:'counting',warehouse:'Main',revision:1,preparer:'Counter',readiness:'Movements stopped'},
  lines:[{item_code:'A',book_qty:10,book_value:500,book_rate:50,counted_qty:8,valuation_rate:90,explanation:'Missing'}],audit:[]
 });
 assert.ok(html.indexOf('aria-label="Count effect statistics"')<html.indexOf('id="inventory-count-form"'));
 assert.match(html, /id="count-effect-dashboard"[\s\S]*?<\/section>\s*<form[^>]*id="inventory-count-form"/);
 assert.match(html,/data-count-effect="qtyNet">-2</);
 assert.match(html,/data-count-effect="valueNet">-100</);
 assert.match(html,/count-effects.js/);
});
