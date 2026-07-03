const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v15-missing-users-data-import-log.json');
const outMd = path.join(__dirname, '..', 'audits', 'v15-missing-users-data-import-log.md');
const tmpCsv = path.join(__dirname, '..', 'audits', 'v15-missing-users-data-import.csv');

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

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const headers = [
    'email',
    'first_name',
    'middle_name',
    'last_name',
    'enabled',
    'user_type',
    'language',
    'time_zone',
    'send_welcome_email',
    'send_password_update_notification',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function markdown(log) {
  const lines = [];
  lines.push('# ERPNext v15 Missing Users Data Import');
  lines.push('');
  lines.push(`Generated: ${log.generated_at}`);
  lines.push(`Target: ${log.target}`);
  lines.push('');
  lines.push(`- Missing users before import: ${log.missing_before.length}`);
  lines.push(`- Data Import: ${log.data_import || ''}`);
  lines.push(`- Status: ${log.status || ''}`);
  lines.push(`- Imported users after verification: ${log.created_after.length}`);
  lines.push(`- Still missing after verification: ${log.missing_after.length}`);
  lines.push('');
  if (log.missing_after.length) {
    lines.push('## Still Missing');
    lines.push('');
    for (const email of log.missing_after) lines.push(`- ${email}`);
    lines.push('');
  }
  if (log.import_logs.length) {
    lines.push('## Data Import Logs');
    lines.push('');
    for (const row of log.import_logs) {
      lines.push(`- ${row.success ? 'success' : 'failed'} ${row.docname || ''} ${row.messages || ''}`.trim());
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
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

async function fetchAllResource(base, cookie, doctype, fields, filters = []) {
  const rows = [];
  const pageLength = 500;
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
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

async function uploadCsv(base, cookie, filePath) {
  const content = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/csv' }), path.basename(filePath));
  form.append('is_private', '1');
  const response = await fetch(`${base}/api/method/upload_file`, {
    method: 'POST',
    headers: { cookie, Accept: 'application/json' },
    body: form,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const err = new Error(`upload_file failed ${response.status}`);
    err.body = body;
    throw err;
  }
  return body.message.file_url;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });
  const [oldUsers] = await conn.query(`
    select name, lower(coalesce(email, name)) email, first_name, middle_name, last_name,
      enabled, user_type, language, time_zone
    from tabUser
    where name not in ('Administrator', 'Guest')
    order by name
  `);
  await conn.end();

  const cookie = await login(base, usr, pwd);
  const before = await fetchAllResource(base, cookie, 'User', ['name', 'email']);
  const beforeEmails = new Set(before.map((row) => String(row.email || row.name).toLowerCase()));
  const missing = oldUsers
    .filter((row) => !beforeEmails.has(row.email))
    .map((row) => clean({
      email: row.email,
      first_name: row.first_name || row.email,
      middle_name: row.middle_name,
      last_name: row.last_name,
      enabled: flag(row.enabled, 1),
      user_type: row.user_type || 'System User',
      language: row.language || 'en',
      time_zone: row.time_zone || 'Africa/Kampala',
      send_welcome_email: 0,
      send_password_update_notification: 0,
    }));

  const log = {
    generated_at: new Date().toISOString(),
    target: base,
    missing_before: missing.map((row) => row.email),
    uploaded_file: null,
    data_import: null,
    status: null,
    import_logs: [],
    created_after: [],
    missing_after: [],
  };

  if (!missing.length) {
    fs.writeFileSync(outJson, `${JSON.stringify(log, null, 2)}\n`);
    fs.writeFileSync(outMd, markdown(log));
    console.log(JSON.stringify({ missing_before: 0, status: 'nothing_to_import' }, null, 2));
    return;
  }

  fs.writeFileSync(tmpCsv, toCsv(missing));
  log.uploaded_file = await uploadCsv(base, cookie, tmpCsv);
  const createdImport = await requestJson(base, cookie, '/api/resource/Data Import', {
    method: 'POST',
    body: JSON.stringify({
      doctype: 'Data Import',
      reference_doctype: 'User',
      import_type: 'Insert New Records',
      import_file: log.uploaded_file,
      mute_emails: 1,
    }),
  });
  log.data_import = createdImport.data.name;

  await requestJson(base, cookie, '/api/method/frappe.core.doctype.data_import.data_import.form_start_import', {
    method: 'POST',
    body: JSON.stringify({ data_import: log.data_import }),
  });

  for (let i = 0; i < 60; i += 1) {
    await sleep(5000);
    const status = await requestJson(
      base,
      cookie,
      `/api/method/frappe.core.doctype.data_import.data_import.get_import_status?${new URLSearchParams({ data_import_name: log.data_import })}`,
    );
    log.status = status.message && status.message.status;
    if (['Success', 'Partial Success', 'Error'].includes(log.status)) break;
  }

  const logs = await requestJson(
    base,
    cookie,
    `/api/method/frappe.core.doctype.data_import.data_import.get_import_logs?${new URLSearchParams({ data_import: log.data_import })}`,
  );
  log.import_logs = logs.message || [];

  const after = await fetchAllResource(base, cookie, 'User', ['name', 'email']);
  const afterEmails = new Set(after.map((row) => String(row.email || row.name).toLowerCase()));
  log.created_after = log.missing_before.filter((email) => afterEmails.has(email));
  log.missing_after = log.missing_before.filter((email) => !afterEmails.has(email));

  fs.writeFileSync(outJson, `${JSON.stringify(log, null, 2)}\n`);
  fs.writeFileSync(outMd, markdown(log));
  console.log(JSON.stringify({
    missing_before: log.missing_before.length,
    status: log.status,
    created_after: log.created_after.length,
    missing_after: log.missing_after.length,
    data_import: log.data_import,
  }, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
