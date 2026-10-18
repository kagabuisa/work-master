const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { permissionCheck } = require('../src/authorize');
const { normalizePurchase, validatePurchaseOrder } = require('../src/purchases');
const { normalizePurchaseOrder } = require('../src/purchase-orders');

test('new purchase invoices use PURINV- and editing preserves existing voucher numbers', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { createPurchase, loadPurchase, updatePurchase } = require('../src/purchases');
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    await pool.query(`
      INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES ('PREFIX-SUP','Supplier');
      INSERT INTO app_master_items(item_code,item_name,is_purchase_item) VALUES ('PREFIX-ITEM','Item',true);
      INSERT INTO app_master_warehouses(warehouse) VALUES ('PREFIX-WH');
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES ('PREFIX-PL','UGX','buying',1);
    `);
    const payload = { posting_date: '2026-10-14', supplier_id: 'PREFIX-SUP', price_list: 'PREFIX-PL',
      items: [{ item_code: 'PREFIX-ITEM', warehouse: 'PREFIX-WH', quantity: 1, unit_price: 100 }] };
    const id = await createPurchase(payload);
    assert.equal((await loadPurchase(id)).purchase_no, `PURINV-${String(id).padStart(6, '0')}`);
    await pool.query('UPDATE app_purchases SET purchase_no=$1 WHERE id=$2', ['PUR-000001', id]);
    await updatePurchase(id, payload);
    assert.equal((await loadPurchase(id)).purchase_no, 'PUR-000001');
  } finally { await store.closeStore(); }
});

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
  await assert.rejects(validatePurchaseOrder(client, purchase), (error) => {
    assert.match(error.message, /draft purchase invoice: PUR-000009/);
    assert.deepEqual(error.draftPurchase, { id: 9, purchase_no: 'PUR-000009' });
    return true;
  });
  draft.purchase_no = null;
  await assert.rejects(validatePurchaseOrder(client, purchase), /draft purchase invoice: PURINV-000009/);
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
  const form = await renderView(path.join(__dirname, '..', 'views', 'purchase-order-form.ejs'), {
    ...base, purchase: { posting_date: '2026-10-02', items: [{}] }, error: null,
  });
  assert.match(form, /action="\/purchase-orders"/);
  assert.match(form, /Expected Delivery Date/);
  assert.match(form, /name="supplier_id"/);
  assert.doesNotMatch(form, /name="supplier_name"/);
  assert.match(form, /name="warehouse" id="purchase-order-warehouse"/);
  assert.doesNotMatch(form, /<td data-label="Warehouse">/);
  assert(form.indexOf('name="remarks"') > form.indexOf('id="purchase-items"'));
  const detail = await renderView(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'draft', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [], total: 0 }, error: null,
  });
  assert.match(detail, /\/purchase-orders\/1\/submit/);
  assert.match(detail, /\/purchase-orders\/1\/delete/);
  const submitted = await renderView(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'submitted', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [{ item_code: 'ITEM-1', item_name: 'Item', warehouse: 'Main', quantity: 5,
        received: 3, unit_price: 100, line_total: 500 }], total: 500 }, error: null,
  });
  assert.match(submitted, /\/purchases\/new\?purchase_order_id=1/);
  assert.match(submitted, /Remaining/);
  assert.match(submitted, /<span>Warehouse<\/span><strong>Main<\/strong>/);
  assert.doesNotMatch(submitted, /<th>Warehouse<\/th>/);
  const mixed = await renderView(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 2, order_no: 'PO-000002', docstatus: 'draft', posting_date: '2026-10-02',
      supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying', total: 300,
      items: [{ item_code: 'ITEM-1', item_name: 'First', warehouse: 'Main', quantity: 1, unit_price: 100, line_total: 100 },
        { item_code: 'ITEM-2', item_name: 'Second', warehouse: 'Branch', quantity: 1, unit_price: 200, line_total: 200 }] },
    error: null,
  });
  assert.match(mixed, /<span>Warehouse<\/span><strong>Multiple warehouses<\/strong>/);
  assert.match(mixed, /<th>Warehouse<\/th>/);
  const cancelled = await renderView(path.join(__dirname, '..', 'views', 'purchase-order.ejs'), {
    ...base, order: { id: 1, order_no: 'PO-000001', docstatus: 'cancelled', posting_date: '2026-10-02',
      posting_time: '11:30', supplier_name: 'Supplier', supplier_id: 'SUP-1', price_list: 'Buying',
      items: [], total: 0 }, error: null,
  });
  assert.match(cancelled, /\/purchase-orders\/1\/delete/);
  const invoice = await renderView(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { purchase_order_id: 1, supplier_id: 'SUP-1', supplier_name: 'Supplier',
      price_list: 'Buying', posting_date: '2026-10-02', items: [{ purchase_order_item_id: 11,
        item_code: 'ITEM-1', warehouse: 'Main', quantity: 2, unit_price: 100 }] }, error: null,
  });
  assert.match(invoice, /name="purchase_order_item_id" value="11"/);
  assert.match(invoice, /name="purchase_order_id" value="1"/);
  assert.match(invoice, /<td data-label="Warehouse">/);
  const draftInvoice = await renderView(path.join(__dirname, '..', 'views', 'purchase-form.ejs'), {
    ...base, purchase: { id: 9, posting_date: '2026-10-02', items: [{}] },
    purchaseOrders: [{ id: 1, order_no: 'PO-000001', supplier_name: 'Supplier' }], error: null,
  });
  assert.match(draftInvoice, /action="\/purchases\/9\/edit"/);
  assert.match(draftInvoice, /Load Order Items/);
});

test('receivable orders filter permissions in one query before limiting results', async () => {
  const { listReceivablePurchaseOrders } = require('../src/purchase-orders');
  let calls = 0;
  const pool = { async query(sql, params) {
    calls++;
    assert.match(sql, /o.created_by_user_id = \$1/);
    assert.match(sql, /supplier\.supplier_type/);
    assert.match(sql, /NOT EXISTS.*app_purchase_order_items item/s);
    assert.match(sql, /ORDER BY o.posting_date DESC, o.id DESC LIMIT 100/);
    assert.deepEqual(params, ['7', ['local'], ['Main'], ['Blocked']]);
    return { rows: [{ id: 1 }] };
  } };
  assert.deepEqual(await listReceivablePurchaseOrders({ ownerId: '7', allowedTypes: ['local'],
    allowedWarehouses: ['Main'], deniedWarehouses: ['Blocked'] }, pool), [{ id: 1 }]);
  assert.equal(calls, 1);
});

test('receivable order SQL preserves permission semantics and filters before the cap', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const { getPostgresPool, closeStore } = require('../src/core');
  const { listReceivablePurchaseOrders } = require('../src/purchase-orders');
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    // Temporary tables isolate this regression from application data and schema.
    await client.query(`CREATE TEMP TABLE app_purchase_orders
      (id bigint, order_no text, supplier_name text, supplier_id text,
       docstatus text, posting_date date, created_by_user_id text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE app_purchase_order_items
      (id bigint, purchase_order_id bigint, warehouse text, quantity numeric) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE app_master_suppliers
      (supplier_id text, supplier_type text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE app_purchase_items
      (purchase_order_item_id bigint, purchase_id bigint, quantity numeric) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE app_purchases (id bigint, docstatus text) ON COMMIT DROP`);
    await client.query(`INSERT INTO app_master_suppliers VALUES ('S', ' Local '), ('X', 'Import')`);
    await client.query(`INSERT INTO app_purchase_orders
      SELECT id, 'PO-' || id, 'Supplier', 'S', 'submitted', '2026-10-01',
        CASE WHEN id > 5 THEN 'other' ELSE '7' END FROM generate_series(1, 110) id`);
    await client.query(`INSERT INTO app_purchase_order_items
      SELECT id, id, 'Main', 10 FROM generate_series(1, 110) id`);
    await client.query(`UPDATE app_purchase_orders SET supplier_id='X' WHERE id=2`);
    await client.query(`UPDATE app_purchase_order_items SET warehouse='Blocked' WHERE id=3`);
    await client.query(`INSERT INTO app_purchase_order_items VALUES (111, 4, 'Blocked', 1)`);
    await client.query(`INSERT INTO app_purchases VALUES (1, 'submitted'), (2, 'draft'), (3, 'cancelled')`);
    await client.query(`INSERT INTO app_purchase_items VALUES (1,1,10), (5,2,10), (5,3,10), (111,1,1)`);
    const options = { ownerId: '7', allowedTypes: ['local'], allowedWarehouses: ['Main'], deniedWarehouses: [] };
    const ids = async opts => (await listReceivablePurchaseOrders(opts, client)).map(row => Number(row.id));
    assert.deepEqual(await ids(options), [5]);
    assert.deepEqual(await ids({ ...options, allowedTypes: [] }), []);
    assert.deepEqual(await ids({ ...options, allowedWarehouses: [] }), []);
    assert.deepEqual(await ids({ ...options, allowedWarehouses: null, deniedWarehouses: ['Blocked'] }), [5]);
    assert.deepEqual(await ids({ ...options, allowedWarehouses: ['Main', 'Blocked'], deniedWarehouses: ['Blocked'] }), [5]);
    assert.deepEqual(await ids({ ...options, allowedWarehouses: null }), [5,4,3]);
    const unrestricted = await ids({});
    assert.equal(unrestricted.length, 100);
    assert.equal(unrestricted[0], 110);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await closeStore();
  }
});

test('order detail and list receipt statuses track submitted quantities on every line and receipt cancellation', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { loadPurchaseOrder, listPurchaseOrders } = require('../src/purchase-orders');
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    const orderId = Number((await pool.query(`INSERT INTO app_purchase_orders
      (order_no, docstatus, posting_date, supplier_id, supplier_name, price_list)
      VALUES ('PO-RECEIPTS', 'submitted', '2026-10-01', 'SUP', 'Supplier', 'Buying') RETURNING id`)).rows[0].id);
    const items = (await pool.query(`INSERT INTO app_purchase_order_items
      (purchase_order_id, line_no, item_code, item_name, warehouse, quantity, unit_price, line_total)
      VALUES ($1, 1, 'A', 'Item A', 'Main', 5, 100, 500),
        ($1, 2, 'B', 'Item B', 'Main', 2.5, 100, 250) RETURNING id`, [orderId])).rows;
    const check = async (label) => {
      const detail = await loadPurchaseOrder(orderId);
      const listed = (await listPurchaseOrders({ q: 'PO-RECEIPTS' })).rows[0];
      assert.equal(detail.status_label, label);
      assert.equal(listed.status_label, label);
      assert.equal(listed.status_class, detail.status_class);
      const locals = { assetVersion: 'test', currentUser: { role: 'admin' }, can: () => true,
        availableReports: [], money: String, error: null };
      const detailHtml = await renderView(path.join(__dirname, '..', 'views', 'purchase-order.ejs'),
        { ...locals, order: detail });
      const listHtml = await renderView(path.join(__dirname, '..', 'views', 'purchase-orders.ejs'),
        { ...locals, query: {}, result: { rows: [listed], pagination: {
          offset: 0, total: 1, page: 1, limit: 25, total_pages: 1, start: 1, end: 1 } } });
      for (const html of [detailHtml, listHtml]) assert.ok(html.includes(`>${label}</span>`));

    };
    await check('Submitted');
    const receipt = async (no, line, quantities, docstatus) => {
      const id = Number((await pool.query(`INSERT INTO app_purchases
        (purchase_no, purchase_order_id, posting_date, supplier_id, supplier_name, docstatus)
        VALUES ($1,$2,'2026-10-02','SUP','Supplier',$3) RETURNING id`, [no, orderId, docstatus])).rows[0].id);
      for (const [index, quantity] of quantities.entries()) await pool.query(`INSERT INTO app_purchase_items
        (purchase_id, purchase_order_item_id, line_no, item_code, item_name, warehouse, quantity, unit_price, line_total)
        VALUES ($1,$2,$3,'ITEM','Item','Main',$4::numeric,100,$4::numeric*100)`, [id, items[line].id, index + 1, quantity]);
      return id;
    };
    const first = await receipt('RECEIPT-A', 0, [5], 'draft');
    await check('Submitted');
    await pool.query("UPDATE app_purchases SET docstatus='submitted' WHERE id=$1", [first]);
    await check('Partially Received');
    const second = await receipt('RECEIPT-B', 1, [1, 1.5], 'draft');
    await check('Partially Received');
    await pool.query("UPDATE app_purchases SET docstatus='submitted' WHERE id=$1", [second]);
    await check('Completed');
    await pool.query("UPDATE app_purchases SET docstatus='cancelled' WHERE id=$1", [second]);
    await check('Partially Received');
    await pool.query("UPDATE app_purchases SET docstatus='cancelled' WHERE id=$1", [first]);
    await check('Submitted');
    await pool.query("UPDATE app_purchase_orders SET docstatus='cancelled' WHERE id=$1", [orderId]);
    await check('Cancelled');
    await pool.query("UPDATE app_purchase_orders SET docstatus='draft' WHERE id=$1", [orderId]);
    await check('Draft');
  } finally { await store.closeStore(); }
});


test('duplicate draft notice links to the existing invoice and escapes its number', async () => {
  const locals = { assetVersion: 'test', currentUser: { role: 'admin' }, availableReports: [],
    money: String, purchase: { items: [], posting_date: '2026-10-17', posting_time: '12:00' }, error: 'Duplicate draft',
    draftPurchase: { id: 13, purchase_no: 'PUR-000013<script>' } };
  const file = path.join(__dirname, '..', 'views', 'purchase-form.ejs');
  const linked = await renderView(file, { ...locals, can: () => true });
  assert.match(linked, /href="\/purchases\/13">PUR-000013&lt;script&gt;<\/a>/);
  const restricted = await renderView(file, { ...locals, can: () => false });
  assert.doesNotMatch(restricted, /href="\/purchases\/13"/);
  assert.match(restricted, /Duplicate draft/);
});
