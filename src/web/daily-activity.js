'use strict';

const { pool } = require('../db');
const { currentPostingDate } = require('../posting-time');
const { isValidIsoDate } = require('../lib/dates');

const PAGE_SIZE = 50;
const STATUS = { '0': 'Draft', '1': 'Submitted', '2': 'Cancelled' };

function normalizeFilters(query = {}) {
  const today = currentPostingDate();
  const from = isValidIsoDate(query.from) ? query.from : today;
  const to = isValidIsoDate(query.to) ? query.to : from;
  if (from > to) {
    const error = new Error('From date must be on or before To date.');
    error.status = 400;
    throw error;
  }
  return {
    from, to,
    status: Object.hasOwn(STATUS, String(query.status)) ? String(query.status) : '',
    shop: String(query.shop || '').trim().slice(0, 120),
    search: String(query.q || '').trim().slice(0, 120),
    page: Math.max(1, Math.min(10000, Number.parseInt(query.page, 10) || 1)),
  };
}

function voucherLink(row) {
  return `/reports/daily-activity/${encodeURIComponent(row.name)}`;
}

function statusLabel(value) {
  return STATUS[String(value)] || 'Unknown';
}

function queryParts(filters) {
  const where = ['`date` >= ?', '`date` <= ?'];
  const values = [filters.from, filters.to];
  if (filters.status) { where.push('docstatus = ?'); values.push(Number(filters.status)); }
  if (filters.shop) { where.push('`cost center` LIKE ?'); values.push(`%${filters.shop}%`); }
  if (filters.search) {
    where.push('(`name` LIKE ? OR `cost center` LIKE ? OR `expense details` LIKE ? OR `remarks` LIKE ? OR `comments_or_remarks` LIKE ?)');
    values.push(...Array(5).fill(`%${filters.search}%`));
  }
  return { where: where.join(' AND '), values };
}

async function dailyActivityReport(query = {}) {
  const filters = normalizeFilters(query);
  const { where, values } = queryParts(filters);
  const [summaryRows] = await pool.query(`SELECT COUNT(*) AS total,
    COALESCE(SUM(sales), 0) AS sales, COALESCE(SUM(expense), 0) AS expense,
    COALESCE(SUM(banked), 0) AS banked
    FROM \`tabDaily Activity Report\` WHERE ${where}`, values);
  const summary = summaryRows[0];
  const [rows] = await pool.query(`SELECT name, DATE_FORMAT(\`date\`, '%Y-%m-%d') AS date,
    \`cost center\` AS shop, unit_type, sales, expense, banked,
    \`expense details\` AS expense_details, stock_entry_number, packages_received,
    do_you_have_any_delivery_differences AS delivery_differences, remarks, docstatus
    FROM \`tabDaily Activity Report\` WHERE ${where}
    ORDER BY \`date\` DESC, modified DESC, name DESC LIMIT ? OFFSET ?`,
  [...values, PAGE_SIZE, (filters.page - 1) * PAGE_SIZE]);
  const total = Number(summary.total);
  return {
    filters, summary: { total, sales: Number(summary.sales), expense: Number(summary.expense), banked: Number(summary.banked) },
    rows: rows.map((row) => ({ ...row, status_label: statusLabel(row.docstatus), href: voucherLink(row) })),
    pagination: {
      page: filters.page, limit: PAGE_SIZE, total, total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      offset: (filters.page - 1) * PAGE_SIZE,
      start: total ? (filters.page - 1) * PAGE_SIZE + 1 : 0,
      end: Math.min(filters.page * PAGE_SIZE, total),
    },
  };
}

async function dailyActivityVoucher(name) {
  if (!name || name.length > 140 || name.includes('/')) return null;
  const [rows] = await pool.query(`SELECT name, DATE_FORMAT(\`date\`, '%Y-%m-%d') AS date,
    \`cost center\` AS shop, unit_type, leads, sales, expense, banked,
    \`expense details\` AS expense_details, stock_entry_number, packages_received,
    do_you_have_any_delivery_differences AS delivery_differences,
    item_not_received_or_excess_items_received AS item_differences,
    remarks, comments_or_remarks, warehouse, sales_invoiced, expenses_posted,
    cash_banked, bank_used, DATE_FORMAT(banked_on, '%Y-%m-%d') AS banked_on,
    amended_from, docstatus
    FROM \`tabDaily Activity Report\` WHERE name = ? LIMIT 1`, [name]);
  return rows[0] ? { ...rows[0], status_label: statusLabel(rows[0].docstatus) } : null;
}

module.exports = { normalizeFilters, voucherLink, dailyActivityReport, dailyActivityVoucher, statusLabel };
