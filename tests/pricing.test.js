const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/pricing');
const { mapPriceList } = require('../src/price-list-importer');
const { mapItemPrice } = require('../src/item-price-importer');
const { permissionCheck } = require('../src/authorize');
const { PERMISSIONS, ROLE_RECORD_TYPES, nextInvoicePriceListScope, normalizePermissions } = require('../src/auth');
const { allowedInvoicePriceLists, requireInvoicePriceList, priceListActionAllowed } = require('../src/access');

const priceList = { price_list: 'Retail', currency: 'ugx', price_type: 'selling', pricelist_type: 'Retail' };
const itemPrice = { item_code: 'ITEM-1', price_list: 'Retail', price_list_rate: '35000.25' };

test('pricing validates names, currency, type and non-negative decimal rates', () => {
  assert.equal(pricing.normalizePricingRecord('price-lists', priceList).currency, 'UGX');
  for (const invalid of [{ price_list: '' }, { currency: 'Uganda' }, { price_type: 'unknown' }, { pricelist_type: '' }, { pricelist_type: 'Buying Import' }]) {
    assert.throws(() => pricing.normalizePricingRecord('price-lists', { ...priceList, ...invalid }), { status: 400 });
  }
  for (const pricelist_type of ['Retail', 'Wholesale', 'Distribution']) {
    assert.equal(pricing.normalizePricingRecord('price-lists', { ...priceList, pricelist_type }).pricelist_type, pricelist_type);
  }
  for (const rate of ['', '-1', 'NaN', 'Infinity', '1.2345678', '1000000000000', '1e4']) {
    assert.throws(() => pricing.normalizePricingRecord('item-prices', { ...itemPrice, price_list_rate: rate }), { status: 400 });
  }
  assert.equal(pricing.normalizePricingRecord('item-prices', { ...itemPrice, price_list_rate: '0' }).price_list_rate, '0');
  assert.equal(pricing.normalizePricingRecord('item-prices', { ...itemPrice, price_list_rate: '1.234567' }).price_list_rate, '1.234567');
});

test('ERPNext item price fields and precise rates map into the local record', () => {
  const mapped = mapItemPrice({
    name: 'PRICE-001', item_code: 'ITEM-1', price_list: 'Retail', price_list_rate: '12.123456',
    item_name: 'Cement', item_description: 'Bag of cement', currency: 'UGX', buying: 0, selling: 1,
    type: 0, warehouse_type: 'Retail',
    cost: '9.500000', promo_rate: '10.250000', promo_start_date: '2026-01-01',
    price_update_on: '2026-01-02', creation: '2026-01-01 10:00:00', modified: '2026-01-02 10:00:00',
  }, true);
  assert.equal(mapped.price_list_rate, '12.123456');
  assert.equal(mapped.cost, '9.500000');
  assert.equal(mapped.promo_rate, '10.250000');
  assert.equal(mapped.promo_start_date, '2026-01-01');
  assert.equal(mapped.active, 1);
  assert.equal(mapped.erpnext_name, 'PRICE-001');
  assert.equal(mapped.erpnext_type, 0);
  assert.equal(mapped.warehouse_type, 'Retail');
});

test('ERPNext pricelist types outside the app choices remain unclassified', () => {
  const source = { name: 'Retail', currency: 'UGX', buying: 0, selling: 1, enabled: 1 };
  assert.equal(mapPriceList({ ...source, pricelist_type: 'Wholesale' }).pricelistType, 'Wholesale');
  assert.equal(mapPriceList({ ...source, pricelist_type: 'Buying Import' }).pricelistType, null);
  assert.equal(mapPriceList({ ...source, pricelist_type: null }).pricelistType, null);
  assert.equal(mapPriceList(source).active, 1);
  assert.equal(mapPriceList({ ...source, enabled: 0 }).active, 0);
});

test('master list actions follow role permissions', () => {
  for (const kind of ['price-lists', 'item-prices', 'items', 'customers', 'suppliers', 'warehouses', 'employees', 'options']) {
    assert.deepEqual(ROLE_RECORD_TYPES.find((row) => row.key === `masters.${kind}`).actions,
      ['view', 'create', 'edit', 'submit', 'cancel', 'delete']);
    assert(ROLE_RECORD_TYPES.some((row) => row.key === `masters.${kind}`));
    for (const action of ['view', 'create', 'edit', 'submit', 'cancel', 'delete']) {
      assert(PERMISSIONS.some((row) => row.key === `masters.${kind}.${action}`));
    }
    const currentUser = { role: 'standard', permissions: [`masters.${kind}.view`] };
    assert(permissionCheck({ currentUser, path: `/settings/${kind}`, method: 'GET' }));
    assert(!permissionCheck({ currentUser, path: `/settings/${kind}`, method: 'POST', body: {} }));
    assert(!permissionCheck({ currentUser, path: `/settings/${kind}/1/cancel`, method: 'POST', body: {} }));
    const editor = { role: 'standard', permissions: [`masters.${kind}.view`, `masters.${kind}.create`,
      `masters.${kind}.edit`, `masters.${kind}.submit`, `masters.${kind}.cancel`, `masters.${kind}.delete`] };
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}`, method: 'POST', body: {} }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/new`, method: 'GET', body: {} }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/1/edit`, method: 'GET', body: {} }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/1`, method: 'POST', body: {} }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/1/active`, method: 'POST', body: { active: '1' } }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/1/active`, method: 'POST', body: { active: '0' } }));
    assert(permissionCheck({ currentUser: editor, path: `/settings/${kind}/1/delete`, method: 'POST', body: {} }));
  }
  const editor = { role: 'standard', permissions: ['masters.item-prices.view'] };
  for (const name of ['price-lists', 'pricing-items']) {
    assert(permissionCheck({ currentUser: editor, path: `/api/${name}`, method: 'GET' }));
    assert(!permissionCheck({ currentUser: { role: 'standard', permissions: [] }, path: `/api/${name}`, method: 'GET' }));
  }
  assert(permissionCheck({ currentUser: editor, path: '/api/item-price-codes', method: 'GET' }));
  assert(!permissionCheck({ currentUser: editor, path: '/api/item-price-codes', method: 'POST' }));
  assert(!permissionCheck({ currentUser: { role: 'standard', permissions: [] }, path: '/api/item-price-codes', method: 'GET' }));
  assert(!permissionCheck({ currentUser: { role: 'standard', permissions: ['masters.price-lists.edit'] }, path: '/settings/price-lists/Retail/active', method: 'POST', body: { active: '1' } }));
  assert(!permissionCheck({ currentUser: { role: 'standard', permissions: ['masters.price-lists.view'] }, path: '/settings/price-lists/Retail/active', method: 'POST', body: { active: '0' } }));
  assert(permissionCheck({ currentUser: { role: 'standard', permissions: ['masters.price-lists.delete'] }, path: '/settings/price-lists/Retail/delete', method: 'POST', body: {} }));
  assert(!permissionCheck({ currentUser: { role: 'standard', permissions: ['masters.price-lists.edit'] }, path: '/settings/price-lists/Retail/delete', method: 'POST', body: {} }));
  for (const action of ['submit', 'cancel']) {
    assert(!permissionCheck({ currentUser: { role: 'admin' }, path: `/settings/price-lists/Retail/${action}`, method: 'POST', body: {} }));
  }
  assert(permissionCheck({ currentUser: { role: 'admin' }, path: '/settings/price-lists/Retail/active', method: 'POST', body: { active: '1' } }));
  assert(permissionCheck({ currentUser: { role: 'admin' }, path: '/settings/price-lists', method: 'POST', body: {} }));
  assert(!permissionCheck({ currentUser: { role: 'standard', permissions: ['masters.price-lists.view'] }, path: '/settings/price-lists/new', method: 'GET', body: {} }));
});

test('invoice price list scope allows only selected lists and exempts admin', () => {
  const user = { role: 'standard', scopes: { invoicePriceLists: { mode: 'selected', values: ['Retail'] } } };
  assert.deepEqual(allowedInvoicePriceLists(user), ['Retail']);
  assert.doesNotThrow(() => requireInvoicePriceList(user, 'Retail'));
  assert.throws(() => requireInvoicePriceList(user, 'Wholesale'), { status: 403 });
  assert.throws(() => requireInvoicePriceList({ role: 'standard', scopes: { invoicePriceLists: { mode: 'selected', values: [] } } }, 'Retail'), { status: 403 });
  assert.doesNotThrow(() => requireInvoicePriceList({ role: 'standard', scopes: {} }, 'Retail'));
  assert.doesNotThrow(() => requireInvoicePriceList({ ...user, role: 'admin' }, 'Wholesale'));
});

test('adding and removing price list permission rows updates the role selection', () => {
  const active = ['Retail', 'Wholesale'];
  assert.deepEqual(nextInvoicePriceListScope({ mode: 'all', values: [] }, active, 'Wholesale', false),
    { mode: 'selected', values: ['Retail'] });
  assert.deepEqual(nextInvoicePriceListScope({ mode: 'selected', values: ['Retail'] }, active, 'Wholesale', true),
    { mode: 'selected', values: ['Retail', 'Wholesale'] });
  assert.deepEqual(nextInvoicePriceListScope({ mode: 'selected', values: ['Retail'] }, active, 'Retail', false),
    { mode: 'selected', values: [] });
});

test('named price list actions grant only their own record and item prices', () => {
  assert.deepEqual(normalizePermissions(['invoice.price-list.edit:Retail']), ['invoice.price-list.edit:Retail']);
  assert.throws(() => normalizePermissions(['invoice.price-list.edit:']), { status: 400 });
  const user = { role: 'standard', scopes: { invoicePriceLists: { mode: 'selected', values: ['Retail'] } },
    permissions: ['invoice.price-list.edit:Retail', 'invoice.price-list.create:Retail',
      'invoice.price-list.submit:Retail', 'invoice.price-list.cancel:Retail', 'invoice.price-list.delete:Retail'] };
  assert(priceListActionAllowed(user, 'Retail', 'view'));
  for (const action of ['create', 'edit', 'submit', 'cancel', 'delete']) {
    assert(priceListActionAllowed(user, 'Retail', action));
    assert(!priceListActionAllowed(user, 'Wholesale', action));
  }
  assert(permissionCheck({ currentUser: user, path: '/settings/price-lists', method: 'GET', body: {} }));
  assert(permissionCheck({ currentUser: user, path: '/settings/price-lists/Retail/edit', method: 'GET', body: {} }));
  assert(!permissionCheck({ currentUser: user, path: '/settings/price-lists/Wholesale/edit', method: 'GET', body: {} }));
  assert(permissionCheck({ currentUser: user, path: '/settings/price-lists/Retail/active', method: 'POST', body: { active: '1' } }));
  assert(permissionCheck({ currentUser: user, path: '/settings/price-lists/Retail/active', method: 'POST', body: { active: '0' } }));
  assert(permissionCheck({ currentUser: user, path: '/settings/price-lists/Retail/delete', method: 'POST', body: {} }));
  assert(permissionCheck({ currentUser: user, path: '/settings/item-prices/new', method: 'GET', body: {} }));
  assert(permissionCheck({ currentUser: user, path: '/settings/item-prices', method: 'POST', body: { price_list: 'Retail' } }));
  assert(!permissionCheck({ currentUser: user, path: '/settings/item-prices', method: 'POST', body: { price_list: 'Wholesale' } }));
  const reader = { role: 'standard', permissions: [], scopes: { invoicePriceLists: { mode: 'selected', values: ['Retail'] } } };
  assert(permissionCheck({ currentUser: reader, path: '/settings/price-lists', method: 'GET', body: {} }));
  assert(!permissionCheck({ currentUser: reader, path: '/settings/price-lists/Retail/edit', method: 'GET', body: {} }));
});

test('invoice price list lookup filters before pagination', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await pricing.listPricingRecords(pool, 'price-lists', { priceType: 'selling', allowedPriceLists: ['Retail'] }, { limit: 25, offset: 0 });
  assert.match(calls[0].sql, /p\.price_list = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].params, [['Retail'], 25, 0]);
  calls.length = 0;
  await pricing.listPricingRecords(pool, 'item-prices', { allowedPriceLists: ['Retail'] }, { limit: 25, offset: 0 });
  assert.match(calls[0].sql, /p\.price_list = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].params, [['Retail'], 25, 0]);
});

test('pricing lifecycle, references, search, pagination, duplicates and audits in Postgres', {
  skip: process.env.PRICING_TEST_POSTGRES !== '1',
}, async () => {
  const { getPostgresPool } = require('../src/store');
  const { AuditPool, initRecordAudit, runWithAuditUser } = require('../src/audit');
  const base = getPostgresPool();
  const schema = `pricing_test_${process.pid}_${Date.now()}`;
  let pool;
  try {
    await base.query(`CREATE SCHEMA "${schema}"`);
    pool = new AuditPool({ ...base.options, password: base.options.password, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE app_master_items (item_code TEXT PRIMARY KEY, item_name TEXT, stock_uom TEXT, description TEXT,
      docstatus TEXT NOT NULL DEFAULT 'submitted', disabled BOOLEAN NOT NULL DEFAULT false)`);
    await pool.query("INSERT INTO app_master_items VALUES ('ITEM-1','Building Cement','Bag',null,'submitted',false), ('ITEM-2','Paint','Tin',null,'draft',false)");
    await pool.query(`CREATE TABLE app_master_price_lists (
      price_list TEXT PRIMARY KEY, currency TEXT NOT NULL, price_type TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT false, docstatus TEXT NOT NULL DEFAULT 'draft',
      legacy_editable BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pool.query(`INSERT INTO app_master_price_lists (price_list, currency, price_type, disabled, docstatus) VALUES
      ('Legacy Active', 'UGX', 'selling', false, 'submitted'),
      ('Legacy Inactive', 'UGX', 'selling', true, 'submitted'),
      ('Legacy Draft', 'UGX', 'selling', false, 'draft')`);
    await pool.query(`CREATE TABLE app_master_item_prices (
      id BIGSERIAL PRIMARY KEY, item_code TEXT NOT NULL REFERENCES app_master_items(item_code),
      price_list TEXT NOT NULL REFERENCES app_master_price_lists(price_list),
      price_list_rate NUMERIC(14, 2) NOT NULL, disabled BOOLEAN NOT NULL DEFAULT false,
      docstatus TEXT NOT NULL DEFAULT 'draft', legacy_editable BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pool.query(`INSERT INTO app_master_item_prices (item_code, price_list, price_list_rate, disabled, docstatus)
      VALUES ('ITEM-1', 'Legacy Active', 25, false, 'submitted')`);
    await pricing.initPricingTables(pool);
    assert.equal((await pool.query("SELECT active FROM app_master_item_prices WHERE price_list = 'Legacy Active'")).rows[0].active, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS total FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'app_master_item_prices' AND column_name = 'disabled'`, [schema])).rows[0].total, 0);
    assert.deepEqual((await pool.query(`SELECT price_list, active FROM app_master_price_lists
      WHERE price_list LIKE 'Legacy%' ORDER BY price_list`)).rows,
    [
      { price_list: 'Legacy Active', active: 1 },
      { price_list: 'Legacy Draft', active: 0 },
      { price_list: 'Legacy Inactive', active: 0 },
    ]);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS total FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'app_master_price_lists' AND column_name = 'disabled'`, [schema])).rows[0].total, 0);
    await pricing.setPriceListActive(pool, 'Legacy Draft', true);
    assert.deepEqual((({ docstatus, active }) => ({ docstatus, active }))(await pricing.findPricingRecord(pool, 'price-lists', 'Legacy Draft')),
      { docstatus: 'submitted', active: 1 });
    await pool.query("DELETE FROM app_master_item_prices WHERE price_list LIKE 'Legacy%'");
    await pool.query("DELETE FROM app_master_price_lists WHERE price_list LIKE 'Legacy%'");
    await pricing.initPricingTables(pool);
    await initRecordAudit(pool);
    await runWithAuditUser({ id: '1', username: 'Pricing tester' }, () => pricing.savePricingRecord(pool, 'price-lists', priceList));
    const list = await pricing.findPricingRecord(pool, 'price-lists', 'Retail');
    assert.equal(list.docstatus, 'submitted');
    assert.equal(list.active, 0);
    assert.equal(list.pricelist_type, 'Retail');
    assert.equal(list.created_by, 'Pricing tester');
    await assert.rejects(pricing.changePricingState(pool, 'price-lists', 'Retail', 'submit'), /Active switch/);
    await assert.rejects(pricing.changePricingState(pool, 'price-lists', 'Retail', 'cancel'), /Active switch/);
    await assert.rejects(pricing.savePricingRecord(pool, 'item-prices', itemPrice), /active price list/);
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_type: 'both' }, 'Retail');
    await pricing.setPriceListActive(pool, 'Retail', true);
    assert.equal((await pricing.findPricingRecord(pool, 'price-lists', 'Retail')).active, 1);
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, currency: 'USD' }, 'Retail');
    await pricing.savePricingRecord(pool, 'price-lists', priceList, 'Retail');
    assert.equal((await pricing.findPricingRecord(pool, 'price-lists', 'Retail')).docstatus, 'submitted');
    await pricing.setPriceListActive(pool, 'Retail', false);
    assert.deepEqual((({ docstatus, active }) => ({ docstatus, active }))(await pricing.findPricingRecord(pool, 'price-lists', 'Retail')),
      { docstatus: 'submitted', active: 0 });
    await assert.rejects(pricing.savePricingRecord(pool, 'item-prices', itemPrice), /active price list/);
    await pricing.setPriceListActive(pool, 'Retail', true);
    await assert.rejects(pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_list: 'retail' }), /already exists/);
    await assert.rejects(pricing.savePricingRecord(pool, 'item-prices', { ...itemPrice, item_code: 'ITEM-2' }), /active, submitted item/);
    const id = await pricing.savePricingRecord(pool, 'item-prices', itemPrice);
    await assert.rejects(pricing.deletePriceList(pool, 'Retail'), /Delete the item prices/);
    await assert.rejects(pricing.savePricingRecord(pool, 'price-lists', { ...priceList, currency: 'USD' }, 'Retail'),
      /Cannot change the currency/);
    assert.equal((await pricing.findPricingRecord(pool, 'item-prices', id)).active, 0);
    await pricing.savePricingRecord(pool, 'item-prices', { ...itemPrice, price_list_rate: '0' }, id);
    await pricing.setItemPriceActive(pool, id, true);
    await pricing.setPriceListActive(pool, 'Retail', false);
    await pricing.setPriceListActive(pool, 'Retail', true);
    await pricing.savePricingRecord(pool, 'item-prices', { ...itemPrice, price_list_rate: '100' }, id);
    const { rows, total } = await pricing.listPricingRecords(pool, 'item-prices', { search: 'cement', paginate: true }, { limit: 1, offset: 0 });
    assert.equal(total, 1);
    assert.equal(rows[0].currency, 'UGX');
    assert.equal(rows[0].stock_uom, 'Bag');
    assert.equal(rows[0].price_list_rate, '100.000000');
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices', { paginate: true }, { limit: 1, offset: 1 })).rows.length, 0);
    assert.equal((await pricing.listPricingRecords(pool, 'price-lists', { search: "%' OR 1=1 --" }, { limit: 10, offset: 0 })).rows.length, 0);
    const replacement = await pricing.savePricingRecord(pool, 'item-prices', itemPrice);
    await assert.rejects(pricing.setItemPriceActive(pool, replacement, true), /active price already exists/i);
    await pricing.setItemPriceActive(pool, id, false);
    await pricing.setItemPriceActive(pool, replacement, true);
    await pricing.setItemPriceActive(pool, replacement, false);
    await pricing.setPriceListActive(pool, 'Retail', false);
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_list: 'Changed', price_type: 'both' }, 'Retail');
    const inactiveList = await pricing.findPricingRecord(pool, 'price-lists', 'Retail');
    assert.equal(inactiveList.price_type, 'both');
    assert.equal(inactiveList.docstatus, 'submitted');
    assert.equal(inactiveList.active, 0);
    await assert.rejects(pricing.setItemPriceActive(pool, replacement, true), /active price list/);
    await pricing.setPriceListActive(pool, 'Retail', true);
    assert.equal((await pricing.findPricingRecord(pool, 'price-lists', 'Retail')).docstatus, 'submitted');
    await assert.rejects(pricing.changePricingState(pool, 'item-prices', replacement, 'submit'), /Active switch/);
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_list: 'Temporary' });
    await pricing.deletePriceList(pool, 'Temporary');
    assert.equal(await pricing.findPricingRecord(pool, 'price-lists', 'Temporary'), null);
    await assert.rejects(pricing.deletePriceList(pool, 'Temporary'), /Price list not found/);
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_list: 'Alpha' });
    await pricing.savePricingRecord(pool, 'price-lists', { ...priceList, price_list: 'Zulu' });
    assert.deepEqual(await pricing.findPriceListNeighbors(pool, 'Retail'), { previous: 'Alpha', next: 'Zulu' });
    assert.deepEqual(await pricing.findPriceListNeighbors(pool, 'Alpha'), { previous: null, next: 'Retail' });
    assert.deepEqual(await pricing.findPriceListNeighbors(pool, 'Zulu'), { previous: 'Retail', next: null });
    await pricing.deletePriceList(pool, 'Alpha');
    await pricing.deletePriceList(pool, 'Zulu');
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices', { includeDisabled: true }, { limit: 10, offset: 0 })).rows.length, 2);
    assert.deepEqual(await pricing.listItemPricePriceLists(pool), ['Retail']);
    const retailPrices = await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: 'Retail', search: 'cement', paginate: true }, { limit: 1, offset: 0 });
    assert.equal(retailPrices.total, 2);
    assert.equal(retailPrices.rows.length, 1);
    assert.equal(retailPrices.rows[0].price_list, 'Retail');
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: 'Missing', paginate: true }, { limit: 10, offset: 0 })).total, 0);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: 'eta', priceListExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: 'Re%', priceListExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: '%%', priceListExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, search: 'build%cement', paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, search: '%%', paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.deepEqual(await pricing.listItemPriceCodes(pool, { search: 'ITEM', priceList: 'Retail' }), ['ITEM-1']);
    assert.deepEqual(await pricing.listItemPriceCodes(pool, { search: 'ITEM', priceList: 'Missing' }), []);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, itemCode: 'ITEM-1', itemCodeExact: true, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, itemCode: 'TEM', itemCodeExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, itemCode: 'TEM%', itemCodeExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 0);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, itemCode: '%TEM%', itemCodeExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await pricing.listPricingRecords(pool, 'item-prices',
      { includeDisabled: true, priceList: "%_' OR 1=1 --", priceListExact: false, paginate: true }, { limit: 10, offset: 0 })).total, 0);
  } finally {
    if (pool) await pool.end();
    await base.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await base.end();
  }
});
