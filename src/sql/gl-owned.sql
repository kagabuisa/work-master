-- Install/backfill from one write-free snapshot of sources and ledger.
LOCK TABLE app_invoices, app_invoice_payments, app_purchases, app_purchase_payments,
 app_journal_entries, app_stock_entries, wm_inventory_corrections, app_gl_entries
 IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION wm_gl_owned_kind(typ text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN typ LIKE 'stock_%' THEN 'stock'
 WHEN typ IN ('sales_invoice_cancellation','customer_payment_cancellation',
  'purchase_cancellation','purchase_payment_cancellation','payment_journal_cancellation',
  'cash_receipt_cancellation','journal_entry_cancellation') THEN regexp_replace(typ,'_cancellation$','')
 ELSE typ END
$$;

CREATE OR REPLACE VIEW wm_gl_owner_sources AS
 SELECT 'sales_invoice'::text kind,i.id source_id,i.created_by_user_id::text owner_id,i.invoicer_id employee_id FROM app_invoices i
 UNION ALL SELECT 'customer_payment',p.id,i.created_by_user_id::text,i.invoicer_id
 FROM app_invoice_payments p JOIN app_invoices i ON i.id=p.invoice_id
 UNION ALL SELECT 'purchase',p.id,p.created_by_user_id::text,NULL::text FROM app_purchases p
 UNION ALL SELECT 'purchase_payment',p.id,v.created_by_user_id::text,NULL::text
 FROM app_purchase_payments p JOIN app_purchases v ON v.id=p.purchase_id
 UNION ALL SELECT 'payment_journal',p.journal_entry_id,v.created_by_user_id::text,NULL::text
 FROM app_purchase_payments p JOIN app_purchases v ON v.id=p.purchase_id
 WHERE p.method<>'journal' AND p.journal_entry_id IS NOT NULL
 UNION ALL SELECT k.kind,j.id,j.created_by_user_id::text,NULL::text FROM app_journal_entries j
 CROSS JOIN (VALUES ('cash_receipt'),('payment_journal'),('journal_entry')) k(kind)
 UNION ALL SELECT 'stock',s.id,s.created_by_user_id::text,NULL::text FROM app_stock_entries s
 UNION ALL SELECT 'inventory_correction',c.id,c.prepared_by::text,NULL::text FROM wm_inventory_corrections c;

-- A narrow, indexed ownership projection also supplies period page rows. It
-- contains no narration or party payload and is never the accounting authority.
CREATE TABLE IF NOT EXISTS wm_gl_owned_entries (
 id bigint PRIMARY KEY, kind text NOT NULL, source_id bigint,
 account_id bigint NOT NULL, posting_date date NOT NULL, voucher_type text NOT NULL,
 debit numeric NOT NULL, credit numeric NOT NULL,
 owner_ids text[] NOT NULL, employee_ids text[] NOT NULL
);
CREATE TABLE IF NOT EXISTS wm_gl_owned_daily (
 account_id bigint NOT NULL, posting_date date NOT NULL, voucher_type text NOT NULL,
 bucket integer NOT NULL, owner_ids text[] NOT NULL, employee_ids text[] NOT NULL,
 entry_count bigint NOT NULL, debit numeric NOT NULL, credit numeric NOT NULL,
 UNIQUE(account_id,posting_date,voucher_type,bucket,owner_ids,employee_ids)
);
CREATE TABLE IF NOT EXISTS wm_gl_owned_scopes (
 owner_ids text[] NOT NULL,employee_ids text[] NOT NULL,PRIMARY KEY(owner_ids,employee_ids)
);

-- Replayed upgrade fixtures can safely rebuild these *derived app tables*.
-- This migration never removes or resets business vouchers or ledger entries.
DO $$
DECLARE ev text;
BEGIN
 FOREACH ev IN ARRAY ARRAY['insert','update','delete'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS wm_gl_owned_daily_%s ON wm_gl_owned_entries',ev);
  EXECUTE format('DROP TRIGGER IF EXISTS wm_gl_owned_gl_%s ON app_gl_entries',ev);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS wm_gl_owned_truncate ON wm_gl_owned_entries;
TRUNCATE wm_gl_owned_entries,wm_gl_owned_daily,wm_gl_owned_scopes;
INSERT INTO wm_gl_owned_entries
 WITH ownership AS MATERIALIZED (
  SELECT kind,source_id,
   COALESCE(array_agg(DISTINCT owner_id ORDER BY owner_id) FILTER(WHERE owner_id IS NOT NULL),'{}'::text[]) owner_ids,
   COALESCE(array_agg(DISTINCT employee_id ORDER BY employee_id) FILTER(WHERE employee_id IS NOT NULL),'{}'::text[]) employee_ids
  FROM wm_gl_owner_sources GROUP BY kind,source_id
 ) SELECT gl.id,wm_gl_owned_kind(gl.voucher_type),
  CASE WHEN gl.voucher_type='inventory_correction' THEN gl.voucher_id ELSE COALESCE(gl.reversal_of_voucher_id,gl.voucher_id) END,
  gl.account_id,gl.posting_date,gl.voucher_type,gl.debit,gl.credit,
  COALESCE(o.owner_ids,'{}'::text[]),COALESCE(o.employee_ids,'{}'::text[])
 FROM app_gl_entries gl LEFT JOIN ownership o ON o.kind=wm_gl_owned_kind(gl.voucher_type)
  AND o.source_id=CASE WHEN gl.voucher_type='inventory_correction' THEN gl.voucher_id ELSE COALESCE(gl.reversal_of_voucher_id,gl.voucher_id) END
 WHERE gl.voucher_type NOT LIKE 'hr_%'
 ORDER BY o.owner_ids,o.employee_ids,gl.account_id,gl.posting_date,gl.id;

INSERT INTO wm_gl_owned_daily
 SELECT account_id,posting_date,voucher_type,mod(COALESCE(source_id,0),16)::int,
 owner_ids,employee_ids,count(*),sum(debit),sum(credit)
 FROM wm_gl_owned_entries GROUP BY 1,2,3,4,5,6 ORDER BY 5,6,1,2,3,4;
INSERT INTO wm_gl_owned_scopes SELECT DISTINCT owner_ids,employee_ids FROM wm_gl_owned_entries;

CREATE INDEX IF NOT EXISTS wm_gl_owned_source_idx ON wm_gl_owned_entries(kind,source_id);
CREATE INDEX IF NOT EXISTS wm_gl_owned_date_idx ON wm_gl_owned_entries(posting_date,id);
CREATE INDEX IF NOT EXISTS wm_gl_owned_account_date_idx ON wm_gl_owned_entries(account_id,posting_date,id);
CREATE INDEX IF NOT EXISTS wm_gl_owned_users_idx ON wm_gl_owned_entries USING gin(owner_ids);
CREATE INDEX IF NOT EXISTS wm_gl_owned_employees_idx ON wm_gl_owned_entries USING gin(employee_ids);
CREATE INDEX IF NOT EXISTS wm_gl_owned_daily_users_idx ON wm_gl_owned_daily USING gin(owner_ids);
CREATE INDEX IF NOT EXISTS wm_gl_owned_daily_employees_idx ON wm_gl_owned_daily USING gin(employee_ids);
CREATE INDEX IF NOT EXISTS wm_gl_owned_daily_date_idx ON wm_gl_owned_daily(account_id,posting_date);
CREATE INDEX IF NOT EXISTS wm_gl_owned_scope_date_idx ON wm_gl_owned_entries(owner_ids,employee_ids,posting_date,id)
 INCLUDE(account_id,debit,credit,voucher_type);
CREATE INDEX IF NOT EXISTS wm_gl_owned_daily_scope_idx ON wm_gl_owned_daily(owner_ids,employee_ids,account_id,posting_date)
 INCLUDE(entry_count,debit,credit,voucher_type);

-- Source edits and ledger writes lock the same typed keys before resolving
-- current membership. The subsequent statement sees commits after a lock wait.
CREATE OR REPLACE FUNCTION wm_gl_owned_lock(k text, sid bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('wm_gl_owned:'||k||':'||COALESCE(sid::text,''),0));
 -- Payment membership depends on its current parent, too. Serialize against
 -- parent ownership edits even when a payment is being linked concurrently.
 IF k='customer_payment' THEN
  SELECT invoice_id INTO parent FROM app_invoice_payments WHERE id=sid;
  IF parent IS NOT NULL THEN PERFORM wm_gl_owned_lock('sales_invoice',parent); END IF;
 ELSIF k='purchase_payment' THEN
  SELECT purchase_id INTO parent FROM app_purchase_payments WHERE id=sid;
  IF parent IS NOT NULL THEN PERFORM wm_gl_owned_lock('purchase',parent); END IF;
 ELSIF k='payment_journal' THEN
  FOR parent IN SELECT DISTINCT purchase_id FROM app_purchase_payments
   WHERE journal_entry_id=sid AND method<>'journal' ORDER BY purchase_id LOOP
   PERFORM wm_gl_owned_lock('purchase',parent);
  END LOOP;
 END IF;
END;
$$;

CREATE OR REPLACE FUNCTION wm_gl_owned_refresh(k text, sid bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owners text[]; employees text[];
BEGIN
 PERFORM wm_gl_owned_lock(k,sid);
 IF NOT EXISTS(SELECT 1 FROM wm_gl_owned_entries WHERE kind=k AND source_id=sid) THEN RETURN; END IF;
 SELECT COALESCE(array_agg(DISTINCT owner_id ORDER BY owner_id) FILTER(WHERE owner_id IS NOT NULL),'{}'::text[]),
  COALESCE(array_agg(DISTINCT employee_id ORDER BY employee_id) FILTER(WHERE employee_id IS NOT NULL),'{}'::text[])
 INTO owners,employees FROM wm_gl_owner_sources WHERE kind=k AND source_id=sid;
 UPDATE wm_gl_owned_entries SET owner_ids=owners,employee_ids=employees
 WHERE kind=k AND source_id=sid AND (owner_ids<>owners OR employee_ids<>employees);
END $$;

CREATE OR REPLACE FUNCTION wm_gl_owned_source_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid bigint; linked bigint; r record;
BEGIN
 -- Both old and new links matter when a payment is reassigned or deleted.
 FOR sid IN SELECT DISTINCT x FROM unnest(ARRAY[
  CASE WHEN TG_OP<>'INSERT' THEN OLD.id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.id END]) x WHERE x IS NOT NULL ORDER BY x LOOP
  IF TG_TABLE_NAME='app_invoices' THEN
   PERFORM wm_gl_owned_refresh('sales_invoice',sid);
   FOR linked IN SELECT id FROM app_invoice_payments WHERE invoice_id=sid ORDER BY id LOOP
    PERFORM wm_gl_owned_refresh('customer_payment',linked);
   END LOOP;
  ELSIF TG_TABLE_NAME='app_invoice_payments' THEN PERFORM wm_gl_owned_refresh('customer_payment',sid);
  ELSIF TG_TABLE_NAME='app_purchases' THEN
   PERFORM wm_gl_owned_refresh('purchase',sid);
   FOR r IN SELECT id,journal_entry_id FROM app_purchase_payments WHERE purchase_id=sid ORDER BY id LOOP
    PERFORM wm_gl_owned_refresh('purchase_payment',r.id);
    IF r.journal_entry_id IS NOT NULL THEN PERFORM wm_gl_owned_refresh('payment_journal',r.journal_entry_id); END IF;
   END LOOP;
  ELSIF TG_TABLE_NAME='app_purchase_payments' THEN
   PERFORM wm_gl_owned_refresh('purchase_payment',sid);
  ELSIF TG_TABLE_NAME='app_journal_entries' THEN
   PERFORM wm_gl_owned_refresh('cash_receipt',sid);
   PERFORM wm_gl_owned_refresh('journal_entry',sid);
   PERFORM wm_gl_owned_refresh('payment_journal',sid);
  ELSIF TG_TABLE_NAME='app_stock_entries' THEN PERFORM wm_gl_owned_refresh('stock',sid);
  ELSIF TG_TABLE_NAME='wm_inventory_corrections' THEN PERFORM wm_gl_owned_refresh('inventory_correction',sid);
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='app_purchase_payments' THEN
  FOR linked IN SELECT DISTINCT x FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.journal_entry_id END,
   CASE WHEN TG_OP<>'DELETE' THEN NEW.journal_entry_id END]) x WHERE x IS NOT NULL ORDER BY x LOOP
   PERFORM wm_gl_owned_refresh('payment_journal',linked);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION wm_gl_owned_source_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Source truncation is rare (controlled transaction resets). Re-evaluate all
 -- remaining ownership instead of retaining permission to orphaned entries.
 UPDATE wm_gl_owned_entries e SET owner_ids=COALESCE(o.owner_ids,'{}'::text[]),employee_ids=COALESCE(o.employee_ids,'{}'::text[])
 FROM (SELECT e.id,
  array_agg(DISTINCT s.owner_id ORDER BY s.owner_id) FILTER(WHERE s.owner_id IS NOT NULL) owner_ids,
  array_agg(DISTINCT s.employee_id ORDER BY s.employee_id) FILTER(WHERE s.employee_id IS NOT NULL) employee_ids
  FROM wm_gl_owned_entries e LEFT JOIN wm_gl_owner_sources s ON s.kind=e.kind AND s.source_id=e.source_id GROUP BY e.id) o
 WHERE e.id=o.id AND (e.owner_ids IS DISTINCT FROM COALESCE(o.owner_ids,'{}'::text[])
  OR e.employee_ids IS DISTINCT FROM COALESCE(o.employee_ids,'{}'::text[]));
 RETURN NULL;
END $$;

DO $$
DECLARE tab text; cols text;
BEGIN
 FOR tab,cols IN SELECT * FROM (VALUES
  ('app_invoices','created_by_user_id,invoicer_id'),('app_invoice_payments','invoice_id'),
  ('app_purchases','created_by_user_id'),('app_purchase_payments','purchase_id,journal_entry_id,method'),
  ('app_journal_entries','created_by_user_id'),('app_stock_entries','created_by_user_id'),
  ('wm_inventory_corrections','prepared_by')) x(tab,cols) LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS wm_gl_owned_source_write ON %I',tab);
  EXECUTE format('CREATE TRIGGER wm_gl_owned_source_write AFTER INSERT OR DELETE OR UPDATE OF %s ON %I FOR EACH ROW EXECUTE FUNCTION wm_gl_owned_source_change()',cols,tab);
  EXECUTE format('DROP TRIGGER IF EXISTS wm_gl_owned_source_reset ON %I',tab);
  EXECUTE format('CREATE TRIGGER wm_gl_owned_source_reset AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_owned_source_truncate()',tab);
 END LOOP;
END $$;
