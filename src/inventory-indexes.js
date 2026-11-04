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

// Cover the immutable ledger deltas used by the deferred quantity/value check.
// Retain the date index: reports and historical checks still need that ordering.
async function createStockBalanceCoverIndex(pool) {
  const name = 'app_stock_ledger_balance_cover_idx';
  const lookup = `SELECT i.indisvalid,i.indisready,i.indisunique,i.indnkeyatts,
    i.indrelid='app_stock_ledger'::regclass AS correct_table,i.indpred IS NULL AS unfiltered,
    am.amname,ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,position)
      LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY position) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam
    WHERE c.relname=$1 AND n.nspname=current_schema()`;
  const previous = (await pool.query(lookup,[name])).rows[0];
  if (previous && !previous.indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
    ON app_stock_ledger(item_code,warehouse) INCLUDE(qty_change,stock_value_change)`);
  const index = (await pool.query(lookup,[name])).rows[0];
  if (!index?.indisvalid || !index.indisready || !index.correct_table || !index.unfiltered
    || index.indisunique || index.amname !== 'btree' || index.indnkeyatts !== 2
    || JSON.stringify(index.columns) !== JSON.stringify(['item_code','warehouse','qty_change','stock_value_change'])) {
    throw new Error('Stock balance covering index is not ready or has an unexpected definition. Check the index and retry the owner migration.');
  }
  await pool.query('ANALYZE app_stock_ledger (item_code,warehouse)');
}

async function createStockReportIndexes(pool) {
  const lookup = `SELECT i.indisvalid,i.indisready,i.indisunique,i.indnkeyatts,
    i.indrelid=to_regclass($2) AS correct_table,i.indpred IS NOT NULL AS filtered,
    am.amname,ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,position)
      LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY position) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam
    WHERE c.relname=$1 AND n.nspname=current_schema()`;
  const indexes = [
    {
      name: 'app_stock_ledger_warehouse_date_id_idx',
      table: 'app_stock_ledger',
      definition: 'ON app_stock_ledger(warehouse,posting_date,id)',
      columns: ['warehouse', 'posting_date', 'id'],
      filtered: false,
    },
    {
      name: 'app_stock_ledger_warehouse_movement_cover_idx',
      table: 'app_stock_ledger',
      definition: 'ON app_stock_ledger(warehouse,item_code) INCLUDE(item_name,posting_date,qty_change,stock_value_change)',
      columns: ['warehouse', 'item_code', 'item_name', 'posting_date', 'qty_change', 'stock_value_change'],
      filtered: false,
    },
    {
      name: 'app_invoices_draft_id_idx',
      table: 'app_invoices',
      definition: "ON app_invoices(id) WHERE docstatus='draft'",
      columns: ['id'],
      filtered: true,
    },
    {
      name: 'app_purchases_draft_id_idx',
      table: 'app_purchases',
      definition: "ON app_purchases(id) WHERE docstatus='draft'",
      columns: ['id'],
      filtered: true,
    },
    {
      name: 'app_stock_entries_draft_id_idx',
      table: 'app_stock_entries',
      definition: "ON app_stock_entries(id) WHERE docstatus='draft' AND entry_type<>'reconciliation'",
      columns: ['id'],
      filtered: true,
    },
  ];

  for (const index of indexes) {
    const previous = (await pool.query(lookup, [index.name, index.table])).rows[0];
    if (previous && !previous.indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${index.name}`);
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ${index.definition}`);
    const created = (await pool.query(lookup, [index.name, index.table])).rows[0];
    if (!created?.indisvalid || !created.indisready || !created.correct_table
      || created.indisunique || created.amname !== 'btree' || created.filtered !== index.filtered
      || JSON.stringify(created.columns) !== JSON.stringify(index.columns)) {
      throw new Error(`Stock report index ${index.name} is not ready or has an unexpected definition. Check the index and retry the owner migration.`);
    }
  }

  await pool.query('ANALYZE app_stock_ledger');
  await pool.query('ANALYZE app_invoices');
  await pool.query('ANALYZE app_purchases');
  await pool.query('ANALYZE app_stock_entries');
}

module.exports = {
  createStockPostingEventIndex,
  createStockBalanceCoverIndex,
  createStockReportIndexes,
};
