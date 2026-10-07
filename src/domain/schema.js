'use strict';
// Schema bootstrap: table DDL, startup migrations and default-account seeding.
// Extracted from store.js.
const { getPostgresPool } = require('../core');
const { DEFAULT_ACCOUNTS } = require('../constants');
const { initRecordAudit } = require('../audit');
const pricing = require('../pricing');
const { postSalesInvoiceGlEntry, createOrUpdatePaymentJournalEntry } = require('./posting');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');

async function initPostgresStore() {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_items (
      item_code TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      stock_uom TEXT,
      category TEXT,
      description TEXT,
      default_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
      markup NUMERIC(14, 2) NOT NULL DEFAULT 0,
      qty_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      cbm_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      weight_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      import_fob NUMERIC(14, 2) NOT NULL DEFAULT 0,
      exporter TEXT,
      source TEXT,
      photo_count_id TEXT,
      is_sales_item BOOLEAN NOT NULL DEFAULT true,
      is_purchase_item BOOLEAN NOT NULL DEFAULT true,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS markup NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS qty_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS cbm_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS weight_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS import_fob NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS exporter TEXT');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS source TEXT');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS photo_count_id TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_customers (
      customer_id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_group TEXT,
      territory TEXT,
      phone TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_customers ADD COLUMN IF NOT EXISTS tin TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_suppliers (
      supplier_id TEXT PRIMARY KEY,
      supplier_name TEXT NOT NULL,
      supplier_type TEXT,
      phone TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_warehouses (
      warehouse TEXT PRIMARY KEY,
      warehouse_type TEXT,
      is_group BOOLEAN NOT NULL DEFAULT false,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_warehouses ADD COLUMN IF NOT EXISTS warehouse_type TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_employees (
      employee_id TEXT PRIMARY KEY,
      employee_name TEXT NOT NULL,
      status TEXT,
      company TEXT,
      department TEXT,
      designation TEXT,
      phone TEXT,
      email TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_cost_centers (
      cost_center TEXT PRIMARY KEY,
      cost_center_name TEXT NOT NULL,
      parent_cost_center TEXT,
      company TEXT,
      cost_center_type TEXT,
      is_group BOOLEAN NOT NULL DEFAULT false,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_options (
      id BIGSERIAL PRIMARY KEY,
      option_group TEXT NOT NULL,
      option_value TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (option_group, option_value)
    )
  `);
  await pricing.initPricingTables(pool);
  for (const table of ['app_master_items', 'app_master_customers', 'app_master_suppliers', 'app_master_warehouses', 'app_master_employees', 'app_master_cost_centers', 'app_master_options']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS legacy_editable BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`UPDATE ${table} SET disabled = true, docstatus = 'submitted' WHERE docstatus IN ('draft', 'cancelled')`);
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN docstatus SET DEFAULT 'submitted'`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS active SMALLINT
      GENERATED ALWAYS AS (CASE WHEN NOT disabled AND docstatus = 'submitted' THEN 1 ELSE 0 END) STORED`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_company_information (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_display_settings (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
      time_format TEXT NOT NULL DEFAULT '24h'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoices (
      id BIGSERIAL PRIMARY KEY,
      invoice_no TEXT UNIQUE,
      non_system_invoice TEXT,
      docstatus TEXT NOT NULL DEFAULT 'draft',
      invoice_date DATE NOT NULL,
      posting_time TIME NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time),
      due_date DATE,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      price_list TEXT,
      cost_center TEXT,
      invoicer_id TEXT,
      invoicer TEXT,
      notes TEXT,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
      tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS is_cash_sale BOOLEAN');
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS non_system_invoice TEXT');
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS price_list TEXT');
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS cost_center TEXT');
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS invoicer_id TEXT');
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS invoicer TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoice_items (
      id BIGSERIAL PRIMARY KEY,
      invoice_pk BIGINT NOT NULL REFERENCES app_invoices(id) ON DELETE CASCADE,
      invoice_id BIGINT,
      invoice_no TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT,
      quantity NUMERIC(14, 3) NOT NULL,
      unit_price NUMERIC(14, 2) NOT NULL,
      stock_at_sale NUMERIC(14, 3),
      line_total NUMERIC(14, 2) NOT NULL,
      UNIQUE (invoice_pk, line_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoice_payments (
      id BIGSERIAL PRIMARY KEY,
      invoice_id BIGINT NOT NULL REFERENCES app_invoices(id) ON DELETE CASCADE,
      payment_no INTEGER NOT NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(14, 2) NOT NULL,
      method TEXT NOT NULL,
      account_id BIGINT,
      reference TEXT,
      notes TEXT,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (invoice_id, payment_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchases (
      id BIGSERIAL PRIMARY KEY,
      purchase_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'draft',
      posting_date DATE NOT NULL,
      posting_time TIME NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time),
      due_date DATE,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      price_list TEXT,
      supplier_reference TEXT,
      remarks TEXT,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_items (
      id BIGSERIAL PRIMARY KEY,
      purchase_id BIGINT NOT NULL REFERENCES app_purchases(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      quantity NUMERIC(14, 3) NOT NULL,
      unit_price NUMERIC(14, 2) NOT NULL,
      line_total NUMERIC(14, 2) NOT NULL,
      UNIQUE (purchase_id, line_no)
    )
  `);
  await pool.query('ALTER TABLE app_purchases ADD COLUMN IF NOT EXISTS price_list TEXT');
  await pool.query('ALTER TABLE app_purchases ADD COLUMN IF NOT EXISTS cost_center TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_orders (
      id BIGSERIAL PRIMARY KEY,
      order_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'draft' CHECK (docstatus IN ('draft', 'submitted', 'cancelled')),
      posting_date DATE NOT NULL,
      posting_time TIME NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time),
      due_date DATE,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      price_list TEXT NOT NULL,
      supplier_reference TEXT,
      remarks TEXT,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      submitted_by TEXT,
      submitted_by_user_id TEXT,
      submitted_at TIMESTAMPTZ,
      cancelled_by TEXT,
      cancelled_by_user_id TEXT,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_order_items (
      id BIGSERIAL PRIMARY KEY,
      purchase_order_id BIGINT NOT NULL REFERENCES app_purchase_orders(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      quantity NUMERIC(14, 3) NOT NULL,
      unit_price NUMERIC(14, 2) NOT NULL,
      line_total NUMERIC(14, 2) NOT NULL,
      UNIQUE (purchase_order_id, line_no)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchase_orders_date_idx ON app_purchase_orders(posting_date DESC, id DESC)');
  await pool.query('ALTER TABLE app_purchase_orders ADD COLUMN IF NOT EXISTS cost_center TEXT');
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchase_orders_supplier_idx ON app_purchase_orders(supplier_id, posting_date DESC)');
  await pool.query('ALTER TABLE app_purchases ADD COLUMN IF NOT EXISTS purchase_order_id BIGINT REFERENCES app_purchase_orders(id)');
  await pool.query('ALTER TABLE app_purchase_items ADD COLUMN IF NOT EXISTS purchase_order_item_id BIGINT REFERENCES app_purchase_order_items(id)');
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchases_order_idx ON app_purchases(purchase_order_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchase_items_order_item_idx ON app_purchase_items(purchase_order_item_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_payments (
      id BIGSERIAL PRIMARY KEY,
      purchase_id BIGINT NOT NULL REFERENCES app_purchases(id) ON DELETE CASCADE,
      payment_no INTEGER NOT NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(14, 2) NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (purchase_id, payment_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_entries (
      id BIGSERIAL PRIMARY KEY,
      entry_no TEXT UNIQUE,
      entry_type TEXT NOT NULL,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      posting_date DATE NOT NULL,
      posting_time TIME NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time),
      remarks TEXT,
      supplier_name TEXT,
      supplier_contact TEXT,
      supplier_phone TEXT,
      supplier_reference TEXT,
      cancelled_at TIMESTAMPTZ,
      cancellation_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_entry_items (
      id BIGSERIAL PRIMARY KEY,
      stock_entry_id BIGINT NOT NULL REFERENCES app_stock_entries(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT,
      target_warehouse TEXT,
      quantity NUMERIC(14, 3) NOT NULL,
      counted_quantity NUMERIC(14, 3),
      valuation_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      UNIQUE (stock_entry_id, line_no)
    )
  `);
  await pool.query('ALTER TABLE app_stock_entry_items ADD COLUMN IF NOT EXISTS counted_quantity NUMERIC(14, 3)');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS cost_center TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_balances (
      item_code TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
      stock_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
      valuation_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_code, warehouse)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_ledger (
      id BIGSERIAL PRIMARY KEY,
      posting_date DATE NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      voucher_type TEXT NOT NULL,
      voucher_id BIGINT,
      voucher_no TEXT,
      qty_change NUMERIC(14, 3) NOT NULL,
      incoming_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      outgoing_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      stock_value_change NUMERIC(14, 2) NOT NULL DEFAULT 0,
      qty_after_transaction NUMERIC(14, 3) NOT NULL,
      stock_value_after_transaction NUMERIC(14, 2) NOT NULL,
      is_reversal BOOLEAN NOT NULL DEFAULT false,
      reversal_of_voucher_id BIGINT,
      reversal_of_voucher_no TEXT,
      remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounts (
      id BIGSERIAL PRIMARY KEY,
      account_code TEXT UNIQUE,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      account_detail_type TEXT,
      normal_balance TEXT NOT NULL,
      parent_account_id BIGINT REFERENCES app_accounts(id),
      is_group BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
      CHECK (normal_balance IN ('debit', 'credit'))
    )
  `);
  await pool.query('ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS account_detail_type TEXT');
  await pool.query('ALTER TABLE app_invoice_payments ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES app_accounts(id)');
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_payments_account_id_fkey'
        AND conrelid = 'app_invoice_payments'::regclass) THEN
        ALTER TABLE app_invoice_payments ADD CONSTRAINT app_invoice_payments_account_id_fkey
          FOREIGN KEY (account_id) REFERENCES app_accounts(id);
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounting_settings (
      setting_key TEXT PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_gl_entries (
      id BIGSERIAL PRIMARY KEY,
      posting_date DATE NOT NULL,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      party_type TEXT,
      party_id TEXT,
      party_name TEXT,
      voucher_type TEXT NOT NULL,
      voucher_id BIGINT,
      voucher_no TEXT,
      line_no INTEGER NOT NULL,
      debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      is_reversal BOOLEAN NOT NULL DEFAULT false,
      reversal_of_voucher_type TEXT,
      reversal_of_voucher_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (debit >= 0 AND credit >= 0),
      CHECK (debit = 0 OR credit = 0)
    )
  `);
  await pool.query('ALTER TABLE app_gl_entries ADD COLUMN IF NOT EXISTS cost_center TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_journal_entries (
      id BIGSERIAL PRIMARY KEY,
      journal_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      journal_type TEXT NOT NULL,
      posting_date DATE NOT NULL,
      posting_time TIME NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time),
      party_type TEXT,
      party_id TEXT,
      party_name TEXT,
      reference_no TEXT,
      remarks TEXT,
      total_debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total_credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'))
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_journal_entry_lines (
      id BIGSERIAL PRIMARY KEY,
      journal_entry_id BIGINT NOT NULL REFERENCES app_journal_entries(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      UNIQUE (journal_entry_id, line_no),
      CHECK (debit >= 0 AND credit >= 0),
      CHECK (debit = 0 OR credit = 0)
    )
  `);
  await pool.query('ALTER TABLE app_journal_entries ADD COLUMN IF NOT EXISTS cost_center TEXT');
  for (const table of ['app_invoices', 'app_purchases', 'app_stock_entries', 'app_journal_entries']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS posting_time TIME NOT NULL DEFAULT '00:00:00'`);
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN posting_time SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala')::time)`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_by TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_by TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_by_user_id TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  }
  await initRecordAudit(pool);
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS gross_profit NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS item_category TEXT');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS source TEXT');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost NUMERIC(14, 2)');
  await pool.query(`UPDATE app_invoice_items line SET
    item_category = COALESCE(line.item_category, item.category),
    source = COALESCE(line.source, item.source),
    cost = COALESCE(line.cost, item.unit_cost)
    FROM app_master_items item WHERE line.item_code = item.item_code
      AND (line.item_category IS NULL OR line.source IS NULL OR line.cost IS NULL)`);
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_name TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_contact TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_phone TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_reference TEXT');
  await pool.query("ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS cancellation_reason TEXT');
  await pool.query("UPDATE app_stock_entries SET docstatus = 'submitted' WHERE docstatus IS NULL OR docstatus = ''");
  await pool.query("ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN NOT NULL DEFAULT false");
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS reversal_of_voucher_id BIGINT');
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS reversal_of_voucher_no TEXT');
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS remarks TEXT');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_balances_warehouse_idx
    ON app_stock_balances(warehouse)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_ledger_item_warehouse_date_idx
    ON app_stock_ledger(item_code, warehouse, posting_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_ledger_voucher_idx
    ON app_stock_ledger(voucher_type, voucher_id)
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchases_date_idx ON app_purchases(posting_date DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchases_supplier_idx ON app_purchases(supplier_id, posting_date DESC)');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_purchases_supplier_reference_idx
    ON app_purchases(supplier_id, LOWER(supplier_reference))
    WHERE supplier_reference IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_gl_entries_voucher_line_idx
    ON app_gl_entries(voucher_type, voucher_id, line_no)
    WHERE voucher_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_account_date_idx
    ON app_gl_entries(account_id, posting_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_voucher_idx
    ON app_gl_entries(voucher_type, voucher_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_party_idx
    ON app_gl_entries(party_type, party_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_journal_entries_date_idx
    ON app_journal_entries(posting_date, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_journal_entry_lines_account_idx
    ON app_journal_entry_lines(account_id)
  `);
  await pool.query('ALTER TABLE app_invoice_payments ADD COLUMN IF NOT EXISTS journal_entry_id BIGINT REFERENCES app_journal_entries(id)');
  await pool.query("ALTER TABLE app_invoice_payments ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("ALTER TABLE app_purchase_payments ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("ALTER TABLE app_journal_entries ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("UPDATE app_journal_entries SET docstatus = 'submitted' WHERE docstatus IS NULL OR docstatus = ''");
  await pool.query('ALTER TABLE app_journal_entries DROP CONSTRAINT IF EXISTS app_journal_entries_journal_type_check');
  await pool.query(`
    ALTER TABLE app_journal_entries
    ADD CONSTRAINT app_journal_entries_journal_type_check
    CHECK (journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'))
  `);
  await migratePostgresInvoiceItems(pool);
  await seedDefaultAccounts(pool);
  await backfillDefaultAccountDetailTypes(pool);
  await backfillInvoicePostingTimes(pool);
  await createPerformanceIndexes(pool);
  await syncAllPostgresInvoicePaymentTotals(pool);
  await backfillSalesInvoiceJournals(pool);
  await backfillInvoicePaymentJournals(pool);
}

async function createPerformanceIndexes(pool) {
  const optionalQueries = [
    'CREATE EXTENSION IF NOT EXISTS pg_trgm',
    'CREATE INDEX IF NOT EXISTS app_invoices_date_id_idx ON app_invoices(invoice_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_invoices_customer_trgm_idx ON app_invoices USING gin (LOWER(customer_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_invoices_no_trgm_idx ON app_invoices USING gin (LOWER(invoice_no) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_items_name_trgm_idx ON app_master_items USING gin (LOWER(item_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_items_code_trgm_idx ON app_master_items USING gin (LOWER(item_code) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_customers_name_trgm_idx ON app_master_customers USING gin (LOWER(customer_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_suppliers_name_trgm_idx ON app_master_suppliers USING gin (LOWER(supplier_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_employees_name_trgm_idx ON app_master_employees USING gin (LOWER(employee_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_employees_id_trgm_idx ON app_master_employees USING gin (LOWER(employee_id) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_cost_centers_name_trgm_idx ON app_master_cost_centers USING gin (LOWER(cost_center_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_cost_centers_id_trgm_idx ON app_master_cost_centers USING gin (LOWER(cost_center) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_stock_ledger_date_id_idx ON app_stock_ledger(posting_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_gl_entries_date_id_idx ON app_gl_entries(posting_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_gl_entries_party_name_trgm_idx ON app_gl_entries USING gin (LOWER(party_name) gin_trgm_ops)',
  ];
  for (const query of optionalQueries) {
    try {
      await pool.query(query);
    } catch (err) {
      console.warn(`Skipped optional performance index: ${err.message}`);
    }
  }
}

async function migratePostgresInvoiceItems(pool) {
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS invoice_pk BIGINT');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS invoice_no TEXT');
  await pool.query(`
    DO $$
    DECLARE
      invoice_id_type TEXT;
    BEGIN
      SELECT data_type
      INTO invoice_id_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'app_invoice_items'
        AND column_name = 'invoice_id';

      IF invoice_id_type IS NULL THEN
        UPDATE app_invoice_items item
        SET invoice_pk = invoice.id
        FROM app_invoices invoice
        WHERE item.invoice_no = invoice.invoice_no
          AND item.invoice_pk IS NULL;
      ELSIF invoice_id_type IN ('bigint', 'integer', 'numeric') THEN
        EXECUTE 'UPDATE app_invoice_items SET invoice_pk = invoice_id::bigint WHERE invoice_pk IS NULL';
      ELSE
        UPDATE app_invoice_items item
        SET invoice_pk = invoice.id
        FROM app_invoices invoice
        WHERE item.invoice_id = invoice.invoice_no
          AND item.invoice_pk IS NULL;
      END IF;
    END $$;
  `);
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_id_fkey');
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_id_line_no_key');
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_pk_line_no_key');
  await pool.query(`
    UPDATE app_invoice_items item
    SET invoice_no = invoice.invoice_no
    FROM app_invoices invoice
    WHERE item.invoice_pk = invoice.id
      AND item.invoice_no IS DISTINCT FROM invoice.invoice_no
  `);
  await pool.query('DROP INDEX IF EXISTS app_invoice_items_invoice_id_idx');
  await pool.query('ALTER TABLE app_invoice_items DROP COLUMN IF EXISTS invoice_id');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN invoice_id BIGINT');
  await pool.query('UPDATE app_invoice_items SET invoice_id = invoice_pk WHERE invoice_id IS NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_no SET NOT NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_pk SET NOT NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_id SET NOT NULL');
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_pk_fkey'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_pk_fkey
        FOREIGN KEY (invoice_pk) REFERENCES app_invoices(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_id_fkey'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_id_fkey
        FOREIGN KEY (invoice_id) REFERENCES app_invoices(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_pk_line_no_key'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_pk_line_no_key
        UNIQUE (invoice_pk, line_no);
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_invoice_items_invoice_no_idx
    ON app_invoice_items(invoice_no)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_invoice_items_invoice_id_idx
    ON app_invoice_items(invoice_id)
  `);
}

async function seedDefaultAccounts(pool) {
  for (const account of DEFAULT_ACCOUNTS) {
    const existing = await pool.query(
      'SELECT account_id FROM app_accounting_settings WHERE setting_key = $1',
      [account.key],
    );
    if (existing.rows.length) continue;
    await pool.query(
      `
      INSERT INTO app_accounts (
        account_code, account_name, account_type, normal_balance, account_detail_type
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_code) DO NOTHING
      `,
      [account.code, account.name, account.type, account.normal, account.detailType],
    );
    const { rows } = await pool.query('SELECT id FROM app_accounts WHERE account_code = $1', [account.code]);
    await pool.query(
      `
      INSERT INTO app_accounting_settings (setting_key, account_id)
      VALUES ($1, $2)
      ON CONFLICT (setting_key) DO UPDATE
      SET account_id = EXCLUDED.account_id,
        updated_at = now()
      `,
      [account.key, Number(rows[0].id)],
    );
  }
}

async function backfillDefaultAccountDetailTypes(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS wm_schema_migrations (migration_key TEXT PRIMARY KEY)`);
  await withMigrationTransaction(pool, async (client) => {
    const values = DEFAULT_ACCOUNTS.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ');
    const params = DEFAULT_ACCOUNTS.flatMap((account) => [account.key, account.detailType]);
    await client.query(`
      WITH claimed AS (
        INSERT INTO wm_schema_migrations (migration_key)
        VALUES ('default_account_detail_types_v1')
        ON CONFLICT DO NOTHING
        RETURNING migration_key
      ), mapping (setting_key, detail_type) AS (VALUES ${values})
      UPDATE app_accounts account
      SET account_detail_type = mapping.detail_type, updated_at = now()
      FROM app_accounting_settings setting, mapping
      WHERE account.id = setting.account_id
        AND setting.setting_key = mapping.setting_key
        AND account.account_detail_type IS NULL
        AND EXISTS (SELECT 1 FROM claimed)
    `, params);
  });
}

async function backfillInvoicePostingTimes(pool) {
  await withMigrationTransaction(pool, async (client) => {
    await client.query(`
      WITH claimed AS (
        INSERT INTO wm_schema_migrations (migration_key)
        VALUES ('invoice_posting_time_from_created_at_v1')
        ON CONFLICT DO NOTHING
        RETURNING migration_key
      )
      UPDATE app_invoices
      SET posting_time = (created_at AT TIME ZONE 'Africa/Kampala')::time
      WHERE posting_time = TIME '00:00:00'
        AND created_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM claimed)
    `);
  });
}

async function withMigrationTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncPostgresInvoicePaymentTotals(client, invoiceId) {
  await client.query(
    `
    UPDATE app_invoices invoice
    SET amount_paid = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
        ELSE totals.amount_paid
      END,
      status = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
        WHEN totals.amount_paid <= 0 THEN 'unpaid'
        WHEN totals.amount_paid >= invoice.total THEN 'paid'
        ELSE 'partial'
      END,
      updated_at = now()
    FROM (
      SELECT COALESCE(SUM(amount), 0) AS amount_paid
      FROM app_invoice_payments
      WHERE invoice_id = $1 AND docstatus = 'submitted'
    ) totals
    WHERE invoice.id = $1
    `,
    [invoiceId],
  );
}

async function syncAllPostgresInvoicePaymentTotals(pool) {
  await pool.query(`
    UPDATE app_invoices invoice
    SET amount_paid = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
        ELSE totals.amount_paid
      END,
      status = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
        WHEN totals.amount_paid <= 0 THEN 'unpaid'
        WHEN totals.amount_paid >= invoice.total THEN 'paid'
        ELSE 'partial'
      END
    FROM (
      SELECT invoice.id, COALESCE(SUM(payment.amount), 0) AS amount_paid
      FROM app_invoices invoice
      LEFT JOIN app_invoice_payments payment ON payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      GROUP BY invoice.id
    ) totals
    WHERE invoice.id = totals.id
      AND (
        invoice.amount_paid IS DISTINCT FROM CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
          ELSE totals.amount_paid
        END
        OR invoice.status IS DISTINCT FROM CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
          WHEN totals.amount_paid <= 0 THEN 'unpaid'
          WHEN totals.amount_paid >= invoice.total THEN 'paid'
          ELSE 'partial'
        END
      )
  `);
}
async function backfillSalesInvoiceJournals(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT
        invoice.*,
        COALESCE(SUM(item.cost_amount), 0)::float AS total_cost
      FROM app_invoices invoice
      LEFT JOIN app_invoice_items item ON item.invoice_pk = invoice.id
      WHERE invoice.docstatus = 'submitted'
        AND NOT EXISTS (
          SELECT 1
          FROM app_journal_entries journal
          WHERE journal.journal_type = 'sales_invoice'
            AND journal.reference_no = invoice.invoice_no
        )
      GROUP BY invoice.id
      ORDER BY invoice.id
    `);
    for (const invoice of rows) {
      await postSalesInvoiceGlEntry(client, {
        ...invoice,
        id: Number(invoice.id),
        invoice_date: dateOnly(invoice.invoice_date),
        total_cost: roundMoney(invoice.total_cost),
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function backfillInvoicePaymentJournals(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT
        payment.id,
        payment.payment_no,
        payment.payment_date,
        payment.amount,
        payment.method,
        payment.account_id,
        payment.reference,
        payment.notes,
        payment.journal_entry_id,
        invoice.id AS invoice_id,
        invoice.invoice_no,
        invoice.invoice_date,
        invoice.customer_id,
        invoice.customer_name
      FROM app_invoice_payments payment
      INNER JOIN app_invoices invoice ON invoice.id = payment.invoice_id
      LEFT JOIN app_journal_entries journal ON journal.id = payment.journal_entry_id
      WHERE invoice.docstatus = 'submitted'
        AND payment.docstatus = 'submitted'
        AND (
          payment.journal_entry_id IS NULL
          OR journal.id IS NULL
        )
      ORDER BY payment.id
    `);
    for (const row of rows) {
      await createOrUpdatePaymentJournalEntry(client, {
        id: Number(row.invoice_id),
        invoice_no: row.invoice_no,
        invoice_date: dateOnly(row.invoice_date),
        customer_id: row.customer_id,
        customer_name: row.customer_name,
      }, row);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
module.exports = {
  initPostgresStore,
  createPerformanceIndexes,
  migratePostgresInvoiceItems,
  seedDefaultAccounts,
  backfillDefaultAccountDetailTypes,
  backfillInvoicePostingTimes,
  syncPostgresInvoicePaymentTotals,
  syncAllPostgresInvoicePaymentTotals,
  backfillSalesInvoiceJournals,
  backfillInvoicePaymentJournals,
};
