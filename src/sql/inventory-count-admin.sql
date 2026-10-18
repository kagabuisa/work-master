-- Administrators may prepare, revise, approve and submit the same unfinished
-- reconciliation. Normal permissions, audit, revision and terminal guards remain.
DO $migration$
DECLARE definition text; old_rule text; new_rule text;
BEGIN
 definition:=pg_get_functiondef('wm_inventory_count_action(text,jsonb)'::regprocedure);
 IF strpos(definition,'admin_reconciliation_authority')>0 THEN RETURN; END IF;
 old_rule:=$rule$IF c.state<>'counting' AND NOT (COALESCE(payload->>'sheet_import','false')='true' AND c.state IN('awaiting_review','approved')) THEN$rule$;
 new_rule:=$rule$IF c.state<>'counting' AND NOT (c.state IN('awaiting_review','approved') AND (EXISTS(SELECT 1 FROM app_users WHERE id=actor AND role='admin') OR COALESCE(payload->>'sheet_import','false')='true')) THEN$rule$;
 IF strpos(definition,old_rule)=0 THEN RAISE EXCEPTION 'Cannot upgrade administrator reconciliation save rule.'; END IF;
 definition:=replace(definition,old_rule,new_rule);
 old_rule:=$rule$IF c.state<>'awaiting_review' OR (actor=c.prepared_by OR EXISTS(SELECT 1 FROM wm_inventory_count_audit a WHERE a.count_id=c.id AND a.actor_id=actor AND a.action IN('start','save','evidence_changed'))) THEN$rule$;
 new_rule:=$rule$IF c.state<>'awaiting_review' OR (NOT EXISTS(SELECT 1 FROM app_users WHERE id=actor AND role='admin') AND (actor=c.prepared_by OR EXISTS(SELECT 1 FROM wm_inventory_count_audit a WHERE a.count_id=c.id AND a.actor_id=actor AND a.action IN('start','save','evidence_changed')))) THEN$rule$;
 IF strpos(definition,old_rule)=0 THEN RAISE EXCEPTION 'Cannot upgrade administrator reconciliation approval rule.'; END IF;
 definition:=replace(definition,old_rule,new_rule);
 old_rule:='OR c.approved_by=c.prepared_by THEN';
 new_rule:='OR (c.approved_by=c.prepared_by AND NOT EXISTS(SELECT 1 FROM app_users WHERE id=c.approved_by AND role=''admin'')) THEN';
 IF strpos(definition,old_rule)=0 THEN RAISE EXCEPTION 'Cannot upgrade administrator reconciliation submission rule.'; END IF;
 definition:=replace(definition,old_rule,new_rule);
 -- Marker makes this upgrade safe to replay without changing ownership/grants.
 definition:=replace(definition,'BEGIN','BEGIN /* admin_reconciliation_authority */');
 EXECUTE definition;
END $migration$;
