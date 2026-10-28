-- Upgrade already-installed controlled posting without rewriting historical rows.
DO $migration$
DECLARE definition text; original text; replacement text;
BEGIN
 definition := pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure);
 original := 'IF q>0 THEN ir:=round(COALESCE(NULLIF((m->>''rate'')::numeric,0),b.valuation_rate,0));val:=round(q*ir);';
 replacement := 'IF q>0 THEN ir:=COALESCE(NULLIF((m->>''rate'')::numeric,0),b.valuation_rate,0);val:=round(q*ir);';
 IF strpos(definition, replacement)>0 THEN RETURN; END IF;
 IF strpos(definition, original)=0 THEN RAISE EXCEPTION 'Cannot install fractional receipt values: valuation differs.'; END IF;
 EXECUTE replace(definition, original, replacement);
END $migration$;
