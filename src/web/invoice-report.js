'use strict';

const { getPostgresPool } = require('../core');
const { isValidIsoDate } = require('../lib/dates');
const { paginationOptions, paginationResult } = require('../lib/pagination');
const { sqlLikePattern } = require('../lib/search');

const columns = [
  { key: 'invoice_no', label: 'Invoice', type: 'link' },
  { key: 'non_system_invoice', label: 'Ext Invoice' },
  { key: 'invoice_date', label: 'Posting Date', type: 'date' },
  { key: 'posting_time', label: 'Time' },
  { key: 'due_date', label: 'Due Date', type: 'date' },
  { key: 'customer_id', label: 'Customer ID' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'customer_phone', label: 'Customer Phone' },
  { key: 'price_list', label: 'Price List' },
  { key: 'cost_center', label: 'Cost Center' },
  { key: 'invoicer_id', label: 'Invoicer ID' },
  { key: 'invoicer', label: 'Invoicer' },
  { key: 'is_cash_sale', label: 'Cash Sale', type: 'boolean' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'line_no', label: 'Line' },
  { key: 'item_code', label: 'Item Code' },
  { key: 'item_name', label: 'Item' },
  { key: 'item_category', label: 'Item Category' },
  { key: 'item_category_at_sale', label: 'Category at Sale' },
  { key: 'source', label: 'Item Source' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'stock_at_sale', label: 'Stock at Sale', type: 'number' },
  { key: 'unit_price', label: 'Unit Price', type: 'money' },
  { key: 'line_total', label: 'Line Total', type: 'money' },
  { key: 'item_cost', label: 'Item Cost', type: 'money' },
  { key: 'cost_rate', label: 'Cost Rate', type: 'money' },
  { key: 'cost_amount', label: 'Cost Amount', type: 'money' },
  { key: 'gross_profit', label: 'Gross Profit', type: 'money' },
  { key: 'subtotal', label: 'Invoice Subtotal', type: 'money' },
  { key: 'discount_amount', label: 'Discount', type: 'money' },
  { key: 'tax_amount', label: 'Tax', type: 'money' },
  { key: 'total', label: 'Invoice Total', type: 'money' },
  { key: 'amount_paid', label: 'Paid', type: 'money' },
  { key: 'balance_due', label: 'Balance Due', type: 'money' },
  { key: 'docstatus', label: 'Document Status' },
  { key: 'payment_status', label: 'Payment Status' },
  { key: 'notes', label: 'Notes' },
  { key: 'created_at', label: 'Created At' },
  { key: 'updated_at', label: 'Updated At' },
];

const defaultColumns = [
  'invoice_no', 'invoice_date', 'customer_name', 'item_name', 'item_category',
  'warehouse', 'quantity', 'unit_price', 'line_total', 'total', 'docstatus',
];
const profitColumns = new Set(['item_cost', 'cost_rate', 'cost_amount', 'gross_profit']);
const EXPORT_PAGE_SIZE = 1000;

function selectedColumns(query = {}, availableColumns = columns) {
  const allowed = new Set(availableColumns.map((column) => column.key));
  if (query.columns_applied === '1') {
    const requested = Array.isArray(query.columns) ? query.columns : [query.columns];
    const selected = [...new Set(requested.filter((key) => allowed.has(key)))];
    return selected.length ? selected : ['invoice_no'];
  }
  const saved = Array.isArray(query.savedColumns)
    ? [...new Set(query.savedColumns.filter((key) => allowed.has(key)))] : [];
  return saved.length ? saved : defaultColumns.filter((key) => allowed.has(key));
}

function availableReportColumns(canViewProfit) {
  return canViewProfit ? columns : columns.filter((column) => !profitColumns.has(column.key));
}

function validateSavedColumns(input, canViewProfit) {
  const requested = Array.isArray(input) ? input : input === undefined ? [] : [input];
  const available = availableReportColumns(canViewProfit);
  const allowed = new Set(available.map((column) => column.key));
  if (!requested.length || requested.length > columns.length
      || requested.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    const error = new Error('Choose at least one available report column.');
    error.status = 400;
    throw error;
  }
  const selected = new Set(requested);
  return available.filter((column) => selected.has(column.key)).map((column) => column.key);
}

async function loadSavedColumns(userId) {
  const { rows } = await getPostgresPool().query(
    'SELECT invoice_report_columns FROM app_users WHERE id = $1', [userId]);
  return Array.isArray(rows[0]?.invoice_report_columns) ? rows[0].invoice_report_columns : null;
}

async function saveDefaultColumns(userId, selected) {
  await getPostgresPool().query(
    'UPDATE app_users SET invoice_report_columns = $2::jsonb WHERE id = $1',
    [userId, JSON.stringify(selected)]);
}

async function resetDefaultColumns(userId) {
  await getPostgresPool().query('UPDATE app_users SET invoice_report_columns = NULL WHERE id = $1', [userId]);
}

function dateFilter(value, label) {
  const date = String(value || '').trim();
  if (date && !isValidIsoDate(date)) {
    const error = new Error(`Choose a valid ${label} date.`);
    error.status = 400;
    throw error;
  }
  return date;
}

async function invoiceReport(options = {}) {
  const exportPage = options.exportPage === true;
  const filters = {
    search: String(options.q || '').trim(),
    from: dateFilter(options.from, 'from'),
    to: dateFilter(options.to, 'to'),
    status: String(options.status || '').trim(),
    warehouse: String(options.warehouse || '').trim(),
    item: String(options.item || '').trim(),
    category: String(options.category || '').trim(),
  };
  if (filters.from && filters.to && filters.from > filters.to) {
    const error = new Error('From date must be on or before To date.');
    error.status = 400;
    throw error;
  }
  if (filters.status && !['draft', 'submitted', 'cancelled'].includes(filters.status)) {
    const error = new Error('Choose a valid invoice status.');
    error.status = 400;
    throw error;
  }
  const pagination = paginationOptions(exportPage
    ? { page: options.page, page_size: EXPORT_PAGE_SIZE } : options,
  exportPage ? EXPORT_PAGE_SIZE : 100, exportPage ? EXPORT_PAGE_SIZE : 200);
  const availableColumns = availableReportColumns(options.canViewProfit);
const params = [];
  const where = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  if (options.ownerId !== null && options.ownerId !== undefined) {
    const creator = `invoice.created_by_user_id = ${add(String(options.ownerId))}`;
    where.push(options.ownerEmployeeId
      ? `(${creator} OR invoice.invoicer_id = ${add(String(options.ownerEmployeeId))})` : creator);
  }
  if (Array.isArray(options.allowedGroups)) {
    const group = add(options.allowedGroups);
    where.push(`EXISTS (SELECT 1 FROM app_master_customers customer
      WHERE customer.customer_id = invoice.customer_id
        AND lower(trim(coalesce(customer.customer_group, ''))) = ANY(${group}::text[]))`);
  }
  if (Array.isArray(options.allowedWarehouses)) {
    const allowed = add(options.allowedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_invoice_items restricted
      WHERE restricted.invoice_pk = invoice.id AND restricted.warehouse IS NOT NULL
        AND restricted.warehouse <> ALL(${allowed}::text[]))`);
  }
  if (Array.isArray(options.deniedWarehouses) && options.deniedWarehouses.length) {
    const denied = add(options.deniedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_invoice_items restricted
      WHERE restricted.invoice_pk = invoice.id AND restricted.warehouse = ANY(${denied}::text[]))`);
  }
  if (filters.search) {
    const search = add(sqlLikePattern(filters.search.toLowerCase()));
    where.push(`(lower(coalesce(invoice.invoice_no, '')) LIKE ${search}
      OR lower(coalesce(invoice.non_system_invoice, '')) LIKE ${search}
      OR lower(invoice.customer_name) LIKE ${search}
      OR lower(coalesce(line.item_code, '')) LIKE ${search}
      OR lower(coalesce(line.item_name, '')) LIKE ${search})`);
  }
  if (filters.from) where.push(`invoice.invoice_date >= ${add(filters.from)}::date`);
  if (filters.to) where.push(`invoice.invoice_date <= ${add(filters.to)}::date`);
  if (filters.status) where.push(`invoice.docstatus = ${add(filters.status)}`);
  if (filters.warehouse) where.push(`line.warehouse = ${add(filters.warehouse)}`);
  if (filters.item) {
    const item = add(sqlLikePattern(filters.item.toLowerCase()));
    where.push(`(lower(coalesce(line.item_code, '')) LIKE ${item}
      OR lower(coalesce(line.item_name, '')) LIKE ${item})`);
  }
  if (filters.category) {
    where.push(`lower(coalesce(nullif(master.category, ''), line.item_category, ''))
      LIKE ${add(sqlLikePattern(filters.category.toLowerCase()))}`);
  }
  const fromSql = `FROM app_invoices invoice
    LEFT JOIN app_invoice_items line ON line.invoice_pk = invoice.id
    LEFT JOIN app_master_items master ON master.item_code = line.item_code`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rowsQuery = getPostgresPool().query(`
      SELECT invoice.id AS invoice_id, invoice.invoice_no, invoice.non_system_invoice,
        invoice.invoice_date::text, invoice.posting_time::text, invoice.due_date::text,
        invoice.customer_id, invoice.customer_name, invoice.customer_phone,
        invoice.price_list, invoice.cost_center, invoice.invoicer_id, invoice.invoicer,
        invoice.is_cash_sale, invoice.created_at::text, invoice.updated_at::text,
        invoice.subtotal::float, invoice.discount_amount::float, invoice.tax_amount::float,
        invoice.total::float, invoice.docstatus, invoice.notes,
        line.line_no, line.item_code, line.item_name,
        coalesce(nullif(master.category, ''), line.item_category) AS item_category,
        line.item_category AS item_category_at_sale, line.source,
        line.warehouse, line.quantity::float, line.stock_at_sale::float,
        line.unit_price::float, line.line_total::float, line.cost::float AS item_cost,
        line.cost_rate::float, line.cost_amount::float, line.gross_profit::float,
        CASE WHEN invoice.docstatus = 'draft' THEN 0
          ELSE payment_total.amount_paid END::float AS amount_paid,
        greatest(invoice.total - CASE WHEN invoice.docstatus = 'draft' THEN 0
          ELSE payment_total.amount_paid END, 0)::float AS balance_due,
        CASE WHEN invoice.docstatus = 'draft' OR payment_total.amount_paid <= 0 THEN 'unpaid'
          WHEN payment_total.amount_paid >= invoice.total THEN 'paid'
          ELSE 'partial' END AS payment_status
      ${fromSql}
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(payment.amount), 0) AS amount_paid
        FROM app_invoice_payments payment
        WHERE payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      ) payments ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(journal_payment.amount), 0) AS amount_paid
        FROM (
          SELECT journal.id, sum(journal_line.credit - journal_line.debit) AS amount
          FROM app_journal_entries journal
          JOIN app_journal_entry_lines journal_line ON journal_line.journal_entry_id = journal.id
          JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
            AND setting.account_id = journal_line.account_id
          WHERE journal.docstatus = 'submitted' AND journal.party_type = 'customer'
            AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
            AND COALESCE(NULLIF(journal_line.reference_no, ''), journal.reference_no) = invoice.invoice_no
            AND (nullif(journal.party_id, '') = nullif(invoice.customer_id, '')
              OR (coalesce(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name))
            AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment
              WHERE payment.journal_entry_id = journal.id)
          GROUP BY journal.id
          HAVING sum(journal_line.credit - journal_line.debit) > 0
        ) journal_payment
      ) journal_payments ON true
      CROSS JOIN LATERAL (
        SELECT coalesce(payments.amount_paid, 0) + coalesce(journal_payments.amount_paid, 0) AS amount_paid
      ) payment_total
      ${whereSql}
      ORDER BY invoice.invoice_date DESC, invoice.id DESC, line.line_no
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pagination.limit, pagination.offset]);
  const countQuery = exportPage ? null : getPostgresPool().query(
    `SELECT count(*)::int AS total ${fromSql} ${whereSql}`, params);
  const [rowsResult, countResult] = await Promise.all([rowsQuery, countQuery]);
  return {
    rows: rowsResult.rows,
    pagination: exportPage ? null : paginationResult(countResult.rows[0].total, pagination),
    filters,
    columns: availableColumns,
    selectedColumns: selectedColumns(options, availableColumns),
    hasSavedColumns: Array.isArray(options.savedColumns) && options.savedColumns.length > 0,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""';
  let text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  // Spreadsheet apps may evaluate cell contents beginning with these characters as formulas.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return `${values.map(csvCell).join(',')}\r\n`;
}

module.exports = { invoiceReport, columns, selectedColumns, validateSavedColumns,
  loadSavedColumns, saveDefaultColumns, resetDefaultColumns, csvLine, EXPORT_PAGE_SIZE };
