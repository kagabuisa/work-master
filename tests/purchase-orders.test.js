const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { permissionCheck } = require('../src/authorize');
const { normalizePurchase, validatePurchaseOrder } = require('../src/purchases');

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

test('linked invoice lines cannot exceed the unreceived order quantity', async () => {
  const client = { async query(sql) {
    if (sql.includes('FROM app_purchase_orders WHERE id=')) return { rows: [
      { id: 7, order_no: 'PO-000007', supplier_id: 'SUP-1', price_list: 'Buying', docstatus: 'submitted' },
    ] };
    if (sql.includes('FROM app_purchase_order_items')) return { rows: [
      { id: '11', item_code: 'ITEM-1', warehouse: 'Main', quantity: 5 },
    ] };
    if (sql.includes('FROM app_purchase_items pi')) return { rows: [{ id: '11', quantity: 3 }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const purchase = { purchase_order_id: 7, supplier_id: 'SUP-1', price_list: 'Buying',
    items: [{ purchase_order_item_id: 11, item_code: 'ITEM-1', warehouse: 'Main', quantity: 2 }] };
  await validatePurchaseOrder(client, purchase, null, true);
  await assert.rejects(validatePurchaseOrder(client, { ...purchase,
    items: [{ ...purchase.items[0], quantity: 2.001 }] }, null, true), /exceeds the remaining/);
  await assert.rejects(validatePurchaseOrder(client, { ...purchase,
    items: [{ ...purchase.items[0], item_code: 'ITEM-2' }] }), /must match/);
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
  const invoice = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { purchase_order_id: 1, supplier_id: 'SUP-1', supplier_name: 'Supplier',
      price_list: 'Buying', posting_date: '2026-10-02', items: [{ purchase_order_item_id: 11,
        item_code: 'ITEM-1', warehouse: 'Main', quantity: 2, unit_price: 100 }] }, error: null,
  });
  assert.match(invoice, /name="purchase_order_item_id" value="11"/);
  assert.match(invoice, /name="purchase_order_id" value="1"/);
  const draftInvoice = await ejs.renderFile(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { id: 9, posting_date: '2026-10-02', items: [{}] },
    purchaseOrders: [{ id: 1, order_no: 'PO-000001', supplier_name: 'Supplier' }], error: null,
  });
  assert.match(draftInvoice, /action="\/purchases\/9\/edit"/);
  assert.match(draftInvoice, /Load Order Items/);
});
