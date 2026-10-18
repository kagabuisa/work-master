'use strict';
// Derived balances are transactionally maintained from GL transition tables.
// Sixteen buckets spread posting contention without retaining financial reads.
const keys = 'account_id, posting_date, voucher_type, bucket, party_id, cost_center, voucher_id';
const projection = `account_id, posting_date, voucher_type, mod(COALESCE(voucher_id,0),16)::int AS bucket,
 CASE WHEN voucher_type LIKE 'hr_%' THEN party_id END AS party_id,
 CASE WHEN voucher_type LIKE 'hr_%' THEN cost_center END AS cost_center,
 CASE WHEN voucher_type IN ('hr_payment','hr_payment_cancellation') THEN COALESCE(reversal_of_voucher_id,voucher_id) END AS voucher_id`;
async function initGlDaily(client) {
  // Backfill and trigger installation must see one write-free ledger snapshot.
  await client.query('LOCK TABLE app_gl_entries IN SHARE ROW EXCLUSIVE MODE');
  await client.query(`CREATE TABLE IF NOT EXISTS wm_gl_daily (
    account_id bigint NOT NULL REFERENCES app_accounts(id), posting_date date NOT NULL,
    voucher_type text NOT NULL, bucket integer NOT NULL, party_id text, cost_center text, voucher_id bigint,
    entry_count bigint NOT NULL, debit numeric NOT NULL, credit numeric NOT NULL,
    UNIQUE NULLS NOT DISTINCT (${keys})
  )`);
  await client.query('TRUNCATE wm_gl_daily');
  await client.query(`INSERT INTO wm_gl_daily (${keys},entry_count,debit,credit)
    SELECT ${projection},count(*),sum(debit),sum(credit) FROM app_gl_entries
    GROUP BY 1,2,3,4,5,6,7`);
  for (const [event, delta] of [
    ['insert', 'SELECT *,1::bigint AS n FROM new_gl'],
    ['delete', 'SELECT *,(-1)::bigint AS n FROM old_gl'],
    ['update', 'SELECT *,1::bigint AS n FROM new_gl UNION ALL SELECT *,(-1)::bigint AS n FROM old_gl'],
  ]) {
    await client.query(`CREATE OR REPLACE FUNCTION wm_gl_daily_${event}() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE remaining bigint;
      BEGIN
        FOR remaining IN
          INSERT INTO wm_gl_daily (${keys},entry_count,debit,credit)
          SELECT ${projection},sum(n),sum(debit*n),sum(credit*n) FROM (${delta}) changes
          GROUP BY 1,2,3,4,5,6,7
          HAVING sum(n)<>0 OR sum(debit*n)<>0 OR sum(credit*n)<>0
          ORDER BY 1,2,3,4,5 NULLS FIRST,6 NULLS FIRST,7 NULLS FIRST
          ON CONFLICT (${keys}) DO UPDATE SET entry_count=wm_gl_daily.entry_count+EXCLUDED.entry_count,
            debit=wm_gl_daily.debit+EXCLUDED.debit, credit=wm_gl_daily.credit+EXCLUDED.credit
          RETURNING entry_count
        LOOP
          IF remaining<0 THEN RAISE EXCEPTION 'General ledger summary count is inconsistent'; END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    await client.query(`DROP TRIGGER IF EXISTS wm_gl_daily_${event} ON app_gl_entries`);
    const transition = event==='insert' ? 'NEW TABLE AS new_gl' : event==='delete' ? 'OLD TABLE AS old_gl' : 'OLD TABLE AS old_gl NEW TABLE AS new_gl';
    await client.query(`CREATE TRIGGER wm_gl_daily_${event} AFTER ${event.toUpperCase()} ON app_gl_entries
      REFERENCING ${transition} FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_daily_${event}()`);
  }
  await client.query(`CREATE OR REPLACE FUNCTION wm_gl_daily_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN TRUNCATE wm_gl_daily; RETURN NULL; END $$;
    DROP TRIGGER IF EXISTS wm_gl_daily_truncate ON app_gl_entries;
    CREATE TRIGGER wm_gl_daily_truncate AFTER TRUNCATE ON app_gl_entries
      FOR EACH STATEMENT EXECUTE FUNCTION wm_gl_daily_truncate();
    ANALYZE wm_gl_daily`);
}
function canSummarizeGl(filters, access) {
  return !String(filters.voucher_id||'').trim() && !String(filters.search||'').trim() && !String(filters.party||'').trim()
    && (access.ownerId===null || access.ownerId===undefined);
}
function glTotalsSql(whereSql, useDaily) {
  return `SELECT ${useDaily ? 'COALESCE(SUM(gl.entry_count),0)' : 'COUNT(*)'}::int AS total,
    COALESCE(SUM(gl.debit),0)::float AS debit, COALESCE(SUM(gl.credit),0)::float AS credit
    FROM ${useDaily ? '(SELECT *,NULL::bigint AS reversal_of_voucher_id FROM wm_gl_daily)' : 'app_gl_entries'} gl
    JOIN app_accounts account ON account.id=gl.account_id ${whereSql}`;
}
module.exports = { initGlDaily, canSummarizeGl, glTotalsSql };
