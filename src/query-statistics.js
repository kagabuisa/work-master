'use strict';
// Keep changing customer/journal distributions visible to the planner. Run once
// on upgrade; PostgreSQL maintains statistics thereafter at table-specific thresholds.
async function tuneQueryStatistics(client) {
  for (const table of ['app_invoices','app_journal_entries']) {
    await client.query(`ALTER TABLE ${table} SET (autovacuum_analyze_scale_factor=0.02, autovacuum_analyze_threshold=1000)`);
  }
  await client.query('ALTER TABLE app_invoices ALTER COLUMN customer_name SET STATISTICS 500');
  await client.query('ALTER INDEX app_invoices_search_trgm_idx ALTER COLUMN 1 SET STATISTICS 500');
  await client.query('ALTER INDEX app_journals_search_trgm_idx ALTER COLUMN 1 SET STATISTICS 500');
  await client.query('ANALYZE app_invoices');
  await client.query('ANALYZE app_journal_entries');
}
module.exports={tuneQueryStatistics};
