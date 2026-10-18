'use strict';

const NAME_KEYS = [
  ['app_master_employees', 'employee_name', 'Employee'],
  ['app_master_cost_centers', 'cost_center_name', 'Cost center'],
  ['app_accounts', 'account_name', 'Account'],
];

async function ensureUniqueMasterNames(client) {
  for (const [table, column] of NAME_KEYS) {
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_${column}_unique
      ON ${table} (lower(btrim(${column})))`);
  }
}

function masterNameConflict(error) {
  if (error.code !== '23505') return false;
  const match = NAME_KEYS.find(([table, column]) => error.constraint === `${table}_${column}_unique`);
  if (!match) return false;
  error.status = 400;
  error.message = `${match[2]} name already exists. Choose a unique name.`;
  return true;
}

function costCenterLabels(rows) {
  const labels = new Map(rows.map(row => [row.cost_center, row.cost_center_name]));
  return id => labels.get(id) || id || '';
}

module.exports = { ensureUniqueMasterNames, masterNameConflict, costCenterLabels };
