'use strict';

const { getPostgresPool } = require('../core');
const { isValidIsoDate } = require('../lib/dates');
const { paginationOptions, paginationResult } = require('../lib/pagination');
const { sqlLikePattern } = require('../lib/search');
const { csvLine, EXPORT_PAGE_SIZE } = require('./invoice-report');

const purchaseColumns = [
  { key: 'purchase_no', label: 'Purchase Invoice', type: 'link' },
  { key: 'posting_date', label: 'Date', type: 'date' },
  { key: 'posting_time', label: 'Time' },
  { key: 'due_date', label: 'Due Date', type: 'date' },
  { key: 'supplier_id', label: 'Supplier ID' },
  { key: 'supplier_name', label: 'Supplier' },
  { key: 'supplier_reference', label: 'Supplier Reference' },
  { key: 'purchase_order_no', label: 'Purchase Order' },
  { key: 'price_list', label: 'Price List' },
  { key: 'cost_center', label: 'Cost Center' },
  { key: 'line_no', label: 'Line' },
  { key: 'item_code', label: 'Item Code' },
  { key: 'item_name', label: 'Item' },
  { key: 'item_category', label: 'Item Category' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'unit_price', label: 'Unit Price', type: 'money' },
  { key: 'line_total', label: 'Line Total', type: 'money' },
  { key: 'subtotal', label: 'Invoice Subtotal', type: 'money' },
  { key: 'total', label: 'Invoice Total', type: 'money' },
  { key: 'amount_paid', label: 'Paid', type: 'money' },
  { key: 'balance_due', label: 'Balance Due', type: 'money' },
  { key: 'docstatus', label: 'Document Status' },
  { key: 'payment_status', label: 'Payment Status' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'created_at', label: 'Created At' },
  { key: 'updated_at', label: 'Updated At' },
];

const orderColumns = [
  { key: 'order_no', label: 'Purchase Order', type: 'link' },
  { key: 'posting_date', label: 'Date', type: 'date' },
  { key: 'posting_time', label: 'Time' },
  { key: 'due_date', label: 'Expected Delivery', type: 'date' },
  { key: 'supplier_id', label: 'Supplier ID' },
  { key: 'supplier_name', label: 'Supplier' },
  { key: 'supplier_reference', label: 'Supplier Reference' },
  { key: 'price_list', label: 'Price List' },
  { key: 'cost_center', label: 'Cost Center' },
  { key: 'line_no', label: 'Line' },
  { key: 'item_code', label: 'Item Code' },
  { key: 'item_name', label: 'Item' },
  { key: 'item_category', label: 'Item Category' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'quantity', label: 'Ordered Quantity', type: 'number' },
  { key: 'received_quantity', label: 'Received Quantity', type: 'number' },
  { key: 'unit_price', label: 'Unit Price', type: 'money' },
  { key: 'line_total', label: 'Line Total', type: 'money' },
  { key: 'subtotal', label: 'Order Subtotal', type: 'money' },
  { key: 'total', label: 'Order Total', type: 'money' },
  { key: 'docstatus', label: 'Document Status' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'created_at', label: 'Created At' },
  { key: 'updated_at', label: 'Updated At' },
];

const journalColumns = [
  { key: 'journal_no', label: 'Journal', type: 'link' },
  { key: 'user', label: 'User' },
  { key: 'posting_date', label: 'Date', type: 'date' },
  { key: 'posting_time', label: 'Time' },
  { key: 'journal_type', label: 'Type' },
  { key: 'party_type', label: 'Party Type' },
  { key: 'party_id', label: 'Party ID' },
  { key: 'party_name', label: 'Party' },
  { key: 'reference_no', label: 'Reference' },
  { key: 'cost_center', label: 'Cost Center' },
  { key: 'line_no', label: 'Line' },
  { key: 'account_code', label: 'Account Code' },
  { key: 'account_name', label: 'Account' },
  { key: 'debit', label: 'Debit', type: 'money' },
  { key: 'credit', label: 'Credit', type: 'money' },
  { key: 'line_remarks', label: 'Line Remarks' },
  { key: 'total_debit', label: 'Total Debit', type: 'money' },
  { key: 'total_credit', label: 'Total Credit', type: 'money' },
  { key: 'docstatus', label: 'Document Status' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'created_at', label: 'Created At' },
];

const reports = {
  purchases: {
    title: 'Purchase Invoice', basePath: '/purchases', module: 'purchases',
    preference: 'purchase_report_columns', columns: purchaseColumns,
    defaults: ['purchase_no', 'posting_date', 'supplier_name', 'item_name', 'item_category', 'warehouse', 'quantity', 'unit_price', 'line_total', 'total', 'docstatus'],
    firstColumn: 'purchase_no', lineLabel: 'invoice', filename: 'purchase-invoices-report.csv',
  },
  'purchase-orders': {
    title: 'Purchase Order', basePath: '/purchase-orders', module: 'purchases',
    preference: 'purchase_order_report_columns', columns: orderColumns,
    defaults: ['order_no', 'posting_date', 'supplier_name', 'item_name', 'item_category', 'warehouse', 'quantity', 'received_quantity', 'unit_price', 'line_total', 'total', 'docstatus'],
    firstColumn: 'order_no', lineLabel: 'order', filename: 'purchase-orders-report.csv',
  },
  journals: {
    title: 'Journal', basePath: '/journals', module: 'accounts',
    preference: 'journal_report_columns', columns: journalColumns,
    defaults: ['journal_no', 'posting_date', 'journal_type', 'party_name', 'account_code', 'account_name', 'debit', 'credit', 'docstatus'],
    firstColumn: 'journal_no', lineLabel: 'journal', filename: 'journals-report.csv',
  },
};

function reportConfig(kind) {
  const config = reports[kind];
  if (!config) throw new Error('Unknown voucher report.');
  return config;
}

function selectedColumns(config, options = {}) {
  const allowed = new Set(config.columns.map((column) => column.key));
  if (options.columns_applied === '1') {
    const requested = Array.isArray(options.columns) ? options.columns : [options.columns];
    const selected = [...new Set(requested.filter((key) => allowed.has(key)))];
    return selected.length ? selected : [config.firstColumn];
  }
  const saved = Array.isArray(options.savedColumns)
    ? [...new Set(options.savedColumns.filter((key) => allowed.has(key)))] : [];
  return saved.length ? saved : config.defaults;
}

function validateColumns(config, input) {
  const requested = Array.isArray(input) ? input : input === undefined ? [] : [input];
  const allowed = new Set(config.columns.map((column) => column.key));
  if (!requested.length || requested.length > config.columns.length
    || requested.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    const error = new Error('Choose at least one available report column.');
    error.status = 400;
    throw error;
  }
  const selected = new Set(requested);
  return config.columns.filter((column) => selected.has(column.key)).map((column) => column.key);
}

async function loadSavedColumns(config, userId) {
  const { rows } = await getPostgresPool().query(`SELECT ${config.preference} AS columns FROM app_users WHERE id = $1`, [userId]);
  return Array.isArray(rows[0]?.columns) ? rows[0].columns : null;
}

async function saveColumns(config, userId, columns) {
  await getPostgresPool().query(`UPDATE app_users SET ${config.preference} = $2::jsonb WHERE id = $1`,
    [userId, JSON.stringify(columns)]);
}

async function resetColumns(config, userId) {
  await getPostgresPool().query(`UPDATE app_users SET ${config.preference} = NULL WHERE id = $1`, [userId]);
}

function parseFilters(config, options) {
  const filters = {
    search: String(options.q || '').trim(),
    from: String(options.from || '').trim(),
    to: String(options.to || '').trim(),
    status: String(options.status || '').trim(),
    item: String(options.item || '').trim(),
    category: String(options.category || '').trim(),
    warehouse: String(options.warehouse || '').trim(),
    journal_type: String(options.journal_type || '').trim(),
    account: String(options.account || '').trim(),
    user: String(options.user || '').trim(),
  };
  for (const key of ['from', 'to']) {
    if (filters[key] && !isValidIsoDate(filters[key])) {
      const error = new Error(`Choose a valid ${key} date.`); error.status = 400; throw error;
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    const error = new Error('From date must be on or before To date.'); error.status = 400; throw error;
  }
  if (filters.status && !['draft', 'submitted', 'cancelled'].includes(filters.status)) {
    const error = new Error('Choose a valid document status.'); error.status = 400; throw error;
  }
  if (config.basePath === '/journals' && filters.journal_type
    && !['cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'].includes(filters.journal_type)) {
    const error = new Error('Choose a valid journal type.'); error.status = 400; throw error;
  }
  return filters;
}

async function voucherReport(kind, options = {}) {
  const config = reportConfig(kind);
  const filters = parseFilters(config, options);
  const exportPage = options.exportPage === true;
  const pagination = paginationOptions(exportPage ? { page: options.page, page_size: EXPORT_PAGE_SIZE } : options,
    exportPage ? EXPORT_PAGE_SIZE : 100, exportPage ? EXPORT_PAGE_SIZE : 200);
  const params = [];
  const where = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const journal = kind === 'journals';
  const order = kind === 'purchase-orders';
  const parent = journal ? 'j' : order ? 'o' : 'p';
  if (options.ownerId !== null && options.ownerId !== undefined) {
    where.push(`${parent}.created_by_user_id = ${add(String(options.ownerId))}`);
  }
  const table = journal ? 'app_journal_entries' : order ? 'app_purchase_orders' : 'app_purchases';
  const lineTable = journal ? 'app_journal_entry_lines' : order ? 'app_purchase_order_items' : 'app_purchase_items';
  const lineFk = journal ? 'journal_entry_id' : order ? 'purchase_order_id' : 'purchase_id';
  let joins = `LEFT JOIN ${lineTable} line ON line.${lineFk} = ${parent}.id`;
  if (journal) joins += ` LEFT JOIN app_accounts account ON account.id = line.account_id
    LEFT JOIN app_users creator ON creator.id::text = ${parent}.created_by_user_id`;
  else joins += ' LEFT JOIN app_master_items master ON master.item_code = line.item_code';
  if (!journal && Array.isArray(options.allowedTypes)) {
    where.push(`EXISTS (SELECT 1 FROM app_master_suppliers supplier
      WHERE supplier.supplier_id = ${parent}.supplier_id
      AND lower(trim(coalesce(supplier.supplier_type, ''))) = ANY(${add(options.allowedTypes)}::text[]))`);
  }
  if (!journal && Array.isArray(options.allowedWarehouses)) {
    where.push(`NOT EXISTS (SELECT 1 FROM ${lineTable} restricted WHERE restricted.${lineFk} = ${parent}.id
      AND restricted.warehouse <> ALL(${add(options.allowedWarehouses)}::text[]))`);
  }
  if (!journal && Array.isArray(options.deniedWarehouses) && options.deniedWarehouses.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM ${lineTable} restricted WHERE restricted.${lineFk} = ${parent}.id
      AND restricted.warehouse = ANY(${add(options.deniedWarehouses)}::text[]))`);
  }
  const restrictedAccounts = [];
  if (journal && Array.isArray(options.allowedAccounts)) {
    restrictedAccounts.push(`restricted.account_id::text <> ALL(${add(options.allowedAccounts.map(String))}::text[])`);
  }
  if (journal && Array.isArray(options.deniedAccounts) && options.deniedAccounts.length) {
    restrictedAccounts.push(`restricted.account_id::text = ANY(${add(options.deniedAccounts.map(String))}::text[])`);
  }
  if (restrictedAccounts.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM app_journal_entry_lines restricted
      WHERE restricted.journal_entry_id = j.id AND (${restrictedAccounts.join(' OR ')}))`);
  }
  if (filters.search) {
    const value = add(sqlLikePattern(filters.search));
    const fields = journal
      ? ['j.journal_no', 'j.party_name', 'j.party_id', 'j.reference_no', 'account.account_code', 'account.account_name', 'creator.username']
      : [`${parent}.${order ? 'order_no' : 'purchase_no'}`, `${parent}.supplier_name`, `${parent}.supplier_id`, `${parent}.supplier_reference`, 'line.item_code', 'line.item_name'];
    where.push(`(${fields.map((field) => `lower(coalesce(${field}::text, '')) LIKE ${value}`).join(' OR ')})`);
  }
  if (filters.from) where.push(`${parent}.posting_date >= ${add(filters.from)}::date`);
  if (filters.to) where.push(`${parent}.posting_date <= ${add(filters.to)}::date`);
  if (filters.status) where.push(`${parent}.docstatus = ${add(filters.status)}`);
  if (journal) {
    if (filters.journal_type) where.push(`j.journal_type = ${add(filters.journal_type)}`);
    if (filters.user) where.push(`lower(coalesce(creator.username, '')) LIKE ${add(sqlLikePattern(filters.user))}`);
    if (filters.account) {
      const value = add(sqlLikePattern(filters.account));
      where.push(`(lower(coalesce(account.account_code, '')) LIKE ${value}
        OR lower(coalesce(account.account_name, '')) LIKE ${value})`);
    }
  } else {
    if (filters.warehouse) where.push(`line.warehouse = ${add(filters.warehouse)}`);
    if (filters.item) {
      const value = add(sqlLikePattern(filters.item));
      where.push(`(lower(coalesce(line.item_code, '')) LIKE ${value}
        OR lower(coalesce(line.item_name, '')) LIKE ${value})`);
    }
    if (filters.category) {
      where.push(`lower(coalesce(master.category, '')) LIKE ${add(sqlLikePattern(filters.category))}`);
    }
  }
  const fromSql = `FROM ${table} ${parent} ${joins}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const common = `${parent}.posting_date::text, ${parent}.posting_time::text,
    ${parent}.cost_center, ${parent}.docstatus, ${parent}.remarks, ${parent}.created_at::text,
    line.line_no`;
  const select = journal ? `j.id AS voucher_id, j.journal_no, creator.username AS "user", ${common}, j.journal_type,
    j.party_type, j.party_id, j.party_name, j.reference_no,
    j.total_debit::float, j.total_credit::float,
    account.account_code, account.account_name, line.debit::float, line.credit::float,
    line.remarks AS line_remarks`
    : `${parent}.id AS voucher_id, ${parent}.${order ? 'order_no' : 'purchase_no'}, ${common},
    ${parent}.due_date::text, ${parent}.supplier_id, ${parent}.supplier_name,
    ${parent}.supplier_reference, ${parent}.price_list, ${parent}.subtotal::float,
    ${parent}.total::float, ${parent}.updated_at::text,
    line.item_code, line.item_name, master.category AS item_category,
    line.warehouse, line.quantity::float, line.unit_price::float, line.line_total::float,
    ${order ? `coalesce((SELECT sum(receipt.quantity) FROM app_purchase_items receipt
      JOIN app_purchases received_purchase ON received_purchase.id = receipt.purchase_id
      WHERE receipt.purchase_order_item_id = line.id AND received_purchase.docstatus = 'submitted'), 0)::float
      AS received_quantity`
    : `${parent}.purchase_order_id, linked_order.order_no AS purchase_order_no,
      ${parent}.amount_paid::float,
      greatest(${parent}.total - ${parent}.amount_paid, 0)::float AS balance_due,
      ${parent}.status AS payment_status`}`;
  const extraJoin = !journal && !order
    ? 'LEFT JOIN app_purchase_orders linked_order ON linked_order.id = p.purchase_order_id' : '';
  const pool = options.pool || getPostgresPool();
  const rowsQuery = pool.query(`SELECT ${select} ${fromSql} ${extraJoin} ${whereSql}
    ORDER BY ${parent}.posting_date DESC, ${parent}.id DESC, line.line_no
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, pagination.limit, pagination.offset]);
  const countQuery = exportPage ? null : pool.query(`SELECT count(*)::int AS total ${fromSql} ${whereSql}`, params);
  const [rowsResult, countResult] = await Promise.all([rowsQuery, countQuery]);
  return {
    rows: rowsResult.rows, filters, columns: config.columns,
    selectedColumns: selectedColumns(config, options),
    hasSavedColumns: Array.isArray(options.savedColumns) && options.savedColumns.length > 0,
    pagination: exportPage ? null : paginationResult(countResult.rows[0].total, pagination),
  };
}

function columnsRedirect(config, body, notice) {
  const params = new URLSearchParams();
  for (const key of ['q', 'from', 'to', 'status', 'warehouse', 'item', 'category', 'journal_type', 'account', 'user']) {
    if (typeof body[key] === 'string' && body[key].trim()) params.set(key, body[key].trim());
  }
  params.set(notice, '1');
  return `${config.basePath}/report?${params}`;
}

async function exportCsv(res, config, options) {
  let page = 1;
  let report = await voucherReport(config.basePath.slice(1), { ...options, exportPage: true, page });
  const shown = report.columns.filter((column) => report.selectedColumns.includes(column.key));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${config.filename}"`,
    'Cache-Control': 'private, no-store' });
  res.write(`\uFEFF${csvLine(shown.map((column) => column.label))}`);
  while (!res.destroyed) {
    for (const row of report.rows) {
      if (res.destroyed) return;
      if (!res.write(csvLine(shown.map((column) => row[column.key])))) {
        await new Promise((resolve) => {
          const resume = () => { res.off('drain', resume); res.off('close', resume); resolve(); };
          res.once('drain', resume); res.once('close', resume);
        });
      }
    }
    if (report.rows.length < EXPORT_PAGE_SIZE) break;
    report = await voucherReport(config.basePath.slice(1), { ...options, exportPage: true, page: ++page });
  }
  if (!res.destroyed) res.end();
}

module.exports = { reportConfig, voucherReport, selectedColumns, validateColumns, loadSavedColumns,
  saveColumns, resetColumns, columnsRedirect, exportCsv };
