const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v15-user-import-log.json');
const outMd = path.join(__dirname, '..', 'audits', 'v15-user-import-log.md');

const SYSTEM_USERS = new Set(['Administrator', 'Guest']);
const SYSTEM_ROLES = new Set(['Administrator', 'Guest', 'All']);

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
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function displayName(row) {
  return [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').trim()
    || row.full_name
    || row.email
    || row.name;
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

function isThrottled(err) {
  const haystack = JSON.stringify(err.body || {}) + err.message;
  return err.status === 417 && /Throttled/i.test(haystack);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withThrottleRetry(action) {
  const waits = [60000, 120000, 300000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (err) {
      if (!isThrottled(err) || attempt >= waits.length) throw err;
      await sleep(waits[attempt]);
    }
  }
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

async function getDoc(base, cookie, doctype, name) {
  const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  return result.data;
}

async function putDoc(base, cookie, doctype, name, payload) {
  const result = await withThrottleRetry(() => requestJson(
    base,
    cookie,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  ));
  return result.data;
}

async function createDoc(base, cookie, payload) {
  const result = await withThrottleRetry(() => requestJson(base, cookie, `/api/resource/${encodeURIComponent(payload.doctype)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }));
  return result.data;
}

function userPayload(row, roles) {
  const email = String(row.email || row.name || '').trim();
  const firstName = row.first_name || displayName(row).split(/\s+/)[0] || email;
  return clean({
    doctype: 'User',
    email,
    first_name: firstName,
    middle_name: row.middle_name,
    last_name: row.last_name,
    full_name: displayName(row),
    username: row.username,
    enabled: flag(row.enabled, 1),
    user_type: row.user_type || 'System User',
    language: row.language || 'en',
    time_zone: row.time_zone || 'Africa/Kampala',
    gender: row.gender,
    birth_date: dateOnly(row.birth_date),
    location: row.location,
    bio: row.bio,
    email_signature: row.email_signature,
    send_welcome_email: 0,
    send_password_update_notification: 0,
    thread_notify: flag(row.thread_notify, 1),
    roles: roles.map((role) => ({ doctype: 'Has Role', role })),
  });
}

function markdown(log) {
  const lines = [];
  lines.push('# ERPNext v15 User Import');
  lines.push('');
  lines.push(`Generated: ${log.generated_at}`);
  lines.push(`Target: ${log.target}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- v6 non-system users: ${log.counts.source_users}`);
  lines.push(`- Created in v15: ${log.counts.created}`);
  lines.push(`- Existing in v15 updated/checked: ${log.counts.existing_updated}`);
  lines.push(`- Skipped existing with no role change: ${log.counts.skipped_existing}`);
  lines.push(`- Skipped invalid email: ${log.counts.skipped_invalid_email}`);
  lines.push(`- Failed: ${log.counts.failed}`);
  lines.push(`- Role assignments added/kept from v6: ${log.counts.role_assignments_applied}`);
  lines.push('');
  lines.push('Password hashes, reset keys, sessions, API keys/secrets, and welcome emails were not copied.');
  lines.push('');
  lines.push('## Missing Roles Not Assigned');
  lines.push('');
  if (log.missing_roles.length) {
    for (const role of log.missing_roles) lines.push(`- ${role.role}: ${role.users.length} user(s)`);
  } else {
    lines.push('- None.');
  }
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  const failures = log.results.filter((row) => row.status === 'failed');
  if (failures.length) {
    for (const row of failures.slice(0, 30)) lines.push(`- ${row.user}: ${row.error}`);
  } else {
    lines.push('- None.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const onlyMissing = process.argv.includes('--only-missing');
  const delayArg = process.argv.find((arg) => arg.startsWith('--delay-ms='));
  const writeDelayMs = delayArg ? Number(delayArg.split('=')[1]) : 1000;
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

  const [users] = await conn.query(`
    select name, email, username, first_name, middle_name, last_name, user_type, enabled,
      language, time_zone, gender, birth_date, location, bio, email_signature, thread_notify
    from tabUser
    where name not in ('Administrator', 'Guest')
    order by name
  `);
  const [roleRows] = await conn.query(`
    select parent, role
    from tabUserRole
    where parent not in ('Administrator', 'Guest')
    order by parent, idx
  `);
  await conn.end();

  const oldRolesByUser = new Map();
  for (const row of roleRows) {
    if (!oldRolesByUser.has(row.parent)) oldRolesByUser.set(row.parent, []);
    oldRolesByUser.get(row.parent).push(row.role);
  }

  const cookie = await login(base, usr, pwd);
  const v15Roles = new Set((await fetchAllResource(base, cookie, 'Role', ['name'])).map((row) => row.name));
  const v15Users = new Map((await fetchAllResource(base, cookie, 'User', ['name', 'email', 'enabled', 'user_type']))
    .map((row) => [String(row.email || row.name).toLowerCase(), row]));

  const log = {
    generated_at: new Date().toISOString(),
    target: base,
    counts: {
      source_users: users.length,
      created: 0,
      existing_updated: 0,
      skipped_existing: 0,
      skipped_system_user: 0,
      skipped_invalid_email: 0,
      failed: 0,
      role_assignments_applied: 0,
    },
    missing_roles: [],
    results: [],
  };

  const missingRoleUsers = new Map();

  for (const row of users) {
    const email = String(row.email || row.name || '').trim();
    if (SYSTEM_USERS.has(row.name) || SYSTEM_USERS.has(email)) {
      log.counts.skipped_system_user += 1;
      continue;
    }
    if (!validEmail(email)) {
      log.counts.skipped_invalid_email += 1;
      log.results.push({ user: row.name, email, status: 'skipped_invalid_email' });
      continue;
    }

    const oldRoles = [...new Set((oldRolesByUser.get(row.name) || oldRolesByUser.get(email) || [])
      .filter((role) => role && !SYSTEM_ROLES.has(role)))];
    const assignableRoles = oldRoles.filter((role) => v15Roles.has(role));
    for (const role of oldRoles.filter((role) => !v15Roles.has(role))) {
      if (!missingRoleUsers.has(role)) missingRoleUsers.set(role, []);
      missingRoleUsers.get(role).push(email);
    }

    const emailKey = email.toLowerCase();
    if (onlyMissing && v15Users.has(emailKey)) {
      log.counts.skipped_existing += 1;
      log.results.push({ user: row.name, email, status: 'skipped_existing_only_missing' });
      continue;
    }

    try {
      if (!v15Users.has(emailKey)) {
        if (writeDelayMs > 0) await sleep(writeDelayMs);
        const created = await createDoc(base, cookie, userPayload({ ...row, email }, assignableRoles));
        v15Users.set(emailKey, created);
        log.counts.created += 1;
        log.counts.role_assignments_applied += assignableRoles.length;
        log.results.push({ user: row.name, email, status: 'created', target: created.name, roles: assignableRoles });
        await sleep(1000);
        continue;
      }

      const existingUserName = v15Users.get(emailKey).name || email;
      const live = await getDoc(base, cookie, 'User', existingUserName);
      const liveRoles = new Set((live.roles || []).map((role) => role.role).filter(Boolean));
      let changed = false;
      for (const role of assignableRoles) {
        if (!liveRoles.has(role)) {
          liveRoles.add(role);
          changed = true;
        }
      }
      const desiredEnabled = flag(row.enabled, 1);
      if (Number(live.enabled || 0) !== desiredEnabled) changed = true;
      if (!changed) {
        log.counts.skipped_existing += 1;
        log.counts.role_assignments_applied += assignableRoles.length;
        log.results.push({ user: row.name, email, status: 'skipped_existing', roles: assignableRoles });
        continue;
      }

      const payload = clean({
        first_name: row.first_name || live.first_name,
        middle_name: row.middle_name || live.middle_name,
        last_name: row.last_name || live.last_name,
        full_name: displayName(row),
        username: row.username || live.username,
        enabled: desiredEnabled,
        user_type: row.user_type || live.user_type || 'System User',
        language: row.language || live.language || 'en',
        time_zone: row.time_zone || live.time_zone || 'Africa/Kampala',
        roles: [...liveRoles].map((role) => ({ doctype: 'Has Role', role })),
      });
      await putDoc(base, cookie, 'User', existingUserName, payload);
      log.counts.existing_updated += 1;
      log.counts.role_assignments_applied += assignableRoles.length;
      log.results.push({ user: row.name, email, status: 'existing_updated', roles: assignableRoles });
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        user: row.name,
        email,
        status: 'failed',
        error: err.message,
        response: err.body,
        roles: assignableRoles,
      });
    }
  }

  log.missing_roles = [...missingRoleUsers.entries()]
    .map(([role, usersForRole]) => ({ role, users: usersForRole.sort() }))
    .sort((a, b) => a.role.localeCompare(b.role));

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(log, null, 2)}\n`);
  fs.writeFileSync(outMd, markdown(log));
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
