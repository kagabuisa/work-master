const { beginInventoryPosting } = require('../services/inventory-posting');
'use strict';
// Sales domain: invoices, payments, debtor reports and invoice hydration.
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { measurePosting, postingStage, runExpensiveRead } = require('../workload-control');
const { shareRead, readSnapshot } = require('../read-cache');
const { invoiceSearchSql, invoiceTextOnlyPattern } = require('./search-sql');
const { PAYMENT_METHODS, DEFAULT_ACCOUNTS } = require('../constants');
const { normalizePostingTime, storedPostingTime } = require('../posting-time');
const { recordAuditFields } = require('../audit');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult, paginationWindow } = require('../lib/pagination');
const { addVoucherOwnerFilter } = require('../voucher-ownership');
const { postSalesInvoiceGlEntry, createOrUpdatePaymentJournalEntry, createOrUpdateSalesInvoiceJournalEntry, postCustomerPaymentGlEntry, applyPostgresStockMovement, postGlEntry, reverseVoucherGlEntries, resolveAccountingAccounts, actorAuditValues, setVoucherDocstatus, nonZeroAccountingLines, addReportFilters, reportFilterValues, groupByInvoiceId, postgresItemToInvoiceItem, postgresPaymentToInvoicePayment } = require('./posting');
const { syncPostgresInvoicePaymentTotals } = require('./schema');
const { validateReceivingAccount } = require('./ledger');
const { findMasterItem, findMasterCustomer, findMasterSupplier } = require('./master-data');
const { buildInvoiceData, buildPaymentData, buildInvoicePayments, isSubmitted, paymentAccountId, fallbackReceivingAccount, normalizeInvoiceTotals, normalizePayments, applyPaymentTotals, sumPayments, paymentStatus, buildCustomerStatement, filterStatementByDate, customerReportKey, customerMatchesSearch, agingBucket, emptyDebtorSummary, typeSort } = require('./normalization');

async function allInvoices() {
  return allPostgresInvoices();
}

async function paginatedInvoices(options = {}) {
  return paginatedPostgresInvoices(options);
}

async function invoiceWarehouses() {
  const pool = getPostgresPool();
  return shareRead(pool, 'invoice-warehouses', async () => {
    // One index seek per distinct warehouse, rather than scanning every line
    // whenever display metadata expires. Historical non-master codes survive.
    const { rows } = await pool.query(`WITH RECURSIVE used(warehouse) AS (
      (SELECT warehouse FROM app_invoice_items WHERE warehouse IS NOT NULL AND warehouse<>''
        ORDER BY warehouse LIMIT 1)
      UNION ALL
      SELECT next.warehouse FROM used CROSS JOIN LATERAL (
        SELECT warehouse FROM app_invoice_items WHERE warehouse IS NOT NULL AND warehouse<>''
          AND warehouse>used.warehouse ORDER BY warehouse LIMIT 1
      ) next
    ) SELECT warehouse FROM used ORDER BY warehouse`);
    return rows.map(row => row.warehouse);
  }, { metadata: true });
}

async function findInvoice(id) {
  return findPostgresInvoice(id);
}

async function invoiceForPayment(id) {
  const paymentId = Number(id);
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) {
    const err = new Error('Invoice payment not found.');
    err.status = 404;
    throw err;
  }
  const result = await getPostgresPool().query(
    'SELECT invoice_id FROM app_invoice_payments WHERE id = $1',
    [paymentId],
  );
  if (!result.rows.length) {
    const err = new Error('Invoice payment not found.');
    err.status = 404;
    throw err;
  }
  return Number(result.rows[0].invoice_id);
}

async function createInvoice(payload) {
  return createPostgresInvoice(payload);
}

async function updateInvoice(id, payload) {
  return updatePostgresInvoice(id, payload);
}

async function submitInvoice(id) {
  return submitPostgresInvoice(id);
}

async function cancelInvoice(id) {
  return cancelPostgresInvoice(id);
}

async function addInvoicePayment(id, payload) {
  return addPostgresInvoicePayment(id, payload);
}

async function cancelInvoicePayment(id, paymentId) {
  return cancelPostgresInvoicePayment(id, paymentId);
}

async function invoiceSummary() {
  return runExpensiveRead(() => postgresInvoiceSummary());
}

async function topDebtors(limit = 10) {
  return runExpensiveRead(() => postgresTopDebtors(limit));
}

async function debtorReport(options = {}) {
  return runExpensiveRead(() => postgresDebtorReport(options));
}

function postgresInvoiceBalancesCte() {
  return `
    ar_ledger AS (
      SELECT gl.* FROM app_gl_entries gl
      JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
        AND setting.account_id = gl.account_id
    ),
    invoice_postings AS (
      SELECT invoice.id AS invoice_id, SUM(gl.debit - gl.credit) AS total
      FROM app_invoices invoice
      JOIN ar_ledger gl ON gl.voucher_type = 'sales_invoice' AND gl.voucher_id = invoice.id
      GROUP BY invoice.id
    ),
    payment_postings AS (
      SELECT invoice_id, SUM(amount) AS amount_paid
      FROM (
        SELECT invoice.id AS invoice_id, gl.credit - gl.debit AS amount
        FROM app_invoices invoice
        JOIN app_journal_entries journal ON EXISTS (SELECT 1 FROM app_journal_entry_lines ref_line WHERE ref_line.journal_entry_id=journal.id AND COALESCE(NULLIF(ref_line.reference_no, ''), journal.reference_no)=invoice.invoice_no)
          AND journal.party_type = 'customer'
          AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
          AND (NULLIF(journal.party_id, '') = NULLIF(invoice.customer_id, '')
            OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name))
        JOIN ar_ledger gl ON gl.voucher_id = journal.id
          AND EXISTS (SELECT 1 FROM app_journal_entry_lines ref_line WHERE ref_line.journal_entry_id=journal.id AND ref_line.line_no=gl.line_no AND COALESCE(NULLIF(ref_line.reference_no, ''), journal.reference_no)=invoice.invoice_no)
          AND gl.voucher_type IN (journal.journal_type, journal.journal_type || '_cancellation')
        UNION ALL
        SELECT payment.invoice_id, gl.credit - gl.debit AS amount
        FROM app_invoice_payments payment
        JOIN ar_ledger gl ON gl.voucher_id = payment.id
          AND gl.voucher_type IN ('customer_payment', 'customer_payment_cancellation')
      ) posted
      GROUP BY invoice_id
    ),
    invoice_balances AS (
      SELECT invoice.id, invoice.invoice_no, invoice.invoice_date, invoice.due_date,
        invoice.customer_id, invoice.customer_name, invoice.docstatus,
        COALESCE(posting.total, 0) AS total,
        COALESCE(payment.amount_paid, 0) AS amount_paid,
        COALESCE(posting.total, 0) - COALESCE(payment.amount_paid, 0) AS balance_due
      FROM app_invoices invoice
      LEFT JOIN invoice_postings posting ON posting.invoice_id = invoice.id
      LEFT JOIN payment_postings payment ON payment.invoice_id = invoice.id
    )`;
}

async function postgresDebtorReport(options = {}) {
  const search = String(options.search || '').trim().toLowerCase();
  const selectedCustomer = String(options.customer || '').trim();
  const from = String(options.from || '').trim();
  const to = String(options.to || '').trim();
  const statementFrom = String(options.statementFrom || '').trim();
  const statementTo = String(options.statementTo || '').trim();
  const pagination = paginationOptions(options, 50, 200);
  const params = [];
  const where = ["docstatus = 'submitted'"];
  if (from) {
    params.push(from);
    where.push(`invoice_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`invoice_date <= $${params.length}`);
  }
  const invoiceDateRange = Boolean(from || to);
  const groupedSql = `
    WITH ${postgresInvoiceBalancesCte()}, invoice_grouped AS (
      SELECT
        COALESCE(NULLIF(customer_id, ''), customer_name) AS customer_key,
        MAX(customer_id) AS customer_id,
        MAX(customer_name) AS customer_name,
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(total), 0)::float AS invoice_total,
        COALESCE(SUM(amount_paid), 0)::float AS paid_total,
        COALESCE(SUM(balance_due), 0)::float AS balance_due,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - COALESCE(due_date, invoice_date) <= 0 THEN balance_due ELSE 0 END), 0)::float AS current,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 1 AND 30 THEN balance_due ELSE 0 END), 0)::float AS days_1_30,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 31 AND 60 THEN balance_due ELSE 0 END), 0)::float AS days_31_60,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 61 AND 90 THEN balance_due ELSE 0 END), 0)::float AS days_61_90,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - COALESCE(due_date, invoice_date) > 90 THEN balance_due ELSE 0 END), 0)::float AS days_over_90
      FROM invoice_balances
      WHERE ${where.join(' AND ')}
      GROUP BY COALESCE(NULLIF(customer_id, ''), customer_name)
    ), party_ar AS (
      SELECT COALESCE(NULLIF(party_id, ''), party_name) AS customer_key,
        MAX(party_id) AS customer_id, MAX(party_name) AS customer_name,
        SUM(debit - credit)::float AS balance_due
      FROM ar_ledger
      WHERE party_type = 'customer'
        AND COALESCE(NULLIF(party_id, ''), party_name) IS NOT NULL
      GROUP BY COALESCE(NULLIF(party_id, ''), party_name)
    ), grouped AS (
      SELECT COALESCE(invoices.customer_key, ledger.customer_key) AS customer_key,
        COALESCE(invoices.customer_id, ledger.customer_id) AS customer_id,
        COALESCE(invoices.customer_name, ledger.customer_name) AS customer_name,
        COALESCE(invoices.invoice_count, 0) AS invoice_count,
        COALESCE(invoices.invoice_total, 0) AS invoice_total,
        COALESCE(invoices.paid_total, 0) AS paid_total,
        ${invoiceDateRange ? 'COALESCE(invoices.balance_due, 0)' : 'COALESCE(ledger.balance_due, invoices.balance_due, 0)'} AS balance_due,
        COALESCE(invoices.current, 0) AS current,
        COALESCE(invoices.days_1_30, 0) AS days_1_30,
        COALESCE(invoices.days_31_60, 0) AS days_31_60,
        COALESCE(invoices.days_61_90, 0) AS days_61_90,
        COALESCE(invoices.days_over_90, 0) AS days_over_90,
        ${invoiceDateRange ? '0::float' : `COALESCE(ledger.balance_due, invoices.balance_due, 0)
          - COALESCE(invoices.balance_due, 0)`} AS unallocated
      FROM invoice_grouped invoices
      ${invoiceDateRange ? 'LEFT' : 'FULL'} JOIN party_ar ledger ON ledger.customer_key = invoices.customer_key
    )
  `;
  const filteredParams = [...params];
  const filteredWhere = [];
  if (search) {
    filteredParams.push(sqlLikePattern(search));
    filteredWhere.push(`(
      LOWER(customer_key) LIKE $${filteredParams.length}
      OR LOWER(COALESCE(customer_id, '')) LIKE $${filteredParams.length}
      OR LOWER(customer_name) LIKE $${filteredParams.length}
      OR invoice_count::text LIKE $${filteredParams.length}
      OR invoice_total::text LIKE $${filteredParams.length}
      OR paid_total::text LIKE $${filteredParams.length}
      OR balance_due::text LIKE $${filteredParams.length}
    )`);
  }
  const filteredSql = `${groupedSql}
    SELECT *
    FROM grouped
    ${filteredWhere.length ? `WHERE ${filteredWhere.join(' AND ')}` : ''}
  `;
  const debtorWhereSql = `${filteredWhere.length ? `WHERE ${filteredWhere.join(' AND ')} AND` : 'WHERE'} balance_due > 0`;
  const [summaryResult, countResult, customerResult, reconciliationResult] = await Promise.all([
    getPostgresPool().query(
      `${groupedSql}
      SELECT
        COUNT(*)::int AS customer_count,
        COALESCE(SUM(invoice_total), 0)::float AS invoice_total,
        COALESCE(SUM(paid_total), 0)::float AS paid_total,
        COALESCE(SUM(balance_due), 0)::float AS balance_due,
        COALESCE(SUM(current), 0)::float AS current,
        COALESCE(SUM(days_1_30), 0)::float AS days_1_30,
        COALESCE(SUM(days_31_60), 0)::float AS days_31_60,
        COALESCE(SUM(days_61_90), 0)::float AS days_61_90,
        COALESCE(SUM(days_over_90), 0)::float AS days_over_90,
        COALESCE(SUM(unallocated), 0)::float AS unallocated
      FROM grouped
      ${debtorWhereSql}`,
      filteredParams,
    ),
    getPostgresPool().query(
      `${groupedSql}
      SELECT COUNT(*)::int AS total
      FROM grouped
      ${debtorWhereSql}`,
      filteredParams,
    ),
    getPostgresPool().query(
      `${filteredSql}
      ORDER BY balance_due DESC, customer_name
      LIMIT 25`,
      filteredParams,
    ),
    getPostgresPool().query(`
      WITH ${postgresInvoiceBalancesCte()}
      SELECT
        (SELECT COALESCE(SUM(debit - credit), 0)::float FROM ar_ledger) AS ledger_balance,
        (SELECT COALESCE(SUM(balance_due), 0)::float FROM invoice_balances
         WHERE docstatus = 'submitted') AS allocated_balance
    `),
  ]);
  const pageParams = [...filteredParams, pagination.limit, pagination.offset];
  const debtorRows = await getPostgresPool().query(
    `${groupedSql}
    SELECT *
    FROM grouped
    ${debtorWhereSql}
    ORDER BY balance_due DESC, customer_name
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  const allMatches = customerResult.rows.map(roundReportMoney);
  const selected = await resolvePostgresDebtorSelection({
    selectedCustomer,
    groupedSql,
    baseParams: params,
  });
  const statementResult = selected ? await postgresCustomerStatement(selected.customer_key, {
    from: statementFrom || from,
    to: statementTo || to,
  }) : { statement: null, paymentInvoiceId: null };
  const summary = roundReportMoney({
    ...emptyDebtorSummary(),
    ...(summaryResult.rows[0] || {}),
  });
  summary.customer_count = Number(summary.customer_count || 0);
  const reconciliation = reconciliationResult.rows[0];
  summary.ledger_balance = roundMoney(reconciliation.ledger_balance);
  summary.allocated_balance = roundMoney(reconciliation.allocated_balance);
  summary.unallocated_balance = roundMoney(reconciliation.ledger_balance - reconciliation.allocated_balance);

  return {
    filters: {
      search,
      customer: selected ? selected.customer_key : '',
      from,
      to,
      statement_from: statementFrom || from,
      statement_to: statementTo || to,
      statement_range_set: Boolean(statementFrom || statementTo),
    },
    summary,
    debtors: debtorRows.rows.map(roundReportMoney),
    customerResults: allMatches,
    selected: selected ? roundReportMoney({ ...selected }) : null,
    statement: statementResult.statement,
    statementBalance: statementResult.statement && statementResult.statement.length
      ? statementResult.statement[statementResult.statement.length - 1].balance : 0,
    paymentInvoiceId: statementResult.paymentInvoiceId,
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}

async function resolvePostgresDebtorSelection({ selectedCustomer, groupedSql, baseParams }) {
  if (!selectedCustomer) return null;
  const { rows } = await getPostgresPool().query(
    `${groupedSql}
    SELECT *
    FROM grouped
    WHERE customer_key = $${baseParams.length + 1}
    LIMIT 1`,
    [...baseParams, selectedCustomer],
  );
  return rows[0] || null;
}

async function postgresCustomerStatement(customerKey, filters = {}) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const { rows } = await getPostgresPool().query(
    `
    WITH ${postgresInvoiceBalancesCte()}
    SELECT gl.posting_date::text AS date, gl.voucher_type, gl.voucher_id, gl.voucher_no,
      MAX(gl.remarks) AS description, SUM(gl.debit)::float AS debit,
      SUM(gl.credit)::float AS credit, invoice.id AS invoice_id,
      invoice.balance_due::float AS balance_due
    FROM ar_ledger gl
    LEFT JOIN app_journal_entries journal ON journal.id = gl.voucher_id
      AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
      AND gl.voucher_type IN (journal.journal_type, journal.journal_type || '_cancellation')
    LEFT JOIN app_invoice_payments payment ON payment.id = gl.voucher_id
      AND gl.voucher_type IN ('customer_payment', 'customer_payment_cancellation')
    LEFT JOIN invoice_balances invoice ON invoice.docstatus = 'submitted'
      AND ((gl.voucher_type = 'sales_invoice' AND gl.voucher_id = invoice.id)
        OR (EXISTS (SELECT 1 FROM app_journal_entry_lines ref_line WHERE ref_line.journal_entry_id=journal.id AND ref_line.line_no=gl.line_no AND COALESCE(NULLIF(ref_line.reference_no, ''), journal.reference_no)=invoice.invoice_no)
          AND journal.party_type = 'customer'
          AND (NULLIF(journal.party_id, '') = NULLIF(invoice.customer_id, '')
            OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name)))
        OR payment.invoice_id = invoice.id)
    WHERE gl.party_type = 'customer'
      AND COALESCE(NULLIF(gl.party_id, ''), gl.party_name) = $1
    GROUP BY gl.posting_date, gl.voucher_type, gl.voucher_id, gl.voucher_no,
      invoice.id, invoice.balance_due
    ORDER BY gl.posting_date, gl.voucher_id, gl.voucher_type
    `,
    [customerKey],
  );
  let balance = 0;
  const fullStatement = rows.map((row) => {
    balance = roundMoney(balance + Number(row.debit) - Number(row.credit));
    return {
      date: row.date,
      type: row.voucher_type === 'sales_invoice' ? 'Invoice'
        : Number(row.credit) > Number(row.debit) ? 'Payment' : 'Adjustment',
      reference: row.voucher_no || '',
      description: row.description || '',
      debit: Number(row.debit),
      credit: Number(row.credit),
      invoice_id: row.invoice_id ? Number(row.invoice_id) : null,
      balance_due: row.balance_due == null ? null : Number(row.balance_due),
      balance,
    };
  });
  const paymentInvoice = fullStatement.find((entry) => (
    entry.type === 'Invoice' && Number(entry.balance_due || 0) > 0
  ));
  return {
    statement: filterStatementByDate(fullStatement, from, to),
    paymentInvoiceId: paymentInvoice ? paymentInvoice.invoice_id : null,
  };
}

async function allPostgresInvoices() {
  const { rows } = await getPostgresPool().query(`
    SELECT *
    FROM app_invoices
    ORDER BY id DESC
  `);
  return hydratePostgresInvoices(rows);
}

async function paginatedPostgresInvoices(options = {}) {
  const includeTotal = options.includeTotal !== false;
  const search = String(options.search || '').trim().toLowerCase();
  const pattern = sqlLikePattern(search);
  const textSearch = Boolean(search) && invoiceTextOnlyPattern(pattern);
  const computedFilter = Boolean((search && !textSearch) || options.paymentStatus);
  const from = String(options.from || '').trim();
  const to = String(options.to || '').trim();
  const warehouse = String(options.warehouse || '').trim();
  const pagination = paginationOptions(options, 50, 200);
  const order = options.order === 'asc' ? 'ASC' : 'DESC';
  const params = [];
  const where = [];
  addVoucherOwnerFilter(where, params, 'invoice', options.ownerId, options.ownerEmployeeId);
  if (Array.isArray(options.allowedGroups)) {
    params.push(options.allowedGroups);
    where.push(`EXISTS (
      SELECT 1 FROM app_master_customers customer
      WHERE customer.customer_id = invoice.customer_id
        AND LOWER(TRIM(COALESCE(customer.customer_group, ''))) = ANY($${params.length}::text[])
    )`);
  }
  // Optional API read filters. Website callers omit these options, preserving
  // their existing behavior. Restrict before both count and page selection.
  if (Array.isArray(options.allowedWarehouses)) {
    params.push(options.allowedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_invoice_items scoped_item WHERE scoped_item.invoice_pk=invoice.id
      AND COALESCE(scoped_item.warehouse,'')<>'' AND scoped_item.warehouse<>ALL($${params.length}::text[]))`);
  }
  if (Array.isArray(options.deniedWarehouses) && options.deniedWarehouses.length) {
    params.push(options.deniedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_invoice_items scoped_item WHERE scoped_item.invoice_pk=invoice.id
      AND scoped_item.warehouse=ANY($${params.length}::text[]))`);
  }
  if (Array.isArray(options.allowedPriceLists)) {
    params.push(options.allowedPriceLists);
    where.push(`COALESCE(invoice.price_list,'')=ANY($${params.length}::text[])`);
  }
  if (Array.isArray(options.deniedPriceLists) && options.deniedPriceLists.length) {
    params.push(options.deniedPriceLists);
    where.push(`COALESCE(invoice.price_list,'')<>ALL($${params.length}::text[])`);
  }
  if (options.customerId) {
    params.push(options.customerId); where.push(`invoice.customer_id=$${params.length}`);
  }
  if (options.docstatus) {
    params.push(options.docstatus); where.push(`invoice.docstatus=$${params.length}`);
  }
  if (options.paymentStatus) {
    params.push(options.paymentStatus); where.push(`invoice.status=$${params.length}`);
  }
  if (search) {
    params.push(pattern);
    const match = `$${params.length}`;
    const fields = ["LOWER(COALESCE(invoice_no, ''))", "LOWER(COALESCE(non_system_invoice, ''))",
      'LOWER(customer_name)', 'LOWER(docstatus)'];
    if (!textSearch) fields.push('invoice_date::text', 'total::text', 'amount_paid::text', 'LOWER(status)');
    where.push(`(${fields.map(field => `${field} LIKE ${match}`).join(' OR ')})`);
    if (textSearch) {
      params.push(`%${pattern}%`);
      where.push(`${invoiceSearchSql('invoice')} LIKE $${params.length}`);
    }
  }
  if (from) {
    params.push(from);
    where.push(`invoice_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`invoice_date <= $${params.length}`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`EXISTS (
      SELECT 1
      FROM app_invoice_items item
      WHERE item.invoice_pk = invoice.id
        AND item.warehouse = $${params.length}
    )`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageParams = [...params, pagination.limit + (includeTotal ? 0 : 1), pagination.offset];
  const invoiceListSql = (invoiceSource = 'app_invoices') => `
    FROM (
      SELECT
        invoice.id,
        invoice.invoice_no,
        invoice.non_system_invoice,
        invoice.docstatus,
        invoice.invoice_date,
        invoice.posting_time,
        invoice.due_date,
        invoice.customer_id,
        invoice.customer_name,
        invoice.customer_phone,
        invoice.invoicer_id,
        invoice.price_list,
        invoice.subtotal,
        invoice.tax_amount,
        invoice.discount_amount,
        invoice.total,
        CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
          ELSE COALESCE(payment_totals.amount_paid, 0) + COALESCE(journal_totals.amount_paid, 0)
        END AS amount_paid,
        CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
          WHEN COALESCE(payment_totals.amount_paid, 0) + COALESCE(journal_totals.amount_paid, 0) <= 0 THEN 'unpaid'
          WHEN COALESCE(payment_totals.amount_paid, 0) + COALESCE(journal_totals.amount_paid, 0) >= invoice.total THEN 'paid'
          ELSE 'partial'
        END AS status,
        invoice.created_at,
        invoice.created_by_user_id,
        invoice.updated_at
      FROM ${invoiceSource} invoice
      LEFT JOIN (
        SELECT invoice_id, COALESCE(SUM(amount), 0) AS amount_paid
        FROM app_invoice_payments
        ${invoiceSource === 'selected_invoices' ? 'JOIN selected_invoices scoped_invoice ON scoped_invoice.id = app_invoice_payments.invoice_id' : ''}
        WHERE app_invoice_payments.docstatus = 'submitted'
        GROUP BY app_invoice_payments.invoice_id
      ) payment_totals ON payment_totals.invoice_id = invoice.id
      LEFT JOIN (
        SELECT invoice.id AS invoice_id, SUM(journal_payment.amount) AS amount_paid
        FROM ${invoiceSource} invoice
        JOIN (
          SELECT journal.id, COALESCE(NULLIF(line.reference_no, ''), journal.reference_no) AS reference_no, journal.party_id, journal.party_name,
            SUM(line.credit - line.debit) AS amount
          FROM ${invoiceSource === 'selected_invoices' ? 'unlinked_customer_journals' : 'app_journal_entries'} journal
          JOIN app_journal_entry_lines line ON line.journal_entry_id = journal.id
          JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
            AND setting.account_id = line.account_id
          WHERE journal.docstatus = 'submitted' AND journal.party_type = 'customer'
            AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
            ${invoiceSource === 'selected_invoices' ? `AND EXISTS (
              SELECT 1 FROM selected_invoices scoped_invoice
              WHERE scoped_invoice.invoice_no = COALESCE(NULLIF(line.reference_no, ''), journal.reference_no)
            )` : ''}
            AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id = journal.id)
          GROUP BY journal.id, journal.party_id, journal.party_name, COALESCE(NULLIF(line.reference_no, ''), journal.reference_no)
          HAVING SUM(line.credit - line.debit) > 0
        ) journal_payment ON journal_payment.reference_no = invoice.invoice_no
          AND (NULLIF(journal_payment.party_id, '') = NULLIF(invoice.customer_id, '')
            OR (COALESCE(journal_payment.party_id, '') = '' AND journal_payment.party_name = invoice.customer_name))
        GROUP BY invoice.id
      ) journal_totals ON journal_totals.invoice_id = invoice.id
    ) invoice
  `;
  // A normal list page can choose its invoice IDs before computing totals.
  // Numeric/payment-status searches retain computed totals before pagination.
  // For creator OR assignment access, take at most offset+page-size candidates
  // from each independently indexed route. UNION removes overlaps before the
  // final page is selected. Every other filter still applies to both routes.
  const ownerAlternatives = options.ownerId != null && options.ownerEmployeeId
    ? ['invoice.created_by_user_id = $1', 'invoice.invoicer_id = $2'] : null;
  const invoiceCandidatesSql = ownerAlternatives ? `SELECT invoice.* FROM app_invoices invoice
    JOIN (${ownerAlternatives.map(owner => `(SELECT invoice.id FROM app_invoices invoice
      WHERE ${[owner, ...where.slice(1)].join(' AND ')} ORDER BY invoice.id ${order}
      LIMIT ($${pageParams.length - 1}::bigint + $${pageParams.length}::bigint))`).join(' UNION ')}
    ) permitted ON permitted.id=invoice.id` : `SELECT invoice.* FROM app_invoices invoice ${whereSql}`;
  // Match references before hydrating customer journals. UNION deduplicates
  // journals whose header and one or more lines all reference the same page.
  const selectedInvoicesSql = computedFilter ? '' : `WITH selected_invoices AS MATERIALIZED (
    ${invoiceCandidatesSql}
    ORDER BY invoice.id ${order}
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
  ), customer_journal_candidates AS MATERIALIZED (
    SELECT journal.id FROM app_journal_entries journal
    WHERE journal.docstatus='submitted' AND journal.party_type='customer'
      AND journal.journal_type IN ('cash_receipt','payment_journal','journal_entry')
      AND journal.reference_no IN (SELECT invoice_no FROM selected_invoices)
    UNION
    SELECT line.journal_entry_id AS id FROM app_journal_entry_lines line
    WHERE line.reference_no IS NOT NULL AND line.reference_no<>''
      AND line.reference_no IN (SELECT invoice_no FROM selected_invoices)
  ), unlinked_customer_journals AS MATERIALIZED (
    SELECT journal.* FROM customer_journal_candidates candidate
    JOIN app_journal_entries journal ON journal.id=candidate.id
    WHERE journal.docstatus='submitted' AND journal.party_type='customer'
      AND journal.journal_type IN ('cash_receipt','payment_journal','journal_entry')
      AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id=journal.id)
      AND EXISTS (SELECT 1 FROM selected_invoices scoped_invoice
        WHERE NULLIF(journal.party_id,'')=NULLIF(scoped_invoice.customer_id,'')
          OR (COALESCE(journal.party_id,'')='' AND journal.party_name=scoped_invoice.customer_name))
  )`;
  return shareRead(getPostgresPool(), ['invoice-page', whereSql, params, order, pagination, includeTotal], () => runExpensiveRead(() => readSnapshot(getPostgresPool(), async client => {
  const [countResult, pageResult] = await Promise.all([
    includeTotal ? client.query(
      `SELECT COUNT(*)::int AS total ${computedFilter ? invoiceListSql() : 'FROM app_invoices invoice'} ${whereSql}`,
      params,
    ) : Promise.resolve(null),
    client.query(
    `
    ${selectedInvoicesSql}
    SELECT
      id,
      invoice_no,
      non_system_invoice,
      docstatus,
      invoice_date::text,
      posting_time::text,
      due_date::text,
      customer_id,
      customer_name,
      customer_phone,
      price_list,
      subtotal::float,
      tax_amount::float,
      discount_amount::float,
      total::float,
      amount_paid::float,
      status,
      created_at,
      updated_at
    ${invoiceListSql(computedFilter ? 'app_invoices' : 'selected_invoices')}
    ${computedFilter ? whereSql : ''}
    ORDER BY id ${order}
    ${computedFilter ? `LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}` : ''}
    `,
      pageParams,
    ),
  ]);
  return {
    rows: pageResult.rows.slice(0, pagination.limit).map(postgresInvoiceListRow),
    pagination: includeTotal ? paginationResult(Number(countResult.rows[0].total || 0), pagination) : paginationWindow(pageResult.rows.length, pagination),
  };
  })), {scope:'invoice-list'});
}

function postgresInvoiceListRow(row) {
  return normalizeInvoiceTotals({
    id: Number(row.id),
    invoice_no: row.invoice_no,
    non_system_invoice: row.non_system_invoice,
    docstatus: row.docstatus,
    invoice_date: dateOnly(row.invoice_date),
    posting_time: storedPostingTime(row.posting_time),
    due_date: dateOnly(row.due_date),
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    price_list: row.price_list,
    cost_center: row.cost_center,
    invoicer_id: row.invoicer_id,
    invoicer: row.invoicer,
    subtotal: Number(row.subtotal || 0),
    tax_amount: Number(row.tax_amount || 0),
    discount_amount: Number(row.discount_amount || 0),
    total: Number(row.total || 0),
    amount_paid: Number(row.amount_paid || 0),
    status: row.status,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    items: [],
  });
}

async function findPostgresInvoice(id) {
  const { rows } = await getPostgresPool().query(
    'SELECT * FROM app_invoices WHERE id = $1',
    [Number(id)],
  );
  if (!rows[0]) {
    return null;
  }
  const invoices = await hydratePostgresInvoices(rows);
  return invoices[0] || null;
}

async function createPostgresInvoice(payload) {
  const invoiceData = buildInvoiceData(payload);
  return measurePosting('invoice_create', () => withPostgresTransaction(client => postingStage('create', () => createPostgresInvoiceInTransaction(client, payload, invoiceData)), {invalidate:['invoice-list']}));
}

async function createPostgresInvoiceInTransaction(client, payload, invoiceData = buildInvoiceData(payload)) {
  const { rows } = await client.query(
    `
    INSERT INTO app_invoices (
      docstatus, invoice_date, due_date, customer_id, customer_name, customer_phone,
      notes, subtotal, tax_amount, discount_amount, total, amount_paid, status, price_list, is_cash_sale, posting_time, non_system_invoice, cost_center, invoicer, invoicer_id
    )
    VALUES (
      'draft', $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11, $12, $13, $16, $14, $15, $17, $18, $19
    )
    RETURNING id
    `,
    [...invoiceParams(invoiceData), payload.is_cash_sale === true, invoiceData.cost_center, invoiceData.invoicer, invoiceData.invoicer_id],
  );
  const id = Number(rows[0].id);
  const invoiceNo = `INV-${String(id).padStart(6, '0')}`;
  await client.query(
    'UPDATE app_invoices SET invoice_no = $1 WHERE id = $2',
    [invoiceNo, id],
  );
  await insertPostgresItems(client, id, invoiceNo, invoiceData.items);
  await insertPostgresPayments(client, id, invoiceData.payments);
  return id;
}

async function createCashSaleInvoice(payload, payment) {
  const invoiceData = buildInvoiceData({ ...payload, is_cash_sale: true, payments: [], amount_paid: 0 });
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      INSERT INTO app_invoices (
        docstatus, invoice_date, due_date, customer_id, customer_name, customer_phone,
        notes, subtotal, tax_amount, discount_amount, total, amount_paid, status, price_list, is_cash_sale, posting_time, non_system_invoice, cost_center, invoicer, invoicer_id
      )
      VALUES (
        'draft', $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $16, $14, $15, $17, $18, $19
      )
      RETURNING id
      `,
      [...invoiceParams(invoiceData), true, invoiceData.cost_center, invoiceData.invoicer, invoiceData.invoicer_id],
    );
    const id = Number(rows[0].id);
    const invoiceNo = `INV-${String(id).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_invoices SET invoice_no = $1 WHERE id = $2',
      [invoiceNo, id],
    );
    await insertPostgresItems(client, id, invoiceNo, invoiceData.items);

    const { rows: itemRows } = await client.query(
      `
      SELECT *
      FROM app_invoice_items
      WHERE invoice_pk = $1
      ORDER BY line_no
      `,
      [id],
    );

    await beginInventoryPosting(client, 'invoice', Number(id), itemRows.map(item => item.warehouse));
    let totalCost = 0;
    for (const item of itemRows) {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: dateOnly(invoiceData.invoice_date),
        posting_time: invoiceData.posting_time,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'invoice',
        voucher_id: id,
        voucher_no: invoiceNo,
        qty_change: -Math.abs(Number(item.quantity || 0)),
      });
      const costRate = movement.outgoing_rate;
      const costAmount = roundMoney(Math.abs(Number(item.quantity || 0)) * costRate);
      totalCost += costAmount;
      const grossProfit = roundMoney(Number(item.line_total || 0) - costAmount);
      await client.query(
        `
        UPDATE app_invoice_items
        SET cost_rate = $1,
          cost_amount = $2,
          gross_profit = $3,
          stock_at_sale = $4
        WHERE id = $5
        `,
        [costRate, costAmount, grossProfit, movement.previous_quantity, Number(item.id)],
      );
    }

    await setVoucherDocstatus(client, 'app_invoices', id, 'submitted');
    await syncPostgresInvoicePaymentTotals(client, id);

    const invoice = {
      ...invoiceData,
      id,
      invoice_no: invoiceNo,
      total_cost: roundMoney(totalCost),
    };
    await postSalesInvoiceGlEntry(client, invoice);

    const paymentData = buildPaymentData(payment, [], 1);
    const destination = paymentData.account_id ? await validateReceivingAccount(client, paymentData.account_id) : null;
    const { rows: paymentRows } = await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, account_id, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, payment_no, payment_date, amount, method, account_id, reference, notes, journal_entry_id
      `,
      [
        id,
        paymentData.id,
        paymentData.payment_date,
        paymentData.amount,
        destination?.method || paymentData.method,
        destination?.id || null,
        paymentData.reference,
        paymentData.notes,
        paymentData.created_at,
      ],
    );
    await syncPostgresInvoicePaymentTotals(client, id);
    await createOrUpdatePaymentJournalEntry(client, invoice, paymentRows[0]);
    return id;
  });
}

async function updatePostgresInvoice(id, payload) {
  return withPostgresTransaction(client => updatePostgresInvoiceInTransaction(client, id, payload));
}

async function updatePostgresInvoiceInTransaction(client, id, payload) {
  const invoiceData = buildInvoiceData(payload);
    const { rows } = await client.query(
      'SELECT invoice_no, docstatus FROM app_invoices WHERE id = $1 FOR UPDATE',
      [Number(id)],
    );
    const invoice = rows[0];
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if ((invoice.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft invoices can be edited.');
      err.status = 400;
      throw err;
    }
    await client.query(
      `
      UPDATE app_invoices
      SET invoice_date = $1,
        due_date = $2,
        customer_id = $3,
        customer_name = $4,
        customer_phone = $5,
        notes = $6,
        subtotal = $7,
        tax_amount = $8,
        discount_amount = $9,
        total = $10,
        amount_paid = $11,
        status = $12,
        price_list = $13,
        posting_time = $14,
        non_system_invoice = $15,
        cost_center = $16,
        invoicer = $17,
        invoicer_id = $18,
        updated_at = now()
      WHERE id = $19
      `,
      [...invoiceParams(invoiceData), invoiceData.cost_center, invoiceData.invoicer, invoiceData.invoicer_id, Number(id)],
    );
    await client.query('DELETE FROM app_invoice_payments WHERE invoice_id = $1', [Number(id)]);
    await syncPostgresInvoiceItems(client, Number(id), invoice.invoice_no, invoiceData.items);
    await insertPostgresPayments(client, Number(id), invoiceData.payments);
    return Number(id);
}

async function submitPostgresInvoice(id) {
  await measurePosting('invoice_submit', () => withPostgresTransaction(client => postingStage('submit', () => submitPostgresInvoiceInTransaction(client, id))));
  return Number(id);
}

async function submitPostgresInvoiceInTransaction(client, id) {
  const { rows: invoiceRows } = await postingStage('invoice_lock', () => client.query(
    'SELECT * FROM app_invoices WHERE id = $1 FOR UPDATE',
    [Number(id)],
  ));
  const invoice = invoiceRows[0];
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  if ((invoice.docstatus || 'submitted') !== 'draft') {
    const err = new Error('Only draft invoices can be submitted.');
    err.status = 400;
    throw err;
  }

  const { rows: itemRows } = await client.query(
    `
    SELECT *
    FROM app_invoice_items
    WHERE invoice_pk = $1
    ORDER BY line_no
    `,
    [Number(id)],
  );

  await beginInventoryPosting(client, 'invoice', Number(id), itemRows.map(item => item.warehouse));
  let totalCost = 0;
  const lineCosts = [];
  for (const item of itemRows) {
    const movement = await postingStage('stock', () => applyPostgresStockMovement(client, {
      posting_date: dateOnly(invoice.invoice_date),
      posting_time: invoice.posting_time,
      item_code: item.item_code,
      item_name: item.item_name,
      warehouse: item.warehouse,
      voucher_type: 'invoice',
      voucher_id: Number(id),
      voucher_no: invoice.invoice_no,
      qty_change: -Math.abs(Number(item.quantity || 0)),
    }));
    const costRate = movement.outgoing_rate;
    const costAmount = roundMoney(Math.abs(Number(item.quantity || 0)) * costRate);
    totalCost += costAmount;
    const grossProfit = roundMoney(Number(item.line_total || 0) - costAmount);
    lineCosts.push({ id: Number(item.id), cost_rate: costRate, cost_amount: costAmount,
      gross_profit: grossProfit, stock_at_sale: movement.previous_quantity });
  }

  if (lineCosts.length) await postingStage('line_costs', () => client.query(`
    UPDATE app_invoice_items item SET cost_rate = costs.cost_rate, cost_amount = costs.cost_amount,
      gross_profit = costs.gross_profit, stock_at_sale = costs.stock_at_sale
    FROM jsonb_to_recordset($1::jsonb) AS costs(id bigint, cost_rate numeric, cost_amount numeric,
      gross_profit numeric, stock_at_sale numeric)
    WHERE item.id = costs.id AND item.invoice_pk = $2`, [JSON.stringify(lineCosts), Number(id)]));
  await setVoucherDocstatus(client, 'app_invoices', Number(id), 'submitted');
  await postingStage('payment_totals', () => syncPostgresInvoicePaymentTotals(client, Number(id)));
  await postingStage('accounting', () => postSalesInvoiceGlEntry(client, {
    ...invoice,
    id: Number(id),
    total_cost: roundMoney(totalCost),
  }));
  const { rows: paymentRows } = await client.query(
    `
    SELECT id, payment_no, payment_date, amount, method, account_id, reference, notes, journal_entry_id
    FROM app_invoice_payments
    WHERE invoice_id = $1
    ORDER BY payment_no
    `,
    [Number(id)],
  );
  for (const payment of paymentRows) {
    await createOrUpdatePaymentJournalEntry(client, invoice, payment);
  }
  return Number(id);
}

async function submitCashSaleInvoice(id, payment) {
  return withPostgresTransaction(async (client) => {
    const { rows: invoiceRows } = await client.query(
      'SELECT * FROM app_invoices WHERE id = $1 FOR UPDATE',
      [Number(id)],
    );
    const invoice = invoiceRows[0];
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if ((invoice.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft invoices can be submitted.');
      err.status = 400;
      throw err;
    }

    const { rows: itemRows } = await client.query(
      `
      SELECT *
      FROM app_invoice_items
      WHERE invoice_pk = $1
      ORDER BY line_no
      `,
      [Number(id)],
    );

    await beginInventoryPosting(client, 'invoice', Number(id), itemRows.map(item => item.warehouse));
    let totalCost = 0;
    for (const item of itemRows) {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: dateOnly(invoice.invoice_date),
        posting_time: invoice.posting_time,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'invoice',
        voucher_id: Number(id),
        voucher_no: invoice.invoice_no,
        qty_change: -Math.abs(Number(item.quantity || 0)),
      });
      const costRate = movement.outgoing_rate;
      const costAmount = roundMoney(Math.abs(Number(item.quantity || 0)) * costRate);
      totalCost += costAmount;
      const grossProfit = roundMoney(Number(item.line_total || 0) - costAmount);
      await client.query(
        `
        UPDATE app_invoice_items
        SET cost_rate = $1,
          cost_amount = $2,
          gross_profit = $3,
          stock_at_sale = $4
        WHERE id = $5
        `,
        [costRate, costAmount, grossProfit, movement.previous_quantity, Number(item.id)],
      );
    }

    await client.query('UPDATE app_invoices SET is_cash_sale = true WHERE id = $1', [Number(id)]);
    await setVoucherDocstatus(client, 'app_invoices', Number(id), 'submitted');
    await syncPostgresInvoicePaymentTotals(client, Number(id));

    const invoiceForGl = {
      ...invoice,
      id: Number(id),
      total_cost: roundMoney(totalCost),
    };
    await postSalesInvoiceGlEntry(client, invoiceForGl);

    const paymentData = buildPaymentData(payment, [], 1);
    const destination = paymentData.account_id ? await validateReceivingAccount(client, paymentData.account_id) : null;
    const { rows: paymentRows } = await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, account_id, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, payment_no, payment_date, amount, method, account_id, reference, notes, journal_entry_id
      `,
      [
        Number(id),
        paymentData.id,
        paymentData.payment_date,
        paymentData.amount,
        destination?.method || paymentData.method,
        destination?.id || null,
        paymentData.reference,
        paymentData.notes,
        paymentData.created_at,
      ],
    );
    await syncPostgresInvoicePaymentTotals(client, Number(id));
    await createOrUpdatePaymentJournalEntry(client, invoiceForGl, paymentRows[0]);
    return Number(id);
  });
}

async function cancelPostgresInvoice(id) {
  return withPostgresTransaction(async (client) => {
    const { rows: invoices } = await client.query(
      'SELECT id, invoice_no, docstatus FROM app_invoices WHERE id = $1 FOR UPDATE',
      [Number(id)],
    );
    const invoice = invoices[0];
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if ((invoice.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Only submitted invoices can be cancelled.');
      err.status = 400;
      throw err;
    }

    const postingDate = dateOnly(new Date());
    const { rows: stockRows } = await client.query(
      "SELECT * FROM app_stock_ledger WHERE voucher_type = 'invoice' AND voucher_id = $1 AND is_reversal = false ORDER BY id",
      [Number(id)],
    );
    await beginInventoryPosting(client, 'invoice', Number(id), stockRows.map(row => row.warehouse), true);
    for (const row of stockRows) {
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: row.item_code,
        item_name: row.item_name,
        warehouse: row.warehouse,
        voucher_type: 'invoice',
        voucher_id: Number(id),
        voucher_no: invoice.invoice_no,
        qty_change: -Number(row.qty_change),
        rate: Number(row.outgoing_rate || row.incoming_rate || 0),
        is_reversal: true,
        reversal_of_voucher_id: Number(id),
        reversal_of_voucher_no: invoice.invoice_no,
        remarks: `Cancellation of ${invoice.invoice_no}`,
      });
    }

    const { rows: payments } = await client.query(
      "SELECT id, journal_entry_id FROM app_invoice_payments WHERE invoice_id = $1 AND docstatus = 'submitted'",
      [Number(id)],
    );
    for (const payment of payments) {
      if (payment.journal_entry_id) {
        await reverseVoucherGlEntries(client, 'payment_journal', payment.journal_entry_id, postingDate);
        await setVoucherDocstatus(client, 'app_journal_entries', payment.journal_entry_id, 'cancelled');
      }
      await reverseVoucherGlEntries(client, 'customer_payment', payment.id, postingDate);
      await client.query("UPDATE app_invoice_payments SET docstatus = 'cancelled' WHERE id = $1", [payment.id]);
    }
    await reverseVoucherGlEntries(client, 'sales_invoice', Number(id), postingDate);
    const { rows: salesJournals } = await client.query(
      "SELECT id FROM app_journal_entries WHERE journal_type = 'sales_invoice' AND reference_no = $1",
      [invoice.invoice_no],
    );
    for (const journal of salesJournals) {
      await setVoucherDocstatus(client, 'app_journal_entries', journal.id, 'cancelled');
    }
    await syncPostgresInvoicePaymentTotals(client, Number(id));
    await setVoucherDocstatus(client, 'app_invoices', Number(id), 'cancelled');
    return Number(id);
  });
}

async function addPostgresInvoicePayment(id, payload) {
  await withPostgresTransaction(client => addPostgresInvoicePaymentInTransaction(client, id, payload));
  return Number(id);
}

async function addPostgresInvoicePaymentInTransaction(client, id, payload) {
  const { rows: invoiceRows } = await client.query(
    `
    SELECT id, invoice_no, customer_id, customer_name, docstatus, total
    FROM app_invoices
    WHERE id = $1
    FOR UPDATE
    `,
    [Number(id)],
  );
  const invoice = invoiceRows[0];
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  if ((invoice.docstatus || 'submitted') !== 'submitted') {
    const err = new Error('Submit the invoice before receiving payments.');
    err.status = 400;
    throw err;
  }

  const { rows: totalsRows } = await client.query(
    `
    SELECT
      COALESCE(MAX(payment_no), 0)::int AS max_payment_no,
      COALESCE(SUM(amount) FILTER (WHERE docstatus = 'submitted'), 0)::float AS amount_paid
    FROM app_invoice_payments
    WHERE invoice_id = $1
    `,
    [Number(id)],
  );
  const totals = totalsRows[0] || {};
  const nextPaymentNo = Number(totals.max_payment_no || 0) + 1;
  const payment = buildPaymentData(payload, [], nextPaymentNo);
  const destination = payment.account_id ? await validateReceivingAccount(client, payment.account_id) : null;
  const { rows: journalTotals } = await client.query(
    `
    SELECT COALESCE(SUM(journal_payment.amount), 0)::float AS amount_paid
    FROM (
      SELECT journal.id, SUM(line.credit - line.debit) AS amount
      FROM app_journal_entries journal
      JOIN app_journal_entry_lines line ON line.journal_entry_id = journal.id
      JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
        AND setting.account_id = line.account_id
      WHERE COALESCE(NULLIF(line.reference_no, ''), journal.reference_no) = $1 AND journal.docstatus = 'submitted'
        AND journal.party_type = 'customer'
        AND (NULLIF(journal.party_id, '') = NULLIF($2, '') OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = $3))
        AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
        AND NOT EXISTS (SELECT 1 FROM app_invoice_payments payment WHERE payment.journal_entry_id = journal.id)
      GROUP BY journal.id
      HAVING SUM(line.credit - line.debit) > 0
    ) journal_payment
    `,
    [invoice.invoice_no, invoice.customer_id, invoice.customer_name],
  );
  const balanceDue = roundMoney(Number(invoice.total || 0) - Number(totals.amount_paid || 0) - Number(journalTotals[0].amount_paid || 0));
  if (payment.amount > balanceDue) {
    const err = new Error('Payment amount cannot exceed the invoice balance.');
    err.status = 400;
    throw err;
  }

  const { rows: paymentRows } = await client.query(
    `
    INSERT INTO app_invoice_payments (
      invoice_id, payment_no, payment_date, amount, method, account_id, reference, notes, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id, payment_no, payment_date, amount, method, account_id, reference, notes, journal_entry_id
    `,
    [
      Number(id),
      payment.id,
      payment.payment_date,
      payment.amount,
      destination?.method || payment.method,
      destination?.id || null,
      payment.reference,
      payment.notes,
      payment.created_at,
    ],
  );
  await syncPostgresInvoicePaymentTotals(client, Number(id));
  await createOrUpdatePaymentJournalEntry(client, invoice, paymentRows[0]);
  return Number(id);
}

async function cancelPostgresInvoicePayment(id, paymentId) {
  if (!Number.isSafeInteger(Number(paymentId)) || Number(paymentId) < 1) {
    const err = new Error('Payment not found.');
    err.status = 404;
    throw err;
  }
  return withPostgresTransaction(async (client) => {
    const { rows: invoices } = await client.query(
      'SELECT id, docstatus FROM app_invoices WHERE id = $1 FOR UPDATE', [Number(id)],
    );
    if (!invoices[0]) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if (invoices[0].docstatus !== 'submitted') {
      const err = new Error('Only payments on submitted invoices can be cancelled.');
      err.status = 400;
      throw err;
    }
    const { rows: payments } = await client.query(
      'SELECT id, journal_entry_id, docstatus FROM app_invoice_payments WHERE invoice_id = $1 AND payment_no = $2 FOR UPDATE',
      [Number(id), Number(paymentId)],
    );
    const payment = payments[0];
    if (!payment) {
      const err = new Error('Payment not found.');
      err.status = 404;
      throw err;
    }
    if (payment.docstatus !== 'submitted') {
      const err = new Error('Payment is already cancelled.');
      err.status = 400;
      throw err;
    }
    const postingDate = dateOnly(new Date());
    if (payment.journal_entry_id) {
      await reverseVoucherGlEntries(client, 'payment_journal', payment.journal_entry_id, postingDate);
      await client.query("UPDATE app_journal_entries SET docstatus = 'cancelled' WHERE id = $1", [payment.journal_entry_id]);
    }
    await reverseVoucherGlEntries(client, 'customer_payment', payment.id, postingDate);
    await client.query("UPDATE app_invoice_payments SET docstatus = 'cancelled' WHERE id = $1", [payment.id]);
    await syncPostgresInvoicePaymentTotals(client, Number(id));
    return Number(id);
  });
}

async function postgresInvoiceSummary() {
  const { rows } = await getPostgresPool().query(`
    WITH ${postgresInvoiceBalancesCte()}
    SELECT
      COUNT(*)::int AS invoice_count,
      COALESCE(SUM(total), 0)::float AS invoice_total,
      COALESCE(SUM(amount_paid), 0)::float AS paid_total,
      (SELECT COALESCE(SUM(balance_due), 0)::float FROM (
        SELECT SUM(debit - credit) AS balance_due
        FROM ar_ledger
        WHERE party_type = 'customer'
          AND COALESCE(NULLIF(party_id, ''), party_name) IS NOT NULL
        GROUP BY COALESCE(NULLIF(party_id, ''), party_name)
        HAVING SUM(debit - credit) > 0
      ) debtors) AS balance_due
    FROM invoice_balances
    WHERE docstatus = 'submitted'
  `);
  return rows[0] || {
    invoice_count: 0,
    invoice_total: 0,
    paid_total: 0,
    balance_due: 0,
  };
}

async function postgresTopDebtors(limit = 10) {
  const { rows } = await getPostgresPool().query(
    `
    SELECT COALESCE(NULLIF(gl.party_id, ''), gl.party_name) AS customer_key,
      MAX(gl.party_name) AS customer_name,
      SUM(gl.debit - gl.credit)::float AS balance_due
    FROM app_gl_entries gl
    JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
      AND setting.account_id = gl.account_id
    WHERE gl.party_type = 'customer'
      AND COALESCE(NULLIF(gl.party_id, ''), gl.party_name) IS NOT NULL
    GROUP BY COALESCE(NULLIF(gl.party_id, ''), gl.party_name)
    HAVING SUM(gl.debit - gl.credit) > 0
    ORDER BY SUM(gl.debit - gl.credit) DESC
    LIMIT $1
    `,
    [Number(limit)],
  );
  return rows;
}

async function hydratePostgresInvoices(invoiceRows) {
  if (!invoiceRows.length) {
    return [];
  }

  const ids = invoiceRows.map((row) => Number(row.id));
  const [itemResult, paymentResult, journalResult] = await Promise.all([
    getPostgresPool().query(
      `
      SELECT *
      FROM app_invoice_items
      WHERE invoice_pk = ANY($1::bigint[])
      ORDER BY invoice_pk, line_no
      `,
      [ids],
    ),
    getPostgresPool().query(
      `
      SELECT payment.*, account.account_name
      FROM app_invoice_payments payment
      LEFT JOIN app_accounts account ON account.id = payment.account_id
      WHERE payment.invoice_id = ANY($1::bigint[])
      ORDER BY payment.invoice_id, payment.payment_no
      `,
      [ids],
    ),
    getPostgresPool().query(
      `
      WITH requested_invoices AS MATERIALIZED (
        SELECT * FROM app_invoices WHERE id=ANY($1::bigint[])
      ), candidate_journals AS MATERIALIZED (
        SELECT journal.id FROM app_journal_entries journal
        WHERE journal.party_type='customer' AND journal.docstatus IN ('submitted','cancelled')
          AND journal.journal_type IN ('cash_receipt','payment_journal','journal_entry')
          AND journal.reference_no IN (SELECT invoice_no FROM requested_invoices)
        UNION
        SELECT line.journal_entry_id AS id FROM app_journal_entry_lines line
        WHERE line.reference_no IS NOT NULL AND line.reference_no<>''
          AND line.reference_no IN (SELECT invoice_no FROM requested_invoices)
      )
      SELECT invoice.id AS invoice_id, journal.id AS journal_id, journal.journal_no,
        journal.posting_date::text AS payment_date, journal.docstatus,
        journal.remarks, journal.created_at, journal.updated_at,
        SUM(line.credit - line.debit)::float AS amount
      FROM requested_invoices invoice
      JOIN candidate_journals candidate ON true
      JOIN app_journal_entries journal ON journal.id=candidate.id
        AND journal.party_type = 'customer'
        AND (NULLIF(journal.party_id, '') = NULLIF(invoice.customer_id, '')
          OR (COALESCE(journal.party_id, '') = '' AND journal.party_name = invoice.customer_name))
        AND journal.journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
        AND journal.docstatus IN ('submitted', 'cancelled')
      JOIN app_journal_entry_lines line ON line.journal_entry_id = journal.id
      JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
        AND setting.account_id = line.account_id
      WHERE invoice.id = ANY($1::bigint[])
        AND COALESCE(NULLIF(line.reference_no, ''), journal.reference_no) = invoice.invoice_no
        AND NOT EXISTS (
          SELECT 1 FROM app_invoice_payments payment
          WHERE payment.journal_entry_id = journal.id
        )
      GROUP BY invoice.id, journal.id
      HAVING SUM(line.credit - line.debit) > 0
      ORDER BY journal.posting_date, journal.id
      `,
      [ids],
    ),
  ]);

  const itemsByInvoice = groupByInvoiceId(itemResult.rows);
  const paymentsByInvoice = groupByInvoiceId(paymentResult.rows);
  const journalPaymentsByInvoice = groupByInvoiceId(journalResult.rows);
  return invoiceRows.map((row) => normalizeInvoiceTotals({
    ...recordAuditFields(row),
    id: Number(row.id),
    invoice_no: row.invoice_no,
    non_system_invoice: row.non_system_invoice,
    docstatus: row.docstatus,
    is_cash_sale: row.is_cash_sale,
    invoice_date: dateOnly(row.invoice_date),
    posting_time: storedPostingTime(row.posting_time),
    due_date: dateOnly(row.due_date),
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    price_list: row.price_list,
    cost_center: row.cost_center,
    invoicer_id: row.invoicer_id,
    invoicer: row.invoicer,
    notes: row.notes,
    subtotal: Number(row.subtotal || 0),
    tax_amount: Number(row.tax_amount || 0),
    discount_amount: Number(row.discount_amount || 0),
    total: Number(row.total || 0),
    amount_paid: Number(row.amount_paid || 0),
    status: row.status,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    submitted_by: row.submitted_by,
    submitted_by_user_id: row.submitted_by_user_id,
    submitted_at: nullableIsoString(row.submitted_at),
    cancelled_by: row.cancelled_by,
    cancelled_by_user_id: row.cancelled_by_user_id,
    cancelled_at: nullableIsoString(row.cancelled_at),
    items: (itemsByInvoice.get(Number(row.id)) || []).map(postgresItemToInvoiceItem),
    payments: [
      ...(paymentsByInvoice.get(Number(row.id)) || []).map(postgresPaymentToInvoicePayment),
      ...(journalPaymentsByInvoice.get(Number(row.id)) || []).map((journal) => ({
        id: `journal-${journal.journal_id}`,
        journal_id: Number(journal.journal_id),
        docstatus: journal.docstatus,
        payment_date: journal.payment_date,
        amount: Number(journal.amount),
        method: 'Journal Entry',
        reference: journal.journal_no,
        notes: journal.remarks,
        created_at: toIsoString(journal.created_at),
        updated_at: toIsoString(journal.updated_at),
      })),
    ],
  }));
}

function invoiceParams(invoiceData) {
  return [
    invoiceData.invoice_date,
    invoiceData.due_date,
    invoiceData.customer_id,
    invoiceData.customer_name,
    invoiceData.customer_phone,
    invoiceData.notes,
    invoiceData.subtotal,
    invoiceData.tax_amount,
    invoiceData.discount_amount,
    invoiceData.total,
    invoiceData.amount_paid,
    invoiceData.status,
    invoiceData.price_list,
    invoiceData.posting_time,
    invoiceData.non_system_invoice,
  ];
}

async function insertPostgresItems(client, invoiceId, invoiceNo, items) {
  await populateInvoiceItemDetails(client, items);
  if (!items?.length) return;
  // Keep master snapshots and normalized values identical to individual inserts.
  // Row audit triggers still stamp every inserted line on this connection.
  const lines = items.map(item => ({
    line_no: item.line_no ?? item.id,
    item_code: item.item_code, item_name: item.item_name, warehouse: item.warehouse,
    quantity: item.quantity, unit_price: item.unit_price, stock_at_sale: item.stock_at_sale,
    line_total: item.line_total, cost_rate: item.cost_rate || 0,
    cost_amount: item.cost_amount || 0, gross_profit: item.gross_profit || 0,
    item_category: item.item_category, source: item.source, cost: item.cost,
  }));
  await client.query(`
    INSERT INTO app_invoice_items (
      invoice_pk, invoice_id, invoice_no, line_no, item_code, item_name, warehouse,
      quantity, unit_price, stock_at_sale, line_total, cost_rate, cost_amount, gross_profit,
      item_category, source, cost
    )
    SELECT $1, $1, $2, line.line_no, line.item_code, line.item_name, line.warehouse,
      line.quantity, line.unit_price, line.stock_at_sale, line.line_total,
      line.cost_rate, line.cost_amount, line.gross_profit, line.item_category, line.source, line.cost
    FROM jsonb_to_recordset($3::jsonb) AS line(
      line_no integer, item_code text, item_name text, warehouse text,
      quantity numeric, unit_price numeric, stock_at_sale numeric, line_total numeric,
      cost_rate numeric, cost_amount numeric, gross_profit numeric,
      item_category text, source text, cost numeric
    ) ORDER BY line.line_no`, [invoiceId, invoiceNo, JSON.stringify(lines)]);
}

async function syncPostgresInvoiceItems(client, invoiceId, invoiceNo, items) {
  await populateInvoiceItemDetails(client, items);
  const existingResult = await client.query(
    'SELECT id FROM app_invoice_items WHERE invoice_pk = $1',
    [invoiceId],
  );
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.id)));
  const seenIds = new Set();

  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    const lineNo = index + 1;
    const dbId = Number(item.db_id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      await client.query(
        `
        UPDATE app_invoice_items
        SET line_no = $1,
          item_code = $2,
          item_name = $3,
          warehouse = $4,
          quantity = $5,
          unit_price = $6,
          stock_at_sale = $7,
          line_total = $8,
          item_category = $9,
          source = $10,
          cost = $11
        WHERE id = $12
          AND invoice_pk = $13
        `,
        [
          lineNo,
          item.item_code,
          item.item_name,
          item.warehouse,
          item.quantity,
          item.unit_price,
          item.stock_at_sale,
          item.line_total,
          item.item_category,
          item.source,
          item.cost,
          dbId,
          invoiceId,
        ],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingIds) {
    if (!seenIds.has(dbId)) {
      await client.query(
        'DELETE FROM app_invoice_items WHERE id = $1 AND invoice_pk = $2',
        [dbId, invoiceId],
      );
    }
  }

  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    const dbId = Number(item.db_id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      continue;
    }
    const lineNo = index + 1;
    await client.query(
      `
      INSERT INTO app_invoice_items (
        invoice_pk, invoice_id, invoice_no, line_no, item_code, item_name, warehouse,
        quantity, unit_price, stock_at_sale, line_total, cost_rate, cost_amount, gross_profit,
        item_category, source, cost
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `,
      [
        invoiceId,
        invoiceId,
        invoiceNo,
        lineNo,
        item.item_code,
        item.item_name,
        item.warehouse,
        item.quantity,
        item.unit_price,
        item.stock_at_sale,
        item.line_total,
        item.cost_rate || 0,
        item.cost_amount || 0,
        item.gross_profit || 0,
        item.item_category,
        item.source,
        item.cost,
      ],
    );
  }
}

async function populateInvoiceItemDetails(client, items) {
  if (!items?.length) return;
  const codes = [...new Set(items.map((item) => item.item_code))];
  const { rows } = await client.query(`SELECT item_code, category, source, unit_cost::float
    FROM app_master_items WHERE item_code = ANY($1::text[])`, [codes]);
  const byCode = new Map(rows.map((row) => [row.item_code, row]));
  for (const item of items) {
    const master = byCode.get(item.item_code);
    item.item_category = master?.category || null;
    item.source = master?.source || null;
    item.cost = Number(master?.unit_cost || 0);
  }
}

async function insertPostgresPayments(client, invoiceId, payments) {
  for (const payment of payments || []) {
    const destination = payment.account_id ? await validateReceivingAccount(client, payment.account_id) : null;
    await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, account_id, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        invoiceId,
        payment.id,
        payment.payment_date,
        payment.amount,
        destination?.method || payment.method,
        destination?.id || null,
        payment.reference,
        payment.notes,
        payment.created_at,
      ],
    );
  }
}
module.exports = {
  updatePostgresInvoiceInTransaction,
  createPostgresInvoiceInTransaction,
  submitPostgresInvoiceInTransaction,
  addPostgresInvoicePaymentInTransaction,
  allInvoices,
  paginatedInvoices,
  invoiceWarehouses,
  findInvoice,
  invoiceForPayment,
  createInvoice,
  updateInvoice,
  submitInvoice,
  cancelInvoice,
  addInvoicePayment,
  cancelInvoicePayment,
  invoiceSummary,
  topDebtors,
  debtorReport,
  postgresInvoiceBalancesCte,
  postgresDebtorReport,
  resolvePostgresDebtorSelection,
  postgresCustomerStatement,
  allPostgresInvoices,
  paginatedPostgresInvoices,
  postgresInvoiceListRow,
  findPostgresInvoice,
  createPostgresInvoice,
  createCashSaleInvoice,
  updatePostgresInvoice,
  submitPostgresInvoice,
  submitCashSaleInvoice,
  cancelPostgresInvoice,
  addPostgresInvoicePayment,
  cancelPostgresInvoicePayment,
  postgresInvoiceSummary,
  postgresTopDebtors,
  hydratePostgresInvoices,
  invoiceParams,
  insertPostgresItems,
  syncPostgresInvoiceItems,
  insertPostgresPayments,
};
