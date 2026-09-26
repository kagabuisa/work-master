const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function textValue(value) {
  return String(value || '').trim();
}

async function importCostCenters() {
  await initStore();
  const [costCenters] = await pool.query(`
    SELECT
      name AS cost_center,
      cost_center_name,
      parent_cost_center,
      company,
      cost_center_type,
      COALESCE(is_group, 0) AS is_group
    FROM \`tabCost Center\`
    ORDER BY cost_center_name, name
  `);

  let imported = 0;
  for (const costCenter of costCenters) {
    await updateMasterRecord('cost_centers', costCenter.cost_center, {
      cost_center_name: costCenter.cost_center_name || costCenter.cost_center,
      parent_cost_center: textValue(costCenter.parent_cost_center),
      company: textValue(costCenter.company),
      cost_center_type: textValue(costCenter.cost_center_type),
      is_group: String(Number(costCenter.is_group || 0) ? 1 : 0),
      disabled: '0',
    });
    imported += 1;
  }

  console.log(JSON.stringify({
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      table: 'public.app_master_cost_centers',
    },
    mysql_rows: costCenters.length,
    imported,
  }, null, 2));
}

importCostCenters()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
