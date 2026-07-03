const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-phase6-duplicate-cleanup-log.json');

const SPECS = {
  'Pricing Rule': ['title', 'apply_on', 'selling', 'buying', 'valid_from', 'valid_upto', 'min_qty', 'rate', 'discount_percentage', 'customer', 'customer_group'],
  'Approved Discounts': ['item_name', 'warehouse', 'warehouse_type', 'pricelist', 'start_date', 'expiry_date', 'min_qty', 'discount_rate'],
  'Part Name': ['part_name'],
  'Goods Transporter': ['transporter'],
  Towns: ['town_name', 'employee'],
  Driver: ['full_name', 'employee'],
};

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

async function fetchAllResource(base, cookie, doctype, fields) {
  const rows = [];
  const pageLength = 500;
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(['name', ...fields]),
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

function keyFor(row, fields) {
  return fields.map((field) => String(row[field] ?? '')).join('\t');
}

function keepName(names) {
  return [...names].sort((a, b) => {
    const oldA = /^([A-Z]+-)?\d+$|^[A-Z]+-\d+/.test(a) || /^(DISC-|CTR-|WMS|PCR-|EMP\/)/.test(a);
    const oldB = /^([A-Z]+-)?\d+$|^[A-Z]+-\d+/.test(b) || /^(DISC-|CTR-|WMS|PCR-|EMP\/)/.test(b);
    if (oldA !== oldB) return oldA ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  })[0];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);

  const log = { generated_at: new Date().toISOString(), apply, target: base, counts: {}, deleted: [], failed: [] };
  for (const [doctype, fields] of Object.entries(SPECS)) {
    const rows = await fetchAllResource(base, cookie, doctype, fields);
    const groups = new Map();
    for (const row of rows) {
      const key = keyFor(row, fields);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.name);
    }
    const toDelete = [];
    for (const names of groups.values()) {
      if (names.length < 2) continue;
      const keep = keepName(names);
      toDelete.push(...names.filter((name) => name !== keep).map((name) => ({ name, keep })));
    }
    log.counts[doctype] = { duplicate_groups: [...groups.values()].filter((names) => names.length > 1).length, delete_count: toDelete.length };
    for (const row of toDelete) {
      if (!apply) {
        log.deleted.push({ doctype, ...row, dry_run: true });
        continue;
      }
      try {
        await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(row.name)}`, { method: 'DELETE' });
        log.deleted.push({ doctype, ...row });
      } catch (err) {
        log.failed.push({ doctype, ...row, error: err.message, response: err.body });
      }
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Deleted/marked: ${log.deleted.length}; failed: ${log.failed.length}`);
  console.log(`Wrote ${logPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
