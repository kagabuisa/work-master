'use strict';
// Ledger domain: chart of accounts, journal entries, general ledger, trial
// balance, profit & loss, balance sheet and accounting backfill.
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { JOURNAL_TYPES, DEFAULT_ACCOUNTS } = require('../constants');
const { normalizePostingTime, storedPostingTime } = require('../posting-time');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');
const { postSalesInvoiceGlEntry, createOrUpdatePaymentJournalEntry, postStockEntryGlEntry, postGlEntry, reverseVoucherGlEntries, syncGeneratedJournalEntryLines, resolveAccountingAccounts, setVoucherDocstatus, nonZeroAccountingLines, actorAuditValues, addReportFilters, reportFilterValues } = require('./posting');
const { normalizeJournalEntryPayload, normalizeAccountingAccountPayload, journalTypeLabel, formatTrialBalanceRow } = require('./normalization');

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
  const pagination = paginationOptions(typeof options === 'number' ? { limit: options } : options, 50, 200);
  const limit = pagination.limit;
  const search = typeof options === 'object'
    ? String(options.search || '').trim().toLowerCase()
    : '';
  const journalType = typeof options === 'object' ? String(options.journal_type || '').trim() : '';
  const status = typeof options === 'object' ? String(options.status || '').trim() : '';
  const params = [];
  const where = [];
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
      OR LOWER(COALESCE(remarks, '')) LIKE $${params.length}
      OR LOWER(COALESCE(docstatus, 'submitted')) LIKE $${params.length}
      OR total_debit::text LIKE $${params.length}
      OR total_credit::text LIKE $${params.length}
    )`);
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
  const countResult = await getPostgresPool().query(
    `SELECT COUNT(*)::int AS total FROM app_journal_entries ${whereSql}`,
    params,
  );
  params.push(Number(limit), pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      id, journal_no, COALESCE(docstatus, 'submitted') AS docstatus,
      journal_type, posting_date::text, posting_time::text, party_type, party_id,
      party_name, reference_no, remarks, total_debit::float, total_credit::float,
      created_at
    FROM app_journal_entries
    ${whereSql}
    ORDER BY posting_date DESC, id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  const journals = rows.map((row) => ({
    ...row,
    id: Number(row.id),
    posting_time: storedPostingTime(row.posting_time),
    created_at: toIsoString(row.created_at),
  }));
  journals.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  return journals;
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
      party_name, reference_no, remarks, total_debit::float, total_credit::float,
      created_at, created_by, created_by_user_id, updated_by, updated_by_user_id, updated_at,
      submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at,
      EXISTS (SELECT 1 FROM app_invoice_payments payment
        WHERE payment.journal_entry_id = journal.id) AS linked_payment
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
      account.account_name, line.debit::float, line.credit::float, line.remarks
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
    if (submit) await validateJournalInvoicePayment(client, journal);
    const { rows } = await client.query(
      `
      INSERT INTO app_journal_entries (
        journal_type, posting_date, party_type, party_id, party_name, reference_no,
        remarks, total_debit, total_credit, docstatus, posting_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          journal_entry_id, line_no, account_id, debit, credit, remarks
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [id, line.line_no, line.account_id, line.debit, line.credit, line.remarks],
      );
    }
    if (submit) await postGlEntry(client, {
      posting_date: journal.posting_date,
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
    return id;
  });
}

async function updateJournalEntry(id, payload) {
  const journal = normalizeJournalEntryPayload(payload);
  return withPostgresTransaction(async (client) => {
    const existing = await client.query('SELECT docstatus FROM app_journal_entries WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows[0]) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (existing.rows[0].docstatus !== 'draft') {
      const error = new Error('Only draft journals can be edited.'); error.status = 400; throw error;
    }
    await client.query(`UPDATE app_journal_entries SET journal_type = $2, posting_date = $3, party_type = $4,
      party_id = $5, party_name = $6, reference_no = $7, remarks = $8, total_debit = $9, total_credit = $10,
      posting_time = $11
      WHERE id = $1`, [id, journal.journal_type, journal.posting_date, journal.party_type, journal.party_id,
      journal.party_name, journal.reference_no, journal.remarks, journal.total_debit, journal.total_credit,
      journal.posting_time]);
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
          remarks = $5
        WHERE id = $6
          AND journal_entry_id = $7
        `,
        [index + 1, line.account_id, line.debit, line.credit, line.remarks, dbId, journalId],
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
        (journal_entry_id, line_no, account_id, debit, credit, remarks)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [journalId, index + 1, line.account_id, line.debit, line.credit, line.remarks],
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
    const lines = (await client.query(`SELECT account_id, debit::float, credit::float, remarks
      FROM app_journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_no`, [id])).rows;
    if (lines.length < 2 || roundMoney(lines.reduce((sum, line) => sum + line.debit - line.credit, 0)) !== 0) {
      const error = new Error('Journal debits and credits must balance.'); error.status = 400; throw error;
    }
    await validateJournalInvoicePayment(client, { ...journal, lines });
    await setVoucherDocstatus(client, 'app_journal_entries', Number(id), 'submitted');
    await postGlEntry(client, {
      posting_date: dateOnly(journal.posting_date),
      voucher_type: journal.journal_type,
      voucher_id: Number(id),
      voucher_no: journal.journal_no,
      party_type: journal.party_type,
      party_id: journal.party_id,
      party_name: journal.party_name,
      remarks: journal.remarks || journal.reference_no || journalTypeLabel(journal.journal_type),
      lines,
    });
    return Number(id);
  });
}

async function validateJournalInvoicePayment(client, journal) {
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
         WHERE existing.reference_no = $2 AND existing.docstatus = 'submitted'
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
    await reverseVoucherGlEntries(client, journal.journal_type, journalId, dateOnly(new Date()));
    return journalId;
  });
}

function isManualJournalType(type, linkedPayment = false) {
  const journalType = String(type || '').trim();
  return ['cash_receipt', 'journal_entry'].includes(journalType)
    || (journalType === 'payment_journal' && !linkedPayment);
}

async function generalLedgerReport(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const account = String(filters.account || '').trim().toLowerCase();
  const party = String(filters.party || '').trim().toLowerCase();
  const voucherType = String(filters.voucher_type || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();

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
    where.push(`(LOWER(COALESCE(gl.party_id, '')) LIKE $${params.length} OR LOWER(COALESCE(gl.party_name, '')) LIKE $${params.length})`);
  }
  if (voucherType) {
    params.push(voucherType);
    where.push(`gl.voucher_type = $${params.length}`);
  }
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
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_gl_entries gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${whereSql}
    `,
    params,
  );
  const summaryResult = await getPostgresPool().query(
    `
    SELECT COALESCE(SUM(gl.debit), 0)::float AS debit, COALESCE(SUM(gl.credit), 0)::float AS credit
    FROM app_gl_entries gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
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
      gl.debit::float,
      gl.credit::float,
      gl.remarks,
      SUM(gl.debit - gl.credit) OVER (
        PARTITION BY gl.account_id
        ORDER BY gl.posting_date, gl.id
      )::float AS running_balance
    FROM app_gl_entries gl
    INNER JOIN app_accounts account ON account.id = gl.account_id
    ${whereSql}
    ORDER BY gl.posting_date ASC, gl.id ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  const summary = summaryResult.rows[0] || { debit: 0, credit: 0 };
  return {
    filters: {
      search: String(filters.search || '').trim(),
      account: String(filters.account || '').trim(),
      party: String(filters.party || '').trim(),
      voucher_type: voucherType,
      from,
      to,
    },
    rows,
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
    summary: {
      debit: roundMoney(summary.debit),
      credit: roundMoney(summary.credit),
      balance: roundMoney(summary.debit - summary.credit),
    },
  };
}

async function generalLedgerFilterOptions() {
  const voucherResult = await getPostgresPool().query(`
      SELECT DISTINCT voucher_type
      FROM app_gl_entries
      WHERE voucher_type IS NOT NULL
      ORDER BY voucher_type
    `);

  return {
    accounts: [],
    parties: [],
    voucher_types: voucherResult.rows.map((row) => ({
      value: row.voucher_type,
      label: journalTypeLabel(row.voucher_type),
    })),
  };
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

async function generalLedgerPartyOptions(search = '') {
  const params = [];
  const where = ['COALESCE(party_id, party_name, party_type) IS NOT NULL'];
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    params.push(sqlLikePattern(q));
    where.push(`(
      LOWER(COALESCE(party_id, '')) LIKE $${params.length}
      OR LOWER(COALESCE(party_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(party_type, '')) LIKE $${params.length}
    )`);
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT DISTINCT party_type, party_id, party_name
    FROM app_gl_entries
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
  if (!partyType || (!partyId && !partyName)) {
    return [];
  }

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
    options.push(row);
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
          WHERE journal.reference_no = invoice.invoice_no AND journal.docstatus = 'submitted'
            AND journal.party_type = 'customer'
            AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
            AND (NULLIF(journal.party_id, '') = NULLIF(invoice.customer_id, '')
              OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name))
            AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id = journal.id)
          GROUP BY journal.id HAVING SUM(line.credit - line.debit) > 0
        ) payment
      ) journal_paid ON true
      WHERE invoice.customer_id = $1 OR invoice.customer_name = $2
      ORDER BY invoice.invoice_date DESC, invoice.id DESC
      LIMIT 200
      `,
      [partyId, partyName],
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
       WHERE supplier_id = $1 OR supplier_name = $2
       ORDER BY posting_date DESC, id DESC LIMIT 200`,
      [partyId, partyName],
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
      WHERE supplier_name = $1 OR supplier_reference = $2
      ORDER BY posting_date DESC, id DESC
      LIMIT 200
      `,
      [partyName, partyId],
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
      ORDER BY posting_date DESC, id DESC
      LIMIT 200
      `,
      [partyType, partyId, partyName],
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
      GROUP BY voucher_type, voucher_no
      ORDER BY MAX(posting_date) DESC, MAX(id) DESC
      LIMIT 200
      `,
      [partyType, partyId, partyName],
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
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      account.account_code,
      account.account_name,
      account.account_type,
      account.normal_balance,
      COALESCE(SUM(CASE WHEN $1::date IS NOT NULL AND gl.posting_date < $1::date THEN gl.debit - gl.credit ELSE 0 END), 0)::float AS opening_balance,
      COALESCE(SUM(CASE WHEN ($1::date IS NULL OR gl.posting_date >= $1::date) AND ($2::date IS NULL OR gl.posting_date <= $2::date) THEN gl.debit ELSE 0 END), 0)::float AS period_debit,
      COALESCE(SUM(CASE WHEN ($1::date IS NULL OR gl.posting_date >= $1::date) AND ($2::date IS NULL OR gl.posting_date <= $2::date) THEN gl.credit ELSE 0 END), 0)::float AS period_credit,
      COALESCE(SUM(CASE WHEN $2::date IS NULL OR gl.posting_date <= $2::date THEN gl.debit - gl.credit ELSE 0 END), 0)::float AS closing_balance
    FROM app_accounts account
    LEFT JOIN app_gl_entries gl ON gl.account_id = account.id
    WHERE account.is_group = false
      AND account.is_active = true
    GROUP BY account.id, account.account_code, account.account_name, account.account_type, account.normal_balance
    HAVING
      COALESCE(SUM(CASE WHEN $1::date IS NOT NULL AND gl.posting_date < $1::date THEN gl.debit - gl.credit ELSE 0 END), 0) <> 0
      OR COALESCE(SUM(CASE WHEN ($1::date IS NULL OR gl.posting_date >= $1::date) AND ($2::date IS NULL OR gl.posting_date <= $2::date) THEN gl.debit ELSE 0 END), 0) <> 0
      OR COALESCE(SUM(CASE WHEN ($1::date IS NULL OR gl.posting_date >= $1::date) AND ($2::date IS NULL OR gl.posting_date <= $2::date) THEN gl.credit ELSE 0 END), 0) <> 0
      OR COALESCE(SUM(CASE WHEN $2::date IS NULL OR gl.posting_date <= $2::date THEN gl.debit - gl.credit ELSE 0 END), 0) <> 0
    ORDER BY account.account_code, account.account_name
    `,
    params,
  );
  const normalizedRows = rows.map((row) => formatTrialBalanceRow(row));
  const summary = normalizedRows.reduce((total, row) => {
    total.opening_debit += row.opening_debit;
    total.opening_credit += row.opening_credit;
    total.period_debit += row.period_debit;
    total.period_credit += row.period_credit;
    total.closing_debit += row.closing_debit;
    total.closing_credit += row.closing_credit;
    return total;
  }, {
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
  });

  return {
    filters: { from, to },
    rows: normalizedRows,
    summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, roundMoney(value)])),
    is_balanced: roundMoney(summary.closing_debit) === roundMoney(summary.closing_credit),
  };
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
      COALESCE(SUM(gl.debit), 0)::float AS debit,
      COALESCE(SUM(gl.credit), 0)::float AS credit
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
      ? roundMoney(Number(row.credit || 0) - Number(row.debit || 0))
      : roundMoney(Number(row.debit || 0) - Number(row.credit || 0));
    const reportRow = {
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      debit: roundMoney(row.debit),
      credit: roundMoney(row.credit),
      amount,
    };
    if (row.account_type === 'income') {
      income.push(reportRow);
    } else {
      expenses.push(reportRow);
    }
  }

  const totalIncome = roundMoney(income.reduce((sum, row) => sum + row.amount, 0));
  const cogs = roundMoney(expenses
    .filter((row) => row.account_name.toLowerCase().includes('cost of goods'))
    .reduce((sum, row) => sum + row.amount, 0));
  const totalExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.amount, 0));
  const grossProfit = roundMoney(totalIncome - cogs);
  const netProfit = roundMoney(totalIncome - totalExpenses);

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
  const asOf = String(filters.as_of || '').trim();
  const params = [asOf || null];
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      account.account_code,
      account.account_name,
      account.account_type,
      COALESCE(SUM(gl.debit), 0)::float AS debit,
      COALESCE(SUM(gl.credit), 0)::float AS credit
    FROM app_accounts account
    LEFT JOIN app_gl_entries gl ON gl.account_id = account.id
      AND ($1::date IS NULL OR gl.posting_date <= $1::date)
    WHERE account.is_group = false
      AND account.is_active = true
      AND account.account_type IN ('asset', 'liability', 'equity')
    GROUP BY account.id, account.account_code, account.account_name, account.account_type
    HAVING COALESCE(SUM(gl.debit), 0) <> 0
      OR COALESCE(SUM(gl.credit), 0) <> 0
    ORDER BY account.account_type, account.account_code, account.account_name
    `,
    params,
  );
  const { rows: earningsRows } = await getPostgresPool().query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN account.account_type = 'income' THEN gl.credit - gl.debit ELSE 0 END), 0)::float AS income,
      COALESCE(SUM(CASE WHEN account.account_type = 'expense' THEN gl.debit - gl.credit ELSE 0 END), 0)::float AS expenses
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
    const debit = roundMoney(row.debit);
    const credit = roundMoney(row.credit);
    const amount = row.account_type === 'asset'
      ? roundMoney(debit - credit)
      : roundMoney(credit - debit);
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
  const currentEarnings = roundMoney(Number(earnings.income || 0) - Number(earnings.expenses || 0));
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

  const totalAssets = roundMoney(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const totalEquity = roundMoney(equity.reduce((sum, row) => sum + row.amount, 0));
  const liabilitiesPlusEquity = roundMoney(totalLiabilities + totalEquity);
  const difference = roundMoney(totalAssets - liabilitiesPlusEquity);

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
  generalLedgerReport,
  generalLedgerFilterOptions,
  generalLedgerAccountOptions,
  generalLedgerPartyOptions,
  journalReferenceOptions,
  trialBalanceReport,
  profitAndLossReport,
  balanceSheetReport,
  backfillAccountingGl,
};
