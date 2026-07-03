const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase2-import-log.json');
const phase1VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');

const ORDER = [
  'Department',
  'Designation',
  'Employment Type',
  'Holiday List',
  'Territory',
  'Customer Group',
  'Supplier Group',
  'Terms and Conditions',
  'Purchase Taxes and Charges Template',
  'Mode of Payment',
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

function flag(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (String(value).toLowerCase() === 'yes') return 1;
  if (String(value).toLowerCase() === 'no') return 0;
  return Number(value) ? 1 : 0;
}

function dateOnly(value) {
  if (!value) return value;
  return new Date(value).toISOString().slice(0, 10);
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

async function tableExists(conn, doctype) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [`tab${doctype}`],
  );
  return Boolean(rows[0].n);
}

async function oldRows(conn, doctype, order = 'name') {
  if (!(await tableExists(conn, doctype))) return [];
  const [rows] = await conn.query(`select * from \`tab${doctype}\` order by ${order}`);
  return rows;
}

async function oldChildRows(conn, doctype, parentType) {
  if (!(await tableExists(conn, doctype))) return [];
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

function existingIndex(rows, ...fields) {
  const names = new Set();
  for (const row of rows) {
    for (const field of fields) {
      if (row[field]) names.add(String(row[field]).toLowerCase());
    }
  }
  return names;
}

function targetCompany(targetCompanies, maps) {
  const mapped = Object.values(maps.Company || {})[0];
  return targetCompanies.find((row) => row.name === mapped) || targetCompanies[0];
}

function addCompanyMappings(targetCompanies, maps, oldCompanyName) {
  if (!maps.Company) maps.Company = {};
  const target = targetCompanies.find((row) => row.abbr === 'SACL') || targetCompanies[0];
  if (target && oldCompanyName) maps.Company[oldCompanyName] = target.name;
}

function departmentPayload(row, company) {
  return clean({
    doctype: 'Department',
    department_name: row.department_name || row.name,
    company: company.name,
    is_group: 0,
  });
}

function designationPayload(row) {
  return clean({
    doctype: 'Designation',
    designation_name: row.designation_name || row.name,
  });
}

function employmentTypePayload(row) {
  return clean({
    doctype: 'Employment Type',
    employee_type_name: row.employee_type_name || row.name,
  });
}

function holidayListPayload(row, children) {
  return clean({
    doctype: 'Holiday List',
    holiday_list_name: row.holiday_list_name || row.name,
    from_date: dateOnly(row.from_date),
    to_date: dateOnly(row.to_date),
    weekly_off: row.weekly_off,
    holidays: (children.get(row.name) || []).map((child) => clean({
      doctype: 'Holiday',
      holiday_date: dateOnly(child.holiday_date),
      description: child.description,
    })),
  });
}

function territoryPayload(row) {
  return clean({
    doctype: 'Territory',
    territory_name: row.territory_name || row.name,
    parent_territory: row.parent_territory,
    is_group: flag(row.is_group),
  });
}

function customerGroupPayload(row, maps) {
  return clean({
    doctype: 'Customer Group',
    customer_group_name: row.customer_group_name || row.name,
    parent_customer_group: row.parent_customer_group,
    is_group: flag(row.is_group),
    default_price_list: mapValue(maps, 'Price List', row.default_price_list),
  });
}

function supplierGroupPayload(row) {
  return clean({
    doctype: 'Supplier Group',
    supplier_group_name: row.supplier_type || row.name,
    parent_supplier_group: 'All Supplier Groups',
    is_group: 0,
  });
}

function termsPayload(row) {
  return clean({
    doctype: 'Terms and Conditions',
    title: row.title || row.name,
    disabled: flag(row.disabled),
    selling: 1,
    buying: 1,
    terms: row.terms,
  });
}

function purchaseTaxTemplatePayload(row, children, maps) {
  return clean({
    doctype: 'Purchase Taxes and Charges Template',
    title: row.title || row.name,
    is_default: flag(row.is_default),
    disabled: flag(row.disabled),
    company: mapValue(maps, 'Company', row.company),
    taxes: (children.get(row.name) || []).map((child) => clean({
      doctype: 'Purchase Taxes and Charges',
      charge_type: child.charge_type,
      account_head: mapValue(maps, 'Account', child.account_head),
      description: child.description,
      rate: child.rate,
      cost_center: mapValue(maps, 'Cost Center', child.cost_center),
      included_in_print_rate: flag(child.included_in_print_rate),
      category: child.category,
      add_deduct_tax: child.add_deduct_tax,
    })),
  });
}

function modeOfPaymentPayload(row, children, maps) {
  return clean({
    doctype: 'Mode of Payment',
    mode_of_payment: row.mode_of_payment || row.name,
    enabled: 1,
    type: 'Cash',
    accounts: (children.get(row.name) || []).map((child) => clean({
      doctype: 'Mode of Payment Account',
      company: mapValue(maps, 'Company', child.company),
      default_account: mapValue(maps, 'Account', child.default_account),
    })),
  });
}

function initLog(apply) {
  return {
    generated_at: new Date().toISOString(),
    apply,
    target: '',
    counts: Object.fromEntries(ORDER.map((doctype) => [doctype, {
      source: 0,
      skipped_existing: 0,
      dry_run_create: 0,
      created: 0,
      failed: 0,
    }])),
    results: [],
  };
}

async function importRows({ base, cookie, apply, log, doctype, rows, existing, makePayload }) {
  log.counts[doctype].source = rows.length;
  for (const row of rows) {
    const payload = makePayload(row);
    const candidateNames = [row.name, payload.name, payload[`${doctype.toLowerCase().replace(/ /g, '_')}_name`], payload.title, payload.mode_of_payment]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (candidateNames.some((value) => existing.has(value))) {
      log.counts[doctype].skipped_existing += 1;
      continue;
    }
    if (!apply) {
      log.counts[doctype].dry_run_create += 1;
      log.results.push({ doctype, name: row.name, status: 'dry_run_create', payload });
      continue;
    }
    try {
      const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const name = (result.data && result.data.name) || row.name;
      existing.add(String(name).toLowerCase());
      log.counts[doctype].created += 1;
      log.results.push({ doctype, name: row.name, status: 'created', target: name });
    } catch (err) {
      log.counts[doctype].failed += 1;
      log.results.push({
        doctype,
        name: row.name,
        status: 'failed',
        error: err.message,
        response: err.body,
        payload,
      });
    }
  }
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
  const targetCompanies = await fetchAllResource(base, cookie, 'Company', ['name', 'abbr']);
  const oldCompanies = await oldRows(oldConn, 'Company', 'name');
  addCompanyMappings(targetCompanies, maps, oldCompanies[0] && oldCompanies[0].name);
  const company = targetCompany(targetCompanies, maps);

  const old = {
    Department: await oldRows(oldConn, 'Department', 'name'),
    Designation: await oldRows(oldConn, 'Designation', 'name'),
    'Employment Type': await oldRows(oldConn, 'Employment Type', 'name'),
    'Holiday List': await oldRows(oldConn, 'Holiday List', 'name'),
    Territory: await oldRows(oldConn, 'Territory', 'lft, name'),
    'Customer Group': await oldRows(oldConn, 'Customer Group', 'lft, name'),
    'Supplier Group': await oldRows(oldConn, 'Supplier Type', 'name'),
    'Terms and Conditions': await oldRows(oldConn, 'Terms and Conditions', 'name'),
    'Purchase Taxes and Charges Template': await oldRows(oldConn, 'Purchase Taxes and Charges Template', 'name'),
    'Mode of Payment': await oldRows(oldConn, 'Mode of Payment', 'name'),
  };
  const holidayChildren = indexChildren(await oldChildRows(oldConn, 'Holiday', 'Holiday List'));
  const purchaseTaxChildren = indexChildren(await oldChildRows(oldConn, 'Purchase Taxes and Charges', 'Purchase Taxes and Charges Template'));
  const modeOfPaymentChildren = indexChildren(await oldChildRows(oldConn, 'Mode of Payment Account', 'Mode of Payment'));

  const log = initLog(apply);
  log.target = base;
  log.company = company ? company.name : null;

  const existing = {
    Department: existingIndex(await fetchAllResource(base, cookie, 'Department', ['name', 'department_name']), 'name', 'department_name'),
    Designation: existingIndex(await fetchAllResource(base, cookie, 'Designation', ['name', 'designation_name']), 'name', 'designation_name'),
    'Employment Type': existingIndex(await fetchAllResource(base, cookie, 'Employment Type', ['name', 'employee_type_name']), 'name', 'employee_type_name'),
    'Holiday List': existingIndex(await fetchAllResource(base, cookie, 'Holiday List', ['name', 'holiday_list_name']), 'name', 'holiday_list_name'),
    Territory: existingIndex(await fetchAllResource(base, cookie, 'Territory', ['name', 'territory_name']), 'name', 'territory_name'),
    'Customer Group': existingIndex(await fetchAllResource(base, cookie, 'Customer Group', ['name', 'customer_group_name']), 'name', 'customer_group_name'),
    'Supplier Group': existingIndex(await fetchAllResource(base, cookie, 'Supplier Group', ['name', 'supplier_group_name']), 'name', 'supplier_group_name'),
    'Terms and Conditions': existingIndex(await fetchAllResource(base, cookie, 'Terms and Conditions', ['name', 'title']), 'name', 'title'),
    'Purchase Taxes and Charges Template': existingIndex(await fetchAllResource(base, cookie, 'Purchase Taxes and Charges Template', ['name', 'title']), 'name', 'title'),
    'Mode of Payment': existingIndex(await fetchAllResource(base, cookie, 'Mode of Payment', ['name', 'mode_of_payment']), 'name', 'mode_of_payment'),
  };

  await importRows({ base, cookie, apply, log, doctype: 'Department', rows: old.Department, existing: existing.Department, makePayload: (row) => departmentPayload(row, company) });
  await importRows({ base, cookie, apply, log, doctype: 'Designation', rows: old.Designation, existing: existing.Designation, makePayload: designationPayload });
  await importRows({ base, cookie, apply, log, doctype: 'Employment Type', rows: old['Employment Type'], existing: existing['Employment Type'], makePayload: employmentTypePayload });
  await importRows({ base, cookie, apply, log, doctype: 'Holiday List', rows: old['Holiday List'], existing: existing['Holiday List'], makePayload: (row) => holidayListPayload(row, holidayChildren) });
  await importRows({ base, cookie, apply, log, doctype: 'Territory', rows: old.Territory, existing: existing.Territory, makePayload: territoryPayload });
  await importRows({ base, cookie, apply, log, doctype: 'Customer Group', rows: old['Customer Group'], existing: existing['Customer Group'], makePayload: (row) => customerGroupPayload(row, maps) });
  await importRows({ base, cookie, apply, log, doctype: 'Supplier Group', rows: old['Supplier Group'], existing: existing['Supplier Group'], makePayload: supplierGroupPayload });
  await importRows({ base, cookie, apply, log, doctype: 'Terms and Conditions', rows: old['Terms and Conditions'], existing: existing['Terms and Conditions'], makePayload: termsPayload });
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Purchase Taxes and Charges Template',
    rows: old['Purchase Taxes and Charges Template'],
    existing: existing['Purchase Taxes and Charges Template'],
    makePayload: (row) => purchaseTaxTemplatePayload(row, purchaseTaxChildren, maps),
  });
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Mode of Payment',
    rows: old['Mode of Payment'],
    existing: existing['Mode of Payment'],
    makePayload: (row) => modeOfPaymentPayload(row, modeOfPaymentChildren, maps),
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
