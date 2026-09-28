const { pool: mysqlPool } = require('./db');
const { getPostgresPool } = require('./store');

const NUMBER_FIELDS = ['cost', 'unit_cost', 'new_price', 'old_price', 'margin',
  'stock_balance', 'incarton', 'carton_price', 'dealer_price', 'promo_rate', 'promo_qty'];
const DATE_FIELDS = ['price_update_on', 'promo_start_date', 'promo_expiry_date'];
const PRICE_COLUMNS = [
  ['erpnext_name', 'text'], ['item_code', 'text'], ['price_list', 'text'],
  ['price_list_rate', 'numeric(18,6)'], ['active', 'smallint'],
  ['item_name', 'text'], ['item_description', 'text'], ['currency', 'text'],
  ['buying', 'smallint'], ['selling', 'smallint'], ['price_type', 'text'], ['erpnext_type', 'integer'], ['cost_center', 'text'],
  ...NUMBER_FIELDS.slice(0, 4).map((name) => [name, 'numeric(18,6)']),
  ['item_category', 'text'],
  ...NUMBER_FIELDS.slice(4, 7).map((name) => [name, 'numeric(18,6)']),
  ['price_update', 'text'], ['price_update_on', 'date'],
  ...NUMBER_FIELDS.slice(7, 9).map((name) => [name, 'numeric(18,6)']),
  ['promo_start_date', 'date'], ['promo_expiry_date', 'date'],
  ['promo_warehouse', 'text'], ['promo_customer', 'text'], ['warehouse_type', 'text'],
  ...NUMBER_FIELDS.slice(9).map((name) => [name, 'numeric(18,6)']),
  ['erpnext_created_at', 'timestamptz'], ['erpnext_modified_at', 'timestamptz'],
  ['erpnext_owner', 'text'], ['erpnext_modified_by', 'text'],
];

function sourceDate(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function sourceTimestamp(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function sourceDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function mapItemPrice(row, active) {
  const mapped = {
    erpnext_name: String(row.name || '').trim(),
    item_code: String(row.item_code || '').trim(),
    price_list: String(row.price_list || '').trim(),
    price_list_rate: sourceDecimal(row.price_list_rate),
    active: active ? 1 : 0,
    item_name: row.item_name || null,
    item_description: row.item_description || null,
    currency: row.currency || null,
    buying: Number(row.buying) === 1 ? 1 : 0,
    selling: Number(row.selling) === 1 ? 1 : 0,
    price_type: row.price_type || null,
    erpnext_type: row.type == null ? null : Number(row.type),
    cost_center: row.cost_center || null,
    item_category: row.item_category || null,
    price_update: row.price_update || null,
    promo_warehouse: row.promo_warehouse || null,
    promo_customer: row.promo_customer || null,
    warehouse_type: row.warehouse_type || null,
    erpnext_created_at: sourceTimestamp(row.creation),
    erpnext_modified_at: sourceTimestamp(row.modified),
    erpnext_owner: row.owner || null,
    erpnext_modified_by: row.modified_by || null,
  };
  for (const field of NUMBER_FIELDS) mapped[field] = sourceDecimal(row[field]);
  for (const field of DATE_FIELDS) mapped[field] = sourceDate(row[field]);
  if (!mapped.erpnext_name || !mapped.item_code || !mapped.price_list
    || !/^\d{1,12}(\.\d{1,6})?$/.test(mapped.price_list_rate || '')) return null;
  return mapped;
}

async function sourceItemPrices(priceLists) {
  const decimalFields = ['price_list_rate', ...NUMBER_FIELDS];
  const fields = ['name', 'item_code', 'item_name', 'item_description', 'price_list', 'currency',
    'buying', 'selling', 'price_type', 'type', 'cost_center', 'item_category', 'price_update',
    'promo_warehouse', 'promo_customer', 'warehouse_type', 'creation', 'modified', 'owner', 'modified_by',
    ...decimalFields.map((name) => `CAST(\`${name}\` AS CHAR) AS \`${name}\``),
    ...DATE_FIELDS.map((name) => `DATE_FORMAT(\`${name}\`, '%Y-%m-%d') AS \`${name}\``)];
  const [rows] = await mysqlPool.query(`SELECT ${fields.join(', ')} FROM \`tabItem Price\`
    WHERE price_list IN (?) AND docstatus <> 2 ORDER BY modified DESC, name DESC`, [priceLists]);
  return rows;
}

async function sourceMissingItems(itemCodes) {
  if (!itemCodes.length) return [];
  const [rows] = await mysqlPool.query(`SELECT name AS item_code, item_name, stock_uom,
    COALESCE(NULLIF(category, ''), NULLIF(item_group, '')) AS category, description,
    CAST(COALESCE(rrp, rwp, cost, last_purchase_rate, 0) AS CHAR) AS default_rate,
    CAST(COALESCE(cost, last_purchase_rate, 0) AS CHAR) AS unit_cost,
    is_sales_item, is_purchase_item, disabled
    FROM \`tabItem\` WHERE name IN (?)`, [itemCodes]);
  return rows;
}

async function importItemPricesFromMysql({ dryRun = false, batchSize = 500, onProgress = () => {} } = {}) {
  const pool = getPostgresPool();
  const lists = (await pool.query('SELECT price_list, currency FROM app_master_price_lists WHERE active = 1')).rows;
  if (!lists.length) return { active_price_lists: 0, source_rows: 0, imported: 0 };
  const listByName = new Map(lists.map((row) => [row.price_list, row]));
  const sourceRows = await sourceItemPrices([...listByName.keys()]);
  const existingItems = new Set((await pool.query('SELECT item_code FROM app_master_items')).rows.map((row) => row.item_code));
  const missingCodes = [...new Set(sourceRows.map((row) => String(row.item_code || '').trim()).filter((code) => code && !existingItems.has(code)))];
  const missingItems = await sourceMissingItems(missingCodes);
  const sourceItems = new Map(missingItems.map((row) => [row.item_code, row]));
  const existingPrices = (await pool.query('SELECT erpnext_name, price_list, item_code, active FROM app_master_item_prices')).rows;
  const knownNames = new Set(existingPrices.map((row) => row.erpnext_name).filter(Boolean));
  const activePairs = new Set(existingPrices.filter((row) => row.active === 1)
    .map((row) => `${row.price_list}\u0000${row.item_code}`));
  const candidates = [];
  const summary = {
    active_price_lists: lists.length, source_rows: sourceRows.length,
    missing_items_found: missingItems.length, missing_items_unavailable: missingCodes.length - missingItems.length,
    imported: 0, imported_active: 0, imported_inactive: 0, already_present: 0,
    skipped_missing_item: 0, skipped_currency_mismatch: 0, skipped_invalid: 0,
    dry_run: dryRun,
  };
  for (const row of sourceRows) {
    const itemCode = String(row.item_code || '').trim();
    if (!existingItems.has(itemCode) && !sourceItems.has(itemCode)) { summary.skipped_missing_item += 1; continue; }
    if (String(row.currency || '').toUpperCase() !== listByName.get(row.price_list)?.currency) {
      summary.skipped_currency_mismatch += 1; continue;
    }
    if (knownNames.has(row.name)) {
      summary.already_present += 1;
      continue;
    }
    const pair = `${row.price_list}\u0000${itemCode}`;
    const active = !activePairs.has(pair) && (existingItems.has(itemCode) || Number(sourceItems.get(itemCode)?.disabled) !== 1);
    const mapped = mapItemPrice(row, active);
    if (!mapped) { summary.skipped_invalid += 1; continue; }
    knownNames.add(mapped.erpnext_name);
    if (active) activePairs.add(pair);
    candidates.push(mapped);
    if (active) summary.imported_active += 1;
    else summary.imported_inactive += 1;
  }
  if (dryRun) { summary.imported = candidates.length; return summary; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of missingItems) {
      await client.query(`INSERT INTO app_master_items
        (item_code, item_name, stock_uom, category, description, default_rate, unit_cost,
          is_sales_item, is_purchase_item, disabled, docstatus, legacy_editable)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', true)
        ON CONFLICT (item_code) DO NOTHING`, [item.item_code, item.item_name || item.item_code,
        item.stock_uom || null, item.category || null, item.description || null,
        Math.round(Number(item.default_rate || 0)), Math.round(Number(item.unit_cost || 0)),
        Number(item.is_sales_item) === 1, Number(item.is_purchase_item) === 1,
        Number(item.disabled) === 1]);
    }
    const names = PRICE_COLUMNS.map(([name]) => name);
    const definitions = PRICE_COLUMNS.map(([name, type]) => `${name} ${type}`);
    const insertSql = `INSERT INTO app_master_item_prices (${names.join(', ')})
      SELECT ${names.map((name) => `source.${name}`).join(', ')}
      FROM jsonb_to_recordset($1::jsonb) AS source (${definitions.join(', ')})
      ON CONFLICT DO NOTHING`;
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const result = await client.query(insertSql, [JSON.stringify(batch)]);
      summary.imported += result.rowCount;
      onProgress({ processed: Math.min(offset + batch.length, candidates.length), total: candidates.length });
    }
    if (summary.imported !== candidates.length) throw new Error('A conflicting item price appeared during import; no rows were committed.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return summary;
}

module.exports = { mapItemPrice, importItemPricesFromMysql };
