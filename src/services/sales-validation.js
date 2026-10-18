'use strict';
// Website sales input and save-time stock validation.
const { getPostgresPool } = require('../core');
const { validateInvoiceDraftStock } = require('./invoice-draft-validation');
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
  if (items && !Array.isArray(items)) {
    const error=new Error('Provide a list of invoice items.'); error.status=400; throw error;
  }
  const checkStock = options.checkStock === true;
  const selectedWarehouse = String(warehouse || '').trim();
  if (!selectedWarehouse) {
    const err = new Error('Select a warehouse.');
    err.status = 400;
    throw err;
  }

  const codes = [...new Set((items || []).filter(item => normalizeItemQuantity(item.quantity)>0)
    .map(item => String(item.item_code || '').trim()).filter(Boolean))];
  const { rows } = codes.length ? await getPostgresPool().query(`
    SELECT item.item_code,item.item_name,stock.quantity::float
    FROM app_master_items item LEFT JOIN app_stock_balances stock
      ON stock.item_code=item.item_code AND stock.warehouse=$2
    WHERE item.item_code=ANY($1::text[]) AND item.disabled=false AND item.docstatus='submitted'`,
    [codes,selectedWarehouse]) : { rows: [] };
  const byCode = new Map(rows.map(item => [item.item_code,item]));
  const validated = [];
  for (const item of items || []) {
    const itemCode = String(item.item_code || '').trim();
    const quantity = normalizeItemQuantity(item.quantity);
    if (!itemCode || quantity <= 0) {
      continue;
    }

    const dbItem = byCode.get(itemCode);
    if (!dbItem) {
      const err = new Error(`Item ${itemCode} is not available in ${selectedWarehouse}.`);
      err.status = 400;
      throw err;
    }
    const available = normalizeStockQuantity(dbItem.quantity);
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
  const { rows: [references] } = await getPostgresPool().query(`SELECT
    (SELECT to_jsonb(c) FROM app_master_customers c WHERE c.customer_id=$1
      AND c.disabled=false AND c.docstatus='submitted') customer,
    (SELECT to_jsonb(p) FROM app_master_price_lists p WHERE p.price_list=$2) price_list,
    (SELECT to_jsonb(e) FROM app_master_employees e WHERE e.employee_id=$3) employee,
    (SELECT to_jsonb(c) FROM app_master_cost_centers c WHERE c.cost_center=$4) cost_center`,
    [String(payload.customer_id || '').trim(),payload.price_list,payload.invoicer_id,payload.cost_center]);
  const customer = references.customer;
  if (!customer) {
    const err = new Error('Select a customer from the database.');
    err.status = 400;
    throw err;
  }
  payload.customer_id = customer.customer_id;
  payload.customer_name = customer.customer_name;
  const priceList = references.price_list;
  if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
    const err = new Error('Select an active UGX selling price list.'); err.status = 400; throw err;
  }
  requireInvoicePriceList(user, payload.price_list);
  if (payload.cost_center) {
    const costCenter = references.cost_center;
    if (!costCenter || costCenter.is_group || costCenter.disabled === true) {
      const err = new Error('Select an enabled cost center.'); err.status = 400; throw err;
    }
  }
  const invoicer = payload.invoicer_id && references.employee;
  if (!invoicer || (invoicer.disabled === true
      && payload.invoicer_id !== user?.record_access?.employee_id)) {
    const err = new Error('Select an invoicer from the employee list.'); err.status = 400; throw err;
  }
  payload.invoicer = invoicer.employee_name;
  payload.items = await validateDbItems(payload.items, payload.warehouse, { checkStock: false });
  await validateInvoiceDraftStock(getPostgresPool(), payload);
  return payload;
}


module.exports = { requireReceiptAccount, validateDbItems, buildInvoicePayload, normalizeStockQuantity };
