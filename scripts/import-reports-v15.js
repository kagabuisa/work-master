const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const renamePath = path.join(__dirname, '..', 'audits', 'v15-custom-doctype-field-renames.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-report-import-log.json');

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

function loadRenames() {
  if (!fs.existsSync(renamePath)) return [];
  return JSON.parse(fs.readFileSync(renamePath, 'utf8'));
}

function normalizeDoctypeName(name) {
  const map = new Map([
    ['Difference Report', 'Delivery Difference Report'],
    ['Shop Maximum Stock', 'Warehouse Maximum Stock'],
  ]);
  return map.get(name) || name;
}

function replaceAllLiteral(value, from, to) {
  return String(value).split(from).join(to);
}

function normalizeText(text, renames) {
  let out = String(text || '');
  out = replaceAllLiteral(out, 'Difference Report', 'Delivery Difference Report');
  out = replaceAllLiteral(out, 'Shop Maximum Stock', 'Warehouse Maximum Stock');
  for (const row of renames) {
    out = replaceAllLiteral(out, `\`${row.old_fieldname}\``, `\`${row.new_fieldname}\``);
    out = replaceAllLiteral(out, `"${row.old_fieldname}"`, `"${row.new_fieldname}"`);
  }
  return out;
}

function normalizeReportJson(jsonText, renames, adjustments) {
  if (!jsonText) return '';
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    const normalized = normalizeText(jsonText, renames);
    if (normalized !== jsonText) adjustments.push('normalized_json_text');
    return normalized;
  }

  const renameByParent = new Map(renames.map((row) => [`${row.parent}::${row.old_fieldname}`, row.new_fieldname]));
  for (const key of ['filters', 'columns']) {
    if (!Array.isArray(data[key])) continue;
    for (const item of data[key]) {
      if (!Array.isArray(item)) continue;
      const dtIndex = key === 'filters' ? 0 : 1;
      const fieldIndex = key === 'filters' ? 1 : 0;
      if (item[dtIndex]) item[dtIndex] = normalizeDoctypeName(item[dtIndex]);
      if (item[fieldIndex] && item[dtIndex]) {
        const renameKey = `${item[dtIndex]}::${item[fieldIndex]}`;
        if (renameByParent.has(renameKey)) {
          adjustments.push(`${item[dtIndex]}.${item[fieldIndex]}->${renameByParent.get(renameKey)}`);
          item[fieldIndex] = renameByParent.get(renameKey);
        }
      }
    }
  }
  for (const key of ['sort_by', 'sort_by_next']) {
    if (!data[key]) continue;
    const parts = String(data[key]).split('.');
    if (parts.length >= 2) {
      const dt = normalizeDoctypeName(parts.slice(0, -1).join('.'));
      const field = parts[parts.length - 1];
      const renameKey = `${dt}::${field}`;
      data[key] = `${dt}.${renameByParent.get(renameKey) || field}`;
    }
  }
  return JSON.stringify(data);
}

function reportPayload(report, body, renames, adjustments) {
  const normalizedJson = normalizeReportJson(body.json || '', renames, adjustments);
  const normalizedQuery = normalizeText(body.query || '', renames);
  if (normalizedQuery !== (body.query || '')) adjustments.push('normalized_query_text');
  return {
    doctype: 'Report',
    name: report.name,
    report_name: report.report_name || report.name,
    ref_doctype: normalizeDoctypeName(report.ref_doctype),
    module: report.module || 'Custom',
    is_standard: 'No',
    report_type: report.report_type,
    disabled: Number(report.disabled || 0),
    json: normalizedJson || undefined,
    query: normalizedQuery || undefined,
    javascript: normalizeText(body.javascript || '', renames) || undefined,
    add_total_row: Number(report.add_total_row || 0),
  };
}

async function doctypeFields(base, cookie, dt) {
  const result = await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(dt)}`);
  const fields = new Set((result.data.fields || []).map((field) => field.fieldname).filter(Boolean));
  for (const field of ['name', 'creation', 'modified', 'modified_by', 'owner', 'docstatus']) fields.add(field);
  const qs = new URLSearchParams({
    fields: JSON.stringify(['fieldname']),
    filters: JSON.stringify([['Custom Field', 'dt', '=', dt]]),
    limit_page_length: '500',
  });
  const customFields = await requestJson(base, cookie, `/api/resource/Custom Field?${qs}`);
  for (const field of customFields.data || []) fields.add(field.fieldname);
  return fields;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const renames = loadRenames();
  const bodies = new Map((audit.report_bodies || []).map((body) => [body.name, body]));
  const reports = audit.reports.filter((report) => report.is_standard === 'No');

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const docTypes = new Set((await fetchAllResource(base, cookie, 'DocType', ['name'])).map((row) => row.name));
  const existingReports = await fetchAllResource(base, cookie, 'Report', ['name', 'report_name', 'ref_doctype', 'report_type']);
  const existingByName = new Map(existingReports.map((row) => [row.name, row]));
  const fieldCache = new Map();

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_non_standard_reports: reports.length,
      attempted_create: 0,
      attempted_update: 0,
      created: 0,
      updated: 0,
      skipped_same_name: 0,
      skipped_missing_doctype: 0,
      report_builder_field_warnings: 0,
      failed: 0,
    },
    adjustments: [],
    warnings: [],
    results: [],
  };

  for (const report of reports) {
    const adjustments = [];
    const body = bodies.get(report.name) || {};
    const data = reportPayload(report, body, renames, adjustments);
    log.adjustments.push(...adjustments.map((adjustment) => ({ report: report.name, adjustment })));
    if (!docTypes.has(data.ref_doctype)) {
      log.counts.skipped_missing_doctype += 1;
      log.results.push({ report: report.name, ref_doctype: data.ref_doctype, status: 'skipped_missing_doctype' });
      continue;
    }

    if (data.report_type === 'Report Builder' && data.json) {
      try {
        const parsed = JSON.parse(data.json);
        for (const key of ['filters', 'columns']) {
          for (const item of Array.isArray(parsed[key]) ? parsed[key] : []) {
            if (!Array.isArray(item) || !item[0] || !item[1]) continue;
            const dt = normalizeDoctypeName(key === 'filters' ? item[0] : item[1]);
            const fieldname = key === 'filters' ? item[1] : item[0];
            if (!docTypes.has(dt)) {
              log.counts.report_builder_field_warnings += 1;
              log.warnings.push({ report: report.name, type: 'missing_column_doctype', doctype: dt, field: fieldname });
              continue;
            }
            if (!fieldCache.has(dt)) fieldCache.set(dt, await doctypeFields(base, cookie, dt));
            const fields = fieldCache.get(dt);
            if (!fields.has(fieldname)) {
              log.counts.report_builder_field_warnings += 1;
              log.warnings.push({ report: report.name, type: 'missing_field', doctype: dt, field: fieldname });
            }
          }
        }
      } catch {
        log.warnings.push({ report: report.name, type: 'invalid_json_after_normalization' });
      }
    }

    const existing = existingByName.get(data.name);
    if (!apply) {
      log.results.push({
        report: data.name,
        ref_doctype: data.ref_doctype,
        report_type: data.report_type,
        status: existing ? 'dry_run_update' : 'dry_run_create',
        adjustments: adjustments.length,
      });
      continue;
    }

    try {
      if (existing) {
        log.counts.attempted_update += 1;
        await requestJson(base, cookie, `/api/resource/Report/${encodeURIComponent(existing.name)}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
        log.counts.updated += 1;
        log.results.push({ report: data.name, status: 'updated', report_type: data.report_type });
      } else {
        log.counts.attempted_create += 1;
        await requestJson(base, cookie, '/api/resource/Report', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        log.counts.created += 1;
        log.results.push({ report: data.name, status: 'created', report_type: data.report_type });
      }
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        report: data.name,
        ref_doctype: data.ref_doctype,
        report_type: data.report_type,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create/update reports.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
