CREATE TABLE IF NOT EXISTS app_voucher_approvals (
 voucher_kind text NOT NULL CHECK(voucher_kind IN ('purchases','journals','stock')),
 voucher_id bigint NOT NULL,revision integer NOT NULL DEFAULT 0,
 action_request text NOT NULL DEFAULT '' CHECK(action_request IN ('','Backdate','Cancel')),
 reason text NOT NULL DEFAULT '',allow text NOT NULL DEFAULT '' CHECK(allow IN ('','Backdate','Cancel')),
 review_hash text NOT NULL,approved_by text,approved_at timestamptz,
 PRIMARY KEY(voucher_kind,voucher_id)
);
CREATE TABLE IF NOT EXISTS app_voucher_approval_events (
 id bigserial PRIMARY KEY,voucher_kind text NOT NULL,voucher_id bigint NOT NULL,event text NOT NULL,
 actor_id text NOT NULL,actor_name text NOT NULL,state jsonb NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_voucher_approval_history_idx ON app_voucher_approval_events(voucher_kind,voucher_id,id);
DO $$ DECLARE login record; BEGIN
 FOR login IN SELECT rolname FROM pg_roles WHERE rolname='wm_inventory_runtime_'||substr(encode(sha256(current_database()::bytea),'hex'),1,12) LOOP
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app_voucher_approvals TO %I',login.rolname);
 EXECUTE format('GRANT SELECT,INSERT ON app_voucher_approval_events TO %I',login.rolname);
 EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE app_voucher_approval_events_id_seq TO %I',login.rolname);
 END LOOP;
END $$;
-- Posting dates on these vouchers are never future dated, including drafts.
CREATE OR REPLACE FUNCTION wm_no_future_voucher_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.posting_date IS NOT DISTINCT FROM OLD.posting_date THEN RETURN NEW; END IF;
 IF NEW.posting_date > (clock_timestamp() AT TIME ZONE 'Africa/Kampala')::date THEN
  RAISE EXCEPTION 'future_posting_date: Posting date cannot be in the future (Africa/Kampala).';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['app_purchases','app_purchase_orders','app_journal_entries','app_stock_entries'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS wm_no_future_voucher_draft ON %I',tbl);
 EXECUTE format('CREATE TRIGGER wm_no_future_voucher_draft BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION wm_no_future_voucher_draft()',tbl);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app_voucher_approval_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Voucher approval history is immutable.'; END $$;
DROP TRIGGER IF EXISTS app_voucher_approval_history_guard ON app_voucher_approval_events;
CREATE TRIGGER app_voucher_approval_history_guard BEFORE UPDATE OR DELETE ON app_voucher_approval_events
 FOR EACH ROW EXECUTE FUNCTION app_voucher_approval_history_guard();
