'use strict';
const { isValidIsoDate } = require('../lib/dates');
const { normalizePostingTime } = require('../posting-time');

// A save is an availability check, not a reservation. Read balances, historical
// minima and closure boundaries in one snapshot; submission still checks under
// warehouse locks. Keep the effective history aligned with migration 45's
// wm_inventory_check_history (including prior backdated controlled issues).
async function validateInvoiceDraftStock(client, payload) {
  if (!isValidIsoDate(payload.invoice_date)) {
    const error = new Error('Choose a valid posting date.'); error.status = 400; throw error;
  }
  const time = normalizePostingTime(payload.posting_time);
  payload.posting_time = time;
  const items = (payload.items || []).map(item => ({
    item_code: item.item_code, item_name: item.item_name || item.item_code,
    warehouse: item.warehouse || payload.warehouse, quantity: Number(item.quantity),
  }));
  if (!items.length) return;
  const { rows } = await client.query(`
    WITH requested AS (
      SELECT item_code,warehouse,MIN(item_name) AS item_name,SUM(quantity) AS requested
      FROM jsonb_to_recordset($1::jsonb) AS item(item_code text,item_name text,warehouse text,quantity numeric)
      GROUP BY item_code,warehouse
    ), selected AS (
      SELECT ($2::date+$3::time) AT TIME ZONE 'Africa/Kampala' AS entered_at,
        wm_inventory_enabled() AS controlled
    ), boundary AS (
      SELECT controlled,CASE WHEN entered_at=date_trunc('minute',entered_at)
        AND entered_at=date_trunc('minute',clock_timestamp()) THEN clock_timestamp() ELSE entered_at END AS posting_at
      FROM selected
    ), current_checks AS MATERIALIZED (
      -- After the last physical movement, only declining issues can have a
      -- later effective time. Their minimum equals the current balance. Skip
      -- history only on an unambiguously successful check; shortage warnings
      -- still use the complete historical calculation below.
      SELECT r.item_code,r.warehouse,
        (b.controlled AND b.posting_at>=c.last_movement AND (c.closed_through IS NULL OR b.posting_at>c.closed_through)
          AND r.requested<=stock.quantity) IS TRUE AS eligible
      FROM requested r CROSS JOIN boundary b
      LEFT JOIN app_stock_balances stock ON stock.item_code=r.item_code AND stock.warehouse=r.warehouse
      LEFT JOIN wm_inventory_control c ON c.warehouse=r.warehouse
    ), historical_requested AS (
      SELECT r.* FROM requested r LEFT JOIN current_checks k
        ON k.item_code=r.item_code AND k.warehouse=r.warehouse WHERE k.eligible IS NOT TRUE
    ), history AS (
      SELECT l.item_code,l.warehouse,l.id,l.qty_change,
        CASE WHEN l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0
          THEN CASE WHEN (CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
            WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END)
              =date_trunc('minute',l.movement_at AT TIME ZONE 'Africa/Kampala') THEN l.movement_at
            ELSE COALESCE((CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
              WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END)
                AT TIME ZONE 'Africa/Kampala',l.movement_at) END
          ELSE l.movement_at END AS effective_at
      FROM historical_requested r JOIN app_stock_ledger l ON l.item_code=r.item_code AND l.warehouse=r.warehouse
      -- Put eligibility in the lookup key. A separate join filter still lets
      -- PostgreSQL probe both document indexes for every legacy ledger row.
      LEFT JOIN app_invoices i ON i.id=CASE WHEN l.posting_event_id IS NOT NULL
        AND NOT l.is_reversal AND l.qty_change<0 AND l.voucher_type='invoice' THEN l.voucher_id END
      LEFT JOIN app_stock_entries s ON s.id=CASE WHEN l.posting_event_id IS NOT NULL
        AND NOT l.is_reversal AND l.qty_change<0 AND l.voucher_type LIKE 'stock_%' THEN l.voucher_id END
      WHERE EXISTS (SELECT 1 FROM historical_requested)
    ), opening AS (
      SELECT item_code,warehouse,SUM(qty_change) AS quantity
      FROM history CROSS JOIN boundary WHERE effective_at<=posting_at GROUP BY item_code,warehouse
    ), later_balances AS (
      SELECT item_code,warehouse,SUM(qty_change) OVER (
        PARTITION BY item_code,warehouse ORDER BY effective_at,id ROWS UNBOUNDED PRECEDING) AS delta
      FROM history CROSS JOIN boundary WHERE effective_at>posting_at
    ), later AS (
      SELECT item_code,warehouse,MIN(delta) AS delta FROM later_balances GROUP BY item_code,warehouse
    )
    SELECT r.*,COALESCE(stock.quantity,0)::float AS current_quantity,
      CASE WHEN k.eligible THEN stock.quantity ELSE COALESCE(at_time.quantity,0) END::float AS historical_quantity,
      CASE WHEN k.eligible THEN stock.quantity ELSE LEAST(COALESCE(at_time.quantity,0)+LEAST(0,COALESCE(later.delta,0)),COALESCE(stock.quantity,0)) END::float AS available_quantity,
      (b.controlled AND b.posting_at<=c.closed_through) IS TRUE AS closed,
      to_char(c.closed_through AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI:SS.US') AS cut_off
    FROM requested r CROSS JOIN boundary b
    LEFT JOIN current_checks k ON k.item_code=r.item_code AND k.warehouse=r.warehouse
    LEFT JOIN app_stock_balances stock ON stock.item_code=r.item_code AND stock.warehouse=r.warehouse
    LEFT JOIN wm_inventory_control c ON c.warehouse=r.warehouse
    LEFT JOIN opening at_time ON at_time.item_code=r.item_code AND at_time.warehouse=r.warehouse
    LEFT JOIN later ON later.item_code=r.item_code AND later.warehouse=r.warehouse
    ORDER BY r.warehouse,r.item_code`, [JSON.stringify(items),payload.invoice_date,time]);
  for (const row of rows) {
    if (row.closed) {
      const error = new Error(`Cannot save this invoice: posting date/time must be after ${row.warehouse}'s reconciliation cut-off ${row.cut_off} Kampala. Use an approved current-period correction for an omitted historical movement.`);
      error.status = 409; error.code = 'inventory_period_closed'; throw error;
    }
    if (Number(row.requested) > Number(row.available_quantity) + 0.0005) {
      const error = new Error(`Cannot save this invoice: insufficient stock for ${row.item_name} in ${row.warehouse} at ${payload.invoice_date} ${time}. Historical stock: ${row.historical_quantity}; current stock: ${row.current_quantity}; available after later transactions: ${row.available_quantity}; requested: ${row.requested}.`);
      error.status = 422; error.code = 'insufficient_stock';
      error.stockWarning = { item_name:row.item_name,item_code:row.item_code,warehouse:row.warehouse,
        requested:Number(row.requested),available:Number(row.available_quantity) };
      throw error;
    }
  }
}
module.exports = { validateInvoiceDraftStock };
