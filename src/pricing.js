const TABLES = {
  'price-lists': ['app_master_price_lists', 'price_list'],
  'item-prices': ['app_master_item_prices', 'id'],
};
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const text = (value) => typeof value === 'string' ? value.trim() : '';
const ITEM_PRICE_TEXT_FIELDS = ['item_name', 'item_description', 'price_type', 'cost_center',
  'item_category', 'price_update', 'promo_warehouse', 'promo_customer', 'warehouse_type'];
const ITEM_PRICE_NUMBER_FIELDS = ['cost', 'unit_cost', 'new_price', 'old_price', 'margin',
  'stock_balance', 'incarton', 'carton_price', 'dealer_price', 'promo_rate', 'promo_qty'];
const ITEM_PRICE_DATE_FIELDS = ['price_update_on', 'promo_start_date', 'promo_expiry_date'];
function likePattern(value) {
  const pattern = value.replace(/[\\_]/g, '\\$&');
  return pattern.includes('%') ? pattern : `%${pattern}%`;
}

async function initPricingTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_price_lists (
      price_list TEXT PRIMARY KEY,
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      price_type TEXT NOT NULL CHECK (price_type IN ('selling', 'buying', 'both')),
      pricelist_type TEXT CHECK (pricelist_type IN ('Retail', 'Wholesale', 'Distribution')),
      active SMALLINT NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      legacy_editable BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_master_price_lists_name_idx ON app_master_price_lists (LOWER(price_list));
    ALTER TABLE app_master_price_lists ADD COLUMN IF NOT EXISTS pricelist_type TEXT
      CHECK (pricelist_type IN ('Retail', 'Wholesale', 'Distribution'));
    ALTER TABLE app_master_price_lists ADD COLUMN IF NOT EXISTS active SMALLINT NOT NULL DEFAULT 0
      CHECK (active IN (0, 1));
    ALTER TABLE app_master_price_lists ALTER COLUMN docstatus SET DEFAULT 'submitted';
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'app_master_price_lists' AND column_name = 'disabled'
      ) THEN
        EXECUTE 'UPDATE app_master_price_lists SET active = CASE WHEN docstatus = ''submitted'' AND NOT disabled THEN 1 ELSE 0 END';
        EXECUTE 'ALTER TABLE app_master_price_lists DROP COLUMN disabled';
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS app_master_item_prices (
      id BIGSERIAL PRIMARY KEY,
      item_code TEXT NOT NULL REFERENCES app_master_items(item_code),
      price_list TEXT NOT NULL REFERENCES app_master_price_lists(price_list),
      price_list_rate NUMERIC(18, 6) NOT NULL CHECK (price_list_rate >= 0),
      item_name TEXT,
      item_description TEXT,
      currency TEXT,
      buying SMALLINT CHECK (buying IN (0, 1)),
      selling SMALLINT CHECK (selling IN (0, 1)),
      price_type TEXT,
      erpnext_type INTEGER,
      cost_center TEXT,
      cost NUMERIC(18, 6),
      unit_cost NUMERIC(18, 6),
      new_price NUMERIC(18, 6),
      old_price NUMERIC(18, 6),
      item_category TEXT,
      margin NUMERIC(18, 6),
      stock_balance NUMERIC(18, 6),
      incarton NUMERIC(18, 6),
      price_update TEXT,
      price_update_on DATE,
      carton_price NUMERIC(18, 6),
      dealer_price NUMERIC(18, 6),
      promo_start_date DATE,
      promo_expiry_date DATE,
      promo_warehouse TEXT,
      promo_customer TEXT,
      warehouse_type TEXT,
      promo_rate NUMERIC(18, 6),
      promo_qty NUMERIC(18, 6),
      erpnext_name TEXT,
      erpnext_created_at TIMESTAMPTZ,
      erpnext_modified_at TIMESTAMPTZ,
      erpnext_owner TEXT,
      erpnext_modified_by TEXT,
      active SMALLINT NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      legacy_editable BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE app_master_item_prices ADD COLUMN IF NOT EXISTS active SMALLINT NOT NULL DEFAULT 0
      CHECK (active IN (0, 1));
    ALTER TABLE app_master_item_prices ALTER COLUMN price_list_rate TYPE NUMERIC(18, 6);
    ALTER TABLE app_master_item_prices ALTER COLUMN docstatus SET DEFAULT 'submitted';
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'app_master_item_prices' AND column_name = 'disabled') THEN
        EXECUTE 'UPDATE app_master_item_prices SET active = CASE WHEN docstatus = ''submitted'' AND NOT disabled THEN 1 ELSE 0 END';
        EXECUTE 'ALTER TABLE app_master_item_prices DROP COLUMN disabled';
      END IF;
    END $$;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
        AND indexname = 'app_master_item_prices_active_idx' AND indexdef LIKE '%docstatus%') THEN
        DROP INDEX app_master_item_prices_active_idx;
      END IF;
    END $$;
    UPDATE app_master_item_prices SET docstatus = 'submitted' WHERE docstatus IN ('draft', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS app_master_item_prices_active_idx
      ON app_master_item_prices (price_list, item_code) WHERE active = 1;
  `);
  const extraColumns = {
    item_name: 'TEXT', item_description: 'TEXT', currency: 'TEXT',
    buying: 'SMALLINT', selling: 'SMALLINT', price_type: 'TEXT', erpnext_type: 'INTEGER', cost_center: 'TEXT',
    cost: 'NUMERIC(18, 6)', unit_cost: 'NUMERIC(18, 6)', new_price: 'NUMERIC(18, 6)',
    old_price: 'NUMERIC(18, 6)', item_category: 'TEXT', margin: 'NUMERIC(18, 6)',
    stock_balance: 'NUMERIC(18, 6)', incarton: 'NUMERIC(18, 6)', price_update: 'TEXT',
    price_update_on: 'DATE', carton_price: 'NUMERIC(18, 6)', dealer_price: 'NUMERIC(18, 6)',
    promo_start_date: 'DATE', promo_expiry_date: 'DATE', promo_warehouse: 'TEXT', warehouse_type: 'TEXT',
    promo_customer: 'TEXT', promo_rate: 'NUMERIC(18, 6)', promo_qty: 'NUMERIC(18, 6)',
    erpnext_name: 'TEXT', erpnext_created_at: 'TIMESTAMPTZ', erpnext_modified_at: 'TIMESTAMPTZ',
    erpnext_owner: 'TEXT', erpnext_modified_by: 'TEXT',
  };
  for (const [column, type] of Object.entries(extraColumns)) {
    await pool.query(`ALTER TABLE app_master_item_prices ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_master_item_prices_erpnext_name_idx
    ON app_master_item_prices (erpnext_name) WHERE erpnext_name IS NOT NULL`);
}

function normalizePricingRecord(kind, payload) {
  if (kind === 'price-lists') {
    const price_list = text(payload.price_list);
    const currency = text(payload.currency).toUpperCase();
    const price_type = text(payload.price_type);
    const pricelist_type = text(payload.pricelist_type);
    if (!price_list || price_list.length > 140) fail('Enter a price list name of 1–140 characters.');
    if (!/^[A-Z]{3}$/.test(currency)) fail('Enter a three-letter currency code, such as UGX.');
    if (!['selling', 'buying', 'both'].includes(price_type)) fail('Choose Selling, Buying, or Buying and Selling.');
    if (!['Retail', 'Wholesale', 'Distribution'].includes(pricelist_type)) {
      fail('Choose Retail, Wholesale, or Distribution for Pricelist Type.');
    }
    return { price_list, currency, price_type, pricelist_type };
  }
  if (kind !== 'item-prices') fail('Unknown pricing list.', 404);
  const item_code = text(payload.item_code);
  const price_list = text(payload.price_list);
  const rawRate = text(payload.price_list_rate);
  if (!item_code) fail('Select an item.');
  if (!price_list) fail('Select a price list.');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(rawRate)) {
    fail('Enter a non-negative rate with up to six decimal places.');
  }
  const record = { item_code, price_list, price_list_rate: rawRate };
  for (const field of ITEM_PRICE_TEXT_FIELDS) record[field] = text(payload[field]) || null;
  const currency = text(payload.currency).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail('Enter a three-letter currency code.');
  record.currency = currency || null;
  for (const field of ['buying', 'selling']) {
    const value = String(payload[field] ?? '').trim();
    if (value && !['0', '1'].includes(value)) fail(`Choose a valid ${field} value.`);
    record[field] = value ? Number(value) : null;
  }
  for (const field of ITEM_PRICE_NUMBER_FIELDS) {
    const value = String(payload[field] ?? '').trim();
    if (value && !/^-?\d{1,12}(\.\d{1,6})?$/.test(value)) fail(`Enter a valid ${field.replaceAll('_', ' ')}.`);
    record[field] = value || null;
  }
  for (const field of ITEM_PRICE_DATE_FIELDS) {
    const value = text(payload[field]);
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`Choose a valid ${field.replaceAll('_', ' ')}.`);
    record[field] = value || null;
  }
  if (record.promo_start_date && record.promo_expiry_date && record.promo_expiry_date < record.promo_start_date) {
    fail('Promotion expiry date cannot be before the start date.');
  }
  return record;
}

async function listPricingRecords(pool, kind, options, pagination) {
  const isList = kind === 'price-lists';
  if (!TABLES[kind]) fail('Unknown pricing list.', 404);
  const from = isList ? 'app_master_price_lists p' : `app_master_item_prices p
    JOIN app_master_price_lists l ON l.price_list = p.price_list
    JOIN app_master_items i ON i.item_code = p.item_code`;
  const fields = isList ? `p.*, CASE WHEN p.price_type = 'both' THEN 'Buying and Selling' ELSE INITCAP(p.price_type) END AS type_label`
    : 'p.*, COALESCE(p.currency, l.currency) AS currency, COALESCE(p.item_name, i.item_name) AS item_name, i.stock_uom';
  const where = options.includeDisabled ? [] : isList
    ? ["p.docstatus = 'submitted'", 'p.active = 1']
    : ["p.docstatus = 'submitted'", 'p.active = 1'];
  if (isList && ['selling', 'buying'].includes(options.priceType)) {
    where.push(`p.price_type IN ('${options.priceType}', 'both')`);
  }
  if (isList && options.currency === 'UGX') where.push("p.currency = 'UGX'");
  if (!isList && !options.includeDisabled) where.push("l.docstatus = 'submitted'", 'l.active = 1', "i.docstatus = 'submitted'", 'i.disabled = false');
  const params = [];
  if (Array.isArray(options.allowedPriceLists)) {
    params.push(options.allowedPriceLists);
    where.push(`p.price_list = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedPriceLists) && options.deniedPriceLists.length) {
    params.push(options.deniedPriceLists);
    where.push(`p.price_list <> ALL($${params.length}::text[])`);
  }
  const priceList = !isList ? text(options.priceList) : '';
  if (priceList) {
    if (options.priceListExact !== false) {
      params.push(priceList);
      where.push(`p.price_list = $${params.length}`);
    } else {
      params.push(likePattern(priceList));
      where.push(`LOWER(p.price_list) LIKE LOWER($${params.length})`);
    }
  }
  const itemCode = !isList ? text(options.itemCode) : '';
  if (itemCode) {
    params.push(options.itemCodeExact === false ? likePattern(itemCode) : itemCode);
    where.push(options.itemCodeExact === false
      ? `LOWER(p.item_code) LIKE LOWER($${params.length})` : `p.item_code = $${params.length}`);
  }
  const search = text(options.search).toLowerCase();
  if (search) {
    params.push(likePattern(search));
    const searchParam = `$${params.length}`;
    where.push(isList ? `(LOWER(p.price_list) LIKE ${searchParam} OR LOWER(p.currency) LIKE ${searchParam} OR LOWER(p.price_type) LIKE ${searchParam})`
      : `(LOWER(p.item_code) LIKE ${searchParam} OR LOWER(i.item_name) LIKE ${searchParam} OR LOWER(p.price_list) LIKE ${searchParam})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let total;
  if (options.paginate) total = (await pool.query(`SELECT COUNT(*)::int AS total FROM ${from} ${whereSql}`, params)).rows[0].total;
  params.push(pagination.limit, pagination.offset);
  const { rows } = await pool.query(`SELECT ${fields} FROM ${from} ${whereSql}
    ORDER BY ${isList ? 'p.price_list' : 'p.price_list, p.item_code, p.id'}
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total };
}

async function listItemPricePriceLists(pool) {
  const { rows } = await pool.query('SELECT price_list FROM app_master_price_lists ORDER BY price_list');
  return rows.map((row) => row.price_list);
}

async function listItemPriceCodes(pool, { search = '', priceList = '', priceListExact = true, limit = 20 } = {}) {
  const where = [];
  const params = [];
  const list = text(priceList);
  if (list) {
    params.push(priceListExact ? list : likePattern(list));
    where.push(priceListExact ? `price_list = $${params.length}` : `LOWER(price_list) LIKE LOWER($${params.length})`);
  }
  const code = text(search);
  if (code) {
    params.push(likePattern(code));
    where.push(`LOWER(item_code) LIKE LOWER($${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 50));
  const { rows } = await pool.query(`SELECT DISTINCT item_code FROM app_master_item_prices
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY item_code LIMIT $${params.length}`, params);
  return rows.map((row) => row.item_code);
}

async function findPricingRecord(pool, kind, id) {
  const fields = TABLES[kind];
  if (!fields) fail('Unknown pricing list.', 404);
  if (kind === 'item-prices' && !/^\d+$/.test(String(id))) return null;
  const dateFields = kind === 'item-prices'
    ? ', price_update_on::text AS price_update_on, promo_start_date::text AS promo_start_date, promo_expiry_date::text AS promo_expiry_date, erpnext_created_at::text AS erpnext_created_at, erpnext_modified_at::text AS erpnext_modified_at' : '';
  return (await pool.query(`SELECT *${dateFields} FROM ${fields[0]} WHERE ${fields[1]} = $1`, [id])).rows[0] || null;
}

async function findPriceListNeighbors(pool, id) {
  const [previous, next] = await Promise.all([
    pool.query('SELECT price_list FROM app_master_price_lists WHERE price_list < $1 ORDER BY price_list DESC LIMIT 1', [id]),
    pool.query('SELECT price_list FROM app_master_price_lists WHERE price_list > $1 ORDER BY price_list ASC LIMIT 1', [id]),
  ]);
  return { previous: previous.rows[0]?.price_list || null, next: next.rows[0]?.price_list || null };
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      fail(error.constraint === 'app_master_item_prices_active_idx'
        ? 'An active price already exists for this item and price list.'
        : 'This price list name already exists.');
    }
    throw error;
  } finally { client.release(); }
}

async function validateReferences(client, record) {
  const list = (await client.query(`SELECT currency, price_type FROM app_master_price_lists
    WHERE price_list = $1 AND docstatus = 'submitted' AND active = 1 FOR SHARE`, [record.price_list])).rows[0];
  if (!list) fail('Choose an active price list.');
  const item = (await client.query(`SELECT item_code, item_name, description FROM app_master_items
    WHERE item_code = $1 AND docstatus = 'submitted' AND disabled = false FOR SHARE`, [record.item_code])).rows[0];
  if (!item) fail('Choose an active, submitted item.');
  return { list, item };
}

async function validateExistingReferences(client, record) {
  const list = (await client.query('SELECT currency, price_type FROM app_master_price_lists WHERE price_list = $1', [record.price_list])).rows[0];
  const item = (await client.query('SELECT item_name, description FROM app_master_items WHERE item_code = $1', [record.item_code])).rows[0];
  if (!list || !item) fail('Choose an existing item and price list.');
  return { list, item };
}

async function savePricingRecord(pool, kind, payload, id = null) {
  const record = normalizePricingRecord(kind, id !== null && kind === 'price-lists' ? { ...payload, price_list: id } : payload);
  return transaction(pool, async (client) => {
    if (kind === 'item-prices') {
      let references;
      if (id === null) references = await validateReferences(client, record);
      else {
        const current = (await client.query('SELECT active FROM app_master_item_prices WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!current) fail('Item price not found.', 404);
        references = current.active === 1 ? await validateReferences(client, record) : await validateExistingReferences(client, record);
      }
      if (record.currency && record.currency !== references.list.currency) fail('Currency must match the price list.');
      record.currency = references.list.currency;
      record.item_name ||= references.item.item_name;
      record.item_description ||= references.item.description;
      record.buying ??= ['buying', 'both'].includes(references.list.price_type) ? 1 : 0;
      record.selling ??= ['selling', 'both'].includes(references.list.price_type) ? 1 : 0;
    }
    const [table, key] = TABLES[kind];
    const columns = Object.keys(record);
    const params = Object.values(record);
    let result;
    if (id === null) {
      result = await client.query(`INSERT INTO ${table} (${columns.join(', ')})
        VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${key}`, params);
    } else {
      if (kind === 'price-lists') {
        const current = (await client.query('SELECT currency FROM app_master_price_lists WHERE price_list = $1 FOR UPDATE', [id])).rows[0];
        if (!current) fail('Price list not found.', 404);
        if (current.currency !== record.currency) {
          const { rows } = await client.query('SELECT 1 FROM app_master_item_prices WHERE price_list = $1 LIMIT 1', [id]);
          if (rows.length) fail('Cannot change the currency of a price list that has item prices.');
        }
      }
      params.push(id);
      result = await client.query(`UPDATE ${table} SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(', ')}, updated_at = now()
        WHERE ${key} = $${params.length} RETURNING ${key}`, params);
      if (!result.rowCount) fail('Pricing record not found.', 404);
    }
    return result.rows[0][key];
  });
}

async function changePricingState(pool, kind, id, action) {
  if (TABLES[kind]) fail('Master prices use the Active switch instead of Submit or Cancel.', 400);
  fail('Unknown pricing action.', 404);
}

async function setItemPriceActive(pool, id, active) {
  if (typeof active !== 'boolean') fail('Choose an active state for the item price.');
  return transaction(pool, async (client) => {
    const record = (await client.query('SELECT * FROM app_master_item_prices WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!record) fail('Item price not found.', 404);
    if (active) await validateReferences(client, record);
    await client.query(`UPDATE app_master_item_prices SET active = $2, docstatus = 'submitted', updated_at = now() WHERE id = $1`,
      [id, active ? 1 : 0]);
  });
}

async function setPriceListActive(pool, id, active) {
  if (typeof active !== 'boolean') fail('Choose an active state for the price list.');
  return transaction(pool, async (client) => {
    const record = (await client.query('SELECT docstatus, active FROM app_master_price_lists WHERE price_list = $1 FOR UPDATE', [id])).rows[0];
    if (!record) fail('Price list not found.', 404);
    const currentlyActive = record.docstatus === 'submitted' && record.active === 1;
    if (currentlyActive === active) return;
    await client.query(`UPDATE app_master_price_lists
      SET docstatus = $2, active = $3, updated_at = now()
      WHERE price_list = $1`, [id, active ? 'submitted' : record.docstatus, active ? 1 : 0]);
  });
}

async function deletePriceList(pool, id) {
  return transaction(pool, async (client) => {
    const record = (await client.query('SELECT price_list FROM app_master_price_lists WHERE price_list = $1 FOR UPDATE', [id])).rows[0];
    if (!record) fail('Price list not found.', 404);
    const { rows } = await client.query('SELECT 1 FROM app_master_item_prices WHERE price_list = $1 LIMIT 1', [id]);
    if (rows.length) fail('Delete the item prices in this price list first.');
    await client.query('DELETE FROM app_master_price_lists WHERE price_list = $1', [id]);
  });
}

module.exports = { initPricingTables, normalizePricingRecord, listPricingRecords, listItemPricePriceLists, listItemPriceCodes, findPricingRecord, findPriceListNeighbors, savePricingRecord, changePricingState, setPriceListActive, setItemPriceActive, deletePriceList };
