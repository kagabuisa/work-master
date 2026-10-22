'use strict';

// More restrictive reports retain the independent detailed access predicates.
// Signatures describe source ownership, never a cached user's permissions.
function canSummarizeOwnedGl(filters, access) {
  return access.ownerId !== null && access.ownerId !== undefined && !access.exportAll
    && !['search', 'party', 'voucher_id', 'group_by'].some(key => String(filters[key] || '').trim())
    && !Array.isArray(access.customerGroups) && !Array.isArray(access.supplierTypes)
    && !Array.isArray(access.allowedAccounts) && !access.deniedAccounts?.length
    && !access.hrAccess?.payroll && !access.hrAccess?.money;
}

async function initOwnedGl(client) {
  await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'sql/gl-owned.sql'), 'utf8'));
  const keys = 'account_id,posting_date,voucher_type,bucket,owner_ids,employee_ids';
  for (const event of ['insert', 'update', 'delete']) {
    const delta = [event !== 'delete' && 'SELECT *,1::bigint n FROM new_owned',
      event !== 'insert' && 'SELECT *,(-1)::bigint n FROM old_owned'].filter(Boolean).join(' UNION ALL ');
    await client.query(`CREATE OR REPLACE FUNCTION wm_gl_owned_daily_${event}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
      DECLARE remaining bigint;
      BEGIN
        INSERT INTO wm_gl_owned_scopes SELECT DISTINCT owner_ids,employee_ids FROM (${delta}) changed
          ORDER BY 1,2 ON CONFLICT DO NOTHING;
        FOR remaining IN
          INSERT INTO wm_gl_owned_daily (${keys},entry_count,debit,credit)
          SELECT account_id,posting_date,voucher_type,mod(COALESCE(source_id,0),16)::int,
            owner_ids,employee_ids,sum(n),sum(debit*n),sum(credit*n) FROM (${delta}) changes
          GROUP BY 1,2,3,4,5,6 HAVING sum(n)<>0 OR sum(debit*n)<>0 OR sum(credit*n)<>0
          ORDER BY 1,2,3,4,5,6
          ON CONFLICT (${keys}) DO UPDATE SET entry_count=wm_gl_owned_daily.entry_count+EXCLUDED.entry_count,
            debit=wm_gl_owned_daily.debit+EXCLUDED.debit,credit=wm_gl_owned_daily.credit+EXCLUDED.credit
          RETURNING entry_count
        LOOP
          IF remaining<0 THEN RAISE EXCEPTION 'Owned ledger summary count is inconsistent'; END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    const transition = event === 'insert' ? 'NEW TABLE AS new_owned' : event === 'delete'
      ? 'OLD TABLE AS old_owned' : 'OLD TABLE AS old_owned NEW TABLE AS new_owned';
    await client.query(`CREATE TRIGGER wm_gl_owned_daily_${event} AFTER ${event} ON wm_gl_owned_entries
      REFERENCING ${transition} FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_owned_daily_${event}()`);
    await client.query(`CREATE OR REPLACE FUNCTION wm_gl_owned_gl_${event}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
      DECLARE r record;
      BEGIN
        ${event !== 'delete' ? `FOR r IN SELECT DISTINCT wm_gl_owned_kind(voucher_type) kind,
          CASE WHEN voucher_type='inventory_correction' THEN voucher_id ELSE COALESCE(reversal_of_voucher_id,voucher_id) END source_id
          FROM new_gl WHERE voucher_type NOT LIKE 'hr_%' ORDER BY 1,2 LOOP
          PERFORM wm_gl_owned_lock(r.kind,r.source_id);
        END LOOP;` : ''}
        ${event !== 'insert' ? 'DELETE FROM wm_gl_owned_entries WHERE id IN (SELECT id FROM old_gl);' : ''}
        ${event !== 'delete' ? `INSERT INTO wm_gl_owned_entries
          WITH keys AS MATERIALIZED (
            SELECT DISTINCT wm_gl_owned_kind(voucher_type) kind,
              CASE WHEN voucher_type='inventory_correction' THEN voucher_id ELSE COALESCE(reversal_of_voucher_id,voucher_id) END source_id
            FROM new_gl WHERE voucher_type NOT LIKE 'hr_%'
          ), ownership AS MATERIALIZED (
            SELECT k.kind,k.source_id,s.owner_ids,s.employee_ids
            FROM keys k CROSS JOIN LATERAL (
              SELECT COALESCE(array_agg(DISTINCT owner_id ORDER BY owner_id) FILTER(WHERE owner_id IS NOT NULL),'{}'::text[]) owner_ids,
                COALESCE(array_agg(DISTINCT employee_id ORDER BY employee_id) FILTER(WHERE employee_id IS NOT NULL),'{}'::text[]) employee_ids
              FROM wm_gl_owner_sources WHERE kind=k.kind AND source_id=k.source_id OFFSET 0
            ) s
          ) SELECT gl.id,wm_gl_owned_kind(gl.voucher_type),
            CASE WHEN gl.voucher_type='inventory_correction' THEN gl.voucher_id ELSE COALESCE(gl.reversal_of_voucher_id,gl.voucher_id) END,
            gl.account_id,gl.posting_date,gl.voucher_type,gl.debit,gl.credit,o.owner_ids,o.employee_ids
          FROM new_gl gl JOIN ownership o ON o.kind=wm_gl_owned_kind(gl.voucher_type)
            AND o.source_id IS NOT DISTINCT FROM CASE WHEN gl.voucher_type='inventory_correction' THEN gl.voucher_id ELSE COALESCE(gl.reversal_of_voucher_id,gl.voucher_id) END
          WHERE gl.voucher_type NOT LIKE 'hr_%';` : ''}
        RETURN NULL;
      END $$`);
    const glTransition = transition.replaceAll('owned', 'gl');
    await client.query(`CREATE TRIGGER wm_gl_owned_gl_${event} AFTER ${event} ON app_gl_entries
      REFERENCING ${glTransition} FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_owned_gl_${event}()`);
  }
  await client.query(`CREATE OR REPLACE FUNCTION wm_gl_owned_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    BEGIN
      IF TG_TABLE_NAME='app_gl_entries' THEN TRUNCATE wm_gl_owned_entries;
      ELSE TRUNCATE wm_gl_owned_daily,wm_gl_owned_scopes; END IF;
      RETURN NULL;
    END $$;
    DROP TRIGGER IF EXISTS wm_gl_owned_truncate ON app_gl_entries;
    CREATE TRIGGER wm_gl_owned_truncate AFTER TRUNCATE ON app_gl_entries FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_owned_truncate();
    DROP TRIGGER IF EXISTS wm_gl_owned_truncate ON wm_gl_owned_entries;
    CREATE TRIGGER wm_gl_owned_truncate AFTER TRUNCATE ON wm_gl_owned_entries FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_owned_truncate();
    ANALYZE wm_gl_owned_entries; ANALYZE wm_gl_owned_daily; ANALYZE wm_gl_owned_scopes;
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname<>current_user
        AND has_table_privilege(oid,'app_gl_entries','SELECT') LOOP
        EXECUTE format('GRANT SELECT ON wm_gl_owned_entries,wm_gl_owned_daily,wm_gl_owned_scopes TO %I',r.rolname);
      END LOOP;
    END $$;`);
}

module.exports = { canSummarizeOwnedGl, initOwnedGl };
