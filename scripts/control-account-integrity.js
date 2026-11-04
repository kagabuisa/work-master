'use strict';

require('../src/environment').loadEnvironment();

const { closeStore, getPostgresPool } = require('../src/core');

async function main() {
  const pool = getPostgresPool();
  const { rows } = await pool.query(`SELECT account_id, account_code, account_name,
      setting_key, party_type, party_id, row_count,
      first_posting_date::text, last_posting_date::text,
      debit::float, credit::float, balance::float
    FROM wm_control_account_exceptions
    ORDER BY setting_key, account_code, party_type, party_id`);
  const result = {
    ok: rows.length === 0,
    checked_at: new Date().toISOString(),
    exception_groups: rows.length,
    exception_rows: rows.reduce((sum, row) => sum + Number(row.row_count), 0),
    exception_balance: rows.reduce((sum, row) => sum + Number(row.balance), 0),
    exceptions: rows,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'control_account_integrity_failed',
    error: error.message,
  }));
  process.exitCode = 1;
}).finally(async () => {
  try { await closeStore(); } catch { /* process is exiting */ }
});
