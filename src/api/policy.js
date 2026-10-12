'use strict';
const { can } = require('../authorize');
const { invoiceAllowed, voucherWarehousesAllowed, invoicePriceListAllowed } = require('../access');
const { voucherOwnedByUser } = require('../voucher-ownership');
const { apiError } = require('./errors');

function requireAction(actor, scope, permission) {
  if (!can(actor.user, permission) || actor.kind === 'integration' && !actor.scopes.includes(scope)) {
    throw apiError(403, 'forbidden', 'This account or credential cannot perform this action.');
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
module.exports = { requireAction, requireInvoice };
