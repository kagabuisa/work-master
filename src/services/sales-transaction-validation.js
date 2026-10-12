'use strict';
// API-only final checks on the financial transaction connection. Website
// validation and posting entry points keep their existing behavior.
const access = require('../access');
const { apiError } = require('../api/errors');
const { normalizeQuantity } = require('../lib/quantity');
const { roundMoney } = require('../lib/money');
const { normalizeStockQuantity } = require('./sales-validation');

async function lockReferences(client, actor, payload, { creating = false } = {}) {
  const customer = (await client.query('SELECT * FROM app_master_customers WHERE customer_id=$1 FOR SHARE', [payload.customer_id])).rows[0];
  if (!customer || customer.disabled || customer.docstatus !== 'submitted') throw apiError(422, 'validation_failed', 'Select an active customer from the database.');
  if (!access.categoryAllowed(actor.user, 'customers', customer.customer_group)) throw apiError(403, 'forbidden', 'Customer is not permitted.');
  const list = (await client.query('SELECT * FROM app_master_price_lists WHERE price_list=$1 FOR SHARE', [payload.price_list])).rows[0];
  if (!list || list.active !== 1 || list.currency !== 'UGX' || !['selling', 'both'].includes(list.price_type)) {
    throw apiError(422, 'validation_failed', 'Select an active UGX selling price list.');
  }
  access.requireInvoicePriceList(actor.user, payload.price_list);
  if (payload.cost_center) {
    const center = (await client.query('SELECT * FROM app_master_cost_centers WHERE cost_center=$1 FOR SHARE', [payload.cost_center])).rows[0];
    if (!center || center.disabled || center.is_group) throw apiError(422, 'validation_failed', 'Select an enabled cost center.');
    if (!access.assignedMasterRecordAllowed(actor.user, 'cost-centers', payload.cost_center)) throw apiError(403, 'forbidden', 'Cost center is not permitted.');
  }
  const employee = payload.invoicer_id && (await client.query('SELECT * FROM app_master_employees WHERE employee_id=$1 FOR SHARE', [payload.invoicer_id])).rows[0];
  if (!employee || employee.disabled && payload.invoicer_id !== actor.user.record_access?.employee_id) {
    throw apiError(422, 'validation_failed', 'Select an invoicer from the employee list.');
  }
  if (creating && !access.assignedMasterRecordAllowed(actor.user, 'employees', payload.invoicer_id)) throw apiError(403, 'forbidden', 'Invoicer is not permitted.');
  const items = payload.items;
  if (!Array.isArray(items) || !items.length || items.length > 200) throw apiError(422, 'validation_failed', 'Provide between 1 and 200 invoice lines.');
  if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw apiError(422, 'validation_failed', 'Provide valid invoice line objects.');
  // Share-lock references in deterministic order. Do not reorder invoice lines
  // or change per-line pricing, rounding, valuation or posting logic.
  const codes = [...new Set(items.map(item => String(item.item_code || '').trim()))].sort();
  const warehouses = [...new Set(items.map(item => String(item.warehouse || payload.warehouse || '').trim()))].sort();
  if (codes.some(code => !code) || warehouses.some(warehouse => !warehouse)) throw apiError(422, 'validation_failed', 'Each line needs an item and warehouse.');
  const masterItems = (await client.query('SELECT * FROM app_master_items WHERE item_code=ANY($1::text[]) ORDER BY item_code FOR SHARE', [codes])).rows;
  if (masterItems.length !== codes.length || masterItems.some(item => item.disabled || item.docstatus !== 'submitted')) throw apiError(422, 'validation_failed', 'Select active submitted invoice items.');
  const masterWarehouses = (await client.query('SELECT * FROM app_master_warehouses WHERE warehouse=ANY($1::text[]) ORDER BY warehouse FOR SHARE', [warehouses])).rows;
  if (masterWarehouses.length !== warehouses.length || masterWarehouses.some(row => row.disabled || row.is_group || row.docstatus !== 'submitted')) throw apiError(422, 'validation_failed', 'Select enabled warehouses.');
  if (warehouses.some(warehouse => !access.warehouseAllowed(actor.user, warehouse))) throw apiError(403, 'forbidden', 'Warehouse is not permitted.');
  const byCode = new Map(masterItems.map(item => [item.item_code, item]));
  const stockAtDraft = new Map();
  for (const warehouse of warehouses) {
    const balances = (await client.query('SELECT item_code,quantity FROM app_stock_balances WHERE warehouse=$1 AND item_code=ANY($2::text[]) ORDER BY item_code FOR SHARE', [warehouse, codes])).rows;
    for (const row of balances) stockAtDraft.set(JSON.stringify([row.item_code, warehouse]), normalizeStockQuantity(row.quantity));
  }
  const normalized = items.map(item => {
    if (![item.quantity, item.unit_price].every(value => typeof value === 'number'
      || typeof value === 'string' && value.trim().length)) throw apiError(422, 'validation_failed', 'Provide numeric quantities and rates.');
    const quantity = Number(item.quantity), rate = Number(item.unit_price);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0
      || normalizeQuantity(quantity) <= 0 || quantity > 99999999999.999
      || roundMoney(rate) > 999999999999 || roundMoney(quantity * rate) > 999999999999) {
      throw apiError(422, 'validation_failed', 'Invoice quantities and rates must be valid finite values.');
    }
    return { ...item, item_code: String(item.item_code).trim(), item_name: byCode.get(String(item.item_code).trim()).item_name,
      warehouse: String(item.warehouse || payload.warehouse).trim(), quantity: normalizeQuantity(quantity), unit_price: item.unit_price,
      stock_at_sale: stockAtDraft.get(JSON.stringify([String(item.item_code).trim(), String(item.warehouse || payload.warehouse).trim()])) || 0 };
  });
  const amounts = ['tax_amount', 'discount_amount'].map(field => Number(payload[field] ?? 0));
  if (amounts.some(amount => !Number.isFinite(amount) || amount < 0 || roundMoney(amount) > 999999999999)
    || normalized.reduce((total, item) => total + roundMoney(item.quantity * roundMoney(item.unit_price)), 0) + roundMoney(amounts[0]) > 999999999999) {
    throw apiError(422, 'validation_failed', 'Invoice amounts exceed supported storage bounds.');
  }
  return { ...payload, customer_name: customer.customer_name, invoicer: employee.employee_name, items: normalized };
}

async function lockStock(client, items) {
  const keys = [...new Map(items.map(item => [JSON.stringify([item.item_code, item.warehouse]), [item.item_code, item.warehouse]])).values()]
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const balances = new Map();
  for (const [code, warehouse] of keys) {
    const row = (await client.query('SELECT quantity FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2 FOR UPDATE', [code, warehouse])).rows[0];
    balances.set(JSON.stringify([code, warehouse]), Number(row?.quantity || 0));
  }
  for (const item of items) {
    const key = JSON.stringify([item.item_code, item.warehouse]);
    const available = balances.get(key) - normalizeQuantity(item.quantity);
    if (available < -0.0005) throw apiError(422, 'insufficient_stock', `Insufficient stock for ${item.item_name} in ${item.warehouse}.`);
    balances.set(key, available);
  }
}

async function lockSubmissionItems(client, items) {
  // Website submission revalidates items and stock, not historical customer,
  // employee or price-list active status. Preserve those saved snapshots/rules.
  if (!Array.isArray(items) || !items.length || items.length > 200) throw apiError(422, 'validation_failed', 'Provide between 1 and 200 invoice lines.');
  const codes = [...new Set(items.map(item => item.item_code))].sort();
  const rows = (await client.query('SELECT item_code FROM app_master_items WHERE item_code=ANY($1::text[]) AND disabled=false AND docstatus=\'submitted\' ORDER BY item_code FOR SHARE', [codes])).rows;
  if (rows.length !== codes.length || items.some(item => !item.warehouse || normalizeQuantity(item.quantity) <= 0)) {
    throw apiError(422, 'validation_failed', 'Select active submitted invoice items and valid line warehouses.');
  }
}

async function lockReceivingAccount(client, accountId) {
  if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) < 1) throw apiError(422, 'validation_failed', 'Choose a valid cash or bank account.');
  // Identical eligibility to the existing validateReceivingAccount domain rule.
  const account = (await client.query(`SELECT id FROM app_accounts WHERE id=$1
    AND account_type='asset' AND account_detail_type IN ('Cash','Bank')
    AND is_active=true AND is_group=false FOR SHARE`, [accountId])).rows[0];
  if (!account) throw apiError(422, 'validation_failed', 'Choose an active cash or bank account.');
}
module.exports = { lockReferences, lockSubmissionItems, lockStock, lockReceivingAccount };
