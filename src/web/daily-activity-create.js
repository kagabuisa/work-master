'use strict';

const { isValidIsoDate } = require('../lib/dates');
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { validateCostCenter } = require('../cost-centers');
const { warehouseAllowed, assignedMasterRecordAllowed } = require('../access');
const { runWithAuditUser } = require('../audit');
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
        WHERE entry.entry_no=$1 AND line.warehouse=$2 AND entry.docstatus='submitted' LIMIT 1`,
      [doc.stock_entry_number, doc.warehouse]);
      if (!stock.rowCount) invalid('Select a submitted stock entry for this warehouse, or leave Stock entry number blank.');
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
module.exports = { draft, createDailyActivity, dailyActivityFormOptions, recordAllowed, UNIT_TYPES, DELIVERY_OPTIONS };
