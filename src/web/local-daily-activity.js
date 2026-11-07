'use strict';
const { getPostgresPool } = require('../core');
const { normalizeFilters, statusLabel } = require('./daily-activity');
const { recordAllowed } = require('./daily-activity-create');
const { allowedNamedListValues, deniedNamedListValues, allowedMasterRecordIds, deniedMasterRecordIds } = require('../access');
const { runHeavyReport } = require('../workload-control');
const { shareRead, readSnapshot } = require('../read-cache');

function displayRow(row) {
  return { ...row, source: 'local', status_label: statusLabel(row.docstatus),
    href: `/reports/daily-activity/${encodeURIComponent(row.name)}`,
    stock_entry_href: row.stock_entry_id
      ? `/stock/entries/${encodeURIComponent(row.stock_entry_id)}` : null };
}
async function localDailyActivityReport(query = {}, user) {
  const filters = normalizeFilters(query);
  const values = [filters.from, filters.to];
  const where = ['report.date >= $1', 'report.date <= $2'];
  function add(sql, value) { values.push(value); where.push(sql.replaceAll('?', '$' + values.length)); }
  if (filters.status) add('report.docstatus = ?', Number(filters.status));
  if (filters.shop) add('report.shop ILIKE ?', `%${filters.shop}%`);
  if (filters.search) add('(report.name ILIKE ? OR report.shop ILIKE ? OR report.expense_details ILIKE ? '
    + 'OR report.remarks ILIKE ? OR report.comments_or_remarks ILIKE ?)', `%${filters.search}%`);
  const allowedWarehouses = allowedNamedListValues(user, 'warehouses');
  if (allowedWarehouses !== null) add('report.warehouse = ANY(?::text[])', allowedWarehouses);
  const deniedWarehouses = deniedNamedListValues(user, 'warehouses');
  if (deniedWarehouses.length) add('report.warehouse <> ALL(?::text[])', deniedWarehouses);
  const allowedShops = allowedMasterRecordIds(user, 'cost-centers');
  if (allowedShops !== null) add('report.shop = ANY(?::text[])', allowedShops);
  const deniedShops = deniedMasterRecordIds(user, 'cost-centers');
  if (deniedShops.length) add('report.shop <> ALL(?::text[])', deniedShops);
  const offset = (filters.page - 1) * 50;
  values.push(50, offset);
  const whereSql = where.join(' AND ');
  const pool = getPostgresPool();
  const result = await shareRead(pool,
    ['local-daily-activity', whereSql, values.slice(0, -2)], () =>
      runHeavyReport(() => readSnapshot(pool, async client => {
        // Use separate result sets inside one repeatable-read snapshot so
        // PostgreSQL DATE, TIMESTAMPTZ, NUMERIC and BIGINT values retain the
        // exact JavaScript types returned by the existing report contract.
        const { rows: [summary] } = await client.query(`
          SELECT COUNT(*)::int AS total,
            COALESCE(SUM(sales), 0)::float AS sales,
            COALESCE(SUM(expense), 0)::float AS expense,
            COALESCE(SUM(banked), 0)::float AS banked
          FROM app_daily_activity_reports report
          WHERE ${whereSql}`,
        values.slice(0, -2));
        const { rows } = await client.query(`
          SELECT report.*, stock.id AS stock_entry_id
          FROM app_daily_activity_reports report
          LEFT JOIN app_stock_entries stock ON stock.entry_no=report.stock_entry_number
          WHERE ${whereSql}
          ORDER BY report.date DESC, report.created_at DESC, report.id DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values);
        return { summary, rows };
      }), {lane:'ledger',label:'daily-activity'}), { scope: 'local-daily-activity' });
  const summary = {
    total: Number(result.summary.total || 0),
    sales: Number(result.summary.sales || 0),
    expense: Number(result.summary.expense || 0),
    banked: Number(result.summary.banked || 0),
  };
  return {
    source: 'local',
    basePath: '/reports/daily-activity',
    filters,
    summary,
    rows: result.rows.map(displayRow),
    pagination: {
      page: filters.page,
      limit: 50,
      total: summary.total,
      total_pages: Math.max(1, Math.ceil(summary.total / 50)),
      offset,
      start: summary.total ? offset + 1 : 0,
      end: Math.min(offset + 50, summary.total),
    },
  };
}
async function localDailyActivityVoucher(name, user) {
  if (!/^DAR-\d{6,}$/.test(name || '')) return null;
  const { rows } = await getPostgresPool().query(`SELECT report.*, stock.id AS stock_entry_id
    FROM app_daily_activity_reports report
    LEFT JOIN app_stock_entries stock ON stock.entry_no=report.stock_entry_number
    WHERE report.name=$1`, [name]);
  return rows[0] && recordAllowed(user, rows[0]) ? displayRow(rows[0]) : null;
}
module.exports = { localDailyActivityReport, localDailyActivityVoucher };
