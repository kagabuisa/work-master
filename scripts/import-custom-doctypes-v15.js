const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-custom-doctype-import-log.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function scrubFieldname(value, fallback) {
  let name = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!name) name = fallback;
  if (/^[0-9]/.test(name)) name = `field_${name}`;
  return name;
}

function intFlag(value) {
  return Number(value || 0) ? 1 : 0;
}

function fieldPayload(field, usedNames, renameLog) {
  const original = field.fieldname || '';
  let fieldname = original;
  if (fieldname && !/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldname)) {
    fieldname = scrubFieldname(fieldname, `field_${field.idx || usedNames.size + 1}`);
  }
  if (fieldname) {
    const base = fieldname;
    let i = 2;
    while (usedNames.has(fieldname)) {
      fieldname = `${base}_${i}`;
      i += 1;
    }
    usedNames.add(fieldname);
  }
  if (original && original !== fieldname) {
    renameLog.push({
      parent: field.parent,
      old_fieldname: original,
      new_fieldname: fieldname,
      fieldtype: field.fieldtype,
    });
  }

  const payload = {
    label: field.label || undefined,
    fieldname: fieldname || undefined,
    fieldtype: field.fieldtype,
    options: field.options || undefined,
    reqd: intFlag(field.reqd),
    hidden: intFlag(field.hidden),
    read_only: intFlag(field.read_only),
    in_list_view: intFlag(field.in_list_view),
    in_filter: intFlag(field.in_filter),
    default: field.default_value || undefined,
    depends_on: field.depends_on || undefined,
    mandatory_depends_on: field.mandatory_depends_on || undefined,
    description: field.description || undefined,
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }
  return payload;
}

function buildPayload(doc, fields, renameLog, forcedChildTables) {
  const isTable = forcedChildTables.has(doc.name) || intFlag(doc.istable);
  const usedNames = new Set();
  return {
    doctype: 'DocType',
    name: doc.name,
    module: doc.module || 'Custom',
    custom: 1,
    istable: isTable ? 1 : 0,
    issingle: intFlag(doc.issingle),
    editable_grid: isTable ? 1 : 0,
    fields: fields.map((field) => fieldPayload(field, usedNames, renameLog)),
    permissions: [
      {
        role: 'System Manager',
        read: 1,
        write: 1,
        create: 1,
        delete: 1,
        report: 1,
        export: 1,
      },
    ],
  };
}

function dependencyOrder(docs, fieldsByParent) {
  const names = new Set(docs.map((doc) => doc.name));
  const byName = new Map(docs.map((doc) => [doc.name, doc]));
  const deps = new Map(docs.map((doc) => [doc.name, new Set()]));

  for (const doc of docs) {
    for (const field of fieldsByParent.get(doc.name) || []) {
      if (!['Table', 'Link'].includes(field.fieldtype)) continue;
      if (field.options && names.has(field.options) && field.options !== doc.name) {
        deps.get(doc.name).add(field.options);
      }
    }
  }

  const ordered = [];
  const temporary = new Set();
  const permanent = new Set();

  function visit(name) {
    if (permanent.has(name)) return;
    if (temporary.has(name)) return;
    temporary.add(name);
    for (const dep of deps.get(name) || []) visit(dep);
    temporary.delete(name);
    permanent.add(name);
    ordered.push(byName.get(name));
  }

  for (const doc of docs) visit(doc.name);
  return ordered.sort((a, b) => Number(b.istable || 0) - Number(a.istable || 0));
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

async function existingDocTypes(base, cookie) {
  const fields = encodeURIComponent(JSON.stringify(['name', 'custom', 'istable']));
  const limit = 1000;
  const result = await requestJson(base, cookie, `/api/resource/DocType?fields=${fields}&limit_page_length=${limit}`);
  return new Map((result.data || []).map((row) => [row.name, row]));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const existing = await existingDocTypes(base, cookie);
  const fieldsByParent = new Map();
  const forcedChildTables = new Set();
  for (const field of audit.custom_doctype_fields) {
    if (!fieldsByParent.has(field.parent)) fieldsByParent.set(field.parent, []);
    fieldsByParent.get(field.parent).push(field);
    if (field.fieldtype === 'Table' && field.options) forcedChildTables.add(field.options);
  }

  const ordered = dependencyOrder(audit.custom_doctypes, fieldsByParent);
  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_custom_doctypes: audit.custom_doctypes.length,
      target_existing_doctypes: existing.size,
      attempted: 0,
      created: 0,
      skipped_existing: 0,
      failed: 0,
    renamed_fields: 0,
      fixed_child_tables: 0,
    },
    field_renames: [],
    results: [],
  };

  for (const doc of ordered) {
    if (existing.has(doc.name)) {
      const existingDoc = existing.get(doc.name);
      if (apply && forcedChildTables.has(doc.name) && Number(existingDoc.istable || 0) !== 1) {
        try {
          await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(doc.name)}`, {
            method: 'PUT',
            body: JSON.stringify({ istable: 1, editable_grid: 1 }),
          });
          log.counts.fixed_child_tables += 1;
          log.results.push({ doctype: doc.name, status: 'fixed_child_table' });
        } catch (err) {
          log.counts.failed += 1;
          log.results.push({
            doctype: doc.name,
            status: 'failed_fix_child_table',
            error: err.message,
            response: err.body,
          });
        }
        continue;
      }
      log.counts.skipped_existing += 1;
      log.results.push({ doctype: doc.name, status: 'skipped_existing' });
      continue;
    }

    const renameLog = [];
    const payload = buildPayload(doc, fieldsByParent.get(doc.name) || [], renameLog, forcedChildTables);
    log.field_renames.push(...renameLog);
    log.counts.renamed_fields += renameLog.length;

    if (!apply) {
      log.results.push({
        doctype: doc.name,
        status: 'dry_run',
        field_count: payload.fields.length,
        renamed_fields: renameLog.length,
      });
      continue;
    }

    log.counts.attempted += 1;
    try {
      await requestJson(base, cookie, '/api/resource/DocType', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      existing.set(doc.name, { name: doc.name, custom: 1, istable: payload.istable });
      log.counts.created += 1;
      log.results.push({
        doctype: doc.name,
        status: 'created',
        field_count: payload.fields.length,
        renamed_fields: renameLog.length,
      });
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        doctype: doc.name,
        status: 'failed',
        field_count: payload.fields.length,
        renamed_fields: renameLog.length,
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create missing custom DocTypes.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
