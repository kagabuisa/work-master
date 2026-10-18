'use strict';
const { isValidIsoDate } = require('../lib/dates');
const { normalizePostingTime } = require('../posting-time');

// A save is an availability check, not a reservation. Read balances, historical
// minima and closure boundaries in one snapshot; submission still checks under
// warehouse locks. Keep the effective history aligned with migration 37's
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
      FROM requested r JOIN app_stock_ledger l ON l.item_code=r.item_code AND l.warehouse=r.warehouse
      LEFT JOIN app_invoices i ON l.voucher_type='invoice' AND i.id=l.voucher_id
      LEFT JOIN app_stock_entries s ON l.voucher_type LIKE 'stock_%' AND s.id=l.voucher_id
    ), balances AS (
      SELECT *,SUM(qty_change) OVER (PARTITION BY item_code,warehouse ORDER BY effective_at,id ROWS UNBOUNDED PRECEDING) AS quantity
      FROM history
    )
    SELECT r.*,COALESCE(stock.quantity,0)::float AS current_quantity,
      COALESCE(at_time.quantity,0)::float AS historical_quantity,
      LEAST(COALESCE(at_time.quantity,0),COALESCE(later.quantity,at_time.quantity,0),COALESCE(stock.quantity,0))::float AS available_quantity,
      (b.controlled AND b.posting_at<=c.closed_through) IS TRUE AS closed,
      to_char(c.closed_through AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI:SS.US') AS cut_off
    FROM requested r CROSS JOIN boundary b
    LEFT JOIN app_stock_balances stock ON stock.item_code=r.item_code AND stock.warehouse=r.warehouse
    LEFT JOIN wm_inventory_control c ON c.warehouse=r.warehouse
    LEFT JOIN LATERAL (SELECT quantity FROM balances WHERE item_code=r.item_code AND warehouse=r.warehouse
      AND effective_at<=b.posting_at ORDER BY effective_at DESC,id DESC LIMIT 1) at_time ON true
    LEFT JOIN LATERAL (SELECT MIN(quantity) AS quantity FROM balances WHERE item_code=r.item_code AND warehouse=r.warehouse
      AND effective_at>b.posting_at) later ON true
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
