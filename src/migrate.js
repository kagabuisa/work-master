'use strict';
// Schema bootstrap and historical backfills run under this session lock.
// Version 1 only recorded that the old startup bootstrap had run. Version 2
// executes the current idempotent bootstrap once for new and v1 databases.
const { initPostgresStore } = require('./domain/schema');
const { initAuth } = require('./auth');

const SCHEMA_VERSION = 3;

// Arbitrary but stable per-app advisory-lock key.
const ADVISORY_LOCK_KEY = 1776342159;

const MIGRATIONS = [
  {
    version: 2,
    name: 'postgres_schema_and_accounting_backfills',
    // Existing bootstrap code uses its own connections and transactions. If it
    // fails, the version is not recorded and the idempotent work can be retried.
    transactional: false,
    up: async () => {
      await initPostgresStore();
      await initAuth();
    },
  },
  {
    version: 3,
    name: 'stock_reconciliation_count',
    up: async (client) => {
      await client.query('ALTER TABLE app_stock_entry_items ADD COLUMN IF NOT EXISTS counted_quantity NUMERIC(14, 3)');
    },
  },
];

async function ensureSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wm_schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0)::int AS version FROM wm_schema_version');
    const current = Number(rows[0].version);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than this app supports (${SCHEMA_VERSION}). Upgrade the application.`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (migration.transactional === false) {
        await migration.up();
        await client.query('INSERT INTO wm_schema_version (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]);
        continue;
      }
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query(
          'INSERT INTO wm_schema_version (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch {
      // A broken connection releases its session lock when it closes.
    }
    client.release();
  }
}

module.exports = { SCHEMA_VERSION, ensureSchema };
