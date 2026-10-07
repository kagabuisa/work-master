'use strict';

async function validateCostCenter(client, value) {
  const costCenter = String(value || '').trim() || null;
  if (!costCenter) return null;
  const { rows } = await client.query(`SELECT 1 FROM app_master_cost_centers
    WHERE cost_center = $1 AND disabled = false AND is_group = false LIMIT 1`, [costCenter]);
  if (!rows.length) {
    const err = new Error('Select an enabled cost center.');
    err.status = 400;
    throw err;
  }
  return costCenter;
}

module.exports = { validateCostCenter };
