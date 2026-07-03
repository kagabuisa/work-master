const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-roles-permissions-import-log.json');

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

async function oldSubmittableDocTypes(audit) {
  const names = audit.custom_doctypes.map((doc) => doc.name);
  if (!names.length) return new Set();
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: ['1', 'true', 'required', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
      ? { rejectUnauthorized: false }
      : undefined,
  });
  const [rows] = await conn.query(
    `select name, is_submittable from \`tabDocType\` where name in (${names.map(() => '?').join(',')})`,
    names,
  );
  await conn.end();
  return new Set(rows.filter((row) => intFlag(row.is_submittable)).map((row) => row.name));
}

function permissionPayload(row, docMeta) {
  const isSubmittable = intFlag(docMeta.is_submittable);
  const allowImport = intFlag(docMeta.allow_import);
  const payload = {
    role: row.role,
    permlevel: Number(row.permlevel || 0),
    read: intFlag(row.read),
    write: intFlag(row.write),
    create: intFlag(row.create),
    delete: intFlag(row.delete),
    submit: isSubmittable ? intFlag(row.submit) : 0,
    cancel: isSubmittable ? intFlag(row.cancel) : 0,
    amend: isSubmittable ? intFlag(row.amend) : 0,
    report: intFlag(row.report),
    export: intFlag(row.export),
    import: allowImport ? intFlag(row.import) : 0,
    set_user_permissions: intFlag(row.set_user_permissions),
  };
  if (!payload.read) {
    payload.write = 0;
    payload.create = 0;
    payload.delete = 0;
    payload.submit = 0;
    payload.cancel = 0;
    payload.amend = 0;
    payload.report = 0;
    payload.export = 0;
    payload.import = 0;
  }
  return payload;
}

function samePermission(a, b) {
  const keys = ['role', 'permlevel', 'read', 'write', 'create', 'delete', 'submit', 'cancel', 'amend', 'report', 'export', 'import', 'set_user_permissions'];
  return keys.every((key) => String(a[key] || 0) === String(b[key] || 0));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const customNames = new Set(audit.custom_doctypes.map((doc) => doc.name));
  const oldSubmittable = await oldSubmittableDocTypes(audit);

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const existingRoles = new Set((await fetchAllResource(base, cookie, 'Role', ['name'])).map((row) => row.name));
  const targetDocTypes = await fetchAllResource(
    base,
    cookie,
    'DocType',
    ['name', 'custom', 'istable', 'is_submittable', 'allow_import'],
    [['DocType', 'name', 'in', [...customNames]]],
  );
  const targetByName = new Map(targetDocTypes.map((doc) => [doc.name, doc]));

  const customRoles = (audit.custom_owner_roles || [])
    .filter((role) => !existingRoles.has(role.name));
  const customPerms = (audit.doc_permissions || [])
    .filter((perm) => customNames.has(perm.parent));

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_custom_roles: (audit.custom_owner_roles || []).length,
      roles_created: 0,
      roles_skipped_existing: (audit.custom_owner_roles || []).length - customRoles.length,
      source_custom_doctype_permissions: customPerms.length,
      doctypes_attempted: 0,
      doctypes_updated: 0,
      doctypes_skipped_standard_existing: 0,
      doctypes_skipped_missing: 0,
      doctypes_skipped_no_change: 0,
      submittable_updated: 0,
      failed: 0,
    },
    results: [],
  };

  for (const role of customRoles) {
    if (!apply) {
      log.results.push({ role: role.name, status: 'dry_run_create_role' });
      continue;
    }
    try {
      await requestJson(base, cookie, '/api/resource/Role', {
        method: 'POST',
        body: JSON.stringify({
          doctype: 'Role',
          role_name: role.name,
          desk_access: 1,
          disabled: intFlag(role.disabled),
        }),
      });
      existingRoles.add(role.name);
      log.counts.roles_created += 1;
      log.results.push({ role: role.name, status: 'role_created' });
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({ role: role.name, status: 'role_failed', error: err.message, response: err.body });
    }
  }

  const permsByDoc = new Map();
  for (const perm of customPerms) {
    if (!permsByDoc.has(perm.parent)) permsByDoc.set(perm.parent, []);
    permsByDoc.get(perm.parent).push(perm);
  }

  for (const [doctype, rows] of permsByDoc) {
    const docMeta = targetByName.get(doctype);
    if (!docMeta) {
      log.counts.doctypes_skipped_missing += 1;
      log.results.push({ doctype, status: 'skipped_missing_doctype' });
      continue;
    }
    if (!intFlag(docMeta.custom)) {
      log.counts.doctypes_skipped_standard_existing += 1;
      log.results.push({ doctype, status: 'skipped_standard_existing_doctype' });
      continue;
    }

    let live;
    try {
      live = (await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(doctype)}`)).data;
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({ doctype, status: 'failed_fetch_doctype', error: err.message, response: err.body });
      continue;
    }

    const canBeSubmittable = oldSubmittable.has(doctype) && !intFlag(live.istable);
    const desiredMeta = {
      is_submittable: canBeSubmittable ? 1 : intFlag(live.is_submittable),
      allow_import: rows.some((row) => intFlag(row.import)) && !intFlag(live.istable) ? 1 : intFlag(live.allow_import),
    };
    const metaForPerms = { ...live, ...desiredMeta };
    const desiredPerms = rows.map((row) => permissionPayload(row, metaForPerms));
    const existingPerms = (live.permissions || []).map((row) => permissionPayload(row, metaForPerms));
    const noChange = intFlag(live.is_submittable) === desiredMeta.is_submittable
      && intFlag(live.allow_import) === desiredMeta.allow_import
      && desiredPerms.length === existingPerms.length
      && desiredPerms.every((perm) => existingPerms.some((existing) => samePermission(perm, existing)));

    if (noChange) {
      log.counts.doctypes_skipped_no_change += 1;
      log.results.push({ doctype, status: 'skipped_no_change', permission_rows: desiredPerms.length });
      continue;
    }

    if (!apply) {
      log.results.push({
        doctype,
        status: 'dry_run_update_permissions',
        permission_rows: desiredPerms.length,
        set_is_submittable: desiredMeta.is_submittable !== intFlag(live.is_submittable),
        set_allow_import: desiredMeta.allow_import !== intFlag(live.allow_import),
      });
      continue;
    }

    log.counts.doctypes_attempted += 1;
    try {
      await requestJson(base, cookie, `/api/resource/DocType/${encodeURIComponent(doctype)}`, {
        method: 'PUT',
        body: JSON.stringify({
          is_submittable: desiredMeta.is_submittable,
          allow_import: desiredMeta.allow_import,
          permissions: desiredPerms,
        }),
      });
      if (desiredMeta.is_submittable !== intFlag(live.is_submittable)) log.counts.submittable_updated += 1;
      log.counts.doctypes_updated += 1;
      log.results.push({ doctype, status: 'permissions_updated', permission_rows: desiredPerms.length });
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({ doctype, status: 'permissions_failed', error: err.message, response: err.body });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create roles and update custom DocType permissions.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
