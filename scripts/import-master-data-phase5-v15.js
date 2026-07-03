const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase5-import-log.json');
const phase3VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase3-verification.json');
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
  return Number(value) ? 1 : 0;
}

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function cleanPhone(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/[A-Za-z]/.test(text)) return '';
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return text;
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
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
  let start = 0;
  const pageLength = 500;
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

function mappedLink(row, maps) {
  if (row.customer) {
    const target = maps.Customer[row.customer];
    if (target) return { link_doctype: 'Customer', link_name: target };
  }
  if (row.supplier) {
    const target = maps.Supplier[row.supplier];
    if (target) return { link_doctype: 'Supplier', link_name: target };
  }
  return null;
}

function contactPayload(row, maps) {
  const link = mappedLink(row, maps);
  if (!link) return null;
  const email = isValidEmail(row.email_id) ? row.email_id.trim() : '';
  const phone = cleanPhone(row.phone);
  const mobile = cleanPhone(row.mobile_no);
  return clean({
    doctype: 'Contact',
    first_name: row.first_name || row.customer_name || row.supplier_name || row.name,
    last_name: row.last_name,
    email_id: email,
    phone,
    mobile_no: mobile,
    status: row.status,
    designation: row.designation,
    department: row.department,
    is_primary_contact: flag(row.is_primary_contact),
    unsubscribed: flag(row.unsubscribed),
    email_ids: email ? [{ doctype: 'Contact Email', email_id: email, is_primary: 1 }] : [],
    phone_nos: [
      phone ? { doctype: 'Contact Phone', phone, is_primary_phone: 1 } : null,
      mobile ? { doctype: 'Contact Phone', phone: mobile, is_primary_mobile_no: 1 } : null,
    ].filter(Boolean),
    links: [{ doctype: 'Dynamic Link', ...link }],
  });
}

function addressPayload(row, maps, companyMap) {
  const link = mappedLink(row, maps);
  if (!link && !row.is_your_company_address) return null;
  const email = isValidEmail(row.email_id) ? row.email_id.trim() : '';
  const phone = cleanPhone(row.phone);
  const links = [];
  if (link) links.push({ doctype: 'Dynamic Link', ...link });
  if (row.is_your_company_address && row.company) {
    links.push({
      doctype: 'Dynamic Link',
      link_doctype: 'Company',
      link_name: companyMap[row.company] || row.company,
    });
  }
  return clean({
    doctype: 'Address',
    address_title: row.address_title || row.customer_name || row.supplier_name || row.name,
    address_type: row.address_type || 'Billing',
    address_line1: row.address_line1 || row.city || row.name,
    address_line2: row.address_line2,
    city: row.city || 'Unknown',
    state: row.state,
    country: row.country || 'Uganda',
    pincode: row.pincode,
    email_id: email,
    phone,
    fax: row.fax,
    is_primary_address: flag(row.is_primary_address),
    is_shipping_address: flag(row.is_shipping_address),
    is_your_company_address: flag(row.is_your_company_address),
    links,
  });
}

function initLog(apply, target) {
  return {
    generated_at: new Date().toISOString(),
    apply,
    target,
    counts: {
      Contact: { source: 0, skipped_existing: 0, skipped_no_link: 0, dry_run_create: 0, created: 0, failed: 0 },
      Address: { source: 0, skipped_existing: 0, skipped_no_link: 0, dry_run_create: 0, created: 0, failed: 0 },
    },
    results: [],
  };
}

async function importRows({ base, cookie, apply, log, doctype, rows, existingNames, makePayload }) {
  log.counts[doctype].source = rows.length;
  for (const row of rows) {
    if (existingNames.has(row.name)) {
      log.counts[doctype].skipped_existing += 1;
      continue;
    }
    const payload = makePayload(row);
    if (!payload) {
      log.counts[doctype].skipped_no_link += 1;
      continue;
    }
    if (!apply) {
      log.counts[doctype].dry_run_create += 1;
      continue;
    }
    try {
      const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const name = (result.data && result.data.name) || row.name;
      existingNames.add(name);
      log.counts[doctype].created += 1;
      if (log.results.length < 300) log.results.push({ doctype, name: row.name, status: 'created', target: name });
    } catch (err) {
      log.counts[doctype].failed += 1;
      log.results.push({ doctype, name: row.name, status: 'failed', error: err.message, response: err.body, payload });
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const phase3 = readJson(phase3VerificationPath);
  const phase1 = readJson(phase1VerificationPath);
  const maps = {
    Customer: (phase3.maps && phase3.maps.Customer) || {},
    Supplier: (phase3.maps && phase3.maps.Supplier) || {},
  };
  const companyMap = (phase1.maps && phase1.maps.Company) || {};
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
  const cookie = await login(base, usr, pwd);

  const [contacts] = await oldConn.query('select * from tabContact order by name');
  const [addresses] = await oldConn.query('select * from tabAddress order by name');
  const existingContacts = new Set((await fetchAllResource(base, cookie, 'Contact', ['name'])).map((row) => row.name));
  const existingAddresses = new Set((await fetchAllResource(base, cookie, 'Address', ['name'])).map((row) => row.name));
  const log = initLog(apply, base);

  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Contact',
    rows: contacts,
    existingNames: existingContacts,
    makePayload: (row) => contactPayload(row, maps),
  });
  await importRows({
    base,
    cookie,
    apply,
    log,
    doctype: 'Address',
    rows: addresses,
    existingNames: existingAddresses,
    makePayload: (row) => addressPayload(row, maps, companyMap),
  });

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create Contacts and Addresses in v15.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
