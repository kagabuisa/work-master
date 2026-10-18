'use strict';
// Schema bootstrap and historical backfills run under this session lock.
// Version 1 only recorded that the old startup bootstrap had run. Version 2
// executes the current idempotent bootstrap once for new and v1 databases.
const { initPostgresStore, initReconciliationAttachments } = require('./domain/schema');
const { initAuth } = require('./auth');
const { getPostgresPool } = require('./core');

const SCHEMA_VERSION = 40;

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
  {
    version: 11,
    name: 'journal_purchase_invoice_allocations',
    up: async (client) => {
      await client.query('ALTER TABLE app_journal_entry_lines ADD COLUMN IF NOT EXISTS reference_no TEXT');
      await client.query('ALTER TABLE app_purchase_payments ADD COLUMN IF NOT EXISTS journal_entry_id BIGINT REFERENCES app_journal_entries(id) ON DELETE SET NULL');
      await client.query('CREATE INDEX IF NOT EXISTS app_purchase_payments_journal_idx ON app_purchase_payments(journal_entry_id)');
    },
  },
  { version: 12, name: 'reconciliation_attachments_and_spreadsheets', up: initReconciliationAttachments },
  { version: 13, name: 'hr_and_payroll', transactional: false, up: async () => {
    const { initHrSchema, HR_TABLES } = require('./hr-schema');
    const { withPostgresTransaction } = require('./core');
    await withPostgresTransaction(initHrSchema);
    await require('./audit').initRecordAudit(getPostgresPool(), HR_TABLES);
  } },
  { version: 14, name: 'hr_working_week_and_payroll_review', up: async (client) => {
    await client.query("ALTER TABLE app_hr_settings ADD COLUMN IF NOT EXISTS working_weekdays JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb");
    await client.query('ALTER TABLE app_hr_runs ADD COLUMN IF NOT EXISTS review_version INTEGER NOT NULL DEFAULT 0');
  } },
  { version: 15, name: 'hr_employee_personal_details', up: async (client) => {
    await client.query("ALTER TABLE app_hr_profiles ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb");
  } },
  { version: 16, name: 'employee_employment_status', up: async (client) => {
    await client.query(`UPDATE app_master_employees SET status=CASE
      WHEN lower(status)='active' THEN 'Active' WHEN lower(status)='left' THEN 'Left'
      WHEN disabled AND NULLIF(trim(status),'') IS NULL THEN 'Left' ELSE status END`);
    await client.query("UPDATE app_master_employees SET disabled=COALESCE(status='Left',false)");
  } },
  { version: 17, name: 'local_daily_activity_reports', transactional: false, up: async () => {
    const { withPostgresTransaction } = require('./core');
    const { initDailyActivitySchema } = require('./daily-activity-schema');
    await withPostgresTransaction(initDailyActivitySchema);
    await require('./audit').initRecordAudit(getPostgresPool(), ['app_daily_activity_reports']);
  } },
  { version: 18, name: 'api_foundation', up: require('./api/schema').initApiSchema },
  { version: 19, name: 'api_retry_resource_audit', up: async client => {
    await client.query(`ALTER TABLE wm_api_idempotency ADD COLUMN IF NOT EXISTS resource_type text;
      ALTER TABLE wm_api_idempotency ADD COLUMN IF NOT EXISTS resource_id text;
      UPDATE wm_api_idempotency SET resource_type=CASE WHEN operation='payment.record' THEN 'payment' ELSE 'invoice' END,
        resource_id=response->'data'->>'id'
      WHERE operation IN ('invoice.create','invoice.submit','payment.record')
        AND resource_type IS NULL AND (response->'data'->>'id') ~ '^[1-9][0-9]*$'`);
  } },
  { version: 20, name: 'unique_master_display_names', up: require('./master-display').ensureUniqueMasterNames },
  { version: 21, name: 'transaction_reset_maintenance', up: require('./maintenance-schema').initMaintenanceSchema },
  { version: 22, name: 'reconciliation_photo_counts', up: require('./photo-count').initPhotoCountSchema },
  { version: 23, name: 'voucher_search_indexes', transactional: false, up: async () => {
    await require('./domain/search-sql').createSearchIndexes(getPostgresPool(), true);
  } },
  { version: 24, name: 'transactional_ledger_daily_balances', up: require('./gl-daily').initGlDaily },
  { version: 25, name: 'invoice_payment_journal_lookup', transactional:false,
    up: () => require('./domain/search-sql').createPaymentJournalIndex(getPostgresPool()) },
  { version: 26, name: 'interactive_search_statistics', up: require('./query-statistics').tuneQueryStatistics },
  { version: 27, name: 'invoice_journal_line_reference_lookup', transactional:false,
    up: () => require('./domain/search-sql').createJournalLineReferenceIndex(getPostgresPool()) },
  { version: 28, name: 'invoice_ownership_lookup', transactional:false,
    up: () => require('./domain/search-sql').createInvoiceOwnershipIndexes(getPostgresPool()) },
  { version:29, name:'invoice_detail_payment_lookup', transactional:false,
    up:()=>require('./domain/search-sql').createInvoiceDetailReferenceIndex(getPostgresPool()) },
  { version:30, name:'invoice_warehouse_choice_lookup', transactional:false,
    up:()=>require('./domain/search-sql').createInvoiceWarehouseIndex(getPostgresPool()) },
  { version:31, name:'purchase_payment_journals', up: require('./purchase-payment-posting').backfillPurchasePaymentJournals },
  { version:32, name:'purchase_payment_accounts', up: async client => {
    await client.query('ALTER TABLE app_purchase_payments ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES app_accounts(id)');
    await client.query(`UPDATE app_purchase_payments payment SET account_id=line.account_id
      FROM app_journal_entry_lines line WHERE line.journal_entry_id=payment.journal_entry_id
        AND line.line_no=2 AND payment.method <> 'journal' AND payment.account_id IS NULL`);
  } },
  { version:33, name:'controlled_warehouse_counts', up: async client => {
    // Entire installation is transactional; preserve a completed installation when upgrade fixtures replay older migrations.
    if ((await client.query("SELECT to_regclass('wm_inventory_policy') IS NOT NULL AS installed")).rows[0].installed) return;
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'sql/inventory-control.sql'),'utf8'));
  } },
  { version:34, name:'excel_count_revisions', up: async client => {
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'sql/inventory-count-import.sql'),'utf8'));
  } },
  { version:35, name:'administrator_reconciliation_authority', up: async client => {
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'sql/inventory-count-admin.sql'),'utf8'));
  } },
  { version:36, name:'posting_date_policy', up: async client => {
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'sql/posting-date-policy.sql'),'utf8'));
  } },
  { version:37, name:'inventory_document_history_rules', up: async client => {
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'sql/inventory-document-rules.sql'),'utf8'));
  } },
  { version:38, name:'inventory_posting_event_lookup', transactional:false,
    up:()=>require('./inventory-indexes').createStockPostingEventIndex(getPostgresPool()) },
  { version:39, name:'stock_entry_delivery_and_sharing', up: require('./stock-entry-workflow').initStockEntryWorkflow },
  { version:40, name:'stock_entry_read_write_sharing', up: require('./stock-entry-workflow').initStockEntrySharePermissions },
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
