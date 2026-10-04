'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
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

test('reconciliation posts the difference from the locked current balance, including unchanged counts', async () => {
  const ledger = [];
  const balance = { quantity: 5, stock_value: 50, valuation_rate: 10 };
  const client = { async query(sql, params) {
    if (sql.includes('INSERT INTO app_stock_balances')) return { rows: [] };
    if (sql.includes('FROM app_stock_balances') && sql.includes('FOR UPDATE')) return { rows: [balance] };
    if (sql.includes('UPDATE app_stock_balances')) {
      balance.quantity = params[1]; balance.stock_value = params[2]; balance.valuation_rate = params[3];
      return { rows: [] };
    }
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
  assert.deepEqual(ledger.map((params) => params[7]), [-3, 0, 2]);
});

test('dedicated stock reconciliation voucher shows counts, differences and save actions', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'stock-reconciliation.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:00', scriptJson,
    today: '2026-10-04', postingTime: '12:00', error: null, entry: null, items: [], warehouse: '',
  });
  assert.match(html, /Stock Reconciliation Voucher/);
  assert.match(html, /Counted Qty/);
  assert.match(html, /Book Qty/);
  assert.match(html, /Net value difference/);
  assert.match(html, /id="reconciliation-gain-value"/);
  assert.match(html, /id="reconciliation-loss-value"/);
  assert.match(html, /Add an item not stocked in this warehouse/);
  assert.match(html, /value="save_draft" data-voucher-save/);
});

test('saved draft reconciliation supplies current book balances to the count sheet', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'stock-reconciliation.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], currentPostingTime: () => '12:00', scriptJson,
    today: '2026-10-04', postingTime: '12:00', error: null,
    entry: { id: 12, entry_no: 'REC-000012', docstatus: 'draft', posting_date: '2026-10-04' },
    items: [{ id: 1, item_code: 'ITEM-1', item_name: 'Item', warehouse: 'Main', quantity: 7 }],
    balances: [{ item_code: 'ITEM-1', quantity: 5, valuation_rate: 10 }],
    warehouse: 'Main', readOnly: true,
  });
  assert.match(html, /"balances":\[\{"item_code":"ITEM-1","quantity":5,"valuation_rate":10\}\]/);
  assert.match(html, /<h1>Stock Reconciliation Voucher<\/h1>/);
  assert.doesNotMatch(html, /<h1>REC-000012<\/h1>/);
  assert.match(html, /action="\/stock\/reconciliations\/12\/submit"/);
  assert.match(html, /Submit reconciliation/);
});
