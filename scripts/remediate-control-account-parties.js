'use strict';

require('../src/environment').loadEnvironment();

const { closeStore, getPostgresPool } = require('../src/core');

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function positiveInteger(value, name, fallback) {
  const number = Number(value || fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100000) {
    throw new Error(`${name} must be an integer from 1 to 100000.`);
  }
  return number;
}

const apply = process.argv.includes('--apply');
const batchSize = positiveInteger(option('batch-size', '10000'), '--batch-size');
const expectedDatabase = option('database');
if (!expectedDatabase) throw new Error('--database is required as an exact safety check.');

const targetsSql = `
  WITH settings AS MATERIALIZED (
    SELECT
      max(account_id) FILTER (WHERE setting_key = 'accounts_receivable') AS receivable_id,
      max(account_id) FILTER (WHERE setting_key = 'accounts_payable') AS payable_id
    FROM app_accounting_settings
  ), ar_journals AS MATERIALIZED (
    SELECT journal.id, journal.journal_no, journal.created_by
    FROM app_journal_entries journal
    WHERE journal.journal_type = 'journal_entry'
      AND journal.docstatus = 'submitted'
      AND (
        COALESCE(journal.party_type, '') <> 'customer'
        OR COALESCE(NULLIF(BTRIM(journal.party_id), ''), '') = ''
      )
      AND journal.total_debit = journal.total_credit
  ), ar_targets AS MATERIALIZED (
    SELECT
      'accounts_receivable'::text AS setting_key,
      entry.id AS gl_entry_id,
      entry.voucher_type,
      entry.voucher_id,
      entry.voucher_no,
      entry.posting_date,
      (entry.debit - entry.credit) AS amount,
      'app_journal_entry_lines'::text AS source_table,
      line.id AS source_row_id,
      journal.id AS journal_id,
      CASE
        WHEN journal.journal_no LIKE 'JRN-LOAD-%' OR journal.created_by = 'System'
          THEN 'historical-synthetic-journal-load'
        WHEN journal.created_by ~ '^(verify-soak|summary-soak|summary-short|posting|load-|load-retest|load-improved)'
          THEN 'historical-soak-or-test-journal'
        ELSE 'other-benchmark-journal'
      END AS source_class,
      settings.receivable_id AS old_account_id
    FROM app_gl_entries entry
    CROSS JOIN settings
    JOIN ar_journals journal ON journal.id = entry.voucher_id
    JOIN app_journal_entry_lines line ON line.journal_entry_id = journal.id
      AND line.line_no = entry.line_no
      AND line.account_id = settings.receivable_id
    WHERE entry.voucher_type = 'journal_entry'
      AND entry.account_id = settings.receivable_id
      AND COALESCE(entry.party_type, '') = ''
      AND COALESCE(entry.party_id, '') = ''
  ), ap_targets AS MATERIALIZED (
    SELECT
      'accounts_payable'::text AS setting_key,
      entry.id AS gl_entry_id,
      entry.voucher_type,
      entry.voucher_id,
      entry.voucher_no,
      entry.posting_date,
      (entry.debit - entry.credit) AS amount,
      'app_stock_entries'::text AS source_table,
      stock.id AS source_row_id,
      NULL::bigint AS journal_id,
      CASE
        WHEN stock.created_by = 'Expanded historical fixture generator'
          THEN 'historical-synthetic-stock-purchase'
        ELSE 'other-benchmark-stock-purchase'
      END AS source_class,
      settings.payable_id AS old_account_id
    FROM app_gl_entries entry
    CROSS JOIN settings
    JOIN app_stock_entries stock ON stock.id = entry.voucher_id
    WHERE entry.voucher_type = 'stock_purchase'
      AND entry.account_id = settings.payable_id
      AND COALESCE(entry.party_type, '') = ''
      AND COALESCE(entry.party_id, '') = ''
  )
  SELECT * FROM ar_targets
  UNION ALL
  SELECT * FROM ap_targets`;

async function inspectCandidates(client) {
  return (await client.query(`
    SELECT setting_key, source_class, count(*)::int AS entries,
      COALESCE(sum(amount), 0)::numeric(20,2) AS balance
    FROM (${targetsSql}) target
    GROUP BY setting_key, source_class
    ORDER BY setting_key, source_class`)).rows;
}

async function verifyTargetCompleteness(client) {
  const { rows: [row] } = await client.query(`
    SELECT
      (SELECT COALESCE(sum(row_count), 0)::int FROM wm_control_account_exceptions) AS exception_rows,
      (SELECT count(*)::int FROM (${targetsSql}) target) AS mapped_rows`);
  if (row.exception_rows !== row.mapped_rows) {
    throw new Error(`Only ${row.mapped_rows} of ${row.exception_rows} control-account exception rows are safely mappable.`);
  }
}

async function ensureSuspenseAccount(client, code, name, type, normalBalance) {
  const { rows } = await client.query(
    'SELECT id, account_type, normal_balance, is_group, is_active FROM app_accounts WHERE account_code = $1',
    [code],
  );
  if (rows[0]) {
    const account = rows[0];
    if (account.account_type !== type || account.normal_balance !== normalBalance
        || account.is_group || !account.is_active) {
      throw new Error(`Existing account ${code} does not match ${type}/${normalBalance} requirements.`);
    }
    return Number(account.id);
  }
  const { rows: [created] } = await client.query(`
    INSERT INTO app_accounts
      (account_code, account_name, account_type, account_detail_type,
       normal_balance, is_group, is_active)
    VALUES ($1, $2, $3, 'Temporary', $4, false, true)
    RETURNING id`, [code, name, type, normalBalance]);
  return Number(created.id);
}

async function rebuildDerivedSummaries(pool, accountIds) {
  const { rows } = await pool.query(`
    SELECT DISTINCT account_id
    FROM (
      SELECT old_account_id AS account_id FROM wm_control_account_remediation_rows
      UNION ALL
      SELECT new_account_id AS account_id FROM wm_control_account_remediation_rows
    ) affected`);
  const ids = [...new Set([
    ...Object.values(accountIds).map(Number),
    ...rows.map((row) => Number(row.account_id)),
  ])];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE wm_gl_daily IN SHARE ROW EXCLUSIVE MODE');
    await client.query('DELETE FROM wm_gl_daily WHERE account_id = ANY($1::bigint[])', [ids]);
    await client.query(`
      INSERT INTO wm_gl_daily
        (account_id,posting_date,voucher_type,bucket,party_id,cost_center,voucher_id,
         entry_count,debit,credit)
      SELECT account_id,posting_date,voucher_type,
        mod(COALESCE(voucher_id,0),16)::int AS bucket,
        CASE WHEN voucher_type LIKE 'hr_%' THEN party_id END AS party_id,
        CASE WHEN voucher_type LIKE 'hr_%' THEN cost_center END AS cost_center,
        CASE WHEN voucher_type IN ('hr_payment','hr_payment_cancellation')
          THEN COALESCE(reversal_of_voucher_id,voucher_id) END AS voucher_id,
        count(*),sum(debit),sum(credit)
      FROM app_gl_entries
      WHERE account_id = ANY($1::bigint[])
      GROUP BY 1,2,3,4,5,6,7`, [ids]);
    await client.query('DELETE FROM wm_gl_owned_daily WHERE account_id = ANY($1::bigint[])', [ids]);
    await client.query(`
      INSERT INTO wm_gl_owned_daily
        (account_id,posting_date,voucher_type,bucket,owner_ids,employee_ids,
         entry_count,debit,credit)
      SELECT account_id,posting_date,voucher_type,
        mod(COALESCE(source_id,0),16)::int,owner_ids,employee_ids,
        count(*),sum(debit),sum(credit)
      FROM wm_gl_owned_entries
      WHERE account_id = ANY($1::bigint[])
      GROUP BY 1,2,3,4,5,6`, [ids]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = getPostgresPool();
  const { rows: [database] } = await pool.query('SELECT current_database() AS name');
  if (database.name !== expectedDatabase) {
    throw new Error(`Connected to ${database.name}, expected ${expectedDatabase}.`);
  }
  if (!/_hr_test$/.test(database.name)) {
    throw new Error('Control-account remediation is restricted to a dedicated *_hr_test database.');
  }
  if (!apply) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await verifyTargetCompleteness(client);
      const candidates = await inspectCandidates(client);
      console.log(JSON.stringify({
        dry_run: true,
        database: database.name,
        candidates,
        total_rows: candidates.reduce((sum, row) => sum + Number(row.entries), 0),
        total_balance: candidates.reduce((sum, row) => sum + Number(row.balance), 0),
      }, null, 2));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const existing = (await pool.query(`
    SELECT to_regclass('public.wm_control_account_remediation_rows') IS NOT NULL AS exists`)).rows[0].exists;
  const existingState = existing ? (await pool.query(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE applied_at IS NULL)::int AS pending,
      max(new_account_id) FILTER (WHERE setting_key='accounts_receivable')::bigint AS receivable_id,
      max(new_account_id) FILTER (WHERE setting_key='accounts_payable')::bigint AS payable_id
    FROM wm_control_account_remediation_rows`)).rows[0] : null;
  const resume = Boolean(existingState && existingState.total > 0);
  const setup = await pool.connect();
  let accountIds;
  let candidates;
  try {
    await setup.query('BEGIN');
    if (resume) {
      accountIds = {
        accounts_receivable: Number(existingState.receivable_id),
        accounts_payable: Number(existingState.payable_id),
      };
      if (!accountIds.accounts_receivable || !accountIds.accounts_payable) {
        throw new Error('Existing remediation mapping does not contain both control-account targets.');
      }
    } else {
      await verifyTargetCompleteness(setup);
      accountIds = {
        accounts_receivable: await ensureSuspenseAccount(
          setup, '1999', 'Benchmark AR Suspense', 'asset', 'debit',
        ),
        accounts_payable: await ensureSuspenseAccount(
          setup, '2999', 'Benchmark AP Suspense', 'liability', 'credit',
        ),
      };
      await setup.query(`
        CREATE TABLE IF NOT EXISTS wm_control_account_remediation_rows (
          gl_entry_id BIGINT PRIMARY KEY,
          setting_key TEXT NOT NULL,
          voucher_type TEXT NOT NULL,
          voucher_id BIGINT,
          voucher_no TEXT,
          posting_date DATE NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          source_table TEXT NOT NULL,
          source_row_id BIGINT NOT NULL,
          journal_id BIGINT,
          source_class TEXT NOT NULL,
          old_account_id BIGINT NOT NULL,
          new_account_id BIGINT NOT NULL,
          applied_at TIMESTAMPTZ,
          batch_no INTEGER
        )`);
      await setup.query(`
        INSERT INTO wm_control_account_remediation_rows
          (gl_entry_id, setting_key, voucher_type, voucher_id, voucher_no,
           posting_date, amount, source_table, source_row_id, journal_id,
           source_class, old_account_id, new_account_id)
        SELECT gl_entry_id, setting_key, voucher_type, voucher_id, voucher_no,
          posting_date, amount, source_table, source_row_id, journal_id,
          source_class, old_account_id,
          CASE setting_key
            WHEN 'accounts_receivable' THEN $1::bigint
            WHEN 'accounts_payable' THEN $2::bigint
          END
        FROM (${targetsSql}) target
        ON CONFLICT (gl_entry_id) DO NOTHING`,
      [accountIds.accounts_receivable, accountIds.accounts_payable]);
    }
    candidates = (await setup.query(`
      SELECT setting_key, source_class, count(*)::int AS entries,
        COALESCE(sum(amount), 0)::numeric(20,2) AS balance
      FROM wm_control_account_remediation_rows
      WHERE applied_at IS NULL
      GROUP BY setting_key, source_class
      ORDER BY setting_key, source_class`)).rows;
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }

  console.log(JSON.stringify({
    event: 'control_account_remediation_started',
    database: database.name,
    resumed: resume,
    suspense_accounts: accountIds,
    batch_size: batchSize,
    candidates,
  }));

  let totalSourceRows = 0;
  let totalGlRows = 0;
  let batchNumber = Number((await pool.query(`
    SELECT COALESCE(max(batch_no), 0)::int AS batch
    FROM wm_control_account_remediation_rows`)).rows[0].batch);
  const disabledTriggers = [];
  let derivedRebuilt = false;
  try {
    // These guards are intentionally suspended only for this approved,
    // write-free benchmark remediation. The mapping table is the audit trail,
    // and both derived summary tables are rebuilt from source before the
    // triggers are restored.
    for (const [table, trigger] of [
      ['app_gl_entries', 'wm_gl_owned_gl_update'],
      ['app_gl_entries', 'app_gl_control_party_update'],
      ['app_gl_entries', 'wm_gl_daily_update'],
      ['app_gl_entries', 'app_record_audit'],
      ['app_gl_entries', 'wm_inventory_gl_guard'],
      ['app_gl_entries', 'wm_no_future_posting'],
      ['app_journal_entry_lines', 'app_record_audit'],
      ['wm_gl_owned_entries', 'wm_gl_owned_daily_update'],
    ]) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      disabledTriggers.push([table, trigger]);
    }
    while (true) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: batch } = await client.query(`
        SELECT gl_entry_id, setting_key, source_row_id, amount
        FROM wm_control_account_remediation_rows
        WHERE applied_at IS NULL
        ORDER BY gl_entry_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`, [batchSize]);
        if (!batch.length) {
          await client.query('COMMIT');
          break;
        }
        const glIds = batch.map((row) => row.gl_entry_id);
        const sourceIds = batch.filter((row) => row.setting_key === 'accounts_receivable')
          .map((row) => row.source_row_id);
        const expectedAmount = batch.reduce((sum, row) => sum + Number(row.amount), 0);
        const sourceResult = sourceIds.length
          ? await client.query(`
          UPDATE app_journal_entry_lines line
          SET account_id = compensation.new_account_id,
            updated_by = 'System control-account remediation',
            updated_by_user_id = NULL,
            updated_at = now()
          FROM wm_control_account_remediation_rows compensation
          WHERE compensation.setting_key = 'accounts_receivable'
            AND compensation.source_row_id = line.id
            AND compensation.gl_entry_id = ANY($1::bigint[])
            AND compensation.applied_at IS NULL
            AND line.account_id = compensation.old_account_id`,
          [glIds])
          : { rowCount: 0 };
        const glResult = await client.query(`
        UPDATE app_gl_entries entry
        SET account_id = compensation.new_account_id,
          updated_by = 'System control-account remediation',
          updated_by_user_id = NULL,
          updated_at = now()
        FROM wm_control_account_remediation_rows compensation
        WHERE entry.id = compensation.gl_entry_id
          AND compensation.gl_entry_id = ANY($1::bigint[])
          AND compensation.applied_at IS NULL
          AND entry.account_id = compensation.old_account_id
          AND COALESCE(entry.party_type, '') = ''
          AND COALESCE(entry.party_id, '') = ''`,
        [glIds]);
        const ownedResult = await client.query(`
        UPDATE wm_gl_owned_entries owned
        SET account_id = compensation.new_account_id
        FROM wm_control_account_remediation_rows compensation
        WHERE owned.id = compensation.gl_entry_id
          AND compensation.gl_entry_id = ANY($1::bigint[])
          AND compensation.applied_at IS NULL
          AND owned.account_id = compensation.old_account_id`,
        [glIds]);
        if (sourceResult.rowCount !== sourceIds.length || glResult.rowCount !== batch.length
            || ownedResult.rowCount !== batch.length) {
          throw new Error(`Batch ${batchNumber + 1} updated ${sourceResult.rowCount}/${sourceIds.length} source rows, ${glResult.rowCount}/${batch.length} GL rows and ${ownedResult.rowCount}/${batch.length} owned rows.`);
        }
        batchNumber++;
        await client.query(`
        UPDATE wm_control_account_remediation_rows
        SET applied_at = now(), batch_no = $2
        WHERE applied_at IS NULL AND gl_entry_id = ANY($1::bigint[])`,
        [glIds, batchNumber]);
        await client.query('COMMIT');
        totalSourceRows += sourceResult.rowCount;
        totalGlRows += glResult.rowCount;
        console.log(JSON.stringify({
          event: 'control_account_remediation_batch',
          batch: batchNumber,
          gl_rows: glResult.rowCount,
          source_rows: sourceResult.rowCount,
          balance: expectedAmount,
        }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await rebuildDerivedSummaries(pool, accountIds);
    derivedRebuilt = true;
  } finally {
    if (!derivedRebuilt) {
      await rebuildDerivedSummaries(pool, accountIds);
    }
    for (const [table, trigger] of disabledTriggers) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }

  const { rows: [remaining] } = await pool.query(`
    SELECT count(*)::int AS entries,
      COALESCE(sum(amount), 0)::numeric(20,2) AS balance
    FROM wm_control_account_remediation_rows
    WHERE applied_at IS NULL`);
  if (remaining.entries !== 0) throw new Error(`${remaining.entries} mapped rows remain unmatched.`);
  console.log(JSON.stringify({
    event: 'control_account_remediation_complete',
    database: database.name,
    batches: batchNumber,
    source_rows: totalSourceRows,
    gl_rows: totalGlRows,
    suspense_accounts: accountIds,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'control_account_remediation_failed',
    error: error.message,
  }));
  process.exitCode = 1;
}).finally(async () => {
  try { await closeStore(); } catch { /* process is exiting */ }
});
