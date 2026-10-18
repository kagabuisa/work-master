'use strict';

// Read-only invoice preview. Historical ordering deliberately matches
// transferStockAvailability, including legacy reversals and future shortfalls.
async function invoiceStockBalances(client, pairs, postingDate, postingTime) {
  if (!pairs.length) return [];
  const requested = `SELECT DISTINCT item_code, warehouse
    FROM jsonb_to_recordset($1::jsonb) AS r(item_code text, warehouse text)`;
  if (postingDate === undefined) {
    const { rows } = await client.query(`WITH requested AS (${requested})
      SELECT r.item_code, r.warehouse, COALESCE(b.quantity,0)::float AS quantity,
        COALESCE(b.quantity,0)::float AS available_quantity
      FROM requested r LEFT JOIN app_stock_balances b
        ON b.item_code=r.item_code AND b.warehouse=r.warehouse`, [JSON.stringify(pairs)]);
    return rows;
  }
  const { rows } = await client.query(`
    WITH requested AS (${requested}), history AS (
      SELECT l.item_code, l.warehouse, l.id, l.posting_date, l.qty_change,
        CASE WHEN l.posting_event_id IS NOT NULL THEN (l.movement_at AT TIME ZONE 'Africa/Kampala')::time
          WHEN l.is_reversal THEN date_trunc('minute',l.created_at AT TIME ZONE 'Africa/Kampala')::time
          ELSE COALESCE(se.posting_time,p.posting_time,i.posting_time,TIME '00:00:00') END AS movement_time
      FROM requested r JOIN app_stock_ledger l ON l.item_code=r.item_code AND l.warehouse=r.warehouse
      LEFT JOIN app_stock_entries se ON l.voucher_type LIKE 'stock_%' AND se.id=l.voucher_id
      LEFT JOIN app_purchases p ON l.voucher_type='purchase' AND p.id=l.voucher_id
      LEFT JOIN app_invoices i ON l.voucher_type='invoice' AND i.id=l.voucher_id
    ), balances AS (
      SELECT *, SUM(qty_change) OVER (PARTITION BY item_code,warehouse
        ORDER BY posting_date,movement_time,id ROWS UNBOUNDED PRECEDING) AS quantity FROM history
    ), at_posting AS (
      SELECT DISTINCT ON (item_code,warehouse) item_code,warehouse,quantity FROM balances
      WHERE (posting_date,movement_time)<=($2::date,$3::time)
      ORDER BY item_code,warehouse,posting_date DESC,movement_time DESC,id DESC
    ), future AS (
      SELECT item_code,warehouse,MIN(quantity) AS minimum_quantity FROM balances
      WHERE (posting_date,movement_time)>($2::date,$3::time) GROUP BY item_code,warehouse
    )
    SELECT r.item_code,r.warehouse,COALESCE(a.quantity,0)::float AS quantity,
      LEAST(COALESCE(a.quantity,0),COALESCE(f.minimum_quantity,a.quantity,0))::float AS available_quantity
    FROM requested r LEFT JOIN at_posting a USING(item_code,warehouse)
      LEFT JOIN future f USING(item_code,warehouse)`, [JSON.stringify(pairs), postingDate, postingTime]);
  return rows;
}

module.exports = { invoiceStockBalances };
