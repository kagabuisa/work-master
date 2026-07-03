const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

function usePostgresStore() {
  return String(process.env.INVOICE_STORE || '').toLowerCase() === 'postgres';
}

function postgresSslConfig() {
  const value = String(process.env.POSTGRES_SSL || process.env.PGSSLMODE || '').toLowerCase();
  return ['1', 'true', 'required', 'require', 'yes'].includes(value)
    ? { rejectUnauthorized: false }
    : undefined;
}

function createPool() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  return new Pool(connectionString ? {
    connectionString,
    ssl: postgresSslConfig(),
  } : {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER,
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    database: process.env.PGDATABASE || process.env.POSTGRES_DB,
    ssl: postgresSslConfig(),
  });
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function pass(name, details = {}) {
  return { name, ok: true, ...details };
}

function fail(name, details = {}) {
  return { name, ok: false, ...details };
}

async function voucherBalanceCheck(pool) {
  const { rows } = await pool.query(`
    SELECT
      voucher_type,
      voucher_id,
      COALESCE(voucher_no, '') AS voucher_no,
      ROUND(SUM(debit)::numeric, 2)::float AS debit,
      ROUND(SUM(credit)::numeric, 2)::float AS credit,
      ROUND((SUM(debit) - SUM(credit))::numeric, 2)::float AS difference
    FROM app_gl_entries
    WHERE voucher_id IS NOT NULL
    GROUP BY voucher_type, voucher_id, voucher_no
    HAVING ROUND((SUM(debit) - SUM(credit))::numeric, 2) <> 0
    ORDER BY voucher_type, voucher_id
    LIMIT 20
  `);
  return rows.length
    ? fail('voucher_balance', { unbalanced_vouchers: rows })
    : pass('voucher_balance');
}

async function overallGlBalanceCheck(pool) {
  const { rows } = await pool.query(`
    SELECT
      ROUND(COALESCE(SUM(debit), 0)::numeric, 2)::float AS debit,
      ROUND(COALESCE(SUM(credit), 0)::numeric, 2)::float AS credit,
      ROUND((COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0))::numeric, 2)::float AS difference
    FROM app_gl_entries
  `);
  const row = rows[0] || {};
  return roundMoney(row.difference) === 0
    ? pass('overall_gl_balance', row)
    : fail('overall_gl_balance', row);
}

async function balanceSheetCheck(pool) {
  const { rows } = await pool.query(`
    WITH balances AS (
      SELECT
        account.account_type,
        COALESCE(SUM(gl.debit), 0) AS debit,
        COALESCE(SUM(gl.credit), 0) AS credit
      FROM app_accounts account
      LEFT JOIN app_gl_entries gl ON gl.account_id = account.id
      WHERE account.is_group = false
        AND account.is_active = true
      GROUP BY account.account_type
    )
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'asset' THEN debit - credit ELSE 0 END), 0)::numeric, 2)::float AS assets,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'liability' THEN credit - debit ELSE 0 END), 0)::numeric, 2)::float AS liabilities,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'equity' THEN credit - debit ELSE 0 END), 0)::numeric, 2)::float AS equity,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'income' THEN credit - debit ELSE 0 END), 0)::numeric, 2)::float AS income,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'expense' THEN debit - credit ELSE 0 END), 0)::numeric, 2)::float AS expenses
    FROM balances
  `);
  const row = rows[0] || {};
  const assets = roundMoney(row.assets);
  const liabilities = roundMoney(row.liabilities);
  const equity = roundMoney(row.equity);
  const currentEarnings = roundMoney(Number(row.income || 0) - Number(row.expenses || 0));
  const liabilitiesPlusEquity = roundMoney(liabilities + equity + currentEarnings);
  const difference = roundMoney(assets - liabilitiesPlusEquity);
  const details = { assets, liabilities, equity, current_earnings: currentEarnings, liabilities_plus_equity: liabilitiesPlusEquity, difference };
  return difference === 0
    ? pass('balance_sheet_balance', details)
    : fail('balance_sheet_balance', details);
}

async function accountsReceivableCheck(pool) {
  const { rows } = await pool.query(`
    WITH ar_account AS (
      SELECT account_id
      FROM app_accounting_settings
      WHERE setting_key = 'accounts_receivable'
    ),
    invoice_totals AS (
      SELECT
        COALESCE(SUM(invoice.total), 0) AS invoice_total,
        COALESCE(SUM(invoice.amount_paid), 0) AS paid_total
      FROM app_invoices invoice
      WHERE invoice.docstatus = 'submitted'
    ),
    gl_totals AS (
      SELECT COALESCE(SUM(gl.debit - gl.credit), 0) AS gl_balance
      FROM app_gl_entries gl
      WHERE gl.account_id = (SELECT account_id FROM ar_account)
    )
    SELECT
      ROUND(invoice_totals.invoice_total::numeric, 2)::float AS invoice_total,
      ROUND(invoice_totals.paid_total::numeric, 2)::float AS paid_total,
      ROUND((invoice_totals.invoice_total - invoice_totals.paid_total)::numeric, 2)::float AS expected_balance,
      ROUND(gl_totals.gl_balance::numeric, 2)::float AS gl_balance,
      ROUND((gl_totals.gl_balance - (invoice_totals.invoice_total - invoice_totals.paid_total))::numeric, 2)::float AS difference
    FROM invoice_totals, gl_totals
  `);
  const row = rows[0] || {};
  return roundMoney(row.difference) === 0
    ? pass('accounts_receivable_subledger', row)
    : fail('accounts_receivable_subledger', row);
}

async function inventoryCheck(pool) {
  const { rows } = await pool.query(`
    WITH inventory_account AS (
      SELECT account_id
      FROM app_accounting_settings
      WHERE setting_key = 'inventory'
    ),
    stock_totals AS (
      SELECT COALESCE(SUM(stock_value), 0) AS stock_value
      FROM app_stock_balances
    ),
    gl_totals AS (
      SELECT COALESCE(SUM(gl.debit - gl.credit), 0) AS gl_balance
      FROM app_gl_entries gl
      WHERE gl.account_id = (SELECT account_id FROM inventory_account)
    )
    SELECT
      ROUND(stock_totals.stock_value::numeric, 2)::float AS stock_value,
      ROUND(gl_totals.gl_balance::numeric, 2)::float AS gl_balance,
      ROUND((gl_totals.gl_balance - stock_totals.stock_value)::numeric, 2)::float AS difference
    FROM stock_totals, gl_totals
  `);
  const row = rows[0] || {};
  return roundMoney(row.difference) === 0
    ? pass('inventory_stock_value', row)
    : fail('inventory_stock_value', row);
}

async function main() {
  if (!usePostgresStore()) {
    throw new Error('Accounting verification requires INVOICE_STORE=postgres.');
  }

  const pool = createPool();
  try {
    const checks = [
      await voucherBalanceCheck(pool),
      await overallGlBalanceCheck(pool),
      await balanceSheetCheck(pool),
      await accountsReceivableCheck(pool),
      await inventoryCheck(pool),
    ];
    const ok = checks.every((check) => check.ok);
    console.log(JSON.stringify({ ok, checks }, null, 2));
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
