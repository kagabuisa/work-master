const { pool: mysqlPool } = require('./db');
const { getPostgresPool } = require('./store');

function mapPriceList(row) {
  const priceList = String(row.name || '').trim();
  const currency = String(row.currency || '').trim().toUpperCase();
  if (!priceList || priceList.length > 140 || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid ERPNext price list: ${row.name}`);
  }
  const buying = Number(row.buying) === 1;
  const selling = Number(row.selling) === 1;
  const sourceType = String(row.pricelist_type || '').trim();
  if (!buying && !selling) throw new Error(`ERPNext price list has no buying or selling type: ${priceList}`);
  return {
    priceList,
    currency,
    priceType: buying && selling ? 'both' : buying ? 'buying' : 'selling',
    pricelistType: ['Retail', 'Wholesale', 'Distribution'].includes(sourceType) ? sourceType : null,
    active: Number(row.enabled) === 1 ? 1 : 0,
  };
}

async function importPriceListsFromMysql() {
  const [sourceRows] = await mysqlPool.query(`
    SELECT name, currency, enabled, buying, selling, pricelist_type
    FROM \`tabPrice List\`
    ORDER BY name
  `);
  const records = sourceRows.map(mapPriceList);
  const client = await getPostgresPool().connect();
  let inserted = 0;
  let typesUpdated = 0;
  try {
    await client.query('BEGIN');
    for (const record of records) {
      const result = await client.query(`
        INSERT INTO app_master_price_lists
          (price_list, currency, price_type, pricelist_type, active, docstatus, legacy_editable)
        VALUES ($1, $2, $3, $4, $5, 'submitted', true)
        ON CONFLICT DO NOTHING
      `, [record.priceList, record.currency, record.priceType, record.pricelistType, record.active]);
      inserted += result.rowCount;
      if (!result.rowCount && record.pricelistType) {
        const update = await client.query(`UPDATE app_master_price_lists
          SET pricelist_type = $2, updated_at = now()
          WHERE price_list = $1 AND pricelist_type IS NULL`, [record.priceList, record.pricelistType]);
        typesUpdated += update.rowCount;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { source_rows: records.length, imported: inserted, already_present: records.length - inserted, types_updated: typesUpdated };
}

module.exports = { mapPriceList, importPriceListsFromMysql };
