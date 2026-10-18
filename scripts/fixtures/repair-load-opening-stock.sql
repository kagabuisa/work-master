-- Isolated historical load fixture only. Never run against an application database.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SET LOCAL app.audit_username='Fixture opening-stock repair 2026-10-15';
DO $$ BEGIN
 IF current_database()<>'resilience_4y_hr_test' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
LOCK TABLE app_stock_entries,app_stock_entry_items,app_stock_ledger,app_stock_balances IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE balances_before ON COMMIT DROP AS SELECT * FROM app_stock_balances;
CREATE TEMP TABLE missing_openings ON COMMIT DROP AS
 WITH l AS (SELECT item_code,warehouse,sum(qty_change) quantity,sum(stock_value_change) value FROM app_stock_ledger GROUP BY 1,2)
 SELECT s.item_code,s.item_name,s.warehouse,s.quantity-coalesce(l.quantity,0) missing_quantity,
 s.stock_value-coalesce(l.value,0) missing_value
 FROM app_stock_balances s FULL JOIN l USING(item_code,warehouse)
 WHERE coalesce(s.quantity,0)<>coalesce(l.quantity,0) OR coalesce(s.stock_value,0)<>coalesce(l.value,0);
TABLE missing_openings;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app_stock_entries WHERE entry_no='FIXTURE-OPENING-20261015') THEN
  IF EXISTS(SELECT 1 FROM missing_openings) THEN RAISE EXCEPTION 'Previously repaired fixture has new discrepancies'; END IF;
 ELSE
  IF (SELECT count(*) FROM missing_openings)<>101 OR EXISTS(
   SELECT 1 FROM missing_openings WHERE warehouse IS DISTINCT FROM 'Load Warehouse'
   OR NOT (item_code='LOAD-SERVICE' OR item_code ~ '^LOAD-VARIED-([0-9]|[1-9][0-9])$')
   OR missing_quantity IS DISTINCT FROM 10000::numeric OR missing_value IS DISTINCT FROM 0::numeric
  ) THEN RAISE EXCEPTION 'Unexpected discrepancy set: refusing repair'; END IF;
 END IF;
END $$;
CREATE TEMP TABLE opening_document ON COMMIT DROP AS
 WITH inserted AS (
 INSERT INTO app_stock_entries(entry_no,entry_type,docstatus,posting_date,remarks,submitted_by,submitted_at)
 SELECT 'FIXTURE-OPENING-20261015','opening','submitted',
 (SELECT min(posting_date)-1 FROM app_stock_ledger),
 'Historical test-fixture repair: document existing 101 x 10000 zero-value opening units; do not change current balances.',
 'Fixture opening-stock repair 2026-10-15',now()
 WHERE EXISTS(SELECT 1 FROM missing_openings)
 RETURNING id,entry_no,posting_date)
 SELECT * FROM inserted;
INSERT INTO app_stock_entry_items(stock_entry_id,line_no,item_code,item_name,warehouse,quantity,valuation_rate)
 SELECT d.id,row_number() OVER(ORDER BY m.item_code,m.warehouse),m.item_code,m.item_name,m.warehouse,m.missing_quantity,0
 FROM missing_openings m CROSS JOIN opening_document d;
INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,voucher_no,
 qty_change,incoming_rate,outgoing_rate,stock_value_change,qty_after_transaction,stock_value_after_transaction,remarks)
 SELECT d.posting_date,m.item_code,m.item_name,m.warehouse,'stock_opening',d.id,d.entry_no,
 m.missing_quantity,0,0,0,m.missing_quantity,0,
 'Restore omitted opening history only; existing balances and subsequent stock movements unchanged.'
 FROM missing_openings m CROSS JOIN opening_document d;
DO $$ BEGIN
 IF EXISTS((SELECT * FROM balances_before EXCEPT SELECT * FROM app_stock_balances)
 UNION ALL (SELECT * FROM app_stock_balances EXCEPT SELECT * FROM balances_before)) THEN
 RAISE EXCEPTION 'Balances changed'; END IF;
 IF EXISTS(WITH l AS (SELECT item_code,warehouse,sum(qty_change) q,sum(stock_value_change) v FROM app_stock_ledger GROUP BY 1,2)
 SELECT 1 FROM app_stock_balances b FULL JOIN l USING(item_code,warehouse)
 WHERE coalesce(b.quantity,0)<>coalesce(l.q,0) OR coalesce(b.stock_value,0)<>coalesce(l.v,0)) THEN
 RAISE EXCEPTION 'Stock reconciliation failed'; END IF;
END $$;
SELECT 'opening_history_restored' result,count(*) inserted_opening_lines,sum(missing_quantity) restored_quantity FROM missing_openings;
COMMIT;
