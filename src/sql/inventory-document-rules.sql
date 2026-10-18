-- Owner-only helper: callers must use the permission-checked posting routines.
CREATE OR REPLACE FUNCTION wm_inventory_document_stamp(typ text, vid bigint)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (document_date + COALESCE(document_time,TIME '00:00')) AT TIME ZONE 'Africa/Kampala'
 FROM (
  SELECT invoice_date AS document_date, posting_time AS document_time FROM app_invoices WHERE typ='invoice' AND id=vid
  UNION ALL
  SELECT posting_date, posting_time FROM app_purchases WHERE typ='purchase' AND id=vid
  UNION ALL
  SELECT posting_date, posting_time FROM app_stock_entries WHERE typ LIKE 'stock_%' AND id=vid
 ) source
$$;
REVOKE ALL ON FUNCTION wm_inventory_document_stamp(text,bigint) FROM PUBLIC;

-- Use the saved header, never a movement payload's claimed date. Warehouse locks
-- are held by wm_inventory_begin before this check and until commit/rollback.
CREATE OR REPLACE FUNCTION wm_inventory_check_document(typ text, vid bigint, warehouses text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE document_at timestamptz; boundary timestamptz; wh text;
BEGIN
 IF typ='inventory_correction' THEN RETURN; END IF;
 document_at:=wm_inventory_document_stamp(typ,vid);
 -- Minute-resolution forms use submission time within the current minute.
 -- An explicit earlier minute or a supplied precise timestamp stays exact.
 IF document_at=date_trunc('minute',document_at) AND document_at=date_trunc('minute',clock_timestamp()) THEN document_at:=clock_timestamp(); END IF;
 IF document_at IS NULL THEN RAISE EXCEPTION 'inventory_invalid_voucher: A saved inventory voucher with a posting date is required.'; END IF;
 IF (document_at AT TIME ZONE 'Africa/Kampala')::date > (clock_timestamp() AT TIME ZONE 'Africa/Kampala')::date THEN
  RAISE EXCEPTION 'future_posting_date: Posting date cannot be in the future (Africa/Kampala).';
 END IF;
 SELECT warehouse,closed_through INTO wh,boundary FROM wm_inventory_control
 WHERE warehouse=ANY(warehouses) AND document_at<=closed_through ORDER BY warehouse LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'inventory_period_closed: Posting date/time for % must be after warehouse % reconciliation cut-off % Kampala. Use an approved current-period correction for an omitted historical movement.',typ,wh,boundary AT TIME ZONE 'Africa/Kampala'; END IF;
END $$;
REVOKE ALL ON FUNCTION wm_inventory_check_document(text,bigint,text[]) FROM PUBLIC;

-- Validate declining movements on their saved document timeline as well as the
-- physical timeline. Already-posted controlled issues consume their historical
-- availability, so repeated lines and repeated/concurrent backdated vouchers
-- cannot spend the same old stock again. Receipts become available only at their
-- actual physical timestamp. Reversals/corrections use their server timestamp.
CREATE OR REPLACE FUNCTION wm_inventory_check_history(ev wm_inventory_events, m jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE document_at timestamptz; at_quantity numeric; available numeric;
 requested numeric:=abs((m->>'qty_change')::numeric);
BEGIN
 IF ev.is_reversal OR ev.count_id IS NOT NULL OR ev.voucher_type='inventory_correction' OR COALESCE((m->>'qty_change')::numeric,0)>=0 THEN RETURN; END IF;
 document_at:=wm_inventory_document_stamp(ev.voucher_type,ev.voucher_id);
 IF document_at=date_trunc('minute',document_at) AND document_at=date_trunc('minute',ev.movement_at) THEN document_at:=ev.movement_at; END IF;
 WITH history AS (
  SELECT l.id,l.qty_change,
   CASE WHEN l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0
    THEN CASE WHEN (CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
       WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END) = date_trunc('minute',l.movement_at AT TIME ZONE 'Africa/Kampala') THEN l.movement_at
     ELSE COALESCE((CASE WHEN l.voucher_type='invoice' THEN i.invoice_date+i.posting_time
       WHEN l.voucher_type LIKE 'stock_%' THEN s.posting_date+s.posting_time END) AT TIME ZONE 'Africa/Kampala',l.movement_at) END
    ELSE l.movement_at END AS effective_at
  FROM app_stock_ledger l
  LEFT JOIN app_invoices i ON l.voucher_type='invoice' AND i.id=l.voucher_id
  LEFT JOIN app_stock_entries s ON l.voucher_type LIKE 'stock_%' AND s.id=l.voucher_id
  WHERE l.item_code=m->>'item_code' AND l.warehouse=m->>'warehouse'
 ), balances AS (
  SELECT *,sum(qty_change) OVER (ORDER BY effective_at,id ROWS UNBOUNDED PRECEDING) AS quantity FROM history
 )
 SELECT COALESCE((SELECT quantity FROM balances WHERE effective_at<=document_at ORDER BY effective_at DESC,id DESC LIMIT 1),0),
  (SELECT min(quantity) FROM balances WHERE effective_at>document_at)
 INTO at_quantity,available;
 available:=LEAST(at_quantity,COALESCE(available,at_quantity));
 IF available-requested < -0.0005 THEN
  RAISE EXCEPTION 'insufficient_stock: Historical stock for % in % at % Kampala is %; available after later transactions is %; requested %. Later receipts or reconciliations cannot supply an earlier sale or transfer.',m->>'item_code',m->>'warehouse',document_at AT TIME ZONE 'Africa/Kampala',at_quantity,available,requested;
 END IF;
END $$;
REVOKE ALL ON FUNCTION wm_inventory_check_history(wm_inventory_events,jsonb) FROM PUBLIC;

-- Patch in place to preserve function identities, ownership and runtime grants.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_begin(text,bigint,boolean,text[])'::regprocedure);
 IF strpos(definition,'document_history_rules')=0 THEN
  anchor:=' stamp:=clock_timestamp();';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Cannot install inventory document date check.'; END IF;
  definition:=replace(definition,anchor,E' -- document_history_rules\n IF NOT rev THEN PERFORM wm_inventory_check_document(typ,vid,warehouses); END IF;\n' || anchor);
  EXECUTE definition;
 END IF;
 definition:=pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure);
 IF strpos(definition,'document_history_rules')=0 THEN
  anchor:=' oldq:=b.quantity;oldv:=b.stock_value;';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Cannot install inventory historical availability check.'; END IF;
  definition:=replace(definition,anchor,E' -- document_history_rules\n IF NOT ev.is_reversal AND ev.count_id IS NULL THEN PERFORM wm_inventory_check_document(ev.voucher_type,ev.voucher_id,ev.warehouses); END IF;\n PERFORM wm_inventory_check_history(ev,m);\n' || anchor);
  EXECUTE definition;
 END IF;
END $migration$;
