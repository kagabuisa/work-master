'use strict';
const { can, permissionCheck } = require('../authorize');
const { invoiceAllowed, voucherWarehousesAllowed, invoicePriceListAllowed } = require('../access');
const { voucherOwnedByUser } = require('../voucher-ownership');
const { apiError } = require('./errors');

function requireAction(actor, scope, permission) {
  if (!can(actor.user, permission) || actor.kind === 'integration' && !actor.scopes.includes(scope)) {
    throw apiError(403, 'forbidden', 'This account or credential cannot perform this action.');
  }
}

function requireLookup(actor, scope, lookup) {
  if (actor.kind === 'integration' && !actor.scopes.includes(scope)
    || !permissionCheck({ currentUser: actor.user, path: `/api/${lookup}`, method: 'GET', body: {} })) {
    throw apiError(403, 'forbidden', 'This account or credential cannot read this resource.');
  }
}

async function requireInvoice(actor, id, scope, permission) {
  requireAction(actor, scope, permission);
  if (!/^[1-9][0-9]*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw apiError(404, 'not_found', 'Invoice not found.');
  }
  if (!await voucherOwnedByUser(actor.user, 'sales', id)
    || !await invoiceAllowed(actor.user, id)
    || !await voucherWarehousesAllowed(actor.user, 'sales', id)) {
    throw apiError(404, 'not_found', 'Invoice not found.');
  }
  const { findInvoice } = require('../store');
  const invoice = await findInvoice(id);
  if (!invoice || !invoicePriceListAllowed(actor.user, invoice.price_list)) {
    throw apiError(404, 'not_found', 'Invoice not found.');
  }
  return invoice;
}

async function requireInvoiceInTransaction(client, actor, id, scope, permission) {
  requireAction(actor, scope, permission);
  if (!/^[1-9][0-9]*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw apiError(404, 'not_found', 'Invoice not found.');
  const invoice = (await client.query('SELECT * FROM app_invoices WHERE id=$1 FOR UPDATE', [id])).rows[0];
  const hidden = () => apiError(404, 'not_found', 'Invoice not found.');
  if (!invoice) throw hidden();
  const access = require('../access');
  const { voucherOwnerId, voucherEmployeeId } = require('../voucher-ownership');
  const owner = voucherOwnerId(actor.user), employee = voucherEmployeeId(actor.user);
  if (owner !== null && String(invoice.created_by_user_id || '') !== owner
    && !(employee && invoice.invoicer_id === employee)) throw hidden();
  if (access.scopeRestricted(actor.user, 'customers')) {
    const customer = (await client.query('SELECT customer_group FROM app_master_customers WHERE customer_id=$1 FOR SHARE', [invoice.customer_id])).rows[0];
    if (!customer || !access.categoryAllowed(actor.user, 'customers', customer.customer_group)) throw hidden();
  }
  const { rows: items } = await client.query('SELECT * FROM app_invoice_items WHERE invoice_pk=$1 ORDER BY line_no FOR SHARE', [id]);
  if (items.some(item => item.warehouse && !access.warehouseAllowed(actor.user, item.warehouse))
    || !access.invoicePriceListAllowed(actor.user, invoice.price_list)) throw hidden();
  return { ...invoice, items };
}
module.exports = { requireAction, requireInvoice, requireLookup, requireInvoiceInTransaction };
