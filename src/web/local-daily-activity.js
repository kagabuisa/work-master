'use strict';
const { getPostgresPool } = require('../core');
const { normalizeFilters, statusLabel } = require('./daily-activity');
const { recordAllowed } = require('./daily-activity-create');

function displayRow(row) {
  return { ...row, source: 'local', status_label: statusLabel(row.docstatus),
    href: `/reports/daily-activity/${encodeURIComponent(row.name)}` };
}
async function localDailyActivityReport(query = {}, user) {
  const filters = normalizeFilters(query);
  const values = [filters.from, filters.to];
  const where = ['date >= $1', 'date <= $2'];
  function add(sql, value) { values.push(value); where.push(sql.replaceAll('?', '$' + values.length)); }
  if (filters.status) add('docstatus = ?', Number(filters.status));
  if (filters.shop) add('shop ILIKE ?', `%${filters.shop}%`);
  if (filters.search) add('(name ILIKE ? OR shop ILIKE ? OR expense_details ILIKE ? OR remarks ILIKE ? OR comments_or_remarks ILIKE ?)', `%${filters.search}%`);
  const { rows } = await getPostgresPool().query(`SELECT * FROM app_daily_activity_reports
    WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC`, values);
  const visible = rows.filter(row => recordAllowed(user, row));
  const summary = visible.reduce((sum, row) => ({ total: sum.total + 1,
    sales: sum.sales + Number(row.sales), expense: sum.expense + Number(row.expense),
    banked: sum.banked + Number(row.banked) }), { total: 0, sales: 0, expense: 0, banked: 0 });
  const offset = (filters.page - 1) * 50;
  return { source: 'local', basePath: '/reports/daily-activity', filters, summary,
    rows: visible.slice(offset, offset + 50).map(displayRow), pagination: { page: filters.page, limit: 50,
      total: summary.total, total_pages: Math.max(1, Math.ceil(summary.total / 50)), offset,
      start: summary.total ? offset + 1 : 0, end: Math.min(offset + 50, summary.total) } };
}
async function localDailyActivityVoucher(name, user) {
  if (!/^DAR-\d{6,}$/.test(name || '')) return null;
  const { rows } = await getPostgresPool().query('SELECT * FROM app_daily_activity_reports WHERE name=$1', [name]);
  return rows[0] && recordAllowed(user, rows[0]) ? displayRow(rows[0]) : null;
}
module.exports = { localDailyActivityReport, localDailyActivityVoucher };
