const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function textValue(value) {
  return String(value || '').trim();
}

async function importWarehouses() {
  await initStore();
  const [warehouses] = await pool.query(`
    SELECT
      name AS warehouse,
      warehouse_type,
      COALESCE(disabled, 0) AS disabled
    FROM \`tabWarehouse\`
    WHERE COALESCE(disabled, 0) = 0
    ORDER BY name
  `);

  let imported = 0;
  for (const warehouse of warehouses) {
    await updateMasterRecord('warehouses', warehouse.warehouse, {
      warehouse: warehouse.warehouse,
      warehouse_type: textValue(warehouse.warehouse_type),
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
      table: 'public.app_master_warehouses',
    },
    mysql_rows: warehouses.length,
    imported,
  }, null, 2));
}

importWarehouses()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
