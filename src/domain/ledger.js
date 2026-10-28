'use strict';
// Ledger domain: chart of accounts, journal entries, general ledger, trial
// balance, profit & loss, balance sheet and accounting backfill.
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { canSummarizeGl } = require('../gl-daily');
const { canSummarizeOwnedGl } = require('../gl-owned');
const { runHeavyReport, runExpensiveRead } = require('../workload-control');
const { shareRead, readSnapshot } = require('../read-cache');
const { journalSearchSql, textOnlyPattern } = require('./search-sql');
const { JOURNAL_TYPES, DEFAULT_ACCOUNTS } = require('../constants');
const { normalizePostingTime, storedPostingTime } = require('../posting-time');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult, paginationWindow } = require('../lib/pagination');
const { postSalesInvoiceGlEntry, createOrUpdatePaymentJournalEntry, postStockEntryGlEntry, postGlEntry, reverseVoucherGlEntries, syncGeneratedJournalEntryLines, resolveAccountingAccounts, setVoucherDocstatus, nonZeroAccountingLines, actorAuditValues, addReportFilters, reportFilterValues } = require('./posting');
const { normalizeJournalEntryPayload, validateJournalAccountSides, normalizeAccountingAccountPayload, journalTypeLabel, formatTrialBalanceRow } = require('./normalization');
const { validateCostCenter } = require('../cost-centers');
const { validatePurchaseAllocations, postPurchaseAllocations, cancelPurchaseAllocations } = require('../journal-purchase-allocations');
const { addVoucherOwnerFilter } = require('../voucher-ownership');
const { reportMoney, subtractMoney, sumMoney, minor } = require('../lib/financial-money');

async function accountingAccounts(options = {}) {
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedAccounts)) {
    params.push(options.allowedAccounts);
    where.push(`id::text = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedAccounts) && options.deniedAccounts.length) {
    params.push(options.deniedAccounts);
    where.push(`id::text <> ALL($${params.length}::text[])`);
  }
  const { rows } = await getPostgresPool().query(`
    SELECT id, account_code, account_name, account_type, account_detail_type, normal_balance, is_group, is_active
    FROM app_accounts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY account_code, account_name
  `, params);
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
  }));
}

async function postableAccountingAccounts(options = {}) {
  return (await accountingAccounts(options))
    .filter((account) => account.is_active && !account.is_group);
}

async function receivingAccounts(options = {}) {
  return (await postableAccountingAccounts(options))
    .filter((account) => account.account_type === 'asset'
      && ['Cash', 'Bank'].includes(account.account_detail_type));
}

async function validateReceivingAccount(client, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Choose a cash or bank account.'); error.status = 400; throw error;
  }
  const { rows } = await client.query(`
    SELECT id, account_name, account_detail_type FROM app_accounts
    WHERE id = $1 AND account_type = 'asset' AND account_detail_type IN ('Cash', 'Bank')
      AND is_active = true AND is_group = false
  `, [id]);
  if (!rows[0]) { const error = new Error('Choose an active cash or bank account.'); error.status = 400; throw error; }
  return { id, method: rows[0].account_detail_type.toLowerCase(), account_name: rows[0].account_name };
}

async function findAccountingAccount(id) {
  const accountId = Number(id);
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    const err = new Error('Account not found.');
    err.status = 404;
    throw err;
  }
  const { rows } = await getPostgresPool().query(
    'SELECT id, account_code, account_name, account_type, account_detail_type, normal_balance, is_group, is_active FROM app_accounts WHERE id = $1',
    [accountId],
  );
  if (!rows.length) {
    const err = new Error('Account not found.');
    err.status = 404;
    throw err;
  }
  return { ...rows[0], id: Number(rows[0].id) };
}

async function createAccountingAccount(payload) {
  const account = normalizeAccountingAccountPayload(payload);
  const { rows } = await getPostgresPool().query(
    `
    INSERT INTO app_accounts (
      account_code, account_name, account_type, account_detail_type, normal_balance, is_group, is_active
    )
    VALUES ($1, $2, $3, $4, $5, false, true)
    RETURNING id
    `,
    [account.account_code, account.account_name, account.account_type,
      account.account_detail_type, account.normal_balance],
  );
  return Number(rows[0].id);
}

async function updateAccountingAccount(id, payload) {
  const existing = await findAccountingAccount(id);
  const account = normalizeAccountingAccountPayload(payload);
  if (!['0', '1'].includes(String(payload.is_active))) {
    const err = new Error('Choose a valid account status.');
    err.status = 400;
    throw err;
  }
  const { rows } = await getPostgresPool().query(
    `UPDATE app_accounts
     SET account_code = $2, account_name = $3, account_type = $4,
         account_detail_type = $5, normal_balance = $6, is_active = $7, updated_at = now()
     WHERE id = $1 RETURNING id`,
    [existing.id, account.account_code, account.account_name, account.account_type,
      account.account_detail_type, account.normal_balance, String(payload.is_active) === '1'],
  );
  return Number(rows[0].id);
}

async function journalEntries(options = {}) {
  const includeTotal = options.includeTotal !== false;
  const pool = options.pool || getPostgresPool();
  const pagination = paginationOptions(typeof options === 'number' ? { limit: options } : options, 50, 200);
  const limit = pagination.limit;
  const search = typeof options === 'object'
    ? String(options.search || '').trim().toLowerCase()
    : '';
  const journalType = typeof options === 'object' ? String(options.journal_type || '').trim() : '';
  const status = typeof options === 'object' ? String(options.status || '').trim() : '';
  const params = [];
  const where = [];
  addVoucherOwnerFilter(where, params, 'app_journal_entries', options.ownerId);
  const restrictedAccounts = [];
  if (Array.isArray(options.allowedAccounts)) {
    params.push(options.allowedAccounts.map(String));
    restrictedAccounts.push(`restricted.account_id::text <> ALL($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedAccounts) && options.deniedAccounts.length) {
    params.push(options.deniedAccounts.map(String));
    restrictedAccounts.push(`restricted.account_id::text = ANY($${params.length}::text[])`);
  }
  if (restrictedAccounts.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM app_journal_entry_lines restricted
      WHERE restricted.journal_entry_id = app_journal_entries.id
        AND (${restrictedAccounts.join(' OR ')}))`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(COALESCE(journal_no, '')) LIKE $${params.length}
      OR LOWER(journal_type) LIKE $${params.length}
      OR LOWER(CASE
        WHEN journal_type = 'cash_receipt' THEN 'Cash Receipt'
        WHEN journal_type = 'payment_journal' THEN 'Payment Journal'
        WHEN journal_type = 'sales_invoice' THEN 'Sales Invoice'
        ELSE 'Journal Entry'
      END) LIKE $${params.length}
      OR posting_date::text LIKE $${params.length}
      OR LOWER(COALESCE(party_type, '')) LIKE $${params.length}
      OR LOWER(COALESCE(party_id, '')) LIKE $${params.length}
      OR LOWER(COALESCE(party_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(reference_no, '')) LIKE $${params.length}
      OR EXISTS (SELECT 1 FROM app_journal_entry_lines reference_line
        WHERE reference_line.journal_entry_id=app_journal_entries.id
          AND LOWER(reference_line.reference_no) LIKE $${params.length})
      OR LOWER(COALESCE(remarks, '')) LIKE $${params.length}
      OR LOWER(COALESCE(docstatus, 'submitted')) LIKE $${params.length}
      OR total_debit::text LIKE $${params.length}
      OR total_credit::text LIKE $${params.length}
    )`);
  }
  if (search && textOnlyPattern(sqlLikePattern(search))) {
    params.push(`%${sqlLikePattern(search)}%`);
    where.push(`(${journalSearchSql('app_journal_entries')} LIKE $${params.length}
      OR EXISTS (SELECT 1 FROM app_journal_entry_lines reference_line
        WHERE reference_line.journal_entry_id=app_journal_entries.id
          AND LOWER(reference_line.reference_no) LIKE $${params.length - 1}))`);
  }
  if (journalType) {
    params.push(journalType);
    where.push(`journal_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`COALESCE(docstatus, 'submitted') = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return shareRead(pool, ['journals', whereSql, [...params], pagination.limit, pagination.offset, includeTotal], () => runExpensiveRead(async () => {
  const countResult = includeTotal ? await pool.query(
    `SELECT COUNT(*)::int AS total FROM app_journal_entries ${whereSql}`,
    params,
  ) : null;
  params.push(Number(limit) + (includeTotal ? 0 : 1), pagination.offset);
  const { rows } = await pool.query(
    `
    SELECT
      id, journal_no, COALESCE(docstatus, 'submitted') AS docstatus,
      journal_type, posting_date::text, posting_time::text, party_type, party_id,
      party_name, reference_no, remarks, cost_center, total_debit::float, total_credit::float,
      created_at
    FROM app_journal_entries
    ${whereSql}
    ORDER BY app_journal_entries.posting_date DESC, id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  const journals = rows.slice(0, pagination.limit).map((row) => ({
    ...row,
    id: Number(row.id),
    posting_time: storedPostingTime(row.posting_time),
    created_at: toIsoString(row.created_at),
  }));
  const missingReferences = journals.filter((journal) => !String(journal.reference_no || '').trim());
  if (missingReferences.length) {
    const references = await pool.query(`SELECT journal_entry_id,
      string_agg(DISTINCT BTRIM(reference_no), ', ' ORDER BY BTRIM(reference_no)) AS source_references
      FROM app_journal_entry_lines WHERE journal_entry_id=ANY($1::bigint[])
        AND NULLIF(BTRIM(reference_no), '') IS NOT NULL GROUP BY journal_entry_id`,
    [missingReferences.map((journal) => journal.id)]);
    const byId = new Map(references.rows.map((row) => [Number(row.journal_entry_id), row.source_references]));
    for (const journal of missingReferences) journal.source_references = byId.get(journal.id) || '';
  }
  journals.pagination = includeTotal ? paginationResult(Number(countResult.rows[0].total || 0), pagination) : paginationWindow(rows.length, pagination);
  return journals;
  }), {scope:'journals'});
}

async function findJournalEntry(id) {
  const journalId = Number(id);
  if (!Number.isFinite(journalId)) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      id, journal_no, COALESCE(docstatus, 'submitted') AS docstatus,
      journal_type, posting_date::text, posting_time::text, party_type, party_id,
      party_name, reference_no, cost_center, remarks, total_debit::float, total_credit::float,
      created_at, created_by, created_by_user_id, updated_by, updated_by_user_id, updated_at,
      submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at,
      (EXISTS (SELECT 1 FROM app_invoice_payments payment
        WHERE payment.journal_entry_id = journal.id) OR EXISTS (SELECT 1 FROM app_purchase_payments payment
        WHERE payment.journal_entry_id = journal.id AND payment.method <> 'journal')) AS linked_payment
    FROM app_journal_entries journal
    WHERE journal.id = $1
    `,
    [journalId],
  );
  const journal = rows[0];
  if (!journal) {
    return null;
  }
  const { rows: lines } = await getPostgresPool().query(
    `
    SELECT
      line.id, line.line_no, line.created_by, line.created_by_user_id, line.created_at,
      line.updated_by, line.updated_by_user_id, line.updated_at,
      line.account_id, account.account_code,
      account.account_name, line.debit::float, line.credit::float, line.remarks, line.reference_no
    FROM app_journal_entry_lines line
    INNER JOIN app_accounts account ON account.id = line.account_id
    WHERE line.journal_entry_id = $1
    ORDER BY line.line_no
    `,
    [journalId],
  );
  return {
    ...journal,
    id: Number(journal.id),
    posting_time: storedPostingTime(journal.posting_time),
    can_cancel: isManualJournalType(journal.journal_type, journal.linked_payment),
    created_at: toIsoString(journal.created_at),
    lines: lines.map((line) => ({ ...line, id: Number(line.id), account_id: Number(line.account_id) })),
  };
}

async function createJournalEntry(payload, options = {}) {
  const journal = normalizeJournalEntryPayload(payload);
  const submit = options.submit !== false;
  return withPostgresTransaction(async (client) => {
    journal.cost_center = await validateCostCenter(client, journal.cost_center);
    const allocations = journal.party_type === 'supplier' ? await validatePurchaseAllocations(client, journal) : [];
    if (submit || journal.lines.some((line) => line.reference_no)) await validateJournalInvoicePayment(client, journal);
    const { rows } = await client.query(
      `
      INSERT INTO app_journal_entries (
        journal_type, posting_date, party_type, party_id, party_name, reference_no,
        remarks, total_debit, total_credit, docstatus, posting_time, cost_center
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
      `,
      [
        journal.journal_type,
        journal.posting_date,
        journal.party_type,
        journal.party_id,
        journal.party_name,
        journal.reference_no,
        journal.remarks,
        journal.total_debit,
        journal.total_credit,
        submit ? 'submitted' : 'draft',
        journal.posting_time,
        journal.cost_center,
      ],
    );
    const id = Number(rows[0].id);
    const journalNo = `JRN-${String(id).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
      [journalNo, id],
    );
    if (submit) {
      await setVoucherDocstatus(client, 'app_journal_entries', id, 'submitted');
    }
    for (const line of journal.lines) {
      await client.query(
        `
        INSERT INTO app_journal_entry_lines (
          journal_entry_id, line_no, account_id, debit, credit, remarks, reference_no
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [id, line.line_no, line.account_id, line.debit, line.credit, line.remarks, line.reference_no],
      );
    }
    if (submit) await postGlEntry(client, {
      posting_date: journal.posting_date,
      cost_center: journal.cost_center,
      voucher_type: journal.journal_type,
      voucher_id: id,
      voucher_no: journalNo,
      party_type: journal.party_type,
      party_id: journal.party_id,
      party_name: journal.party_name,
      remarks: journal.remarks || journal.reference_no || journalTypeLabel(journal.journal_type),
      lines: journal.lines.map((line) => ({
        account_id: line.account_id,
        debit: line.debit,
        credit: line.credit,
        remarks: line.remarks,
      })),
    });
    if (submit) await postPurchaseAllocations(client, { ...journal, id, journal_no: journalNo }, allocations);
    return id;
  });
}

async function updateJournalEntry(id, payload) {
  const journal = normalizeJournalEntryPayload(payload);
  return withPostgresTransaction(async (client) => {
    journal.cost_center = await validateCostCenter(client, journal.cost_center);
    const existing = await client.query('SELECT docstatus FROM app_journal_entries WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows[0]) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (existing.rows[0].docstatus !== 'draft') {
      const error = new Error('Only draft journals can be edited.'); error.status = 400; throw error;
    }
    if (journal.party_type === 'supplier') await validatePurchaseAllocations(client, journal);
    if (journal.lines.some((line) => line.reference_no)) await validateJournalInvoicePayment(client, journal);
    await client.query(`UPDATE app_journal_entries SET journal_type = $2, posting_date = $3, party_type = $4,
      party_id = $5, party_name = $6, reference_no = $7, remarks = $8, total_debit = $9, total_credit = $10,
      posting_time = $11, cost_center = $12
      WHERE id = $1`, [id, journal.journal_type, journal.posting_date, journal.party_type, journal.party_id,
      journal.party_name, journal.reference_no, journal.remarks, journal.total_debit, journal.total_credit,
      journal.posting_time, journal.cost_center]);
    await syncJournalEntryLines(client, id, journal.lines);
    return Number(id);
  });
}

async function syncJournalEntryLines(client, journalId, lines) {
  const existingResult = await client.query(
    'SELECT id FROM app_journal_entry_lines WHERE journal_entry_id = $1',
    [journalId],
  );
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.id)));
  const seenIds = new Set();

  // Free the positive line numbers before assigning the new order, so swapping
  // existing rows cannot collide with the journal's unique line-number key.
  await client.query(
    'UPDATE app_journal_entry_lines SET line_no = -line_no WHERE journal_entry_id = $1',
    [journalId],
  );

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dbId = Number(line.id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      await client.query(
        `
        UPDATE app_journal_entry_lines
        SET line_no = $1,
          account_id = $2,
          debit = $3,
          credit = $4,
          remarks = $5, reference_no = $8
        WHERE id = $6
          AND journal_entry_id = $7
        `,
        [index + 1, line.account_id, line.debit, line.credit, line.remarks, dbId, journalId, line.reference_no],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingIds) {
    if (!seenIds.has(dbId)) {
      await client.query(
        'DELETE FROM app_journal_entry_lines WHERE id = $1 AND journal_entry_id = $2',
        [dbId, journalId],
      );
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dbId = Number(line.id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      continue;
    }
    await client.query(
      `
      INSERT INTO app_journal_entry_lines
        (journal_entry_id, line_no, account_id, debit, credit, remarks, reference_no)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [journalId, index + 1, line.account_id, line.debit, line.credit, line.remarks, line.reference_no],
    );
  }
}

async function submitJournalEntry(id) {
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM app_journal_entries WHERE id = $1 FOR UPDATE', [id]);
    const journal = rows[0];
    if (!journal) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (journal.docstatus !== 'draft') {
      const error = new Error('Only draft journals can be submitted.'); error.status = 400; throw error;
    }
    const lines = (await client.query(`SELECT account_id, debit::float, credit::float, remarks, reference_no
      FROM app_journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_no`, [id])).rows;
    if (lines.length < 2 || roundMoney(lines.reduce((sum, line) => sum + line.debit - line.credit, 0)) !== 0) {
      const error = new Error('Journal debits and credits must balance.'); error.status = 400; throw error;
    }
    validateJournalAccountSides(lines);
    const allocations = journal.party_type === 'supplier' ? await validatePurchaseAllocations(client, { ...journal, lines }) : [];
    await validateJournalInvoicePayment(client, { ...journal, lines });
    await setVoucherDocstatus(client, 'app_journal_entries', Number(id), 'submitted');
    await postGlEntry(client, {
      posting_date: dateOnly(journal.posting_date),
      cost_center: journal.cost_center,
      voucher_type: journal.journal_type,
      voucher_id: Number(id),
      voucher_no: journal.journal_no,
      party_type: journal.party_type,
      party_id: journal.party_id,
      party_name: journal.party_name,
      remarks: journal.remarks || journal.reference_no || journalTypeLabel(journal.journal_type),
      lines,
    });
    await postPurchaseAllocations(client, { ...journal, posting_date: dateOnly(journal.posting_date), lines }, allocations);
    return Number(id);
  });
}

async function validateJournalInvoicePayment(client, journal) {
  const referenced = (journal.lines || []).filter((line) => line.reference_no);
  if (!referenced.length) return validateSingleJournalInvoicePayment(client, journal);
  if (journal.party_type !== 'customer') return;
  if (!['cash_receipt', 'payment_journal', 'journal_entry'].includes(journal.journal_type)) {
    const error = new Error('Use a Cash Receipt, Payment Journal, or Journal Entry for invoice allocations.');
    error.status = 400; throw error;
  }
  const { rows } = await client.query("SELECT account_id FROM app_accounting_settings WHERE setting_key='accounts_receivable'");
  const receivableId = Number(rows[0]?.account_id);
  for (const line of referenced) {
    if (Number(line.account_id) !== receivableId || Number(line.credit) <= 0 || Number(line.debit) > 0) {
      const error = new Error('Sales invoice references belong on credit rows of Accounts Receivable.');
      error.status = 400; throw error;
    }
  }
  for (const reference of [...new Set(referenced.map((line) => line.reference_no))].sort()) {
    const { rows: invoices } = await client.query('SELECT customer_id, invoice_date::text FROM app_invoices WHERE invoice_no=$1 FOR UPDATE', [reference]);
    if (!invoices[0] || invoices[0].customer_id !== journal.party_id || dateOnly(journal.posting_date) < invoices[0].invoice_date) {
      const error = new Error(`Sales invoice ${reference} must belong to the selected customer and cannot be paid before its posting date.`);
      error.status = 400; throw error;
    }
    await validateSingleJournalInvoicePayment(client, { ...journal, reference_no: reference,
      lines: referenced.filter((line) => line.reference_no === reference) });
  }
}

async function validateSingleJournalInvoicePayment(client, journal) {
  if (journal.party_type !== 'customer' || !journal.reference_no
      || !['cash_receipt', 'payment_journal', 'journal_entry'].includes(journal.journal_type)) return;
  const invoiceResult = await client.query(
    `SELECT id, total, customer_id, customer_name, docstatus FROM app_invoices
     WHERE invoice_no = $1 FOR UPDATE`,
    [journal.reference_no],
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice || !(journal.party_id && journal.party_id === invoice.customer_id
      || (!journal.party_id && journal.party_name === invoice.customer_name))) return;
  const accountResult = await client.query(
    "SELECT account_id FROM app_accounting_settings WHERE setting_key = 'accounts_receivable'",
  );
  const receivableId = Number(accountResult.rows[0]?.account_id);
  const credit = roundMoney((journal.lines || []).reduce((sum, line) => (
    Number(line.account_id) === receivableId
      ? sum + Number(line.credit || 0) - Number(line.debit || 0) : sum
  ), 0));
  if (credit <= 0) return;
  if (invoice.docstatus !== 'submitted') {
    const error = new Error('Submit the sales invoice before posting a payment journal.');
    error.status = 400;
    throw error;
  }
  const totalsResult = await client.query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM app_invoice_payments
        WHERE invoice_id = $1 AND docstatus = 'submitted') AS direct_paid,
       (SELECT COALESCE(SUM(amount), 0) FROM (
         SELECT SUM(line.credit - line.debit) AS amount
         FROM app_journal_entries existing
         JOIN app_journal_entry_lines line ON line.journal_entry_id = existing.id
         WHERE COALESCE(NULLIF(line.reference_no, ''), existing.reference_no) = $2 AND existing.docstatus = 'submitted'
           AND existing.party_type = 'customer'
           AND existing.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
           AND (NULLIF(existing.party_id, '') = NULLIF($3, '') OR (COALESCE(existing.party_id, '') = '' AND existing.party_name = $4))
           AND line.account_id = $5
           AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id = existing.id)
         GROUP BY existing.id HAVING SUM(line.credit - line.debit) > 0
       ) payments) AS journal_paid`,
    [invoice.id, journal.reference_no, invoice.customer_id, invoice.customer_name, receivableId],
  );
  const totals = totalsResult.rows[0];
  if (credit > roundMoney(Number(invoice.total) - Number(totals.direct_paid) - Number(totals.journal_paid))) {
    const error = new Error('Payment amount cannot exceed the invoice balance.');
    error.status = 400;
    throw error;
  }
}

async function cancelJournalEntry(id) {
  const journalId = Number(id);
  if (!Number.isFinite(journalId)) {
    const err = new Error('Journal entry not found.');
    err.status = 404;
    throw err;
  }

  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      SELECT *
      FROM app_journal_entries
      WHERE id = $1
      FOR UPDATE
      `,
      [journalId],
    );
    const journal = rows[0];
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    if ((journal.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Only submitted journals can be cancelled.');
      err.status = 400;
      throw err;
    }
    const generatedPurchasePayment = await client.query(
      "SELECT 1 FROM app_purchase_payments WHERE journal_entry_id=$1 AND method <> 'journal' LIMIT 1", [journalId]);
    if (generatedPurchasePayment.rowCount) {
      const error = new Error('Cancel this supplier payment from its purchase invoice.');
      error.status = 400;
      throw error;
    }
    const linkedPayment = await client.query(
      'SELECT 1 FROM app_invoice_payments WHERE journal_entry_id = $1 LIMIT 1',
      [journalId],
    );
    if (!isManualJournalType(journal.journal_type, linkedPayment.rowCount > 0)) {
      const err = new Error('Automatically generated journals cannot be cancelled here.');
      err.status = 400;
      throw err;
    }

    const actor = actorAuditValues();
    await client.query(
      `
      UPDATE app_journal_entries
      SET docstatus = 'cancelled',
          cancelled_by = $1,
          cancelled_by_user_id = $2,
          cancelled_at = $3,
          remarks = COALESCE(NULLIF(remarks, ''), $4)
      WHERE id = $5
      `,
      [actor.by, actor.by_user_id, actor.at, 'Cancelled', journalId],
    );
    await cancelPurchaseAllocations(client, journalId);
    await reverseVoucherGlEntries(client, journal.journal_type, journalId, dateOnly(new Date()));
    return journalId;
  });
}

function isManualJournalType(type, linkedPayment = false) {
  const journalType = String(type || '').trim();
  return ['cash_receipt', 'journal_entry'].includes(journalType)
    || (journalType === 'payment_journal' && !linkedPayment);
}

function addGeneralLedgerAccessFilter(where, params, access = {}, sourcePlan) {
  let hrRule='';
  if(access.hrAccess) {
    const hr=access.hrAccess;const rules=[];
    const source='COALESCE(gl.reversal_of_voucher_id,gl.voucher_id)';
    if(hr.payroll)rules.push("gl.voucher_type IN ('hr_payroll','hr_payroll_cancellation')");
    if(hr.money)rules.push("gl.voucher_type IN ('hr_money','hr_money_cancellation')");
    if(hr.payroll||hr.money)rules.push(`(gl.voucher_type IN ('hr_payment','hr_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_hr_payments hp WHERE hp.id=${source} AND (${hr.payroll?'hp.slip_id IS NOT NULL':'false'} OR ${hr.money?'hp.money_id IS NOT NULL':'false'})))`);
    const restrictions=[];
    for(const [values,column,denial] of [[hr.employees,'gl.party_id',false],[hr.deniedEmployees,'gl.party_id',true],
      [hr.costCenters,'gl.cost_center',false],[hr.deniedCostCenters,'gl.cost_center',true]]) {
      if(rules.length&&Array.isArray(values)&&(!denial||values.length)) {
        params.push(values);
        restrictions.push(column==='gl.cost_center'
          ? `(${column} IS NULL OR ${column} ${denial?'<> ALL':'= ANY'}($${params.length}::text[]))`
          : `${column} ${denial?'<> ALL':'= ANY'}($${params.length}::text[])`);
      }
    }
    hrRule=rules.length?`((${rules.join(' OR ')})${restrictions.length?' AND '+restrictions.join(' AND '):''})`:'false';
    where.push(`(gl.voucher_type NOT LIKE 'hr_%' OR ${hrRule})`);
  }
  const accountRules = [];
  if (Array.isArray(access.allowedAccounts)) {
    params.push(access.allowedAccounts);
    const position = params.length;
    accountRules.push((column) => `${column}::text = ANY($${position}::text[])`);
  }
  if (Array.isArray(access.deniedAccounts) && access.deniedAccounts.length) {
    params.push(access.deniedAccounts);
    const position = params.length;
    accountRules.push((column) => `${column}::text <> ALL($${position}::text[])`);
  }
  if (accountRules.length) where.push(accountRules.map((rule) => rule('gl.account_id')).join(' AND '));

  if (access.ownerId === null || access.ownerId === undefined) return;
  let customerRule = '';
  if (Array.isArray(access.customerGroups)) {
    params.push(access.customerGroups);
    customerRule = `AND EXISTS (SELECT 1 FROM app_master_customers customer
      WHERE customer.customer_id = i.customer_id
        AND LOWER(customer.customer_group) = ANY($${params.length}::text[]))`;
  }
  let supplierRule = '';
  if (Array.isArray(access.supplierTypes)) {
    params.push(access.supplierTypes);
    supplierRule = `AND EXISTS (SELECT 1 FROM app_master_suppliers supplier
      WHERE supplier.supplier_id = purchase.supplier_id
        AND LOWER(supplier.supplier_type) = ANY($${params.length}::text[]))`;
  }
  const partyScopeRestricted = Boolean(customerRule || supplierRule);
  params.push(String(access.ownerId), String(access.ownerEmployeeId || ''));
  const owner = `$${params.length - 1}`;
  const employee = `$${params.length}`;
  const sourceId = 'COALESCE(gl.reversal_of_voucher_id, gl.voucher_id)';
  const invoiceOwner = `(i.created_by_user_id = ${owner} OR i.invoicer_id = ${employee})`;
  const journalAccounts = accountRules.length ? `AND NOT EXISTS (
    SELECT 1 FROM app_journal_entry_lines line
    WHERE line.journal_entry_id = journal.id
      AND NOT (${accountRules.map((rule) => rule('line.account_id')).join(' AND ')})
  )` : '';
  if (sourcePlan) {
    // Distinct typed keys preserve the OR between purchase-payment journals and
    // directly owned journals without duplicating their ledger entries.
    const typed = (types, sql) => `SELECT kind.voucher_type, source.id FROM (${sql}) source
      CROSS JOIN (VALUES ${types.map(type => `('${type}')`).join(',')}) kind(voucher_type)`;
    const sources = [
      typed(['sales_invoice','sales_invoice_cancellation'], `SELECT i.id FROM app_invoices i WHERE ${invoiceOwner} ${customerRule}`),
      typed(['customer_payment','customer_payment_cancellation'], `SELECT payment.id FROM app_invoice_payments payment
        JOIN app_invoices i ON i.id=payment.invoice_id WHERE ${invoiceOwner} ${customerRule}`),
      typed(['inventory_correction'], `SELECT correction.id FROM wm_inventory_corrections correction WHERE correction.prepared_by::text=${owner}`),
      typed(['purchase','purchase_cancellation'], `SELECT purchase.id FROM app_purchases purchase WHERE purchase.created_by_user_id=${owner} ${supplierRule}`),
      typed(['purchase_payment','purchase_payment_cancellation'], `SELECT payment.id FROM app_purchase_payments payment
        JOIN app_purchases purchase ON purchase.id=payment.purchase_id WHERE purchase.created_by_user_id=${owner} ${supplierRule}`),
      typed(['payment_journal','payment_journal_cancellation'], `SELECT payment.journal_entry_id AS id FROM app_purchase_payments payment
        JOIN app_purchases purchase ON purchase.id=payment.purchase_id WHERE payment.method<>'journal'
        AND payment.journal_entry_id IS NOT NULL AND purchase.created_by_user_id=${owner} ${supplierRule}`),
    ];
    if (!partyScopeRestricted) {
      sources.push(typed(['cash_receipt','payment_journal','journal_entry','cash_receipt_cancellation','payment_journal_cancellation','journal_entry_cancellation'],
        `SELECT journal.id FROM app_journal_entries journal WHERE journal.created_by_user_id=${owner} ${journalAccounts}`));
      // Daily metadata retains every posted stock type, including legacy types.
      sources.push(`SELECT kind.voucher_type, stock.id FROM app_stock_entries stock CROSS JOIN
        (SELECT DISTINCT voucher_type FROM wm_gl_daily WHERE voucher_type LIKE 'stock_%') kind
        WHERE stock.created_by_user_id=${owner}`);
    }
    sourcePlan.ctes = `visible_vouchers AS MATERIALIZED (
      ${sources.join('\nUNION\n')}
      ORDER BY 1,2
    ), scoped_gl AS NOT MATERIALIZED (
      SELECT gl.* FROM visible_vouchers visible CROSS JOIN LATERAL (
        SELECT gl.* FROM app_gl_entries gl WHERE gl.voucher_type=visible.voucher_type
          AND gl.voucher_id=visible.id AND gl.reversal_of_voucher_id IS NULL OFFSET 0
      ) gl
      UNION ALL
      SELECT gl.* FROM app_gl_entries gl JOIN visible_vouchers visible
        ON visible.voucher_type=gl.voucher_type AND visible.id=CASE
          WHEN gl.voucher_type='inventory_correction' THEN gl.voucher_id ELSE gl.reversal_of_voucher_id END
        WHERE gl.reversal_of_voucher_id IS NOT NULL
      ${hrRule && hrRule !== 'false' ? `UNION ALL SELECT gl.* FROM app_gl_entries gl WHERE ${hrRule}` : ''}
    )`;
    return;
  }
  where.push(`(
    (gl.voucher_type IN ('sales_invoice', 'sales_invoice_cancellation') AND EXISTS (
      SELECT 1 FROM app_invoices i WHERE i.id = ${sourceId} AND ${invoiceOwner} ${customerRule}))
    OR (gl.voucher_type IN ('customer_payment', 'customer_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_invoice_payments payment
      JOIN app_invoices i ON i.id = payment.invoice_id
      WHERE payment.id = ${sourceId} AND ${invoiceOwner} ${customerRule}))
    OR (gl.voucher_type='inventory_correction' AND EXISTS(SELECT 1 FROM wm_inventory_corrections correction WHERE correction.id=gl.voucher_id AND correction.prepared_by::text=${owner}))
    OR (gl.voucher_type IN ('purchase', 'purchase_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchases purchase
      WHERE purchase.id = ${sourceId} AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    OR (gl.voucher_type IN ('purchase_payment', 'purchase_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchase_payments payment
      JOIN app_purchases purchase ON purchase.id = payment.purchase_id
      WHERE payment.id = ${sourceId} AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    OR (gl.voucher_type IN ('payment_journal', 'payment_journal_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchase_payments payment
      JOIN app_purchases purchase ON purchase.id = payment.purchase_id
      WHERE payment.journal_entry_id = ${sourceId} AND payment.method <> 'journal'
        AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    ${partyScopeRestricted ? '' : `OR (gl.voucher_type IN ('cash_receipt', 'payment_journal', 'journal_entry',
        'cash_receipt_cancellation', 'payment_journal_cancellation', 'journal_entry_cancellation')
      AND EXISTS (SELECT 1 FROM app_journal_entries journal
        WHERE journal.id = ${sourceId} AND journal.created_by_user_id = ${owner} ${journalAccounts}))
    OR (gl.voucher_type LIKE 'stock_%' AND EXISTS (
      SELECT 1 FROM app_stock_entries stock
      WHERE stock.id = ${sourceId} AND stock.created_by_user_id = ${owner}))`}
    ${hrRule ? `OR (${hrRule})` : ''}
  )`);
}

function generalLedgerQuery(filters = {}, access = {}, voucherFirst = false) {
  const params = [];
  const where = [];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  validateReportDates(from, to);
  const account = String(filters.account || '').trim().toLowerCase();
  const party = String(filters.party || '').trim().toLowerCase();
  const voucherType = String(filters.voucher_type || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  const voucherId = String(filters.voucher_id || '').trim();
  if (voucherId && (!/^[1-9]\d*$/.test(voucherId) || !Number.isSafeInteger(Number(voucherId)) || !voucherType)) { const error=new Error('Choose a valid voucher.'); error.status=400; throw error; }

  const sourcePlan = voucherFirst && !voucherId ? {} : null;
  addGeneralLedgerAccessFilter(where, params, access, sourcePlan);

  if (from) {
    params.push(from);
    where.push(`gl.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`gl.posting_date <= $${params.length}`);
  }
  if (account) {
    params.push(sqlLikePattern(account));
    where.push(`(
      LOWER(account.account_code) LIKE $${params.length}
      OR LOWER(account.account_name) LIKE $${params.length}
      OR LOWER(account.account_code || ' - ' || account.account_name) LIKE $${params.length}
    )`);
  }
  if (party) {
    params.push(sqlLikePattern(party));
    const position = params.length;
    if (filters.party_scope === 'related') {
      const accessible = [];
      addGeneralLedgerAccessFilter(accessible, params, access);
      where.push(`EXISTS (SELECT 1 FROM app_gl_entries matched
        WHERE matched.voucher_type=gl.voucher_type AND matched.voucher_id=gl.voucher_id
        AND (LOWER(COALESCE(matched.party_id,'')) LIKE $${position}
          OR LOWER(COALESCE(matched.party_name,'')) LIKE $${position})
        ${accessible.length ? 'AND ' + accessible.join(' AND ').replace(/\bgl\./g,'matched.') : ''})`);
    } else {
      where.push(`(LOWER(COALESCE(gl.party_id,'')) LIKE $${position}
        OR LOWER(COALESCE(gl.party_name,'')) LIKE $${position})`);
    }
  }
  if (voucherType) {
    params.push(voucherType);
    where.push(`gl.voucher_type = $${params.length}`);
  }
  if (voucherId) { params.push(voucherId); where.push(`gl.voucher_id = $${params.length}::bigint`); }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(COALESCE(gl.posting_date::text, '')) LIKE $${params.length}
      OR LOWER(account.account_code) LIKE $${params.length}
      OR LOWER(account.account_name) LIKE $${params.length}
      OR LOWER(account.account_type) LIKE $${params.length}
      OR LOWER(COALESCE(gl.party_type, '')) LIKE $${params.length}
      OR LOWER(COALESCE(gl.party_id, '')) LIKE $${params.length}
      OR LOWER(COALESCE(gl.party_name, '')) LIKE $${params.length}
      OR LOWER(gl.voucher_type) LIKE $${params.length}
      OR LOWER(COALESCE(gl.voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(gl.remarks, '')) LIKE $${params.length}
      OR gl.debit::text LIKE $${params.length}
      OR gl.credit::text LIKE $${params.length}
      OR (gl.debit - gl.credit)::text LIKE $${params.length}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const extraFilters = {};
  if (['related','lines'].includes(filters.party_scope)) extraFilters.party_scope = filters.party_scope;
  if (filters.group_by === 'account') extraFilters.group_by = 'account';
  if (voucherId) extraFilters.voucher_id = voucherId;
  return { params, whereSql, ownerCtes: sourcePlan?.ctes, filters: {
    ...extraFilters,
    search: String(filters.search || '').trim(), account: String(filters.account || '').trim(),
    party: String(filters.party || '').trim(), voucher_type: voucherType, from, to,
  } };
}

function validateReportDates(from, to) {
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to)) || (from && to && from > to)) {
    const error = new Error('Choose valid report dates with From on or before To.');
    error.status = 400;
    throw error;
  }
}

// Keep pre-period history in balances while limiting displayed transactions.
function generalLedgerHistory(whereSql) {
  const from = whereSql.match(/gl\.posting_date >= (\$\d+)/);
  return { from: from?.[1], whereSql: from ? whereSql.replace(from[0], 'true') : whereSql };
}

// One grouped scan calculates opening history and period totals. Keep sums numeric
// inside PostgreSQL until the final projection, including totals across accounts.
function generalLedgerOverviewSql(query, useDaily, sourceOverride, sourceFiltered = Boolean(sourceOverride)) {
  const history = generalLedgerHistory(query.whereSql);
  const before = history.from ? `gl.posting_date < ${history.from}::date` : 'false';
  const period = history.from ? `gl.posting_date >= ${history.from}::date` : 'true';
  return `WITH ${query.ownedCtes ? query.ownedCtes+',' : !sourceOverride && query.ownerCtes ? query.ownerCtes + ',' : ''} account_totals AS (
    SELECT account.id, account.account_code, account.account_name,
      COALESCE(SUM(gl.debit-gl.credit) FILTER (WHERE ${before}),0) AS opening,
      COALESCE(SUM(${useDaily ? 'gl.entry_count' : '1'}) FILTER (WHERE ${period}),0) AS period_count,
      COALESCE(SUM(gl.debit) FILTER (WHERE ${period}),0) AS period_debit,
      COALESCE(SUM(gl.credit) FILTER (WHERE ${period}),0) AS period_credit
    FROM ${sourceOverride || (query.ownerCtes ? 'scoped_gl' : useDaily ? '(SELECT *,NULL::bigint AS reversal_of_voucher_id FROM wm_gl_daily)' : 'app_gl_entries')} gl
    JOIN app_accounts account ON account.id=gl.account_id ${sourceFiltered ? '' : history.whereSql}
    GROUP BY account.id,account.account_code,account.account_name
  ) SELECT account_code,account_name,opening::float AS running_balance,
    SUM(period_count) OVER ()::int AS total,
    SUM(period_debit) OVER ()::float AS debit,
    SUM(period_credit) OVER ()::float AS credit
    FROM account_totals ORDER BY account_code,id`;
}

function generalLedgerOverviewRows(rows) {
  return {
    totals: rows.length ? { total: rows[0].total, debit: rows[0].debit, credit: rows[0].credit }
      : { total: 0, debit: 0, credit: 0 },
    openingRows: rows.map(({ account_code, account_name, running_balance }) =>
      ({ account_code, account_name, running_balance })),
  };
}

async function generalLedgerOverview(client, query, useDaily) {
  const { rows } = await client.query(generalLedgerOverviewSql(query, useDaily), query.params);
  return generalLedgerOverviewRows(rows);
}

async function scopedGeneralLedgerPage(client, query, params, grouped) {
  const history=generalLedgerHistory(query.whereSql);
  const { rows }=await client.query(`WITH ${query.ownerCtes}, page_history AS MATERIALIZED (
    SELECT gl.id,gl.account_id,gl.posting_date,gl.debit,gl.credit
    FROM scoped_gl gl JOIN app_accounts account ON account.id=gl.account_id ${history.whereSql}
  ) SELECT
    (SELECT COALESCE(jsonb_agg(overview),'[]'::jsonb) FROM (
      ${generalLedgerOverviewSql(query,false,'page_history')}
    ) overview) AS overview,
    (SELECT COALESCE(jsonb_agg(detail ORDER BY ${grouped ? 'detail.account_code,' : ''}detail.posting_date,detail.id::bigint),'[]'::jsonb) FROM (
      ${generalLedgerPageSql(query.whereSql,params.length-1,params.length,false,grouped,query.ownerCtes,true)}
    ) detail) AS entries`,params);
  return {...generalLedgerOverviewRows(rows[0].overview),rows:rows[0].entries};
}

async function generalLedgerReviewDetails(client, filters, access, query) {
  const details = {};
  if (filters.group_by === 'account') {
    const history = generalLedgerHistory(query.whereSql);
    const before = history.from ? `gl.posting_date < ${history.from}::date` : 'false';
    const period = history.from ? `gl.posting_date >= ${history.from}::date` : 'true';
    const source = query.ownerCtes ? 'scoped_gl' : canSummarizeGl(filters,access) ? '(SELECT *,NULL::bigint AS reversal_of_voucher_id FROM wm_gl_daily)' : 'app_gl_entries';
    details.account_summaries = (await client.query(`${query.ownerCtes ? 'WITH ' + query.ownerCtes : ''} SELECT account.account_code,account.account_name,
      COALESCE(SUM(gl.debit-gl.credit) FILTER (WHERE ${before}),0)::float opening_balance,
      COALESCE(SUM(gl.debit) FILTER (WHERE ${period}),0)::float debit,
      COALESCE(SUM(gl.credit) FILTER (WHERE ${period}),0)::float credit,
      SUM(gl.debit-gl.credit)::float closing_balance
      FROM ${source} gl JOIN app_accounts account ON account.id=gl.account_id ${history.whereSql}
      GROUP BY account.id,account.account_code,account.account_name ORDER BY account.account_code,account.id`,query.params)).rows;
  }
  if (String(filters.party || '').trim()) {
    const partyQuery=generalLedgerQuery({party:filters.party,to:filters.to},access);
    const balances=(await client.query(`SELECT gl.party_type,gl.party_id,MAX(gl.party_name) party_name,
      SUM(CASE WHEN gl.party_type='supplier' THEN gl.credit-gl.debit ELSE gl.debit-gl.credit END)::float balance
      FROM app_gl_entries gl JOIN app_accounts account ON account.id=gl.account_id
      ${partyQuery.whereSql} AND (
        (gl.party_type='customer' AND (LOWER(account.account_detail_type)='receivable' OR LOWER(account.account_name)='accounts receivable'))
        OR (gl.party_type='supplier' AND (LOWER(account.account_detail_type)='payable' OR LOWER(account.account_name)='accounts payable')))
      GROUP BY gl.party_type,gl.party_id ORDER BY gl.party_type,gl.party_id`,partyQuery.params)).rows;
    const forParty=(type)=>balances.filter(row=>row.party_type===type)
      .map(({party_id,party_name,balance})=>({party_id,party_name,balance}));
    details.customer_balances=forParty('customer');
    details.supplier_balances=forParty('supplier');
  }
  if (filters.voucher_id && ['cash_receipt','payment_journal','journal_entry'].includes(String(filters.voucher_type||'').replace(/_cancellation$/,''))) {
    // Only source lines already visible through the ledger are eligible.
    details.allocations=(await client.query(`${query.ownerCtes ? 'WITH ' + query.ownerCtes : ''} SELECT account.account_code,account.account_name,
      COALESCE(NULLIF(line.reference_no,''),journal.reference_no) reference_no,
      line.debit::float debit,line.credit::float credit
      FROM ${query.ownerCtes ? 'scoped_gl' : 'app_gl_entries'} gl JOIN app_accounts account ON account.id=gl.account_id
      JOIN app_journal_entries journal ON journal.id=COALESCE(gl.reversal_of_voucher_id,gl.voucher_id)
      JOIN app_journal_entry_lines line ON line.journal_entry_id=journal.id AND line.line_no=gl.line_no
      ${query.whereSql} AND (LOWER(account.account_detail_type) IN ('receivable','payable')
        OR LOWER(account.account_name) IN ('accounts receivable','accounts payable'))
      AND COALESCE(NULLIF(line.reference_no,''),NULLIF(journal.reference_no,'')) IS NOT NULL
      ORDER BY line.line_no`,query.params)).rows;
  }
  return details;
}

function generalLedgerSummary(totals, openingRows) {
  const opening = openingRows.reduce((sum, row) => sum + Number(row.running_balance || 0), 0);
  return { debit: roundMoney(totals.debit), credit: roundMoney(totals.credit),
    balance: roundMoney(opening + Number(totals.debit) - Number(totals.credit)) };
}

async function generalLedgerReport(filters = {}, access = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  // An explicit account already narrows the account/date index efficiently;
  // building all permitted voucher keys would add work to that selective path.
  const voucherFirst = !access.exportAll && !String(filters.account || '').trim();
  const owned = canSummarizeOwnedGl(filters, access);
  const query = generalLedgerQuery(filters, owned ? {...access, ownerId:null} : access, voucherFirst);
  if (owned) {
    query.params.push(String(access.ownerId),String(access.ownerEmployeeId || ''));
    // Resolve a small set of exact signatures once. Equality on the complete
    // signature uses covering B-tree ranges instead of scattered GIN heap reads.
    query.ownedCtes=`owned_scopes AS MATERIALIZED (
      SELECT * FROM wm_gl_owned_scopes WHERE owner_ids @> ARRAY[$${query.params.length-1}]::text[]
        OR employee_ids @> ARRAY[$${query.params.length}]::text[]
    ), owned_daily AS MATERIALIZED (
      SELECT gl.* FROM owned_scopes scope CROSS JOIN LATERAL (
        SELECT gl.account_id,gl.posting_date,gl.voucher_type,gl.entry_count,gl.debit,gl.credit
        FROM wm_gl_owned_daily gl JOIN app_accounts account ON account.id=gl.account_id
        ${query.whereSql ? generalLedgerHistory(query.whereSql).whereSql+' AND' : 'WHERE'}
          gl.owner_ids=scope.owner_ids AND gl.employee_ids=scope.employee_ids AND gl.entry_count>0 OFFSET 0
      ) gl
    ), owned_entries AS MATERIALIZED (
      SELECT gl.* FROM owned_scopes scope CROSS JOIN LATERAL (
        SELECT gl.id,gl.account_id,gl.posting_date,gl.voucher_type,gl.debit,gl.credit
        FROM wm_gl_owned_entries gl JOIN app_accounts account ON account.id=gl.account_id
        ${query.whereSql ? query.whereSql+' AND' : 'WHERE'}
          gl.owner_ids=scope.owner_ids AND gl.employee_ids=scope.employee_ids OFFSET 0
      ) gl
    )`;
  }
  const { params, whereSql } = query;
  const pool = getPostgresPool();
  const load = () => runHeavyReport(() => readSnapshot(pool, async client => {
    const pageParams = [...params, pagination.limit, pagination.offset];
    let summary,openingRows,rows;
    if (owned) {
      ({totals:summary,openingRows}=generalLedgerOverviewRows((await client.query(
        generalLedgerOverviewSql(query,true,'owned_daily',true),params)).rows));
      ({rows}=await client.query(generalLedgerPageSql(whereSql,pageParams.length-1,pageParams.length,
        true,false,'',false,query.ownedCtes),pageParams));
    } else if(query.ownerCtes&&!access.exportAll) {
      const result=await scopedGeneralLedgerPage(client,query,pageParams,filters.group_by==='account');
      summary=result.totals;openingRows=result.openingRows;rows=result.rows;
    } else {
      ({totals:summary,openingRows}=await generalLedgerOverview(client,query,canSummarizeGl(filters,access)));
      ({rows}=await client.query(access.exportAll ? generalLedgerRowsSql(whereSql, false, filters.group_by === 'account')
        : generalLedgerPageSql(whereSql, pageParams.length - 1, pageParams.length, canSummarizeGl(filters, access), filters.group_by === 'account', query.ownerCtes),
      access.exportAll ? params : pageParams));
    }
    return {
      filters: query.filters, rows,
      ...await generalLedgerReviewDetails(client, filters, access, query),
      opening_rows: openingRows,
      pagination: paginationResult(Number(summary.total), pagination),
      summary: generalLedgerSummary(summary, openingRows),
    };
  }));
  // The SQL and every bound access/filter value form the sharing key. Export
  // readers retain their own snapshot and do not retain large arrays here.
  return access.exportAll ? load() : shareRead(pool,
    ['ledger', whereSql, params, query.filters, pagination.limit, pagination.offset, query.ownerCtes], load);
}

function generalLedgerPageSql(whereSql, limit, offset, useDaily = false, grouped = false, ownerCtes = '', sharedHistory = false, owned = false) {
  const source = owned ? 'owned_entries' : ownerCtes ? 'page_history' : 'app_gl_entries';
  const history = generalLedgerHistory(whereSql);
  const historyWhere = history.whereSql;
  const priorWhere = ownerCtes ? 'WHERE' : historyWhere ? historyWhere.replace(/\bgl\./g, 'prior.') + ' AND' : 'WHERE';
  // Reuse only matching permitted history for the page and its earlier balances.
  // Retain pre-From entries, but push To/account/party/access filters into the
  // indexed source before materializing; later reversals need not be gathered.
  const scopedHistory = ownerCtes && !sharedHistory ? `${ownerCtes}, page_history AS MATERIALIZED (
    SELECT gl.id,gl.account_id,gl.posting_date,gl.debit,gl.credit
    FROM scoped_gl gl JOIN app_accounts account ON account.id=gl.account_id
    ${historyWhere}
  ),` : '';
  // Scoped history has already applied every restriction except From. Retain
  // only numeric balance fields there; load narration/party data for the page.
  const pageWhere = ownerCtes ? history.from ? `WHERE gl.posting_date>=${history.from}::date` : '' : whereSql;
  // Disjoint ranges retain all filters and access. OFFSET 0 keeps the same-day
  // date/id range inside its subquery: otherwise the planner can prefer the
  // account/date index and fetch every later same-day entry before filtering IDs.
  const priorBalanceSql = (boundary, source = 'app_gl_entries') => `SELECT SUM(prior.debit-prior.credit) AS balance
    FROM ${source} prior ${ownerCtes ? '' : 'JOIN app_accounts account ON account.id=prior.account_id'}
    ${priorWhere} prior.account_id=b.balance_account_id AND ${boundary}`;
  const openingSql = owned ? `SELECT b.balance_account_id,COALESCE(d.balance,0)+COALESCE((
      SELECT SUM(prior.debit-prior.credit) FROM owned_entries prior
      WHERE prior.account_id=b.balance_account_id AND prior.posting_date=b.balance_posting_date AND prior.id<b.id
    ),0) AS balance FROM bounds b LEFT JOIN (
      SELECT prior.account_id,SUM(prior.debit-prior.credit) AS balance FROM owned_daily prior
      JOIN bounds first ON first.balance_account_id=prior.account_id AND prior.posting_date<first.balance_posting_date
      GROUP BY prior.account_id
    ) d ON d.account_id=b.balance_account_id` : `SELECT b.balance_account_id, COALESCE((
      SELECT SUM(parts.balance) FROM (
        ${priorBalanceSql('prior.posting_date<b.balance_posting_date', useDaily
          ? '(SELECT *,NULL::bigint AS reversal_of_voucher_id FROM wm_gl_daily)' : source)}
        UNION ALL
        ${priorBalanceSql('true', `(SELECT * FROM ${source}
          WHERE posting_date=b.balance_posting_date AND id<b.id OFFSET 0)`)}
      ) parts
    ),0) AS balance FROM bounds b`;
  return `WITH ${owned ? owned+',' : ''}${scopedHistory} page AS MATERIALIZED (
    SELECT gl.id,gl.account_id AS balance_account_id,gl.posting_date AS balance_posting_date,
      gl.debit-gl.credit AS balance_delta
    FROM ${source} gl JOIN app_accounts account ON account.id=gl.account_id ${pageWhere}
    ORDER BY ${grouped ? 'account.account_code, ' : ''}gl.posting_date,gl.id
    LIMIT $${limit} OFFSET $${offset}
  ), bounds AS (
    SELECT DISTINCT ON (balance_account_id) balance_account_id, balance_posting_date, id
    FROM page ORDER BY balance_account_id, balance_posting_date, id
  ), opening AS MATERIALIZED (
    ${openingSql}
  )
  SELECT gl.id::text AS id,gl.posting_date::text,account.account_code,account.account_name,account.account_type,
    gl.party_type,gl.party_id,gl.party_name,gl.voucher_type,gl.voucher_id::text AS voucher_id,
    gl.voucher_no,${generalLedgerVoucherExistsSql(Boolean(ownerCtes), true)} AS voucher_exists,
    gl.debit::float,gl.credit::float,gl.remarks,
    (opening.balance + SUM(page.balance_delta) OVER (
      PARTITION BY page.balance_account_id ORDER BY page.balance_posting_date, page.id
    ))::float AS running_balance
  FROM page JOIN opening ON opening.balance_account_id=page.balance_account_id
  JOIN app_gl_entries gl ON gl.id=page.id JOIN app_accounts account ON account.id=gl.account_id
  ORDER BY ${grouped ? 'account.account_code, ' : ''}page.balance_posting_date, page.id`;
}

function generalLedgerVoucherExistsSql(sourceExists = false, page = false) {
  // OFFSET 0 keeps page probes as indexed lookups. PostgreSQL may otherwise
  // preload every source ID into a hash even when only 50 links are displayed.
  const probe = page ? ' OFFSET 0' : '';
  return `CASE
    ${sourceExists ? 'WHEN gl.reversal_of_voucher_id IS NULL THEN true' : ''}
    WHEN gl.voucher_type='sales_invoice' THEN EXISTS(SELECT 1 FROM app_invoices i WHERE i.id=gl.voucher_id${probe})
    WHEN gl.voucher_type='purchase' THEN EXISTS(SELECT 1 FROM app_purchases p WHERE p.id=gl.voucher_id${probe})
    WHEN gl.voucher_type='purchase_payment' THEN EXISTS(SELECT 1 FROM app_purchase_payments pp WHERE pp.id=gl.voucher_id${probe})
    WHEN gl.voucher_type='customer_payment' THEN EXISTS(SELECT 1 FROM app_invoice_payments ip WHERE ip.id=gl.voucher_id${probe})
    WHEN gl.voucher_type IN ('cash_receipt','payment_journal','journal_entry') THEN EXISTS(SELECT 1 FROM app_journal_entries j WHERE j.id=gl.voucher_id${probe})
    WHEN gl.voucher_type LIKE 'stock_%' THEN EXISTS(SELECT 1 FROM app_stock_entries se WHERE se.id=gl.voucher_id${probe})
    ELSE true END`;
}

function generalLedgerRowsSql(whereSql, page = false, grouped = false, useDaily = false, source = 'app_gl_entries', sourceExists = source === 'scoped_gl', resolveVoucherLinks = true) {
  const history = generalLedgerHistory(whereSql);
  const dailyOpening = !page && history.from && useDaily;
  const wrapPeriod = !page && history.from && !dailyOpening;
  const rowWhere = page || dailyOpening ? whereSql : history.whereSql;
  // Seed the period window with exact numeric daily totals. Both sides retain
  // identical account, voucher and HR restrictions in the export's snapshot.
  const openingSql = dailyOpening ? `WITH opening AS MATERIALIZED (
    SELECT gl.account_id, SUM(gl.debit-gl.credit) AS balance
    FROM (SELECT *,NULL::bigint AS reversal_of_voucher_id FROM wm_gl_daily) gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${history.whereSql} AND gl.posting_date < ${history.from}::date
    GROUP BY gl.account_id
  )` : '';
  const sql = `${openingSql}
    SELECT
      gl.id,
      gl.posting_date::text,
      account.account_code,
      account.account_name,
      account.account_type,
      gl.party_type,
      gl.party_id,
      gl.party_name,
      gl.voucher_type,
      gl.voucher_id,
      gl.voucher_no,
      ${resolveVoucherLinks ? generalLedgerVoucherExistsSql(sourceExists, page) + ' AS voucher_exists,' : ''}
      gl.debit::float,
      gl.credit::float,
      gl.remarks,
      ${page ? `gl.account_id AS balance_account_id, gl.posting_date AS balance_posting_date,
        gl.debit-gl.credit AS balance_delta` : `${dailyOpening ? '(COALESCE(opening.balance,0) + ' : ''}SUM(gl.debit - gl.credit) OVER (
        PARTITION BY gl.account_id ORDER BY gl.posting_date, gl.id
      )${dailyOpening ? ')' : ''}::float AS running_balance`}
    FROM ${source} gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${dailyOpening ? 'LEFT JOIN opening ON opening.account_id = gl.account_id' : ''}
    ${rowWhere}
    ${wrapPeriod ? '' : `ORDER BY ${grouped ? 'account.account_code, ' : ''}gl.posting_date ASC, gl.id ASC`}
`;
  return wrapPeriod
    ? `SELECT * FROM (${sql}) ledger_period WHERE posting_date >= ${history.from}::text ORDER BY ${grouped ? 'account_code, ' : ''}posting_date,id`
    : sql;
}

// One snapshot keeps totals and running balances consistent while pages are read.
async function withGeneralLedgerExport(filters, access, consume, options = {}) {
  return runHeavyReport(() => executeGeneralLedgerExport(filters, access, consume, options), options);
}
async function executeGeneralLedgerExport(filters, access, consume, { signal, batchSize = 500, resolveVoucherLinks = true } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('Invalid export batch size.');
  if (typeof resolveVoucherLinks !== 'boolean') throw new Error('Invalid voucher-link option.');
  const query = generalLedgerQuery(filters, access, true);
  const client = await getPostgresPool().connect();
  let failed;
  const check = () => { if (signal?.aborted) throw signal.reason || new Error('Export cancelled.'); };
  try {
    check();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // These indexed voucher lookups benefit from execution rather than JIT
    // compilation, matching the existing interactive-report snapshot policy.
    if (query.ownerCtes) await client.query('SET LOCAL jit=off');
    const useDaily = canSummarizeGl(filters, access);
    const { totals: summary, openingRows } = await generalLedgerOverview(client, query, useDaily);
    await client.query(`DECLARE ledger_export_cursor NO SCROLL CURSOR FOR
      ${query.ownerCtes ? 'WITH ' + query.ownerCtes : ''}
      ${generalLedgerRowsSql(query.whereSql, false, filters.group_by === 'account', useDaily, query.ownerCtes ? 'scoped_gl' : 'app_gl_entries', Boolean(query.ownerCtes), resolveVoucherLinks)}`, query.params);
    async function* entries() {
      while (true) {
        check();
        const batch = await client.query(`FETCH FORWARD ${batchSize} FROM ledger_export_cursor`);
        if (!batch.rows.length) break;
        for (const row of batch.rows) { check(); yield row; }
      }
    }
    await consume({ filters: query.filters, rows: entries(),
      ...await generalLedgerReviewDetails(client, filters, access, query),
      opening_rows: openingRows, pagination: { total: summary.total },
      summary: generalLedgerSummary(summary, openingRows) });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { failed = rollbackError; }
    throw error;
  } finally { client.release(failed); }
}

async function generalLedgerFilterOptions() {
  const pool = getPostgresPool();
  return shareRead(pool, 'ledger-voucher-types', async () => {
    const { rows } = await pool.query(`SELECT DISTINCT voucher_type FROM wm_gl_daily
      WHERE entry_count>0 ORDER BY voucher_type`);
    return { accounts: [], parties: [], voucher_types: rows.map(row => ({
      value: row.voucher_type, label: journalTypeLabel(row.voucher_type),
    })) };
  }, { metadata: true });
}

async function generalLedgerAccountOptions(search = '', options = {}) {
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedAccounts)) {
    params.push(options.allowedAccounts);
    where.push(`account.id::text = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedAccounts) && options.deniedAccounts.length) {
    params.push(options.deniedAccounts);
    where.push(`account.id::text <> ALL($${params.length}::text[])`);
  }
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    params.push(sqlLikePattern(q));
    where.push(`(
      LOWER(account.account_code) LIKE $${params.length}
      OR LOWER(account.account_name) LIKE $${params.length}
      OR LOWER(account.account_code || ' - ' || account.account_name) LIKE $${params.length}
    )`);
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT DISTINCT account.account_code, account.account_name
    FROM app_gl_entries gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY account.account_code, account.account_name
    LIMIT 25
    `,
    params,
  );
  return rows.map((row) => ({
    value: `${row.account_code} - ${row.account_name}`,
    account_code: row.account_code,
    account_name: row.account_name,
  }));
}

async function generalLedgerPartyOptions(search = '', access = {}) {
  const params = [];
  const where = ['COALESCE(gl.party_id, gl.party_name, gl.party_type) IS NOT NULL'];
  addGeneralLedgerAccessFilter(where, params, access);
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    params.push(sqlLikePattern(q));
    where.push(`(
      LOWER(COALESCE(gl.party_id, '')) LIKE $${params.length}
      OR LOWER(COALESCE(gl.party_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(gl.party_type, '')) LIKE $${params.length}
    )`);
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT DISTINCT gl.party_type, gl.party_id, gl.party_name
    FROM app_gl_entries gl
    WHERE ${where.join(' AND ')}
    ORDER BY party_name NULLS LAST, party_id NULLS LAST, party_type NULLS LAST
    LIMIT 25
    `,
    params,
  );
  return rows.map((row) => ({
    value: row.party_name || row.party_id || row.party_type,
    party_type: row.party_type,
    party_id: row.party_id,
    party_name: row.party_name,
  })).filter((row) => row.value);
}

async function journalReferenceOptions(filters = {}) {
  const partyType = String(filters.party_type || '').trim();
  const partyId = String(filters.party_id || '').trim();
  const partyName = String(filters.party_name || '').trim();
  const search = String(filters.search || '').trim();
  const limit = Math.max(1, Math.min(Number(filters.limit || 25), 50));
  const ownerId = filters.ownerId === null || filters.ownerId === undefined ? null : String(filters.ownerId);
  const employeeId = String(filters.ownerEmployeeId || '');
  if (!partyType || (!partyId && !partyName)) {
    return [];
  }

  if (filters.purchaseInvoicesOnly) {
    if (partyType !== 'supplier' || !partyId) return [];
    const params = [partyId, sqlLikePattern(search)];
    if (ownerId !== null) params.push(ownerId);
    return (await getPostgresPool().query(`SELECT purchase_no AS reference, 'Purchase' AS type,
      posting_date::text, supplier_name AS party_name, total::float AS amount,
      GREATEST(total - amount_paid, 0)::float AS balance, docstatus AS status, id,
      (SELECT account_id FROM app_accounting_settings WHERE setting_key='accounts_payable') AS account_id
      FROM app_purchases WHERE supplier_id=$1 AND purchase_no ILIKE $2
        ${filters.outstandingOnly ? "AND docstatus='submitted' AND total > amount_paid" : ''}
        ${ownerId === null ? '' : 'AND created_by_user_id=$3'}
      ORDER BY posting_date DESC, id DESC LIMIT 50`, params)).rows;
  }

  const { rows: referenceAccounts } = await getPostgresPool().query("SELECT setting_key, account_id FROM app_accounting_settings WHERE setting_key IN ('accounts_receivable', 'accounts_payable')");
  const referenceAccountId = (key) => referenceAccounts.find((row) => row.setting_key === key)?.account_id;
  const options = [];
  const seen = new Set();
  const addOption = (row) => {
    const reference = String(row.reference || '').trim();
    if (!reference) {
      return;
    }
    const key = reference;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ ...row, account_id: row.type === 'Invoice' ? referenceAccountId('accounts_receivable') : row.type === 'Purchase' ? referenceAccountId('accounts_payable') : null });
  };

  if (partyType === 'customer') {
    const { rows } = await getPostgresPool().query(
      `
      SELECT
        invoice.invoice_no AS reference,
        'Invoice' AS type,
        invoice.invoice_date::text AS posting_date,
        invoice.customer_name AS party_name,
        invoice.total::float AS amount,
        CASE WHEN invoice.docstatus = 'submitted' THEN
          GREATEST(invoice.total - direct_paid.amount - journal_paid.amount, 0)::float
          ELSE NULL::float END AS balance,
        invoice.status,
        invoice.id
      FROM app_invoices invoice
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(payment.amount), 0) AS amount
        FROM app_invoice_payments payment
        WHERE payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      ) direct_paid ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(payment.amount), 0) AS amount FROM (
          SELECT SUM(line.credit - line.debit) AS amount
          FROM app_journal_entries journal
          JOIN app_journal_entry_lines line ON line.journal_entry_id = journal.id
          JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
            AND setting.account_id = line.account_id
          WHERE COALESCE(NULLIF(line.reference_no, ''), journal.reference_no) = invoice.invoice_no AND journal.docstatus = 'submitted'
            AND journal.party_type = 'customer'
            AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
            AND (NULLIF(journal.party_id, '') = NULLIF(invoice.customer_id, '')
              OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name))
            AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id = journal.id)
          GROUP BY journal.id HAVING SUM(line.credit - line.debit) > 0
        ) payment
      ) journal_paid ON true
      WHERE (invoice.customer_id = $1 OR invoice.customer_name = $2)
        ${ownerId === null ? '' : employeeId
    ? 'AND (invoice.created_by_user_id = $3 OR invoice.invoicer_id = $4)'
    : 'AND invoice.created_by_user_id = $3'}
      ORDER BY invoice.invoice_date DESC, invoice.id DESC
      LIMIT 200
      `,
      ownerId === null ? [partyId, partyName] : employeeId
        ? [partyId, partyName, ownerId, employeeId] : [partyId, partyName, ownerId],
    );
    rows.forEach(addOption);
  }

  if (partyType === 'supplier') {
    const purchases = await getPostgresPool().query(
      `SELECT purchase_no AS reference, 'Purchase' AS type, posting_date::text,
        supplier_name AS party_name, total::float AS amount,
        CASE WHEN docstatus = 'submitted' THEN GREATEST(total - amount_paid, 0)::float
          ELSE NULL::float END AS balance,
        docstatus AS status, id
       FROM app_purchases
       WHERE (supplier_id = $1 OR supplier_name = $2)
         ${ownerId === null ? '' : 'AND created_by_user_id = $3'}
       ORDER BY posting_date DESC, id DESC LIMIT 200`,
      ownerId === null ? [partyId, partyName] : [partyId, partyName, ownerId],
    );
    purchases.rows.forEach(addOption);
    const { rows } = await getPostgresPool().query(
      `
      SELECT
        entry_no AS reference,
        'Stock Entry' AS type,
        posting_date::text AS posting_date,
        supplier_name AS party_name,
        NULL::float AS amount,
        NULL::float AS balance,
        docstatus AS status,
        id
      FROM app_stock_entries
      WHERE (supplier_name = $1 OR supplier_reference = $2)
        ${ownerId === null ? '' : 'AND created_by_user_id = $3'}
      ORDER BY posting_date DESC, id DESC
      LIMIT 200
      `,
      ownerId === null ? [partyName, partyId] : [partyName, partyId, ownerId],
    );
    rows.forEach(addOption);
  }

  const [journalResult, glResult] = await Promise.all([
    getPostgresPool().query(
      `
      SELECT
        COALESCE(reference_no, journal_no) AS reference,
        CASE
          WHEN journal_type = 'cash_receipt' THEN 'Cash Receipt'
          WHEN journal_type = 'payment_journal' THEN 'Payment Journal'
          WHEN journal_type = 'sales_invoice' THEN 'Sales Invoice'
          ELSE 'Journal Entry'
        END AS type,
        posting_date::text AS posting_date,
        party_name,
        total_debit::float AS amount,
        NULL::float AS balance,
        NULL::text AS status,
        id
      FROM app_journal_entries
      WHERE party_type = $1
        AND (party_id = $2 OR party_name = $3)
        AND COALESCE(reference_no, journal_no) IS NOT NULL
        ${ownerId === null ? '' : 'AND created_by_user_id = $4'}
      ORDER BY posting_date DESC, id DESC
      LIMIT 200
      `,
      ownerId === null ? [partyType, partyId, partyName] : [partyType, partyId, partyName, ownerId],
    ),
    getPostgresPool().query(
      `
      SELECT
        voucher_no AS reference,
        voucher_type AS type,
        MAX(posting_date)::text AS posting_date,
        MAX(party_name) AS party_name,
        GREATEST(SUM(debit), SUM(credit))::float AS amount,
        NULL::float AS balance,
        NULL::text AS status,
        MAX(voucher_id) AS id
      FROM app_gl_entries
      WHERE party_type = $1
        AND (party_id = $2 OR party_name = $3)
        AND voucher_no IS NOT NULL
        AND voucher_type NOT LIKE 'hr_%'
        ${ownerId === null ? '' : 'AND created_by_user_id = $4'}
      GROUP BY voucher_type, voucher_no
      ORDER BY MAX(posting_date) DESC, MAX(id) DESC
      LIMIT 200
      `,
      ownerId === null ? [partyType, partyId, partyName] : [partyType, partyId, partyName, ownerId],
    ),
  ]);
  journalResult.rows.forEach(addOption);
  glResult.rows.forEach(addOption);

  return options
    .filter((option) => matchesSearchFields([
      option.reference,
      option.type,
      option.posting_date,
      option.party_name,
      option.amount,
      option.balance,
      option.status,
    ], search))
    .slice(0, limit);
}

async function trialBalanceReport(filters = {}) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const params = [from || null, to || null];
  validateReportDates(from, to);
  const pool = getPostgresPool();
  return shareRead(pool, ['trial-balance', params], () => runHeavyReport(async () => {
  const { rows } = await pool.query(`WITH balances AS (
    SELECT account_id,
      SUM(CASE WHEN $1::date IS NOT NULL AND posting_date < $1::date THEN debit-credit ELSE 0 END) AS opening_balance,
      SUM(CASE WHEN $1::date IS NULL OR posting_date >= $1::date THEN debit ELSE 0 END) AS period_debit,
      SUM(CASE WHEN $1::date IS NULL OR posting_date >= $1::date THEN credit ELSE 0 END) AS period_credit,
      SUM(debit-credit) AS closing_balance
    FROM wm_gl_daily WHERE $2::date IS NULL OR posting_date <= $2::date GROUP BY account_id
  )
  SELECT account.account_code, account.account_name, account.account_type, account.normal_balance,
    COALESCE(b.opening_balance,0)::text AS opening_balance,
    COALESCE(b.period_debit,0)::text AS period_debit,
    COALESCE(b.period_credit,0)::text AS period_credit,
    COALESCE(b.closing_balance,0)::text AS closing_balance
  FROM app_accounts account LEFT JOIN balances b ON b.account_id=account.id
  WHERE NOT account.is_group
    AND (COALESCE(b.opening_balance,0)<>0 OR COALESCE(b.period_debit,0)<>0
      OR COALESCE(b.period_credit,0)<>0 OR COALESCE(b.closing_balance,0)<>0)
  ORDER BY account.account_code, account.account_name`, params);
  const normalizedRows = rows.map((row) => formatTrialBalanceRow(row));
  const summary = Object.fromEntries(['opening_debit', 'opening_credit', 'period_debit',
    'period_credit', 'closing_debit', 'closing_credit'].map(key => [key, sumMoney(normalizedRows, key)]));

  return {
    filters: { from, to },
    rows: normalizedRows,
    summary,
    is_balanced: minor(summary.closing_debit) === minor(summary.closing_credit),
  };
  }));
}

async function profitAndLossReport(filters = {}) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const params = [];
  const where = ["account.account_type IN ('income', 'expense')"];
  if (from) {
    params.push(from);
    where.push(`gl.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`gl.posting_date <= $${params.length}`);
  }

  const { rows } = await getPostgresPool().query(
    `
    SELECT
      account.account_code,
      account.account_name,
      account.account_type,
      COALESCE(SUM(gl.debit), 0)::text AS debit,
      COALESCE(SUM(gl.credit), 0)::text AS credit
    FROM app_gl_entries gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    WHERE ${where.join(' AND ')}
    GROUP BY account.id, account.account_code, account.account_name, account.account_type
    HAVING COALESCE(SUM(gl.debit), 0) <> 0
      OR COALESCE(SUM(gl.credit), 0) <> 0
    ORDER BY account.account_type, account.account_code, account.account_name
    `,
    params,
  );

  const income = [];
  const expenses = [];
  for (const row of rows) {
    const amount = row.account_type === 'income'
      ? subtractMoney(row.credit, row.debit)
      : subtractMoney(row.debit, row.credit);
    const reportRow = {
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      debit: reportMoney(row.debit),
      credit: reportMoney(row.credit),
      amount,
    };
    if (row.account_type === 'income') {
      income.push(reportRow);
    } else {
      expenses.push(reportRow);
    }
  }

  const totalIncome = sumMoney(income, 'amount');
  const cogs = sumMoney(expenses.filter(row => row.account_name.toLowerCase().includes('cost of goods')), 'amount');
  const totalExpenses = sumMoney(expenses, 'amount');
  const grossProfit = subtractMoney(totalIncome, cogs);
  const netProfit = subtractMoney(totalIncome, totalExpenses);

  return {
    filters: { from, to },
    income,
    expenses,
    summary: {
      total_income: totalIncome,
      cost_of_goods_sold: cogs,
      gross_profit: grossProfit,
      total_expenses: totalExpenses,
      net_profit: netProfit,
    },
  };
}

async function balanceSheetReport(filters = {}) {
  return readSnapshot(getPostgresPool(), async client => {
    const asOf = String(filters.as_of || '').trim();
    const params = [asOf || null];
    const { rows } = await client.query(
      `
      SELECT
        account.account_code,
        account.account_name,
        account.account_type,
        COALESCE(SUM(gl.debit), 0)::text AS debit,
        COALESCE(SUM(gl.credit), 0)::text AS credit
      FROM app_accounts account
      LEFT JOIN app_gl_entries gl ON gl.account_id = account.id
        AND ($1::date IS NULL OR gl.posting_date <= $1::date)
      WHERE account.is_group = false
        AND account.account_type IN ('asset', 'liability', 'equity')
      GROUP BY account.id, account.account_code, account.account_name, account.account_type
      HAVING COALESCE(SUM(gl.debit), 0) <> 0
        OR COALESCE(SUM(gl.credit), 0) <> 0
      ORDER BY account.account_type, account.account_code, account.account_name
      `,
      params,
    );
    const { rows: earningsRows } = await client.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN account.account_type = 'income' THEN gl.credit - gl.debit ELSE 0 END), 0)::text AS income,
        COALESCE(SUM(CASE WHEN account.account_type = 'expense' THEN gl.debit - gl.credit ELSE 0 END), 0)::text AS expenses
      FROM app_gl_entries gl
      INNER JOIN app_accounts account ON account.id = gl.account_id
      WHERE account.account_type IN ('income', 'expense')
        AND ($1::date IS NULL OR gl.posting_date <= $1::date)
      `,
      params,
    );

    const assets = [];
    const liabilities = [];
    const equity = [];
    for (const row of rows) {
      const debit = reportMoney(row.debit);
      const credit = reportMoney(row.credit);
      const amount = row.account_type === 'asset'
        ? subtractMoney(debit, credit)
        : subtractMoney(credit, debit);
      const reportRow = {
        account_code: row.account_code,
        account_name: row.account_name,
        account_type: row.account_type,
        debit,
        credit,
        amount,
      };
      if (row.account_type === 'asset') {
        assets.push(reportRow);
      } else if (row.account_type === 'liability') {
        liabilities.push(reportRow);
      } else {
        equity.push(reportRow);
      }
    }

    const earnings = earningsRows[0] || {};
    const currentEarnings = subtractMoney(earnings.income, earnings.expenses);
    if (currentEarnings !== 0) {
      equity.push({
        account_code: '',
        account_name: 'Current Earnings',
        account_type: 'equity',
        debit: 0,
        credit: 0,
        amount: currentEarnings,
      });
    }

    const totalAssets = sumMoney(assets, 'amount');
    const totalLiabilities = sumMoney(liabilities, 'amount');
    const totalEquity = sumMoney(equity, 'amount');
    const liabilitiesPlusEquity = sumMoney([{ amount: totalLiabilities }, { amount: totalEquity }], 'amount');
    const difference = subtractMoney(totalAssets, liabilitiesPlusEquity);

    return {
      filters: { as_of: asOf },
      assets,
      liabilities,
      equity,
      summary: {
        total_assets: totalAssets,
        total_liabilities: totalLiabilities,
        total_equity: totalEquity,
        liabilities_plus_equity: liabilitiesPlusEquity,
        difference,
        is_balanced: difference === 0,
      },
    };
  });
}

async function backfillAccountingGl() {
  return withPostgresTransaction(async (client) => {
    const { rows: invoiceRows } = await client.query(`
      SELECT
        invoice.*,
        COALESCE(SUM(item.cost_amount), 0)::float AS total_cost
      FROM app_invoices invoice
      LEFT JOIN app_invoice_items item ON item.invoice_pk = invoice.id
      WHERE invoice.docstatus = 'submitted'
      GROUP BY invoice.id
      ORDER BY invoice.id
    `);
    let salesInvoices = 0;
    let customerPayments = 0;
    let stockEntries = 0;
    let stockReversals = 0;
    let skippedInvoices = 0;

    for (const invoice of invoiceRows) {
      try {
        await postSalesInvoiceGlEntry(client, {
          ...invoice,
          id: Number(invoice.id),
          invoice_date: dateOnly(invoice.invoice_date),
          total_cost: roundMoney(invoice.total_cost),
        });
        salesInvoices += 1;
      } catch (err) {
        skippedInvoices += 1;
        continue;
      }

      const { rows: paymentRows } = await client.query(
        `
        SELECT id, payment_no, payment_date, amount, method, account_id, reference, notes, journal_entry_id
        FROM app_invoice_payments
        WHERE invoice_id = $1 AND docstatus = 'submitted'
        ORDER BY payment_no
        `,
        [Number(invoice.id)],
      );
      for (const payment of paymentRows) {
        await createOrUpdatePaymentJournalEntry(client, invoice, payment);
        customerPayments += 1;
      }
    }

    const { rows: stockRows } = await client.query(`
      SELECT
        se.id,
        se.entry_no,
        se.entry_type,
        se.posting_date::text AS posting_date
      FROM app_stock_entries se
      WHERE EXISTS (
        SELECT 1
        FROM app_stock_ledger ledger
        WHERE ledger.voucher_id = se.id
          AND ledger.voucher_type LIKE 'stock_%'
          AND ledger.is_reversal = false
      )
      ORDER BY se.id
    `);
    for (const entry of stockRows) {
      await postStockEntryGlEntry(client, {
        id: Number(entry.id),
        entryNo: entry.entry_no,
        entryType: entry.entry_type,
        postingDate: dateOnly(entry.posting_date),
      });
      stockEntries += 1;

      const { rows: reversalRows } = await client.query(
        `
        SELECT posting_date::text AS posting_date
        FROM app_stock_ledger
        WHERE voucher_id = $1
          AND voucher_type = $2
          AND is_reversal = true
        ORDER BY posting_date DESC, id DESC
        LIMIT 1
        `,
        [Number(entry.id), `stock_${entry.entry_type}`],
      );
      if (reversalRows.length) {
        await postStockEntryGlEntry(client, {
          id: Number(entry.id),
          entryNo: entry.entry_no,
          entryType: entry.entry_type,
          postingDate: dateOnly(reversalRows[0].posting_date),
          isReversal: true,
          remarks: `Cancellation of ${entry.entry_no}`,
        });
        stockReversals += 1;
      }
    }

    const { rows: glRows } = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM app_gl_entries
      WHERE voucher_type IN ('sales_invoice', 'customer_payment', 'payment_journal')
        OR voucher_type LIKE 'stock_%'
    `);

    return {
      sales_invoices: salesInvoices,
      customer_payments: customerPayments,
      stock_entries: stockEntries,
      stock_reversals: stockReversals,
      skipped_invoices: skippedInvoices,
      gl_entries: Number(glRows[0].count || 0),
    };
  });
}
module.exports = {
  accountingAccounts,
  postableAccountingAccounts,
  receivingAccounts,
  validateReceivingAccount,
  findAccountingAccount,
  createAccountingAccount,
  updateAccountingAccount,
  journalEntries,
  findJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  syncJournalEntryLines,
  submitJournalEntry,
  validateJournalInvoicePayment,
  cancelJournalEntry,
  isManualJournalType,
  addGeneralLedgerAccessFilter,
  generalLedgerReport,
  withGeneralLedgerExport,
  generalLedgerFilterOptions,
  generalLedgerAccountOptions,
  generalLedgerPartyOptions,
  journalReferenceOptions,
  trialBalanceReport,
  profitAndLossReport,
  balanceSheetReport,
  backfillAccountingGl,
};
