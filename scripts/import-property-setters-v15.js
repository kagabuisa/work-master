const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const renamePath = path.join(__dirname, '..', 'audits', 'v15-custom-doctype-field-renames.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-property-setter-import-log.json');

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

async function doctypeFields(base, cookie, dt) {
  const result = await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(dt)}`);
  return new Set((result.data.fields || [])
    .map((field) => field.fieldname)
    .filter(Boolean));
}

function setterKey(setter) {
  return [
    setter.doc_type,
    setter.doctype_or_field || 'DocType',
    setter.field_name || '',
    setter.property,
  ].join('::');
}

function normalizeSetter(setter, renameMap, log) {
  const normalized = { ...setter };
  const renameKey = `${setter.doc_type}::${setter.field_name || ''}`;
  if (setter.field_name && renameMap.has(renameKey)) {
    normalized.field_name = renameMap.get(renameKey);
    log.renamed_field_targets.push({
      doc_type: setter.doc_type,
      old_field_name: setter.field_name,
      new_field_name: normalized.field_name,
      property: setter.property,
    });
  }
  return normalized;
}

function shouldSkip(setter) {
  if (['width', 'read_only_onload'].includes(setter.property)) return 'skipped_obsolete_property';
  if (setter.property === 'default_print_format') return 'deferred_until_print_formats';
  if (setter.value === null || setter.value === undefined || setter.value === '') return 'skipped_empty_value';
  return '';
}

function payload(setter) {
  const data = {
    doctype: 'Property Setter',
    doc_type: setter.doc_type,
    doctype_or_field: setter.doctype_or_field || (setter.field_name ? 'DocField' : 'DocType'),
    field_name: setter.field_name || undefined,
    property: setter.property,
    property_type: setter.property_type || 'Data',
    value: String(setter.value),
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined || data[key] === '') delete data[key];
  }
  return data;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const renames = fs.existsSync(renamePath) ? JSON.parse(fs.readFileSync(renamePath, 'utf8')) : [];
  const renameMap = new Map(renames.map((row) => [`${row.parent}::${row.old_fieldname}`, row.new_fieldname]));

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const docTypes = new Set((await fetchAllResource(base, cookie, 'DocType', ['name'])).map((row) => row.name));
  const existingSetters = await fetchAllResource(
    base,
    cookie,
    'Property Setter',
    ['name', 'doc_type', 'doctype_or_field', 'field_name', 'property', 'property_type', 'value'],
  );
  const existingByKey = new Map(existingSetters.map((setter) => [setterKey(setter), setter]));
  const fieldCache = new Map();

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_property_setters: audit.property_setters.length,
      attempted_create: 0,
      attempted_update: 0,
      created: 0,
      updated: 0,
      skipped_existing_same_value: 0,
      skipped_missing_doctype: 0,
      skipped_missing_field: 0,
      skipped_obsolete_property: 0,
      skipped_empty_value: 0,
      deferred_until_print_formats: 0,
      failed: 0,
    },
    renamed_field_targets: [],
    results: [],
  };

  for (const original of audit.property_setters) {
    const skip = shouldSkip(original);
    if (skip) {
      log.counts[skip] += 1;
      log.results.push({
        doc_type: original.doc_type,
        field_name: original.field_name,
        property: original.property,
        status: skip,
      });
      continue;
    }

    const setter = normalizeSetter(original, renameMap, log);
    if (!docTypes.has(setter.doc_type)) {
      log.counts.skipped_missing_doctype += 1;
      log.results.push({
        doc_type: setter.doc_type,
        field_name: setter.field_name,
        property: setter.property,
        status: 'skipped_missing_doctype',
      });
      continue;
    }

    if (setter.field_name) {
      if (!fieldCache.has(setter.doc_type)) {
        fieldCache.set(setter.doc_type, await doctypeFields(base, cookie, setter.doc_type));
      }
      if (!fieldCache.get(setter.doc_type).has(setter.field_name)) {
        log.counts.skipped_missing_field += 1;
        log.results.push({
          doc_type: setter.doc_type,
          field_name: setter.field_name,
          property: setter.property,
          status: 'skipped_missing_field',
        });
        continue;
      }
    }

    const data = payload(setter);
    const key = setterKey(data);
    const existing = existingByKey.get(key);

    if (existing && String(existing.value) === data.value && String(existing.property_type || '') === String(data.property_type || '')) {
      log.counts.skipped_existing_same_value += 1;
      log.results.push({
        doc_type: data.doc_type,
        field_name: data.field_name,
        property: data.property,
        status: 'skipped_existing_same_value',
      });
      continue;
    }

    if (!apply) {
      log.results.push({
        doc_type: data.doc_type,
        field_name: data.field_name,
        property: data.property,
        status: existing ? 'dry_run_update' : 'dry_run_create',
        value: data.value,
      });
      continue;
    }

    try {
      if (existing) {
        log.counts.attempted_update += 1;
        await requestJson(base, cookie, `/api/resource/Property Setter/${encodeURIComponent(existing.name)}`, {
          method: 'PUT',
          body: JSON.stringify({
            property_type: data.property_type,
            value: data.value,
          }),
        });
        log.counts.updated += 1;
        log.results.push({
          doc_type: data.doc_type,
          field_name: data.field_name,
          property: data.property,
          status: 'updated',
          old_value: existing.value,
          value: data.value,
        });
      } else {
        log.counts.attempted_create += 1;
        const created = await requestJson(base, cookie, '/api/resource/Property Setter', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        existingByKey.set(key, created.data || data);
        log.counts.created += 1;
        log.results.push({
          doc_type: data.doc_type,
          field_name: data.field_name,
          property: data.property,
          status: 'created',
          value: data.value,
        });
      }
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        doc_type: data.doc_type,
        field_name: data.field_name,
        property: data.property,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create/update property setters.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
