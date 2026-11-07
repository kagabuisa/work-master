'use strict';

const { isValidIsoDate } = require('../lib/dates');
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { validateCostCenter } = require('../cost-centers');
const { allowedNamedListValues, deniedNamedListValues, warehouseAllowed, assignedMasterRecordAllowed } = require('../access');
const { runWithAuditUser } = require('../audit');
const { sqlLikePattern } = require('../lib/search');
const { STOCK_ENTRY_TYPE_LABELS } = require('../constants');
const UNIT_TYPES = ['Shop', 'Field Sales(FiSa)'];
const DELIVERY_OPTIONS = ['No', 'Yes - Fill out a Delivery Difference Report - DDR'];
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function draft(input = {}) {
  function text(key, label, required = false, limit = 4000) {
    if (typeof input[key] !== 'string' && input[key] !== undefined) invalid(`Enter a valid ${label}.`);
    const value = String(input[key] || '').trim();
    if (required && !value) invalid(`${label} is required.`);
    if (value.length > limit) invalid(`${label} is too long.`);
    return value;
  }
  function number(key, label, integer = false) {
    const raw = text(key, label, true, 40);
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || ['sales', 'expense'].includes(key) && !/^\d+(\.\d{1,2})?$/.test(raw) || !Number.isFinite(value) || value > 999999999999
      || integer && !Number.isSafeInteger(value)) invalid(`Enter a valid non-negative ${label}.`);
    return value;
  }
  const date = text('date', 'Date', true, 10);
  if (!isValidIsoDate(date)) invalid('Enter a valid date.');
  const unit_type = text('unit_type', 'Unit type', true, 40);
  if (!UNIT_TYPES.includes(unit_type)) invalid('Choose a valid unit type.');
  const differences = text('delivery_differences', 'Delivery differences', true, 100);
  if (!DELIVERY_OPTIONS.includes(differences)) invalid('Choose a valid delivery differences option.');
  const sales = number('sales', 'sales amount');
  const expense = number('expense', 'expense amount');
  return { docstatus: 0,
    date, shop: text('shop', 'Shop/Unit', true, 140), warehouse: text('warehouse', 'Warehouse', true, 140),
    unit_type, sales, expense, banked: sales - expense,
    expense_details: text('expense_details', 'Expense details', true),
    packages_received: number('packages_received', 'packages received', true),
    delivery_differences: differences,
    leads: unit_type === 'Field Sales(FiSa)' ? number('leads', 'leads') : 0,
    stock_entry_number: text('stock_entry_number', 'Stock entry', false, 140),
    item_differences: text('item_differences', 'Item differences'),
    remarks: text('remarks', 'Market information'), comments_or_remarks: text('comments_or_remarks', 'Comments'),
  };
}
function recordAllowed(user, record) {
  return warehouseAllowed(user, record.warehouse)
    && assignedMasterRecordAllowed(user, 'cost-centers', record.shop);
}

async function createDailyActivity(input, user) {
  const doc = draft(input);
  if (!recordAllowed(user, doc)) throw Object.assign(new Error('Choose a permitted shop and warehouse.'), { status: 403 });
  return runWithAuditUser(user, () => withPostgresTransaction(async (client) => {
    await validateCostCenter(client, doc.shop);
    const warehouse = await client.query('SELECT 1 FROM app_master_warehouses WHERE warehouse=$1 AND disabled=false AND is_group=false FOR SHARE', [doc.warehouse]);
    if (!warehouse.rowCount) invalid('Select an enabled warehouse.');
    if (doc.stock_entry_number) {
      const stock = await client.query(`SELECT 1 FROM app_stock_entries entry
        JOIN app_stock_entry_items line ON line.stock_entry_id=entry.id
        WHERE entry.entry_no=$1 AND (line.warehouse=$2 OR line.target_warehouse=$2)
          AND COALESCE(entry.docstatus, 'submitted')='submitted' LIMIT 1`,
      [doc.stock_entry_number, doc.warehouse]);
      if (!stock.rowCount) invalid('Select a submitted stock entry that includes this warehouse, or leave Stock entry number blank.');
    }
    const keys = Object.keys(doc).filter(key => key !== 'banked');
    const { rows } = await client.query(`INSERT INTO app_daily_activity_reports (${keys.join(',')})
      VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, keys.map(key => doc[key]));
    return rows[0];
  }));
}

async function dailyActivityFormOptions(user) {
  const pool = getPostgresPool();
  const [shops, warehouses] = await Promise.all([
    pool.query('SELECT cost_center AS name FROM app_master_cost_centers WHERE disabled=false AND is_group=false ORDER BY cost_center'),
    pool.query('SELECT warehouse AS name FROM app_master_warehouses WHERE disabled=false AND is_group=false ORDER BY warehouse'),
  ]);
  return { shops: shops.rows.map(row => row.name).filter(name => assignedMasterRecordAllowed(user, 'cost-centers', name)),
    warehouses: warehouses.rows.map(row => row.name).filter(name => warehouseAllowed(user, name)) };
}

async function dailyActivityStockEntryOptions(filters = {}, user, pool) {
  const warehouse = String(filters.warehouse || '').trim().slice(0, 140);
  if (!warehouse) return [];
  if (!warehouseAllowed(user, warehouse)) {
    throw Object.assign(new Error('Choose a permitted warehouse.'), { status: 403 });
  }
  const search = String(filters.q || '').trim().slice(0, 140);
  const params = [warehouse];
  const where = [
    `COALESCE(entry.docstatus, 'submitted')='submitted'`,
    `entry.entry_no IS NOT NULL`,
    `EXISTS (SELECT 1 FROM app_stock_entry_items selected_line
      WHERE selected_line.stock_entry_id=entry.id
        AND (selected_line.warehouse=$1 OR selected_line.target_warehouse=$1))`,
  ];
  if (search) {
    params.push(sqlLikePattern(search.toLowerCase()));
    where.push(`(LOWER(entry.entry_no) LIKE $${params.length}
      OR LOWER(entry.entry_type) LIKE $${params.length}
      OR LOWER(COALESCE(entry.remarks, '')) LIKE $${params.length}
      OR entry.posting_date::text LIKE $${params.length})`);
  }
  const allowedWarehouses = allowedNamedListValues(user, 'warehouses');
  if (allowedWarehouses !== null) {
    params.push(allowedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_stock_entry_items scoped_line
      WHERE scoped_line.stock_entry_id=entry.id AND (
        NULLIF(scoped_line.warehouse, '') IS NOT NULL AND scoped_line.warehouse <> ALL($${params.length}::text[])
        OR NULLIF(scoped_line.target_warehouse, '') IS NOT NULL AND scoped_line.target_warehouse <> ALL($${params.length}::text[])
      ))`);
  }
  const deniedWarehouses = deniedNamedListValues(user, 'warehouses');
  if (deniedWarehouses.length) {
    params.push(deniedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_stock_entry_items denied_line
      WHERE denied_line.stock_entry_id=entry.id AND (
        denied_line.warehouse = ANY($${params.length}::text[])
        OR denied_line.target_warehouse = ANY($${params.length}::text[])
      ))`);
  }
  const { rows } = await (pool || getPostgresPool()).query(`
    SELECT entry.id, entry.entry_no, entry.entry_type, entry.posting_date::text
    FROM app_stock_entries entry
    WHERE ${where.join(' AND ')}
    ORDER BY entry.posting_date DESC, entry.posting_time DESC, entry.id DESC
    LIMIT 25`, params);
  return rows.map((row) => {
    const type = STOCK_ENTRY_TYPE_LABELS[row.entry_type] || row.entry_type;
    return {
      id: Number(row.id),
      value: row.entry_no,
      entry_no: row.entry_no,
      posting_date: row.posting_date,
      entry_type: row.entry_type,
      label: [row.posting_date, type].filter(Boolean).join(' · '),
      href: `/stock/entries/${encodeURIComponent(row.id)}`,
    };
  });
}

module.exports = { draft, createDailyActivity, dailyActivityFormOptions, dailyActivityStockEntryOptions,
  recordAllowed, UNIT_TYPES, DELIVERY_OPTIONS };
