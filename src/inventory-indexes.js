'use strict';

// Run outside a transaction: existing warehouses may continue posting while
// PostgreSQL builds the lookup used by deferred inventory-event validation.
async function createStockPostingEventIndex(pool) {
  const name = 'app_stock_ledger_posting_event_idx';
  const lookup = `SELECT i.indisvalid, i.indisready FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname=$1 AND n.nspname=current_schema()`;
  const { rows } = await pool.query(lookup, [name]);
  // An interrupted concurrent build can leave an invalid index. IF NOT EXISTS
  // alone would retain it and incorrectly mark the migration as complete.
  if (rows[0] && !rows[0].indisvalid) {
    await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  }
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
    ON app_stock_ledger(posting_event_id) WHERE posting_event_id IS NOT NULL`);
  const index = (await pool.query(lookup, [name])).rows[0];
  if (!index?.indisvalid || !index.indisready) {
    throw new Error('Stock posting-event index did not become valid. Retry the owner migration.');
  }
  await pool.query('ANALYZE app_stock_ledger (posting_event_id)');
}

module.exports = { createStockPostingEventIndex };
