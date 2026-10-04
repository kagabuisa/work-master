'use strict';
// Master-data domain: items, customers, suppliers, warehouses, employees,
// cost centres, options, price lists and item prices. Extracted from store.js.
const { getPostgresPool } = require('../core');
const pricing = require('../pricing');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');

async function masterItemsWithStock(options = {}) {
  const search = String(options.search || '').trim().toLowerCase();
  const warehouse = String(options.warehouse || '').trim();
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const params = [warehouse];
  const where = ['item.disabled = false', "item.docstatus = 'submitted'", 'COALESCE(balance.quantity, 0) > 0'];
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.stock_uom, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.category, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.description, '')) LIKE $${params.length}
      OR item.default_rate::text LIKE $${params.length}
    )`);
  }
  params.push(limit);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      item.item_code,
      item.item_name,
      item.stock_uom,
      item.category,
      item.category AS item_category,
      item.source,
      item.unit_cost::float AS cost,
      item.description,
      item.default_rate::float,
      item.default_rate::float AS unit_price,
      $1::text AS warehouse,
      COALESCE(balance.quantity, 0)::float AS stock_balance,
      COALESCE(balance.valuation_rate, 0)::float AS valuation_rate
    FROM app_master_items item
    LEFT JOIN app_stock_balances balance
      ON balance.item_code = item.item_code
      AND balance.warehouse = $1
    WHERE ${where.join(' AND ')}
    ORDER BY item.item_name, item.item_code
    LIMIT $${params.length}
    `,
    params,
  );
  await applySelectedItemPrices(rows, options.priceList);
  return rows.map((row) => ({
    ...row,
    stock_balance: normalizeStockQuantity(row.stock_balance),
  }));
}

async function masterItems(options = {}) {
  const params = [];
  const where = [];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(COALESCE(stock_uom, '')) LIKE $${params.length}
      OR LOWER(COALESCE(category, '')) LIKE $${params.length}
      OR LOWER(COALESCE(description, '')) LIKE $${params.length}
      OR LOWER(COALESCE(exporter, '')) LIKE $${params.length}
      OR LOWER(COALESCE(source, '')) LIKE $${params.length}
      OR LOWER(COALESCE(photo_count_id, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'disabled' ELSE 'enabled' END) LIKE $${params.length}
      OR default_rate::text LIKE $${params.length}
      OR unit_cost::text LIKE $${params.length}
      OR markup::text LIKE $${params.length}
      OR qty_per_carton::text LIKE $${params.length}
      OR cbm_per_carton::text LIKE $${params.length}
      OR weight_per_carton::text LIKE $${params.length}
      OR import_fob::text LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_items ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      item_code,
      item_name,
      stock_uom,
      category,
      description,
      default_rate::float,
      unit_cost::float,
      markup::float,
      qty_per_carton::float,
      cbm_per_carton::float,
      weight_per_carton::float,
      import_fob::float,
      exporter,
      source,
      photo_count_id,
      is_sales_item,
      is_purchase_item,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_items
    ${whereSql}
    ORDER BY item_name, item_code
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  await applySelectedItemPrices(rows, options.priceList);
  return rows;
}

async function applySelectedItemPrices(rows, priceList) {
  const selected = String(priceList || '').trim();
  if (!selected || !rows.length) return;
  const codes = rows.map((row) => row.item_code);
  const { rows: prices } = await getPostgresPool().query(`
    SELECT item_code, price_list_rate::float FROM app_master_item_prices
    WHERE price_list = $1 AND item_code = ANY($2::text[]) AND active = 1
  `, [selected, codes]);
  const byCode = new Map(prices.map((row) => [row.item_code, row.price_list_rate]));
  for (const row of rows) {
    if (!byCode.has(row.item_code)) continue;
    row.unit_price = byCode.get(row.item_code);
    row.unit_cost = byCode.get(row.item_code);
  }
}

async function invoiceItemPrices(itemCodes, priceList) {
  const { rows } = await getPostgresPool().query(`
    SELECT item.item_code,
      COALESCE(price.price_list_rate, item.default_rate, 0)::float AS unit_price,
      price.id IS NOT NULL AS has_list_price
    FROM app_master_items item
    LEFT JOIN app_master_item_prices price
      ON price.item_code = item.item_code AND price.price_list = $2 AND price.active = 1
    WHERE item.item_code = ANY($1::text[])
  `, [itemCodes, priceList]);
  return rows;
}

async function masterCustomers(options = {}) {
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedGroups)) {
    params.push(options.allowedGroups);
    where.push(`LOWER(TRIM(COALESCE(customer_group, ''))) = ANY($${params.length}::text[])`);
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(customer_id) LIKE $${params.length}
      OR LOWER(customer_name) LIKE $${params.length}
      OR LOWER(COALESCE(customer_group, '')) LIKE $${params.length}
      OR LOWER(COALESCE(territory, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(COALESCE(tin, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'inactive' ELSE 'active' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_customers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      customer_id,
      customer_name,
      customer_group,
      territory,
      phone,
      tin,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_customers
    ${whereSql}
    ORDER BY customer_name, customer_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterSuppliers(options = {}) {
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedTypes)) {
    params.push(options.allowedTypes);
    where.push(`LOWER(TRIM(COALESCE(supplier_type, ''))) = ANY($${params.length}::text[])`);
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(supplier_id) LIKE $${params.length}
      OR LOWER(supplier_name) LIKE $${params.length}
      OR LOWER(COALESCE(supplier_type, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'inactive' ELSE 'active' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_suppliers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      supplier_id,
      supplier_name,
      supplier_type,
      phone,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_suppliers
    ${whereSql}
    ORDER BY supplier_name, supplier_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterWarehouses(options = {}) {
  const params = [];
  const where = ['is_group = false'];
  if (Array.isArray(options.allowedWarehouses)) {
    params.push(options.allowedWarehouses);
    where.push(`warehouse = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedWarehouses) && options.deniedWarehouses.length) {
    params.push(options.deniedWarehouses);
    where.push(`warehouse <> ALL($${params.length}::text[])`);
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(warehouse) LIKE $${params.length}
      OR LOWER(COALESCE(warehouse_type, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'disabled' ELSE 'enabled' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.join(' AND ');
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_warehouses WHERE ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      warehouse,
      warehouse_type,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_warehouses
    WHERE ${whereSql}
    ORDER BY warehouse
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterEmployees(options = {}) {
  const params = [];
  const where = [];
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(employee_id) LIKE $${params.length}
      OR LOWER(employee_name) LIKE $${params.length}
      OR LOWER(COALESCE(status, '')) LIKE $${params.length}
      OR LOWER(COALESCE(company, '')) LIKE $${params.length}
      OR LOWER(COALESCE(department, '')) LIKE $${params.length}
      OR LOWER(COALESCE(designation, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(COALESCE(email, '')) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_employees ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      employee_id,
      employee_name,
      status,
      company,
      department,
      designation,
      phone,
      email,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE COALESCE(NULLIF(status, ''), 'Active') END AS status_label
    FROM app_master_employees
    ${whereSql}
    ORDER BY employee_name, employee_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterCostCenters(options = {}) {
  const params = [];
  const where = [];
  if (!options.includeGroups) {
    where.push('is_group = false');
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(cost_center) LIKE $${params.length}
      OR LOWER(cost_center_name) LIKE $${params.length}
      OR LOWER(COALESCE(parent_cost_center, '')) LIKE $${params.length}
      OR LOWER(COALESCE(company, '')) LIKE $${params.length}
      OR LOWER(COALESCE(cost_center_type, '')) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_cost_centers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      cost_center,
      cost_center_name,
      parent_cost_center,
      company,
      cost_center_type,
      is_group,
      CASE WHEN is_group THEN 'Yes' ELSE 'No' END AS group_label,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_cost_centers
    ${whereSql}
    ORDER BY cost_center_name, cost_center
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterPricingRecords(kind, options = {}) {
  const pagination = paginationOptions(options, Number(options.limit || 50), 200);
  const { rows, total } = await pricing.listPricingRecords(getPostgresPool(), kind, options, pagination);
  if (options.paginate) rows.pagination = paginationResult(Number(total || 0), pagination);
  return rows;
}

async function masterPriceLists(options = {}) { return masterPricingRecords('price-lists', options); }
async function masterItemPrices(options = {}) { return masterPricingRecords('item-prices', options); }
async function itemPriceListFilters() {
  return pricing.listItemPricePriceLists(getPostgresPool());
}
async function itemPriceCodeSuggestions(options = {}) {
  return pricing.listItemPriceCodes(getPostgresPool(), options);
}

async function masterOptions(options = {}) {
  const params = [];
  const where = options.includeDisabled ? [] : ['disabled = false', "docstatus = 'submitted'"];
  const search = String(options.search || '').trim().toLowerCase();
  const group = String(options.group || '').trim();
  if (group) {
    params.push(group);
    where.push(`option_group = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(option_group) LIKE $${params.length}
      OR LOWER(option_value) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_options ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT id, option_group, option_value, docstatus, legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled
    FROM app_master_options
    ${whereSql}
    ORDER BY option_group, option_value
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function findMasterRecord(kind, id) {
  if (kind === 'price-lists' || kind === 'item-prices') return pricing.findPricingRecord(getPostgresPool(), kind, id);
  if (kind === 'items') {
    return findMasterItem(id, { includeDisabled: true });
  }
  if (kind === 'customers') {
    return findMasterCustomer(id, { includeDisabled: true });
  }
  if (kind === 'suppliers') {
    return findMasterSupplier(id, { includeDisabled: true });
  }
  if (kind === 'warehouses') {
    return findMasterWarehouse(id);
  }
  if (kind === 'employees') {
    return findMasterEmployee(id, { includeDisabled: true });
  }
  if (kind === 'cost_centers' || kind === 'cost-centers') {
    return findMasterCostCenter(id, { includeGroups: true, includeDisabled: true });
  }
  if (kind === 'options') {
    return findMasterOption(id);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

async function priceListNeighbors(id) {
  return pricing.findPriceListNeighbors(getPostgresPool(), id);
}

async function masterRecordNeighbors(kind, id) {
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) return null;
  const [table, key] = fields;
  const visible = kind === 'warehouses' ? ' AND is_group = false' : '';
  const [previous, next] = await Promise.all([
    getPostgresPool().query(`SELECT ${key} AS id FROM ${table} WHERE ${key} < $1${visible} ORDER BY ${key} DESC LIMIT 1`, [id]),
    getPostgresPool().query(`SELECT ${key} AS id FROM ${table} WHERE ${key} > $1${visible} ORDER BY ${key} ASC LIMIT 1`, [id]),
  ]);
  return { previous: previous.rows[0]?.id ?? null, next: next.rows[0]?.id ?? null };
}

async function findMasterItem(itemCode, options = {}) {
  const code = String(itemCode || '').trim();
  if (!code) {
    return null;
  }
  const where = ['item_code = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      item_code,
      item_name,
      stock_uom,
      category,
      description,
      default_rate::float,
      unit_cost::float,
      markup::float,
      qty_per_carton::float,
      cbm_per_carton::float,
      weight_per_carton::float,
      import_fob::float,
      exporter,
      source,
      photo_count_id,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_items
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [code],
  );
  return rows[0] || null;
}

async function findMasterCustomer(customerId, options = {}) {
  const id = String(customerId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['customer_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      customer_id,
      customer_name,
      customer_group,
      territory,
      phone,
      tin,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_customers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterSupplier(supplierId, options = {}) {
  const id = String(supplierId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['supplier_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      supplier_id,
      supplier_name,
      supplier_type,
      phone,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_suppliers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterWarehouse(warehouseName) {
  const warehouse = String(warehouseName || '').trim();
  if (!warehouse) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      warehouse,
      warehouse_type,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_warehouses
    WHERE warehouse = $1
      AND is_group = false
    LIMIT 1
    `,
    [warehouse],
  );
  return rows[0] || null;
}

async function findMasterEmployee(employeeId, options = {}) {
  const id = String(employeeId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['employee_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      employee_id,
      employee_name,
      status,
      company,
      department,
      designation,
      phone,
      email,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE COALESCE(NULLIF(status, ''), 'Active') END AS status_label
    FROM app_master_employees
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterCostCenter(costCenterName, options = {}) {
  const costCenter = String(costCenterName || '').trim();
  if (!costCenter) {
    return null;
  }
  const where = ['cost_center = $1'];
  if (!options.includeGroups) {
    where.push('is_group = false');
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      cost_center,
      cost_center_name,
      parent_cost_center,
      company,
      cost_center_type,
      is_group,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_cost_centers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [costCenter],
  );
  return rows[0] || null;
}

async function findMasterOption(optionId) {
  const id = Number(optionId);
  if (!id) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at, id, option_group, option_value, docstatus, legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled
    FROM app_master_options
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function createMasterRecord(kind, payload) {
  if (kind === 'price-lists' || kind === 'item-prices') return pricing.savePricingRecord(getPostgresPool(), kind, payload);
  if (kind === 'items') {
    return createMasterItem(payload);
  }
  if (kind === 'customers') {
    return createMasterCustomer(payload);
  }
  if (kind === 'suppliers') {
    return createMasterSupplier(payload);
  }
  if (kind === 'warehouses') {
    return createMasterWarehouse(payload);
  }
  if (kind === 'employees') {
    return createMasterEmployee(payload);
  }
  if (kind === 'cost-centers') {
    return createMasterCostCenter(payload);
  }
  if (kind === 'options') {
    return createMasterOption(payload);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

const MASTER_RECORD_TABLES = {
  'item-prices': ['app_master_item_prices', 'id'],
  items: ['app_master_items', 'item_code'],
  customers: ['app_master_customers', 'customer_id'],
  suppliers: ['app_master_suppliers', 'supplier_id'],
  warehouses: ['app_master_warehouses', 'warehouse'],
  employees: ['app_master_employees', 'employee_id'],
  'cost-centers': ['app_master_cost_centers', 'cost_center'],
  options: ['app_master_options', 'id'],
};

async function setMasterRecordActive(kind, id, active) {
  if (typeof active !== 'boolean') { const error = new Error('Choose an active state.'); error.status = 400; throw error; }
  if (kind === 'item-prices') return pricing.setItemPriceActive(getPostgresPool(), id, active);
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
  const { rowCount } = await getPostgresPool().query(
    `UPDATE ${fields[0]} SET disabled = $2, docstatus = 'submitted', updated_at = now()${kind === 'cost-centers' ? ', legacy_editable = false' : ''} WHERE ${fields[1]} = $1`,
    [id, !active],
  );
  if (!rowCount) { const error = new Error('Master record not found.'); error.status = 404; throw error; }
}

async function setPriceListActive(id, active) {
  return pricing.setPriceListActive(getPostgresPool(), id, active);
}

async function deletePriceList(id) {
  return pricing.deletePriceList(getPostgresPool(), id);
}

async function deleteMasterRecord(kind, id) {
  if (kind === 'price-lists') return deletePriceList(id);
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
  try {
    const { rowCount } = await getPostgresPool().query(`DELETE FROM ${fields[0]} WHERE ${fields[1]} = $1`, [id]);
    if (!rowCount) { const error = new Error('Master record not found.'); error.status = 404; throw error; }
  } catch (error) {
    if (error.code === '23503') { const blocked = new Error('This record is used elsewhere and cannot be deleted. Deactivate it instead.'); blocked.status = 400; throw blocked; }
    throw error;
  }
}

async function updateMasterRecord(kind, id, payload) {
  if (kind === 'price-lists' || kind === 'item-prices') return pricing.savePricingRecord(getPostgresPool(), kind, payload, id);
  if (MASTER_RECORD_TABLES[kind]) {
    const [table, key] = MASTER_RECORD_TABLES[kind];
    const { rowCount } = await getPostgresPool().query(`SELECT 1 FROM ${table} WHERE ${key} = $1`, [id]);
    if (!rowCount) { const error = new Error('Master record not found.'); error.status = 404; throw error; }
  }
  if (kind === 'items') {
    return updateMasterItem(id, payload);
  }
  if (kind === 'customers') {
    return updateMasterCustomer(id, payload);
  }
  if (kind === 'suppliers') {
    return updateMasterSupplier(id, payload);
  }
  if (kind === 'warehouses') {
    return updateMasterWarehouse(id, payload);
  }
  if (kind === 'employees') {
    return updateMasterEmployee(id, payload);
  }
  if (kind === 'cost_centers' || kind === 'cost-centers') {
    return updateMasterCostCenter(id, payload, { upsert: kind === 'cost_centers' });
  }
  if (kind === 'options') {
    return updateMasterOption(id, payload);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

async function createMasterItem(payload) {
  const itemCode = requiredValue(payload.item_code, 'Item code is required.');
  const itemName = requiredValue(payload.item_name, 'Item name is required.');
  const disabled = true;
  await getPostgresPool().query(
    `
    INSERT INTO app_master_items (
      item_code, item_name, stock_uom, category, description, default_rate,
      unit_cost, markup, qty_per_carton, cbm_per_carton, weight_per_carton,
      import_fob, exporter, source, photo_count_id, is_sales_item,
      is_purchase_item, disabled, docstatus, legacy_editable
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, 'submitted', false
    )
    `,
    [
      itemCode,
      itemName,
      optionalValue(payload.stock_uom),
      optionalValue(payload.category),
      optionalValue(payload.description),
      roundMoney(payload.default_rate),
      roundMoney(payload.unit_cost),
      numberValue(payload.markup),
      numberValue(payload.qty_per_carton),
      numberValue(payload.cbm_per_carton),
      numberValue(payload.weight_per_carton),
      numberValue(payload.import_fob),
      optionalValue(payload.exporter),
      optionalValue(payload.source),
      optionalValue(payload.photo_count_id),
      payload.is_sales_item !== '0',
      payload.is_purchase_item !== '0',
      disabled,
    ],
  );
  return itemCode;
}

async function updateMasterItem(id, payload) {
  const itemCode = requiredValue(id, 'Item code is required.');
  const itemName = requiredValue(payload.item_name, 'Item name is required.');
  const disabled = true;
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_items (
      item_code, item_name, stock_uom, category, description, default_rate,
      unit_cost, markup, qty_per_carton, cbm_per_carton, weight_per_carton,
      import_fob, exporter, source, photo_count_id, is_sales_item,
      is_purchase_item, disabled
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18
    )
    ON CONFLICT (item_code) DO UPDATE SET
      item_name = EXCLUDED.item_name,
      stock_uom = EXCLUDED.stock_uom,
      category = EXCLUDED.category,
      description = EXCLUDED.description,
      default_rate = EXCLUDED.default_rate,
      unit_cost = EXCLUDED.unit_cost,
      markup = EXCLUDED.markup,
      qty_per_carton = EXCLUDED.qty_per_carton,
      cbm_per_carton = EXCLUDED.cbm_per_carton,
      weight_per_carton = EXCLUDED.weight_per_carton,
      import_fob = EXCLUDED.import_fob,
      exporter = EXCLUDED.exporter,
      source = EXCLUDED.source,
      photo_count_id = EXCLUDED.photo_count_id,
      is_sales_item = EXCLUDED.is_sales_item,
      is_purchase_item = EXCLUDED.is_purchase_item,
      disabled = app_master_items.disabled,
      updated_at = now()
    `,
    [
      itemCode,
      itemName,
      optionalValue(payload.stock_uom),
      optionalValue(payload.category),
      optionalValue(payload.description),
      roundMoney(payload.default_rate),
      roundMoney(payload.unit_cost),
      numberValue(payload.markup),
      numberValue(payload.qty_per_carton),
      numberValue(payload.cbm_per_carton),
      numberValue(payload.weight_per_carton),
      numberValue(payload.import_fob),
      optionalValue(payload.exporter),
      optionalValue(payload.source),
      optionalValue(payload.photo_count_id),
      payload.is_sales_item !== '0',
      payload.is_purchase_item !== '0',
      disabled,
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return itemCode;
}

function customerTin(value) {
  const tin = optionalValue(value);
  if (tin && tin.length > 100) {
    const error = new Error('TIN must be 100 characters or fewer.');
    error.status = 400;
    throw error;
  }
  return tin;
}

async function createMasterCustomer(payload) {
  const customerName = requiredValue(payload.customer_name, 'Customer name is required.');
  const customerId = optionalValue(payload.customer_id) || customerName;
  const disabled = true;
  const tin = customerTin(payload.tin);
  await getPostgresPool().query(
    `
    INSERT INTO app_master_customers (
      customer_id, customer_name, customer_group, territory, phone, disabled, tin, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', false)
    `,
    [
      customerId,
      customerName,
      optionalValue(payload.customer_group),
      optionalValue(payload.territory),
      optionalValue(payload.phone),
      disabled,
      tin,
    ],
  );
  return customerId;
}

async function updateMasterCustomer(id, payload) {
  const customerId = requiredValue(id, 'Customer ID is required.');
  const customerName = requiredValue(payload.customer_name, 'Customer name is required.');
  const disabled = true;
  const tin = customerTin(payload.tin);
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_customers (
      customer_id, customer_name, customer_group, territory, phone, disabled, tin
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (customer_id) DO UPDATE SET
      customer_name = EXCLUDED.customer_name,
      customer_group = EXCLUDED.customer_group,
      territory = EXCLUDED.territory,
      phone = EXCLUDED.phone,
      disabled = app_master_customers.disabled,
      tin = CASE WHEN $8::boolean THEN EXCLUDED.tin ELSE app_master_customers.tin END,
      updated_at = now()
    `,
    [
      customerId,
      customerName,
      optionalValue(payload.customer_group),
      optionalValue(payload.territory),
      optionalValue(payload.phone),
      disabled,
      tin,
      Object.hasOwn(payload, 'tin'),
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return customerId;
}

async function createMasterSupplier(payload) {
  const supplierName = requiredValue(payload.supplier_name, 'Supplier name is required.');
  const supplierId = optionalValue(payload.supplier_id) || supplierName;
  const disabled = true;
  await getPostgresPool().query(
    `
    INSERT INTO app_master_suppliers (
      supplier_id, supplier_name, supplier_type, phone, disabled, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, 'submitted', false)
    `,
    [
      supplierId,
      supplierName,
      optionalValue(payload.supplier_type),
      optionalValue(payload.phone),
      disabled,
    ],
  );
  return supplierId;
}

async function updateMasterSupplier(id, payload) {
  const supplierId = requiredValue(id, 'Supplier ID is required.');
  const supplierName = requiredValue(payload.supplier_name, 'Supplier name is required.');
  const disabled = true;
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_suppliers (
      supplier_id, supplier_name, supplier_type, phone, disabled
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (supplier_id) DO UPDATE SET
      supplier_name = EXCLUDED.supplier_name,
      supplier_type = EXCLUDED.supplier_type,
      phone = EXCLUDED.phone,
      disabled = app_master_suppliers.disabled,
      updated_at = now()
    `,
    [
      supplierId,
      supplierName,
      optionalValue(payload.supplier_type),
      optionalValue(payload.phone),
      disabled,
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return supplierId;
}

async function createMasterWarehouse(payload) {
  const warehouse = requiredValue(payload.warehouse, 'Warehouse name is required.');
  const disabled = true;
  await getPostgresPool().query(
    `
    INSERT INTO app_master_warehouses (warehouse, warehouse_type, disabled, docstatus, legacy_editable)
    VALUES ($1, $2, $3, 'submitted', false)
    `,
    [warehouse, optionalValue(payload.warehouse_type), disabled],
  );
  return warehouse;
}

async function updateMasterWarehouse(id, payload) {
  const warehouse = requiredValue(id, 'Warehouse name is required.');
  const disabled = true;
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_warehouses (warehouse, warehouse_type, is_group, disabled)
    VALUES ($1, $2, false, $3)
    ON CONFLICT (warehouse) DO UPDATE SET
      warehouse_type = EXCLUDED.warehouse_type,
      is_group = false,
      disabled = app_master_warehouses.disabled,
      updated_at = now()
    `,
    [warehouse, optionalValue(payload.warehouse_type), disabled],
  );
  assertMasterUpdateApplied(rowCount);
  return warehouse;
}

function assertMasterUpdateApplied(rowCount) {
  if (!rowCount) { const error = new Error('This master record can no longer be edited.'); error.status = 400; throw error; }
}

async function createMasterEmployee(payload) {
  const employeeName = requiredValue(payload.employee_name, 'Employee name is required.');
  const employeeId = optionalValue(payload.employee_id) || employeeName;
  const disabled = true;
  await getPostgresPool().query(
    `
    INSERT INTO app_master_employees (
      employee_id, employee_name, status, company, department, designation,
      phone, email, disabled, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'submitted', false)
    `,
    [
      employeeId,
      employeeName,
      optionalValue(payload.status),
      optionalValue(payload.company),
      optionalValue(payload.department),
      optionalValue(payload.designation),
      optionalValue(payload.phone),
      optionalValue(payload.email),
      disabled,
    ],
  );
  return employeeId;
}

async function updateMasterEmployee(id, payload) {
  const employeeId = requiredValue(id, 'Employee ID is required.');
  const employeeName = requiredValue(payload.employee_name || id, 'Employee name is required.');
  const { rowCount } = await getPostgresPool().query(
    `
    UPDATE app_master_employees
    SET employee_name = $2,
        status = $3,
        company = $4,
        department = $5,
        designation = $6,
        phone = $7,
        email = $8,
        updated_at = now()
    WHERE employee_id = $1
    `,
    [
      employeeId,
      employeeName,
      optionalValue(payload.status),
      optionalValue(payload.company),
      optionalValue(payload.department),
      optionalValue(payload.designation),
      optionalValue(payload.phone),
      optionalValue(payload.email),
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return employeeId;
}

async function createMasterCostCenter(payload) {
  const costCenterName = requiredValue(payload.cost_center_name, 'Cost center name is required.');
  const costCenter = optionalValue(payload.cost_center) || costCenterName;
  const isGroup = ['1', 'true'].includes(String(payload.is_group || '').toLowerCase());
  await getPostgresPool().query(
    `INSERT INTO app_master_cost_centers (
      cost_center, cost_center_name, parent_cost_center, company,
      cost_center_type, is_group, disabled, docstatus, legacy_editable
    ) VALUES ($1, $2, $3, $4, $5, $6, true, 'submitted', false)`,
    [costCenter, costCenterName, optionalValue(payload.parent_cost_center),
      optionalValue(payload.company), optionalValue(payload.cost_center_type), isGroup],
  );
  return costCenter;
}

async function updateMasterCostCenter(id, payload, options = {}) {
  const costCenter = requiredValue(id, 'Cost center is required.');
  const costCenterName = requiredValue(payload.cost_center_name || id, 'Cost center name is required.');
  const isGroup = ['1', 'true'].includes(String(payload.is_group || '').toLowerCase());
  const fields = [costCenter, costCenterName, optionalValue(payload.parent_cost_center),
    optionalValue(payload.company), optionalValue(payload.cost_center_type), isGroup];
  if (!options.upsert) {
    const { rowCount } = await getPostgresPool().query(
      `UPDATE app_master_cost_centers
       SET cost_center_name = $2, parent_cost_center = $3, company = $4,
         cost_center_type = $5, is_group = $6, legacy_editable = false, updated_at = now()
       WHERE cost_center = $1`, fields,
    );
    assertMasterUpdateApplied(rowCount);
    return costCenter;
  }
  const disabled = String(payload.disabled || '0') === '1';
  await getPostgresPool().query(
    `
    INSERT INTO app_master_cost_centers (
      cost_center, cost_center_name, parent_cost_center, company,
      cost_center_type, is_group, disabled, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, true)
    ON CONFLICT (cost_center) DO UPDATE SET
      cost_center_name = EXCLUDED.cost_center_name,
      parent_cost_center = EXCLUDED.parent_cost_center,
      company = EXCLUDED.company,
      cost_center_type = EXCLUDED.cost_center_type,
      is_group = EXCLUDED.is_group,
      disabled = EXCLUDED.disabled,
      updated_at = now()
    WHERE app_master_cost_centers.legacy_editable = true
    `,
    [...fields, disabled],
  );
  return costCenter;
}

async function createMasterOption(payload) {
  const optionGroup = requiredValue(payload.option_group, 'Option group is required.');
  const optionValue = requiredValue(payload.option_value, 'Option value is required.');
  const { rows } = await getPostgresPool().query(
    `
    INSERT INTO app_master_options (option_group, option_value, disabled, docstatus, legacy_editable)
    VALUES ($1, $2, true, 'submitted', false)
    RETURNING id
    `,
    [optionGroup, optionValue],
  );
  return Number(rows[0].id);
}

async function updateMasterOption(id, payload) {
  const optionId = Number(id);
  if (!optionId) {
    const err = new Error('Option not found.');
    err.status = 404;
    throw err;
  }
  const optionGroup = requiredValue(payload.option_group, 'Option group is required.');
  const optionValue = requiredValue(payload.option_value, 'Option value is required.');
  const { rowCount } = await getPostgresPool().query(
    `
    UPDATE app_master_options
    SET option_group = $1,
      option_value = $2,
      updated_at = now()
    WHERE id = $3
    `,
    [optionGroup, optionValue, optionId],
  );
  if (!rowCount) {
    const err = new Error('Option not found.');
    err.status = 404;
    throw err;
  }
  return optionId;
}
module.exports = {
  masterItemsWithStock,
  masterItems,
  applySelectedItemPrices,
  invoiceItemPrices,
  masterCustomers,
  masterSuppliers,
  masterWarehouses,
  masterEmployees,
  masterCostCenters,
  masterPricingRecords,
  masterPriceLists,
  masterItemPrices,
  itemPriceListFilters,
  itemPriceCodeSuggestions,
  masterOptions,
  findMasterRecord,
  priceListNeighbors,
  masterRecordNeighbors,
  findMasterItem,
  findMasterCustomer,
  findMasterSupplier,
  findMasterWarehouse,
  findMasterEmployee,
  findMasterCostCenter,
  findMasterOption,
  createMasterRecord,
  setMasterRecordActive,
  setPriceListActive,
  deletePriceList,
  deleteMasterRecord,
  updateMasterRecord,
  createMasterItem,
  updateMasterItem,
  customerTin,
  createMasterCustomer,
  updateMasterCustomer,
  createMasterSupplier,
  updateMasterSupplier,
  createMasterWarehouse,
  updateMasterWarehouse,
  assertMasterUpdateApplied,
  createMasterEmployee,
  updateMasterEmployee,
  createMasterCostCenter,
  updateMasterCostCenter,
  createMasterOption,
  updateMasterOption,
};
