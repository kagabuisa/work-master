-- Eligibility must be part of the index key, rather than a post-lookup join
-- filter. Otherwise PostgreSQL probes both document indexes for every legacy
-- movement even though its effective time is already stored in the ledger.
-- Keep the v43 function's identity, owner, privileges and availability formula.
DO $migration$
DECLARE definition text; invoice_join text; stock_join text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_check_history(wm_inventory_events,jsonb)'::regprocedure);
 IF strpos(definition,'conditional_history_source_lookups')>0 THEN RETURN; END IF;
 invoice_join:=E'LEFT JOIN app_invoices i ON l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0\n   AND l.voucher_type=''invoice'' AND i.id=l.voucher_id';
 stock_join:=E'LEFT JOIN app_stock_entries s ON l.posting_event_id IS NOT NULL AND NOT l.is_reversal AND l.qty_change<0\n   AND l.voucher_type LIKE ''stock_%'' AND s.id=l.voucher_id';
 IF strpos(definition,invoice_join)=0 OR strpos(definition,stock_join)=0 THEN
  RAISE EXCEPTION 'Cannot install conditional inventory history lookups: expected v43 definition.';
 END IF;
 definition:=replace(definition,invoice_join,E'LEFT JOIN app_invoices i ON i.id=CASE WHEN l.posting_event_id IS NOT NULL\n   AND NOT l.is_reversal AND l.qty_change<0 AND l.voucher_type=''invoice'' THEN l.voucher_id END');
 definition:=replace(definition,stock_join,E'LEFT JOIN app_stock_entries s ON s.id=CASE WHEN l.posting_event_id IS NOT NULL\n   AND NOT l.is_reversal AND l.qty_change<0 AND l.voucher_type LIKE ''stock_%'' THEN l.voucher_id END');
 definition:=replace(definition,'WITH history AS MATERIALIZED (','WITH history AS MATERIALIZED ( -- conditional_history_source_lookups');
 EXECUTE definition;
END $migration$;
