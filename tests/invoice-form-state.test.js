const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { invoiceFormState, duplicateInvoiceFormState } = require('../src/invoice-form-state');
const { permissionCheck } = require('../src/authorize');
const { normalizePostingTime, storedPostingTime } = require('../src/posting-time');
const { scriptJson } = require('../src/web/script-json');

test('new sales invoices default the employee and permitted retail price list', async () => {
  const store = require('../src/store');
  const routePath = require.resolve('../src/web/routes/sales');
  const previousRoute = require.cache[routePath];
  const originalFind = store.findMasterRecord;
  const originalCreate = store.createInvoice;
  const parties = require('../src/web/parties');
  const originalCustomer = parties.findDbCustomer;
  const lookups = [];
  store.findMasterRecord = async (kind, id) => {
    lookups.push([kind, id]);
    if (kind === 'price-lists') return { active: 1, docstatus: 'submitted', currency: 'UGX', price_type: 'selling' };
    return { employee_id: id, employee_name: 'Isa Kagabu', disabled: '1' };
  };
  parties.findDbCustomer = async () => ({ customer_id: 'C-1', customer_name: 'Customer' });
  let saved;
  store.createInvoice = async (payload) => { saved = payload; return 42; };
  try {
    delete require.cache[routePath];
    const router = require(routePath);
    const handler = router.stack.find((layer) => layer.route?.path === '/invoices/new').route.stack[0].handle;
    let rendered;
    const res = { render: (view, data) => { rendered = { view, data }; } };
    const errors = [];
    await handler({ currentUser: { record_access: { employee_id: 'EMP-ISA' } } }, res,
      (error) => errors.push(error));
    assert.deepEqual(errors, []);
    assert.deepEqual(lookups, [['employees', 'EMP-ISA'], ['price-lists', 'Retail Pricelist']]);
    assert.equal(rendered.view, 'new-invoice');
    assert.equal(rendered.data.invoice.invoicer_id, 'EMP-ISA');
    assert.equal(rendered.data.invoice.invoicer, 'Isa Kagabu');
    assert.equal(rendered.data.invoice.price_list, 'Retail Pricelist');
    const html = await ejs.renderFile(path.join(__dirname, '../views/new-invoice.ejs'), {
      ...locals, ...rendered.data, formError: null,
    });
    assert.match(html, /name="invoicer"[^>]*value="Isa Kagabu"/);
    assert.match(html, /name="invoicer_id" value="EMP-ISA"/);

    await handler({ currentUser: { role: 'standard', record_access: {
      warehouse: 'Main', retail_price_list: 'Retail Selling', employee_id: 'EMP-ISA',
    } } }, res, (error) => errors.push(error));
    assert.equal(rendered.data.invoice.warehouse, 'Main');
    assert.equal(rendered.data.invoice.price_list, 'Retail Selling');
    const defaultsHtml = await ejs.renderFile(path.join(__dirname, '../views/new-invoice.ejs'), {
      ...locals, ...rendered.data, formError: null,
    });
    assert.match(defaultsHtml, /name="price_list" required>\s*<option value="Retail Selling"/);
    assert.match(defaultsHtml, /name="warehouse" required>\s*<option value="Main"/);
    assert.match(defaultsHtml, new RegExp(`name="invoice_date" value="${rendered.data.today}"`));
    assert.match(defaultsHtml, /name="posting_time" value="19:40"/);
    assert.match(defaultsHtml, /name="ext_invoice"/);

    await handler({ currentUser: { role: 'standard', record_access: {
      warehouse: 'Main', retail_price_list: 'Retail Selling',
    }, permission_denials: ['warehouse.view:Main', 'invoice.price-list.view:Retail Selling'] } },
    res, (error) => errors.push(error));
    assert.equal(rendered.data.invoice, null);

    await handler({ currentUser: { record_access: {} } }, res, (error) => errors.push(error));
    assert.equal(rendered.data.invoice.price_list, 'Retail Pricelist');
    assert(lookups.some(([kind, id]) => kind === 'price-lists' && id === 'Retail Selling'));

    const create = router.stack.find((layer) => layer.route?.path === '/invoices'
      && layer.route.methods.post).route.stack[0].handle;
    let redirect;
    const body = {
      customer_id: 'C-1', customer_name: 'Customer', price_list: 'Retail Selling',
      invoicer_id: 'EMP-ISA', warehouse: 'Main', ext_invoice: 'EXT-42', items_json: '[]',
    };
    await create({ currentUser: { role: 'admin', record_access: { employee_id: 'EMP-ISA' } }, body },
      { redirect: (url) => { redirect = url; } }, (error) => errors.push(error));
    assert.equal(redirect, '/invoices/42');
    assert.equal(saved.invoicer_id, 'EMP-ISA');
    assert.equal(saved.invoicer, 'Isa Kagabu');
    assert.equal(saved.non_system_invoice, 'EXT-42');

    let rejected;
    await create({ currentUser: { role: 'admin', record_access: {} }, body }, {
      status: (code) => ({ render: (_view, data) => { rejected = { code, error: data.formError }; } }),
    }, (error) => errors.push(error));
    assert.deepEqual(rejected, { code: 400, error: 'Select an invoicer from the employee list.' });
  } finally {
    store.findMasterRecord = originalFind;
    store.createInvoice = originalCreate;
    parties.findDbCustomer = originalCustomer;
    delete require.cache[routePath];
    if (previousRoute) require.cache[routePath] = previousRoute;
  }
});

const attempted = {
  invoice_date: '2026-09-26', posting_time: '19:40', due_date: '2026-10-26', ext_invoice: 'EXT-0007', customer_id: 'C2',
  customer_name: 'New customer', price_list: 'Retail Selling', cost_center: 'Retail - WM', invoicer_id: 'EMP-004', invoicer: 'Jane Doe', warehouse: 'Retail', notes: 'Deliver tomorrow <please>',
  discount_amount: '120', tax_amount: '25',
  items_json: JSON.stringify([{ item_code: 'B', item_name: 'Item B', quantity: 7, unit_price: 200, warehouse: 'Retail' }]),
};
const locals = {
  assetVersion: 'test', currentUser: { role: 'admin', username: 'test' },
  can: () => true, availableReports: [], formError: 'Insufficient stock',
  currentPostingTime: () => '19:40',
  scriptJson,
};

test('failed draft edits retain attempted customer, warehouse, amounts and lines', () => {
  const state = invoiceFormState(attempted, { id: 12, invoice_no: 'INV-12', notes: 'Old', items: [{ item_code: 'A', quantity: 1 }] });
  assert.equal(state.invoice.id, 12);
  assert.equal(state.invoice.invoice_no, 'INV-12');
  assert.equal(state.invoice.non_system_invoice, attempted.ext_invoice);
  for (const key of ['invoice_date', 'posting_time', 'due_date', 'customer_id', 'customer_name', 'price_list', 'cost_center', 'invoicer_id', 'invoicer', 'warehouse', 'notes', 'discount_amount', 'tax_amount']) {
    assert.equal(state.invoice[key], attempted[key], key);
  }
  assert.deepEqual(state.items, JSON.parse(attempted.items_json));
});

test('duplicate opens a new unpaid draft with copied invoice details and items', async () => {
  const source = {
    id: 12, invoice_no: 'INV-12', docstatus: 'submitted', is_cash_sale: true,
    invoice_date: '2026-09-26', posting_time: '10:00', due_date: '2026-10-26',
    non_system_invoice: 'EXT-12', customer_id: 'C2', customer_name: 'New customer',
    customer_phone: '123', price_list: 'Retail Selling', cost_center: 'Retail - WM',
    invoicer_id: 'EMP-004', invoicer: 'Jane Doe', warehouse: 'Retail', notes: 'Deliver tomorrow',
    discount_amount: 120, tax_amount: 25, amount_paid: 500,
    payments: [{ id: 4, amount: 500 }],
    items: [{ id: 8, line_no: 1, item_code: 'B', item_name: 'Item B', warehouse: 'Retail',
      quantity: 7, unit_price: 200, stock_at_sale: 20 }],
  };
  const state = duplicateInvoiceFormState(source, { invoiceDate: '2026-10-02', postingTime: '14:30' });
  assert.equal(state.invoice.id, undefined);
  assert.equal(state.invoice.invoice_date, '2026-10-02');
  assert.equal(state.invoice.posting_time, '14:30');
  assert.equal(state.invoice.due_date, '');
  assert.equal(state.invoice.non_system_invoice, '');
  assert.equal(state.invoice.amount_paid, 0);
  assert.deepEqual(state.invoice.payments, []);
  assert.equal(state.invoice.customer_id, source.customer_id);
  assert.equal(state.invoice.price_list, source.price_list);
  assert.equal(state.invoice.notes, source.notes);
  assert.deepEqual(state.items, [{ item_code: 'B', item_name: 'Item B', warehouse: 'Retail',
    quantity: 7, unit_price: 200, stock_at_sale: null }]);
  const html = await ejs.renderFile(path.join(__dirname, '../views/new-invoice.ejs'), {
    ...locals, formError: null, ...state, duplicateOf: source.invoice_no,
  });
  assert.match(html, /action="\/invoices"/);
  assert.match(html, /Copy of <strong>INV-12<\/strong>/);
  assert.doesNotMatch(html, /action="\/invoices\/12"|EXT-12|"id":12|"amount":500/);

  const store = require('../src/store');
  const routePath = require.resolve('../src/web/routes/sales');
  const previousRoute = require.cache[routePath];
  const originalFind = store.findInvoice;
  const originalCompany = store.getCompanyInformation;
  const originalStock = store.localStockQuantity;
  const stockLookups = [];
  store.findInvoice = async () => source;
  store.getCompanyInformation = async () => ({});
  store.localStockQuantity = async (itemCode, warehouse) => {
    stockLookups.push([itemCode, warehouse]);
    return { quantity: 13.5 };
  };
  try {
    delete require.cache[routePath];
    const router = require(routePath);
    const handler = router.stack.find((layer) => layer.route?.path === '/invoices/:id/duplicate')
      .route.stack[0].handle;
    let rendered;
    const errors = [];
    await handler({ params: { id: '12' } }, { render: (view, data) => { rendered = { view, data }; } },
      (error) => errors.push(error));
    assert.deepEqual(errors, []);
    assert.deepEqual(stockLookups, [['B', 'Retail']]);
    assert.equal(rendered.view, 'new-invoice');
    assert.equal(rendered.data.items[0].stock_at_sale, 13.5);
    assert.equal(rendered.data.items[0].warehouse, 'Retail');
    assert.equal(rendered.data.items[0].unit_price, 200);
  } finally {
    store.findInvoice = originalFind;
    store.getCompanyInformation = originalCompany;
    store.localStockQuantity = originalStock;
    delete require.cache[routePath];
    if (previousRoute) require.cache[routePath] = previousRoute;
  }
});

test('duplicate route needs both sales view and create permissions', () => {
  const allowed = (permissions, method = 'GET') => permissionCheck({
    currentUser: { role: 'standard', permissions }, path: '/invoices/12/duplicate', method, body: {},
  });
  assert.equal(allowed(['vouchers.sales.view', 'vouchers.sales.create']), true);
  assert.equal(allowed(['vouchers.sales.view']), false);
  assert.equal(allowed(['vouchers.sales.create']), false);
  assert.equal(allowed(['vouchers.sales.view', 'vouchers.sales.create'], 'POST'), false);
});

test('posting time accepts minute precision and rejects invalid values', () => {
  assert.equal(normalizePostingTime('19:40'), '19:40');
  assert.equal(storedPostingTime('19:40:00'), '19:40');
  assert.throws(() => normalizePostingTime('24:00'), { status: 400 });
  assert.throws(() => normalizePostingTime('', { required: true }), { status: 400 });
});

test('failed creation remains a new invoice with Save only and escaped entered values', async () => {
  const state = invoiceFormState(attempted);
  const html = await ejs.renderFile(path.join(__dirname, '../views/new-invoice.ejs'), { ...locals, ...state });
  assert.match(html, /id="invoice-form" method="post" action="\/invoices"/);
  assert.match(html, /form="invoice-form" data-voucher-save data-edit-save>Save<\/button>/);
  assert.doesNotMatch(html, /Submit Cash Sale|Submit Invoice|name="cash_sale_method"/);
  assert.match(html, /Deliver tomorrow &lt;please&gt;/);
  assert.match(html, /name="ext_invoice" value="EXT-0007"/);
  assert.match(html, />Ext Invoice<\/label>/);
  assert.match(html, /name="cost_center"[^>]*value="Retail - WM"/);
  assert.match(html, /name="invoicer"[^>]*value="Jane Doe"/);
  assert.match(html, /name="invoicer_id" value="EMP-004"/);
  assert.match(html, /"warehouse":"Retail"/);
  assert.match(html, /"recovered":true/);
});

test('malformed item data does not crash error recovery or accept non-list data', () => {
  for (const items_json of ['{', '{}', 'null', '[null,3,"item"]']) {
    const state = invoiceFormState({ ...attempted, items_json });
    assert.deepEqual(state.items, []);
    assert.equal(state.invoice.notes, attempted.notes);
  }
});

test('saved drafts expose submission actions with permission checks; submitted invoices do not', async () => {
  const file = path.join(__dirname, '../views/invoice-actions.ejs');
  const invoice = { id: 12, invoice_date: '2026-09-26', total: 200, docstatus: 'draft' };
  const draft = await ejs.renderFile(file, { ...locals, invoice });
  assert.match(draft, /data-cash-sale-url="\/invoices\/12\/submit-cash-sale"/);
  assert.match(draft, /action="\/invoices\/12\/submit"/);
  assert.match(draft, /href="\/invoices\/12\/duplicate">Duplicate<\/a>\s*<a[^>]*href="\/invoices\/new"/);
  const restricted = await ejs.renderFile(file, { invoice, can: () => false });
  assert.doesNotMatch(restricted, /Submit/);
  assert.doesNotMatch(restricted, /Duplicate/);
  const blockedList = await ejs.renderFile(file, { ...locals, invoice, invoicePriceListAllowed: () => false });
  assert.doesNotMatch(blockedList, /action="\/invoices\/12\/submit"|data-cash-sale-url/);
  assert.match(blockedList, /Select an allowed price list/);
  const submitted = await ejs.renderFile(file, { ...locals, invoice: { ...invoice, docstatus: 'submitted' } });
  assert.doesNotMatch(submitted, /Submit Cash Sale|Submit Invoice/);
});

test('saved draft edit offers submission actions until the form has changes', async () => {
  const invoice = { id: 12, invoice_no: 'INV-12', invoice_date: '2026-09-26', price_list: 'Retail', warehouse: 'Main', total: 200 };
  const file = path.join(__dirname, '../views/new-invoice.ejs');
  const draft = await ejs.renderFile(file, { ...locals, formError: null, invoice, items: [], today: '2026-09-26' });
  assert.match(draft, /data-cash-sale-url="\/invoices\/12\/submit-cash-sale"/);
  assert.match(draft, /action="\/invoices\/12\/submit"[^>]*data-edit-submit-action/);
  assert.match(draft, /data-edit-save hidden>Save<\/button>/);

  const recovered = await ejs.renderFile(file, { ...locals, invoice, items: [], today: '2026-09-26' });
  assert.match(recovered, /"recovered":true/);
  const restricted = await ejs.renderFile(file, { ...locals, can: () => false, invoice, items: [], today: '2026-09-26' });
  assert.doesNotMatch(restricted, /Submit Cash Sale|Submit Invoice/);
  assert.match(restricted, /data-edit-save>Save<\/button>/);
  const blockedList = await ejs.renderFile(file, { ...locals, invoicePriceListAllowed: () => false, invoice, items: [], today: '2026-09-26' });
  assert.doesNotMatch(blockedList, /Submit Cash Sale|Submit Invoice/);
  assert.match(blockedList, /data-edit-save>Save<\/button>/);
});

test('sales payment form offers cash and bank ledger accounts', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/invoice-payments.ejs'), {
    ...locals,
    invoice: { id: 12, status: 'unpaid', amount_paid: 0, total: 500 },
    payments: [{ id: 1, payment_date: '2026-09-26', amount: 100,
      account_id: 7, account_name: 'Main Bank', method: 'bank', docstatus: 'submitted' }],
    docstatus: 'submitted', balanceDue: 400, today: '2026-09-29', returnTo: '', money: (value) => String(value),
    formatDate: (value) => value, formatTimestamp: () => '',
    receiptAccounts: [
      { id: 6, account_code: '1110', account_name: 'Till Cash' },
      { id: 7, account_code: '1120', account_name: 'Main Bank' },
    ],
  });
  assert.match(html, /select name="account_id" required/);
  assert.match(html, /value="6">1110 · Till Cash/);
  assert.match(html, /value="7">1120 · Main Bank/);
  assert.doesNotMatch(html, /select name="method"/);
  assert.match(html, /<td>Main Bank<\/td>/);
});
