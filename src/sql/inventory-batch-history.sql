-- Validate all invoice movements in one set-based pass before applying them.
-- The unchecked apply helper is private: only the batch entry point can call it,
-- and that entry point performs the historical check first.

CREATE OR REPLACE FUNCTION wm_inventory_check_history_batch(
  ev wm_inventory_events,
  movements jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  document_at timestamptz;
  missing record;
BEGIN
  IF ev.is_reversal OR ev.count_id IS NOT NULL OR ev.voucher_type='inventory_correction' THEN
    RETURN;
  END IF;

  document_at:=wm_inventory_document_stamp(ev.voucher_type,ev.voucher_id);
  IF document_at=date_trunc('minute',document_at)
    AND document_at=date_trunc('minute',ev.movement_at) THEN
    document_at:=ev.movement_at;
  END IF;

  -- A successful current posting needs only one stock-balance lookup per item.
  -- Shortage checks still fall through to the exact historical calculation.
  IF document_at>=ev.movement_at AND wm_inventory_enabled()
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(movements) movement
      LEFT JOIN wm_inventory_control control ON control.warehouse=movement->>'warehouse'
      WHERE control.warehouse IS NULL
        OR control.last_movement>document_at
        OR COALESCE((movement->>'qty_change')::numeric,0)>=0
    )
  THEN
    SELECT requested.item_code,requested.item_name,requested.warehouse,
      requested.requested,COALESCE(stock.quantity,0) AS current_quantity
    INTO missing
    FROM (
      SELECT movement->>'item_code' AS item_code,
        movement->>'warehouse' AS warehouse,
        MIN(movement->>'item_name') AS item_name,
        SUM(ABS((movement->>'qty_change')::numeric)) AS requested
      FROM jsonb_array_elements(movements) movement
      WHERE COALESCE((movement->>'qty_change')::numeric,0)<0
      GROUP BY 1,2
    ) requested
    LEFT JOIN app_stock_balances stock
      ON stock.item_code=requested.item_code AND stock.warehouse=requested.warehouse
    WHERE COALESCE(stock.quantity,0)-requested.requested<-0.0005
    ORDER BY requested.warehouse,requested.item_code
    LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  WITH requested AS MATERIALIZED (
    SELECT movement->>'item_code' AS item_code,
      movement->>'warehouse' AS warehouse,
      MIN(movement->>'item_name') AS item_name,
      SUM(ABS((movement->>'qty_change')::numeric)) AS requested
    FROM jsonb_array_elements(movements) movement
    WHERE COALESCE((movement->>'qty_change')::numeric,0)<0
    GROUP BY 1,2
  ), history AS MATERIALIZED (
    SELECT requested.item_code,requested.warehouse,ledger.id,ledger.qty_change,
      CASE WHEN ledger.posting_event_id IS NOT NULL AND NOT ledger.is_reversal AND ledger.qty_change<0
        THEN CASE WHEN (CASE WHEN ledger.voucher_type='invoice' THEN invoice.invoice_date+invoice.posting_time
          WHEN ledger.voucher_type LIKE 'stock_%' THEN entry.posting_date+entry.posting_time END)
            =date_trunc('minute',ledger.movement_at AT TIME ZONE 'Africa/Kampala') THEN ledger.movement_at
          ELSE COALESCE((CASE WHEN ledger.voucher_type='invoice' THEN invoice.invoice_date+invoice.posting_time
            WHEN ledger.voucher_type LIKE 'stock_%' THEN entry.posting_date+entry.posting_time END)
              AT TIME ZONE 'Africa/Kampala',ledger.movement_at) END
        ELSE ledger.movement_at END AS effective_at
    FROM requested
    JOIN app_stock_ledger ledger
      ON ledger.item_code=requested.item_code AND ledger.warehouse=requested.warehouse
    LEFT JOIN app_invoices invoice ON invoice.id=CASE WHEN ledger.posting_event_id IS NOT NULL
      AND NOT ledger.is_reversal AND ledger.qty_change<0 AND ledger.voucher_type='invoice'
      THEN ledger.voucher_id END
    LEFT JOIN app_stock_entries entry ON entry.id=CASE WHEN ledger.posting_event_id IS NOT NULL
      AND NOT ledger.is_reversal AND ledger.qty_change<0 AND ledger.voucher_type LIKE 'stock_%'
      THEN ledger.voucher_id END
  ), opening AS (
    SELECT item_code,warehouse,SUM(qty_change) AS quantity
    FROM history
    WHERE effective_at<=document_at
    GROUP BY item_code,warehouse
  ), later_balances AS (
    SELECT item_code,warehouse,id,effective_at,
      SUM(qty_change) OVER (
        PARTITION BY item_code,warehouse ORDER BY effective_at,id ROWS UNBOUNDED PRECEDING
      ) AS delta
    FROM history
    WHERE effective_at>document_at
  ), later AS (
    SELECT item_code,warehouse,MIN(delta) AS delta
    FROM later_balances
    GROUP BY item_code,warehouse
  )
  SELECT requested.item_code,requested.item_name,requested.warehouse,requested.requested,
    COALESCE(opening.quantity,0) AS historical_quantity,
    LEAST(COALESCE(opening.quantity,0),
      COALESCE(opening.quantity,0)+LEAST(0,COALESCE(later.delta,0))) AS available_quantity,
    COALESCE(stock.quantity,0) AS current_quantity
  INTO missing
  FROM requested
  LEFT JOIN opening ON opening.item_code=requested.item_code AND opening.warehouse=requested.warehouse
  LEFT JOIN later ON later.item_code=requested.item_code AND later.warehouse=requested.warehouse
  LEFT JOIN app_stock_balances stock
    ON stock.item_code=requested.item_code AND stock.warehouse=requested.warehouse
  WHERE requested.requested>
    LEAST(COALESCE(opening.quantity,0),
      COALESCE(opening.quantity,0)+LEAST(0,COALESCE(later.delta,0)))+0.0005
  ORDER BY requested.warehouse,requested.item_code
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'insufficient_stock: Historical stock for % in % at % Kampala is %; available after later transactions is %; requested %. Later receipts or reconciliations cannot supply an earlier sale or transfer.',
      missing.item_code,missing.warehouse,document_at AT TIME ZONE 'Africa/Kampala',
      missing.historical_quantity,missing.available_quantity,missing.requested;
  END IF;
END $$;

DO $migration$
DECLARE definition text;
BEGIN
  IF to_regprocedure('wm_inventory_apply_unchecked(jsonb)') IS NULL THEN
    definition:=pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure);
    definition:=replace(definition,'wm_inventory_apply(m jsonb)','wm_inventory_apply_unchecked(m jsonb)');
    IF strpos(definition,'wm_inventory_apply_unchecked(m jsonb)')=0 THEN
      RAISE EXCEPTION 'Cannot create the private inventory apply helper.';
    END IF;
    definition:=replace(definition,E'\n PERFORM wm_inventory_check_history(ev,m);','');
    EXECUTE definition;
  END IF;
END $migration$;

CREATE OR REPLACE FUNCTION wm_inventory_apply_batch(movements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  ev wm_inventory_events;
  result jsonb:='[]'::jsonb;
  index integer;
BEGIN
  IF jsonb_typeof(movements)<>'array' OR jsonb_array_length(movements)=0 THEN
    RAISE EXCEPTION 'inventory_invalid_batch: Supply at least one stock movement.';
  END IF;
  SELECT * INTO ev FROM wm_inventory_events
  WHERE txid=txid_current()
    AND voucher_type=movements->0->>'voucher_type'
    AND voucher_id=(movements->0->>'voucher_id')::bigint
    AND is_reversal=COALESCE((movements->0->>'is_reversal')::boolean,false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory_posting_required: Controlled posting must precede stock changes.';
  END IF;
  PERFORM wm_inventory_check_history_batch(ev,movements);
  FOR index IN 0..jsonb_array_length(movements)-1 LOOP
    result:=result||jsonb_build_array(wm_inventory_apply_unchecked(movements->index));
  END LOOP;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION wm_inventory_check_history_batch(wm_inventory_events,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_inventory_apply_unchecked(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_inventory_apply_batch(jsonb) FROM PUBLIC;

DO $migration$
DECLARE role_name name;
BEGIN
  FOR role_name IN
    SELECT DISTINCT grantee::name
    FROM information_schema.routine_privileges
    WHERE specific_schema='public'
      AND routine_name='wm_inventory_apply'
      AND privilege_type='EXECUTE'
      AND grantee<>'PUBLIC'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION wm_inventory_apply_batch(jsonb) TO %I',role_name);
  END LOOP;
END $migration$;
