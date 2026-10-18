'use strict';
const { roundMoney } = require('../lib/money');

function decimal(value) {
  if (typeof value === 'string' && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) return value;
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw new Error('Invalid stored decimal.');
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

function master(kind, row) {
  const keys = { customers: ['customer_id', 'customer_name'], suppliers: ['supplier_id', 'supplier_name'],
    items: ['item_code', 'item_name'], warehouses: ['warehouse', 'warehouse'],
    'price-lists': ['price_list', 'price_list'], 'cost-centers': ['cost_center', 'cost_center_name'],
    employees: ['employee_id', 'employee_name'] };
  const [id, label] = keys[kind];
  const result = { id: String(row[id]), label: row[label] || String(row[id]), active: true };
  if (kind === 'customers') Object.assign(result, { customer_group: row.customer_group || '', territory: row.territory || '', phone: row.phone || '', tin: row.tin || '' });
  if (kind === 'suppliers') Object.assign(result, { supplier_type: row.supplier_type || '', phone: row.phone || '' });
  if (kind === 'items') {
    Object.assign(result, { stock_uom: row.stock_uom || '', category: row.category || '', description: row.description || '' });
    if (row.stock_balance !== undefined) Object.assign(result, { warehouse: row.warehouse, stock_balance: decimal(row.stock_balance) });
    if (row.api_price !== undefined) Object.assign(result, { unit_price: decimal(row.api_price), has_list_price: Boolean(row.has_list_price), currency: 'UGX' });
  }
  if (kind === 'warehouses') result.warehouse_type = row.warehouse_type || '';
  if (kind === 'price-lists') Object.assign(result, { currency: row.currency, price_type: row.price_type });
  if (kind === 'cost-centers') Object.assign(result, { parent_cost_center: row.parent_cost_center || '', company: row.company || '', cost_center_type: row.cost_center_type || '' });
  return result;
}

function stock(row) {
  return { item_code: row.item_code, item_name: row.item_name, warehouse: row.warehouse,
    quantity: decimal(row.quantity), valuation_rate: decimal(row.valuation_rate), stock_value: decimal(row.stock_value) };
}

// Display metadata already visible on an authorized invoice. Never expose actor IDs.
function displayAudit(row = {}) {
  const timestamp = value => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  return { created_by: row.created_by || null, created_at: timestamp(row.created_at),
    updated_by: row.updated_by || null, updated_at: timestamp(row.updated_at) };
}
function company(row = {}) {
  return Object.fromEntries(['name', 'address', 'phone', 'email', 'website', 'tax_id', 'registration_number']
    .map(key => [key, String(row[key] || '')]));
}

function invoice(row, detail = false) {
  const result = { id: String(row.id), invoice_no: row.invoice_no, non_system_invoice: row.non_system_invoice || null, docstatus: row.docstatus,
    invoice_date: row.invoice_date, posting_time: row.posting_time || null, due_date: row.due_date || null,
    customer_id: row.customer_id || null, customer_name: row.customer_name,
    price_list: row.price_list || null, currency: 'UGX', subtotal: decimal(row.subtotal),
    tax_amount: decimal(row.tax_amount), discount_amount: decimal(row.discount_amount),
    total: decimal(row.total), amount_paid: decimal(row.amount_paid),
    balance_due: decimal(roundMoney(Number(row.total) - Number(row.amount_paid))),
    payment_status: row.status, created_at: row.created_at, updated_at: row.updated_at };
  if (detail) Object.assign(result, { ...displayAudit(row), customer_phone: row.customer_phone || '', is_cash_sale: Boolean(row.is_cash_sale),
    submitted_by: row.submitted_by || null, submitted_at: displayAudit({ created_at: row.submitted_at }).created_at,
    cancelled_by: row.cancelled_by || null, cancelled_at: displayAudit({ created_at: row.cancelled_at }).created_at, notes: row.notes || '', cost_center: row.cost_center || null,
    invoicer_id: row.invoicer_id || null, invoicer: row.invoicer || null,
    items: (row.items || []).map(item => ({ ...displayAudit(item), item_code: item.item_code, item_name: item.item_name,
      warehouse: item.warehouse || null, quantity: decimal(item.quantity), unit_price: decimal(item.unit_price),
      line_total: decimal(item.line_total) })) });
  return result;
}

function payment(row, invoiceId) {
  const journalOnly = Boolean(row.journal_id);
  const legacy = !journalOnly && !row.payment_record_id;
  return { ...displayAudit(row), account_name: row.account_name || null, notes: row.notes || '', id: journalOnly ? `journal-${row.journal_id}` : legacy ? `legacy-${invoiceId}` : String(row.payment_record_id),
    source: journalOnly ? 'journal_allocation' : legacy ? 'legacy_balance' : 'invoice_payment', invoice_id: String(invoiceId),
    payment_no: journalOnly || legacy ? null : row.id, payment_date: row.payment_date, amount: decimal(row.amount),
    account_id: row.account_id ? String(row.account_id) : null, method: journalOnly ? 'journal' : row.method,
    docstatus: row.docstatus, reference: row.reference || null,
    journal_id: row.journal_id || row.journal_entry_id ? String(row.journal_id || row.journal_entry_id) : null };
}

function receivingAccount(row) {
  return { id: String(row.id), label: row.account_name, active: true, account_code: row.account_code,
    method: row.account_detail_type === 'Cash' ? 'cash' : 'bank' };
}
module.exports = { decimal, master, stock, invoice, payment, receivingAccount, company };
