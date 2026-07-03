const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-custom-field-import-log.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function intFlag(value) {
  return Number(value || 0) ? 1 : 0;
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
  const pageLength = 500;
  let start = 0;
  const rows = [];
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

async function existingDocTypes(base, cookie) {
  const rows = await fetchAllResource(base, cookie, 'DocType', ['name', 'istable']);
  return new Map(rows.map((row) => [row.name, row]));
}

async function doctypeFields(base, cookie, dt) {
  const result = await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(dt)}`);
  return new Set((result.data.fields || [])
    .map((field) => field.fieldname)
    .filter(Boolean));
}

function customFieldPayload(field, knownFields, adjustments) {
  const payload = {
    doctype: 'Custom Field',
    dt: field.dt,
    fieldname: field.fieldname,
    label: field.label || field.fieldname,
    fieldtype: field.fieldtype,
    options: field.options || undefined,
    insert_after: field.insert_after || undefined,
    reqd: intFlag(field.reqd),
    hidden: intFlag(field.hidden),
    read_only: intFlag(field.read_only),
  };

  if (payload.insert_after && !knownFields.has(payload.insert_after)) {
    adjustments.push({
      dt: field.dt,
      fieldname: field.fieldname,
      adjustment: 'removed_missing_insert_after',
      old_insert_after: payload.insert_after,
    });
    delete payload.insert_after;
  }

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }
  return payload;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const docTypes = await existingDocTypes(base, cookie);
  const tableTargets = new Set(
    audit.custom_fields
      .filter((field) => field.fieldtype === 'Table' && field.options)
      .map((field) => field.options),
  );
  for (const target of tableTargets) {
    const docType = docTypes.get(target);
    if (apply && docType && Number(docType.istable || 0) !== 1) {
      await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(target)}`, {
        method: 'PUT',
        body: JSON.stringify({ istable: 1, editable_grid: 1 }),
      });
      docType.istable = 1;
    }
  }
  const existingCustomFields = await fetchAllResource(
    base,
    cookie,
    'Custom Field',
    ['name', 'dt', 'fieldname', 'fieldtype'],
  );
  const existingByPair = new Set(existingCustomFields.map((field) => `${field.dt}::${field.fieldname}`));

  const fieldsByDt = new Map();
  const uniqueDts = [...new Set(audit.custom_fields.map((field) => field.dt))].sort();
  for (const dt of uniqueDts) {
    if (!docTypes.has(dt)) continue;
    fieldsByDt.set(dt, await doctypeFields(base, cookie, dt));
  }

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_custom_fields: audit.custom_fields.length,
      attempted: 0,
      created: 0,
      skipped_existing: 0,
      skipped_missing_doctype: 0,
      skipped_field_already_on_doctype: 0,
      failed: 0,
      adjusted_insert_after: 0,
    },
    adjustments: [],
    results: [],
  };

  for (const field of audit.custom_fields) {
    if (!docTypes.has(field.dt)) {
      log.counts.skipped_missing_doctype += 1;
      log.results.push({ dt: field.dt, fieldname: field.fieldname, status: 'skipped_missing_doctype' });
      continue;
    }

    const pair = `${field.dt}::${field.fieldname}`;
    if (existingByPair.has(pair)) {
      log.counts.skipped_existing += 1;
      log.results.push({ dt: field.dt, fieldname: field.fieldname, status: 'skipped_existing_custom_field' });
      continue;
    }

    const knownFields = fieldsByDt.get(field.dt) || new Set();
    if (knownFields.has(field.fieldname)) {
      log.counts.skipped_field_already_on_doctype += 1;
      log.results.push({ dt: field.dt, fieldname: field.fieldname, status: 'skipped_field_already_on_doctype' });
      continue;
    }

    const beforeAdjustments = log.adjustments.length;
    const payload = customFieldPayload(field, knownFields, log.adjustments);
    log.counts.adjusted_insert_after += log.adjustments.length - beforeAdjustments;

    if (!apply) {
      knownFields.add(field.fieldname);
      log.results.push({
        dt: field.dt,
        fieldname: field.fieldname,
        status: 'dry_run',
        adjusted: log.adjustments.length > beforeAdjustments,
      });
      continue;
    }

    log.counts.attempted += 1;
    try {
      await requestJson(base, cookie, '/api/resource/Custom Field', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      existingByPair.add(pair);
      knownFields.add(field.fieldname);
      log.counts.created += 1;
      log.results.push({ dt: field.dt, fieldname: field.fieldname, status: 'created' });
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        dt: field.dt,
        fieldname: field.fieldname,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create missing custom fields.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
