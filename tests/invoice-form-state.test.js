const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { invoiceFormState } = require('../src/invoice-form-state');

const attempted = {
  invoice_date: '2026-09-26', due_date: '2026-10-26', customer_id: 'C2',
  customer_name: 'New customer', price_list: 'Retail Selling', warehouse: 'Retail', notes: 'Deliver tomorrow <please>',
  discount_amount: '120', tax_amount: '25',
  items_json: JSON.stringify([{ item_code: 'B', item_name: 'Item B', quantity: 7, unit_price: 200, warehouse: 'Retail' }]),
};
const locals = {
  assetVersion: 'test', currentUser: { role: 'admin', username: 'test' },
  can: () => true, availableReports: [], formError: 'Insufficient stock',
};

test('failed draft edits retain attempted customer, warehouse, amounts and lines', () => {
  const state = invoiceFormState(attempted, { id: 12, invoice_no: 'INV-12', notes: 'Old', items: [{ item_code: 'A', quantity: 1 }] });
  assert.equal(state.invoice.id, 12);
  assert.equal(state.invoice.invoice_no, 'INV-12');
  for (const key of ['invoice_date', 'due_date', 'customer_id', 'customer_name', 'price_list', 'warehouse', 'notes', 'discount_amount', 'tax_amount']) {
    assert.equal(state.invoice[key], attempted[key], key);
  }
  assert.deepEqual(state.items, JSON.parse(attempted.items_json));
});

test('failed creation remains a new invoice with Save only and escaped entered values', async () => {
  const state = invoiceFormState(attempted);
  const html = await ejs.renderFile(path.join(__dirname, '../views/new-invoice.ejs'), { ...locals, ...state });
  assert.match(html, /id="invoice-form" method="post" action="\/invoices"/);
  assert.match(html, /form="invoice-form" data-edit-save>Save<\/button>/);
  assert.doesNotMatch(html, /Submit Cash Sale|Submit Invoice|name="cash_sale_method"/);
  assert.match(html, /Deliver tomorrow &lt;please&gt;/);
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
  const restricted = await ejs.renderFile(file, { invoice, can: () => false });
  assert.doesNotMatch(restricted, /Submit/);
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
