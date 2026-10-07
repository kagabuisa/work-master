'use strict';
// Schema bootstrap and historical backfills run under this session lock.
// Version 1 only recorded that the old startup bootstrap had run. Version 2
// executes the current idempotent bootstrap once for new and v1 databases.
const { initPostgresStore } = require('./domain/schema');
const { initAuth } = require('./auth');
const { getPostgresPool } = require('./core');

const SCHEMA_VERSION = 10;

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
  {
    version: 4,
    name: 'voucher_cost_centers',
    up: async (client) => {
      for (const table of ['app_purchases', 'app_purchase_orders', 'app_stock_entries',
        'app_gl_entries', 'app_journal_entries']) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cost_center TEXT`);
      }
    },
  },
  {
    version: 5,
    name: 'invoice_item_snapshot_columns',
    up: async (client) => {
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(14, 2) NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS gross_profit NUMERIC(14, 2) NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS item_category TEXT');
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS source TEXT');
      await client.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost NUMERIC(14, 2)');
      await client.query(`UPDATE app_invoice_items line SET
        item_category = COALESCE(line.item_category, item.category),
        source = COALESCE(line.source, item.source),
        cost = COALESCE(line.cost, item.unit_cost)
        FROM app_master_items item WHERE line.item_code = item.item_code
          AND (line.item_category IS NULL OR line.source IS NULL OR line.cost IS NULL)`);
    },
  },
  {
    version: 6,
    name: 'invoice_report_user_columns',
    up: async (client) => {
      await client.query('ALTER TABLE app_users ADD COLUMN IF NOT EXISTS invoice_report_columns JSONB');
    },
  },
  {
    version: 7,
    name: 'voucher_report_user_columns',
    up: async (client) => {
      for (const column of ['purchase_report_columns', 'purchase_order_report_columns', 'journal_report_columns']) {
        await client.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS ${column} JSONB`);
      }
    },
  },
  {
    version: 8,
    name: 'user_master_record_access',
    up: async (client) => {
      await client.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS record_access JSONB NOT NULL DEFAULT '{}'::jsonb");
    },
  },
  {
    version: 9,
    name: 'session_idle_activity',
    up: async (client) => {
      await client.query('ALTER TABLE app_user_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ');
      await client.query('UPDATE app_user_sessions SET last_activity_at = COALESCE(created_at, now()) WHERE last_activity_at IS NULL');
      await client.query('ALTER TABLE app_user_sessions ALTER COLUMN last_activity_at SET DEFAULT now()');
      await client.query('ALTER TABLE app_user_sessions ALTER COLUMN last_activity_at SET NOT NULL');
    },
  },
  {
    version: 10,
    name: 'invoice_journal_reference_index',
    transactional: false,
    up: async () => {
      const pool = getPostgresPool();
      const { rowCount } = await pool.query(`
        SELECT 1 FROM pg_class index_relation
        JOIN pg_index index_info ON index_info.indexrelid = index_relation.oid
        WHERE index_relation.relname = 'app_journal_entries_invoice_reference_idx'
          AND NOT index_info.indisvalid
      `);
      if (rowCount) {
        await pool.query('DROP INDEX CONCURRENTLY IF EXISTS app_journal_entries_invoice_reference_idx');
      }
      await pool.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS app_journal_entries_invoice_reference_idx
        ON app_journal_entries(reference_no)
        WHERE docstatus = 'submitted' AND party_type = 'customer'
          AND journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
      `);
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
