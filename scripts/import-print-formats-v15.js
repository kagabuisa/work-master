const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-print-format-import-log.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
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

function normalizeType(type) {
  if (!type || type === 'Server') return 'Jinja';
  return type;
}

function payload(format, body) {
  return {
    doctype: 'Print Format',
    name: format.name,
    print_format_for: 'DocType',
    doc_type: format.doc_type,
    standard: 'No',
    disabled: Number(format.disabled || 0),
    print_format_type: normalizeType(format.print_format_type),
    custom_format: Number(format.custom_format || 0),
    print_format_builder: Number(format.print_format_builder || (body.format_data ? 1 : 0)),
    html: body.html || undefined,
    css: body.css || undefined,
    format_data: body.format_data || undefined,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const bodies = new Map((audit.print_format_bodies || []).map((body) => [body.name, body]));
  const formats = audit.print_formats.filter((format) => format.standard === 'No');

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const docTypes = new Set((await fetchAllResource(base, cookie, 'DocType', ['name'])).map((row) => row.name));
  const existingFormats = await fetchAllResource(base, cookie, 'Print Format', ['name', 'doc_type', 'standard']);
  const existingByName = new Map(existingFormats.map((row) => [row.name, row]));
  const existingByLowerName = new Map(existingFormats.map((row) => [String(row.name).toLowerCase(), row]));

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_custom_print_formats: formats.length,
      attempted_create: 0,
      attempted_update: 0,
      created: 0,
      updated: 0,
      skipped_missing_doctype: 0,
      failed: 0,
    },
    results: [],
  };

  for (const format of formats) {
    const body = bodies.get(format.name) || {};
    const data = payload(format, body);
    if (!docTypes.has(data.doc_type)) {
      log.counts.skipped_missing_doctype += 1;
      log.results.push({ print_format: data.name, doc_type: data.doc_type, status: 'skipped_missing_doctype' });
      continue;
    }

    const existing = existingByName.get(data.name) || existingByLowerName.get(String(data.name).toLowerCase());
    if (!apply) {
      log.results.push({
        print_format: data.name,
        doc_type: data.doc_type,
        status: existing ? 'dry_run_update' : 'dry_run_create',
        has_html: Boolean(data.html),
        has_format_data: Boolean(data.format_data),
      });
      continue;
    }

    try {
      if (existing) {
        log.counts.attempted_update += 1;
        await requestJson(base, cookie, `/api/resource/Print Format/${encodeURIComponent(data.name)}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
        log.counts.updated += 1;
        log.results.push({ print_format: data.name, doc_type: data.doc_type, status: 'updated' });
      } else {
        log.counts.attempted_create += 1;
        await requestJson(base, cookie, '/api/resource/Print Format', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        log.counts.created += 1;
        log.results.push({ print_format: data.name, doc_type: data.doc_type, status: 'created' });
      }
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        print_format: data.name,
        doc_type: data.doc_type,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create/update print formats.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
