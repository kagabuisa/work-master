-- Activated inventory has reconciled balances, immutable past ledger rows and
-- warehouse-serialized physical timestamps. At/after the latest physical event,
-- all later EFFECTIVE movements can only be declining issues: receipts use
-- their physical time. Their minimum therefore equals the current balance.
-- Only short-circuit successful availability checks. Failures and earlier
-- document times retain the full history query and its exact warning details.
-- Check the warehouse marker too: one transaction may create several events,
-- so the caller's event can precede another receipt in that same transaction.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_check_history(wm_inventory_events,jsonb)'::regprocedure);
 IF strpos(definition,'controlled_current_availability')>0 THEN RETURN; END IF;
 anchor:=' WITH history AS MATERIALIZED (';
 IF strpos(definition,'conditional_history_source_lookups')=0 OR strpos(definition,anchor)=0 THEN
  RAISE EXCEPTION 'Cannot install current inventory availability: expected v44 checker.';
 END IF;
 definition:=replace(definition,anchor,E' -- controlled_current_availability\n'
  || E' IF document_at>=ev.movement_at AND wm_inventory_enabled()\n'
  || E'  AND EXISTS(SELECT 1 FROM wm_inventory_control WHERE warehouse=m->>''warehouse'' AND last_movement<=document_at) THEN\n'
  || E'  SELECT quantity INTO available FROM app_stock_balances WHERE item_code=m->>''item_code'' AND warehouse=m->>''warehouse'';\n'
  || E'  IF available-requested>=-0.0005 THEN RETURN; END IF;\n'
  || E' END IF;\n' || anchor);
 EXECUTE definition;
END $migration$;
