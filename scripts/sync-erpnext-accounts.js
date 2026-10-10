'use strict';

require('dotenv').config({ quiet: true });
const { getPostgresPool, closeStore } = require('../src/core');
const { accountCodePlan } = require('../src/account-codes');

async function sourceAccounts() {
  const base = String(process.env.ERPNEXT_URL || '').replace(/\/$/, '');
  const usr = process.env.ERPNEXT_USERNAME;
  const pwd = process.env.ERPNEXT_PASSWORD;
  if (!base || !usr || !pwd) throw new Error('Set ERPNEXT_URL, ERPNEXT_USERNAME and ERPNEXT_PASSWORD.');
  const login = await fetch(`${base}/api/method/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usr, pwd }), signal: AbortSignal.timeout(20000),
  });
  if (!login.ok) throw new Error(`ERPNext login failed (HTTP ${login.status}). No accounts changed.`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (!cookie.includes('sid=')) throw new Error('ERPNext login did not return a session.');
  const metadata = await fetch(`${base}/api/method/frappe.desk.form.load.getdoctype?doctype=Account`, {
    headers: { cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
  });
  if (!metadata.ok) throw new Error(`ERPNext account metadata failed (HTTP ${metadata.status}).`);
  const definition = (await metadata.json()).docs?.find((doc) => doc.name === 'Account' && Array.isArray(doc.fields));
  if (!definition) throw new Error('ERPNext did not return Account field metadata.');
  const available = new Set(definition.fields.map((field) => field.fieldname));
  const fields = ['name', 'account_name', 'parent_account', 'root_type', 'account_type', 'is_group', 'company'];
  for (const optional of ['disabled', 'freeze_account']) if (available.has(optional)) fields.push(optional);
  const rows = [];
  for (let start = 0; ; start += 500) {
    const query = new URLSearchParams({
      fields: JSON.stringify(fields),
      limit_start: String(start), limit_page_length: '500', order_by: 'name asc',
    });
    const response = await fetch(`${base}/api/resource/Account?${query}`, {
      headers: { cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`ERPNext accounts failed (HTTP ${response.status}).`);
    const page = (await response.json()).data;
    if (!Array.isArray(page)) throw new Error('ERPNext returned an invalid account list.');
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

async function syncAccounts(rows, client) {
  const source = new Map(rows.map((row) => [row.name, row]));
  if (!rows.length || source.size !== rows.length) throw new Error('ERPNext accounts must be nonempty and unique.');
  const visiting = new Set();
  const ordered = [];
  const visited = new Set();
  function visit(row) {
    if (visited.has(row.name)) return;
    if (visiting.has(row.name)) throw new Error(`Account hierarchy contains a cycle: ${row.name}`);
    visiting.add(row.name);
    if (row.parent_account) {
      const parent = source.get(row.parent_account);
      if (!parent || !Number(parent.is_group) || parent.company !== row.company) {
        throw new Error(`Invalid parent for ${row.name}`);
      }
      visit(parent);
    }
    visiting.delete(row.name);
    visited.add(row.name);
    ordered.push(row);
  }
  rows.forEach(visit);
  await client.query('ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS erpnext_account_name TEXT');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_erpnext_name_idx ON app_accounts (erpnext_account_name)');
  await client.query('LOCK TABLE app_accounts IN SHARE ROW EXCLUSIVE MODE');
  const existingRows = (await client.query('SELECT * FROM app_accounts')).rows;
  const existing = new Map(existingRows.map((row) => [row.erpnext_account_name || row.account_code, row]));
  const codes = accountCodePlan(rows, existingRows);
  const ids = new Map();
  const counts = { source_accounts: rows.length, added: 0, updated: 0, unchanged: 0, recoded: 0 };
  for (const row of ordered) {
    const type = String(row.root_type || '').toLowerCase();
    if (!row.name || !['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) {
      throw new Error(`Unsupported root type for ${row.name}`);
    }
    const old = existing.get(row.name);
    const group = Boolean(Number(row.is_group));
    if (old && (old.account_type !== type || old.is_group !== group)) {
      throw new Error(`Account classification changed for ${row.name}; review transaction links before updating.`);
    }
    const code = codes.get(row.name);
    const recoded = old && old.account_code !== code;
    if (old && (recoded || old.erpnext_account_name !== row.name)) {
      await client.query('UPDATE app_accounts SET account_code = $1, erpnext_account_name = $2, updated_at = now() WHERE id = $3', [code, row.name, old.id]);
    }
    if (recoded) counts.recoded++;
    const result = await client.query(`INSERT INTO app_accounts
      (account_code, account_name, account_type, account_detail_type, normal_balance, parent_account_id, is_group, is_active, erpnext_account_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (account_code) DO UPDATE SET
        account_name = EXCLUDED.account_name, account_detail_type = EXCLUDED.account_detail_type,
        parent_account_id = EXCLUDED.parent_account_id, is_active = EXCLUDED.is_active, updated_at = now()
      WHERE (app_accounts.account_name, app_accounts.account_detail_type, app_accounts.parent_account_id, app_accounts.is_active)
        IS DISTINCT FROM (EXCLUDED.account_name, EXCLUDED.account_detail_type, EXCLUDED.parent_account_id, EXCLUDED.is_active)
      RETURNING id`, [code, row.name, type, row.account_type || null,
      ['asset', 'expense'].includes(type) ? 'debit' : 'credit',
      row.parent_account ? ids.get(row.parent_account) : null, group,
      !Number(row.disabled || 0) && String(row.freeze_account || '').toLowerCase() !== 'yes', row.name]);
    ids.set(row.name, result.rows[0]?.id || old.id);
    counts[!old ? 'added' : (result.rowCount || recoded) ? 'updated' : 'unchanged'] += 1;
  }
  return counts;
}

async function main() {
  const rows = await sourceAccounts();
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const counts = await syncAccounts(rows, client);
    const dryRun = process.argv.includes('--dry-run');
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify({ dry_run: dryRun, ...counts }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(closeStore);

module.exports = { syncAccounts };
