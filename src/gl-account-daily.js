'use strict';

// Compact, transactionally maintained account/date totals for posting guards.
// The detailed wm_gl_daily table retains dimensions needed by reports; posting
// validation only needs the net debit and credit for each account and date.
async function initGlAccountDaily(client) {
  // Backfill and trigger installation must see one write-free ledger snapshot.
  await client.query('LOCK TABLE app_gl_entries IN SHARE ROW EXCLUSIVE MODE');
  await client.query(`CREATE TABLE IF NOT EXISTS wm_gl_account_daily (
    account_id bigint NOT NULL REFERENCES app_accounts(id),
    posting_date date NOT NULL,
    entry_count bigint NOT NULL,
    debit numeric NOT NULL,
    credit numeric NOT NULL,
    PRIMARY KEY (account_id, posting_date)
  )`);
  await client.query('TRUNCATE wm_gl_account_daily');
  await client.query(`INSERT INTO wm_gl_account_daily
      (account_id,posting_date,entry_count,debit,credit)
    SELECT account_id,posting_date,sum(entry_count),sum(debit),sum(credit)
    FROM wm_gl_daily
    GROUP BY account_id,posting_date`);

  for (const [event, delta] of [
    ['insert', 'SELECT *,1::bigint AS n FROM new_gl'],
    ['delete', 'SELECT *,(-1)::bigint AS n FROM old_gl'],
    ['update', `SELECT *,1::bigint AS n FROM new_gl
      UNION ALL SELECT *,(-1)::bigint AS n FROM old_gl`],
  ]) {
    await client.query(`CREATE OR REPLACE FUNCTION wm_gl_account_daily_${event}()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp AS $$
      DECLARE remaining bigint;
      BEGIN
        FOR remaining IN
          INSERT INTO wm_gl_account_daily
            (account_id,posting_date,entry_count,debit,credit)
          SELECT account_id,posting_date,sum(n),sum(debit*n),sum(credit*n)
          FROM (${delta}) changes
          GROUP BY account_id,posting_date
          HAVING sum(n)<>0 OR sum(debit*n)<>0 OR sum(credit*n)<>0
          ORDER BY account_id,posting_date
          ON CONFLICT (account_id,posting_date) DO UPDATE SET
            entry_count=wm_gl_account_daily.entry_count+EXCLUDED.entry_count,
            debit=wm_gl_account_daily.debit+EXCLUDED.debit,
            credit=wm_gl_account_daily.credit+EXCLUDED.credit
          RETURNING entry_count
        LOOP
          IF remaining<0 THEN
            RAISE EXCEPTION 'General ledger account daily count is inconsistent';
          END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    await client.query(`REVOKE ALL ON FUNCTION wm_gl_account_daily_${event}() FROM PUBLIC`);
    await client.query(`DROP TRIGGER IF EXISTS wm_gl_account_daily_${event} ON app_gl_entries`);
    const transition = event === 'insert' ? 'NEW TABLE AS new_gl'
      : event === 'delete' ? 'OLD TABLE AS old_gl'
        : 'OLD TABLE AS old_gl NEW TABLE AS new_gl';
    await client.query(`CREATE TRIGGER wm_gl_account_daily_${event}
      AFTER ${event.toUpperCase()} ON app_gl_entries
      REFERENCING ${transition}
      FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_account_daily_${event}()`);
  }

  await client.query(`CREATE OR REPLACE FUNCTION wm_gl_account_daily_truncate()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp AS $$
    BEGIN
      TRUNCATE wm_gl_account_daily;
      RETURN NULL;
    END $$`);
  await client.query('REVOKE ALL ON FUNCTION wm_gl_account_daily_truncate() FROM PUBLIC');
  await client.query('DROP TRIGGER IF EXISTS wm_gl_account_daily_truncate ON app_gl_entries');
  await client.query(`CREATE TRIGGER wm_gl_account_daily_truncate
    AFTER TRUNCATE ON app_gl_entries
    FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_account_daily_truncate()`);

  await client.query(`DO $$
    DECLARE runtime_role text;
    BEGIN
      FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'wm_inventory_runtime_%'
      LOOP
        EXECUTE format('REVOKE ALL ON wm_gl_account_daily FROM %I', runtime_role);
        EXECUTE format('GRANT SELECT ON wm_gl_account_daily TO %I', runtime_role);
      END LOOP;
    END $$`);
  await client.query('ANALYZE wm_gl_account_daily');
}

module.exports = { initGlAccountDaily };
