'use strict';

require('dotenv').config({ quiet: true });
const { pool: mysql } = require('../src/db');
const { initStore, getPostgresPool, closeStore } = require('../src/store');

function sourceValue(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'local') return 'Local';
  if (source === 'import') return 'Import';
  return null;
}

async function main() {
  const [items] = await mysql.query(`SELECT name AS item_code,
    COALESCE(NULLIF(category, ''), NULLIF(item_group, '')) AS item_category,
    source, COALESCE(cost, last_purchase_rate, 0) AS cost FROM \`tabItem\``);
  await initStore();
  const pg = getPostgresPool();
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const codes = items.map((item) => item.item_code);
    const categories = items.map((item) => item.item_category || null);
    const sources = items.map((item) => sourceValue(item.source));
    const costs = items.map((item) => Number(item.cost || 0));
    const updated = await client.query(`WITH erpnext AS (
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::numeric[])
        AS value(item_code, item_category, source, cost)
    )
    UPDATE app_master_items item SET category = erpnext.item_category,
      source = erpnext.source, unit_cost = erpnext.cost, updated_at = now()
    FROM erpnext WHERE item.item_code = erpnext.item_code
      AND (item.category, item.source, item.unit_cost)
        IS DISTINCT FROM (erpnext.item_category, erpnext.source, erpnext.cost)`,
    [codes, categories, sources, costs]);
    const invoiceRows = await client.query(`UPDATE app_invoice_items line SET
      item_category = item.category, source = item.source, cost = item.unit_cost
      FROM app_master_items item WHERE line.item_code = item.item_code
        AND (line.item_category, line.source, line.cost)
          IS DISTINCT FROM (item.category, item.source, item.unit_cost)`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ erpnext_items: items.length,
      master_items_updated: updated.rowCount, invoice_lines_updated: invoiceRows.rowCount }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await mysql.end();
  await closeStore();
});
