const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase6-other-setup-import-log.json');
const phase1VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');
const phase3VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase3-verification.json');

const SYSTEM_FIELDS = new Set([
  'creation',
  'modified',
  'modified_by',
  'owner',
  'docstatus',
  'parent',
  'parentfield',
  'parenttype',
  'idx',
  'lft',
  'rgt',
  'old_parent',
  '_liked_by',
  '_comments',
  '_assign',
  '_user_tags',
  'amended_from',
]);

const SIMPLE_CUSTOM_DOCTYPES = [
  'Supply Report',
  'Part Name',
  'Towns',
  'Goods Transporter',
  'Price Master Login Audit',
  'Container',
  'Handler Worksheet',
  'Warehouse Stocking',
  'Budget Set',
  'Month',
  'Computed Profit n Loss Report',
  'Position',
  'receipt',
  'Penalty',
  'Year',
  'Items Cost',
  'Payslip',
  'Price Change Request',
  'Driver',
  'Motor Vehicle',
  'Area',
  'Vehicle',
  'Performance charges',
  'Ext Links',
];

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

function sqlIdent(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
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

function abbr(text) {
  return String(text || '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 10)
    .toUpperCase() || 'SC';
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function readMaps() {
  const maps = {
    ...(readJson(phase1VerificationPath).maps || {}),
  };
  const phase3 = readJson(phase3VerificationPath).maps || {};
  for (const [doctype, map] of Object.entries(phase3)) maps[doctype] = { ...(maps[doctype] || {}), ...map };
  maps.Company = { ...(maps.Company || {}), 'SUPERTEX APA CO. LTD': 'SUPERTEX APA CO LTD' };
  maps['Mode of Payment'] = { ...(maps['Mode of Payment'] || {}) };
  const phase2 = readJson(path.join(__dirname, '..', 'audits', 'v15-master-data-phase2-import-log.json'));
  for (const row of phase2.results || []) {
    if (row.doctype === 'Mode of Payment' && row.target) maps['Mode of Payment'][row.name] = row.target;
  }
  maps['Letter Head'] = { ...(maps['Letter Head'] || {}) };
  return maps;
}

function mapValue(maps, mapName, value) {
  if (!value) return value;
  return (maps[mapName] && maps[mapName][value]) || value;
}

function mapFieldValue(maps, fieldname, value) {
  const fieldMap = {
    account: 'Account',
    account_for_change_amount: 'Account',
    cash_bank_account: 'Account',
    company: 'Company',
    cost_center: 'Cost Center',
    customer: 'Customer',
    customer_group: 'Customer Group',
    default_warehouse: 'Warehouse',
    employee: 'Employee',
    manager: 'Employee',
    store_manager: 'Employee',
    expense_account: 'Account',
    for_price_list: 'Price List',
    free_item: 'Item',
    income_account: 'Account',
    item: 'Item',
    item_code: 'Item',
    item_name: 'Item',
    item_group: 'Item Group',
    letter_head: 'Letter Head',
    mode_of_payment: 'Mode of Payment',
    new_item_code: 'Item',
    pricelist: 'Price List',
    selling_price_list: 'Price List',
    shop: 'Warehouse',
    supplier: 'Supplier',
    customer_or_consignee: 'Supplier',
    agent_mombasa: 'Supplier',
    agent_malaba: 'Supplier',
    agent_ura: 'Supplier',
    territory: 'Territory',
    warehouse: 'Warehouse',
    write_off_account: 'Account',
    write_off_cost_center: 'Cost Center',
  };
  const mapName = fieldMap[fieldname];
  return mapName ? mapValue(maps, mapName, value) : value;
}

async function tableExists(conn, doctype) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [`tab${doctype}`],
  );
  return Boolean(rows[0].n);
}

async function columns(conn, doctype) {
  if (!(await tableExists(conn, doctype))) return [];
  const [rows] = await conn.query(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position',
    [`tab${doctype}`],
  );
  return rows.map((row) => row.column_name);
}

async function oldRows(conn, doctype, order = 'name') {
  if (!(await tableExists(conn, doctype))) return [];
  const [rows] = await conn.query(`select * from ${sqlIdent(`tab${doctype}`)} order by ${order}`);
  return rows;
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

async function docMeta(base, cookie, doctype) {
  const result = await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(doctype)}`);
  const fields = result.data.fields || [];
  return {
    name: doctype,
    istable: Number(result.data.istable || 0),
    fields,
    fieldMap: new Map(fields.filter((field) => field.fieldname).map((field) => [field.fieldname, field])),
  };
}

async function existingSet(base, cookie, doctype) {
  try {
    return new Set((await fetchAllResource(base, cookie, doctype, ['name'])).map((row) => row.name));
  } catch {
    return new Set();
  }
}

async function createDoc(base, cookie, payload) {
  const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(payload.doctype)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return result.data;
}

async function ensureItem(base, cookie, linkSets, itemCode, itemName) {
  if (!itemCode || linkSets.Item.has(itemCode)) return;
  const categoryRows = await fetchAllResource(base, cookie, 'Item Category', ['name', 'item_category']);
  const itemCategory = (categoryRows.find((row) => row.name === 'LUBRICANTS') || categoryRows.find((row) => row.name === 'OTHER PARTS') || categoryRows[0] || {}).name;
  const payload = clean({
    doctype: 'Item',
    name: itemCode,
    item_code: itemCode,
    item_name: itemName || itemCode,
    item_group: 'Products',
    stock_uom: 'Unit',
    item_category: itemCategory,
    cost: 0,
    rrp: 0,
    is_stock_item: 0,
    is_sales_item: 1,
    is_purchase_item: 0,
    disabled: 0,
  });
  const created = await createDoc(base, cookie, payload);
  linkSets.Item.add(created.name || itemCode);
}

function addResult(log, doctype, name, status, extra = {}) {
  if (!log.counts[doctype]) {
    log.counts[doctype] = { source: 0, skipped_existing: 0, skipped_missing_link: 0, created: 0, failed: 0 };
  }
  if (status in log.counts[doctype]) log.counts[doctype][status] += 1;
  log.results.push({ doctype, name, status, ...extra });
}

function existingLookupMaps(targets) {
  const lookup = {};
  for (const [doctype, names] of Object.entries(targets)) lookup[doctype] = names;
  return lookup;
}

function linkExists(linkSets, doctype, value) {
  if (!value || !doctype) return true;
  const set = linkSets[doctype];
  return !set || set.has(value);
}

function validateLinks(payload, meta, linkSets) {
  const missing = [];
  for (const [fieldname, value] of Object.entries(payload)) {
    const field = meta.fieldMap.get(fieldname);
    if (!field || field.fieldtype !== 'Link' || !value) continue;
    if (!linkSets[field.options]) {
      delete payload[fieldname];
      missing.push({ field: fieldname, doctype: field.options, value, dropped_untracked_link: true });
      continue;
    }
    if (!linkExists(linkSets, field.options, value)) {
      delete payload[fieldname];
      missing.push({ field: fieldname, doctype: field.options, value });
    }
  }
  return missing;
}

async function importRows({ base, cookie, oldRowsList, doctype, payloadFor, existing, log }) {
  log.counts[doctype] = log.counts[doctype] || { source: oldRowsList.length, skipped_existing: 0, skipped_missing_link: 0, created: 0, failed: 0 };
  log.counts[doctype].source = oldRowsList.length;
  for (const row of oldRowsList) {
    const name = row.name;
    if (existing.has(name)) {
      addResult(log, doctype, name, 'skipped_existing');
      continue;
    }
    let payload;
    try {
      payload = payloadFor(row);
      if (!payload) {
        addResult(log, doctype, name, 'skipped_missing_link', { reason: 'No payload after link validation.' });
        continue;
      }
      const created = await createDoc(base, cookie, payload);
      existing.add(created.name || name);
      addResult(log, doctype, name, 'created', { target: created.name });
    } catch (err) {
      addResult(log, doctype, name, 'failed', {
        error: err.message,
        response: err.body,
        payload,
      });
    }
  }
}

function genericPayload(row, doctype, oldCols, meta, maps, linkSets) {
  const payload = { doctype, name: row.name };
  for (const field of meta.fields) {
    const fieldname = field.fieldname;
    if (!fieldname || SYSTEM_FIELDS.has(fieldname) || field.fieldtype === 'Table') continue;
    if (!oldCols.includes(fieldname)) continue;
    let value = row[fieldname];
    if (field.fieldtype === 'Date') value = dateOnly(value);
    if (field.fieldtype === 'Datetime' && value) {
      value = value instanceof Date
        ? value.toISOString().slice(0, 19).replace('T', ' ')
        : String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '').slice(0, 19);
    }
    value = mapFieldValue(maps, fieldname, value);
    if (value !== undefined && value !== null && value !== '') payload[fieldname] = value;
  }
  const missing = validateLinks(payload, meta, linkSets);
  const requiredMissing = meta.fields
    .filter((field) => field.reqd && field.fieldtype !== 'Table')
    .filter((field) => !payload[field.fieldname])
    .map((field) => field.fieldname);
  if (requiredMissing.length) return { payload: null, missing: [...missing, ...requiredMissing.map((field) => ({ field, required: true }))] };
  return { payload: clean(payload), missing };
}

function salesPersonPayload(row, maps, linkSets) {
  const payload = clean({
    doctype: 'Sales Person',
    name: row.name,
    sales_person_name: row.sales_person_name || row.name,
    parent_sales_person: row.parent_sales_person || undefined,
    is_group: flag(row.is_group),
    enabled: row.enabled === undefined ? 1 : flag(row.enabled, 1),
    employee: mapValue(maps, 'Employee', row.employee),
  });
  if (payload.employee && !linkExists(linkSets, 'Employee', payload.employee)) delete payload.employee;
  if (payload.parent_sales_person && !linkExists(linkSets, 'Sales Person', payload.parent_sales_person)) delete payload.parent_sales_person;
  return payload;
}

function pricingRulePayload(row, maps, linkSets) {
  const applyOn = row.apply_on || 'Item Code';
  const priceOrDiscount = row.price_or_discount === 'Price' ? 'Price' : 'Discount';
  const payload = clean({
    doctype: 'Pricing Rule',
    name: row.name,
    title: row.title || row.name,
    disable: flag(row.disable),
    apply_on: applyOn,
    price_or_product_discount: priceOrDiscount,
    selling: flag(row.selling),
    buying: flag(row.buying),
    applicable_for: row.applicable_for,
    min_qty: row.min_qty,
    max_qty: Number(row.max_qty || 0) ? row.max_qty : undefined,
    valid_from: dateOnly(row.valid_from),
    valid_upto: dateOnly(row.valid_upto),
    company: mapValue(maps, 'Company', row.company),
    currency: 'UGX',
    rate_or_discount: priceOrDiscount === 'Price' ? 'Rate' : 'Discount Percentage',
    rate: priceOrDiscount === 'Price' ? row.price : undefined,
    discount_percentage: priceOrDiscount === 'Price' ? undefined : row.discount_percentage,
    priority: row.priority ? String(row.priority) : undefined,
    customer: mapValue(maps, 'Customer', row.customer),
    customer_group: mapValue(maps, 'Customer Group', row.customer_group),
    supplier: mapValue(maps, 'Supplier', row.supplier),
    territory: mapValue(maps, 'Territory', row.territory),
    for_price_list: mapValue(maps, 'Price List', row.for_price_list),
  });
  if (applyOn === 'Item Code' && row.item_code) {
    const item = mapValue(maps, 'Item', row.item_code);
    if (!linkExists(linkSets, 'Item', item)) return null;
    payload.items = [{ doctype: 'Pricing Rule Item Code', item_code: item }];
  } else if (applyOn === 'Item Group' && row.item_group) {
    const itemGroup = mapValue(maps, 'Item Group', row.item_group);
    if (!linkExists(linkSets, 'Item Group', itemGroup)) return null;
    payload.item_groups = [{ doctype: 'Pricing Rule Item Group', item_group: itemGroup }];
  } else if (applyOn === 'Brand' && row.brand) {
    const brand = mapValue(maps, 'Brand', row.brand);
    if (!linkExists(linkSets, 'Brand', brand)) return null;
    payload.brands = [{ doctype: 'Pricing Rule Brand', brand }];
  } else if (applyOn !== 'Transaction') {
    return null;
  }
  for (const [field, doctype] of [
    ['customer', 'Customer'],
    ['customer_group', 'Customer Group'],
    ['supplier', 'Supplier'],
    ['territory', 'Territory'],
    ['for_price_list', 'Price List'],
    ['company', 'Company'],
  ]) {
    if (payload[field] && !linkExists(linkSets, doctype, payload[field])) delete payload[field];
  }
  return payload;
}

function posProfilePayload(row, maps, linkSets) {
  const company = mapValue(maps, 'Company', row.company);
  const warehouse = mapValue(maps, 'Warehouse', row.warehouse);
  const mode = mapValue(maps, 'Mode of Payment', row.mode_of_payment);
  const writeOffAccount = mapValue(maps, 'Account', row.write_off_account);
  const writeOffCostCenter = mapValue(maps, 'Cost Center', row.write_off_cost_center || row.cost_center);
  if (!linkExists(linkSets, 'Company', company) || !linkExists(linkSets, 'Warehouse', warehouse) || !linkExists(linkSets, 'Mode of Payment', mode)) return null;
  if (!linkExists(linkSets, 'Account', writeOffAccount) || !linkExists(linkSets, 'Cost Center', writeOffCostCenter)) return null;
  const payload = clean({
    doctype: 'POS Profile',
    name: row.name,
    company,
    customer: mapValue(maps, 'Customer', row.customer),
    disabled: 0,
    warehouse,
    hide_images: 0,
    payments: [{ doctype: 'POS Payment Method', mode_of_payment: mode, default: 1 }],
    print_format: row.print_format,
    letter_head: mapValue(maps, 'Letter Head', row.letter_head),
    tc_name: mapValue(maps, 'Terms and Conditions', row.tc_name),
    select_print_heading: row.select_print_heading,
    selling_price_list: mapValue(maps, 'Price List', row.selling_price_list) || 'Standard Selling',
    currency: row.currency || 'UGX',
    write_off_account: writeOffAccount,
    write_off_cost_center: writeOffCostCenter,
    write_off_limit: 1,
    income_account: mapValue(maps, 'Account', row.income_account),
    expense_account: mapValue(maps, 'Account', row.expense_account),
    cost_center: mapValue(maps, 'Cost Center', row.cost_center),
  });
  for (const [field, doctype] of [
    ['customer', 'Customer'],
    ['letter_head', 'Letter Head'],
    ['tc_name', 'Terms and Conditions'],
    ['select_print_heading', 'Print Heading'],
    ['selling_price_list', 'Price List'],
    ['income_account', 'Account'],
    ['expense_account', 'Account'],
    ['cost_center', 'Cost Center'],
  ]) {
    if (payload[field] && !linkExists(linkSets, doctype, payload[field])) delete payload[field];
  }
  return payload;
}

async function syncModeOfPaymentAccounts({ base, cookie, oldConn, maps, linkSets, log }) {
  const rows = await oldRows(oldConn, 'Mode of Payment Account');
  log.counts['Mode of Payment Account'] = { source: rows.length, skipped_existing: 0, skipped_missing_link: 0, created: 0, failed: 0 };
  for (const row of rows) {
    const mode = mapValue(maps, 'Mode of Payment', row.parent);
    const company = mapValue(maps, 'Company', row.company);
    const account = mapValue(maps, 'Account', row.default_account);
    if (!linkExists(linkSets, 'Mode of Payment', mode) || !linkExists(linkSets, 'Company', company) || !linkExists(linkSets, 'Account', account)) {
      addResult(log, 'Mode of Payment Account', row.name, 'skipped_missing_link', { mode, company, account });
      continue;
    }
    try {
      const doc = (await requestJson(base, cookie, `/api/resource/Mode%20of%20Payment/${encodeURIComponent(mode)}`)).data;
      const accounts = doc.accounts || [];
      if (accounts.some((child) => child.company === company && child.default_account === account)) {
        addResult(log, 'Mode of Payment Account', row.name, 'skipped_existing', { mode });
        continue;
      }
      accounts.push({ doctype: 'Mode of Payment Account', company, default_account: account });
      await requestJson(base, cookie, `/api/resource/Mode%20of%20Payment/${encodeURIComponent(mode)}`, {
        method: 'PUT',
        body: JSON.stringify({ accounts }),
      });
      addResult(log, 'Mode of Payment Account', row.name, 'created', { mode });
    } catch (err) {
      addResult(log, 'Mode of Payment Account', row.name, 'failed', { error: err.message, response: err.body, mode });
    }
  }
}

function salaryComponentPayload(name, type) {
  return clean({
    doctype: 'Salary Component',
    name,
    salary_component: name,
    salary_component_abbr: abbr(name),
    type,
    depends_on_payment_days: type === 'Earning' ? 1 : 0,
  });
}

function salaryStructurePayload(row, earnings, deductions, maps, linkSets) {
  const employee = mapValue(maps, 'Employee', row.employee);
  const company = mapValue(maps, 'Company', row.company);
  if (!linkExists(linkSets, 'Employee', employee) || !linkExists(linkSets, 'Company', company)) return null;
  return clean({
    doctype: 'Salary Structure',
    name: row.name,
    company,
    letter_head: mapValue(maps, 'Letter Head', row.letter_head),
    is_active: row.is_active === 'No' ? 'No' : 'Yes',
    is_default: 'No',
    currency: 'UGX',
    salary_slip_based_on_timesheet: 0,
    payroll_frequency: 'Monthly',
    total_earning: row.total_earning,
    total_deduction: row.total_deduction,
    net_pay: row.net_pay,
    earnings: earnings.map((child) => clean({
      doctype: 'Salary Detail',
      salary_component: child.e_type,
      amount: child.modified_value,
      depends_on_payment_days: flag(child.depend_on_lwp, 1),
    })),
    deductions: deductions.map((child) => clean({
      doctype: 'Salary Detail',
      salary_component: child.d_type,
      amount: child.d_modified_amt,
      depends_on_payment_days: flag(child.depend_on_lwp),
    })),
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);
  const maps = readMaps();

  const linkDoctypes = [
    'Account',
    'Brand',
    'Company',
    'Cost Center',
    'Customer',
    'Customer Group',
    'Employee',
    'Item',
    'Item Group',
    'Letter Head',
    'Mode of Payment',
    'Price List',
    'Print Heading',
    'Supplier',
    'Terms and Conditions',
    'Territory',
    'UOM',
    'Warehouse',
    'Warehouse Type',
  ];
  const linkSets = existingLookupMaps(Object.fromEntries(await Promise.all(
    linkDoctypes.map(async (doctype) => [doctype, await existingSet(base, cookie, doctype)]),
  )));
  if (!maps.LetterHead) maps.LetterHead = {};

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {},
    results: [],
  };

  const runImport = async (doctype, rows, payloadFor) => {
    const existing = await existingSet(base, cookie, doctype);
    if (!apply) {
      log.counts[doctype] = { source: rows.length, skipped_existing: rows.filter((row) => existing.has(row.name)).length, skipped_missing_link: 0, created: rows.filter((row) => !existing.has(row.name)).length, failed: 0 };
      return;
    }
    await importRows({ base, cookie, oldRowsList: rows, doctype, payloadFor, existing, log });
    linkSets[doctype] = await existingSet(base, cookie, doctype);
  };

  const letterHeads = await oldRows(oldConn, 'Letter Head');
  const letterHeadMeta = await docMeta(base, cookie, 'Letter Head');
  const letterHeadCols = await columns(oldConn, 'Letter Head');
  await runImport('Letter Head', letterHeads, (row) => {
    const { payload } = genericPayload(row, 'Letter Head', letterHeadCols, letterHeadMeta, maps, linkSets);
    if (payload) {
      payload.name = row.name;
      payload.letter_head_name = row.letter_head_name || row.name;
      if (!payload.source) payload.source = payload.content ? 'HTML' : 'Image';
    }
    return payload;
  });

  await runImport('Sales Person', await oldRows(oldConn, 'Sales Person', 'is_group desc, name'), (row) => salesPersonPayload(row, maps, linkSets));

  await runImport('Leave Type', await oldRows(oldConn, 'Leave Type'), (row) => clean({
    doctype: 'Leave Type',
    name: row.name,
    leave_type_name: row.leave_type_name || row.name,
    max_leaves_allowed: row.max_leaves_allowed,
    is_lwp: flag(row.is_lwp),
    is_carry_forward: flag(row.is_carry_forward),
    include_holiday: flag(row.include_holiday),
  }));

  const earningNames = new Set((await oldRows(oldConn, 'Earning Type')).map((row) => row.name));
  const deductionNames = new Set((await oldRows(oldConn, 'Deduction Type')).map((row) => row.name));
  const salaryEarnings = await oldRows(oldConn, 'Salary Structure Earning');
  const salaryDeductions = await oldRows(oldConn, 'Salary Structure Deduction');
  salaryEarnings.forEach((row) => row.e_type && earningNames.add(row.e_type));
  salaryDeductions.forEach((row) => row.d_type && deductionNames.add(row.d_type));
  await runImport('Salary Component', [...earningNames].map((name) => ({ name, type: 'Earning' })), (row) => salaryComponentPayload(row.name, row.type));
  await runImport('Salary Component', [...deductionNames].map((name) => ({ name, type: 'Deduction' })), (row) => salaryComponentPayload(row.name, row.type));
  linkSets['Salary Component'] = await existingSet(base, cookie, 'Salary Component');

  const earningsByParent = new Map();
  for (const row of salaryEarnings) {
    if (!earningsByParent.has(row.parent)) earningsByParent.set(row.parent, []);
    earningsByParent.get(row.parent).push(row);
  }
  const deductionsByParent = new Map();
  for (const row of salaryDeductions) {
    if (!deductionsByParent.has(row.parent)) deductionsByParent.set(row.parent, []);
    deductionsByParent.get(row.parent).push(row);
  }
  await runImport('Salary Structure', await oldRows(oldConn, 'Salary Structure'), (row) => salaryStructurePayload(
    row,
    earningsByParent.get(row.name) || [],
    deductionsByParent.get(row.name) || [],
    maps,
    linkSets,
  ));

  await runImport('Currency Exchange', await oldRows(oldConn, 'Currency Exchange'), (row) => {
    const [fromCurrency, toCurrency] = String(row.name || '').split('-');
    const payload = clean({
      doctype: 'Currency Exchange',
      name: row.name,
      date: dateOnly(row.date) || dateOnly(row.modified) || new Date().toISOString().slice(0, 10),
      from_currency: row.from_currency || fromCurrency,
      to_currency: row.to_currency || toCurrency,
      exchange_rate: row.exchange_rate || row.exchange_rate_buying || row.exchange_rate_selling || 1,
      for_buying: 1,
      for_selling: 1,
    });
    if (!linkExists(linkSets, 'Currency', payload.from_currency) || !linkExists(linkSets, 'Currency', payload.to_currency)) return null;
    return payload;
  });

  await runImport('Item Attribute', await oldRows(oldConn, 'Item Attribute'), (row) => clean({
    doctype: 'Item Attribute',
    name: row.name,
    attribute_name: row.attribute_name || row.name,
    numeric_values: flag(row.numeric_values),
    disabled: flag(row.disabled),
  }));

  const productBundleItems = await oldRows(oldConn, 'Product Bundle Item');
  const productBundleChildren = new Map();
  for (const row of productBundleItems) {
    if (!productBundleChildren.has(row.parent)) productBundleChildren.set(row.parent, []);
    productBundleChildren.get(row.parent).push(row);
  }
  if (apply) {
    for (const row of await oldRows(oldConn, 'Product Bundle')) {
      await ensureItem(base, cookie, linkSets, row.new_item_code || row.name, row.description || row.name);
    }
  }
  await runImport('Product Bundle', await oldRows(oldConn, 'Product Bundle'), (row) => {
    const newItem = mapValue(maps, 'Item', row.new_item_code || row.name);
    if (!linkExists(linkSets, 'Item', newItem)) return null;
    const items = (productBundleChildren.get(row.name) || [])
      .map((child) => clean({
        doctype: 'Product Bundle Item',
        item_code: mapValue(maps, 'Item', child.item_code),
        qty: Number(child.qty || 1),
        description: child.description,
        rate: Number(child.rate || 0),
        uom: child.uom,
      }))
      .filter((child) => linkExists(linkSets, 'Item', child.item_code));
    if (!items.length) return null;
    return clean({
      doctype: 'Product Bundle',
      name: row.name,
      new_item_code: newItem,
      description: row.description,
      disabled: flag(row.disabled),
      items,
    });
  });

  await runImport('Pricing Rule', await oldRows(oldConn, 'Pricing Rule'), (row) => pricingRulePayload(row, maps, linkSets));
  if (apply) await syncModeOfPaymentAccounts({ base, cookie, oldConn, maps, linkSets, log });
  await runImport('POS Profile', await oldRows(oldConn, 'POS Profile'), (row) => posProfilePayload(row, maps, linkSets));

  const approvedMeta = await docMeta(base, cookie, 'Approved Discounts');
  const approvedCols = await columns(oldConn, 'Approved Discounts');
  await runImport('Approved Discounts', await oldRows(oldConn, 'Approved Discounts'), (row) => {
    const { payload } = genericPayload(row, 'Approved Discounts', approvedCols, approvedMeta, maps, linkSets);
    return payload;
  });

  const maxStockRows = await oldRows(oldConn, 'maximum stock');
  const maxStockByParent = new Map();
  for (const row of maxStockRows) {
    if (!maxStockByParent.has(row.parent)) maxStockByParent.set(row.parent, []);
    maxStockByParent.get(row.parent).push(row);
  }
  await runImport('Warehouse Maximum Stock', await oldRows(oldConn, 'Warehouse Maximum Stock'), (row) => {
    const shop = mapValue(maps, 'Warehouse', row.shop);
    if (!linkExists(linkSets, 'Warehouse', shop)) return null;
    const children = (maxStockByParent.get(row.name) || [])
      .map((child) => clean({
        doctype: 'maximum stock',
        item_name: mapValue(maps, 'Item', child.item_name),
        warehouse: mapValue(maps, 'Warehouse', child.warehouse),
        category: child.category,
        code: child.code,
        maximum_qty: child.maximum_qty,
        reorder_qty: child.reorder_qty,
        approved: flag(child.approved),
      }))
      .filter((child) => linkExists(linkSets, 'Item', child.item_name) && linkExists(linkSets, 'Warehouse', child.warehouse));
    return clean({
      doctype: 'Warehouse Maximum Stock',
      name: row.name,
      shop,
      item_maximum_stock: children,
    });
  });

  for (const doctype of SIMPLE_CUSTOM_DOCTYPES) {
    const rows = await oldRows(oldConn, doctype);
    if (!rows.length) continue;
    const meta = await docMeta(base, cookie, doctype);
    const oldCols = await columns(oldConn, doctype);
    await runImport(doctype, rows, (row) => {
      if (doctype === 'Container') {
        const payload = clean({
          doctype,
          name: row.name,
          naming_series: row.naming_series,
          booking_date: dateOnly(row.booking_date),
          loading_date: dateOnly(row.loading_date),
          seal_number: row.seal_number,
          eta: dateOnly(row.eta),
          container_number: row.container_number || row.name,
          booking_ref: row.booking_ref,
          customer_or_consignee: mapValue(maps, 'Supplier', row.customer_or_consignee),
          shipping_line: row.shipping_line,
          china_truck: row.china_truck,
          driver_phone: row.driver_phone,
          freight_company: row.freight_company,
          cartons: Number(row.cartons || 0),
          declared_weight: Number(row.declared_weight || 0),
          agent_mombasa: mapValue(maps, 'Supplier', row.agent_mombasa),
          agent_malaba: mapValue(maps, 'Supplier', row.agent_malaba),
          agent_ura: mapValue(maps, 'Supplier', row.agent_ura),
          tax_year: row.tax_year,
          entry_number: row.entry_number,
          value_of_goods: Number(row.value_of_goods || 0),
          usd_rate_ura: Number(row.usd_rate_ura || 0),
          assesment_number: row.assesment_number,
          exit_date: dateOnly(row.exit_date),
          import_duty: Number(row.import_duty || 0),
          with_holding_tax: Number(row.with_holding_tax || 0),
          duty_paid: Number(row.duty_paid || 0),
          c_and_f_mbsa_to_kla: Number(row.c_and_f_mbsa_to_kla || 0),
          vat: Number(row.vat || 0),
          inf_levy: Number(row.inf_levy || 0),
          cost_plus_duty: Number(row.cost_plus_duty || 0),
          identity: Number(row.identity || 0),
          cartons_offloaded: Number(row.cartons_offloaded || 0),
          truck_hire_costs: Number(row.truck_hire_costs || 0),
          cartons_1st_delivered: Number(row.cartons_1st_delivered || 0),
          offloading_costs: Number(row.offloading_costs || 0),
          reference: row.reference || row.booking_ref || row.container_number || row.name,
        });
        for (const field of ['customer_or_consignee', 'agent_mombasa', 'agent_malaba', 'agent_ura']) {
          if (payload[field] && !linkExists(linkSets, 'Supplier', payload[field])) delete payload[field];
        }
        return payload;
      }
      if (doctype === 'Driver') {
        const employee = mapValue(maps, 'Employee', row.employee || row.emloyee);
        const payload = clean({
          doctype,
          name: row.name,
          naming_series: row.naming_series,
          full_name: row.full_name || row.name,
          status: row.status || 'Active',
          employee: linkExists(linkSets, 'Employee', employee) ? employee : undefined,
          cell_number: row.cell_number,
        });
        return payload;
      }
      if (doctype === 'Vehicle') {
        const employee = mapValue(maps, 'Employee', row.employee);
        const payload = clean({
          doctype,
          name: row.name,
          license_plate: row.license_plate || row.registration_number || row.name,
          make: row.make || row.vehicle_make || 'Unknown',
          model: row.model || row.vehicle_model || 'Unknown',
          last_odometer: Number(row.last_odometer || 0),
          acquisition_date: dateOnly(row.acquisition_date),
          employee: linkExists(linkSets, 'Employee', employee) ? employee : undefined,
          fuel_type: row.fuel_type || 'Diesel',
          uom: row.uom || 'Ltr',
        });
        if (!linkExists(linkSets, 'UOM', payload.uom)) payload.uom = 'Nos';
        return payload;
      }
      if (doctype === 'Vehicle') {
        const { payload } = genericPayload(row, doctype, oldCols, meta, maps, linkSets);
        if (payload) {
          payload.license_plate = payload.license_plate || row.registration_number || row.name;
          payload.make = payload.make || row.vehicle_make || 'Unknown';
          payload.model = payload.model || row.vehicle_model || 'Unknown';
          payload.last_odometer = payload.last_odometer || 0;
          payload.fuel_type = payload.fuel_type || 'Diesel';
          payload.uom = payload.uom || 'Ltr';
        }
        return payload;
      }
      if (doctype === 'Vehicle') {
        const { payload } = genericPayload(row, doctype, oldCols, meta, maps, linkSets);
        if (payload) {
          payload.license_plate = payload.license_plate || row.registration_number || row.name;
          payload.make = payload.make || row.vehicle_make || 'Unknown';
          payload.model = payload.model || row.vehicle_model || 'Unknown';
          payload.last_odometer = payload.last_odometer || 0;
          payload.fuel_type = payload.fuel_type || 'Diesel';
          payload.uom = payload.uom || 'Ltr';
        }
        return payload;
      }
      const { payload } = genericPayload(row, doctype, oldCols, meta, maps, linkSets);
      return payload;
    });
  }

  await oldConn.end();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create records.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
