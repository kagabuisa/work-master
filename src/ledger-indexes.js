'use strict';

// Build outside transactions so reporting indexes do not block normal posting.
// Failed concurrent builds are retried rather than retained as invalid indexes.
const INDEXES = [
  ['app_journals_creator_id_idx', 'app_journal_entries(created_by_user_id,id)', 'created_by_user_id IS NOT NULL'],
  ['app_gl_entries_posted_voucher_cover_idx',
    'app_gl_entries(voucher_type,voucher_id) INCLUDE(id,account_id,posting_date,debit,credit)',
    'reversal_of_voucher_id IS NULL'],
  ['app_gl_entries_reversal_source_cover_idx',
    `app_gl_entries(voucher_type,(CASE WHEN voucher_type='inventory_correction' THEN voucher_id ELSE reversal_of_voucher_id END))
      INCLUDE(id,account_id,posting_date,debit,credit,voucher_id,reversal_of_voucher_id)`,
    'reversal_of_voucher_id IS NOT NULL'],
  ['wm_gl_daily_account_date_cover_idx',
    'wm_gl_daily(account_id,posting_date) INCLUDE(voucher_type,party_id,cost_center,voucher_id,entry_count,debit,credit)'],
];

async function createLedgerReadIndexes(pool) {
  const lookup = `SELECT i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`;
  for (const [name, definition, predicate] of INDEXES) {
    const previous = (await pool.query(lookup, [name])).rows[0];
    if (previous && !previous.indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${definition}${predicate ? ' WHERE '+predicate : ''}`);
    const index = (await pool.query(lookup, [name])).rows[0];
    if (!index?.indisvalid || !index.indisready) throw new Error(`Ledger lookup ${name} is not ready; retry the migration.`);
  }
  await pool.query('ANALYZE app_journal_entries (created_by_user_id)');
  await pool.query('ANALYZE app_gl_entries (voucher_type,voucher_id,reversal_of_voucher_id,account_id,posting_date)');
  await pool.query('ANALYZE wm_gl_daily (account_id,posting_date)');
}

module.exports = { createLedgerReadIndexes };
