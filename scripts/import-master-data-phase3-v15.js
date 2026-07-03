const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase3-import-log.json');
const phase1VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');

const ORDER = ['Supplier', 'Customer', 'Employee'];

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

function existingSet(rows, ...fields) {
  const out = new Set();
  for (const row of rows) {
    for (const field of fields) {
      if (row[field]) out.add(String(row[field]).toLowerCase());
    }
  }
  return out;
}

function existingSetWhere(rows, predicate, ...fields) {
  return existingSet(rows.filter(predicate), ...fields);
}

function supplierPayload(row, maps, supplierGroups) {
  const oldType = row.supplier_type || 'All Supplier Groups';
  const v15SupplierType = ['Company', 'Individual', 'Partnership'].includes(oldType) ? oldType : 'Company';
  const supplierGroup = supplierGroups.has(String(oldType).toLowerCase()) ? oldType : 'All Supplier Groups';
  return clean({
    doctype: 'Supplier',
    name: row.name,
    naming_series: row.naming_series || 'SUP-.YYYY.-',
    supplier_name: row.supplier_name || row.name,
    supplier_type: v15SupplierType,
    supplier_group: supplierGroup,
    default_currency: mapValue(maps, 'Currency', row.default_currency),
    default_price_list: mapValue(maps, 'Price List', row.default_price_list),
    website: row.website,
    is_frozen: flag(row.is_frozen),
    disabled: flag(row.disabled),
  });
}

function customerPayload(row, maps, customerGroups, territories) {
  const group = mapValue(maps, 'Customer Group', row.customer_group);
  const territory = mapValue(maps, 'Territory', row.territory);
  return clean({
    doctype: 'Customer',
    name: row.name,
    naming_series: row.naming_series || 'CUST-.YYYY.-',
    customer_name: row.customer_name || row.name,
    customer_type: ['Company', 'Individual', 'Partnership'].includes(row.customer_type) ? row.customer_type : 'Individual',
    customer_group: customerGroups.has(String(group).toLowerCase()) ? group : 'Individual',
    territory: territories.has(String(territory).toLowerCase()) ? territory : 'All Territories',
    default_currency: mapValue(maps, 'Currency', row.default_currency),
    default_price_list: mapValue(maps, 'Price List', row.default_price_list),
    website: row.website,
    tax_id: row.tax_id,
    default_commission_rate: row.default_commission_rate,
    is_frozen: flag(row.is_frozen),
    disabled: flag(row.disabled),
  });
}

function splitEmployeeName(row) {
  const value = row.employee_name || row.employee || row.name;
  const parts = String(value).trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts.shift() || value,
    middle_name: parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined,
    last_name: parts.length ? parts[parts.length - 1] : undefined,
  };
}

function employeePayload(row, maps, lookups) {
  const names = splitEmployeeName(row);
  const department = row.department && lookups.Department.has(String(row.department).toLowerCase()) ? row.department : undefined;
  const designation = row.designation && lookups.Designation.has(String(row.designation).toLowerCase()) ? row.designation : undefined;
  const branch = row.branch && mapValue(maps, 'Branch', row.branch);
  const holidayList = row.holiday_list && lookups['Holiday List'].has(String(row.holiday_list).toLowerCase()) ? row.holiday_list : undefined;
  const employmentType = row.employment_type && lookups['Employment Type'].has(String(row.employment_type).toLowerCase()) ? row.employment_type : undefined;
  return clean({
    doctype: 'Employee',
    name: row.name,
    employee: row.employee || row.name,
    naming_series: 'HR-EMP-',
    ...names,
    employee_name: row.employee_name || row.name,
    gender: row.gender,
    date_of_birth: dateOnly(row.date_of_birth),
    date_of_joining: dateOnly(row.date_of_joining),
    status: row.status || 'Active',
    company: mapValue(maps, 'Company', row.company),
    department,
    designation,
    branch: branch && lookups.Branch.has(String(branch).toLowerCase()) ? branch : undefined,
    assigned_to: row.assigned_to ? mapValue(maps, 'Cost Center', row.assigned_to) : undefined,
    employment_type: employmentType,
    holiday_list: holidayList,
    employee_number: row.employee_number,
    notice_number_of_days: row.notice_number_of_days,
    personal_email: row.personal_email,
    company_email: row.company_email,
    unsubscribed: flag(row.unsubscribed),
    current_address: row.current_address,
    permanent_address: row.permanent_address,
    person_to_be_contacted: row.person_to_be_contacted,
    relation: row.relation,
    salary_mode: row.salary_mode,
    bank_name: row.bank_name,
    bank_ac_no: row.bank_ac_no,
    marital_status: row.marital_status,
    blood_group: row.blood_group,
    passport_number: row.passport_number,
    place_of_issue: row.place_of_issue,
    bio: row.bio,
    relieving_date: dateOnly(row.relieving_date),
    resignation_letter_date: dateOnly(row.resignation_letter_date),
    reason_for_leaving: row.reason_for_leaving,
    feedback: row.feedback,
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
    const keys = [row.name, payload.name, payload.supplier_name, payload.customer_name, payload.employee, payload.employee_name]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (keys.some((value) => existing.has(value))) {
      log.counts[doctype].skipped_existing += 1;
      continue;
    }
    if (!apply) {
      log.counts[doctype].dry_run_create += 1;
      if (log.results.length < 100) log.results.push({ doctype, name: row.name, status: 'dry_run_create', payload });
      continue;
    }
    try {
      const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const name = (result.data && result.data.name) || payload.name || row.name;
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

  const old = {
    Supplier: await oldRows(oldConn, 'Supplier', 'name'),
    Customer: await oldRows(oldConn, 'Customer', 'name'),
    Employee: await oldRows(oldConn, 'Employee', 'name'),
  };
  const lookups = {
    Supplier: existingSet(await fetchAllResource(base, cookie, 'Supplier', ['name', 'supplier_name']), 'name', 'supplier_name'),
    Customer: existingSet(await fetchAllResource(base, cookie, 'Customer', ['name', 'customer_name']), 'name', 'customer_name'),
    Employee: existingSet(await fetchAllResource(base, cookie, 'Employee', ['name', 'employee', 'employee_name']), 'name', 'employee', 'employee_name'),
    'Supplier Group': existingSet(await fetchAllResource(base, cookie, 'Supplier Group', ['name', 'supplier_group_name']), 'name', 'supplier_group_name'),
    'Customer Group': existingSetWhere(
      await fetchAllResource(base, cookie, 'Customer Group', ['name', 'customer_group_name', 'is_group']),
      (row) => !Number(row.is_group),
      'name',
      'customer_group_name',
    ),
    Territory: existingSet(await fetchAllResource(base, cookie, 'Territory', ['name', 'territory_name']), 'name', 'territory_name'),
    Department: existingSet(await fetchAllResource(base, cookie, 'Department', ['name', 'department_name']), 'name', 'department_name'),
    Designation: existingSet(await fetchAllResource(base, cookie, 'Designation', ['name', 'designation_name']), 'name', 'designation_name'),
    'Employment Type': existingSet(await fetchAllResource(base, cookie, 'Employment Type', ['name', 'employee_type_name']), 'name', 'employee_type_name'),
    'Holiday List': existingSet(await fetchAllResource(base, cookie, 'Holiday List', ['name', 'holiday_list_name']), 'name', 'holiday_list_name'),
    Branch: existingSet(await fetchAllResource(base, cookie, 'Branch', ['name', 'branch']), 'name', 'branch'),
  };

  const log = initLog(apply);
  log.target = base;
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Supplier',
    rows: old.Supplier,
    existing: lookups.Supplier,
    makePayload: (row) => supplierPayload(row, maps, lookups['Supplier Group']),
  });
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Customer',
    rows: old.Customer,
    existing: lookups.Customer,
    makePayload: (row) => customerPayload(row, maps, lookups['Customer Group'], lookups.Territory),
  });
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Employee',
    rows: old.Employee,
    existing: lookups.Employee,
    makePayload: (row) => employeePayload(row, maps, lookups),
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
