const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-item-category-update-log.json');

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

async function main() {
  const apply = process.argv.includes('--apply');
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
    dateStrings: true,
  });
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  const cookie = await login(base, usr, pwd);

  const [oldItems] = await oldConn.query('select name, item_code, item_category from tabItem where item_category is not null and item_category != ""');
  const oldByName = new Map();
  for (const row of oldItems) {
    oldByName.set(row.name, row.item_category);
    oldByName.set(row.item_code, row.item_category);
  }

  const categories = await fetchAllResource(base, cookie, 'Item Category', ['name', 'item_category']);
  const categoryMap = new Map(categories.flatMap((row) => [
    [row.name, row.name],
    [row.item_category, row.name],
  ]).filter(([key]) => key));

  const blankItems = await fetchAllResource(
    base,
    cookie,
    'Item',
    ['name', 'item_code', 'item_category'],
    [['Item', 'item_category', 'is', 'not set']],
  );

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    source_with_category: oldItems.length,
    v15_blank_items: blankItems.length,
    updated: 0,
    dry_run_update: 0,
    skipped_no_old_category: 0,
    skipped_missing_category_record: 0,
    failed: 0,
    results: [],
  };

  for (const item of blankItems) {
    const oldCategory = oldByName.get(item.item_code) || oldByName.get(item.name);
    if (!oldCategory) {
      log.skipped_no_old_category += 1;
      continue;
    }
    const categoryName = categoryMap.get(oldCategory);
    if (!categoryName) {
      log.skipped_missing_category_record += 1;
      log.results.push({ item: item.name, status: 'skipped_missing_category_record', old_category: oldCategory });
      continue;
    }
    if (!apply) {
      log.dry_run_update += 1;
      continue;
    }
    try {
      await requestJson(base, cookie, `/api/resource/Item/${encodeURIComponent(item.name)}`, {
        method: 'PUT',
        body: JSON.stringify({ item_category: categoryName }),
      });
      log.updated += 1;
      if (log.results.length < 200) {
        log.results.push({ item: item.name, status: 'updated', old_category: oldCategory, item_category: categoryName });
      }
    } catch (err) {
      log.failed += 1;
      log.results.push({ item: item.name, status: 'failed', error: err.message, response: err.body, old_category: oldCategory, item_category: categoryName });
    }
  }

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify({
    apply: log.apply,
    source_with_category: log.source_with_category,
    v15_blank_items: log.v15_blank_items,
    dry_run_update: log.dry_run_update,
    updated: log.updated,
    skipped_no_old_category: log.skipped_no_old_category,
    skipped_missing_category_record: log.skipped_missing_category_record,
    failed: log.failed,
  }, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to update v15 Items.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
