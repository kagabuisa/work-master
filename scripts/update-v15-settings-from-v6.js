const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-settings-update-log.json');

const SETTINGS = {
  'System Settings': [
    'deny_multiple_sessions',
    'disable_standard_email_footer',
    'number_format',
    'session_expiry',
  ],
  'Global Defaults': [
    'default_company',
    'disable_rounded_total',
  ],
  'Stock Settings': [
    'reorder_email_notify',
    'stock_uom',
  ],
  'Buying Settings': [
    'allow_multiple_items',
  ],
  'Print Settings': [
    'print_style',
  ],
  'Website Settings': [
    'disable_signup',
  ],
};

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

function normalize(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function boolish(value) {
  const text = normalize(value).toLowerCase();
  if (text === 'yes' || text === 'true') return '1';
  if (text === 'no' || text === 'false') return '0';
  return normalize(value);
}

function equivalent(a, b) {
  return boolish(a) === boolish(b);
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

async function fetchSingle(base, cookie, doctype) {
  const result = await requestJson(
    base,
    cookie,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(doctype)}`,
  );
  return result.data || {};
}

async function oldSingles(conn, doctype) {
  const [rows] = await conn.query(
    'select field, value from tabSingles where doctype = ? order by field',
    [doctype],
  );
  return Object.fromEntries(rows.map((row) => [row.field, row.value]));
}

async function companyMap(conn, base, cookie) {
  const [oldCompanies] = await conn.query('select name, abbr from tabCompany order by name');
  const qs = new URLSearchParams({ fields: JSON.stringify(['name', 'abbr']), limit_page_length: '100' });
  const result = await requestJson(base, cookie, `/api/resource/Company?${qs}`);
  const targetCompanies = result.data || [];
  const map = {};
  for (const oldCompany of oldCompanies) {
    const target = targetCompanies.find((row) => row.abbr === oldCompany.abbr);
    if (target) map[oldCompany.name] = target.name;
  }
  return map;
}

function mapFieldValue(field, value, maps) {
  if (field === 'default_company') return maps.company[value] || value;
  return value;
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
  const cookie = await login(base, usr, pwd);
  const maps = { company: await companyMap(oldConn, base, cookie) };

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    updates: [],
    skipped_same: [],
    failed: [],
  };

  for (const [doctype, fields] of Object.entries(SETTINGS)) {
    const oldDoc = await oldSingles(oldConn, doctype);
    let newDoc;
    try {
      newDoc = await fetchSingle(base, cookie, doctype);
    } catch (err) {
      log.failed.push({ doctype, status: 'read_failed', error: err.message, response: err.body });
      continue;
    }

    const payload = {};
    for (const field of fields) {
      if (!(field in oldDoc) || !(field in newDoc)) continue;
      const value = mapFieldValue(field, oldDoc[field], maps);
      if (equivalent(value, newDoc[field])) {
        log.skipped_same.push({ doctype, field, value: normalize(value) });
        continue;
      }
      payload[field] = value;
      log.updates.push({
        doctype,
        field,
        old_value: normalize(oldDoc[field]),
        update_value: normalize(value),
        previous_v15_value: normalize(newDoc[field]),
      });
    }

    if (apply && Object.keys(payload).length) {
      try {
        await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(doctype)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } catch (err) {
        log.failed.push({ doctype, status: 'update_failed', payload, error: err.message, response: err.body });
      }
    }
  }

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify({
    apply: log.apply,
    planned_or_applied_updates: log.updates.length,
    skipped_same: log.skipped_same.length,
    failed: log.failed.length,
  }, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to update v15 settings.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
