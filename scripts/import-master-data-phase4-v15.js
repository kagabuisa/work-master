const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase4-import-log.json');
const phase1VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function sslConfig() {
  return ['1', 'true', 'required', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;
}

function flag(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (String(value).toLowerCase() === 'yes') return 1;
  if (String(value).toLowerCase() === 'no') return 0;
  return Number(value) ? 1 : 0;
}

function dateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

function readMaps() {
  if (!fs.existsSync(phase1VerificationPath)) return {};
  return JSON.parse(fs.readFileSync(phase1VerificationPath, 'utf8')).maps || {};
}

function mapValue(maps, mapName, value) {
  if (!value) return value;
  return (maps[mapName] && maps[mapName][value]) || value;
}

function addCompanyMappings(targetCompanies, maps, oldCompanyName) {
  if (!maps.Company) maps.Company = {};
  const target = targetCompanies.find((row) => row.abbr === 'SACL') || targetCompanies[0];
  if (target && oldCompanyName) maps.Company[oldCompanyName] = target.name;
}

async function login(base, usr, pwd) {
  const response = await fetch(`${base}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ usr, pwd }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Login failed ${response.status}: ${text.slice(0, 300)}`);
  return (response.headers.get('set-cookie') || '')
    .split(/,(?=\s*\w+=)/)
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

async function requestJson(base, cookie, resourcePath, options = {}) {
  const response = await fetch(`${base}${resourcePath}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      cookie,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`${options.method || 'GET'} ${resourcePath} failed ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchAllResource(base, cookie, doctype, fields) {
  const rows = [];
  const pageLength = 500;
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
      limit_start: String(start),
      limit_page_length: String(pageLength),
    });
    const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < pageLength) break;
    start += pageLength;
  }
  return rows;
}

async function oldRows(conn, doctype, order = 'name') {
  const [rows] = await conn.query(`select * from \`tab${doctype}\` order by ${order}`);
  return rows;
}

async function oldChildRows(conn, doctype, parentType) {
  const [rows] = await conn.query(
    `select * from \`tab${doctype}\` where parenttype = ? order by parent, idx`,
    [parentType],
  );
  return rows;
}

function indexChildren(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.parent)) map.set(row.parent, []);
    map.get(row.parent).push(row);
  }
  return map;
}

function itemPayload(row, uomChildren, maps, lookups, company) {
  const warehouse = mapValue(maps, 'Warehouse', row.default_warehouse);
  const income = mapValue(maps, 'Account', row.income_account);
  const expense = mapValue(maps, 'Account', row.expense_account);
  const buyingCostCenter = mapValue(maps, 'Cost Center', row.buying_cost_center);
  const sellingCostCenter = mapValue(maps, 'Cost Center', row.selling_cost_center);
  const supplier = row.default_supplier && lookups.Supplier.has(row.default_supplier) ? row.default_supplier : undefined;
  const itemDefaults = clean({
    doctype: 'Item Default',
    company: company.name,
    default_warehouse: warehouse && lookups.Warehouse.has(warehouse) ? warehouse : undefined,
    income_account: income && lookups.Account.has(income) ? income : undefined,
    expense_account: expense && lookups.Account.has(expense) ? expense : undefined,
    buying_cost_center: buyingCostCenter && lookups['Cost Center'].has(buyingCostCenter) ? buyingCostCenter : undefined,
    selling_cost_center: sellingCostCenter && lookups['Cost Center'].has(sellingCostCenter) ? sellingCostCenter : undefined,
    default_supplier: supplier,
  });
  return clean({
    doctype: 'Item',
    name: row.name,
    item_code: row.item_code || row.name,
    item_name: row.item_name || row.name,
    item_group: mapValue(maps, 'Item Group', row.item_group) || 'Products',
    stock_uom: row.stock_uom || 'Nos',
    disabled: flag(row.disabled),
    is_stock_item: flag(row.is_stock_item, 1),
    is_sales_item: flag(row.is_sales_item, 1),
    is_purchase_item: flag(row.is_purchase_item, 1),
    has_variants: flag(row.has_variants),
    end_of_life: dateOnly(row.end_of_life),
    description: row.description,
    brand: mapValue(maps, 'Brand', row.brand),
    valuation_method: row.valuation_method,
    warranty_period: row.warranty_period,
    weight_uom: row.weight_uom,
    min_order_qty: row.min_order_qty,
    last_purchase_rate: row.last_purchase_rate,
    delivered_by_supplier: flag(row.delivered_by_supplier),
    is_sub_contracted_item: flag(row.is_sub_contracted_item),
    max_discount: row.max_discount,
    customer_code: row.customer_code,
    item_category: lookups.ItemCategoryName.get(row.item_category) || row.item_category,
    cost: row.cost,
    rrp: row.rrp,
    uoms: (uomChildren.get(row.name) || []).map((child) => clean({
      doctype: 'UOM Conversion Detail',
      uom: child.uom,
      conversion_factor: child.conversion_factor || 1,
    })),
    item_defaults: Object.keys(itemDefaults).length > 2 ? [itemDefaults] : [],
  });
}

function itemPricePayload(row, maps, lookups) {
  const itemCode = lookups.ItemCodeMap.get(row.item_code) || row.item_code;
  const priceList = mapValue(maps, 'Price List', row.price_list);
  return clean({
    doctype: 'Item Price',
    item_code: itemCode,
    item_name: row.item_name,
    price_list: priceList,
    buying: flag(row.buying),
    selling: flag(row.selling),
    currency: mapValue(maps, 'Currency', row.currency) || 'UGX',
    price_list_rate: row.price_list_rate,
    uom: lookups.ItemUom.get(itemCode) || 'Nos',
    reference: row.name,
  });
}

function priceKey(row, maps, itemUom) {
  const itemCode = itemUom.codeMap ? itemUom.codeMap.get(row.item_code) || row.item_code : row.item_code;
  return [
    itemCode,
    mapValue(maps, 'Price List', row.price_list),
    mapValue(maps, 'Currency', row.currency) || 'UGX',
    itemUom.get(itemCode) || itemUom.get(row.item_code) || 'Nos',
  ].join('::').toLowerCase();
}

function latestPriceRows(rows, maps, itemUom) {
  const byKey = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = priceKey(row, maps, itemUom);
    const prev = byKey.get(key);
    if (!prev || String(row.modified || '') > String(prev.modified || '')) {
      byKey.set(key, row);
    }
    if (prev) duplicateRows += 1;
  }
  return { rows: [...byKey.values()], duplicateRows };
}

function initLog(apply) {
  return {
    generated_at: new Date().toISOString(),
    apply,
    target: '',
    counts: {
      'Item Category': { source: 0, skipped_existing: 0, dry_run_create: 0, created: 0, failed: 0 },
      Item: { source: 0, skipped_existing: 0, skipped_missing_link: 0, dry_run_create: 0, created: 0, failed: 0 },
      'Item Price': {
        source: 0,
        latest_unique_source: 0,
        duplicate_old_rows_skipped: 0,
        skipped_existing: 0,
        skipped_missing_link: 0,
        dry_run_create: 0,
        created: 0,
        failed: 0,
      },
    },
    results: [],
  };
}

async function importCategories({ base, cookie, apply, log, rows, existingCategories }) {
  log.counts['Item Category'].source = rows.length;
  for (const row of rows) {
    const name = row.item_category || row.name;
    if (existingCategories.has(name)) {
      log.counts['Item Category'].skipped_existing += 1;
      continue;
    }
    const payload = clean({ doctype: 'Item Category', name, item_category: name });
    if (!apply) {
      log.counts['Item Category'].dry_run_create += 1;
      continue;
    }
    try {
      const result = await requestJson(base, cookie, '/api/resource/Item Category', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      existingCategories.add((result.data && result.data.name) || name);
      log.counts['Item Category'].created += 1;
    } catch (err) {
      log.counts['Item Category'].failed += 1;
      log.results.push({ doctype: 'Item Category', name, status: 'failed', error: err.message, response: err.body, payload });
    }
  }
}

async function importItems({ base, cookie, apply, log, rows, existingItems, uomChildren, maps, lookups, company }) {
  log.counts.Item.source = rows.length;
  for (const row of rows) {
    if (existingItems.has(row.name) || existingItems.has(row.item_code)) {
      log.counts.Item.skipped_existing += 1;
      continue;
    }
    if (row.item_category && !lookups.ItemCategoryName.has(row.item_category) && !lookups['Item Category'].has(row.item_category)) {
      log.counts.Item.skipped_missing_link += 1;
      log.results.push({ doctype: 'Item', name: row.name, status: 'skipped_missing_link', missing: { item_category: row.item_category } });
      continue;
    }
    const payload = itemPayload(row, uomChildren, maps, lookups, company);
    if (!apply) {
      log.counts.Item.dry_run_create += 1;
      log.results.push({ doctype: 'Item', name: row.name, status: 'dry_run_create', payload });
      continue;
    }
    try {
      const result = await requestJson(base, cookie, '/api/resource/Item', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const name = (result.data && result.data.name) || payload.name || row.name;
      existingItems.add(name);
      existingItems.add(payload.item_code);
      log.counts.Item.created += 1;
      log.results.push({ doctype: 'Item', name: row.name, status: 'created', target: name });
    } catch (err) {
      log.counts.Item.failed += 1;
      log.results.push({ doctype: 'Item', name: row.name, status: 'failed', error: err.message, response: err.body, payload });
    }
  }
}

async function importPrices({ base, cookie, apply, log, rows, existingPriceKeys, maps, lookups, limit, concurrency }) {
  const candidates = [];
  for (const row of rows) {
    if (limit && candidates.length >= limit) break;
    const key = priceKey(row, maps, lookups.ItemUom);
    const payload = itemPricePayload(row, maps, lookups);
    if (!lookups.Item.has(payload.item_code) || !lookups['Price List'].has(payload.price_list)) {
      log.counts['Item Price'].skipped_missing_link += 1;
      if (log.results.length < 300) {
        log.results.push({
          doctype: 'Item Price',
          name: row.name,
          status: 'skipped_missing_link',
          item_code: payload.item_code,
          price_list: payload.price_list,
        });
      }
      continue;
    }
    if (existingPriceKeys.has(key)) {
      log.counts['Item Price'].skipped_existing += 1;
      continue;
    }
    existingPriceKeys.add(key);
    if (!apply) {
      log.counts['Item Price'].dry_run_create += 1;
      continue;
    }
    candidates.push({ row, key, payload });
  }

  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < candidates.length) {
      const current = candidates[next];
      next += 1;
      const { row, payload } = current;
    try {
      const result = await requestJson(base, cookie, '/api/resource/Item Price', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      log.counts['Item Price'].created += 1;
      if (log.results.length < 500) {
        log.results.push({ doctype: 'Item Price', name: row.name, status: 'created', target: result.data && result.data.name });
      }
    } catch (err) {
      log.counts['Item Price'].failed += 1;
      log.results.push({ doctype: 'Item Price', name: row.name, status: 'failed', error: err.message, response: err.body, payload });
    }
      completed += 1;
      if (completed % 5000 === 0) console.log(`Item Price progress: ${completed}/${candidates.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;
  const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : 4;
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
    dateStrings: true,
  });
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);
  const maps = readMaps();
  const targetCompanies = await fetchAllResource(base, cookie, 'Company', ['name', 'abbr']);
  const oldCompanies = await oldRows(oldConn, 'Company', 'name');
  addCompanyMappings(targetCompanies, maps, oldCompanies[0] && oldCompanies[0].name);
  const company = targetCompanies.find((row) => row.abbr === 'SACL') || targetCompanies[0];

  const oldItems = await oldRows(oldConn, 'Item', 'name');
  const oldCategories = await oldRows(oldConn, 'Item Category', 'name');
  const oldItemPrices = await oldRows(oldConn, 'Item Price', 'modified desc, name');
  const uomChildren = indexChildren(await oldChildRows(oldConn, 'UOM Conversion Detail', 'Item'));
  const v15Items = await fetchAllResource(base, cookie, 'Item', ['name', 'item_code', 'stock_uom']);
  const v15Categories = await fetchAllResource(base, cookie, 'Item Category', ['name', 'item_category']);
  const v15ItemPrices = await fetchAllResource(base, cookie, 'Item Price', ['name', 'item_code', 'price_list', 'currency', 'buying', 'selling', 'uom']);
  const itemSet = new Set(v15Items.flatMap((row) => [row.name, row.item_code]).filter(Boolean));
  const itemCodeMap = new Map(oldItems.flatMap((row) => [
    [row.name, row.item_code || row.name],
    [row.item_code || row.name, row.item_code || row.name],
  ]));
  const itemUomMap = new Map([
    ...oldItems.flatMap((row) => [
      [row.name, row.stock_uom || 'Nos'],
      [row.item_code || row.name, row.stock_uom || 'Nos'],
    ]),
    ...v15Items.map((row) => [row.item_code, row.stock_uom || 'Nos']),
  ]);
  itemUomMap.codeMap = itemCodeMap;
  const itemCategoryNameMap = new Map(v15Categories.map((row) => [row.item_category || row.name, row.name]));
  const lookups = {
    Item: itemSet,
    ItemCodeMap: itemCodeMap,
    ItemUom: itemUomMap,
    Warehouse: new Set((await fetchAllResource(base, cookie, 'Warehouse', ['name'])).map((row) => row.name)),
    Account: new Set((await fetchAllResource(base, cookie, 'Account', ['name'])).map((row) => row.name)),
    'Cost Center': new Set((await fetchAllResource(base, cookie, 'Cost Center', ['name'])).map((row) => row.name)),
    Supplier: new Set((await fetchAllResource(base, cookie, 'Supplier', ['name'])).map((row) => row.name)),
    'Price List': new Set((await fetchAllResource(base, cookie, 'Price List', ['name'])).map((row) => row.name)),
    'Item Category': new Set(v15Categories.flatMap((row) => [row.name, row.item_category]).filter(Boolean)),
    ItemCategoryName: itemCategoryNameMap,
  };
  const existingPriceKeys = new Set(v15ItemPrices.map((row) => [
    row.item_code,
    row.price_list,
    row.currency || 'UGX',
    row.uom || lookups.ItemUom.get(row.item_code) || 'Nos',
  ].join('::').toLowerCase()));
  const latest = latestPriceRows(oldItemPrices, maps, lookups.ItemUom);

  const log = initLog(apply);
  log.target = base;
  log.counts['Item Price'].source = oldItemPrices.length;
  log.counts['Item Price'].latest_unique_source = latest.rows.length;
  log.counts['Item Price'].duplicate_old_rows_skipped = latest.duplicateRows;

  await importCategories({
    base,
    cookie,
    apply,
    log,
    rows: oldCategories,
    existingCategories: lookups['Item Category'],
  });
  await importItems({
    base,
    cookie,
    apply,
    log,
    rows: oldItems,
    existingItems: itemSet,
    uomChildren,
    maps,
    lookups,
    company,
  });
  for (const item of oldItems) itemSet.add(item.item_code);
  await importPrices({
    base,
    cookie,
    apply,
    log,
    rows: latest.rows,
    existingPriceKeys,
    maps,
    lookups,
    limit,
    concurrency,
  });

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create these records in v15.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
