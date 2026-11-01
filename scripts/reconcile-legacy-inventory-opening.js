'use strict';

const { Pool } = require('pg');
const { databaseTls } = require('../src/database-tls');
require('dotenv').config({ quiet: true });

const TARGETS = [
  { id: 3, entryNo: 'STK-000003', value: 46200000 },
  { id: 9, entryNo: 'STK-000009', value: 35200000 },
  { id: 10, entryNo: 'STK-000010', value: 6600000 },
  { id: 11, entryNo: 'STK-000011', value: 6600000 },
];
const TARGET_TOTAL = TARGETS.reduce((sum, target) => sum + target.value, 0);
const MARKER = 'Legacy opening inventory reconciliation';

function createPool() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  return new Pool(connectionString ? {
    connectionString,
    ssl: databaseTls(process.env.PGSSL || process.env.POSTGRES_SSL || process.env.PGSSLMODE,
      process.env.POSTGRES_SSL_CA_FILE),
  } : {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER,
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    database: process.env.PGDATABASE || process.env.POSTGRES_DB,
    ssl: databaseTls(process.env.PGSSL || process.env.POSTGRES_SSL || process.env.PGSSLMODE,
      process.env.POSTGRES_SSL_CA_FILE),
  });
}

function fail(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

async function preview(client) {
  const ids = TARGETS.map((target) => target.id);
  const { rows: entries } = await client.query(`
    SELECT entry.id, entry.entry_no, entry.entry_type, entry.docstatus,
      entry.posting_date::text, entry.cost_center,
      ROUND(COALESCE(SUM(ledger.stock_value_change), 0)::numeric, 2)::float AS stock_value
    FROM app_stock_entries entry
    LEFT JOIN app_stock_ledger ledger ON ledger.voucher_id = entry.id
      AND ledger.voucher_type = 'stock_purchase'
    WHERE entry.id = ANY($1::bigint[])
    GROUP BY entry.id
    ORDER BY entry.id
  `, [ids]);
  if (entries.length !== TARGETS.length) fail(`Expected ${TARGETS.length} legacy stock entries, found ${entries.length}.`);

  const byId = new Map(entries.map((entry) => [Number(entry.id), entry]));
  for (const target of TARGETS) {
    const entry = byId.get(target.id);
    if (!entry || entry.entry_no !== target.entryNo || entry.entry_type !== 'purchase'
        || entry.docstatus !== 'submitted' || Number(entry.stock_value) !== target.value) {
      fail(`${target.entryNo} does not match the reviewed legacy purchase snapshot.`);
    }
  }

  const { rows: mappings } = await client.query(`
    SELECT setting_key, account_id
    FROM app_accounting_settings
    WHERE setting_key IN ('inventory', 'opening_equity')
  `);
  const inventoryId = Number(mappings.find((row) => row.setting_key === 'inventory')?.account_id);
  const openingEquityId = Number(mappings.find((row) => row.setting_key === 'opening_equity')?.account_id);
  if (!inventoryId || !openingEquityId) fail('Inventory and Opening Equity account mappings are required.');
  const { rows: accounts } = await client.query(`
    SELECT id, account_code, is_group, is_active
    FROM app_accounts
    WHERE id = ANY($1::bigint[])
    ORDER BY id
  `, [[inventoryId, openingEquityId]]);
  if (accounts.length !== 2 || accounts.some((account) => account.is_group || !account.is_active)) {
    fail('Inventory and Opening Equity must be active posting accounts.');
  }

  const { rows: closed } = await client.query(`
    SELECT id
    FROM app_accounting_periods
    WHERE status = 'closed'
      AND period_start <= $2::date
      AND period_end >= $1::date
    LIMIT 1
  `, [entries[0].posting_date, entries.at(-1).posting_date]);
  if (closed.length) fail('A closed accounting period covers the repair dates.');

  const inventoryRows = await client.query(`
    SELECT voucher_id, account_id, debit::float, credit::float, remarks
    FROM app_gl_entries
    WHERE voucher_type = 'stock_purchase'
      AND voucher_id = ANY($1::bigint[])
    ORDER BY voucher_id, line_no, id
  `, [ids]);
  const existing = new Map();
  for (const row of inventoryRows.rows) {
    const list = existing.get(Number(row.voucher_id)) || [];
    list.push(row);
    existing.set(Number(row.voucher_id), list);
  }

  const pending = [];
  const alreadyApplied = [];
  for (const target of TARGETS) {
    const rows = existing.get(target.id) || [];
    if (!rows.length) {
      pending.push(target);
      continue;
    }
    const valid = rows.length === 2
      && rows.some((row) => Number(row.account_id) === inventoryId
        && row.debit === target.value && row.credit === 0
        && row.remarks?.startsWith(MARKER))
      && rows.some((row) => Number(row.account_id) === openingEquityId
        && row.debit === 0 && row.credit === target.value
        && row.remarks?.startsWith(MARKER));
    if (!valid) fail(`${target.entryNo} already has conflicting accounting entries.`);
    alreadyApplied.push(target);
  }

  const { rows: gapRows } = await client.query(`
    WITH stock AS (
      SELECT ROUND(SUM(stock_value_change)::numeric, 2)::float AS value
      FROM app_stock_ledger
    ),
    inventory AS (
      SELECT ROUND(SUM(gl.debit - gl.credit)::numeric, 2)::float AS value
      FROM app_gl_entries gl
      JOIN app_accounting_settings setting ON setting.setting_key = 'inventory'
        AND setting.account_id = gl.account_id
    )
    SELECT ROUND((stock.value - inventory.value)::numeric, 2)::float AS difference
    FROM stock, inventory
  `);
  const pendingTotal = pending.reduce((sum, target) => sum + target.value, 0);
  if (Math.abs(Number(gapRows[0].difference) - pendingTotal) > 0.01) {
    fail(`Inventory GL gap ${gapRows[0].difference} does not equal pending repair value ${pendingTotal}.`);
  }

  return {
    accountIds: { inventory: inventoryId, openingEquity: openingEquityId },
    entries: entries.map((entry) => ({ ...entry, id: Number(entry.id), stock_value: Number(entry.stock_value) })),
    pending,
    alreadyApplied,
    targetTotal: TARGET_TOTAL,
  };
}

async function repairLegacyInventoryOpening(pool, { apply = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1776342162), pg_advisory_xact_lock(1776342163)');
    const plan = await preview(client);
    if (!apply || !plan.pending.length) {
      await client.query('ROLLBACK');
      return { applied: false, ...plan };
    }

    await client.query("SELECT set_config('app.audit_user_id', '', true), set_config('app.audit_username', 'Legacy inventory repair', true)");
    await client.query('ALTER TABLE app_gl_entries DISABLE TRIGGER wm_inventory_gl_guard');
    for (const target of plan.pending) {
      const entry = plan.entries.find((row) => row.id === target.id);
      const remarks = `${MARKER}: ${target.entryNo}`;
      await client.query(`
        INSERT INTO app_gl_entries
          (posting_date, account_id, voucher_type, voucher_id, voucher_no, line_no,
           debit, credit, remarks, cost_center)
        VALUES
          ($1, $2, 'stock_purchase', $3, $4, 1, $5, 0, $6, $7),
          ($1, $8, 'stock_purchase', $3, $4, 2, 0, $5, $6, $7)
      `, [entry.posting_date, plan.accountIds.inventory, target.id, target.entryNo,
        target.value, remarks, entry.cost_center, plan.accountIds.openingEquity]);
    }
    await client.query('ALTER TABLE app_gl_entries ENABLE TRIGGER wm_inventory_gl_guard');
    await client.query('COMMIT');
    return { applied: true, ...plan, appliedEntries: plan.pending };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = createPool();
  try {
    const result = await repairLegacyInventoryOpening(pool, { apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply && result.pending.length) {
      console.log('Dry run only. Re-run with --apply to post the reviewed repair.');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { TARGETS, TARGET_TOTAL, createPool, preview, repairLegacyInventoryOpening };
