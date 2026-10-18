-- Installed by the migration owner. Runtime has no direct mutation grants on these records.
CREATE TABLE wm_inventory_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false);
INSERT INTO wm_inventory_policy VALUES(true,false);
CREATE TABLE wm_inventory_counts(
 id bigserial PRIMARY KEY, warehouse text NOT NULL REFERENCES app_master_warehouses(warehouse) ON UPDATE RESTRICT ON DELETE RESTRICT,
 cutoff timestamptz NOT NULL, state text NOT NULL CHECK(state IN('counting','awaiting_review','approved','submitted','abandoned')),
 revision integer NOT NULL DEFAULT 1, prepared_by bigint NOT NULL REFERENCES app_users(id),
 approved_by bigint REFERENCES app_users(id), approved_revision integer, approved_at timestamptz,
 submitted_at timestamptz, abandoned_at timestamptz, reason text, readiness text NOT NULL, snapshot_ledger_id bigint,
 reconciliation_id bigint UNIQUE REFERENCES app_stock_entries(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE UNIQUE INDEX wm_inventory_one_active_count ON wm_inventory_counts(warehouse) WHERE state NOT IN('submitted','abandoned');
CREATE TABLE wm_inventory_control(warehouse text PRIMARY KEY REFERENCES app_master_warehouses(warehouse) ON DELETE RESTRICT ON UPDATE RESTRICT,
 active_count bigint UNIQUE REFERENCES wm_inventory_counts(id), closed_through timestamptz, last_movement timestamptz);
CREATE TABLE wm_inventory_count_lines(count_id bigint REFERENCES wm_inventory_counts(id), item_code text REFERENCES app_master_items(item_code),
 item_name text NOT NULL, book_qty numeric(14,3) NOT NULL, book_value numeric(14,2) NOT NULL, book_rate numeric(14,2) NOT NULL,
 counted_qty numeric(14,3) CHECK(counted_qty>=0), valuation_rate numeric(14,2) NOT NULL CHECK(valuation_rate>=0),
 explanation text NOT NULL DEFAULT '', PRIMARY KEY(count_id,item_code));
CREATE TABLE wm_inventory_closures(id bigserial PRIMARY KEY, warehouse text NOT NULL REFERENCES wm_inventory_control(warehouse),
 count_id bigint UNIQUE NOT NULL REFERENCES wm_inventory_counts(id), cutoff timestamptz NOT NULL, reconciliation_id bigint NOT NULL,
 approved_by bigint NOT NULL, submitted_by bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE wm_inventory_events(id bigserial PRIMARY KEY, txid bigint NOT NULL, voucher_type text NOT NULL,voucher_id bigint NOT NULL,
 is_reversal boolean NOT NULL DEFAULT false, movement_at timestamptz NOT NULL, warehouses text[] NOT NULL,
 count_id bigint REFERENCES wm_inventory_counts(id), actor_id bigint, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(voucher_type,voucher_id,is_reversal));
CREATE TABLE wm_inventory_count_audit(id bigserial PRIMARY KEY,count_id bigint REFERENCES wm_inventory_counts(id),
 action text NOT NULL,actor_id bigint NOT NULL,revision integer NOT NULL,details jsonb NOT NULL DEFAULT '{}',at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE wm_inventory_corrections(id bigserial PRIMARY KEY, warehouse text NOT NULL REFERENCES wm_inventory_control(warehouse),
 source_reference text NOT NULL, reason text NOT NULL, treatment text NOT NULL CHECK(treatment IN('absorbed','physical')),
 count_id bigint REFERENCES wm_inventory_counts(id), item_code text REFERENCES app_master_items(item_code), quantity numeric(14,3) NOT NULL,
 rate numeric(14,2) NOT NULL CHECK(rate>=0), financial_lines jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','approved','submitted','abandoned')),
 prepared_by bigint NOT NULL REFERENCES app_users(id),approved_by bigint REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),approved_at timestamptz,submitted_at timestamptz,abandoned_at timestamptz,abandon_reason text, journal_id bigint,
 CHECK((treatment='absorbed' AND count_id IS NOT NULL AND quantity<>0) OR (treatment='physical' AND quantity<>0)));
CREATE UNIQUE INDEX wm_inventory_correction_source ON wm_inventory_corrections(warehouse,lower(trim(source_reference))) WHERE state<>'abandoned';
ALTER TABLE app_stock_ledger ADD COLUMN movement_at timestamptz;
ALTER TABLE app_stock_ledger ADD COLUMN posting_event_id bigint REFERENCES wm_inventory_events(id);
-- Legacy movement time is reconstructed without changing original document fields.
UPDATE app_stock_ledger l SET movement_at = (l.posting_date + CASE WHEN l.is_reversal
 THEN date_trunc('minute',l.created_at AT TIME ZONE 'Africa/Kampala')::time ELSE COALESCE(
 (SELECT se.posting_time FROM app_stock_entries se WHERE se.id=l.voucher_id AND l.voucher_type LIKE 'stock_%'),
 (SELECT p.posting_time FROM app_purchases p WHERE p.id=l.voucher_id AND l.voucher_type='purchase'),
 (SELECT i.posting_time FROM app_invoices i WHERE i.id=l.voucher_id AND l.voucher_type='invoice'),TIME '00:00') END) AT TIME ZONE 'Africa/Kampala';
CREATE INDEX wm_inventory_ledger_time ON app_stock_ledger(warehouse,movement_at,item_code);

CREATE FUNCTION wm_inventory_enabled() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT enabled FROM wm_inventory_policy WHERE id$$;
CREATE FUNCTION wm_inventory_actor(permission text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor bigint; u record; BEGIN
 actor:=NULLIF(current_setting('app.audit_user_id',true),'')::bigint;
 SELECT * INTO u FROM app_users WHERE id=actor AND active=true FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_permission_denied: An active signed-in user is required.' USING ERRCODE='P0001'; END IF;
 IF u.role <> 'admin' AND (COALESCE(u.permission_denials,'[]'::jsonb) ? permission OR NOT (COALESCE(u.permission_grants,'[]'::jsonb) ? permission OR EXISTS(SELECT 1 FROM app_roles r WHERE r.slug=u.role AND r.permissions ? permission)))
 THEN RAISE EXCEPTION 'inventory_permission_denied: Missing permission %.',permission; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION wm_inventory_warehouse_access(wh text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u record; scope jsonb; grants jsonb; denials jsonb; BEGIN
 SELECT u1.*,r.scopes INTO u FROM app_users u1 LEFT JOIN app_roles r ON r.slug=u1.role WHERE u1.id=NULLIF(current_setting('app.audit_user_id',true),'')::bigint;
 IF u.role='admin' THEN RETURN; END IF;
 grants:=COALESCE(u.permission_grants,'[]'::jsonb);denials:=COALESCE(u.permission_denials,'[]'::jsonb);scope:=u.scopes->'warehouses';
 IF denials ? ('warehouse.view:'||wh) OR (NOT (grants ? ('warehouse.view:'||wh)) AND
  ((COALESCE(u.record_access->>'warehouse','')<>'' AND NOT (grants ? 'masters.warehouses.view') AND u.record_access->>'warehouse'<>wh)
   OR (COALESCE(u.record_access->>'warehouse','')='' AND scope->>'mode'='selected' AND NOT ((scope->'values') ? wh)))) THEN
  RAISE EXCEPTION 'inventory_permission_denied: Warehouse is not permitted.'; END IF;
 IF u.id IS NULL THEN RAISE EXCEPTION 'inventory_permission_denied: An active user is required.'; END IF;
END $$;
CREATE FUNCTION wm_inventory_lock(warehouses text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(1776342162);
 FOR w IN SELECT DISTINCT unnest(warehouses) ORDER BY 1 LOOP
  IF w IS NULL OR NOT EXISTS(SELECT 1 FROM app_master_warehouses WHERE warehouse=w AND NOT disabled AND NOT is_group AND docstatus='submitted') THEN RAISE EXCEPTION 'inventory_invalid_warehouse: Choose an active warehouse.'; END IF;
  INSERT INTO wm_inventory_control(warehouse) VALUES(w) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM wm_inventory_control WHERE warehouse=w FOR UPDATE;
 END LOOP;
END $$;
CREATE FUNCTION wm_inventory_begin(typ text,vid bigint,rev boolean,warehouses text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ctl record; ev wm_inventory_events; stamp timestamptz; BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN NULL; END IF;
 IF typ='stock_reconciliation' AND NOT rev THEN RAISE EXCEPTION 'count_required: Use a controlled warehouse count and independent approval.'; END IF;
 PERFORM wm_inventory_lock(warehouses);
 SELECT * INTO ev FROM wm_inventory_events WHERE voucher_type=typ AND voucher_id=vid AND is_reversal=rev;
 IF FOUND THEN
  IF ev.txid<>txid_current() OR ev.warehouses<>ARRAY(SELECT DISTINCT unnest(warehouses) ORDER BY 1) THEN RAISE EXCEPTION 'inventory_posting_conflict: Inventory was already posted.'; END IF;
  RETURN to_jsonb(ev);
 END IF;
 IF NOT rev AND EXISTS(SELECT 1 FROM app_stock_ledger WHERE voucher_type=typ AND voucher_id=vid AND NOT is_reversal) THEN RAISE EXCEPTION 'inventory_posting_conflict: This voucher already has stock movements; use a separate correction.';END IF;
 FOR ctl IN SELECT * FROM wm_inventory_control WHERE warehouse=ANY(warehouses) ORDER BY warehouse LOOP
  IF ctl.active_count IS NOT NULL THEN RAISE EXCEPTION 'warehouse_count_in_progress: % is frozen by count %.',ctl.warehouse,ctl.active_count; END IF;
  IF rev AND EXISTS(SELECT 1 FROM app_stock_ledger l WHERE l.voucher_type=typ AND l.voucher_id=vid AND NOT l.is_reversal
   AND l.warehouse=ctl.warehouse AND l.movement_at<=ctl.closed_through) THEN RAISE EXCEPTION 'closed_voucher_immutable: Use a separately approved current-period correction.'; END IF;
 END LOOP;
 PERFORM wm_inventory_actor(CASE WHEN typ='invoice' THEN 'vouchers.sales.'||CASE WHEN rev THEN 'cancel' ELSE 'submit' END WHEN typ='purchase' THEN 'vouchers.purchases.'||CASE WHEN rev THEN 'cancel' ELSE 'submit' END WHEN typ='inventory_correction' THEN 'inventory.correction.submit' ELSE 'vouchers.stock.'||CASE WHEN rev THEN 'cancel' ELSE 'submit' END END);
 FOR ctl IN SELECT unnest(warehouses) AS warehouse LOOP PERFORM wm_inventory_warehouse_access(ctl.warehouse); END LOOP;
 stamp:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM wm_inventory_control WHERE warehouse=ANY(warehouses) AND (stamp<=closed_through OR stamp<=last_movement))
 THEN RAISE EXCEPTION 'inventory_clock_conflict: Database time must exceed the warehouse closing and posting times.'; END IF;
 INSERT INTO wm_inventory_events(txid,voucher_type,voucher_id,is_reversal,movement_at,warehouses,actor_id)
 VALUES(txid_current(),typ,vid,rev,stamp,ARRAY(SELECT DISTINCT unnest(warehouses) ORDER BY 1),NULLIF(current_setting('app.audit_user_id',true),'')::bigint) RETURNING * INTO ev;
 UPDATE wm_inventory_control SET last_movement=stamp WHERE warehouse=ANY(warehouses);
 RETURN to_jsonb(ev);
END $$;
CREATE FUNCTION wm_inventory_apply(m jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev wm_inventory_events; b app_stock_balances; code text:=m->>'item_code'; wh text:=m->>'warehouse';
 q numeric:=round(COALESCE((m->>'qty_change')::numeric,0),3); oldq numeric; oldv numeric; val numeric; nq numeric; nv numeric; nr numeric; ir numeric:=0; outr numeric:=0;
BEGIN
 IF q::text IN('NaN','Infinity','-Infinity') OR abs(q)>99999999999.999 OR COALESCE(m->>'rate','0') IN('NaN','Infinity','-Infinity') OR COALESCE(m->>'target_quantity','0') IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'inventory_invalid_quantity: Supply finite quantities and rates within storage bounds.';END IF;
 SELECT * INTO ev FROM wm_inventory_events WHERE txid=txid_current() AND voucher_type=m->>'voucher_type'
  AND voucher_id=(m->>'voucher_id')::bigint AND is_reversal=COALESCE((m->>'is_reversal')::boolean,false);
 IF NOT FOUND OR NOT wh=ANY(ev.warehouses) THEN RAISE EXCEPTION 'inventory_posting_required: Controlled posting must precede stock changes.'; END IF;
 IF ev.count_id IS NULL AND NOT EXISTS(SELECT 1 FROM app_master_items WHERE item_code=code AND NOT disabled AND docstatus='submitted') THEN RAISE EXCEPTION 'inventory_invalid_item: Select an active submitted item.';END IF;
 IF ev.count_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wm_inventory_count_lines WHERE count_id=ev.count_id AND item_code=code AND counted_qty=(m->>'target_quantity')::numeric AND valuation_rate=(m->>'rate')::numeric) THEN RAISE EXCEPTION 'count_revision_not_approved: Movement differs from the approved count line.';END IF;
 IF ev.voucher_type='inventory_correction' AND NOT EXISTS(SELECT 1 FROM wm_inventory_corrections WHERE id=ev.voucher_id AND treatment='physical' AND state='approved' AND item_code=code AND warehouse=wh AND quantity=q AND rate=COALESCE((m->>'rate')::numeric,0)) THEN RAISE EXCEPTION 'correction_not_approved: Movement differs from the approved correction.';END IF;
 IF ev.count_id IS NULL AND EXISTS(SELECT 1 FROM wm_inventory_control WHERE warehouse=wh AND (active_count IS NOT NULL OR ev.movement_at<=closed_through)) THEN RAISE EXCEPTION 'inventory_period_closed: Warehouse is frozen or history is closed.'; END IF;
 INSERT INTO app_stock_balances(item_code,warehouse,item_name) VALUES(code,wh,COALESCE(m->>'item_name',code)) ON CONFLICT DO NOTHING;
 SELECT * INTO b FROM app_stock_balances WHERE item_code=code AND warehouse=wh FOR UPDATE;
 oldq:=b.quantity;oldv:=b.stock_value;
 IF m ? 'target_quantity' THEN
  IF ev.count_id IS NULL THEN RAISE EXCEPTION 'count_required: Reconciliation requires an approved count session.'; END IF;
  q:=round((m->>'target_quantity')::numeric-oldq,3);
 END IF;
 IF q<0 AND oldq+q < -0.0005 THEN RAISE EXCEPTION 'insufficient_stock: Insufficient stock for % in %.',code,wh; END IF;
 IF q>0 THEN ir:=round(COALESCE(NULLIF((m->>'rate')::numeric,0),b.valuation_rate,0));val:=round(q*ir);
 ELSE outr:=round(COALESCE(NULLIF((m->>'force_outgoing_rate')::numeric,0),b.valuation_rate,0));val:=-round(abs(q)*outr); END IF;
 IF m ? 'target_quantity' AND q>0 AND ir<=0 THEN RAISE EXCEPTION 'invalid_valuation: Enter a positive valuation rate.'; END IF;
 nq:=round(oldq+q,3);nv:=round(oldv+val);
 nr:=CASE WHEN nq=0 THEN 0 ELSE round(nv/nq) END;
 IF q<>0 OR val<>0 THEN
 UPDATE app_stock_balances SET item_name=COALESCE(m->>'item_name',code),quantity=nq,stock_value=nv,valuation_rate=nr,updated_at=clock_timestamp() WHERE item_code=code AND warehouse=wh;
 INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,voucher_no,qty_change,incoming_rate,outgoing_rate,stock_value_change,qty_after_transaction,stock_value_after_transaction,is_reversal,reversal_of_voucher_id,reversal_of_voucher_no,remarks,movement_at,posting_event_id)
 VALUES((ev.movement_at AT TIME ZONE 'Africa/Kampala')::date,code,COALESCE(m->>'item_name',code),wh,ev.voucher_type,ev.voucher_id,m->>'voucher_no',q,ir,outr,val,nq,nv,ev.is_reversal,(m->>'reversal_of_voucher_id')::bigint,m->>'reversal_of_voucher_no',m->>'remarks',ev.movement_at,ev.id);
 END IF;
 RETURN jsonb_build_object('qty_change',q,'previous_quantity',oldq,'quantity',nq,'valuation_rate',nr,'incoming_rate',ir,'outgoing_rate',outr,'stock_value_change',val);
END $$;
CREATE FUNCTION wm_inventory_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'closed_history_immutable: Inventory control history cannot be modified directly.'; END $$;
CREATE TRIGGER wm_inventory_closure_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wm_inventory_closures FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_immutable();
CREATE TRIGGER wm_inventory_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wm_inventory_count_audit FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_immutable();
-- Protect ordinary SQL writers as well as application paths. Only owner routines may alter stock once enabled.
CREATE FUNCTION wm_inventory_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sourceid bigint; typ text; wh text; BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN COALESCE(NEW,OLD); END IF;
 PERFORM pg_advisory_xact_lock_shared(1776342162);
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'inventory_reset_forbidden: Inventory source records cannot be reset.'; END IF;
 typ:=CASE WHEN TG_TABLE_NAME IN('app_invoices','app_invoice_items') THEN 'invoice' WHEN TG_TABLE_NAME IN('app_purchases','app_purchase_items') THEN 'purchase' ELSE 'stock' END;
 sourceid:=(CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END)->>CASE WHEN TG_TABLE_NAME='app_invoice_items' THEN 'invoice_pk' WHEN TG_TABLE_NAME='app_purchase_items' THEN 'purchase_id' WHEN TG_TABLE_NAME='app_stock_entry_items' THEN 'stock_entry_id' ELSE 'id' END;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)->'id') IS DISTINCT FROM (to_jsonb(OLD)->'id') OR (to_jsonb(NEW)->'invoice_pk') IS DISTINCT FROM (to_jsonb(OLD)->'invoice_pk') OR (to_jsonb(NEW)->'purchase_id') IS DISTINCT FROM (to_jsonb(OLD)->'purchase_id') OR (to_jsonb(NEW)->'stock_entry_id') IS DISTINCT FROM (to_jsonb(OLD)->'stock_entry_id')) THEN RAISE EXCEPTION 'inventory_source_identity_immutable: Inventory source identities cannot be reassigned.';END IF;
 IF typ='stock' AND EXISTS(SELECT 1 FROM wm_inventory_counts WHERE reconciliation_id=sourceid) AND NOT EXISTS(SELECT 1 FROM wm_inventory_events WHERE voucher_id=sourceid AND voucher_type='stock_reconciliation' AND txid=txid_current()) THEN RAISE EXCEPTION 'count_source_immutable: Use the controlled count workflow.'; END IF;
 IF (typ='stock' AND EXISTS(SELECT 1 FROM wm_inventory_counts WHERE reconciliation_id=sourceid AND state IN('submitted','abandoned'))) OR EXISTS(SELECT 1 FROM app_stock_ledger l JOIN wm_inventory_control c ON c.warehouse=l.warehouse
 WHERE l.voucher_id=sourceid AND (l.voucher_type=typ OR (typ='stock' AND l.voucher_type LIKE 'stock_%')) AND l.movement_at<=c.closed_through) THEN
  IF TG_OP IN('INSERT','DELETE') OR TG_TABLE_NAME LIKE '%items' THEN RAISE EXCEPTION 'closed_voucher_immutable: Closed inventory source records cannot be amended or deleted.'; END IF;
  IF (to_jsonb(NEW)-ARRAY['updated_at','updated_by','updated_by_user_id','amount_paid','status']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['updated_at','updated_by','updated_by_user_id','amount_paid','status']) THEN RAISE EXCEPTION 'closed_voucher_immutable: Use a separately approved current-period correction.'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('app_invoices','app_purchases','app_stock_entries') AND
 ((to_jsonb(NEW)->'posting_time') IS DISTINCT FROM (to_jsonb(OLD)->'posting_time') OR
 (to_jsonb(NEW)->'posting_date') IS DISTINCT FROM (to_jsonb(OLD)->'posting_date') OR
 (to_jsonb(NEW)->'invoice_date') IS DISTINCT FROM (to_jsonb(OLD)->'invoice_date')) AND
 EXISTS(SELECT 1 FROM app_stock_ledger WHERE voucher_id=sourceid AND (voucher_type=typ OR (typ='stock' AND voucher_type LIKE 'stock_%'))) THEN
 RAISE EXCEPTION 'inventory_timestamp_immutable: Posted inventory document timestamps cannot be changed.';END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['app_invoices','app_invoice_items','app_purchases','app_purchase_items','app_stock_entries','app_stock_entry_items'] LOOP
 EXECUTE format('CREATE TRIGGER wm_inventory_source_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wm_inventory_source_guard()',t);
 EXECUTE format('CREATE TRIGGER wm_inventory_source_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_source_guard()',t);
 END LOOP;
END $$;
REVOKE ALL ON wm_inventory_policy,wm_inventory_control,wm_inventory_counts,wm_inventory_count_lines,wm_inventory_closures,wm_inventory_events,wm_inventory_count_audit,wm_inventory_corrections FROM PUBLIC;
CREATE FUNCTION wm_inventory_count_action(action text, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c wm_inventory_counts; actor bigint; ctl wm_inventory_control; stamp timestamptz; rid bigint; line jsonb; r record; entryno text; result jsonb;
BEGIN
 IF NOT wm_inventory_enabled() THEN RAISE EXCEPTION 'inventory_not_enabled: Controlled inventory has not been activated.'; END IF;
 PERFORM pg_advisory_xact_lock(1776342162);
 actor:=wm_inventory_actor('inventory.count.'||CASE WHEN action IN('prepare_submit','finish') THEN 'submit' ELSE action END);
 IF action='start' THEN
  IF length(trim(COALESCE(payload->>'readiness','')))<10 THEN RAISE EXCEPTION 'count_readiness_required: Confirm all physical movements stopped and preceding vouchers were submitted.'; END IF;
  PERFORM wm_inventory_warehouse_access(payload->>'warehouse');
  PERFORM wm_inventory_lock(ARRAY[payload->>'warehouse']);
  SELECT * INTO ctl FROM wm_inventory_control WHERE warehouse=payload->>'warehouse' FOR UPDATE;
  IF ctl.active_count IS NOT NULL THEN RAISE EXCEPTION 'warehouse_count_in_progress: Count % is already active.',ctl.active_count; END IF;
  stamp:=clock_timestamp();
  IF ctl.closed_through>=stamp OR ctl.last_movement>=stamp OR EXISTS(SELECT 1 FROM app_stock_ledger WHERE warehouse=ctl.warehouse AND movement_at>=stamp) THEN RAISE EXCEPTION 'inventory_clock_conflict: Resolve future-dated inventory before starting a count.'; END IF;
  INSERT INTO app_stock_entries(entry_type,docstatus,posting_date,posting_time,remarks) VALUES('reconciliation','draft',(stamp AT TIME ZONE 'Africa/Kampala')::date,(stamp AT TIME ZONE 'Africa/Kampala')::time,'Controlled warehouse count') RETURNING id INTO rid;
  UPDATE app_stock_entries SET entry_no='REC-'||lpad(rid::text,6,'0') WHERE id=rid;
  INSERT INTO wm_inventory_counts(warehouse,cutoff,state,prepared_by,readiness,reconciliation_id) VALUES(ctl.warehouse,stamp,'counting',actor,payload->>'readiness',rid) RETURNING * INTO c;
  INSERT INTO wm_inventory_count_lines(count_id,item_code,item_name,book_qty,book_value,book_rate,valuation_rate)
    SELECT c.id,item_code,item_name,quantity,stock_value,valuation_rate,valuation_rate FROM app_stock_balances WHERE warehouse=c.warehouse AND (quantity<>0 OR stock_value<>0);
  UPDATE wm_inventory_counts SET snapshot_ledger_id=(SELECT max(id) FROM app_stock_ledger WHERE warehouse=c.warehouse) WHERE id=c.id RETURNING * INTO c;
  UPDATE wm_inventory_control SET active_count=c.id WHERE warehouse=c.warehouse;
 ELSE
  SELECT * INTO c FROM wm_inventory_counts WHERE id=(payload->>'id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'count_not_found: Count session not found.'; END IF;
  PERFORM wm_inventory_warehouse_access(c.warehouse);
  PERFORM wm_inventory_lock(ARRAY[c.warehouse]);
  SELECT * INTO ctl FROM wm_inventory_control WHERE warehouse=c.warehouse FOR UPDATE;
  IF action IN('prepare_submit','finish') AND c.state='submitted' THEN RETURN to_jsonb(c); END IF;
  IF c.state IN('submitted','abandoned') OR ctl.active_count IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'count_terminal: This count cannot be changed or reused.'; END IF;
  IF (payload->>'revision')::integer IS DISTINCT FROM c.revision THEN RAISE EXCEPTION 'count_revision_conflict: Reload the latest count revision.'; END IF;
  IF action='save' THEN
   IF c.state<>'counting' THEN RAISE EXCEPTION 'count_review_locked: Return the count to counting before editing.'; END IF;
   IF jsonb_typeof(payload->'lines')<>'array' THEN RAISE EXCEPTION 'invalid_count: Provide count lines.'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'lines') x GROUP BY x->>'item_code' HAVING count(*)>1) THEN RAISE EXCEPTION 'invalid_count: Duplicate count lines.'; END IF;
   FOR line IN SELECT * FROM jsonb_array_elements(payload->'lines') LOOP
    IF NOT EXISTS(SELECT 1 FROM app_master_items WHERE item_code=line->>'item_code') THEN RAISE EXCEPTION 'invalid_count: Unknown item.'; END IF;
    IF COALESCE(line->>'counted_qty','0') IN('NaN','Infinity','-Infinity') OR COALESCE(line->>'valuation_rate','NaN') IN('NaN','Infinity','-Infinity') OR (line->>'counted_qty')::numeric>99999999999.999 OR (line->>'valuation_rate')::numeric>999999999999 OR (line->>'counted_qty')::numeric<0 OR (line->>'counted_qty')::numeric<>round((line->>'counted_qty')::numeric,3)
      OR (line->>'valuation_rate')::numeric<0 THEN RAISE EXCEPTION 'invalid_count: Invalid count or valuation rate.'; END IF;
    INSERT INTO wm_inventory_count_lines(count_id,item_code,item_name,book_qty,book_value,book_rate,counted_qty,valuation_rate,explanation)
     SELECT c.id,item_code,item_name,0,0,0,(line->>'counted_qty')::numeric,(line->>'valuation_rate')::numeric,COALESCE(line->>'explanation','') FROM app_master_items WHERE item_code=line->>'item_code'
     ON CONFLICT(count_id,item_code) DO UPDATE SET counted_qty=EXCLUDED.counted_qty,valuation_rate=EXCLUDED.valuation_rate,explanation=EXCLUDED.explanation;
   END LOOP;
   UPDATE wm_inventory_counts SET revision=revision+1,approved_by=NULL,approved_revision=NULL,approved_at=NULL WHERE id=c.id RETURNING * INTO c;
  ELSIF action='review' THEN
   IF c.state<>'counting' OR EXISTS(SELECT 1 FROM wm_inventory_count_lines WHERE count_id=c.id AND (counted_qty IS NULL OR (counted_qty>book_qty AND valuation_rate<=0) OR (counted_qty<>book_qty AND length(trim(explanation))<3))) THEN RAISE EXCEPTION 'count_incomplete: Count every item, explain discrepancies and supply positive rates for gains.'; END IF;
   UPDATE wm_inventory_counts SET state='awaiting_review' WHERE id=c.id RETURNING * INTO c;
  ELSIF action='approve' THEN
   IF c.state<>'awaiting_review' OR (actor=c.prepared_by OR EXISTS(SELECT 1 FROM wm_inventory_count_audit a WHERE a.count_id=c.id AND a.actor_id=actor AND a.action IN('start','save','evidence_changed'))) THEN RAISE EXCEPTION 'count_independent_approval_required: A different authorized reviewer must approve the submitted count.'; END IF;
   UPDATE wm_inventory_counts SET state='approved',approved_by=actor,approved_revision=revision,approved_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  ELSIF action='reject' THEN
   IF c.state NOT IN('awaiting_review','approved') OR length(trim(COALESCE(payload->>'reason','')))<3 THEN RAISE EXCEPTION 'count_reason_required: Supply a review rejection reason.'; END IF;
   UPDATE wm_inventory_counts SET state='counting',revision=revision+1,approved_by=NULL,approved_revision=NULL,approved_at=NULL,reason=payload->>'reason' WHERE id=c.id RETURNING * INTO c;
  ELSIF action='abandon' THEN
   IF length(trim(COALESCE(payload->>'reason','')))<10 THEN RAISE EXCEPTION 'count_reason_required: Explain why this physical count is abandoned.'; END IF;
   UPDATE wm_inventory_counts SET state='abandoned',abandoned_at=clock_timestamp(),reason=payload->>'reason' WHERE id=c.id RETURNING * INTO c;
   UPDATE wm_inventory_control SET active_count=NULL WHERE warehouse=c.warehouse;
  ELSIF action='prepare_submit' THEN
   IF c.state<>'approved' OR c.approved_revision IS DISTINCT FROM c.revision OR c.approved_by=c.prepared_by THEN RAISE EXCEPTION 'count_revision_not_approved: Approve this exact revision before submitting.'; END IF;
   IF EXISTS(SELECT 1 FROM wm_inventory_count_lines l LEFT JOIN app_stock_balances b ON b.warehouse=c.warehouse AND b.item_code=l.item_code WHERE count_id=c.id AND (l.book_qty<>COALESCE(b.quantity,0) OR l.book_value<>COALESCE(b.stock_value,0)))
    OR EXISTS(SELECT 1 FROM app_stock_balances b WHERE b.warehouse=c.warehouse AND (b.quantity<>0 OR b.stock_value<>0) AND NOT EXISTS(SELECT 1 FROM wm_inventory_count_lines l WHERE l.count_id=c.id AND l.item_code=b.item_code)) THEN RAISE EXCEPTION 'count_snapshot_changed: Frozen stock differs from the approved snapshot.'; END IF;
   INSERT INTO wm_inventory_events(txid,voucher_type,voucher_id,movement_at,warehouses,count_id,actor_id) VALUES(txid_current(),'stock_reconciliation',c.reconciliation_id,c.cutoff,ARRAY[c.warehouse],c.id,actor);
   SELECT entry_no INTO entryno FROM app_stock_entries WHERE id=c.reconciliation_id;
   FOR r IN SELECT * FROM wm_inventory_count_lines WHERE count_id=c.id ORDER BY item_code LOOP
    INSERT INTO app_stock_entry_items(stock_entry_id,line_no,item_code,item_name,warehouse,quantity,counted_quantity,valuation_rate)
     VALUES(c.reconciliation_id,(SELECT count(*)+1 FROM app_stock_entry_items WHERE stock_entry_id=c.reconciliation_id),r.item_code,r.item_name,c.warehouse,r.counted_qty-r.book_qty,r.counted_qty,r.valuation_rate);
    PERFORM wm_inventory_apply(jsonb_build_object('item_code',r.item_code,'item_name',r.item_name,'warehouse',c.warehouse,'voucher_type','stock_reconciliation','voucher_id',c.reconciliation_id,'voucher_no',entryno,'target_quantity',r.counted_qty,'rate',r.valuation_rate));
   END LOOP;
  ELSIF action='finish' THEN
   IF c.state<>'approved' OR NOT EXISTS(SELECT 1 FROM wm_inventory_events WHERE count_id=c.id AND txid=txid_current()) THEN RAISE EXCEPTION 'count_posting_required: Reconciliation and closure must commit together.'; END IF;
   IF COALESCE((SELECT sum(stock_value_change) FROM app_stock_ledger WHERE voucher_type='stock_reconciliation' AND voucher_id=c.reconciliation_id),0)
      <>COALESCE((SELECT sum(g.debit-g.credit) FROM app_gl_entries g JOIN app_accounts a ON a.id=g.account_id WHERE g.voucher_type='stock_reconciliation' AND g.voucher_id=c.reconciliation_id AND a.id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory')),0) THEN RAISE EXCEPTION 'count_accounting_mismatch: Reconciliation stock and inventory accounting must agree.'; END IF;
   UPDATE app_stock_entries SET docstatus='submitted',submitted_at=clock_timestamp(),submitted_by_user_id=actor,submitted_by=(SELECT username FROM app_users WHERE id=actor) WHERE id=c.reconciliation_id;
   INSERT INTO wm_inventory_closures(warehouse,count_id,cutoff,reconciliation_id,approved_by,submitted_by) VALUES(c.warehouse,c.id,c.cutoff,c.reconciliation_id,c.approved_by,actor);
   UPDATE wm_inventory_counts SET state='submitted',submitted_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
   UPDATE wm_inventory_control SET active_count=NULL,closed_through=c.cutoff,last_movement=c.cutoff WHERE warehouse=c.warehouse;
  ELSE RAISE EXCEPTION 'invalid_count_action: Unknown count action.';
  END IF;
 END IF;
 INSERT INTO wm_inventory_count_audit(count_id,action,actor_id,revision,details) VALUES(c.id,action,actor,c.revision,payload);
 RETURN to_jsonb(c);
END $$;
CREATE FUNCTION wm_inventory_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c wm_inventory_counts; sid bigint; BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN COALESCE(NEW,OLD); END IF;
 PERFORM pg_advisory_xact_lock(1776342162);
 sid:=CASE WHEN TG_OP='DELETE' THEN OLD.stock_entry_id ELSE NEW.stock_entry_id END;
 SELECT * INTO c FROM wm_inventory_counts WHERE reconciliation_id=sid FOR UPDATE;
 IF FOUND THEN
  IF c.state IN('submitted','abandoned') THEN RAISE EXCEPTION 'count_terminal: Evidence for completed counts is immutable.'; END IF;
  PERFORM wm_inventory_actor('inventory.count.save');PERFORM wm_inventory_warehouse_access(c.warehouse);
  UPDATE wm_inventory_counts SET state='counting',revision=revision+1,approved_by=NULL,approved_revision=NULL,approved_at=NULL WHERE id=c.id;
  INSERT INTO wm_inventory_count_audit(count_id,action,actor_id,revision,details) VALUES(c.id,'evidence_changed',NULLIF(current_setting('app.audit_user_id',true),'')::bigint,c.revision+1,jsonb_build_object('table',TG_TABLE_NAME,'operation',TG_OP));
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER wm_inventory_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON app_stock_reconciliation_attachments FOR EACH ROW EXECUTE FUNCTION wm_inventory_evidence_guard();
CREATE TRIGGER wm_inventory_photo_guard BEFORE INSERT OR UPDATE OR DELETE ON app_reconciliation_photo_counts FOR EACH ROW EXECUTE FUNCTION wm_inventory_evidence_guard();
CREATE FUNCTION wm_inventory_event_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev wm_inventory_events; st text; gltype text; sv numeric; gv numeric; BEGIN
 SELECT * INTO ev FROM wm_inventory_events WHERE id=NEW.id;
 IF ev.count_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wm_inventory_counts WHERE id=ev.count_id AND state='submitted') THEN RAISE EXCEPTION 'inventory_incomplete_posting: Count closure must commit with its movements.'; END IF;
 IF ev.voucher_type='invoice' THEN SELECT docstatus INTO st FROM app_invoices WHERE id=ev.voucher_id;
 ELSIF ev.voucher_type='purchase' THEN SELECT docstatus INTO st FROM app_purchases WHERE id=ev.voucher_id;
 ELSIF ev.voucher_type LIKE 'stock_%' THEN SELECT docstatus INTO st FROM app_stock_entries WHERE id=ev.voucher_id;
 ELSIF ev.voucher_type='inventory_correction' THEN SELECT state INTO st FROM wm_inventory_corrections WHERE id=ev.voucher_id;
 ELSE RAISE EXCEPTION 'inventory_invalid_voucher: Unsupported inventory voucher.'; END IF;
 IF st IS DISTINCT FROM (CASE WHEN ev.is_reversal THEN 'cancelled' ELSE 'submitted' END) THEN RAISE EXCEPTION 'inventory_incomplete_posting: Stock and voucher status must commit together.'; END IF;
 gltype:=CASE WHEN ev.voucher_type='invoice' THEN 'sales_invoice' ELSE ev.voucher_type END || CASE WHEN ev.is_reversal AND ev.voucher_type LIKE 'stock_%' THEN '_reversal' WHEN ev.is_reversal THEN '_cancellation' ELSE '' END;
 SELECT COALESCE(sum(stock_value_change),0) INTO sv FROM app_stock_ledger WHERE posting_event_id=ev.id;
 SELECT COALESCE(sum(g.debit-g.credit),0) INTO gv FROM app_gl_entries g JOIN app_accounts a ON a.id=g.account_id WHERE g.voucher_type=gltype AND g.voucher_id=ev.voucher_id AND a.id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory');
 IF sv<>gv THEN RAISE EXCEPTION 'inventory_accounting_mismatch: Stock value and inventory GL must agree.'; END IF;
 IF ev.voucher_type='invoice' AND NOT ev.is_reversal AND EXISTS(
  (SELECT item_code,warehouse,-sum(quantity) q FROM app_invoice_items WHERE invoice_pk=ev.voucher_id GROUP BY 1,2 EXCEPT
   SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2) UNION ALL
  (SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2 EXCEPT
   SELECT item_code,warehouse,-sum(quantity) FROM app_invoice_items WHERE invoice_pk=ev.voucher_id GROUP BY 1,2)) THEN RAISE EXCEPTION 'inventory_incomplete_posting: Invoice lines and stock movements differ.'; END IF;
 IF ev.voucher_type='purchase' AND NOT ev.is_reversal AND EXISTS(
  (SELECT item_code,warehouse,sum(quantity) q FROM app_purchase_items WHERE purchase_id=ev.voucher_id GROUP BY 1,2 EXCEPT
   SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2) UNION ALL
  (SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2 EXCEPT
   SELECT item_code,warehouse,sum(quantity) FROM app_purchase_items WHERE purchase_id=ev.voucher_id GROUP BY 1,2)) THEN RAISE EXCEPTION 'inventory_incomplete_posting: Receipt lines and stock movements differ.'; END IF;
 IF ev.voucher_type IN('stock_transfer','stock_order','stock_taff_kla_order','stock_ddr_shortage','stock_ddr_excess') AND (sv<>0 OR COALESCE((SELECT sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id),0)<>0) THEN RAISE EXCEPTION 'inventory_incomplete_transfer: Both transfer movements must commit together.'; END IF;
 IF ev.voucher_type LIKE 'stock_%' AND ev.count_id IS NULL AND NOT ev.is_reversal AND EXISTS(
 WITH expected AS (
 SELECT item_code,warehouse,sum(CASE WHEN ev.voucher_type IN('stock_transfer','stock_order','stock_taff_kla_order','stock_ddr_shortage','stock_ddr_excess','stock_cancel') THEN -abs(quantity) WHEN ev.voucher_type='stock_adjustment' THEN quantity ELSE abs(quantity) END) q FROM app_stock_entry_items WHERE stock_entry_id=ev.voucher_id GROUP BY 1,2
 UNION ALL SELECT item_code,target_warehouse,sum(abs(quantity)) FROM app_stock_entry_items WHERE stock_entry_id=ev.voucher_id AND ev.voucher_type IN('stock_transfer','stock_order','stock_taff_kla_order','stock_ddr_shortage','stock_ddr_excess') GROUP BY 1,2),
 actual AS (SELECT item_code,warehouse,sum(qty_change) q FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2)
 (SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)
 ) THEN RAISE EXCEPTION 'inventory_incomplete_posting: Stock entry lines and movements differ.';END IF;
 IF ev.voucher_type='inventory_correction' AND COALESCE((SELECT sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id),0) IS DISTINCT FROM (SELECT CASE WHEN treatment='absorbed' THEN 0 ELSE quantity END FROM wm_inventory_corrections WHERE id=ev.voucher_id) THEN RAISE EXCEPTION 'correction_double_count: Correction quantity must match the independently approved quantity exactly once.';END IF;
 IF ev.is_reversal AND EXISTS(
 (SELECT item_code,warehouse,-sum(qty_change) FROM app_stock_ledger WHERE voucher_type=ev.voucher_type AND voucher_id=ev.voucher_id AND NOT is_reversal GROUP BY 1,2 EXCEPT SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2)
 UNION ALL (SELECT item_code,warehouse,sum(qty_change) FROM app_stock_ledger WHERE posting_event_id=ev.id GROUP BY 1,2 EXCEPT SELECT item_code,warehouse,-sum(qty_change) FROM app_stock_ledger WHERE voucher_type=ev.voucher_type AND voucher_id=ev.voucher_id AND NOT is_reversal GROUP BY 1,2)) THEN RAISE EXCEPTION 'inventory_incomplete_reversal: Reverse every original movement exactly once.';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wm_inventory_event_complete AFTER INSERT ON wm_inventory_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wm_inventory_event_complete();
CREATE TRIGGER wm_inventory_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wm_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_immutable();
CREATE FUNCTION wm_inventory_ledger_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF wm_inventory_enabled() THEN RAISE EXCEPTION 'closed_history_immutable: Posted inventory history cannot be modified or reset.'; END IF;RETURN NULL;END $$;
CREATE TRIGGER wm_inventory_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_stock_ledger FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_ledger_immutable();
CREATE FUNCTION wm_inventory_activate() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(1776342162);
 IF wm_inventory_enabled() THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM app_stock_ledger WHERE movement_at IS NULL OR movement_at>clock_timestamp()) THEN RAISE EXCEPTION 'inventory_activation_blocked: Resolve undated or future inventory history.'; END IF;
 IF EXISTS(SELECT 1 FROM app_stock_ledger l LEFT JOIN app_master_warehouses w USING(warehouse) LEFT JOIN app_master_items i USING(item_code) WHERE w.warehouse IS NULL OR i.item_code IS NULL) THEN RAISE EXCEPTION 'inventory_activation_blocked: Resolve unregistered stock warehouses/items.';END IF;
 IF EXISTS(WITH totals AS(SELECT item_code,warehouse,sum(qty_change) q,sum(stock_value_change) v FROM app_stock_ledger GROUP BY 1,2)
 SELECT 1 FROM totals t FULL JOIN app_stock_balances b USING(item_code,warehouse) WHERE COALESCE(t.q,0)<>COALESCE(b.quantity,0) OR COALESCE(t.v,0)<>COALESCE(b.stock_value,0)) THEN RAISE EXCEPTION 'inventory_activation_blocked: Stock balances must reconcile to the ledger.';END IF;
 INSERT INTO wm_inventory_control(warehouse,last_movement) SELECT warehouse,max(movement_at) FROM app_stock_ledger GROUP BY warehouse ON CONFLICT(warehouse) DO UPDATE SET last_movement=EXCLUDED.last_movement;
 UPDATE wm_inventory_policy SET enabled=true WHERE id;
END $$;
REVOKE ALL ON FUNCTION wm_inventory_activate() FROM PUBLIC;
-- Count history and immutable events survive all ordinary maintenance operations.
CREATE FUNCTION wm_inventory_correction_action(action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c wm_inventory_corrections; actor bigint; discrepancy numeric; used numeric; ev jsonb; BEGIN
 IF NOT wm_inventory_enabled() THEN RAISE EXCEPTION 'inventory_not_enabled: Controlled inventory is not activated.'; END IF;
 PERFORM pg_advisory_xact_lock(1776342162);
 actor:=wm_inventory_actor('inventory.correction.'||CASE WHEN action='prepare_submit' OR action='finish' THEN 'submit' ELSE action END);
 IF action='create' THEN
  PERFORM wm_inventory_warehouse_access(payload->>'warehouse');PERFORM wm_inventory_lock(ARRAY[payload->>'warehouse']);
  IF length(trim(COALESCE(payload->>'reason','')))<10 OR length(trim(COALESCE(payload->>'source_reference','')))<3 THEN RAISE EXCEPTION 'correction_evidence_required: Supply a unique source reference and detailed reason/evidence.'; END IF;
  IF COALESCE(payload->>'quantity','NaN') IN('NaN','Infinity','-Infinity') OR COALESCE(payload->>'rate','0') IN('NaN','Infinity','-Infinity') OR abs((payload->>'quantity')::numeric)>99999999999.999 OR (payload->>'quantity')::numeric=0 OR (payload->>'quantity')::numeric<>round((payload->>'quantity')::numeric,3) THEN RAISE EXCEPTION 'invalid_correction_quantity: Supply a nonzero quantity with at most three decimal places.'; END IF;
  IF payload->>'treatment'='absorbed' THEN
   SELECT l.counted_qty-l.book_qty INTO discrepancy FROM wm_inventory_count_lines l JOIN wm_inventory_counts s ON s.id=l.count_id
    WHERE s.id=(payload->>'count_id')::bigint AND s.warehouse=payload->>'warehouse' AND s.state='submitted' AND l.item_code=payload->>'item_code' FOR UPDATE OF l;
   SELECT COALESCE(sum(abs(quantity)),0) INTO used FROM wm_inventory_corrections WHERE count_id=(payload->>'count_id')::bigint AND item_code=payload->>'item_code' AND treatment='absorbed' AND state<>'abandoned';
   IF discrepancy IS NULL OR sign(discrepancy)<>sign((payload->>'quantity')::numeric) OR used+abs((payload->>'quantity')::numeric)>abs(discrepancy) THEN RAISE EXCEPTION 'correction_exceeds_absorbed_quantity: Correction must match an unallocated signed discrepancy in the closed count.'; END IF;
   IF jsonb_array_length(COALESCE(payload->'financial_lines','[]'))=0 THEN RAISE EXCEPTION 'correction_accounting_required: Provide the reviewed financial reclassification.'; END IF;
  END IF;
  IF jsonb_typeof(COALESCE(payload->'financial_lines','[]'))<>'array' THEN RAISE EXCEPTION 'invalid_correction_accounting: Supply financial lines.';END IF;
  IF jsonb_array_length(COALESCE(payload->'financial_lines','[]'))>0 AND (
   EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'financial_lines') l LEFT JOIN app_accounts a ON a.id=(l->>'account_id')::bigint
    WHERE a.id IS NULL OR NOT a.is_active OR a.is_group OR COALESCE((l->>'debit')::numeric,0)<0 OR COALESCE((l->>'credit')::numeric,0)<0
      OR (COALESCE((l->>'debit')::numeric,0)>0 AND COALESCE((l->>'credit')::numeric,0)>0))
   OR (SELECT COALESCE(sum(COALESCE((l->>'debit')::numeric,0)-COALESCE((l->>'credit')::numeric,0)),0) FROM jsonb_array_elements(payload->'financial_lines') l)<>0
   OR (SELECT COALESCE(sum(COALESCE((l->>'debit')::numeric,0)),0) FROM jsonb_array_elements(payload->'financial_lines') l)<=0
  ) THEN RAISE EXCEPTION 'invalid_correction_accounting: Use active posting accounts and positive balanced debit/credit lines.';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(payload->'financial_lines','[]')) l JOIN app_accounts a ON a.id=(l->>'account_id')::bigint
   WHERE (lower(a.account_detail_type)='receivable' AND (COALESCE(l->>'party_type','')<>'customer' OR NOT EXISTS(SELECT 1 FROM app_master_customers WHERE customer_id=l->>'party_id')))
   OR (lower(a.account_detail_type)='payable' AND (COALESCE(l->>'party_type','')<>'supplier' OR NOT EXISTS(SELECT 1 FROM app_master_suppliers WHERE supplier_id=l->>'party_id')))) THEN RAISE EXCEPTION 'correction_party_required: Receivable/payable lines require a valid customer/supplier.';END IF;
  IF payload->>'treatment'='absorbed' AND (SELECT COALESCE(sum(COALESCE((l->>'debit')::numeric,0)-COALESCE((l->>'credit')::numeric,0)),0)
    FROM jsonb_array_elements(payload->'financial_lines') l WHERE (l->>'account_id')::bigint=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory'))<>0 THEN RAISE EXCEPTION 'correction_inventory_double_count: Absorbed corrections cannot change inventory accounting again.';END IF;
  INSERT INTO wm_inventory_corrections(warehouse,source_reference,reason,treatment,count_id,item_code,quantity,rate,financial_lines,prepared_by)
   VALUES(payload->>'warehouse',trim(payload->>'source_reference'),payload->>'reason',payload->>'treatment',NULLIF(payload->>'count_id','')::bigint,payload->>'item_code',(payload->>'quantity')::numeric,COALESCE((payload->>'rate')::numeric,0),COALESCE(payload->'financial_lines','[]'),actor) RETURNING * INTO c;
 ELSE
  SELECT * INTO c FROM wm_inventory_corrections WHERE id=(payload->>'id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'correction_not_found: Correction not found.'; END IF;
  PERFORM wm_inventory_warehouse_access(c.warehouse);PERFORM wm_inventory_lock(ARRAY[c.warehouse]);
  IF c.state='submitted' AND action IN('prepare_submit','finish') THEN RETURN to_jsonb(c); END IF;
  IF action='abandon' THEN
   IF c.state NOT IN('draft','approved') OR length(trim(COALESCE(payload->>'reason','')))<10 THEN RAISE EXCEPTION 'correction_reason_required: Only unposted corrections may be abandoned, with a detailed reason.';END IF;
   UPDATE wm_inventory_corrections SET state='abandoned',abandoned_at=clock_timestamp(),abandon_reason=payload->>'reason' WHERE id=c.id RETURNING * INTO c;
  ELSIF action='approve' THEN
   IF c.state<>'draft' OR c.prepared_by=actor THEN RAISE EXCEPTION 'correction_independent_approval_required: A different authorized reviewer must approve.'; END IF;
   UPDATE wm_inventory_corrections SET state='approved',approved_by=actor,approved_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  ELSIF action='prepare_submit' THEN
   IF c.state<>'approved' OR c.prepared_by=c.approved_by THEN RAISE EXCEPTION 'correction_not_approved: Independent approval is required.'; END IF;
   ev:=wm_inventory_begin('inventory_correction',c.id,false,ARRAY[c.warehouse]);
   IF c.treatment='physical' THEN PERFORM wm_inventory_apply(jsonb_build_object('item_code',c.item_code,'warehouse',c.warehouse,'item_name',(SELECT item_name FROM app_master_items WHERE item_code=c.item_code),'voucher_type','inventory_correction','voucher_id',c.id,'voucher_no','COR-'||c.id,'qty_change',c.quantity,'rate',c.rate,'remarks',c.reason)); END IF;
  ELSIF action='finish' THEN
   IF c.state<>'approved' OR NOT EXISTS(SELECT 1 FROM wm_inventory_events WHERE txid=txid_current() AND voucher_type='inventory_correction' AND voucher_id=c.id) THEN RAISE EXCEPTION 'correction_posting_required: Effects and approval must commit together.'; END IF;
   UPDATE wm_inventory_corrections SET state='submitted',submitted_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  ELSE RAISE EXCEPTION 'invalid_correction_action: Unknown correction action.'; END IF;
 END IF;
 INSERT INTO wm_inventory_correction_audit(correction_id,action,actor_id,details) VALUES(c.id,action,actor,to_jsonb(c));
 RETURN to_jsonb(c);
END $$;
-- Public EXECUTE is removed; only the provisioned runtime role and owner receive approved entry points.
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'wm_inventory_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION wm_inventory_enabled() TO PUBLIC;
CREATE FUNCTION wm_inventory_ledger_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NOT wm_inventory_enabled() AND NEW.movement_at IS NULL THEN
 NEW.movement_at := (NEW.posting_date + CASE WHEN NEW.is_reversal THEN date_trunc('minute',NEW.created_at AT TIME ZONE 'Africa/Kampala')::time ELSE COALESCE(
 (SELECT posting_time FROM app_stock_entries WHERE id=NEW.voucher_id AND NEW.voucher_type LIKE 'stock_%'),
 (SELECT posting_time FROM app_purchases WHERE id=NEW.voucher_id AND NEW.voucher_type='purchase'),
 (SELECT posting_time FROM app_invoices WHERE id=NEW.voucher_id AND NEW.voucher_type='invoice'),TIME '00:00') END) AT TIME ZONE 'Africa/Kampala';
 END IF;
 IF wm_inventory_enabled() AND NOT EXISTS(SELECT 1 FROM wm_inventory_events WHERE id=NEW.posting_event_id AND txid=txid_current() AND voucher_type=NEW.voucher_type AND voucher_id=NEW.voucher_id AND is_reversal=NEW.is_reversal AND movement_at=NEW.movement_at AND NEW.warehouse=ANY(warehouses)) THEN
 RAISE EXCEPTION 'inventory_posting_required: Every stock movement requires a controlled posting event.';END IF;RETURN NEW;END $$;
CREATE TRIGGER wm_inventory_ledger_insert_guard BEFORE INSERT ON app_stock_ledger FOR EACH ROW EXECUTE FUNCTION wm_inventory_ledger_insert_guard();
CREATE FUNCTION wm_inventory_balance_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b app_stock_balances; q numeric; v numeric; BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN NULL;END IF;
 SELECT * INTO b FROM app_stock_balances WHERE warehouse=NEW.warehouse AND item_code=NEW.item_code;
 SELECT COALESCE(sum(qty_change),0),COALESCE(sum(stock_value_change),0) INTO q,v FROM app_stock_ledger WHERE warehouse=NEW.warehouse AND item_code=NEW.item_code;
 IF b.quantity<>q OR b.stock_value<>v THEN RAISE EXCEPTION 'inventory_balance_mismatch: Stock balance must equal posted movement history.';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER wm_inventory_balance_check AFTER INSERT OR UPDATE ON app_stock_balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wm_inventory_balance_check();
CREATE FUNCTION wm_inventory_gl_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE typ text;vid bigint;BEGIN
 IF NOT wm_inventory_enabled() THEN RETURN COALESCE(NEW,OLD);END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'inventory_reset_forbidden: Posted inventory accounting cannot be reset.';END IF;
 typ:=COALESCE(OLD.voucher_type,NEW.voucher_type);vid:=COALESCE(OLD.voucher_id,NEW.voucher_id);
 IF (NEW.account_id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory') OR OLD.account_id=(SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory')) AND NOT EXISTS(
 SELECT 1 FROM wm_inventory_events e WHERE e.txid=txid_current() AND e.voucher_id=vid AND
 (CASE WHEN e.voucher_type='invoice' THEN 'sales_invoice' ELSE e.voucher_type END || CASE WHEN e.is_reversal AND e.voucher_type LIKE 'stock_%' THEN '_reversal' WHEN e.is_reversal THEN '_cancellation' ELSE '' END)=typ
 AND (e.movement_at AT TIME ZONE 'Africa/Kampala')::date=COALESCE(NEW.posting_date,OLD.posting_date)) THEN
 RAISE EXCEPTION 'inventory_posting_required: Inventory account postings require controlled stock entries or approved corrections; manual journals cannot change inventory.';END IF;

 IF EXISTS(SELECT 1 FROM wm_inventory_events e JOIN wm_inventory_control c ON c.warehouse=ANY(e.warehouses)
 WHERE e.voucher_id=vid AND (e.voucher_type=typ OR (e.voucher_type='invoice' AND typ='sales_invoice')) AND e.movement_at<=c.closed_through)
 OR EXISTS(SELECT 1 FROM app_stock_ledger l JOIN wm_inventory_control c ON c.warehouse=l.warehouse WHERE l.voucher_id=vid AND (l.voucher_type=typ OR (l.voucher_type='invoice' AND typ='sales_invoice')) AND l.movement_at<=c.closed_through) THEN RAISE EXCEPTION 'closed_voucher_immutable: Closed inventory accounting cannot be changed.';END IF;
 RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER wm_inventory_gl_guard BEFORE INSERT OR UPDATE OR DELETE ON app_gl_entries FOR EACH ROW EXECUTE FUNCTION wm_inventory_gl_guard();
CREATE TRIGGER wm_inventory_gl_truncate BEFORE TRUNCATE ON app_gl_entries FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_gl_guard();
REVOKE ALL ON FUNCTION wm_inventory_ledger_insert_guard(),wm_inventory_balance_check(),wm_inventory_gl_guard() FROM PUBLIC;

CREATE TABLE wm_inventory_correction_audit(id bigserial PRIMARY KEY,correction_id bigint NOT NULL REFERENCES wm_inventory_corrections(id),action text NOT NULL,actor_id bigint NOT NULL REFERENCES app_users(id),details jsonb NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER wm_inventory_correction_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wm_inventory_correction_audit FOR EACH STATEMENT EXECUTE FUNCTION wm_inventory_immutable();
REVOKE ALL ON wm_inventory_correction_audit FROM PUBLIC;

CREATE FUNCTION wm_inventory_warehouse_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF wm_inventory_enabled() AND EXISTS(SELECT 1 FROM wm_inventory_control WHERE warehouse=OLD.warehouse AND active_count IS NOT NULL) AND (TG_OP='DELETE' OR NEW.warehouse<>OLD.warehouse OR NEW.disabled OR NEW.is_group OR NEW.docstatus<>'submitted') THEN RAISE EXCEPTION 'warehouse_count_in_progress: Finish or abandon the active count before changing warehouse availability.';END IF;
 RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER wm_inventory_warehouse_guard BEFORE UPDATE OR DELETE ON app_master_warehouses FOR EACH ROW EXECUTE FUNCTION wm_inventory_warehouse_guard();
REVOKE ALL ON FUNCTION wm_inventory_warehouse_guard() FROM PUBLIC;

CREATE FUNCTION wm_inventory_mapping_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF wm_inventory_enabled() AND (to_jsonb(OLD)->>'setting_key'='inventory' OR to_jsonb(NEW)->>'setting_key'='inventory') AND (TG_OP='DELETE' OR to_jsonb(NEW)->>'setting_key' IS DISTINCT FROM 'inventory' OR (to_jsonb(NEW)->>'account_id') IS DISTINCT FROM (SELECT account_id::text FROM app_accounting_settings WHERE setting_key='inventory')) THEN RAISE EXCEPTION 'inventory_mapping_immutable: The inventory account mapping is fixed under controlled inventory.';END IF;
 RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER wm_inventory_mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON app_accounting_settings FOR EACH ROW EXECUTE FUNCTION wm_inventory_mapping_guard();
REVOKE ALL ON FUNCTION wm_inventory_mapping_guard() FROM PUBLIC;
