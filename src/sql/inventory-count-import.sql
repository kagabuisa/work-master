-- Preserve the installed owner, grants and function signature while extending
-- Count Save to accept reviewed quantities from an Excel sheet atomically.
DO $migration$
DECLARE definition text; old_guard text; new_guard text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_count_action(text,jsonb)'::regprocedure);
 IF strpos(definition,'sheet_import')>0 THEN RETURN; END IF;
 old_guard:=$guard$IF c.state<>'counting' THEN RAISE EXCEPTION 'count_review_locked: Return the count to counting before editing.'; END IF;$guard$;
 new_guard:=$guard$IF c.state<>'counting' AND NOT (COALESCE(payload->>'sheet_import','false')='true' AND c.state IN('awaiting_review','approved')) THEN RAISE EXCEPTION 'count_review_locked: Return the count to counting before editing.'; END IF;$guard$;
 IF strpos(definition,old_guard)=0 THEN RAISE EXCEPTION 'Cannot upgrade count import: expected review guard is missing.'; END IF;
 definition:=replace(definition,old_guard,new_guard);
 old_guard:='UPDATE wm_inventory_counts SET revision=revision+1,approved_by=NULL,approved_revision=NULL,approved_at=NULL WHERE id=c.id RETURNING * INTO c;';
 new_guard:='UPDATE wm_inventory_counts SET state=''counting'',revision=revision+1,approved_by=NULL,approved_revision=NULL,approved_at=NULL WHERE id=c.id RETURNING * INTO c;';
 IF strpos(definition,old_guard)=0 THEN RAISE EXCEPTION 'Cannot upgrade count import: expected revision update is missing.'; END IF;
 EXECUTE replace(definition,old_guard,new_guard);
END $migration$;
