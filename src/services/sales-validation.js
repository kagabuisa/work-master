'use strict';
// Extracted without behavior changes from website sales routes.
const { findMasterItem, findMasterRecord, localStockQuantity } = require('../store');
const { findDbCustomer } = require('../web/parties');
const { accountAllowed, requireInvoicePriceList } = require('../access');

function requireReceiptAccount(user, value) {
  if (!value) { const error = new Error('Choose a cash or bank account.'); error.status = 400; throw error; }
  if (!accountAllowed(user, value)) {
    const error = new Error('Your account cannot use the selected payment account.');
    error.status = 403;
    throw error;
  }
}


async function validateDbItems(items, warehouse, options = {}) {
  const checkStock = options.checkStock === true;
  const selectedWarehouse = String(warehouse || '').trim();
  if (!selectedWarehouse) {
    const err = new Error('Select a warehouse.');
    err.status = 400;
    throw err;
  }

  const validated = [];
  for (const item of items || []) {
    const itemCode = String(item.item_code || '').trim();
    const quantity = normalizeItemQuantity(item.quantity);
    if (!itemCode || quantity <= 0) {
      continue;
    }

    const dbItem = await findDbItem(itemCode);
    if (!dbItem) {
      const err = new Error(`Item ${itemCode} is not available in ${selectedWarehouse}.`);
      err.status = 400;
      throw err;
    }
    const localBalance = await localStockQuantity(dbItem.item_code, selectedWarehouse);
    const available = normalizeStockQuantity(localBalance.quantity);
    if (checkStock && quantity > available) {
      const err = new Error(`Adjust quantity for ${dbItem.item_name}.`);
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: dbItem.item_name,
        item_code: dbItem.item_code,
        warehouse: selectedWarehouse,
        requested: quantity,
        available,
      };
      throw err;
    }

    validated.push({
      ...item,
      item_code: dbItem.item_code,
      item_name: dbItem.item_name,
      warehouse: selectedWarehouse,
      quantity,
      stock_at_sale: available,
    });
  }

  return validated;
}


async function findDbItem(itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) {
    return null;
  }
  return findMasterItem(code);
}


function normalizeStockQuantity(value) {
  const quantity = Number(value || 0);
  const rounded = Math.round(quantity);
  return Math.abs(quantity - rounded) <= 0.0015
    ? rounded
    : Number(quantity.toFixed(3));
}


function normalizeItemQuantity(value) {
  return Math.max(0, Number(Number(value || 0).toFixed(3)));
}


async function buildInvoicePayload(body, user) {
  const payload = {
    invoice_date: body.invoice_date,
    posting_time: body.posting_time,
    due_date: body.due_date,
    non_system_invoice: body.ext_invoice ?? body.non_system_invoice,
    customer_id: body.customer_id,
    customer_name: String(body.customer_name || '').trim(),
    customer_phone: String(body.customer_phone || '').trim(),
    price_list: String(body.price_list || '').trim(),
    cost_center: String(body.cost_center || '').trim(),
    invoicer_id: String(body.invoicer_id || '').trim(),
    invoicer: String(body.invoicer || '').trim(),
    warehouse: String(body.warehouse || '').trim(),
    notes: String(body.notes || '').trim(),
    discount_amount: body.discount_amount,
    tax_amount: body.tax_amount,
    amount_paid: body.amount_paid,
    items: JSON.parse(body.items_json || '[]'),
    payments: JSON.parse(body.payments_json || '[]'),
  };
  if (Array.isArray(payload.payments)) {
    for (const payment of payload.payments) requireReceiptAccount(user, payment?.account_id);
  }
  if (!payload.customer_name) {
    const err = new Error('Customer name is required.');
    err.status = 400;
    throw err;
  }
  const customer = await findDbCustomer(payload.customer_id);
  if (!customer) {
    const err = new Error('Select a customer from the database.');
    err.status = 400;
    throw err;
  }
  payload.customer_id = customer.customer_id;
  payload.customer_name = customer.customer_name;
  const priceList = await findMasterRecord('price-lists', payload.price_list);
  if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
    const err = new Error('Select an active UGX selling price list.'); err.status = 400; throw err;
  }
  requireInvoicePriceList(user, payload.price_list);
  if (payload.cost_center) {
    const costCenter = await findMasterRecord('cost_centers', payload.cost_center);
    if (!costCenter || costCenter.is_group || costCenter.disabled === '1') {
      const err = new Error('Select an enabled cost center.'); err.status = 400; throw err;
    }
  }
  const invoicer = payload.invoicer_id && await findMasterRecord('employees', payload.invoicer_id);
  if (!invoicer || (invoicer.disabled === '1'
      && payload.invoicer_id !== user?.record_access?.employee_id)) {
    const err = new Error('Select an invoicer from the employee list.'); err.status = 400; throw err;
  }
  payload.invoicer = invoicer.employee_name;
  payload.items = await validateDbItems(payload.items, payload.warehouse);
  return payload;
}


module.exports = { requireReceiptAccount, validateDbItems, buildInvoicePayload, normalizeStockQuantity };
