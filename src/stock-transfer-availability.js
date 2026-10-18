'use strict';

// Stock ledger rows predate voucher posting times. Resolve original movement
// times from their saved voucher; reversals use their own Kampala creation time.
async function transferStockAvailability(client, itemCode, warehouse, postingDate, postingTime) {
  const { rows } = await client.query(`
    WITH history AS (
      SELECT l.id, l.posting_date, l.qty_change,
        CASE WHEN l.posting_event_id IS NOT NULL THEN (l.movement_at AT TIME ZONE 'Africa/Kampala')::time WHEN l.is_reversal THEN date_trunc('minute',l.created_at AT TIME ZONE 'Africa/Kampala')::time
          ELSE COALESCE(se.posting_time, p.posting_time, i.posting_time, TIME '00:00:00') END AS movement_time
      FROM app_stock_ledger l
      LEFT JOIN app_stock_entries se ON l.voucher_type LIKE 'stock_%' AND se.id=l.voucher_id
      LEFT JOIN app_purchases p ON l.voucher_type='purchase' AND p.id=l.voucher_id
      LEFT JOIN app_invoices i ON l.voucher_type='invoice' AND i.id=l.voucher_id
      WHERE l.item_code=$1 AND l.warehouse=$2
    ), balances AS (
      SELECT *, SUM(qty_change) OVER (ORDER BY posting_date, movement_time, id ROWS UNBOUNDED PRECEDING) AS quantity
      FROM history
    )
    SELECT COALESCE((SELECT quantity FROM balances
      WHERE (posting_date,movement_time)<=($3::date,$4::time)
      ORDER BY posting_date DESC,movement_time DESC,id DESC LIMIT 1),0)::float AS quantity,
      (SELECT MIN(quantity) FROM balances
        WHERE (posting_date,movement_time)>($3::date,$4::time))::float AS minimum_future_quantity`,
  [itemCode, warehouse, postingDate, postingTime]);
  const quantity = Number(rows[0]?.quantity || 0);
  const future = rows[0]?.minimum_future_quantity;
  return { quantity, available_quantity: future == null ? quantity : Math.min(quantity, Number(future)) };
}

module.exports = { transferStockAvailability };
