'use strict';

const { getPostgresPool } = require('./core');

const FIELDS = ['warehouse', 'cost_center', 'employee_id', 'retail_price_list', 'wholesale_price_list'];

async function recordAccessChoices() {
  const pool = getPostgresPool();
  const [warehouses, costCenters, employees, priceLists] = await Promise.all([
    pool.query('SELECT warehouse FROM app_master_warehouses WHERE is_group = false ORDER BY warehouse'),
    pool.query('SELECT cost_center, cost_center_name FROM app_master_cost_centers WHERE is_group = false ORDER BY cost_center_name, cost_center'),
    pool.query('SELECT employee_id, employee_name FROM app_master_employees ORDER BY employee_name, employee_id'),
    pool.query(`SELECT price_list, pricelist_type FROM app_master_price_lists
      WHERE pricelist_type IN ('Retail', 'Wholesale') AND currency = 'UGX'
        AND price_type IN ('selling', 'both') ORDER BY price_list`),
  ]);
  return {
    warehouse: warehouses.rows.map((row) => ({ id: row.warehouse, label: row.warehouse })),
    cost_center: costCenters.rows.map((row) => ({ id: row.cost_center,
      label: row.cost_center_name || row.cost_center })),
    employee_id: employees.rows.map((row) => ({ id: row.employee_id,
      label: `${row.employee_name} · ${row.employee_id}` })),
    retail_price_list: priceLists.rows.filter((row) => row.pricelist_type === 'Retail')
      .map((row) => ({ id: row.price_list, label: row.price_list })),
    wholesale_price_list: priceLists.rows.filter((row) => row.pricelist_type === 'Wholesale')
      .map((row) => ({ id: row.price_list, label: row.price_list })),
  };
}

function selectedLabels(access = {}, choices = {}) {
  return Object.fromEntries(FIELDS.map((field) => [field,
    choices[field]?.find((choice) => choice.id === access[field])?.label || access[field] || '']));
}

function validateRecordAccess(input = {}, choices) {
  const selected = {};
  const labels = { warehouse: 'warehouse', cost_center: 'cost center', employee_id: 'employee',
    retail_price_list: 'retail price list', wholesale_price_list: 'wholesale price list' };
  for (const field of FIELDS) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 300)) {
      const error = new Error(`Choose a valid ${labels[field]}.`); error.status = 400; throw error;
    }
    const text = String(value || '').trim();
    if (!text) continue;
    const match = choices[field].find((choice) => choice.label === text);
    if (!match) {
      const error = new Error(`Choose a ${labels[field]} from the suggestions.`);
      error.status = 400;
      throw error;
    }
    selected[field] = match.id;
  }
  return selected;
}

function defaultRecordPermissions(access = {}) {
  return [
    access.warehouse && `warehouse.view:${access.warehouse}`,
    access.cost_center && `cost-center.view:${access.cost_center}`,
    access.employee_id && `employee.view:${access.employee_id}`,
    access.retail_price_list && `invoice.price-list.view:${access.retail_price_list}`,
    access.wholesale_price_list && `invoice.price-list.view:${access.wholesale_price_list}`,
  ].filter(Boolean);
}

module.exports = { recordAccessChoices, selectedLabels, validateRecordAccess, defaultRecordPermissions };
