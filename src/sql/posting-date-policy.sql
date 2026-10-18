CREATE OR REPLACE FUNCTION wm_inventory_gl_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE typ text;vid bigint;BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN COALESCE(NEW,OLD);END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'inventory_reset_forbidden: Posted inventory accounting cannot be reset.';END IF;
 typ:=COALESCE(OLD.voucher_type,NEW.voucher_type);vid:=COALESCE(OLD.voucher_id,NEW.voucher_id);
 IF (NEW.account_id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory') OR OLD.account_id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory')) AND NOT EXISTS(
 SELECT 1 FROM wm_inventory_events e WHERE e.txid=txid_current() AND e.voucher_id=vid AND
 (CASE WHEN e.voucher_type='invoice' THEN 'sales_invoice' ELSE e.voucher_type END || CASE WHEN e.is_reversal AND e.voucher_type LIKE 'stock_%' THEN '_reversal' WHEN e.is_reversal THEN '_cancellation' ELSE '' END)=typ
 AND (CASE WHEN typ='sales_invoice' AND NOT e.is_reversal THEN (SELECT invoice_date FROM app_invoices WHERE id=vid) ELSE (e.movement_at AT TIME ZONE 'Africa/Kampala')::date END)=COALESCE(NEW.posting_date,OLD.posting_date)) THEN
 RAISE EXCEPTION 'inventory_posting_required: Inventory account postings require controlled stock entries or approved corrections; manual journals cannot change inventory.';END IF;

 IF EXISTS(SELECT 1 FROM wm_inventory_events e JOIN wm_inventory_control c ON c.warehouse=ANY(e.warehouses)
 WHERE e.voucher_id=vid AND (e.voucher_type=typ OR (e.voucher_type='invoice' AND typ='sales_invoice')) AND e.movement_at<=c.closed_through)
 OR EXISTS(SELECT 1 FROM app_stock_ledger l JOIN wm_inventory_control c ON c.warehouse=l.warehouse WHERE l.voucher_id=vid AND (l.voucher_type=typ OR (l.voucher_type='invoice' AND typ='sales_invoice')) AND l.movement_at<=c.closed_through) THEN RAISE EXCEPTION 'closed_voucher_immutable: Closed inventory accounting cannot be changed.';END IF;
 RETURN COALESCE(NEW,OLD);END $$;

-- Validate only new postings or changed posting dates; keep historical rows untouched.
CREATE OR REPLACE FUNCTION wm_no_future_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; old_data jsonb; day date;
BEGIN
 row_data := to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN
   old_data := to_jsonb(OLD);
   IF (row_data->>TG_ARGV[0]) IS NOT DISTINCT FROM (old_data->>TG_ARGV[0])
      AND (row_data->>'docstatus') IS NOT DISTINCT FROM (old_data->>'docstatus') THEN RETURN NEW; END IF;
 END IF;
 IF row_data ? 'docstatus' AND COALESCE(row_data->>'docstatus','submitted') <> 'submitted' THEN RETURN NEW; END IF;
 day := (row_data->>TG_ARGV[0])::date;
 IF day > (clock_timestamp() AT TIME ZONE 'Africa/Kampala')::date THEN
   RAISE EXCEPTION 'future_posting_date: Posting date cannot be in the future (Africa/Kampala).';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_invoices;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_invoices FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('invoice_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_invoice_payments;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_invoice_payments FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('payment_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_purchases;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_purchases FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_purchase_payments;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_purchase_payments FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('payment_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_purchase_orders;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_purchase_orders FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_stock_entries;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_stock_entries FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_journal_entries;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_journal_entries FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_gl_entries;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_gl_entries FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_stock_ledger;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_stock_ledger FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_hr_money;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_hr_money FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_hr_runs;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_hr_runs FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_hr_payments;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_hr_payments FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('posting_date');
DROP TRIGGER IF EXISTS wm_no_future_posting ON app_hr_attendance;
CREATE TRIGGER wm_no_future_posting BEFORE INSERT OR UPDATE ON app_hr_attendance FOR EACH ROW EXECUTE FUNCTION wm_no_future_posting('attendance_date');
