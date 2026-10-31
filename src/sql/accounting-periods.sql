CREATE TABLE IF NOT EXISTS app_accounting_periods (
 id bigserial PRIMARY KEY, period_start date NOT NULL, period_end date NOT NULL CHECK(period_end>=period_start),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','returned','closed','reopened')),
 revision integer NOT NULL DEFAULT 1, review_notes text NOT NULL DEFAULT '', review_checks jsonb NOT NULL DEFAULT '{}',
 prepared_by bigint NOT NULL REFERENCES app_users(id), prepared_at timestamptz NOT NULL DEFAULT now(),
 ledger_snapshot jsonb, approved_by bigint REFERENCES app_users(id), approved_at timestamptz,
 admin_notes text NOT NULL DEFAULT '', opened_by bigint REFERENCES app_users(id), opened_at timestamptz, open_reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_accounting_periods_closed_dates_idx ON app_accounting_periods(period_start,period_end) WHERE status='closed';
CREATE TABLE IF NOT EXISTS app_accounting_period_events (
 id bigserial PRIMARY KEY, period_id bigint NOT NULL REFERENCES app_accounting_periods(id),
 action text NOT NULL, actor_id bigint NOT NULL REFERENCES app_users(id), reason text NOT NULL,
 state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- Shared locks coexist during posting; only approval/reopening takes the exclusive lock.
CREATE OR REPLACE FUNCTION wm_accounting_posting_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(1776342163); RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION wm_accounting_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocked boolean;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_accounting_periods WHERE status='closed') THEN RETURN NULL; END IF;
 IF TG_OP IN ('DELETE','UPDATE') THEN
  SELECT EXISTS(SELECT 1 FROM old_rows g JOIN app_accounting_periods p ON p.status='closed' AND g.posting_date BETWEEN p.period_start AND p.period_end) INTO blocked;
  IF blocked THEN RAISE EXCEPTION 'accounting_period_closed: Cannot change postings in a closed accounting period.' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  SELECT EXISTS(SELECT 1 FROM new_rows g JOIN app_accounting_periods p ON p.status='closed' AND g.posting_date BETWEEN p.period_start AND p.period_end) INTO blocked;
  IF NOT blocked THEN
   SELECT EXISTS(SELECT 1 FROM new_rows n JOIN app_gl_entries original ON original.voucher_type=n.reversal_of_voucher_type AND original.voucher_id=n.reversal_of_voucher_id
    JOIN app_accounting_periods p ON p.status='closed' AND original.posting_date BETWEEN p.period_start AND p.period_end) INTO blocked;
  END IF;
  IF blocked THEN RAISE EXCEPTION 'accounting_period_closed: Cannot post into or reverse a voucher from a closed accounting period.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS wm_accounting_posting_lock ON app_gl_entries;
CREATE TRIGGER wm_accounting_posting_lock BEFORE INSERT OR UPDATE OR DELETE ON app_gl_entries FOR EACH STATEMENT EXECUTE FUNCTION wm_accounting_posting_lock();
DROP TRIGGER IF EXISTS wm_accounting_insert_guard ON app_gl_entries;
CREATE TRIGGER wm_accounting_insert_guard AFTER INSERT ON app_gl_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wm_accounting_period_guard();
DROP TRIGGER IF EXISTS wm_accounting_update_guard ON app_gl_entries;
CREATE TRIGGER wm_accounting_update_guard AFTER UPDATE ON app_gl_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wm_accounting_period_guard();
DROP TRIGGER IF EXISTS wm_accounting_delete_guard ON app_gl_entries;
CREATE TRIGGER wm_accounting_delete_guard AFTER DELETE ON app_gl_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION wm_accounting_period_guard();
DO $$ DECLARE login record; BEGIN
 FOR login IN SELECT rolname FROM pg_roles WHERE rolname='wm_inventory_runtime_'||substr(encode(sha256(current_database()::bytea),'hex'),1,12) LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app_accounting_periods TO %I',login.rolname);
  EXECUTE format('GRANT SELECT,INSERT ON app_accounting_period_events TO %I',login.rolname);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE app_accounting_periods_id_seq,app_accounting_period_events_id_seq TO %I',login.rolname);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION wm_accounting_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(1776342163);
 IF EXISTS(SELECT 1 FROM app_accounting_periods WHERE status='closed') THEN
  RAISE EXCEPTION 'accounting_period_closed: Reopen closed accounting periods before resetting financial history.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS wm_accounting_truncate_guard ON app_gl_entries;
CREATE TRIGGER wm_accounting_truncate_guard BEFORE TRUNCATE ON app_gl_entries FOR EACH STATEMENT EXECUTE FUNCTION wm_accounting_truncate_guard();
CREATE OR REPLACE FUNCTION wm_accounting_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Accounting period audit events are immutable.';
END $$;
DROP TRIGGER IF EXISTS wm_accounting_event_immutable ON app_accounting_period_events;
CREATE TRIGGER wm_accounting_event_immutable BEFORE UPDATE OR DELETE ON app_accounting_period_events FOR EACH ROW EXECUTE FUNCTION wm_accounting_event_immutable();
