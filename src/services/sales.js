'use strict';
// Transaction-aware adapters preserve the domain posting functions. Public
// financial endpoints and HTTP payload validation are intentionally deferred.
const { createPostgresInvoiceInTransaction, submitPostgresInvoiceInTransaction,
  addPostgresInvoicePaymentInTransaction } = require('../domain/sales');
const { requireAction, requireInvoice } = require('../api/policy');
const { masterRecordAllowed, warehouseAllowed, requireInvoicePriceList,
  assignedMasterRecordAllowed } = require('../access');
const { atomicMutation, permanentPayment } = require('../api/transactions');
const { apiError } = require('../api/errors');
const { clearInvoiceCaches } = require('../web/cache');
const { requireReceiptAccount } = require('./sales-validation');

async function executeInvoiceOperation(actor, operation, id, key, validatedPayload) {
  const policies = {
    'invoice.create': ['invoices:create', 'vouchers.sales.create'],
    'invoice.submit': ['invoices:submit', 'vouchers.sales.submit'],
    'payment.record': ['payments:record', 'payments.sales.record'],
  };
  if (!policies[operation]) throw apiError(400, 'invalid_operation', 'Unknown sales operation.');
  const [scope, permission] = policies[operation];
  const path = operation === 'invoice.create' ? '/invoices' : `/invoices/${id}/${operation === 'invoice.submit' ? 'submit' : 'payments'}`;
  const result = await atomicMutation(actor, operation, path, key, validatedPayload,
    async (client, fresh) => {
      requireAction(fresh, scope, permission);
      if (operation !== 'invoice.create') await requireInvoice(fresh, id, scope, permission);
      if (operation === 'payment.record') requireReceiptAccount(fresh.user, validatedPayload.account_id);
      if (operation === 'invoice.create') {
        if ((validatedPayload.payments || []).length || Number(validatedPayload.amount_paid || 0)) {
          throw apiError(400, 'invalid_request', 'Create a draft without payments.');
        }
        if (!await masterRecordAllowed(fresh.user, 'customers', validatedPayload.customer_id)
          || (validatedPayload.items || []).some(item => !warehouseAllowed(fresh.user, item.warehouse))
          || validatedPayload.cost_center && !assignedMasterRecordAllowed(fresh.user, 'cost-centers', validatedPayload.cost_center)) {
          throw apiError(403, 'forbidden', 'The invoice references are not permitted.');
        }
        requireInvoicePriceList(fresh.user, validatedPayload.price_list);
      }
    }, async (client, fresh) => {
      if (operation === 'invoice.create') {
        const invoiceId = await createPostgresInvoiceInTransaction(client, validatedPayload);
        return { status: 201, data: { id: String(invoiceId) }, resource: { type: 'invoice', id: invoiceId } };
      }
      if (operation === 'invoice.submit') {
        await submitPostgresInvoiceInTransaction(client, id);
        return { status: 200, data: { id: String(id) }, resource: { type: 'invoice', id } };
      }
      const receipt = await permanentPayment(client, fresh, id, validatedPayload.external_source,
        validatedPayload.external_reference, validatedPayload, async transaction => {
          await addPostgresInvoicePaymentInTransaction(transaction, id, validatedPayload);
          const { rows } = await transaction.query(`SELECT id FROM app_invoice_payments WHERE invoice_id=$1 ORDER BY payment_no DESC LIMIT 1`, [id]);
          return { id: String(rows[0].id), invoice_id: String(id) };
        });
      return { status: 201, data: receipt, resource: { type: 'payment', id: receipt.id } };
    });
  clearInvoiceCaches(); // After commit, including replay following an uncertain response.
  return result;
}
module.exports = { executeInvoiceOperation };
