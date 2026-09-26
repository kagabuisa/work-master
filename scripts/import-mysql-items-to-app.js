const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function money(value) {
  return Math.round(Number(value || 0));
}

function numeric(value) {
  return Number(value || 0);
}

function sourceValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'local') {
    return 'Local';
  }
  if (normalized === 'import') {
    return 'Import';
  }
  return '';
}

async function importItems() {
  await initStore();
  const [items] = await pool.query(`
    SELECT
      i.name AS item_code,
      i.item_name,
      i.stock_uom,
      COALESCE(NULLIF(i.category, ''), NULLIF(i.item_group, '')) AS category,
      i.description,
      COALESCE(price.price_list_rate, i.rrp, i.rwp, i.cost, i.last_purchase_rate, 0) AS default_rate,
      COALESCE(i.cost, i.last_purchase_rate, 0) AS unit_cost,
      i.qty_per_carton,
      i.cbm_per_carton,
      i.gross_weight,
      i.fob,
      i.import_supplier,
      i.source,
      COALESCE(i.disabled, 0) AS disabled
    FROM \`tabItem\` i
    LEFT JOIN (
      SELECT item_code, MAX(price_list_rate) AS price_list_rate
      FROM \`tabItem Price\`
      WHERE buying = 1 OR selling = 1
      GROUP BY item_code
    ) price ON price.item_code = i.name
    ORDER BY i.name
  `);

  let imported = 0;
  for (const item of items) {
    await updateMasterRecord('items', item.item_code, {
      item_name: item.item_name || item.item_code,
      stock_uom: item.stock_uom || '',
      category: item.category || '',
      description: item.description || '',
      default_rate: money(item.default_rate),
      unit_cost: money(item.unit_cost),
      markup: 0,
      qty_per_carton: numeric(item.qty_per_carton),
      cbm_per_carton: numeric(item.cbm_per_carton),
      weight_per_carton: numeric(item.gross_weight),
      import_fob: numeric(item.fob),
      exporter: item.import_supplier || '',
      source: sourceValue(item.source),
      photo_count_id: '',
      disabled: String(Number(item.disabled || 0) ? 1 : 0),
    });
    imported += 1;
  }

  console.log(JSON.stringify({
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      table: 'public.app_master_items',
    },
    mysql_rows: items.length,
    imported,
  }, null, 2));
}

importItems()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
