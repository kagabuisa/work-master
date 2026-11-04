'use strict';

// Stock Movement only needs daily deltas when no detailed search or ownership
// filter is present. Keep those totals in the same transaction as the ledger.
const keys = 'warehouse, item_code, item_name, posting_date';
const projection = `warehouse, item_code, item_name, posting_date,
  count(*)::bigint AS movement_count,
  sum(qty_change) AS qty_change,
  sum(CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END) AS in_qty,
  sum(CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END) AS out_qty,
  sum(stock_value_change) AS stock_value_change`;

async function initStockDaily(client) {
  // Backfill and trigger installation must see one write-free ledger snapshot.
  await client.query('LOCK TABLE app_stock_ledger IN SHARE ROW EXCLUSIVE MODE');
  await client.query(`CREATE TABLE IF NOT EXISTS wm_stock_daily (
    warehouse text NOT NULL,
    item_code text NOT NULL,
    item_name text NOT NULL,
    posting_date date NOT NULL,
    movement_count bigint NOT NULL CHECK (movement_count >= 0),
    qty_change numeric NOT NULL,
    in_qty numeric NOT NULL DEFAULT 0,
    out_qty numeric NOT NULL DEFAULT 0,
    stock_value_change numeric NOT NULL,
    PRIMARY KEY (${keys})
  )`);
  await client.query(`ALTER TABLE wm_stock_daily
    ADD COLUMN IF NOT EXISTS in_qty numeric NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS out_qty numeric NOT NULL DEFAULT 0`);
  await client.query('TRUNCATE wm_stock_daily');
  await client.query(`INSERT INTO wm_stock_daily
      (${keys}, movement_count, qty_change, in_qty, out_qty, stock_value_change)
    SELECT ${projection}
    FROM app_stock_ledger
    GROUP BY warehouse, item_code, item_name, posting_date`);

  for (const [event, delta] of [
    ['insert', `SELECT *, CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END AS in_qty,
      CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END AS out_qty,
      1::bigint AS n FROM new_stock`],
    ['delete', `SELECT *, CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END AS in_qty,
      CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END AS out_qty,
      (-1)::bigint AS n FROM old_stock`],
    ['update', `SELECT *, CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END AS in_qty,
      CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END AS out_qty,
      1::bigint AS n FROM new_stock
      UNION ALL
      SELECT *, CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END AS in_qty,
      CASE WHEN qty_change < 0 THEN abs(qty_change) ELSE 0 END AS out_qty,
      (-1)::bigint AS n FROM old_stock`],
  ]) {
    await client.query(`CREATE OR REPLACE FUNCTION wm_stock_daily_${event}()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp AS $$
      DECLARE remaining bigint;
      BEGIN
        FOR remaining IN
          INSERT INTO wm_stock_daily
            (${keys}, movement_count, qty_change, in_qty, out_qty, stock_value_change)
          SELECT warehouse, item_code, item_name, posting_date,
            sum(n), sum(qty_change * n), sum(in_qty * n), sum(out_qty * n),
            sum(stock_value_change * n)
          FROM (${delta}) changes
          GROUP BY warehouse, item_code, item_name, posting_date
          HAVING sum(n) <> 0 OR sum(qty_change * n) <> 0 OR sum(in_qty * n) <> 0
            OR sum(out_qty * n) <> 0 OR sum(stock_value_change * n) <> 0
          ORDER BY warehouse, item_code, item_name, posting_date
          ON CONFLICT (${keys}) DO UPDATE SET
            movement_count = wm_stock_daily.movement_count + EXCLUDED.movement_count,
            qty_change = wm_stock_daily.qty_change + EXCLUDED.qty_change,
            in_qty = wm_stock_daily.in_qty + EXCLUDED.in_qty,
            out_qty = wm_stock_daily.out_qty + EXCLUDED.out_qty,
            stock_value_change = wm_stock_daily.stock_value_change + EXCLUDED.stock_value_change
          RETURNING movement_count
        LOOP
          IF remaining < 0 THEN
            RAISE EXCEPTION 'stock_daily_count_mismatch: Stock daily count would become negative.';
          END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    await client.query(`REVOKE ALL ON FUNCTION wm_stock_daily_${event}() FROM PUBLIC`);
    await client.query(`DROP TRIGGER IF EXISTS wm_stock_daily_${event} ON app_stock_ledger`);
    const transition = event === 'insert' ? 'NEW TABLE AS new_stock'
      : event === 'delete' ? 'OLD TABLE AS old_stock'
        : 'OLD TABLE AS old_stock NEW TABLE AS new_stock';
    await client.query(`CREATE TRIGGER wm_stock_daily_${event}
      AFTER ${event.toUpperCase()} ON app_stock_ledger
      REFERENCING ${transition}
      FOR EACH STATEMENT EXECUTE FUNCTION wm_stock_daily_${event}()`);
  }

  await client.query(`CREATE OR REPLACE FUNCTION wm_stock_daily_truncate()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp AS $$
    BEGIN
      TRUNCATE wm_stock_daily;
      RETURN NULL;
    END $$`);
  await client.query('REVOKE ALL ON FUNCTION wm_stock_daily_truncate() FROM PUBLIC');
  await client.query('DROP TRIGGER IF EXISTS wm_stock_daily_truncate ON app_stock_ledger');
  await client.query(`CREATE TRIGGER wm_stock_daily_truncate
    AFTER TRUNCATE ON app_stock_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION wm_stock_daily_truncate()`);

  await client.query(`DO $$
    DECLARE runtime_role text;
    BEGIN
      FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'wm_inventory_runtime_%'
      LOOP
        EXECUTE format('GRANT SELECT ON wm_stock_daily TO %I', runtime_role);
      END LOOP;
    END $$`);
  await client.query('ANALYZE wm_stock_daily');
}

function canSummarizeStockMovement(filters = {}) {
  return !String(filters.search || '').trim()
    && !String(filters.ownerId || '').trim()
    && !String(filters.ownerEmployeeId || '').trim();
}

module.exports = { initStockDaily, canSummarizeStockMovement };
