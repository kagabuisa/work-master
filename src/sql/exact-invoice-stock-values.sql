-- Additive upgrade only: preserve every posted amount and movement. Selling
-- rates carry six decimal places; monetary line/document amounts remain UGX.
ALTER TABLE app_invoice_items ALTER COLUMN unit_price TYPE numeric(18,6);
ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS reversal_of_ledger_id bigint
  REFERENCES app_stock_ledger(id);
CREATE UNIQUE INDEX IF NOT EXISTS app_stock_ledger_reversal_source_idx
  ON app_stock_ledger(reversal_of_ledger_id) WHERE reversal_of_ledger_id IS NOT NULL;

-- Preserve the guarded function's OID, owner, grants, and all historical/date
-- checks installed by earlier migrations. Fail atomically if anchors differ.
DO $migration$
DECLARE definition text; original text; replacement text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure);
 IF strpos(definition,'exact_stock_values')>0 THEN RETURN; END IF;
 original:=' outr numeric:=0;';
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: declaration differs.'; END IF;
 definition:=replace(definition,original,original || ' source app_stock_ledger; posted_id bigint;');
 original:=$old$ IF q>0 THEN ir:=round(COALESCE(NULLIF((m->>'rate')::numeric,0),b.valuation_rate,0));val:=round(q*ir);
 ELSE outr:=round(COALESCE(NULLIF((m->>'force_outgoing_rate')::numeric,0),b.valuation_rate,0));val:=-round(abs(q)*outr); END IF;$old$;
 replacement:=$new$ -- exact_stock_values: issue a proportion of the locked value, never a rounded average rate.
 IF oldv<0 AND q<0 AND ev.count_id IS NULL THEN RAISE EXCEPTION 'inventory_invalid_value: Resolve the negative stock value before issuing stock.'; END IF;
 IF ev.is_reversal OR m ? 'value_source_id' THEN
  SELECT * INTO source FROM app_stock_ledger WHERE id=CASE WHEN ev.is_reversal
    THEN (m->>'reversal_of_ledger_id')::bigint ELSE (m->>'value_source_id')::bigint END FOR SHARE;
  IF NOT FOUND OR source.item_code<>code OR source.qty_change<>-q OR source.is_reversal
    OR source.voucher_type<>ev.voucher_type OR source.voucher_id<>ev.voucher_id
    OR (ev.is_reversal AND source.warehouse<>wh)
    OR (NOT ev.is_reversal AND (source.warehouse=wh OR q<=0 OR source.posting_event_id IS DISTINCT FROM ev.id
      OR ev.voucher_type NOT IN('stock_transfer','stock_order','stock_taff_kla_order','stock_ddr_shortage','stock_ddr_excess')))
  THEN RAISE EXCEPTION 'inventory_invalid_value_source: Movement must reference its original stock value.'; END IF;
 END IF;
 IF q>0 THEN ir:=round(COALESCE(NULLIF((m->>'rate')::numeric,0),b.valuation_rate,0));val:=round(q*ir);
 ELSE outr:=round(COALESCE(b.valuation_rate,0));val:=CASE WHEN oldq>0 THEN -round(abs(q)*oldv/oldq) ELSE 0 END; END IF;
 IF source.id IS NOT NULL THEN val:=-source.stock_value_change; END IF;
 -- An approved zero count can also correct a legacy value-only residual.
 IF m ? 'target_quantity' AND (m->>'target_quantity')::numeric=0 THEN val:=-oldv; END IF;$new$;
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: valuation differs.'; END IF;
 definition:=replace(definition,original,replacement);
 original:=' nq:=round(oldq+q,3);nv:=round(oldv+val);';
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: balance differs.'; END IF;
 definition:=replace(definition,original,original || E'\n IF nv<0 THEN RAISE EXCEPTION ''inventory_invalid_value: This reversal creates negative stock value; use an approved correction.''; END IF;\n IF nq=0 AND nv<>0 THEN RAISE EXCEPTION ''inventory_value_remaining: This reversal leaves value without quantity; use an approved correction.''; END IF;');
 original:='reversal_of_voucher_id,reversal_of_voucher_no,remarks,movement_at,posting_event_id)';
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: ledger columns differ.'; END IF;
 definition:=replace(definition,original,'reversal_of_voucher_id,reversal_of_voucher_no,remarks,movement_at,posting_event_id,reversal_of_ledger_id)');
 original:='m->>''remarks'',ev.movement_at,ev.id);';
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: ledger values differ.'; END IF;
 definition:=replace(definition,original,'m->>''remarks'',ev.movement_at,ev.id,CASE WHEN ev.is_reversal THEN source.id END) RETURNING id INTO posted_id;');
 original:='RETURN jsonb_build_object(''qty_change'',q,';
 IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Cannot install exact stock values: result differs.'; END IF;
 definition:=replace(definition,original,'RETURN jsonb_build_object(''ledger_id'',posted_id,''qty_change'',q,');
 EXECUTE definition;
END $migration$;
