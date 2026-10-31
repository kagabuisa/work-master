ALTER TABLE app_invoices
  ADD COLUMN IF NOT EXISTS action_request text NOT NULL DEFAULT '' CHECK(action_request IN ('','Backdate','Cancel')),
  ADD COLUMN IF NOT EXISTS why_cancel text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS allow text NOT NULL DEFAULT '' CHECK(allow IN ('','Backdate','Cancel')),
  ADD COLUMN IF NOT EXISTS approval_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE TABLE IF NOT EXISTS app_approved_discounts (
  id bigserial PRIMARY KEY,
  item_code text NOT NULL REFERENCES app_master_items(item_code),
  status text NOT NULL DEFAULT 'Disapproved' CHECK(status IN ('Approved','Disapproved')),
  start_date date NOT NULL,
  expiry_date date CHECK(expiry_date>=start_date),
  warehouse text REFERENCES app_master_warehouses(warehouse),
  warehouse_type text,
  price_list text REFERENCES app_master_price_lists(price_list),
  min_qty numeric(14,3) NOT NULL CHECK(min_qty>0),
  discount_rate numeric(18,6) NOT NULL CHECK(discount_rate>0),
  revision integer NOT NULL DEFAULT 1,
  created_by text,created_by_user_id text,created_at timestamptz,
  updated_by text,updated_by_user_id text,updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS app_approved_discounts_eligible_idx ON app_approved_discounts(item_code,start_date) WHERE status='Approved';
DROP TRIGGER IF EXISTS app_record_audit ON app_approved_discounts;
CREATE TRIGGER app_record_audit BEFORE INSERT OR UPDATE ON app_approved_discounts
  FOR EACH ROW EXECUTE FUNCTION app_stamp_record_audit();
CREATE TABLE IF NOT EXISTS app_sales_approval_events (
  id bigserial PRIMARY KEY,invoice_id bigint NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,
  event text NOT NULL,state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sales_approval_events_invoice_idx ON app_sales_approval_events(invoice_id,id);
CREATE TABLE IF NOT EXISTS app_discount_events (
  id bigserial PRIMARY KEY,discount_id bigint NOT NULL,actor_id text NOT NULL,state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Grant only the new ordinary application tables to already provisioned runtimes.
DO $$ DECLARE login record; BEGIN
 FOR login IN SELECT rolname FROM pg_roles WHERE rolname='wm_inventory_runtime_'||substr(encode(sha256(current_database()::bytea),'hex'),1,12) LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app_approved_discounts TO %I',login.rolname);
  EXECUTE format('GRANT SELECT,INSERT ON app_sales_approval_events,app_discount_events TO %I',login.rolname);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE app_approved_discounts_id_seq,app_sales_approval_events_id_seq,app_discount_events_id_seq TO %I',login.rolname);
 END LOOP;
END $$;
