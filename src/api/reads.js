'use strict';
const express = require('express');
const store = require('../store');
const access = require('../access');
const { voucherOwnerId, voucherEmployeeId } = require('../voucher-ownership');
const { warehouseAccessOptions, accountAccessOptions } = require('../web/helpers');
const { paginationOptions, paginationResult } = require('../lib/pagination');
const { requireAction, requireInvoice, requireLookup } = require('./policy');
const { readQuery, dates, envelope } = require('./query');
const serialize = require('./serializers');
const { apiError } = require('./errors');
const { recordApiAudit } = require('./audit');
const router = express.Router();
const wrap = action => (req, res, next) => Promise.resolve().then(() => action(req, res)).catch(next);
const priceDenials = user => user.role === 'admin' ? [] : (user.permission_denials || [])
  .filter(key => key.startsWith('invoice.price-list.view:')).map(key => key.slice('invoice.price-list.view:'.length));

async function reply(req, res, operation, result, resource) {
  await recordApiAudit(store.getPostgresPool(), req.apiActor, operation, 'allowed', resource);
  res.json(result);
}

const masters = {
  customers: { lookup: 'customers', fetch: store.masterCustomers, options: user => ({ allowedGroups: access.selectedCategories(user, 'customers') }) },
  suppliers: { lookup: 'suppliers', fetch: store.masterSuppliers, options: user => ({ allowedTypes: access.selectedCategories(user, 'suppliers') }) },
  items: { lookup: 'master-items', fetch: store.masterItems, options: () => ({ searchPublicOnly: true }) },
  warehouses: { lookup: 'warehouses', fetch: store.masterWarehouses, options: warehouseAccessOptions },
  'price-lists': { lookup: 'price-lists', fetch: store.masterPriceLists, options: user => ({
    allowedPriceLists: access.allowedInvoicePriceLists(user), deniedPriceLists: priceDenials(user), priceType: 'selling', currency: 'UGX' }) },
  'cost-centers': { lookup: 'cost-centers', fetch: store.masterCostCenters, options: user => ({
    allowedIds: access.allowedMasterRecordIds(user, 'cost-centers'), deniedIds: access.deniedMasterRecordIds(user, 'cost-centers') }) },
};

for (const [kind, config] of Object.entries(masters)) {
  router.get(`/${kind}`, wrap(async (req, res) => {
    requireLookup(req.apiActor, 'masters:read', config.lookup);
    const query = readQuery(req.query, kind === 'items' ? ['price_list'] : []);
    if (query.price_list !== undefined) {
      if (!query.price_list.trim()) throw apiError(400, 'invalid_query', 'price_list must not be empty.');
      requireLookup(req.apiActor, 'masters:read', 'price-lists');
      access.requireInvoicePriceList(req.currentUser, query.price_list);
      const list = await store.findMasterRecord('price-lists', query.price_list);
      if (!list || list.active !== 1 || list.docstatus !== 'submitted' || list.currency !== 'UGX'
        || !['selling', 'both'].includes(list.price_type)) throw apiError(422, 'validation_failed', 'Choose an active UGX selling price list.');
    }
    const rows = await config.fetch({ ...query, ...config.options(req.currentUser), paginate: true });
    if (query.price_list) {
      const prices = await store.invoiceItemPrices(rows.map(row => row.item_code), query.price_list);
      const byCode = new Map(prices.map(row => [row.item_code, row]));
      for (const row of rows) {
        const price = byCode.get(row.item_code);
        if (price) { row.api_price = price.unit_price; row.has_list_price = price.has_list_price; }
      }
    }
    await reply(req, res, `${kind}.read`, envelope(rows.map(row => serialize.master(kind, row)), rows.pagination));
  }));
}

router.get('/stock-balances', wrap(async (req, res) => {
  requireLookup(req.apiActor, 'stock:read', 'stock-balance');
  const query = readQuery(req.query, ['warehouse', 'item_code']);
  if (!query.warehouse?.trim()) throw apiError(400, 'invalid_query', 'warehouse is required.');
  if (!access.warehouseAllowed(req.currentUser, query.warehouse)) throw apiError(403, 'forbidden', 'Warehouse is not permitted.');
  if (query.item_code !== undefined && !query.item_code.trim()) throw apiError(400, 'invalid_query', 'item_code must not be empty.');
  const rows = await store.stockBalances({ ...query, itemCode: query.item_code, textNumerics: true });
  await reply(req, res, 'stock.read', envelope(rows.map(serialize.stock), rows.pagination));
}));

router.get('/invoices', wrap(async (req, res) => {
  requireAction(req.apiActor, 'invoices:read', 'vouchers.sales.view');
  const query = readQuery(req.query, ['from', 'to', 'warehouse', 'customer_id', 'docstatus', 'sort']);
  dates(query);
  if (query.docstatus !== undefined && !['draft', 'submitted', 'cancelled'].includes(query.docstatus)) throw apiError(400, 'invalid_query', 'Choose draft, submitted or cancelled.');
  if (query.sort !== undefined && !['id_asc', 'id_desc'].includes(query.sort)) throw apiError(400, 'invalid_query', 'sort must be id_asc or id_desc.');
  if (query.warehouse !== undefined && (!query.warehouse.trim() || !access.warehouseAllowed(req.currentUser, query.warehouse))) throw apiError(403, 'forbidden', 'Warehouse is not permitted.');
  if (query.customer_id !== undefined && !query.customer_id.trim()) throw apiError(400, 'invalid_query', 'customer_id must not be empty.');
  const result = await store.paginatedInvoices({ ...query, customerId: query.customer_id,
    order: query.sort === 'id_asc' ? 'asc' : 'desc',
    ownerId: voucherOwnerId(req.currentUser), ownerEmployeeId: voucherEmployeeId(req.currentUser),
    allowedGroups: access.selectedCategories(req.currentUser, 'customers'),
    ...warehouseAccessOptions(req.currentUser), allowedPriceLists: access.allowedInvoicePriceLists(req.currentUser),
    deniedPriceLists: priceDenials(req.currentUser) });
  await reply(req, res, 'invoices.read', envelope(result.rows.map(row => serialize.invoice(row)), result.pagination));
}));

router.get('/invoices/:id', wrap(async (req, res) => {
  readQuery(req.query, [], { paged: false });
  const invoice = await requireInvoice(req.apiActor, req.params.id, 'invoices:read', 'vouchers.sales.view');
  await reply(req, res, 'invoice.read', { data: serialize.invoice(invoice, true) }, { type: 'invoice', id: invoice.id });
}));

router.get('/invoices/:id/payments', wrap(async (req, res) => {
  const query = readQuery(req.query);
  const invoice = await requireInvoice(req.apiActor, req.params.id, 'invoices:read', 'vouchers.sales.view');
  const visible = [];
  for (const payment of invoice.payments || []) {
    if (payment.account_id) {
      if (!access.accountAllowed(req.currentUser, payment.account_id)) continue;
    } else if (access.namedListRestricted(req.currentUser, 'accounts')) {
      const journalId = payment.journal_id || payment.journal_entry_id;
      if (!journalId || !(await access.journalAccountAccess(req.currentUser, journalId)).allowed) continue;
    }
    visible.push(serialize.payment(payment, invoice.id));
  }
  const filtered = query.search ? visible.filter(row => Object.values(row).some(value =>
    String(value ?? '').toLowerCase().includes(query.search.toLowerCase()))) : visible;
  // Both filtering and counts use only the permitted parent/receipts.
  const pagination = paginationOptions(query, 50, 200);
  await reply(req, res, 'payments.read', envelope(filtered.slice(pagination.offset, pagination.offset + pagination.limit),
    paginationResult(filtered.length, pagination)), { type: 'invoice', id: invoice.id });
}));

router.get('/sales-options', wrap(async (req, res) => {
  const query = readQuery(req.query, ['purpose']);
  if (!['invoicing', 'payments'].includes(query.purpose)) throw apiError(400, 'invalid_query', 'purpose must be invoicing or payments.');
  if (query.purpose === 'invoicing') {
    requireAction(req.apiActor, 'invoices:create', 'vouchers.sales.create');
    const rows = await store.masterEmployees({ ...query, paginate: true, searchPublicOnly: true,
      allowedIds: access.allowedMasterRecordIds(req.currentUser, 'employees'), deniedIds: access.deniedMasterRecordIds(req.currentUser, 'employees') });
    const result = envelope(rows.map(row => serialize.master('employees', row)), rows.pagination);
    result.data = { invoicers: result.data };
    await reply(req, res, 'sales_options.invoicing', result);
  } else {
    requireAction(req.apiActor, 'payments:record', 'payments.sales.record');
    const rows = (await store.receivingAccounts(accountAccessOptions(req.currentUser))).map(serialize.receivingAccount);
    const filtered = query.search ? rows.filter(row => [row.label, row.account_code].some(value =>
      value.toLowerCase().includes(query.search.toLowerCase()))) : rows;
    const pagination = paginationOptions(query, 50, 200);
    const result = envelope(filtered.slice(pagination.offset, pagination.offset + pagination.limit), paginationResult(filtered.length, pagination));
    result.data = { receiving_accounts: result.data };
    await reply(req, res, 'sales_options.payments', result);
  }
}));
module.exports = router;
