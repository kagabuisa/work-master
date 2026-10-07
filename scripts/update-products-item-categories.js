'use strict';

require('dotenv').config({ quiet: true });
const { pool: mysql } = require('../src/db');
const { getPostgresPool, closeStore } = require('../src/core');

function env(...names) {
  return names.map((name) => process.env[name]).find(Boolean)?.trim() || '';
}

async function erpnextRows(base, cookie, doctype, fields) {
  const rows = [];
  for (let start = 0; ; start += 500) {
    const query = new URLSearchParams({
      fields: JSON.stringify(fields),
      limit_start: String(start),
      limit_page_length: '500',
    });
    const response = await fetch(`${base}/api/resource/${encodeURIComponent(doctype)}?${query}`, {
      headers: { Accept: 'application/json', cookie },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`ERPNext ${doctype} request failed (${response.status}).`);
    const page = (await response.json()).data || [];
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

async function currentErpnextData() {
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('ERPNext v15 connection is not configured.');
  const response = await fetch(`${base}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ usr, pwd }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`ERPNext login failed (${response.status}).`);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('ERPNext login did not return a session cookie.');
  const [items, categories] = await Promise.all([
    erpnextRows(base, cookie, 'Item', ['name', 'item_code', 'item_category']),
    erpnextRows(base, cookie, 'Item Category', ['name', 'item_category']),
  ]);
  return { items, categories };
}

function itemIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const code of [row.name, row.item_code]) {
      const key = String(code || '').trim();
      if (!key) continue;
      const existing = index.get(key);
      if (existing && String(existing.item_category || '').trim() !== String(row.item_category || '').trim()) {
        throw new Error(`Conflicting ERPNext categories for item ${key}.`);
      }
      index.set(key, row);
    }
  }
  return index;
}

function categoryIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const canonical = String(row.item_category || row.name || '').trim();
    for (const value of [row.name, row.item_category]) {
      if (value) index.set(String(value).trim().toLowerCase(), canonical);
    }
  }
  return index;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { items: currentItems, categories } = await currentErpnextData();
  const [oldItems] = await mysql.query('SELECT name, item_code, item_category FROM `tabItem`');
  const current = itemIndex(currentItems);
  const old = itemIndex(oldItems);
  const categoryNames = categoryIndex(categories);
  const pg = getPostgresPool();
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const { rows: targets } = await client.query(`
      SELECT item_code, category FROM app_master_items
      WHERE lower(trim(category)) = 'products'
      ORDER BY item_code FOR UPDATE
    `);
    const changes = [];
    const unresolved = [];
    const disagreements = [];
    let currentMatches = 0;
    let oldFallbacks = 0;
    for (const target of targets) {
      const currentItem = current.get(target.item_code);
      const oldItem = old.get(target.item_code);
      const selected = currentItem || oldItem;
      const rawCategory = String(selected?.item_category || '').trim();
      const category = categoryNames.get(rawCategory.toLowerCase());
      if (!category) {
        unresolved.push(target.item_code);
        continue;
      }
      if (currentItem) currentMatches += 1;
      else oldFallbacks += 1;
      if (currentItem && oldItem && String(currentItem.item_category).trim().toLowerCase()
        !== String(oldItem.item_category).trim().toLowerCase()) {
        disagreements.push(target.item_code);
      }
      if (target.category !== category) changes.push({ item_code: target.item_code, category });
    }
    let updated = 0;
    if (apply && changes.length) {
      const result = await client.query(`
        WITH source AS (
          SELECT * FROM unnest($1::text[], $2::text[]) AS value(item_code, category)
        )
        UPDATE app_master_items AS item
        SET category = source.category, updated_at = now()
        FROM source
        WHERE item.item_code = source.item_code
          AND lower(trim(item.category)) = 'products'
          AND item.category IS DISTINCT FROM source.category
      `, [changes.map((row) => row.item_code), changes.map((row) => row.category)]);
      updated = result.rowCount;
      if (updated !== changes.length) throw new Error('Item category update count changed during the transaction.');
    }
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    console.log(JSON.stringify({
      apply,
      products_found: targets.length,
      current_erpnext_matches: currentMatches,
      old_erpnext_fallbacks: oldFallbacks,
      would_change: changes.length,
      updated,
      unresolved,
      source_disagreements_preferred_current: disagreements,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await mysql.end();
  await closeStore();
});
