-- Keep the document timeline and availability rule from migration 37. Sum the
-- opening quantity once; only movements AFTER the requested time need an
-- ordered running balance. Present-day postings avoid sorting old history.
-- CREATE OR REPLACE preserves the existing function owner and private grants.
CREATE OR REPLACE FUNCTION wm_inventory_check_history(ev wm_inventory_events, m jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE document_at timestamptz; at_quantity numeric; available numeric;
 requested numeric:=abs((m->>'qty_change')::numeric);
BEGIN
 IF ev.is_reversal OR ev.count_id IS NOT NULL OR ev.voucher_type='inventory_correction' OR COALESCE((m->>'qty_change')::numeric,0)>=0 THEN RETURN; END IF;
 document_at:=wm_inventory_document_stamp(ev.voucher_type,ev.voucher_id);
 IF document_at=date_trunc('minute',document_at) AND document_at=date_trunc('minute',ev.movement_at) THEN document_at:=ev.movement_at; END IF;
 WITH history AS MATERIALIZED (
  SELECT l.id,l.qty_change,
   CASE WHEN l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0
    THEN CASE WHEN (CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
       WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END) = date_trunc('minute',l.movement_at AT TIME ZONE 'Africa/Kampala') THEN l.movement_at
     ELSE COALESCE((CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
       WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END) AT TIME ZONE 'Africa/Kampala',l.movement_at) END
    ELSE l.movement_at END AS effective_at
  FROM app_stock_ledger l
  LEFT JOIN app_invoices i ON l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0
   AND l.voucher_type='invoice' AND i.id=l.voucher_id
  LEFT JOIN app_stock_entries s ON l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0
   AND l.voucher_type LIKE 'stock_%' AND s.id=l.voucher_id
  WHERE l.item_code=m->>'item_code' AND l.warehouse=m->>'warehouse'
 ), opening AS (
  SELECT COALESCE(sum(qty_change) FILTER (WHERE effective_at<=document_at),0) AS quantity FROM history
 ), later AS (
  SELECT sum(qty_change) OVER (ORDER BY effective_at,id ROWS UNBOUNDED PRECEDING) AS delta
  FROM history WHERE effective_at>document_at
 )
 SELECT quantity,quantity+LEAST(0,COALESCE((SELECT min(delta) FROM later),0))
 INTO at_quantity,available FROM opening;
 IF available-requested < -0.0005 THEN
  RAISE EXCEPTION 'insufficient_stock: Historical stock for % in % at % Kampala is %; available after later transactions is %; requested %. Later receipts or reconciliations cannot supply an earlier sale or transfer.',m->>'item_code',m->>'warehouse',document_at AT TIME ZONE 'Africa/Kampala',at_quantity,available,requested;
 END IF;
END $$;
REVOKE ALL ON FUNCTION wm_inventory_check_history(wm_inventory_events,jsonb) FROM PUBLIC;
