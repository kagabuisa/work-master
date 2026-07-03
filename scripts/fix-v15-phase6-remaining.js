const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-phase6-remaining-fix-log.json');

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

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

function dateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function readMaps() {
  const maps = { ...(readJson(path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json')).maps || {}) };
  const phase3 = readJson(path.join(__dirname, '..', 'audits', 'v15-master-data-phase3-verification.json')).maps || {};
  for (const [doctype, map] of Object.entries(phase3)) maps[doctype] = { ...(maps[doctype] || {}), ...map };
  maps.Company = { ...(maps.Company || {}), 'SUPERTEX APA CO. LTD': 'SUPERTEX APA CO LTD' };
  maps['Mode of Payment'] = { ...(maps['Mode of Payment'] || {}) };
  const phase2 = readJson(path.join(__dirname, '..', 'audits', 'v15-master-data-phase2-import-log.json'));
  for (const row of phase2.results || []) {
    if (row.doctype === 'Mode of Payment' && row.target) maps['Mode of Payment'][row.name] = row.target;
  }
  return maps;
}

function mapValue(maps, doctype, value) {
  if (!value) return value;
  return (maps[doctype] && maps[doctype][value]) || value;
}

async function oldRows(conn, doctype, order = 'name') {
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

async function fetchAll(base, cookie, doctype, fields) {
  const out = [];
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({ fields: JSON.stringify(fields), limit_start: String(start), limit_page_length: '500' });
    const rows = (await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`)).data || [];
    out.push(...rows);
    if (rows.length < 500) break;
    start += 500;
  }
  return out;
}

async function existingSet(base, cookie, doctype) {
  return new Set((await fetchAll(base, cookie, doctype, ['name'])).map((row) => row.name));
}

function exists(sets, doctype, value) {
  return !value || (sets[doctype] && sets[doctype].has(value));
}

async function create(base, cookie, payload) {
  return (await requestJson(base, cookie, `/api/resource/${encodeURIComponent(payload.doctype)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })).data;
}

function add(log, doctype, name, status, extra = {}) {
  if (!log.counts[doctype]) log.counts[doctype] = { created: 0, skipped_existing: 0, skipped_missing_link: 0, failed: 0 };
  if (status in log.counts[doctype]) log.counts[doctype][status] += 1;
  log.results.push({ doctype, name, status, ...extra });
}

async function main() {
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  const cookie = await login(base, usr, pwd);
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });
  const maps = readMaps();
  const sets = {};
  for (const dt of ['Account', 'Company', 'Cost Center', 'Customer', 'Employee', 'Item', 'Mode of Payment', 'Price List', 'Supplier', 'UOM', 'Warehouse']) {
    sets[dt] = await existingSet(base, cookie, dt);
  }
  const log = { generated_at: new Date().toISOString(), target: base, counts: {}, results: [] };

  for (const row of await oldRows(oldConn, 'Mode of Payment Account')) {
    const mode = mapValue(maps, 'Mode of Payment', row.parent);
    const company = mapValue(maps, 'Company', row.company);
    const account = mapValue(maps, 'Account', row.default_account);
    if (!exists(sets, 'Mode of Payment', mode) || !exists(sets, 'Company', company) || !exists(sets, 'Account', account)) {
      add(log, 'Mode of Payment Account', row.name, 'skipped_missing_link', { mode, company, account });
      continue;
    }
    try {
      const doc = (await requestJson(base, cookie, `/api/resource/Mode%20of%20Payment/${encodeURIComponent(mode)}`)).data;
      const accounts = doc.accounts || [];
      if (accounts.some((child) => child.company === company && child.default_account === account)) {
        add(log, 'Mode of Payment Account', row.name, 'skipped_existing', { mode });
        continue;
      }
      accounts.push({ doctype: 'Mode of Payment Account', company, default_account: account });
      await requestJson(base, cookie, `/api/resource/Mode%20of%20Payment/${encodeURIComponent(mode)}`, {
        method: 'PUT',
        body: JSON.stringify({ accounts }),
      });
      add(log, 'Mode of Payment Account', row.name, 'created', { mode });
    } catch (err) {
      add(log, 'Mode of Payment Account', row.name, 'failed', { error: err.message, response: err.body });
    }
  }

  const bundleExisting = await existingSet(base, cookie, 'Product Bundle');
  if (!bundleExisting.has('Shell HX3 Carton')) {
    const children = await oldRows(oldConn, 'Product Bundle Item');
    const items = children.filter((row) => row.parent === 'Shell HX3 Carton')
      .map((row) => clean({
        doctype: 'Product Bundle Item',
        item_code: mapValue(maps, 'Item', row.item_code),
        qty: Number(row.qty || 1),
        description: row.description,
        rate: Number(row.rate || 0),
        uom: row.uom,
      }))
      .filter((row) => exists(sets, 'Item', row.item_code));
    try {
      await create(base, cookie, { doctype: 'Product Bundle', name: 'Shell HX3 Carton', new_item_code: 'Shell HX3 Carton', items });
      add(log, 'Product Bundle', 'Shell HX3 Carton', 'created');
    } catch (err) {
      add(log, 'Product Bundle', 'Shell HX3 Carton', 'failed', { error: err.message, response: err.body });
    }
  } else {
    add(log, 'Product Bundle', 'Shell HX3 Carton', 'skipped_existing');
  }

  const posExisting = await existingSet(base, cookie, 'POS Profile');
  const cpuWarehouse = sets.Warehouse.has('CPU Stores WHse - SACL') ? 'CPU Stores WHse - SACL' : [...sets.Warehouse][0];
  for (const row of await oldRows(oldConn, 'POS Profile')) {
    if (posExisting.has(row.name)) {
      add(log, 'POS Profile', row.name, 'skipped_existing');
      continue;
    }
    const mode = mapValue(maps, 'Mode of Payment', row.mode_of_payment) || 'Cash';
    const payload = clean({
      doctype: 'POS Profile',
      name: row.name,
      company: mapValue(maps, 'Company', row.company),
      disabled: 0,
      warehouse: mapValue(maps, 'Warehouse', row.warehouse) || cpuWarehouse,
      payments: [{ doctype: 'POS Payment Method', mode_of_payment: exists(sets, 'Mode of Payment', mode) ? mode : 'Cash', default: 1 }],
      letter_head: 'st',
      selling_price_list: mapValue(maps, 'Price List', row.selling_price_list) || 'Standard Selling',
      currency: row.currency || 'UGX',
      write_off_account: mapValue(maps, 'Account', row.write_off_account) || '5214 - Sales Expenses - SACL',
      write_off_cost_center: mapValue(maps, 'Cost Center', row.write_off_cost_center || row.cost_center) || 'CPU CTC - SACL',
      write_off_limit: 1,
      income_account: mapValue(maps, 'Account', row.income_account),
      expense_account: mapValue(maps, 'Account', row.expense_account),
      cost_center: mapValue(maps, 'Cost Center', row.cost_center) || 'CPU CTC - SACL',
    });
    try {
      await create(base, cookie, payload);
      add(log, 'POS Profile', row.name, 'created');
    } catch (err) {
      add(log, 'POS Profile', row.name, 'failed', { error: err.message, response: err.body, payload });
    }
  }

  const containerExisting = await existingSet(base, cookie, 'Container');
  for (const row of await oldRows(oldConn, 'Container')) {
    if (containerExisting.has(row.name)) {
      add(log, 'Container', row.name, 'skipped_existing');
      continue;
    }
    const payload = clean({
      doctype: 'Container',
      name: row.name,
      booking_date: dateOnly(row.booking_date),
      loading_date: dateOnly(row.loading_date),
      seal_number: row.seal_number,
      eta: dateOnly(row.eta),
      container_number: row.container_number || row.name,
      booking_ref: row.booking_ref,
      customer_or_consignee: exists(sets, 'Supplier', mapValue(maps, 'Supplier', row.customer_or_consignee)) ? mapValue(maps, 'Supplier', row.customer_or_consignee) : undefined,
      shipping_line: row.shipping_line,
      china_truck: row.china_truck,
      driver_phone: row.driver_phone,
      freight_company: row.freight_company,
      cartons: Number(row.cartons || 0),
      declared_weight: Number(row.declared_weight || 0),
      reference: row.reference || row.booking_ref || row.container_number || row.name,
    });
    try {
      await create(base, cookie, payload);
      add(log, 'Container', row.name, 'created');
    } catch (err) {
      add(log, 'Container', row.name, 'failed', { error: err.message, response: err.body, payload });
    }
  }

  for (const row of await oldRows(oldConn, 'Driver')) {
    const existing = await existingSet(base, cookie, 'Driver');
    if (existing.has(row.name)) {
      add(log, 'Driver', row.name, 'skipped_existing');
      continue;
    }
    const employee = mapValue(maps, 'Employee', row.employee || row.emloyee);
    try {
      await create(base, cookie, clean({
        doctype: 'Driver',
        name: row.name,
        full_name: row.full_name || row.name,
        status: 'Active',
        employee: exists(sets, 'Employee', employee) ? employee : undefined,
      }));
      add(log, 'Driver', row.name, 'created');
    } catch (err) {
      add(log, 'Driver', row.name, 'failed', { error: err.message, response: err.body });
    }
  }

  for (const row of await oldRows(oldConn, 'Vehicle')) {
    const existing = await existingSet(base, cookie, 'Vehicle');
    if (existing.has(row.name)) {
      add(log, 'Vehicle', row.name, 'skipped_existing');
      continue;
    }
    try {
      await create(base, cookie, clean({
        doctype: 'Vehicle',
        name: row.name,
        license_plate: row.registration_number || row.name,
        make: row.make || row.vehicle_make || 'Unknown',
        model: row.model || row.vehicle_model || 'Unknown',
        last_odometer: 0,
        fuel_type: 'Diesel',
        uom: sets.UOM.has('Ltr') ? 'Ltr' : 'Nos',
      }));
      add(log, 'Vehicle', row.name, 'created');
    } catch (err) {
      add(log, 'Vehicle', row.name, 'failed', { error: err.message, response: err.body });
    }
  }

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
