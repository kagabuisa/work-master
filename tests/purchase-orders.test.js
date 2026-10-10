const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { permissionCheck } = require('../src/authorize');
const { normalizePurchase, validatePurchaseOrder } = require('../src/purchases');
const { normalizePurchaseOrder } = require('../src/purchase-orders');

test('purchase order actions require their own permissions', () => {
  const request = (route, method, permissions) => ({
    path: route, method, body: {}, currentUser: { role: 'standard', permissions },
  });
  for (const [route, method, action] of [
    ['/purchase-orders', 'GET', 'view'],
    ['/purchase-orders/new', 'GET', 'create'],
    ['/purchase-orders', 'POST', 'create'],
    ['/purchase-orders/1/edit', 'GET', 'edit'],
    ['/purchase-orders/1', 'POST', 'edit'],
    ['/purchase-orders/1/submit', 'POST', 'submit'],
    ['/purchase-orders/1/cancel', 'POST', 'cancel'],
    ['/purchase-orders/1/delete', 'POST', 'delete'],
  ]) {
    assert.equal(permissionCheck(request(route, method, [`vouchers.purchase-orders.${action}`])), true);
    assert.equal(permissionCheck(request(route, method, ['vouchers.purchases.' + action])), false);
  }
});

test('purchase order lines validate dates, quantities and totals', () => {
  const payload = { posting_date: '2026-10-02', due_date: '2026-10-10', posting_time: '11:30',
    supplier_id: 'SUP-1', price_list: 'Buying', items: [
      { item_code: 'ITEM-1', warehouse: 'Main', quantity: '2', unit_price: '1500' },
    ] };
  const order = normalizePurchase(payload);
  assert.equal(order.total, 3000);
  assert.equal(order.items[0].line_total, 3000);
  assert.throws(() => normalizePurchase({ ...payload, due_date: '2026-10-01' }), /Due date/);
  assert.throws(() => normalizePurchase({ ...payload, items: [{ ...payload.items[0], quantity: '0' }] }), /quantity/);
});

test('a purchase order applies its header warehouse to every item', () => {
  const payload = { posting_date: '2026-10-02', supplier_id: 'SUP-1', price_list: 'Buying',
    warehouse: 'Main', items: [
      { item_code: 'ITEM-1', warehouse: 'Old', quantity: 2, unit_price: 100 },
      { item_code: 'ITEM-2', quantity: 1, unit_price: 200 },
    ] };
  const order = normalizePurchaseOrder(payload);
  assert.deepEqual(order.items.map((item) => item.warehouse), ['Main', 'Main']);
  assert.throws(() => normalizePurchaseOrder({ ...payload, warehouse: '' }), /Choose a warehouse/);
});

test('linked invoice lines cannot exceed the unreceived order quantity', async () => {
  let receivedQuantity = 3;
  const client = { async query(sql) {
    if (sql.includes('FROM app_purchase_orders WHERE id=')) return { rows: [
      { id: 7, order_no: 'PO-000007', supplier_id: 'SUP-1', price_list: 'Buying', docstatus: 'submitted' },
    ] };
    if (sql.includes('FROM app_purchase_order_items')) return { rows: [
      { id: '11', item_code: 'ITEM-1', warehouse: 'Main', quantity: 5 },
    ] };
    if (sql.includes('FROM app_purchase_items pi')) return { rows: [{ id: '11', quantity: receivedQuantity }] };
    if (sql.includes('FROM app_purchases')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const purchase = { purchase_order_id: 7, supplier_id: 'SUP-1', price_list: 'Buying',
    items: [{ purchase_order_item_id: 11, item_code: 'ITEM-1', warehouse: 'Main', quantity: 2 }] };
  await validatePurchaseOrder(client, { ...purchase, purchase_order_id: '7' }, 9, true);
  await assert.rejects(validatePurchaseOrder(client, { ...purchase, purchase_order_id: '7',
    items: [{ ...purchase.items[0], quantity: 2.001 }] }, 9, true), /exceeds the remaining/);
  for (const purchase_order_id of ['invalid', '0', '-1', '7.5', '9007199254740993']) {
    await assert.rejects(validatePurchaseOrder(client, { ...purchase, purchase_order_id }, 9, true),
      /Select a valid purchase order/);
  }
  for (const [excludeId, submitting] of [[null, false], [9, false], [9, true]]) {
    await validatePurchaseOrder(client, purchase, excludeId, submitting);
    await assert.rejects(validatePurchaseOrder(client, { ...purchase,
      items: [{ ...purchase.items[0], quantity: 2.001 }] }, excludeId, submitting),
    { message: 'Invoice quantity 2.001 exceeds the remaining quantity for ITEM-1 on purchase order PO-000007. Ordered: 5; already received: 3; remaining: 2.' });
    await assert.rejects(validatePurchaseOrder(client, { ...purchase,
      items: [{ ...purchase.items[0], quantity: 1.001 }, { ...purchase.items[0], quantity: 1 }] },
    excludeId, submitting), /exceeds the remaining/);
  }
  receivedQuantity = 0;
  await validatePurchaseOrder(client, { ...purchase, items: [{ ...purchase.items[0], quantity: 5 }] });
  await assert.rejects(validatePurchaseOrder(client, { ...purchase,
    items: [{ ...purchase.items[0], quantity: 5.001 }] }), /exceeds the remaining/);
  await assert.rejects(validatePurchaseOrder(client, { ...purchase,
    items: [{ ...purchase.items[0], item_code: 'ITEM-2' }] }), /must match/);
});

test('a purchase order permits only one draft invoice and allows editing that draft', async () => {
  const purchase = { purchase_order_id: 7, supplier_id: 'SUP-1', price_list: 'Buying', items: [] };
  let draft = { id: 9, purchase_no: 'PUR-000009', docstatus: 'draft' };
  let locked = false;
  const client = { async query(sql, params) {
    if (sql.includes('FROM app_purchase_orders')) {
      assert.match(sql, /FOR UPDATE/);
      locked = true;
      return { rows: [{ id: 7, supplier_id: 'SUP-1', price_list: 'Buying', docstatus: 'submitted' }] };
    }
    if (sql.includes('FROM app_purchases')) {
      assert.equal(locked, true);
      assert.match(sql, /docstatus='draft'/);
      assert.match(sql, /SELECT id, purchase_no/);
      assert.equal(params[0], 7);
      assert.match(sql, /\$2::bigint IS NULL OR id<>\$2/);
      return { rows: draft && draft.docstatus === 'draft' && draft.id !== params[1] ? [draft] : [] };
    }
    if (sql.includes('FROM app_purchase_order_items') || sql.includes('FROM app_purchase_items pi')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  await assert.rejects(validatePurchaseOrder(client, purchase), /draft purchase invoice: PUR-000009/);
  draft.purchase_no = null;
  await assert.rejects(validatePurchaseOrder(client, purchase), /draft purchase invoice: PUR-000009/);
  await validatePurchaseOrder(client, purchase, 9);
  await assert.rejects(validatePurchaseOrder(client, purchase, 10), /already has a draft purchase invoice/);
  for (const docstatus of ['submitted', 'cancelled']) {
    draft = { id: 9, docstatus };
    await validatePurchaseOrder(client, purchase);
  }
  draft = null;
  await validatePurchaseOrder(client, purchase);
  await validatePurchaseOrder(client, { purchase_order_id: null, items: [] });
});

test('purchase order form posts to order routes and detail exposes status actions', async () => {
  const base = { assetVersion: 'test', currentUser: { role: 'admin' }, can: () => true,
    availableReports: [], formatDate: (value) => value, formatDateTime: (date, time) => `${date} ${time}`,
    currentPostingTime: () => '11:30', money: (value) => String(value) };
  const form = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-order-form.ejs'), {
    ...base, purchase: { posting_date: '2026-10-02', items: [{}] }, error: null,
  });
  assert.match(form, /action="\/purchase-orders"/);
  assert.match(form, /Expected Delivery Date/);
  assert.match(form, /name="supplier_id"/);
  assert.doesNotMatch(form, /name="supplier_name"/);
  assert.match(form, /name="warehouse" id="purchase-order-warehouse"/);
  assert.doesNotMatch(form, /<td data-label="Warehouse">/);
  assert(form.indexOf('name="remarks"') > form.indexOf('id="purchase-items"'));
  const detail = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'draft', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [], total: 0 }, error: null,
  });
  assert.match(detail, /\/purchase-orders\/1\/submit/);
  assert.match(detail, /\/purchase-orders\/1\/delete/);
  const submitted = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'submitted', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [{ item_code: 'ITEM-1', item_name: 'Item', warehouse: 'Main', quantity: 5,
        received: 3, unit_price: 100, line_total: 500 }], total: 500 }, error: null,
  });
  assert.match(submitted, /\/purchases\/new\?purchase_order_id=1/);
  assert.match(submitted, /Remaining/);
  assert.match(submitted, /Warehouse: <strong>Main<\/strong>/);
  assert.doesNotMatch(submitted, /<th>Warehouse<\/th>/);
  const mixed = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 2, order_no: 'PO-000002', docstatus: 'draft', posting_date: '2026-10-02',
      supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying', total: 300,
      items: [{ item_code: 'ITEM-1', item_name: 'First', warehouse: 'Main', quantity: 1, unit_price: 100, line_total: 100 },
        { item_code: 'ITEM-2', item_name: 'Second', warehouse: 'Branch', quantity: 1, unit_price: 200, line_total: 200 }] },
    error: null,
  });
  assert.match(mixed, /Warehouse: <strong>Multiple warehouses<\/strong>/);
  assert.match(mixed, /<th>Warehouse<\/th>/);
  const cancelled = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'cancelled', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [], total: 0 }, error: null,
  });
  assert.match(cancelled, /\/purchase-orders\/1\/delete/);
  const invoice = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { purchase_order_id: 1, supplier_id: 'SUP-1', supplier_name: 'Supplier',
      price_list: 'Buying', posting_date: '2026-10-02', items: [{ purchase_order_item_id: 11,
        item_code: 'ITEM-1', warehouse: 'Main', quantity: 2, unit_price: 100 }] }, error: null,
  });
  assert.match(invoice, /name="purchase_order_item_id" value="11"/);
  assert.match(invoice, /name="purchase_order_id" value="1"/);
  assert.match(invoice, /<td data-label="Warehouse">/);
  const draftInvoice = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { id: 9, posting_date: '2026-10-02', items: [{}] },
    purchaseOrders: [{ id: 1, order_no: 'PO-000001', supplier_name: 'Supplier' }], error: null,
  });
  assert.match(draftInvoice, /action="\/purchases\/9\/edit"/);
  assert.match(draftInvoice, /Load Order Items/);
});
