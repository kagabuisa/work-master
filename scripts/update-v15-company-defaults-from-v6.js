const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-company-defaults-update-log.json');
const phase1VerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');

const FIELDS = [
  'default_payable_account',
  'default_receivable_account',
  'default_income_account',
  'default_expense_account',
  'cost_center',
  'round_off_account',
];

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

function readMaps() {
  if (!fs.existsSync(phase1VerificationPath)) return {};
  return JSON.parse(fs.readFileSync(phase1VerificationPath, 'utf8')).maps || {};
}

function mapValue(maps, field, value) {
  if (!value) return value;
  const mapNames = {
    default_payable_account: 'Account',
    default_receivable_account: 'Account',
    default_income_account: 'Account',
    default_expense_account: 'Account',
    round_off_account: 'Account',
    cost_center: 'Cost Center',
  };
  const mapName = mapNames[field];
  return (mapName && maps[mapName] && maps[mapName][value]) || value;
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

async function resourceExists(base, cookie, doctype, name) {
  try {
    await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
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
  });

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);
  const maps = readMaps();

  const [oldCompanies] = await oldConn.query(
    `select name, abbr, ${FIELDS.map((field) => `\`${field}\``).join(', ')} from \`tabCompany\` order by name`,
  );
  await oldConn.end();

  const targetCompanies = (await requestJson(
    base,
    cookie,
    `/api/resource/Company?fields=${encodeURIComponent(JSON.stringify(['name', 'abbr', ...FIELDS]))}`,
  )).data || [];

  const updates = [];
  const failed = [];
  const skipped = [];

  for (const oldCompany of oldCompanies) {
    const target = targetCompanies.find((row) => row.abbr === oldCompany.abbr);
    if (!target) {
      failed.push({ company: oldCompany.name, error: 'No v15 company with matching abbreviation.' });
      continue;
    }

    const payload = {};
    for (const field of FIELDS) {
      const expected = mapValue(maps, field, oldCompany[field]);
      if (!expected || target[field] === expected) continue;
      const linkedDoctype = field === 'cost_center' ? 'Cost Center' : 'Account';
      if (!(await resourceExists(base, cookie, linkedDoctype, expected))) {
        failed.push({ company: target.name, field, expected, error: `${linkedDoctype} does not exist in v15.` });
        continue;
      }
      payload[field] = expected;
    }

    if (!Object.keys(payload).length) {
      skipped.push({ company: target.name, reason: 'Already aligned.' });
      continue;
    }

    if (apply) {
      await requestJson(base, cookie, `/api/resource/Company/${encodeURIComponent(target.name)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    }
    updates.push({ company: target.name, fields: payload, dry_run: !apply });
  }

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    updates,
    skipped,
    failed,
  };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log, null, 2));
  console.log(`Wrote ${logPath}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
