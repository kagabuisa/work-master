'use strict';
// Transaction-aware adapters preserve the domain posting functions. Public
// financial requests are validated by the API before entering this service.
const { createPostgresInvoiceInTransaction, submitPostgresInvoiceInTransaction,
  addPostgresInvoicePaymentInTransaction } = require('../domain/sales');
const { requireAction, requireInvoiceInTransaction } = require('../api/policy');
const { scopeRestricted, categoryAllowed, warehouseAllowed, requireInvoicePriceList,
  assignedMasterRecordAllowed } = require('../access');
const { atomicMutation, permanentPayment } = require('../api/transactions');
const { apiError } = require('../api/errors');
const { clearInvoiceCaches } = require('../web/cache');
const { requireReceiptAccount } = require('./sales-validation');
const { lockReferences, lockSubmissionItems, lockStock, lockReceivingAccount } = require('./sales-transaction-validation');
const { decimal } = require('../api/serializers');

async function invoiceResult(client, id) {
  const row = (await client.query(`SELECT id,invoice_no,docstatus,subtotal,tax_amount,discount_amount,total
    FROM app_invoices WHERE id=$1`, [id])).rows[0];
  return { id: String(row.id), invoice_no: row.invoice_no, docstatus: row.docstatus,
    subtotal: decimal(row.subtotal), tax_amount: decimal(row.tax_amount),
    discount_amount: decimal(row.discount_amount), total: decimal(row.total) };
}

async function executeInvoiceOperation(actor, operation, id, key, validatedPayload) {
  const policies = {
    'invoice.create': ['invoices:create', 'vouchers.sales.create'],
    'invoice.submit': ['invoices:submit', 'vouchers.sales.submit'],
    'payment.record': ['payments:record', 'payments.sales.record'],
  };
  if (!policies[operation]) throw apiError(400, 'invalid_operation', 'Unknown sales operation.');
  const [scope, permission] = policies[operation];
  let lockedInvoice;
  let referenceReplayed = false;
  const path = operation === 'invoice.create' ? '/invoices' : `/invoices/${id}/${operation === 'invoice.submit' ? 'submit' : 'payments'}`;
  const result = await atomicMutation(actor, operation, path, key, validatedPayload,
    async (client, fresh) => {
      requireAction(fresh, scope, permission);
      if (operation !== 'invoice.create') lockedInvoice = await requireInvoiceInTransaction(client, fresh, id, scope, permission);
      if (operation === 'payment.record') requireReceiptAccount(fresh.user, validatedPayload.account_id);
      if (operation === 'invoice.create') {
        if (!Array.isArray(validatedPayload.items) || !validatedPayload.items.length
          || validatedPayload.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw apiError(422, 'validation_failed', 'Provide invoice lines.');
        if (validatedPayload.payments && (!Array.isArray(validatedPayload.payments) || validatedPayload.payments.length)
          || Number(validatedPayload.amount_paid || 0)) {
          throw apiError(400, 'invalid_request', 'Create a draft without payments.');
        }
        if (scopeRestricted(fresh.user, 'customers')) {
          const customer = (await client.query('SELECT customer_group FROM app_master_customers WHERE customer_id=$1 FOR SHARE', [validatedPayload.customer_id])).rows[0];
          if (!customer || !categoryAllowed(fresh.user, 'customers', customer.customer_group)) throw apiError(403, 'forbidden', 'Customer is not permitted.');
        }
        if (validatedPayload.items.some(item => !warehouseAllowed(fresh.user, item.warehouse || validatedPayload.warehouse))
          || validatedPayload.cost_center && !assignedMasterRecordAllowed(fresh.user, 'cost-centers', validatedPayload.cost_center)) {
          throw apiError(403, 'forbidden', 'The invoice references are not permitted.');
        }
        requireInvoicePriceList(fresh.user, validatedPayload.price_list);
      }
    }, async (client, fresh) => {
      if (operation === 'invoice.create') {
        const prepared = await lockReferences(client, fresh, validatedPayload, { creating: true });
        const invoiceId = await createPostgresInvoiceInTransaction(client, prepared);
        return { status: 201, data: await invoiceResult(client, invoiceId), resource: { type: 'invoice', id: invoiceId } };
      }
      if (operation === 'invoice.submit') {
        if (lockedInvoice.docstatus !== 'draft') throw apiError(409, 'state_conflict', 'Only draft invoices can be submitted.');
        await lockSubmissionItems(client, lockedInvoice.items);
        await lockStock(client, lockedInvoice.items);
        await submitPostgresInvoiceInTransaction(client, id);
        return { status: 200, data: await invoiceResult(client, id), resource: { type: 'invoice', id } };
      }
      const receipt = await permanentPayment(client, fresh, id, validatedPayload.external_source,
        validatedPayload.external_reference, validatedPayload, async transaction => {
          if (lockedInvoice.docstatus !== 'submitted') throw apiError(409, 'state_conflict', 'Submit the invoice before receiving payments.');
          await lockReceivingAccount(transaction, validatedPayload.account_id);
          try {
            await addPostgresInvoicePaymentInTransaction(transaction, id, validatedPayload);
          } catch (error) {
            // Domain validation retains its website status. Only this API adapter
            // maps expected business validation failures to the public contract.
            if (error.status === 400) throw apiError(422, 'validation_failed', error.message);
            throw error;
          }
          const { rows } = await transaction.query(`SELECT id FROM app_invoice_payments WHERE invoice_id=$1 ORDER BY payment_no DESC LIMIT 1`, [id]);
          return { id: String(rows[0].id), invoice_id: String(id) };
        }, () => { referenceReplayed = true; });
      return { status: 201, data: receipt, resource: { type: 'payment', id: receipt.id } };
    }, async (client, fresh, record) => {
      // A website edit can change the saved draft's visibility after creation.
      // Check the resulting resource, not only the original request references.
      if (operation === 'invoice.create') {
        await requireInvoiceInTransaction(client, fresh, record.resource_id || record.response.data.id, scope, permission);
      }
    });
  clearInvoiceCaches(); // After commit, including replay following an uncertain response.
  return { ...result, referenceReplayed };
}
module.exports = { executeInvoiceOperation };
