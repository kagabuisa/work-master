const fs = require('fs/promises');
const path = require('path');
const { AuditPool, auditActor, initRecordAudit, recordAuditFields, stampRecord, stampRecordList } = require('./audit');
require('dotenv').config({ quiet: true });

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'invoices.json');
const STOCK_ENTRY_TYPES = ['opening', 'purchase', 'transfer', 'adjustment', 'cancel'];
const JOURNAL_TYPES = ['cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'];
const PAYMENT_METHODS = new Set(['cash', 'bank', 'mobile_money', 'card', 'other']);
let storeWriteQueue = Promise.resolve();

function withStoreLock(task) {
  const run = storeWriteQueue.then(task, task);
  storeWriteQueue = run.catch(() => {});
  return run;
}
const DEFAULT_ACCOUNTS = [
  { code: '1100', name: 'Accounts Receivable', type: 'asset', normal: 'debit', key: 'accounts_receivable' },
  { code: '1110', name: 'Cash', type: 'asset', normal: 'debit', key: 'cash' },
  { code: '1120', name: 'Bank', type: 'asset', normal: 'debit', key: 'bank' },
  { code: '1130', name: 'Mobile Money', type: 'asset', normal: 'debit', key: 'mobile_money' },
  { code: '1140', name: 'Card Clearing', type: 'asset', normal: 'debit', key: 'card_clearing' },
  { code: '1200', name: 'Inventory', type: 'asset', normal: 'debit', key: 'inventory' },
  { code: '2100', name: 'Accounts Payable', type: 'liability', normal: 'credit', key: 'accounts_payable' },
  { code: '2200', name: 'Tax Payable', type: 'liability', normal: 'credit', key: 'tax_payable' },
  { code: '3000', name: 'Opening Equity', type: 'equity', normal: 'credit', key: 'opening_equity' },
  { code: '4000', name: 'Sales Income', type: 'income', normal: 'credit', key: 'sales_income' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normal: 'debit', key: 'cost_of_goods_sold' },
  { code: '5100', name: 'Stock Adjustment Loss', type: 'expense', normal: 'debit', key: 'stock_adjustment_loss' },
  { code: '4100', name: 'Stock Adjustment Gain', type: 'income', normal: 'credit', key: 'stock_adjustment_gain' },
];
let postgresPool;

async function initStore() {
  if (usePostgresStore()) {
    await initPostgresStore();
    return;
  }

  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await writeStore({ nextId: 1, invoices: [] });
  }
}

const companyInformationFields = {
  name: 200,
  address: 1000,
  phone: 100,
  email: 254,
  website: 254,
  tax_id: 100,
  registration_number: 100,
};

function normalizeCompanyInformation(payload = {}) {
  return Object.fromEntries(Object.keys(companyInformationFields).map((field) => [
    field, String(payload[field] || '').trim(),
  ]));
}

async function getCompanyInformation() {
  if (usePostgresStore()) {
    const { rows } = await getPostgresPool().query('SELECT * FROM app_company_information WHERE id = 1');
    return { ...normalizeCompanyInformation(rows[0]?.details), ...recordAuditFields(rows[0]) };
  }
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'company.json'), 'utf8'));
    return { ...normalizeCompanyInformation(saved), ...recordAuditFields(saved) };
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeCompanyInformation();
    throw error;
  }
}

async function saveCompanyInformation(payload) {
  const company = normalizeCompanyInformation(payload);
  const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
  if (!company.name) fail('Company name is required.');
  for (const [field, limit] of Object.entries(companyInformationFields)) {
    if (company[field].length > limit) fail(`${field.replaceAll('_', ' ')} must be ${limit} characters or fewer.`);
  }
  if (company.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) {
    fail('Enter a valid company email address.');
  }
  if (usePostgresStore()) {
    await getPostgresPool().query(`
      INSERT INTO app_company_information (id, details) VALUES (1, $1::jsonb)
      ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details
    `, [JSON.stringify(company)]);
  } else {
    await fs.mkdir(dataDir, { recursive: true });
    let previous;
    try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'company.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    stampRecord(company, previous);
    const temporaryFile = path.join(dataDir, `company.${require('node:crypto').randomUUID()}.tmp`);
    await fs.writeFile(temporaryFile, JSON.stringify(company, null, 2));
    await fs.rename(temporaryFile, path.join(dataDir, 'company.json'));
  }
  return company;
}

async function allInvoices() {
  if (usePostgresStore()) {
    return allPostgresInvoices();
  }

  const store = await readStore();
  return store.invoices.map(normalizeInvoiceTotals).sort((a, b) => b.id - a.id);
}

async function paginatedInvoices(options = {}) {
  if (usePostgresStore()) {
    return paginatedPostgresInvoices(options);
  }

  const search = String(options.search || '').trim();
  const from = String(options.from || '').trim();
  const to = String(options.to || '').trim();
  const warehouse = String(options.warehouse || '').trim().toLowerCase();
  const pagination = paginationOptions(options, 50, 200);
  let invoices = await allInvoices();
  if (Array.isArray(options.allowedGroups)) {
    const { rows } = await getPostgresPool().query(
      'SELECT customer_id FROM app_master_customers WHERE LOWER(TRIM(COALESCE(customer_group, \'\'))) = ANY($1::text[])',
      [options.allowedGroups],
    );
    const allowedIds = new Set(rows.map((row) => row.customer_id));
    invoices = invoices.filter((invoice) => allowedIds.has(invoice.customer_id));
  }
  if (search) {
    invoices = invoices.filter((invoice) => (
      matchesSearchPattern(invoice.invoice_no, search)
      || matchesSearchPattern(invoice.invoice_date, search)
      || matchesSearchPattern(invoice.customer_name, search)
      || matchesSearchPattern(invoice.total, search)
      || matchesSearchPattern(invoice.amount_paid, search)
      || matchesSearchPattern(invoice.status, search)
      || matchesSearchPattern(invoice.docstatus || 'submitted', search)
    ));
  }
  if (from) {
    invoices = invoices.filter((invoice) => String(invoice.invoice_date || '') >= from);
  }
  if (to) {
    invoices = invoices.filter((invoice) => String(invoice.invoice_date || '') <= to);
  }
  if (warehouse) {
    invoices = invoices.filter((invoice) => (invoice.items || []).some((item) => (
      String(item.warehouse || '').trim().toLowerCase() === warehouse
    )));
  }
  const total = invoices.length;
  const rows = invoices.slice(pagination.offset, pagination.offset + pagination.limit);
  return { rows, pagination: paginationResult(total, pagination) };
}

async function invoiceWarehouses() {
  if (usePostgresStore()) {
    const { rows } = await getPostgresPool().query(`
      SELECT DISTINCT warehouse
      FROM app_invoice_items
      WHERE COALESCE(warehouse, '') <> ''
      ORDER BY warehouse
    `);
    return rows.map((row) => row.warehouse);
  }

  const invoices = await allInvoices();
  return [...new Set(invoices.flatMap((invoice) => (
    (invoice.items || []).map((item) => String(item.warehouse || '').trim()).filter(Boolean)
  )))].sort();
}

async function findInvoice(id) {
  if (usePostgresStore()) {
    return findPostgresInvoice(id);
  }

  const store = await readStore();
  const invoice = store.invoices.find((row) => row.id === Number(id));
  return invoice ? normalizeInvoiceTotals(invoice) : invoice;
}

async function invoiceForPayment(id) {
  if (!usePostgresStore()) {
    const err = new Error('Invoice payments require Postgres storage.');
    err.status = 400;
    throw err;
  }
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
  if (usePostgresStore()) {
    return createPostgresInvoice(payload);
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const invoiceData = buildInvoiceData(payload);
    const id = store.nextId;

    store.nextId += 1;
    store.invoices.push({
      id,
      invoice_no: `INV-${String(id).padStart(6, '0')}`,
      docstatus: 'draft',
      is_cash_sale: payload.is_cash_sale === true,
      ...invoiceData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await writeStore(store);
    return id;
  });
}

async function updateInvoice(id, payload) {
  if (usePostgresStore()) {
    return updatePostgresInvoice(id, payload);
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const invoice = store.invoices.find((row) => row.id === Number(id));
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if ((invoice.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Submitted invoices cannot be edited.');
      err.status = 400;
      throw err;
    }

    Object.assign(invoice, buildInvoiceData(payload), {
      updated_at: new Date().toISOString(),
    });
    await writeStore(store);
    return invoice.id;
  });
}

async function submitInvoice(id) {
  if (usePostgresStore()) {
    return submitPostgresInvoice(id);
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const invoice = store.invoices.find((row) => row.id === Number(id));
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
    invoice.docstatus = 'submitted';
    const actor = actorAuditValues();
    invoice.submitted_by = actor.by;
    invoice.submitted_by_user_id = actor.by_user_id;
    invoice.submitted_at = actor.at;
    invoice.updated_at = new Date().toISOString();
    await writeStore(store);
    return invoice.id;
  });
}

async function cancelInvoice(id) {
  if (usePostgresStore()) return cancelPostgresInvoice(id);
  return withStoreLock(async () => {
    const store = await readStore();
    const invoice = store.invoices.find((row) => row.id === Number(id));
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
    invoice.docstatus = 'cancelled';
    const actor = actorAuditValues();
    invoice.cancelled_by = actor.by;
    invoice.cancelled_by_user_id = actor.by_user_id;
    invoice.cancelled_at = actor.at;
    invoice.updated_at = new Date().toISOString();
    await writeStore(store);
    return invoice.id;
  });
}

async function addInvoicePayment(id, payload) {
  if (usePostgresStore()) {
    return addPostgresInvoicePayment(id, payload);
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const invoice = store.invoices.find((row) => row.id === Number(id));
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    normalizeInvoiceTotals(invoice);
    if ((invoice.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Submit the invoice before receiving payments.');
      err.status = 400;
      throw err;
    }

    const payments = normalizePayments(invoice);
    const payment = buildPaymentData(payload, payments);
    const balanceDue = roundMoney(Number(invoice.total || 0) - sumPayments(payments));
    if (payment.amount > balanceDue) {
      const err = new Error('Payment amount cannot exceed the invoice balance.');
      err.status = 400;
      throw err;
    }

    payments.push(payment);
    invoice.payments = payments;
    applyPaymentTotals(invoice);
    invoice.updated_at = new Date().toISOString();

    await writeStore(store);
    return invoice.id;
  });
}

async function cancelInvoicePayment(id, paymentId) {
  if (usePostgresStore()) return cancelPostgresInvoicePayment(id, paymentId);
  return withStoreLock(async () => {
    const store = await readStore();
    const invoice = store.invoices.find((row) => row.id === Number(id));
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if ((invoice.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Only payments on submitted invoices can be cancelled.');
      err.status = 400;
      throw err;
    }
    const payments = normalizePayments(invoice);
    const payment = payments.find((row) => Number(row.id) === Number(paymentId));
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
    payment.docstatus = 'cancelled';
    invoice.payments = payments;
    applyPaymentTotals(invoice);
    invoice.updated_at = new Date().toISOString();
    await writeStore(store);
    return invoice.id;
  });
}

async function invoiceSummary() {
  if (usePostgresStore()) {
    return postgresInvoiceSummary();
  }

  const store = await readStore();
  return store.invoices.map(normalizeInvoiceTotals).filter(isSubmitted).reduce((summary, invoice) => {
    summary.invoice_count += 1;
    summary.invoice_total += Number(invoice.total || 0);
    summary.paid_total += Number(invoice.amount_paid || 0);
    summary.balance_due += Number(invoice.total || 0) - Number(invoice.amount_paid || 0);
    return summary;
  }, {
    invoice_count: 0,
    invoice_total: 0,
    paid_total: 0,
    balance_due: 0,
  });
}

async function topDebtors(limit = 10) {
  if (usePostgresStore()) {
    return postgresTopDebtors(limit);
  }

  const store = await readStore();
  const balances = new Map();
  for (const invoice of store.invoices.map(normalizeInvoiceTotals).filter(isSubmitted)) {
    const balance = Number(invoice.total || 0) - Number(invoice.amount_paid || 0);
    if (balance > 0) {
      balances.set(invoice.customer_name, (balances.get(invoice.customer_name) || 0) + balance);
    }
  }
  return [...balances.entries()]
    .map(([customer_name, balance_due]) => ({ customer_name, balance_due }))
    .sort((a, b) => b.balance_due - a.balance_due)
    .slice(0, limit);
}

async function debtorReport(options = {}) {
  if (usePostgresStore()) {
    return postgresDebtorReport(options);
  }

  const search = String(options.search || '').trim().toLowerCase();
  const selectedCustomer = String(options.customer || '').trim();
  const from = String(options.from || '').trim();
  const to = String(options.to || '').trim();
  const statementFrom = String(options.statementFrom || '').trim();
  const statementTo = String(options.statementTo || '').trim();
  const submittedInvoices = (await allInvoices()).filter(isSubmitted);
  const invoices = submittedInvoices
    .filter((invoice) => dateInRange(invoice.invoice_date, from, to));

  const customers = new Map();
  for (const invoice of invoices) {
    const customerKey = customerReportKey(invoice);
    const balanceDue = roundMoney(Number(invoice.total || 0) - Number(invoice.amount_paid || 0));
    if (!customers.has(customerKey)) {
      customers.set(customerKey, {
        customer_key: customerKey,
        customer_id: invoice.customer_id || '',
        customer_name: invoice.customer_name,
        invoice_count: 0,
        invoice_total: 0,
        paid_total: 0,
        balance_due: 0,
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_over_90: 0,
      });
    }

    const row = customers.get(customerKey);
    row.invoice_count += 1;
    row.invoice_total += Number(invoice.total || 0);
    row.paid_total += Number(invoice.amount_paid || 0);
    row.balance_due += balanceDue;
    if (balanceDue > 0) {
      row[agingBucket(invoice)] += balanceDue;
    }
  }

  const allCustomers = [...customers.values()].map(roundReportMoney);
  let debtors = allCustomers
    .filter((row) => row.balance_due > 0)
    .sort((a, b) => b.balance_due - a.balance_due);
  let customerResults = allCustomers
    .map(roundReportMoney)
    .sort((a, b) => b.balance_due - a.balance_due);

  if (search) {
    debtors = debtors.filter((row) => customerMatchesSearch(row, search));
    customerResults = customerResults.filter((row) => customerMatchesSearch(row, search));
  }

  const requestedSelected = selectedCustomer
    ? allCustomers.find((row) => row.customer_key === selectedCustomer)
    : null;
  const selected = requestedSelected && (!search || customerMatchesSearch(requestedSelected, search))
    ? requestedSelected
    : null;
  const fullStatement = selected ? buildCustomerStatement(submittedInvoices, selected.customer_key) : null;
  const statement = fullStatement ? filterStatementByDate(
    fullStatement,
    statementFrom || from,
    statementTo || to,
  ) : null;
  const paymentInvoice = fullStatement && fullStatement.find((entry) => (
    entry.type === 'Invoice' && Number(entry.balance_due || 0) > 0
  ));

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
    summary: debtors.reduce((summary, row) => {
      summary.customer_count += 1;
      summary.invoice_total += row.invoice_total;
      summary.paid_total += row.paid_total;
      summary.balance_due += row.balance_due;
      summary.current += row.current;
      summary.days_1_30 += row.days_1_30;
      summary.days_31_60 += row.days_31_60;
      summary.days_61_90 += row.days_61_90;
      summary.days_over_90 += row.days_over_90;
      return summary;
    }, emptyDebtorSummary()),
    debtors,
    customerResults,
    selected: selected ? roundReportMoney({ ...selected }) : null,
    statement,
    paymentInvoiceId: paymentInvoice ? paymentInvoice.invoice_id : null,
  };
}

async function postgresDebtorReport(options = {}) {
  assertPostgresAccounting();
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
  const groupedSql = `
    WITH grouped AS (
      SELECT
        COALESCE(NULLIF(customer_id, ''), customer_name) AS customer_key,
        MAX(customer_id) AS customer_id,
        customer_name,
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(total), 0)::float AS invoice_total,
        COALESCE(SUM(amount_paid), 0)::float AS paid_total,
        COALESCE(SUM(total - amount_paid), 0)::float AS balance_due,
        COALESCE(SUM(CASE WHEN total - amount_paid > 0 AND CURRENT_DATE - COALESCE(due_date, invoice_date) <= 0 THEN total - amount_paid ELSE 0 END), 0)::float AS current,
        COALESCE(SUM(CASE WHEN total - amount_paid > 0 AND CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 1 AND 30 THEN total - amount_paid ELSE 0 END), 0)::float AS days_1_30,
        COALESCE(SUM(CASE WHEN total - amount_paid > 0 AND CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 31 AND 60 THEN total - amount_paid ELSE 0 END), 0)::float AS days_31_60,
        COALESCE(SUM(CASE WHEN total - amount_paid > 0 AND CURRENT_DATE - COALESCE(due_date, invoice_date) BETWEEN 61 AND 90 THEN total - amount_paid ELSE 0 END), 0)::float AS days_61_90,
        COALESCE(SUM(CASE WHEN total - amount_paid > 0 AND CURRENT_DATE - COALESCE(due_date, invoice_date) > 90 THEN total - amount_paid ELSE 0 END), 0)::float AS days_over_90
      FROM app_invoices
      WHERE ${where.join(' AND ')}
      GROUP BY COALESCE(NULLIF(customer_id, ''), customer_name), customer_name
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
  const [summaryResult, countResult, customerResult] = await Promise.all([
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
        COALESCE(SUM(days_over_90), 0)::float AS days_over_90
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
  const params = [customerKey];
  const where = ["docstatus = 'submitted'", "COALESCE(NULLIF(customer_id, ''), customer_name) = $1"];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const { rows } = await getPostgresPool().query(
    `
    SELECT *
    FROM app_invoices
    WHERE ${where.join(' AND ')}
    ORDER BY invoice_date, id
    `,
    params,
  );
  const invoices = await hydratePostgresInvoices(rows);
  const fullStatement = buildCustomerStatement(invoices, customerKey);
  const paymentInvoice = fullStatement.find((entry) => (
    entry.type === 'Invoice' && Number(entry.balance_due || 0) > 0
  ));
  return {
    statement: filterStatementByDate(fullStatement, from, to),
    paymentInvoiceId: paymentInvoice ? paymentInvoice.invoice_id : null,
  };
}

function usePostgresStore() {
  return String(process.env.INVOICE_STORE || '').toLowerCase() === 'postgres';
}

function getPostgresPool() {
  if (!postgresPool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    postgresPool = new AuditPool(connectionString ? {
      connectionString,
      ssl: postgresSslConfig(),
    } : {
      host: postgresHost(),
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      ssl: postgresSslConfig(),
    });
  }
  return postgresPool;
}

function postgresHost() {
  const host = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
  return host === 'localhost' ? '127.0.0.1' : host;
}

async function closeStore() {
  if (postgresPool) {
    await postgresPool.end();
    postgresPool = null;
  }
}

function postgresSslConfig() {
  const value = String(process.env.PGSSL || process.env.POSTGRES_SSL || '').toLowerCase();
  return ['1', 'true', 'required', 'yes'].includes(value)
    ? { rejectUnauthorized: false }
    : undefined;
}

async function initPostgresStore() {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_items (
      item_code TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      stock_uom TEXT,
      category TEXT,
      description TEXT,
      default_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
      markup NUMERIC(14, 2) NOT NULL DEFAULT 0,
      qty_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      cbm_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      weight_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0,
      import_fob NUMERIC(14, 2) NOT NULL DEFAULT 0,
      exporter TEXT,
      source TEXT,
      photo_count_id TEXT,
      is_sales_item BOOLEAN NOT NULL DEFAULT true,
      is_purchase_item BOOLEAN NOT NULL DEFAULT true,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS markup NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS qty_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS cbm_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS weight_per_carton NUMERIC(14, 3) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS import_fob NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS exporter TEXT');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS source TEXT');
  await pool.query('ALTER TABLE app_master_items ADD COLUMN IF NOT EXISTS photo_count_id TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_customers (
      customer_id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_group TEXT,
      territory TEXT,
      phone TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_customers ADD COLUMN IF NOT EXISTS tin TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_suppliers (
      supplier_id TEXT PRIMARY KEY,
      supplier_name TEXT NOT NULL,
      supplier_type TEXT,
      phone TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_warehouses (
      warehouse TEXT PRIMARY KEY,
      warehouse_type TEXT,
      is_group BOOLEAN NOT NULL DEFAULT false,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_master_warehouses ADD COLUMN IF NOT EXISTS warehouse_type TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_employees (
      employee_id TEXT PRIMARY KEY,
      employee_name TEXT NOT NULL,
      status TEXT,
      company TEXT,
      department TEXT,
      designation TEXT,
      phone TEXT,
      email TEXT,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_cost_centers (
      cost_center TEXT PRIMARY KEY,
      cost_center_name TEXT NOT NULL,
      parent_cost_center TEXT,
      company TEXT,
      cost_center_type TEXT,
      is_group BOOLEAN NOT NULL DEFAULT false,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_master_options (
      id BIGSERIAL PRIMARY KEY,
      option_group TEXT NOT NULL,
      option_value TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (option_group, option_value)
    )
  `);
  for (const table of ['app_master_items', 'app_master_customers', 'app_master_suppliers', 'app_master_warehouses', 'app_master_employees', 'app_master_options']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS legacy_editable BOOLEAN NOT NULL DEFAULT true`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_company_information (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoices (
      id BIGSERIAL PRIMARY KEY,
      invoice_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'draft',
      invoice_date DATE NOT NULL,
      due_date DATE,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      notes TEXT,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
      tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE app_invoices ADD COLUMN IF NOT EXISTS is_cash_sale BOOLEAN');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoice_items (
      id BIGSERIAL PRIMARY KEY,
      invoice_pk BIGINT NOT NULL REFERENCES app_invoices(id) ON DELETE CASCADE,
      invoice_id BIGINT,
      invoice_no TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT,
      quantity NUMERIC(14, 3) NOT NULL,
      unit_price NUMERIC(14, 2) NOT NULL,
      stock_at_sale NUMERIC(14, 3),
      line_total NUMERIC(14, 2) NOT NULL,
      UNIQUE (invoice_pk, line_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_invoice_payments (
      id BIGSERIAL PRIMARY KEY,
      invoice_id BIGINT NOT NULL REFERENCES app_invoices(id) ON DELETE CASCADE,
      payment_no INTEGER NOT NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(14, 2) NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (invoice_id, payment_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchases (
      id BIGSERIAL PRIMARY KEY,
      purchase_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'draft',
      posting_date DATE NOT NULL,
      due_date DATE,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      supplier_reference TEXT,
      remarks TEXT,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_items (
      id BIGSERIAL PRIMARY KEY,
      purchase_id BIGINT NOT NULL REFERENCES app_purchases(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      quantity NUMERIC(14, 3) NOT NULL,
      unit_price NUMERIC(14, 2) NOT NULL,
      line_total NUMERIC(14, 2) NOT NULL,
      UNIQUE (purchase_id, line_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purchase_payments (
      id BIGSERIAL PRIMARY KEY,
      purchase_id BIGINT NOT NULL REFERENCES app_purchases(id) ON DELETE CASCADE,
      payment_no INTEGER NOT NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(14, 2) NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (purchase_id, payment_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_entries (
      id BIGSERIAL PRIMARY KEY,
      entry_no TEXT UNIQUE,
      entry_type TEXT NOT NULL,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      posting_date DATE NOT NULL,
      remarks TEXT,
      supplier_name TEXT,
      supplier_contact TEXT,
      supplier_phone TEXT,
      supplier_reference TEXT,
      cancelled_at TIMESTAMPTZ,
      cancellation_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_entry_items (
      id BIGSERIAL PRIMARY KEY,
      stock_entry_id BIGINT NOT NULL REFERENCES app_stock_entries(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT,
      target_warehouse TEXT,
      quantity NUMERIC(14, 3) NOT NULL,
      valuation_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      UNIQUE (stock_entry_id, line_no)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_balances (
      item_code TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
      stock_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
      valuation_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_code, warehouse)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_stock_ledger (
      id BIGSERIAL PRIMARY KEY,
      posting_date DATE NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      voucher_type TEXT NOT NULL,
      voucher_id BIGINT,
      voucher_no TEXT,
      qty_change NUMERIC(14, 3) NOT NULL,
      incoming_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      outgoing_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      stock_value_change NUMERIC(14, 2) NOT NULL DEFAULT 0,
      qty_after_transaction NUMERIC(14, 3) NOT NULL,
      stock_value_after_transaction NUMERIC(14, 2) NOT NULL,
      is_reversal BOOLEAN NOT NULL DEFAULT false,
      reversal_of_voucher_id BIGINT,
      reversal_of_voucher_no TEXT,
      remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounts (
      id BIGSERIAL PRIMARY KEY,
      account_code TEXT UNIQUE,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      normal_balance TEXT NOT NULL,
      parent_account_id BIGINT REFERENCES app_accounts(id),
      is_group BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
      CHECK (normal_balance IN ('debit', 'credit'))
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounting_settings (
      setting_key TEXT PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_gl_entries (
      id BIGSERIAL PRIMARY KEY,
      posting_date DATE NOT NULL,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      party_type TEXT,
      party_id TEXT,
      party_name TEXT,
      voucher_type TEXT NOT NULL,
      voucher_id BIGINT,
      voucher_no TEXT,
      line_no INTEGER NOT NULL,
      debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      is_reversal BOOLEAN NOT NULL DEFAULT false,
      reversal_of_voucher_type TEXT,
      reversal_of_voucher_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (debit >= 0 AND credit >= 0),
      CHECK (debit = 0 OR credit = 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_journal_entries (
      id BIGSERIAL PRIMARY KEY,
      journal_no TEXT UNIQUE,
      docstatus TEXT NOT NULL DEFAULT 'submitted',
      journal_type TEXT NOT NULL,
      posting_date DATE NOT NULL,
      party_type TEXT,
      party_id TEXT,
      party_name TEXT,
      reference_no TEXT,
      remarks TEXT,
      total_debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      total_credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'))
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_journal_entry_lines (
      id BIGSERIAL PRIMARY KEY,
      journal_entry_id BIGINT NOT NULL REFERENCES app_journal_entries(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      account_id BIGINT NOT NULL REFERENCES app_accounts(id),
      debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      UNIQUE (journal_entry_id, line_no),
      CHECK (debit >= 0 AND credit >= 0),
      CHECK (debit = 0 OR credit = 0)
    )
  `);
  for (const table of ['app_invoices', 'app_purchases', 'app_stock_entries', 'app_journal_entries']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_by TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_by TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_by_user_id TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  }
  await initRecordAudit(pool);
  if (!shouldRunStartupMigrations()) {
    return;
  }

  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS gross_profit NUMERIC(14, 2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_name TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_contact TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_phone TEXT');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS supplier_reference TEXT');
  await pool.query("ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE app_stock_entries ADD COLUMN IF NOT EXISTS cancellation_reason TEXT');
  await pool.query("UPDATE app_stock_entries SET docstatus = 'submitted' WHERE docstatus IS NULL OR docstatus = ''");
  await pool.query("ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN NOT NULL DEFAULT false");
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS reversal_of_voucher_id BIGINT');
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS reversal_of_voucher_no TEXT');
  await pool.query('ALTER TABLE app_stock_ledger ADD COLUMN IF NOT EXISTS remarks TEXT');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_balances_warehouse_idx
    ON app_stock_balances(warehouse)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_ledger_item_warehouse_date_idx
    ON app_stock_ledger(item_code, warehouse, posting_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_stock_ledger_voucher_idx
    ON app_stock_ledger(voucher_type, voucher_id)
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchases_date_idx ON app_purchases(posting_date DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS app_purchases_supplier_idx ON app_purchases(supplier_id, posting_date DESC)');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_purchases_supplier_reference_idx
    ON app_purchases(supplier_id, LOWER(supplier_reference))
    WHERE supplier_reference IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_gl_entries_voucher_line_idx
    ON app_gl_entries(voucher_type, voucher_id, line_no)
    WHERE voucher_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_account_date_idx
    ON app_gl_entries(account_id, posting_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_voucher_idx
    ON app_gl_entries(voucher_type, voucher_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_gl_entries_party_idx
    ON app_gl_entries(party_type, party_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_journal_entries_date_idx
    ON app_journal_entries(posting_date, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_journal_entry_lines_account_idx
    ON app_journal_entry_lines(account_id)
  `);
  await pool.query('ALTER TABLE app_invoice_payments ADD COLUMN IF NOT EXISTS journal_entry_id BIGINT REFERENCES app_journal_entries(id)');
  await pool.query("ALTER TABLE app_invoice_payments ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("ALTER TABLE app_purchase_payments ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("ALTER TABLE app_journal_entries ADD COLUMN IF NOT EXISTS docstatus TEXT NOT NULL DEFAULT 'submitted'");
  await pool.query("UPDATE app_journal_entries SET docstatus = 'submitted' WHERE docstatus IS NULL OR docstatus = ''");
  await pool.query('ALTER TABLE app_journal_entries DROP CONSTRAINT IF EXISTS app_journal_entries_journal_type_check');
  await pool.query(`
    ALTER TABLE app_journal_entries
    ADD CONSTRAINT app_journal_entries_journal_type_check
    CHECK (journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'))
  `);
  await migratePostgresInvoiceItems(pool);
  await seedDefaultAccounts(pool);
  await createPerformanceIndexes(pool);
  await syncAllPostgresInvoicePaymentTotals(pool);
  await backfillSalesInvoiceJournals(pool);
  await backfillInvoicePaymentJournals(pool);
}

function shouldRunStartupMigrations() {
  return !['0', 'false', 'no'].includes(String(process.env.APP_RUN_STARTUP_MIGRATIONS || 'true').toLowerCase());
}

async function createPerformanceIndexes(pool) {
  const optionalQueries = [
    'CREATE EXTENSION IF NOT EXISTS pg_trgm',
    'CREATE INDEX IF NOT EXISTS app_invoices_date_id_idx ON app_invoices(invoice_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_invoices_customer_trgm_idx ON app_invoices USING gin (LOWER(customer_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_invoices_no_trgm_idx ON app_invoices USING gin (LOWER(invoice_no) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_items_name_trgm_idx ON app_master_items USING gin (LOWER(item_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_items_code_trgm_idx ON app_master_items USING gin (LOWER(item_code) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_customers_name_trgm_idx ON app_master_customers USING gin (LOWER(customer_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_suppliers_name_trgm_idx ON app_master_suppliers USING gin (LOWER(supplier_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_employees_name_trgm_idx ON app_master_employees USING gin (LOWER(employee_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_employees_id_trgm_idx ON app_master_employees USING gin (LOWER(employee_id) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_cost_centers_name_trgm_idx ON app_master_cost_centers USING gin (LOWER(cost_center_name) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_master_cost_centers_id_trgm_idx ON app_master_cost_centers USING gin (LOWER(cost_center) gin_trgm_ops)',
    'CREATE INDEX IF NOT EXISTS app_stock_ledger_date_id_idx ON app_stock_ledger(posting_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_gl_entries_date_id_idx ON app_gl_entries(posting_date DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS app_gl_entries_party_name_trgm_idx ON app_gl_entries USING gin (LOWER(party_name) gin_trgm_ops)',
  ];
  for (const query of optionalQueries) {
    try {
      await pool.query(query);
    } catch (err) {
      console.warn(`Skipped optional performance index: ${err.message}`);
    }
  }
}

async function migratePostgresInvoiceItems(pool) {
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS invoice_pk BIGINT');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN IF NOT EXISTS invoice_no TEXT');
  await pool.query(`
    DO $$
    DECLARE
      invoice_id_type TEXT;
    BEGIN
      SELECT data_type
      INTO invoice_id_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'app_invoice_items'
        AND column_name = 'invoice_id';

      IF invoice_id_type IS NULL THEN
        UPDATE app_invoice_items item
        SET invoice_pk = invoice.id
        FROM app_invoices invoice
        WHERE item.invoice_no = invoice.invoice_no
          AND item.invoice_pk IS NULL;
      ELSIF invoice_id_type IN ('bigint', 'integer', 'numeric') THEN
        EXECUTE 'UPDATE app_invoice_items SET invoice_pk = invoice_id::bigint WHERE invoice_pk IS NULL';
      ELSE
        UPDATE app_invoice_items item
        SET invoice_pk = invoice.id
        FROM app_invoices invoice
        WHERE item.invoice_id = invoice.invoice_no
          AND item.invoice_pk IS NULL;
      END IF;
    END $$;
  `);
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_id_fkey');
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_id_line_no_key');
  await pool.query('ALTER TABLE app_invoice_items DROP CONSTRAINT IF EXISTS app_invoice_items_invoice_pk_line_no_key');
  await pool.query(`
    UPDATE app_invoice_items item
    SET invoice_no = invoice.invoice_no
    FROM app_invoices invoice
    WHERE item.invoice_pk = invoice.id
      AND item.invoice_no IS DISTINCT FROM invoice.invoice_no
  `);
  await pool.query('DROP INDEX IF EXISTS app_invoice_items_invoice_id_idx');
  await pool.query('ALTER TABLE app_invoice_items DROP COLUMN IF EXISTS invoice_id');
  await pool.query('ALTER TABLE app_invoice_items ADD COLUMN invoice_id BIGINT');
  await pool.query('UPDATE app_invoice_items SET invoice_id = invoice_pk WHERE invoice_id IS NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_no SET NOT NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_pk SET NOT NULL');
  await pool.query('ALTER TABLE app_invoice_items ALTER COLUMN invoice_id SET NOT NULL');
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_pk_fkey'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_pk_fkey
        FOREIGN KEY (invoice_pk) REFERENCES app_invoices(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_id_fkey'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_id_fkey
        FOREIGN KEY (invoice_id) REFERENCES app_invoices(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_invoice_items_invoice_pk_line_no_key'
      ) THEN
        ALTER TABLE app_invoice_items
        ADD CONSTRAINT app_invoice_items_invoice_pk_line_no_key
        UNIQUE (invoice_pk, line_no);
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_invoice_items_invoice_no_idx
    ON app_invoice_items(invoice_no)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS app_invoice_items_invoice_id_idx
    ON app_invoice_items(invoice_id)
  `);
}

async function seedDefaultAccounts(pool) {
  for (const account of DEFAULT_ACCOUNTS) {
    const { rows } = await pool.query(
      `
      INSERT INTO app_accounts (
        account_code, account_name, account_type, normal_balance
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (account_code) DO UPDATE
      SET account_name = EXCLUDED.account_name,
        account_type = EXCLUDED.account_type,
        normal_balance = EXCLUDED.normal_balance,
        updated_at = now()
      RETURNING id
      `,
      [account.code, account.name, account.type, account.normal],
    );
    await pool.query(
      `
      INSERT INTO app_accounting_settings (setting_key, account_id)
      VALUES ($1, $2)
      ON CONFLICT (setting_key) DO UPDATE
      SET account_id = EXCLUDED.account_id,
        updated_at = now()
      `,
      [account.key, Number(rows[0].id)],
    );
  }
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
  const search = String(options.search || '').trim().toLowerCase();
  const from = String(options.from || '').trim();
  const to = String(options.to || '').trim();
  const warehouse = String(options.warehouse || '').trim();
  const pagination = paginationOptions(options, 50, 200);
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedGroups)) {
    params.push(options.allowedGroups);
    where.push(`EXISTS (
      SELECT 1 FROM app_master_customers customer
      WHERE customer.customer_id = invoice.customer_id
        AND LOWER(TRIM(COALESCE(customer.customer_group, ''))) = ANY($${params.length}::text[])
    )`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(COALESCE(invoice_no, '')) LIKE $${params.length}
      OR invoice_date::text LIKE $${params.length}
      OR LOWER(customer_name) LIKE $${params.length}
      OR total::text LIKE $${params.length}
      OR amount_paid::text LIKE $${params.length}
      OR LOWER(status) LIKE $${params.length}
      OR LOWER(docstatus) LIKE $${params.length}
    )`);
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
  const pageParams = [...params, pagination.limit, pagination.offset];
  const invoiceListSql = `
    FROM (
      SELECT
        invoice.id,
        invoice.invoice_no,
        invoice.docstatus,
        invoice.invoice_date,
        invoice.due_date,
        invoice.customer_id,
        invoice.customer_name,
        invoice.customer_phone,
        invoice.subtotal,
        invoice.tax_amount,
        invoice.discount_amount,
        invoice.total,
        CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
          ELSE COALESCE(payment_totals.amount_paid, 0)
        END AS amount_paid,
        CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
          WHEN COALESCE(payment_totals.amount_paid, 0) <= 0 THEN 'unpaid'
          WHEN COALESCE(payment_totals.amount_paid, 0) >= invoice.total THEN 'paid'
          ELSE 'partial'
        END AS status,
        invoice.created_at,
        invoice.updated_at
      FROM app_invoices invoice
      LEFT JOIN (
        SELECT invoice_id, COALESCE(SUM(amount), 0) AS amount_paid
        FROM app_invoice_payments
        WHERE docstatus = 'submitted'
        GROUP BY invoice_id
      ) payment_totals ON payment_totals.invoice_id = invoice.id
    ) invoice
  `;
  const [countResult, pageResult] = await Promise.all([
    getPostgresPool().query(
      `SELECT COUNT(*)::int AS total ${invoiceListSql} ${whereSql}`,
      params,
    ),
    getPostgresPool().query(
    `
    SELECT
      id,
      invoice_no,
      docstatus,
      invoice_date::text,
      due_date::text,
      customer_id,
      customer_name,
      customer_phone,
      subtotal::float,
      tax_amount::float,
      discount_amount::float,
      total::float,
      amount_paid::float,
      status,
      created_at,
      updated_at
    ${invoiceListSql}
    ${whereSql}
    ORDER BY id DESC
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
    `,
      pageParams,
    ),
  ]);
  return {
    rows: pageResult.rows.map(postgresInvoiceListRow),
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}

function postgresInvoiceListRow(row) {
  return normalizeInvoiceTotals({
    id: Number(row.id),
    invoice_no: row.invoice_no,
    docstatus: row.docstatus,
    invoice_date: dateOnly(row.invoice_date),
    due_date: dateOnly(row.due_date),
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
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
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      INSERT INTO app_invoices (
        docstatus, invoice_date, due_date, customer_id, customer_name, customer_phone,
        notes, subtotal, tax_amount, discount_amount, total, amount_paid, status, is_cash_sale
      )
      VALUES (
        'draft', $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13
      )
      RETURNING id
      `,
      [...invoiceParams(invoiceData), payload.is_cash_sale === true],
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
  });
}

async function createCashSaleInvoice(payload, payment) {
  if (!usePostgresStore()) {
    const id = await createInvoice({ ...payload, is_cash_sale: true, payments: [], amount_paid: 0 });
    await submitInvoice(id);
    await addInvoicePayment(id, payment);
    return id;
  }

  const invoiceData = buildInvoiceData({ ...payload, is_cash_sale: true, payments: [], amount_paid: 0 });
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      INSERT INTO app_invoices (
        docstatus, invoice_date, due_date, customer_id, customer_name, customer_phone,
        notes, subtotal, tax_amount, discount_amount, total, amount_paid, status, is_cash_sale
      )
      VALUES (
        'draft', $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13
      )
      RETURNING id
      `,
      [...invoiceParams(invoiceData), true],
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

    let totalCost = 0;
    for (const item of itemRows) {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: dateOnly(invoiceData.invoice_date),
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
    const { rows: paymentRows } = await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id
      `,
      [
        id,
        paymentData.id,
        paymentData.payment_date,
        paymentData.amount,
        paymentData.method,
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
  const invoiceData = buildInvoiceData(payload);
  return withPostgresTransaction(async (client) => {
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
        updated_at = now()
      WHERE id = $13
      `,
      [...invoiceParams(invoiceData), Number(id)],
    );
    await client.query('DELETE FROM app_invoice_payments WHERE invoice_id = $1', [Number(id)]);
    await syncPostgresInvoiceItems(client, Number(id), invoice.invoice_no, invoiceData.items);
    await insertPostgresPayments(client, Number(id), invoiceData.payments);
    return Number(id);
  });
}

async function submitPostgresInvoice(id) {
  await withPostgresTransaction(async (client) => {
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

    let totalCost = 0;
    for (const item of itemRows) {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: dateOnly(invoice.invoice_date),
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

    await setVoucherDocstatus(client, 'app_invoices', Number(id), 'submitted');
    await syncPostgresInvoicePaymentTotals(client, Number(id));
    await postSalesInvoiceGlEntry(client, {
      ...invoice,
      id: Number(id),
      total_cost: roundMoney(totalCost),
    });
    const { rows: paymentRows } = await client.query(
      `
      SELECT id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id
      FROM app_invoice_payments
      WHERE invoice_id = $1
      ORDER BY payment_no
      `,
      [Number(id)],
    );
    for (const payment of paymentRows) {
      await createOrUpdatePaymentJournalEntry(client, invoice, payment);
    }
  });
  return Number(id);
}

async function submitCashSaleInvoice(id, payment) {
  if (!usePostgresStore()) {
    const invoiceId = await submitInvoice(id);
    await addInvoicePayment(invoiceId, payment);
    return invoiceId;
  }

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

    let totalCost = 0;
    for (const item of itemRows) {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: dateOnly(invoice.invoice_date),
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

    await setVoucherDocstatus(client, 'app_invoices', Number(id), 'submitted');
    await syncPostgresInvoicePaymentTotals(client, Number(id));

    const invoiceForGl = {
      ...invoice,
      id: Number(id),
      total_cost: roundMoney(totalCost),
    };
    await postSalesInvoiceGlEntry(client, invoiceForGl);

    const paymentData = buildPaymentData(payment, [], 1);
    const { rows: paymentRows } = await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id
      `,
      [
        Number(id),
        paymentData.id,
        paymentData.payment_date,
        paymentData.amount,
        paymentData.method,
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
  await withPostgresTransaction(async (client) => {
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
    const balanceDue = roundMoney(Number(invoice.total || 0) - Number(totals.amount_paid || 0));
    if (payment.amount > balanceDue) {
      const err = new Error('Payment amount cannot exceed the invoice balance.');
      err.status = 400;
      throw err;
    }

    const { rows: paymentRows } = await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id
      `,
      [
        Number(id),
        payment.id,
        payment.payment_date,
        payment.amount,
        payment.method,
        payment.reference,
        payment.notes,
        payment.created_at,
      ],
    );
    await syncPostgresInvoicePaymentTotals(client, Number(id));
    await createOrUpdatePaymentJournalEntry(client, invoice, paymentRows[0]);
  });
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

async function syncPostgresInvoicePaymentTotals(client, invoiceId) {
  await client.query(
    `
    UPDATE app_invoices invoice
    SET amount_paid = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
        ELSE totals.amount_paid
      END,
      status = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
        WHEN totals.amount_paid <= 0 THEN 'unpaid'
        WHEN totals.amount_paid >= invoice.total THEN 'paid'
        ELSE 'partial'
      END,
      updated_at = now()
    FROM (
      SELECT COALESCE(SUM(amount), 0) AS amount_paid
      FROM app_invoice_payments
      WHERE invoice_id = $1 AND docstatus = 'submitted'
    ) totals
    WHERE invoice.id = $1
    `,
    [invoiceId],
  );
}

async function syncAllPostgresInvoicePaymentTotals(pool) {
  await pool.query(`
    UPDATE app_invoices invoice
    SET amount_paid = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
        ELSE totals.amount_paid
      END,
      status = CASE
        WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
        WHEN totals.amount_paid <= 0 THEN 'unpaid'
        WHEN totals.amount_paid >= invoice.total THEN 'paid'
        ELSE 'partial'
      END
    FROM (
      SELECT invoice.id, COALESCE(SUM(payment.amount), 0) AS amount_paid
      FROM app_invoices invoice
      LEFT JOIN app_invoice_payments payment ON payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      GROUP BY invoice.id
    ) totals
    WHERE invoice.id = totals.id
      AND (
        invoice.amount_paid IS DISTINCT FROM CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 0
          ELSE totals.amount_paid
        END
        OR invoice.status IS DISTINCT FROM CASE
          WHEN COALESCE(invoice.docstatus, 'submitted') = 'draft' THEN 'unpaid'
          WHEN totals.amount_paid <= 0 THEN 'unpaid'
          WHEN totals.amount_paid >= invoice.total THEN 'paid'
          ELSE 'partial'
        END
      )
  `);
}

async function postgresInvoiceSummary() {
  const { rows } = await getPostgresPool().query(`
    SELECT
      COUNT(*)::int AS invoice_count,
      COALESCE(SUM(total), 0)::float AS invoice_total,
      COALESCE(SUM(amount_paid), 0)::float AS paid_total,
      COALESCE(SUM(total - amount_paid), 0)::float AS balance_due
    FROM (
      SELECT
        invoice.id,
        invoice.total,
        COALESCE(SUM(payment.amount), 0) AS amount_paid
      FROM app_invoices invoice
      LEFT JOIN app_invoice_payments payment ON payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      WHERE invoice.docstatus = 'submitted'
      GROUP BY invoice.id, invoice.total
    ) totals
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
    SELECT customer_name, COALESCE(SUM(balance_due), 0)::float AS balance_due
    FROM (
      SELECT
        invoice.id,
        invoice.customer_name,
        invoice.total - COALESCE(SUM(payment.amount), 0) AS balance_due
      FROM app_invoices invoice
      LEFT JOIN app_invoice_payments payment ON payment.invoice_id = invoice.id AND payment.docstatus = 'submitted'
      WHERE invoice.docstatus = 'submitted'
      GROUP BY invoice.id, invoice.customer_name, invoice.total
    ) balances
    WHERE balance_due > 0
    GROUP BY customer_name
    ORDER BY COALESCE(SUM(balance_due), 0) DESC
    LIMIT $1
    `,
    [Number(limit)],
  );
  return rows;
}

function assertPostgresInventory() {
  if (!usePostgresStore()) {
    const err = new Error('Stock management requires INVOICE_STORE=postgres.');
    err.status = 400;
    throw err;
  }
}

function assertPostgresAccounting() {
  if (!usePostgresStore()) {
    const err = new Error('Accounting requires INVOICE_STORE=postgres.');
    err.status = 400;
    throw err;
  }
}

async function stockSummary() {
  assertPostgresInventory();
  const { rows } = await getPostgresPool().query(`
    SELECT
      COUNT(*)::int AS item_count,
      COALESCE(SUM(quantity), 0)::float AS total_quantity,
      COALESCE(SUM(stock_value), 0)::float AS stock_value
    FROM app_stock_balances
    WHERE quantity <> 0
  `);
  return rows[0] || { item_count: 0, total_quantity: 0, stock_value: 0 };
}

async function stockBalances(filters = {}) {
  assertPostgresInventory();
  const pagination = paginationOptions(filters, 50, 200);
  const search = String(filters.search || '').trim().toLowerCase();
  const warehouse = String(filters.warehouse || '').trim();
  const params = [];
  const where = ['quantity <> 0'];
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(warehouse) LIKE $${params.length}
      OR quantity::text LIKE $${params.length}
      OR valuation_rate::text LIKE $${params.length}
      OR stock_value::text LIKE $${params.length}
    )`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`warehouse = $${params.length}`);
  }
  const whereSql = where.join(' AND ');
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_balances
    WHERE ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT item_code, item_name, warehouse, quantity::float, stock_value::float, valuation_rate::float
    FROM app_stock_balances
    WHERE ${whereSql}
    ORDER BY item_name, warehouse
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  return rows;
}

async function localStockQuantity(itemCode, warehouse) {
  assertPostgresInventory();
  const { rows } = await getPostgresPool().query(
    `
    SELECT quantity::float, stock_value::float, valuation_rate::float
    FROM app_stock_balances
    WHERE item_code = $1
      AND warehouse = $2
    `,
    [String(itemCode || '').trim(), String(warehouse || '').trim()],
  );
  return rows[0] || { quantity: 0, stock_value: 0, valuation_rate: 0 };
}

async function masterItemsWithStock(options = {}) {
  assertPostgresInventory();
  const search = String(options.search || '').trim().toLowerCase();
  const warehouse = String(options.warehouse || '').trim();
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const params = [warehouse];
  const where = ['item.disabled = false', "item.docstatus = 'submitted'", 'COALESCE(balance.quantity, 0) > 0'];
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.stock_uom, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.category, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.description, '')) LIKE $${params.length}
      OR item.default_rate::text LIKE $${params.length}
    )`);
  }
  params.push(limit);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      item.item_code,
      item.item_name,
      item.stock_uom,
      item.category,
      item.description,
      item.default_rate::float,
      item.default_rate::float AS unit_price,
      $1::text AS warehouse,
      COALESCE(balance.quantity, 0)::float AS stock_balance,
      COALESCE(balance.valuation_rate, 0)::float AS valuation_rate
    FROM app_master_items item
    LEFT JOIN app_stock_balances balance
      ON balance.item_code = item.item_code
      AND balance.warehouse = $1
    WHERE ${where.join(' AND ')}
    ORDER BY item.item_name, item.item_code
    LIMIT $${params.length}
    `,
    params,
  );
  return rows.map((row) => ({
    ...row,
    stock_balance: normalizeStockQuantity(row.stock_balance),
  }));
}

async function masterItems(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = [];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(COALESCE(stock_uom, '')) LIKE $${params.length}
      OR LOWER(COALESCE(category, '')) LIKE $${params.length}
      OR LOWER(COALESCE(description, '')) LIKE $${params.length}
      OR LOWER(COALESCE(exporter, '')) LIKE $${params.length}
      OR LOWER(COALESCE(source, '')) LIKE $${params.length}
      OR LOWER(COALESCE(photo_count_id, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'disabled' ELSE 'enabled' END) LIKE $${params.length}
      OR default_rate::text LIKE $${params.length}
      OR unit_cost::text LIKE $${params.length}
      OR markup::text LIKE $${params.length}
      OR qty_per_carton::text LIKE $${params.length}
      OR cbm_per_carton::text LIKE $${params.length}
      OR weight_per_carton::text LIKE $${params.length}
      OR import_fob::text LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_items ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      item_code,
      item_name,
      stock_uom,
      category,
      description,
      default_rate::float,
      unit_cost::float,
      markup::float,
      qty_per_carton::float,
      cbm_per_carton::float,
      weight_per_carton::float,
      import_fob::float,
      exporter,
      source,
      photo_count_id,
      is_sales_item,
      is_purchase_item,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_items
    ${whereSql}
    ORDER BY item_name, item_code
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterCustomers(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedGroups)) {
    params.push(options.allowedGroups);
    where.push(`LOWER(TRIM(COALESCE(customer_group, ''))) = ANY($${params.length}::text[])`);
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(customer_id) LIKE $${params.length}
      OR LOWER(customer_name) LIKE $${params.length}
      OR LOWER(COALESCE(customer_group, '')) LIKE $${params.length}
      OR LOWER(COALESCE(territory, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(COALESCE(tin, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'inactive' ELSE 'active' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_customers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      customer_id,
      customer_name,
      customer_group,
      territory,
      phone,
      tin,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_customers
    ${whereSql}
    ORDER BY customer_name, customer_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterSuppliers(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = [];
  if (Array.isArray(options.allowedTypes)) {
    params.push(options.allowedTypes);
    where.push(`LOWER(TRIM(COALESCE(supplier_type, ''))) = ANY($${params.length}::text[])`);
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(supplier_id) LIKE $${params.length}
      OR LOWER(supplier_name) LIKE $${params.length}
      OR LOWER(COALESCE(supplier_type, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'inactive' ELSE 'active' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_suppliers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      supplier_id,
      supplier_name,
      supplier_type,
      phone,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_suppliers
    ${whereSql}
    ORDER BY supplier_name, supplier_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterWarehouses(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = ['is_group = false'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(warehouse) LIKE $${params.length}
      OR LOWER(COALESCE(warehouse_type, '')) LIKE $${params.length}
      OR LOWER(CASE WHEN disabled THEN 'disabled' ELSE 'enabled' END) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.join(' AND ');
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_warehouses WHERE ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      warehouse,
      warehouse_type,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_warehouses
    WHERE ${whereSql}
    ORDER BY warehouse
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterEmployees(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = [];
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(employee_id) LIKE $${params.length}
      OR LOWER(employee_name) LIKE $${params.length}
      OR LOWER(COALESCE(status, '')) LIKE $${params.length}
      OR LOWER(COALESCE(company, '')) LIKE $${params.length}
      OR LOWER(COALESCE(department, '')) LIKE $${params.length}
      OR LOWER(COALESCE(designation, '')) LIKE $${params.length}
      OR LOWER(COALESCE(phone, '')) LIKE $${params.length}
      OR LOWER(COALESCE(email, '')) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_employees ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      employee_id,
      employee_name,
      status,
      company,
      department,
      designation,
      phone,
      email,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE COALESCE(NULLIF(status, ''), 'Active') END AS status_label
    FROM app_master_employees
    ${whereSql}
    ORDER BY employee_name, employee_id
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterCostCenters(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = [];
  if (!options.includeGroups) {
    where.push('is_group = false');
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(cost_center) LIKE $${params.length}
      OR LOWER(cost_center_name) LIKE $${params.length}
      OR LOWER(COALESCE(parent_cost_center, '')) LIKE $${params.length}
      OR LOWER(COALESCE(company, '')) LIKE $${params.length}
      OR LOWER(COALESCE(cost_center_type, '')) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_cost_centers ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      cost_center,
      cost_center_name,
      parent_cost_center,
      company,
      cost_center_type,
      is_group,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_cost_centers
    ${whereSql}
    ORDER BY cost_center_name, cost_center
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function masterOptions(options = {}) {
  assertPostgresInventory();
  const params = [];
  const where = options.includeDisabled ? [] : ['disabled = false', "docstatus = 'submitted'"];
  const search = String(options.search || '').trim().toLowerCase();
  const group = String(options.group || '').trim();
  if (group) {
    params.push(group);
    where.push(`option_group = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(option_group) LIKE $${params.length}
      OR LOWER(option_value) LIKE $${params.length}
    )`);
  }
  const pagination = paginationOptions(options, Number(options.limit || 100), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let countResult = null;
  if (options.paginate) {
    countResult = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_master_options ${whereSql}`, params);
  }
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT id, option_group, option_value, docstatus, legacy_editable
    FROM app_master_options
    ${whereSql}
    ORDER BY option_group, option_value
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  if (countResult) {
    rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  }
  return rows;
}

async function findMasterRecord(kind, id) {
  assertPostgresInventory();
  if (kind === 'items') {
    return findMasterItem(id, { includeDisabled: true });
  }
  if (kind === 'customers') {
    return findMasterCustomer(id, { includeDisabled: true });
  }
  if (kind === 'suppliers') {
    return findMasterSupplier(id, { includeDisabled: true });
  }
  if (kind === 'warehouses') {
    return findMasterWarehouse(id);
  }
  if (kind === 'employees') {
    return findMasterEmployee(id, { includeDisabled: true });
  }
  if (kind === 'cost_centers') {
    return findMasterCostCenter(id, { includeGroups: true, includeDisabled: true });
  }
  if (kind === 'options') {
    return findMasterOption(id);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

async function findMasterItem(itemCode, options = {}) {
  const code = String(itemCode || '').trim();
  if (!code) {
    return null;
  }
  const where = ['item_code = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      item_code,
      item_name,
      stock_uom,
      category,
      description,
      default_rate::float,
      unit_cost::float,
      markup::float,
      qty_per_carton::float,
      cbm_per_carton::float,
      weight_per_carton::float,
      import_fob::float,
      exporter,
      source,
      photo_count_id,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_items
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [code],
  );
  return rows[0] || null;
}

async function findMasterCustomer(customerId, options = {}) {
  const id = String(customerId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['customer_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      customer_id,
      customer_name,
      customer_group,
      territory,
      phone,
      tin,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_customers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterSupplier(supplierId, options = {}) {
  const id = String(supplierId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['supplier_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
    where.push("docstatus = 'submitted'");
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      supplier_id,
      supplier_name,
      supplier_type,
      phone,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE 'Active' END AS status
    FROM app_master_suppliers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterWarehouse(warehouseName) {
  const warehouse = String(warehouseName || '').trim();
  if (!warehouse) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      warehouse,
      warehouse_type,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_warehouses
    WHERE warehouse = $1
      AND is_group = false
    LIMIT 1
    `,
    [warehouse],
  );
  return rows[0] || null;
}

async function findMasterEmployee(employeeId, options = {}) {
  const id = String(employeeId || '').trim();
  if (!id) {
    return null;
  }
  const where = ['employee_id = $1'];
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      employee_id,
      employee_name,
      status,
      company,
      department,
      designation,
      phone,
      email,
      docstatus,
      legacy_editable,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Inactive' ELSE COALESCE(NULLIF(status, ''), 'Active') END AS status_label
    FROM app_master_employees
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function findMasterCostCenter(costCenterName, options = {}) {
  const costCenter = String(costCenterName || '').trim();
  if (!costCenter) {
    return null;
  }
  const where = ['cost_center = $1'];
  if (!options.includeGroups) {
    where.push('is_group = false');
  }
  if (!options.includeDisabled) {
    where.push('disabled = false');
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      cost_center,
      cost_center_name,
      parent_cost_center,
      company,
      cost_center_type,
      is_group,
      CASE WHEN disabled THEN '1' ELSE '0' END AS disabled,
      CASE WHEN disabled THEN 'Disabled' ELSE 'Enabled' END AS status
    FROM app_master_cost_centers
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    [costCenter],
  );
  return rows[0] || null;
}

async function findMasterOption(optionId) {
  const id = Number(optionId);
  if (!id) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at, id, option_group, option_value, docstatus, legacy_editable
    FROM app_master_options
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );
  return rows[0] || null;
}

async function createMasterRecord(kind, payload) {
  assertPostgresInventory();
  if (kind === 'items') {
    return createMasterItem(payload);
  }
  if (kind === 'customers') {
    return createMasterCustomer(payload);
  }
  if (kind === 'suppliers') {
    return createMasterSupplier(payload);
  }
  if (kind === 'warehouses') {
    return createMasterWarehouse(payload);
  }
  if (kind === 'employees') {
    return createMasterEmployee(payload);
  }
  if (kind === 'options') {
    return createMasterOption(payload);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

const MASTER_RECORD_TABLES = {
  items: ['app_master_items', 'item_code'],
  customers: ['app_master_customers', 'customer_id'],
  suppliers: ['app_master_suppliers', 'supplier_id'],
  warehouses: ['app_master_warehouses', 'warehouse'],
  employees: ['app_master_employees', 'employee_id'],
  options: ['app_master_options', 'id'],
};

async function masterRecordState(kind, id) {
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
  const { rows } = await getPostgresPool().query(
    `SELECT docstatus, legacy_editable FROM ${fields[0]} WHERE ${fields[1]} = $1`, [id],
  );
  if (!rows[0]) { const error = new Error('Master record not found.'); error.status = 404; throw error; }
  return rows[0];
}

async function submitMasterRecord(kind, id) {
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
  const { rowCount } = await getPostgresPool().query(
    `UPDATE ${fields[0]} SET docstatus = 'submitted', legacy_editable = false, updated_at = now()
     WHERE ${fields[1]} = $1 AND docstatus = 'draft'`, [id],
  );
  if (!rowCount) { const error = new Error('Only draft master records can be submitted.'); error.status = 400; throw error; }
}

async function cancelMasterRecord(kind, id) {
  const fields = MASTER_RECORD_TABLES[kind];
  if (!fields) { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
  const { rowCount } = await getPostgresPool().query(
    `UPDATE ${fields[0]} SET docstatus = 'cancelled', legacy_editable = false, disabled = true, updated_at = now()
     WHERE ${fields[1]} = $1 AND docstatus = 'submitted'`, [id],
  );
  if (!rowCount) { const error = new Error('Only submitted master records can be cancelled.'); error.status = 400; throw error; }
}

async function updateMasterRecord(kind, id, payload) {
  assertPostgresInventory();
  if (MASTER_RECORD_TABLES[kind]) {
    const state = await masterRecordState(kind, id);
    if (state.docstatus !== 'draft' && !(state.docstatus === 'submitted' && state.legacy_editable)) {
      const error = new Error('Submitted or cancelled master records cannot be edited.'); error.status = 400; throw error;
    }
  }
  if (kind === 'items') {
    return updateMasterItem(id, payload);
  }
  if (kind === 'customers') {
    return updateMasterCustomer(id, payload);
  }
  if (kind === 'suppliers') {
    return updateMasterSupplier(id, payload);
  }
  if (kind === 'warehouses') {
    return updateMasterWarehouse(id, payload);
  }
  if (kind === 'employees') {
    return updateMasterEmployee(id, payload);
  }
  if (kind === 'cost_centers') {
    return updateMasterCostCenter(id, payload);
  }
  if (kind === 'options') {
    return updateMasterOption(id, payload);
  }
  const err = new Error('Unknown master list.');
  err.status = 404;
  throw err;
}

async function createMasterItem(payload) {
  const itemCode = requiredValue(payload.item_code, 'Item code is required.');
  const itemName = requiredValue(payload.item_name, 'Item name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  await getPostgresPool().query(
    `
    INSERT INTO app_master_items (
      item_code, item_name, stock_uom, category, description, default_rate,
      unit_cost, markup, qty_per_carton, cbm_per_carton, weight_per_carton,
      import_fob, exporter, source, photo_count_id, is_sales_item,
      is_purchase_item, disabled, docstatus, legacy_editable
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, 'draft', false
    )
    `,
    [
      itemCode,
      itemName,
      optionalValue(payload.stock_uom),
      optionalValue(payload.category),
      optionalValue(payload.description),
      roundMoney(payload.default_rate),
      roundMoney(payload.unit_cost),
      numberValue(payload.markup),
      numberValue(payload.qty_per_carton),
      numberValue(payload.cbm_per_carton),
      numberValue(payload.weight_per_carton),
      numberValue(payload.import_fob),
      optionalValue(payload.exporter),
      optionalValue(payload.source),
      optionalValue(payload.photo_count_id),
      payload.is_sales_item !== '0',
      payload.is_purchase_item !== '0',
      disabled,
    ],
  );
  return itemCode;
}

async function updateMasterItem(id, payload) {
  const itemCode = requiredValue(id, 'Item code is required.');
  const itemName = requiredValue(payload.item_name, 'Item name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_items (
      item_code, item_name, stock_uom, category, description, default_rate,
      unit_cost, markup, qty_per_carton, cbm_per_carton, weight_per_carton,
      import_fob, exporter, source, photo_count_id, is_sales_item,
      is_purchase_item, disabled
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18
    )
    ON CONFLICT (item_code) DO UPDATE SET
      item_name = EXCLUDED.item_name,
      stock_uom = EXCLUDED.stock_uom,
      category = EXCLUDED.category,
      description = EXCLUDED.description,
      default_rate = EXCLUDED.default_rate,
      unit_cost = EXCLUDED.unit_cost,
      markup = EXCLUDED.markup,
      qty_per_carton = EXCLUDED.qty_per_carton,
      cbm_per_carton = EXCLUDED.cbm_per_carton,
      weight_per_carton = EXCLUDED.weight_per_carton,
      import_fob = EXCLUDED.import_fob,
      exporter = EXCLUDED.exporter,
      source = EXCLUDED.source,
      photo_count_id = EXCLUDED.photo_count_id,
      is_sales_item = EXCLUDED.is_sales_item,
      is_purchase_item = EXCLUDED.is_purchase_item,
      disabled = EXCLUDED.disabled,
      updated_at = now()
    WHERE app_master_items.docstatus = 'draft'
       OR (app_master_items.docstatus = 'submitted' AND app_master_items.legacy_editable)
    `,
    [
      itemCode,
      itemName,
      optionalValue(payload.stock_uom),
      optionalValue(payload.category),
      optionalValue(payload.description),
      roundMoney(payload.default_rate),
      roundMoney(payload.unit_cost),
      numberValue(payload.markup),
      numberValue(payload.qty_per_carton),
      numberValue(payload.cbm_per_carton),
      numberValue(payload.weight_per_carton),
      numberValue(payload.import_fob),
      optionalValue(payload.exporter),
      optionalValue(payload.source),
      optionalValue(payload.photo_count_id),
      payload.is_sales_item !== '0',
      payload.is_purchase_item !== '0',
      disabled,
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return itemCode;
}

function customerTin(value) {
  const tin = optionalValue(value);
  if (tin && tin.length > 100) {
    const error = new Error('TIN must be 100 characters or fewer.');
    error.status = 400;
    throw error;
  }
  return tin;
}

async function createMasterCustomer(payload) {
  const customerName = requiredValue(payload.customer_name, 'Customer name is required.');
  const customerId = optionalValue(payload.customer_id) || customerName;
  const disabled = String(payload.disabled || '0') === '1';
  const tin = customerTin(payload.tin);
  await getPostgresPool().query(
    `
    INSERT INTO app_master_customers (
      customer_id, customer_name, customer_group, territory, phone, disabled, tin, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', false)
    `,
    [
      customerId,
      customerName,
      optionalValue(payload.customer_group),
      optionalValue(payload.territory),
      optionalValue(payload.phone),
      disabled,
      tin,
    ],
  );
  return customerId;
}

async function updateMasterCustomer(id, payload) {
  const customerId = requiredValue(id, 'Customer ID is required.');
  const customerName = requiredValue(payload.customer_name, 'Customer name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const tin = customerTin(payload.tin);
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_customers (
      customer_id, customer_name, customer_group, territory, phone, disabled, tin
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (customer_id) DO UPDATE SET
      customer_name = EXCLUDED.customer_name,
      customer_group = EXCLUDED.customer_group,
      territory = EXCLUDED.territory,
      phone = EXCLUDED.phone,
      disabled = EXCLUDED.disabled,
      tin = CASE WHEN $8::boolean THEN EXCLUDED.tin ELSE app_master_customers.tin END,
      updated_at = now()
    WHERE app_master_customers.docstatus = 'draft'
       OR (app_master_customers.docstatus = 'submitted' AND app_master_customers.legacy_editable)
    `,
    [
      customerId,
      customerName,
      optionalValue(payload.customer_group),
      optionalValue(payload.territory),
      optionalValue(payload.phone),
      disabled,
      tin,
      Object.hasOwn(payload, 'tin'),
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return customerId;
}

async function createMasterSupplier(payload) {
  const supplierName = requiredValue(payload.supplier_name, 'Supplier name is required.');
  const supplierId = optionalValue(payload.supplier_id) || supplierName;
  const disabled = String(payload.disabled || '0') === '1';
  await getPostgresPool().query(
    `
    INSERT INTO app_master_suppliers (
      supplier_id, supplier_name, supplier_type, phone, disabled, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, 'draft', false)
    `,
    [
      supplierId,
      supplierName,
      optionalValue(payload.supplier_type),
      optionalValue(payload.phone),
      disabled,
    ],
  );
  return supplierId;
}

async function updateMasterSupplier(id, payload) {
  const supplierId = requiredValue(id, 'Supplier ID is required.');
  const supplierName = requiredValue(payload.supplier_name, 'Supplier name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_suppliers (
      supplier_id, supplier_name, supplier_type, phone, disabled
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (supplier_id) DO UPDATE SET
      supplier_name = EXCLUDED.supplier_name,
      supplier_type = EXCLUDED.supplier_type,
      phone = EXCLUDED.phone,
      disabled = EXCLUDED.disabled,
      updated_at = now()
    WHERE app_master_suppliers.docstatus = 'draft'
       OR (app_master_suppliers.docstatus = 'submitted' AND app_master_suppliers.legacy_editable)
    `,
    [
      supplierId,
      supplierName,
      optionalValue(payload.supplier_type),
      optionalValue(payload.phone),
      disabled,
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return supplierId;
}

async function createMasterWarehouse(payload) {
  const warehouse = requiredValue(payload.warehouse, 'Warehouse name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  await getPostgresPool().query(
    `
    INSERT INTO app_master_warehouses (warehouse, warehouse_type, disabled, docstatus, legacy_editable)
    VALUES ($1, $2, $3, 'draft', false)
    `,
    [warehouse, optionalValue(payload.warehouse_type), disabled],
  );
  return warehouse;
}

async function updateMasterWarehouse(id, payload) {
  const warehouse = requiredValue(id, 'Warehouse name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const { rowCount } = await getPostgresPool().query(
    `
    INSERT INTO app_master_warehouses (warehouse, warehouse_type, is_group, disabled)
    VALUES ($1, $2, false, $3)
    ON CONFLICT (warehouse) DO UPDATE SET
      warehouse_type = EXCLUDED.warehouse_type,
      is_group = false,
      disabled = EXCLUDED.disabled,
      updated_at = now()
    WHERE app_master_warehouses.docstatus = 'draft'
       OR (app_master_warehouses.docstatus = 'submitted' AND app_master_warehouses.legacy_editable)
    `,
    [warehouse, optionalValue(payload.warehouse_type), disabled],
  );
  assertMasterUpdateApplied(rowCount);
  return warehouse;
}

function assertMasterUpdateApplied(rowCount) {
  if (!rowCount) { const error = new Error('This master record can no longer be edited.'); error.status = 400; throw error; }
}

async function createMasterEmployee(payload) {
  const employeeName = requiredValue(payload.employee_name, 'Employee name is required.');
  const employeeId = optionalValue(payload.employee_id) || employeeName;
  const disabled = String(payload.disabled || '0') === '1';
  await getPostgresPool().query(
    `
    INSERT INTO app_master_employees (
      employee_id, employee_name, status, company, department, designation,
      phone, email, disabled, docstatus, legacy_editable
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', false)
    `,
    [
      employeeId,
      employeeName,
      optionalValue(payload.status),
      optionalValue(payload.company),
      optionalValue(payload.department),
      optionalValue(payload.designation),
      optionalValue(payload.phone),
      optionalValue(payload.email),
      disabled,
    ],
  );
  return employeeId;
}

async function updateMasterEmployee(id, payload) {
  const employeeId = requiredValue(id, 'Employee ID is required.');
  const employeeName = requiredValue(payload.employee_name || id, 'Employee name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const { rowCount } = await getPostgresPool().query(
    `
    UPDATE app_master_employees
    SET employee_name = $2,
        status = $3,
        company = $4,
        department = $5,
        designation = $6,
        phone = $7,
        email = $8,
        disabled = $9,
        updated_at = now()
    WHERE employee_id = $1
      AND (
        docstatus = 'draft'
        OR (docstatus = 'submitted' AND legacy_editable)
      )
    `,
    [
      employeeId,
      employeeName,
      optionalValue(payload.status),
      optionalValue(payload.company),
      optionalValue(payload.department),
      optionalValue(payload.designation),
      optionalValue(payload.phone),
      optionalValue(payload.email),
      disabled,
    ],
  );
  assertMasterUpdateApplied(rowCount);
  return employeeId;
}

async function updateMasterCostCenter(id, payload) {
  const costCenter = requiredValue(id, 'Cost center is required.');
  const costCenterName = requiredValue(payload.cost_center_name || id, 'Cost center name is required.');
  const disabled = String(payload.disabled || '0') === '1';
  const isGroup = String(payload.is_group || '0') === '1' || payload.is_group === true;
  await getPostgresPool().query(
    `
    INSERT INTO app_master_cost_centers (
      cost_center, cost_center_name, parent_cost_center, company,
      cost_center_type, is_group, disabled
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (cost_center) DO UPDATE SET
      cost_center_name = EXCLUDED.cost_center_name,
      parent_cost_center = EXCLUDED.parent_cost_center,
      company = EXCLUDED.company,
      cost_center_type = EXCLUDED.cost_center_type,
      is_group = EXCLUDED.is_group,
      disabled = EXCLUDED.disabled,
      updated_at = now()
    `,
    [
      costCenter,
      costCenterName,
      optionalValue(payload.parent_cost_center),
      optionalValue(payload.company),
      optionalValue(payload.cost_center_type),
      isGroup,
      disabled,
    ],
  );
  return costCenter;
}

async function createMasterOption(payload) {
  const optionGroup = requiredValue(payload.option_group, 'Option group is required.');
  const optionValue = requiredValue(payload.option_value, 'Option value is required.');
  const { rows } = await getPostgresPool().query(
    `
    INSERT INTO app_master_options (option_group, option_value, docstatus, legacy_editable)
    VALUES ($1, $2, 'draft', false)
    RETURNING id
    `,
    [optionGroup, optionValue],
  );
  return Number(rows[0].id);
}

async function updateMasterOption(id, payload) {
  const optionId = Number(id);
  if (!optionId) {
    const err = new Error('Option not found.');
    err.status = 404;
    throw err;
  }
  const optionGroup = requiredValue(payload.option_group, 'Option group is required.');
  const optionValue = requiredValue(payload.option_value, 'Option value is required.');
  const { rowCount } = await getPostgresPool().query(
    `
    UPDATE app_master_options
    SET option_group = $1,
      option_value = $2,
      disabled = false,
      updated_at = now()
    WHERE id = $3
      AND disabled = false
      AND (docstatus = 'draft' OR (docstatus = 'submitted' AND legacy_editable))
    `,
    [optionGroup, optionValue, optionId],
  );
  if (!rowCount) {
    const err = new Error('Option not found.');
    err.status = 404;
    throw err;
  }
  return optionId;
}

async function createStockEntry(payload) {
  assertPostgresInventory();
  const entryType = String(payload.entry_type || '').trim();
  if (!STOCK_ENTRY_TYPES.includes(entryType)) {
    const err = new Error('Choose a valid stock entry type.');
    err.status = 400;
    throw err;
  }
  const postingDate = String(payload.posting_date || '').trim();
  if (!isValidIsoDate(postingDate)) {
    const err = new Error('Choose a valid posting date.');
    err.status = 400;
    throw err;
  }
  const items = normalizeStockEntryItems(payload.items, entryType);
  if (!items.length) {
    const err = new Error('Add at least one stock item.');
    err.status = 400;
    throw err;
  }
  const docstatus = payload.action === 'save_draft' ? 'draft' : 'submitted';

  return withPostgresTransaction(async (client) => {
    const supplier = entryType === 'purchase' ? normalizeSupplierInfo(payload) : normalizeSupplierInfo();
    const { rows } = await client.query(
      `
      INSERT INTO app_stock_entries (
        entry_type, docstatus, posting_date, remarks, supplier_name, supplier_contact,
        supplier_phone, supplier_reference
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      [
        entryType,
        docstatus,
        postingDate,
        String(payload.remarks || '').trim() || null,
        supplier.supplier_name || null,
        supplier.supplier_contact || null,
        supplier.supplier_phone || null,
        supplier.supplier_reference || null,
      ],
    );
    const id = Number(rows[0].id);
    const entryNo = `STK-${String(id).padStart(6, '0')}`;
    await client.query('UPDATE app_stock_entries SET entry_no = $1 WHERE id = $2', [entryNo, id]);
    if (docstatus === 'submitted') {
      await setVoucherDocstatus(client, 'app_stock_entries', id, 'submitted');
    }

    await insertStockEntryItems(client, id, items);
    if (docstatus === 'submitted') {
      await postStockEntryMovements(client, { id, entryNo, entryType, postingDate, items });
      await postStockEntryGlEntry(client, { id, entryNo, entryType, postingDate });
    }

    return id;
  });
}

async function loadStockEntry(id) {
  assertPostgresInventory();
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      id, entry_no, entry_type, docstatus, posting_date::text, remarks,
      supplier_name, supplier_contact, supplier_phone, supplier_reference,
      submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at
    FROM app_stock_entries
    WHERE id = $1
    `,
    [stockEntryId],
  );
  const entry = rows[0];
  if (!entry) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const { rows: items } = await getPostgresPool().query(
    `
    SELECT id, created_by, created_by_user_id, created_at,
      updated_by, updated_by_user_id, updated_at,
      item_code, item_name, warehouse, target_warehouse, quantity::float, valuation_rate::float
    FROM app_stock_entry_items
    WHERE stock_entry_id = $1
    ORDER BY line_no
    `,
    [stockEntryId],
  );
  return {
    entry: {
      ...entry,
      posting_date: dateOnly(entry.posting_date),
      ...normalizeSupplierInfo(entry),
    },
    items: items.map((item) => ({
      ...item,
      id: Number(item.id),
      quantity: Number(item.quantity || 0),
      valuation_rate: Number(item.valuation_rate || 0),
    })),
  };
}

async function stockEntryCancelTemplate(identifier) {
  assertPostgresInventory();
  const value = String(identifier || '').trim();
  if (!value) {
    const err = new Error('Enter a stock entry number to cancel.');
    err.status = 400;
    throw err;
  }
  const numericId = Number(value);
  const params = Number.isFinite(numericId) ? [numericId] : [value.toUpperCase()];
  const condition = Number.isFinite(numericId) ? 'id = $1' : 'UPPER(entry_no) = $1';
  const { rows } = await getPostgresPool().query(
    `
    SELECT id, entry_no, entry_type, docstatus, posting_date::text, remarks
    FROM app_stock_entries
    WHERE ${condition}
    `,
    params,
  );
  const entry = rows[0];
  if (!entry) {
    const err = new Error('Stock entry to cancel was not found.');
    err.status = 404;
    throw err;
  }
  if ((entry.docstatus || 'submitted') !== 'submitted') {
    const err = new Error('Only submitted stock entries can be used for Cancel Entry.');
    err.status = 400;
    throw err;
  }
  const { rows: items } = await getPostgresPool().query(
    `
    SELECT item_code, item_name, warehouse, target_warehouse, quantity::float, valuation_rate::float
    FROM app_stock_entry_items
    WHERE stock_entry_id = $1
    ORDER BY line_no
    `,
    [entry.id],
  );
  return {
    entry: {
      id: Number(entry.id),
      entry_no: entry.entry_no,
      entry_type: entry.entry_type,
      posting_date: dateOnly(entry.posting_date),
      remarks: entry.remarks || '',
    },
    items: items.map((item) => ({
      item_code: item.item_code,
      item_name: item.item_name || item.item_code,
      warehouse: item.warehouse || '',
      target_warehouse: item.target_warehouse || '',
      quantity: Math.abs(Number(item.quantity || 0)),
      valuation_rate: Number(item.valuation_rate || 0),
    })),
  };
}

async function searchStockEntriesForCancel(search = '') {
  assertPostgresInventory();
  const value = String(search || '').trim();
  const params = [];
  const where = ["COALESCE(se.docstatus, 'submitted') = 'submitted'"];
  if (value) {
    params.push(sqlLikePattern(value.toLowerCase()));
    where.push(`(
      LOWER(se.entry_no) LIKE $${params.length}
      OR LOWER(se.entry_type) LIKE $${params.length}
      OR LOWER(COALESCE(se.remarks, '')) LIKE $${params.length}
      OR se.posting_date::text LIKE $${params.length}
    )`);
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      se.id,
      se.entry_no,
      se.entry_type,
      se.posting_date::text AS posting_date,
      COALESCE(se.remarks, '') AS remarks,
      COUNT(item.id)::int AS item_count
    FROM app_stock_entries se
    LEFT JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${where.join(' AND ')}
    GROUP BY se.id, se.entry_no, se.entry_type, se.posting_date, se.remarks
    ORDER BY se.posting_date DESC, se.id DESC
    LIMIT 25
    `,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    entry_no: row.entry_no,
    entry_type: row.entry_type,
    posting_date: dateOnly(row.posting_date),
    remarks: row.remarks || '',
    item_count: Number(row.item_count || 0),
  }));
}

async function updateStockEntry(id, payload) {
  assertPostgresInventory();
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const entryType = String(payload.entry_type || '').trim();
  if (!STOCK_ENTRY_TYPES.includes(entryType)) {
    const err = new Error('Choose a valid stock entry type.');
    err.status = 400;
    throw err;
  }
  const postingDate = String(payload.posting_date || '').trim();
  if (!isValidIsoDate(postingDate)) {
    const err = new Error('Choose a valid posting date.');
    err.status = 400;
    throw err;
  }
  const items = normalizeStockEntryItems(payload.items, entryType);
  if (!items.length) {
    const err = new Error('Add at least one stock item.');
    err.status = 400;
    throw err;
  }
  const docstatus = payload.action === 'save_draft' ? 'draft' : 'submitted';

  return withPostgresTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      'SELECT id, entry_no, docstatus FROM app_stock_entries WHERE id = $1 FOR UPDATE',
      [stockEntryId],
    );
    const existing = existingRows[0];
    if (!existing) {
      const err = new Error('Stock entry not found.');
      err.status = 404;
      throw err;
    }
    if ((existing.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft stock entries can be edited.');
      err.status = 400;
      throw err;
    }

    const supplier = entryType === 'purchase' ? normalizeSupplierInfo(payload) : normalizeSupplierInfo();
    await client.query(
      `
      UPDATE app_stock_entries
      SET entry_type = $1,
          docstatus = $2,
          posting_date = $3,
          remarks = $4,
          supplier_name = $5,
          supplier_contact = $6,
          supplier_phone = $7,
          supplier_reference = $8
      WHERE id = $9
      `,
      [
        entryType,
        docstatus,
        postingDate,
        String(payload.remarks || '').trim() || null,
        supplier.supplier_name || null,
        supplier.supplier_contact || null,
        supplier.supplier_phone || null,
        supplier.supplier_reference || null,
        stockEntryId,
      ],
    );
    if (docstatus === 'submitted') {
      await setVoucherDocstatus(client, 'app_stock_entries', stockEntryId, 'submitted');
    }
    await syncStockEntryItems(client, stockEntryId, items);
    if (docstatus === 'submitted') {
      await postStockEntryMovements(client, {
        id: stockEntryId,
        entryNo: existing.entry_no,
        entryType,
        postingDate,
        items,
      });
      await postStockEntryGlEntry(client, {
        id: stockEntryId,
        entryNo: existing.entry_no,
        entryType,
        postingDate,
      });
    }
    return stockEntryId;
  });
}

async function updateStockEntrySupplierInfo(id, payload) {
  assertPostgresInventory();
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const supplier = normalizeSupplierInfo(payload);
  const { rows } = await getPostgresPool().query(
    `
    UPDATE app_stock_entries
    SET supplier_name = $1,
        supplier_contact = $2,
        supplier_phone = $3,
        supplier_reference = $4
    WHERE id = $5
      AND entry_type = 'purchase'
      AND docstatus = 'draft'
    RETURNING supplier_name, supplier_contact, supplier_phone, supplier_reference
    `,
    [
      supplier.supplier_name || null,
      supplier.supplier_contact || null,
      supplier.supplier_phone || null,
      supplier.supplier_reference || null,
      stockEntryId,
    ],
  );
  if (!rows[0]) {
    const err = new Error('Only draft purchase receipts can be edited.');
    err.status = 400;
    throw err;
  }
  return normalizeSupplierInfo(rows[0]);
}

async function cancelStockEntry(id, payload = {}) {
  assertPostgresInventory();
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const reason = String(payload.reason || '').trim() || 'Cancelled';
  const cancellationPostingDate = String(payload.posting_date || '').trim() || dateOnly(new Date());
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      SELECT id, entry_no, docstatus
      FROM app_stock_entries
      WHERE id = $1
      FOR UPDATE
      `,
      [stockEntryId],
    );
    const entry = rows[0];
    if (!entry) {
      const err = new Error('Stock entry not found.');
      err.status = 404;
      throw err;
    }
    if ((entry.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Only submitted stock entries can be cancelled.');
      err.status = 400;
      throw err;
    }
    const { rows: existingReversal } = await client.query(
      `
      SELECT id
      FROM app_stock_ledger
      WHERE reversal_of_voucher_id = $1
        AND is_reversal = true
      LIMIT 1
      `,
      [stockEntryId],
    );
    if (existingReversal.length) {
      const err = new Error('This stock entry already has cancellation reversal rows.');
      err.status = 400;
      throw err;
    }
    const { rows: ledgerRows } = await client.query(
      `
      SELECT *
      FROM app_stock_ledger
      WHERE voucher_id = $1
        AND voucher_type LIKE 'stock_%'
        AND is_reversal = false
      ORDER BY id
      `,
      [stockEntryId],
    );
    if (!ledgerRows.length) {
      const err = new Error('No submitted stock movement found to reverse.');
      err.status = 400;
      throw err;
    }

    await validateStockEntryCancellation(client, ledgerRows);

    const actor = actorAuditValues();
    await client.query(
      `
      UPDATE app_stock_entries
      SET docstatus = 'cancelled',
          cancelled_by = $1,
          cancelled_by_user_id = $2,
          cancelled_at = $3,
          cancellation_reason = $4
      WHERE id = $5
      `,
      [actor.by, actor.by_user_id, actor.at, reason, stockEntryId],
    );

    for (const row of ledgerRows) {
      const qtyChange = -Number(row.qty_change || 0);
      const rate = qtyChange > 0
        ? Number(row.outgoing_rate || row.incoming_rate || 0)
        : undefined;
      const forceOutgoingRate = qtyChange < 0
        ? Number(row.incoming_rate || row.outgoing_rate || 0)
        : undefined;
      await applyPostgresStockMovement(client, {
        posting_date: cancellationPostingDate,
        item_code: row.item_code,
        item_name: row.item_name,
        warehouse: row.warehouse,
        voucher_type: row.voucher_type,
        voucher_id: stockEntryId,
        voucher_no: entry.entry_no,
        qty_change: qtyChange,
        rate,
        force_outgoing_rate: forceOutgoingRate,
        is_reversal: true,
        reversal_of_voucher_id: stockEntryId,
        reversal_of_voucher_no: entry.entry_no,
        remarks: `Cancellation of ${entry.entry_no}: ${reason}`,
      });
    }
    await postStockEntryGlEntry(client, {
      id: stockEntryId,
      entryNo: entry.entry_no,
      entryType: String(ledgerRows[0].voucher_type || '').replace(/^stock_/, ''),
      postingDate: cancellationPostingDate,
      isReversal: true,
      remarks: `Cancellation of ${entry.entry_no}: ${reason}`,
    });
    return stockEntryId;
  });
}

async function validateStockEntryCancellation(client, ledgerRows) {
  const requiredByBalance = new Map();
  for (const row of ledgerRows) {
    const reversalQty = -Number(row.qty_change || 0);
    if (reversalQty >= 0) {
      continue;
    }
    const itemCode = String(row.item_code || '').trim();
    const itemName = String(row.item_name || itemCode).trim();
    const warehouse = String(row.warehouse || '').trim();
    const key = `${itemCode}\u0000${warehouse}`;
    const existing = requiredByBalance.get(key) || {
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      required: 0,
    };
    existing.required = Number((existing.required + Math.abs(reversalQty)).toFixed(3));
    requiredByBalance.set(key, existing);
  }

  for (const requirement of requiredByBalance.values()) {
    const { rows } = await client.query(
      `
      SELECT quantity::float
      FROM app_stock_balances
      WHERE item_code = $1
        AND warehouse = $2
      FOR UPDATE
      `,
      [requirement.item_code, requirement.warehouse],
    );
    const available = Number(rows[0]?.quantity || 0);
    if (available + 0.0005 < requirement.required) {
      const err = new Error(
        `Insufficient stock for ${requirement.item_name} in ${requirement.warehouse}. ` +
        `Cancellation needs ${requirement.required}, available ${available}.`,
      );
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: requirement.item_name,
        item_code: requirement.item_code,
        warehouse: requirement.warehouse,
        requested: requirement.required,
        available,
      };
      throw err;
    }
  }
}

async function stockLedgerReport(filters = {}) {
  assertPostgresInventory();
  if (String(filters.status || 'posted').trim() === 'draft') {
    return stockEntryDraftReport(filters);
  }
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  addReportFilters(where, params, filters);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_ledger l
    LEFT JOIN app_stock_entries se
      ON se.id = COALESCE(l.voucher_id, l.reversal_of_voucher_id)
      AND l.voucher_type LIKE 'stock_%'
    LEFT JOIN app_purchases p ON p.id = l.voucher_id AND l.voucher_type = 'purchase'
    LEFT JOIN app_invoices i ON i.id = l.voucher_id AND l.voucher_type = 'invoice'
    ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      l.posting_date::text AS posting_date,
      l.item_code AS item_code,
      l.item_name AS item_name,
      l.warehouse AS warehouse,
      CASE
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', ''))
        WHEN l.voucher_type = 'purchase' THEN 'purchase'
        ELSE ''
      END AS stock_entry_type,
      CASE
        WHEN l.is_reversal THEN 'cancelled'
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted')
        WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted')
        WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted')
        ELSE 'submitted'
      END AS stock_entry_status,
      l.voucher_type AS voucher_type,
      CASE
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(l.voucher_id, l.reversal_of_voucher_id)
        ELSE l.voucher_id
      END AS voucher_id,
      l.voucher_no AS voucher_no,
      l.is_reversal AS is_reversal,
      l.reversal_of_voucher_id AS reversal_of_voucher_id,
      l.reversal_of_voucher_no AS reversal_of_voucher_no,
      l.remarks AS ledger_remarks,
      l.qty_change::float AS qty_change,
      l.incoming_rate::float AS incoming_rate,
      l.outgoing_rate::float AS outgoing_rate,
      l.stock_value_change::float AS stock_value_change,
      l.qty_after_transaction::float AS qty_after_transaction,
      l.stock_value_after_transaction::float AS stock_value_after_transaction
    FROM app_stock_ledger l
    LEFT JOIN app_stock_entries se
      ON se.id = COALESCE(l.voucher_id, l.reversal_of_voucher_id)
      AND l.voucher_type LIKE 'stock_%'
    LEFT JOIN app_purchases p ON p.id = l.voucher_id AND l.voucher_type = 'purchase'
    LEFT JOIN app_invoices i ON i.id = l.voucher_id AND l.voucher_type = 'invoice'
    ${whereSql}
    ORDER BY l.posting_date DESC, l.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  return { filters: reportFilterValues(filters), rows, pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination) };
}

async function stockLedgerVoucherDetails(voucherType, voucherId) {
  assertPostgresInventory();
  const type = String(voucherType || '').trim();
  const id = Number(voucherId);
  if (!type || !Number.isFinite(id)) {
    return null;
  }

  if (type === 'purchase') {
    const { rows } = await getPostgresPool().query(`
      SELECT purchase_no, posting_date::text, supplier_id, supplier_name,
        supplier_reference, docstatus, status, total::float, amount_paid::float
      FROM app_purchases WHERE id = $1
    `, [id]);
    const purchase = rows[0];
    if (!purchase) return null;
    const { rows: items } = await getPostgresPool().query(`
      SELECT item_code, warehouse, quantity::float, unit_price::float, line_total::float
      FROM app_purchase_items WHERE purchase_id = $1 ORDER BY line_no
    `, [id]);
    return {
      kind: 'purchase',
      title: purchase.purchase_no,
      href: `/purchases/${id}`,
      meta: {
        Supplier: purchase.supplier_name,
        Date: purchase.posting_date,
        Status: purchase.docstatus,
        Payment: purchase.status,
        Reference: purchase.supplier_reference || '',
      },
      items: items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse,
        quantity: item.quantity,
        rate: item.unit_price,
        amount: item.line_total,
      })),
      totals: {
        Total: purchase.total,
        Paid: purchase.amount_paid,
        Balance: purchase.total - purchase.amount_paid,
      },
    };
  }

  if (type === 'invoice') {
    const invoice = await findPostgresInvoice(id);
    if (!invoice) {
      return null;
    }
    return {
      kind: 'invoice',
      title: invoice.invoice_no,
      href: `/invoices/${invoice.id}`,
      meta: {
        Customer: invoice.customer_name,
        Date: invoice.invoice_date,
        Status: invoice.docstatus === 'draft' ? 'Draft' : invoice.docstatus === 'cancelled' ? 'Cancelled' : 'Submitted',
        Payment: invoice.status,
      },
      items: invoice.items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse || '',
        quantity: item.quantity,
        rate: item.unit_price,
        amount: item.line_total,
      })),
      totals: {
        Subtotal: invoice.subtotal,
        Discount: invoice.discount_amount,
        Tax: invoice.tax_amount,
        Total: invoice.total,
        Paid: invoice.amount_paid,
        Balance: Number(invoice.total || 0) - Number(invoice.amount_paid || 0),
      },
    };
  }

  if (type.startsWith('stock_')) {
    const { rows } = await getPostgresPool().query(
      `
      SELECT
        id, entry_no, entry_type, docstatus, posting_date::text, remarks, supplier_name,
        supplier_contact, supplier_phone, supplier_reference, cancellation_reason,
        cancelled_at::text
      FROM app_stock_entries
      WHERE id = $1
      `,
      [id],
    );
    const entry = rows[0];
    if (!entry) {
      return null;
    }
    const { rows: items } = await getPostgresPool().query(
      `
      SELECT item_code, warehouse, target_warehouse, quantity::float, valuation_rate::float
      FROM app_stock_entry_items
      WHERE stock_entry_id = $1
      ORDER BY line_no
      `,
      [id],
    );
    return {
      kind: 'stock_entry',
      id,
      entry_type: entry.entry_type,
      status: entry.docstatus || 'submitted',
      title: entry.entry_no,
      href: (entry.docstatus || 'submitted') === 'draft' ? `/stock/entries/${id}/edit` : '',
      meta: {
        Type: entry.entry_type,
        Status: entry.docstatus || 'submitted',
        Date: dateOnly(entry.posting_date),
        ...(entry.cancellation_reason ? { Cancellation: entry.cancellation_reason } : {}),
        Remarks: entry.remarks || '',
      },
      supplier: normalizeSupplierInfo(entry),
      items: items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse || '',
        target_warehouse: item.target_warehouse || '',
        quantity: Number(item.quantity || 0),
        rate: Number(item.valuation_rate || 0),
        amount: roundMoney(Number(item.quantity || 0) * Number(item.valuation_rate || 0)),
      })),
      totals: {
        Total: roundMoney(items.reduce((sum, item) => (
          sum + (Number(item.quantity || 0) * Number(item.valuation_rate || 0))
        ), 0)),
      },
    };
  }

  return null;
}

async function stockEntryDraftReport(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  const status = String(filters.status || 'draft').trim();
  const entryType = String(filters.entry_type || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  params.push(status);
  where.push(`se.docstatus = $${params.length}`);
  if (entryType) {
    params.push(entryType);
    where.push(`se.entry_type = $${params.length}`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`(item.warehouse = $${params.length} OR item.target_warehouse = $${params.length})`);
  }
  if (from) {
    params.push(from);
    where.push(`se.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`se.posting_date <= $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.warehouse, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.target_warehouse, '')) LIKE $${params.length}
      OR LOWER(se.entry_type) LIKE $${params.length}
      OR LOWER(se.docstatus) LIKE $${params.length}
      OR LOWER(COALESCE(se.entry_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.remarks, '')) LIKE $${params.length}
      OR item.quantity::text LIKE $${params.length}
      OR item.valuation_rate::text LIKE $${params.length}
      OR (item.quantity * item.valuation_rate)::text LIKE $${params.length}
    )`);
  }
  const whereSql = where.join(' AND ');
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_entries se
    JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      se.posting_date::text AS posting_date,
      item.item_code AS item_code,
      item.item_name AS item_name,
      item.warehouse AS warehouse,
      se.entry_type AS stock_entry_type,
      se.docstatus AS stock_entry_status,
      'stock_' || se.entry_type AS voucher_type,
      se.id AS voucher_id,
      se.entry_no AS voucher_no,
      false AS is_reversal,
      NULL::bigint AS reversal_of_voucher_id,
      NULL::text AS reversal_of_voucher_no,
      NULL::text AS ledger_remarks,
      CASE WHEN se.entry_type = 'cancel' THEN -item.quantity ELSE item.quantity END::float AS qty_change,
      CASE WHEN se.entry_type = 'cancel' THEN 0 ELSE item.valuation_rate END::float AS incoming_rate,
      CASE WHEN se.entry_type = 'cancel' THEN item.valuation_rate ELSE 0 END::float AS outgoing_rate,
      CASE
        WHEN se.entry_type = 'cancel' THEN -(item.quantity * item.valuation_rate)
        ELSE item.quantity * item.valuation_rate
      END::float AS stock_value_change,
      0::float AS qty_after_transaction,
      0::float AS stock_value_after_transaction
    FROM app_stock_entries se
    JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${whereSql}
    ORDER BY se.posting_date DESC, se.id DESC, item.line_no
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  return { filters: reportFilterValues(filters), rows, pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination) };
}

async function stockMovementReport(filters = {}) {
  assertPostgresInventory();
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const entryType = String(filters.entry_type || '').trim();
  const status = String(filters.status || 'posted').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (warehouse) {
    params.push(warehouse);
    where.push(`warehouse = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(warehouse) LIKE $${params.length}
      OR LOWER(voucher_type) LIKE $${params.length}
      OR LOWER(COALESCE(voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(reversal_of_voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(remarks, '')) LIKE $${params.length}
      OR posting_date::text LIKE $${params.length}
      OR qty_change::text LIKE $${params.length}
      OR incoming_rate::text LIKE $${params.length}
      OR outgoing_rate::text LIKE $${params.length}
      OR stock_value_change::text LIKE $${params.length}
      OR qty_after_transaction::text LIKE $${params.length}
      OR stock_value_after_transaction::text LIKE $${params.length}
    )`);
  }
  const fromSql = from ? `$${params.length + 1}::date` : 'NULL::date';
  if (from) {
    params.push(from);
  }
  const toSql = to ? `$${params.length + 1}::date` : 'NULL::date';
  if (to) {
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const groupedSql = `
    WITH movement AS (
      SELECT *
      FROM app_stock_ledger
      ${whereSql}
    ),
    grouped AS (
      SELECT
        item_code,
        item_name,
        warehouse,
        COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN qty_change ELSE 0 END), 0)::float AS opening_qty,
        COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN stock_value_change ELSE 0 END), 0)::float AS opening_value,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change > 0 THEN qty_change ELSE 0 END), 0)::float AS in_qty,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change < 0 THEN ABS(qty_change) ELSE 0 END), 0)::float AS out_qty,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) THEN stock_value_change ELSE 0 END), 0)::float AS value_change,
        COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN qty_change ELSE 0 END), 0)::float AS closing_qty,
        COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN stock_value_change ELSE 0 END), 0)::float AS closing_value
      FROM movement
      GROUP BY item_code, item_name, warehouse
    )
  `;
  const [countResult, summaryResult] = await Promise.all([
    getPostgresPool().query(
      `${groupedSql} SELECT COUNT(*)::int AS total FROM grouped`,
      params,
    ),
    getPostgresPool().query(
      `${groupedSql}
      SELECT
        COALESCE(SUM(opening_qty), 0)::float AS opening_qty,
        COALESCE(SUM(in_qty), 0)::float AS in_qty,
        COALESCE(SUM(out_qty), 0)::float AS out_qty,
        COALESCE(SUM(closing_qty), 0)::float AS closing_qty,
        COALESCE(SUM(opening_value), 0)::float AS opening_value,
        COALESCE(SUM(value_change), 0)::float AS value_change,
        COALESCE(SUM(closing_value), 0)::float AS closing_value
      FROM grouped`,
      params,
    ),
  ]);
  const pageParams = [...params, pagination.limit, pagination.offset];
  const { rows } = await getPostgresPool().query(
    `
    WITH movement AS (
      SELECT *
      FROM app_stock_ledger
      ${whereSql}
    )
    SELECT
      item_code,
      item_name,
      warehouse,
      COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN qty_change ELSE 0 END), 0)::float AS opening_qty,
      COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN stock_value_change ELSE 0 END), 0)::float AS opening_value,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change > 0 THEN qty_change ELSE 0 END), 0)::float AS in_qty,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change < 0 THEN ABS(qty_change) ELSE 0 END), 0)::float AS out_qty,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) THEN stock_value_change ELSE 0 END), 0)::float AS value_change,
      COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN qty_change ELSE 0 END), 0)::float AS closing_qty,
      COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN stock_value_change ELSE 0 END), 0)::float AS closing_value
    FROM movement
    GROUP BY item_code, item_name, warehouse
    ORDER BY item_name, warehouse
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
    `,
    pageParams,
  );
  return {
    filters: reportFilterValues(filters),
    rows,
    summary: summaryResult.rows[0] || {},
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}

async function stockMovementDetails(filters = {}) {
  assertPostgresInventory();
  const itemCode = String(filters.item_code || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const direction = String(filters.direction || '').trim();
  if (!itemCode || !warehouse || !['in', 'out'].includes(direction)) {
    const err = new Error('Item, warehouse, and direction are required.');
    err.status = 400;
    throw err;
  }
  const params = [itemCode, warehouse];
  const where = ['item_code = $1', 'warehouse = $2'];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  if (from) {
    params.push(from);
    where.push(`posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`posting_date <= $${params.length}`);
  }
  where.push(direction === 'in' ? 'qty_change > 0' : 'qty_change < 0');
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      posting_date::text,
      voucher_type,
      voucher_id,
      voucher_no,
      CASE
        WHEN voucher_type LIKE 'stock_%' THEN replace(voucher_type, 'stock_', '')
        WHEN voucher_type = 'purchase' THEN 'purchase'
        ELSE ''
      END AS stock_entry_type,
      ${direction === 'in' ? 'qty_change' : 'ABS(qty_change)'}::float AS qty,
      ${direction === 'in' ? 'incoming_rate' : 'outgoing_rate'}::float AS rate,
      ABS(stock_value_change)::float AS value,
      qty_after_transaction::float AS balance_qty,
      stock_value_after_transaction::float AS balance_value,
      remarks
    FROM app_stock_ledger
    WHERE ${where.join(' AND ')}
    ORDER BY posting_date DESC, id DESC
    LIMIT 200
    `,
    params,
  );
  return {
    item_code: itemCode,
    warehouse,
    direction,
    rows,
    summary: {
      qty: rows.reduce((sum, row) => sum + Number(row.qty || 0), 0),
      value: rows.reduce((sum, row) => sum + Number(row.value || 0), 0),
    },
  };
}

async function grossProfitReport(filters = {}) {
  assertPostgresInventory();
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = ["invoice.docstatus = 'submitted'"];
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (from) {
    params.push(from);
    where.push(`invoice.invoice_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`invoice.invoice_date <= $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      invoice.invoice_date::text LIKE $${params.length}
      OR LOWER(invoice.invoice_no) LIKE $${params.length}
      OR LOWER(invoice.customer_name) LIKE $${params.length}
      OR LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.warehouse, '')) LIKE $${params.length}
      OR item.quantity::text LIKE $${params.length}
      OR item.line_total::text LIKE $${params.length}
      OR item.cost_amount::text LIKE $${params.length}
      OR item.gross_profit::text LIKE $${params.length}
    )`);
  }
  const whereSql = where.join(' AND ');
  const [countResult, summaryResult] = await Promise.all([
    getPostgresPool().query(
      `
      SELECT COUNT(*)::int AS total
      FROM app_invoice_items item
      INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
      WHERE ${whereSql}
      `,
      params,
    ),
    getPostgresPool().query(
      `
      SELECT
        COALESCE(SUM(item.line_total), 0)::float AS sales_amount,
        COALESCE(SUM(item.cost_amount), 0)::float AS cost_amount,
        COALESCE(SUM(item.gross_profit), 0)::float AS gross_profit
      FROM app_invoice_items item
      INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
      WHERE ${whereSql}
      `,
      params,
    ),
  ]);
  const pageParams = [...params, pagination.limit, pagination.offset];
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      invoice.invoice_date::text,
      invoice.invoice_no,
      invoice.id AS invoice_id,
      invoice.customer_name,
      item.item_code,
      item.item_name,
      item.warehouse,
      item.quantity::float,
      item.line_total::float AS sales_amount,
      item.cost_amount::float,
      item.gross_profit::float
    FROM app_invoice_items item
    INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
    WHERE ${whereSql}
    ORDER BY invoice.invoice_date DESC, invoice.id DESC, item.line_no
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
    `,
    pageParams,
  );
  return {
    filters: reportFilterValues(filters),
    rows,
    summary: roundReportMoney(summaryResult.rows[0] || { sales_amount: 0, cost_amount: 0, gross_profit: 0 }),
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}

async function accountingAccounts() {
  assertPostgresAccounting();
  const { rows } = await getPostgresPool().query(`
    SELECT id, account_code, account_name, account_type, normal_balance, is_group, is_active
    FROM app_accounts
    ORDER BY account_code, account_name
  `);
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
  }));
}

async function postableAccountingAccounts() {
  return (await accountingAccounts())
    .filter((account) => account.is_active && !account.is_group);
}

async function createAccountingAccount(payload) {
  assertPostgresAccounting();
  const account = normalizeAccountingAccountPayload(payload);
  const { rows } = await getPostgresPool().query(
    `
    INSERT INTO app_accounts (
      account_code, account_name, account_type, normal_balance, is_group, is_active
    )
    VALUES ($1, $2, $3, $4, false, true)
    RETURNING id
    `,
    [account.account_code, account.account_name, account.account_type, account.normal_balance],
  );
  return Number(rows[0].id);
}

async function journalEntries(options = {}) {
  assertPostgresAccounting();
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
      journal_type, posting_date::text, party_type, party_id,
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
    created_at: toIsoString(row.created_at),
  }));
  journals.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  return journals;
}

async function findJournalEntry(id) {
  assertPostgresAccounting();
  const journalId = Number(id);
  if (!Number.isFinite(journalId)) {
    return null;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      id, journal_no, COALESCE(docstatus, 'submitted') AS docstatus,
      journal_type, posting_date::text, party_type, party_id,
      party_name, reference_no, remarks, total_debit::float, total_credit::float,
      created_at, created_by, created_by_user_id, updated_by, updated_by_user_id, updated_at,
      submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at
    FROM app_journal_entries
    WHERE id = $1
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
    created_at: toIsoString(journal.created_at),
    lines: lines.map((line) => ({ ...line, id: Number(line.id), account_id: Number(line.account_id) })),
  };
}

async function createJournalEntry(payload, options = {}) {
  assertPostgresAccounting();
  const journal = normalizeJournalEntryPayload(payload);
  const submit = options.submit !== false;
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      INSERT INTO app_journal_entries (
        journal_type, posting_date, party_type, party_id, party_name, reference_no,
        remarks, total_debit, total_credit, docstatus
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
  assertPostgresAccounting();
  const journal = normalizeJournalEntryPayload(payload);
  return withPostgresTransaction(async (client) => {
    const existing = await client.query('SELECT docstatus FROM app_journal_entries WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows[0]) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (existing.rows[0].docstatus !== 'draft') {
      const error = new Error('Only draft journals can be edited.'); error.status = 400; throw error;
    }
    await client.query(`UPDATE app_journal_entries SET journal_type = $2, posting_date = $3, party_type = $4,
      party_id = $5, party_name = $6, reference_no = $7, remarks = $8, total_debit = $9, total_credit = $10
      WHERE id = $1`, [id, journal.journal_type, journal.posting_date, journal.party_type, journal.party_id,
      journal.party_name, journal.reference_no, journal.remarks, journal.total_debit, journal.total_credit]);
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

async function syncGeneratedJournalEntryLines(client, journalId, lines, accountIds) {
  const existingResult = await client.query(
    'SELECT id, line_no FROM app_journal_entry_lines WHERE journal_entry_id = $1',
    [journalId],
  );
  const existingByLine = new Map(existingResult.rows.map((row) => [Number(row.line_no), Number(row.id)]));
  const seenIds = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    const dbId = existingByLine.get(lineNo);
    if (dbId) {
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
        [lineNo, accountIds[index], line.debit, line.credit, line.remarks, dbId, journalId],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingResult.rows.map((row) => Number(row.id))) {
    if (!seenIds.has(dbId)) {
      await client.query('DELETE FROM app_journal_entry_lines WHERE id = $1 AND journal_entry_id = $2', [dbId, journalId]);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (existingByLine.has(index + 1)) {
      continue;
    }
    const line = lines[index];
    await client.query(
      `
      INSERT INTO app_journal_entry_lines
        (journal_entry_id, line_no, account_id, debit, credit, remarks)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [journalId, index + 1, accountIds[index], line.debit, line.credit, line.remarks],
    );
  }
}

async function submitJournalEntry(id) {
  assertPostgresAccounting();
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

async function cancelJournalEntry(id) {
  assertPostgresAccounting();
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
    if (!isManualJournalType(journal.journal_type)) {
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

function isManualJournalType(type) {
  return ['cash_receipt', 'journal_entry'].includes(String(type || '').trim());
}

async function generalLedgerReport(filters = {}) {
  assertPostgresAccounting();
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
    ORDER BY gl.posting_date DESC, gl.id DESC
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
  assertPostgresAccounting();
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

async function generalLedgerAccountOptions(search = '') {
  assertPostgresAccounting();
  const params = [];
  const where = [];
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
  assertPostgresAccounting();
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
  assertPostgresAccounting();
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
        invoice_no AS reference,
        'Invoice' AS type,
        invoice_date::text AS posting_date,
        customer_name AS party_name,
        total::float AS amount,
        status,
        id
      FROM app_invoices
      WHERE customer_id = $1 OR customer_name = $2
      ORDER BY invoice_date DESC, id DESC
      LIMIT 200
      `,
      [partyId, partyName],
    );
    rows.forEach(addOption);
  }

  if (partyType === 'supplier') {
    const { rows } = await getPostgresPool().query(
      `
      SELECT
        entry_no AS reference,
        'Stock Entry' AS type,
        posting_date::text AS posting_date,
        supplier_name AS party_name,
        NULL::float AS amount,
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
        SUM(debit + credit)::float AS amount,
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
      option.status,
    ], search))
    .slice(0, limit);
}

async function trialBalanceReport(filters = {}) {
  assertPostgresAccounting();
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
  assertPostgresAccounting();
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
  assertPostgresAccounting();
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
  assertPostgresAccounting();
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
        SELECT id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id
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

async function backfillSalesInvoiceJournals(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT
        invoice.*,
        COALESCE(SUM(item.cost_amount), 0)::float AS total_cost
      FROM app_invoices invoice
      LEFT JOIN app_invoice_items item ON item.invoice_pk = invoice.id
      WHERE invoice.docstatus = 'submitted'
        AND NOT EXISTS (
          SELECT 1
          FROM app_journal_entries journal
          WHERE journal.journal_type = 'sales_invoice'
            AND journal.reference_no = invoice.invoice_no
        )
      GROUP BY invoice.id
      ORDER BY invoice.id
    `);
    for (const invoice of rows) {
      await postSalesInvoiceGlEntry(client, {
        ...invoice,
        id: Number(invoice.id),
        invoice_date: dateOnly(invoice.invoice_date),
        total_cost: roundMoney(invoice.total_cost),
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.warn(`Skipped sales invoice journal backfill: ${err.message}`);
  } finally {
    client.release();
  }
}

async function backfillInvoicePaymentJournals(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT
        payment.id,
        payment.payment_no,
        payment.payment_date,
        payment.amount,
        payment.method,
        payment.reference,
        payment.notes,
        payment.journal_entry_id,
        invoice.id AS invoice_id,
        invoice.invoice_no,
        invoice.invoice_date,
        invoice.customer_id,
        invoice.customer_name
      FROM app_invoice_payments payment
      INNER JOIN app_invoices invoice ON invoice.id = payment.invoice_id
      LEFT JOIN app_journal_entries journal ON journal.id = payment.journal_entry_id
      WHERE invoice.docstatus = 'submitted'
        AND payment.docstatus = 'submitted'
        AND (
          payment.journal_entry_id IS NULL
          OR journal.id IS NULL
        )
      ORDER BY payment.id
    `);
    for (const row of rows) {
      await createOrUpdatePaymentJournalEntry(client, {
        id: Number(row.invoice_id),
        invoice_no: row.invoice_no,
        invoice_date: dateOnly(row.invoice_date),
        customer_id: row.customer_id,
        customer_name: row.customer_name,
      }, row);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.warn(`Skipped invoice payment journal backfill: ${err.message}`);
  } finally {
    client.release();
  }
}

async function hydratePostgresInvoices(invoiceRows) {
  if (!invoiceRows.length) {
    return [];
  }

  const ids = invoiceRows.map((row) => Number(row.id));
  const [itemResult, paymentResult] = await Promise.all([
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
      SELECT *
      FROM app_invoice_payments
      WHERE invoice_id = ANY($1::bigint[])
      ORDER BY invoice_id, payment_no
      `,
      [ids],
    ),
  ]);

  const itemsByInvoice = groupByInvoiceId(itemResult.rows);
  const paymentsByInvoice = groupByInvoiceId(paymentResult.rows);
  return invoiceRows.map((row) => normalizeInvoiceTotals({
    ...recordAuditFields(row),
    id: Number(row.id),
    invoice_no: row.invoice_no,
    docstatus: row.docstatus,
    is_cash_sale: row.is_cash_sale,
    invoice_date: dateOnly(row.invoice_date),
    due_date: dateOnly(row.due_date),
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
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
    payments: (paymentsByInvoice.get(Number(row.id)) || []).map(postgresPaymentToInvoicePayment),
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
  ];
}

async function insertPostgresItems(client, invoiceId, invoiceNo, items) {
  for (const item of items || []) {
    await client.query(
      `
      INSERT INTO app_invoice_items (
        invoice_pk, invoice_id, invoice_no, line_no, item_code, item_name, warehouse,
        quantity, unit_price, stock_at_sale, line_total, cost_rate, cost_amount, gross_profit
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        invoiceId,
        invoiceId,
        invoiceNo,
        item.line_no ?? item.id,
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
      ],
    );
  }
}

async function syncPostgresInvoiceItems(client, invoiceId, invoiceNo, items) {
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
          line_total = $8
        WHERE id = $9
          AND invoice_pk = $10
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
        quantity, unit_price, stock_at_sale, line_total, cost_rate, cost_amount, gross_profit
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      ],
    );
  }
}

async function insertPostgresPayments(client, invoiceId, payments) {
  for (const payment of payments || []) {
    await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, reference, notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        invoiceId,
        payment.id,
        payment.payment_date,
        payment.amount,
        payment.method,
        payment.reference,
        payment.notes,
        payment.created_at,
      ],
    );
  }
}

async function withPostgresTransaction(callback) {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function postSalesInvoiceGlEntry(client, invoice) {
  const lines = salesInvoiceAccountingLines(invoice);
  await createOrUpdateSalesInvoiceJournalEntry(client, invoice, lines);
  await postGlEntry(client, {
    posting_date: dateOnly(invoice.invoice_date),
    voucher_type: 'sales_invoice',
    voucher_id: Number(invoice.id),
    voucher_no: invoice.invoice_no,
    remarks: 'Sales invoice submission',
    lines,
  });
}

function salesInvoiceAccountingLines(invoice) {
  const total = roundMoney(invoice.total);
  const taxAmount = roundMoney(invoice.tax_amount);
  const salesAmount = roundMoney(Math.max(0, Number(invoice.subtotal || 0) - Number(invoice.discount_amount || 0)));
  const totalCost = roundMoney(invoice.total_cost);
  const party = {
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
  };

  return [
    { account_key: 'accounts_receivable', debit: total, credit: 0, remarks: 'Sales invoice submission', ...party },
    { account_key: 'sales_income', debit: 0, credit: salesAmount, remarks: 'Sales invoice submission' },
    { account_key: 'tax_payable', debit: 0, credit: taxAmount, remarks: 'Sales tax' },
    { account_key: 'cost_of_goods_sold', debit: totalCost, credit: 0, remarks: 'Cost of goods sold' },
    { account_key: 'inventory', debit: 0, credit: totalCost, remarks: 'Inventory sold' },
  ];
}

async function createOrUpdateSalesInvoiceJournalEntry(client, invoice, journalLines = salesInvoiceAccountingLines(invoice)) {
  journalLines = nonZeroAccountingLines(journalLines);
  if (!journalLines.length) {
    return null;
  }
  const totalDebit = roundMoney(journalLines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const totalCredit = roundMoney(journalLines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  const remarks = `Sales invoice ${invoice.invoice_no || invoice.id}`;
  const { rows } = await client.query(
    `
    SELECT id, journal_no
    FROM app_journal_entries
    WHERE journal_type = 'sales_invoice'
      AND reference_no = $1
    ORDER BY id
    LIMIT 1
    `,
    [invoice.invoice_no || String(invoice.id)],
  );
  let journalId = rows[0] ? Number(rows[0].id) : null;
  let journalNo = rows[0] && rows[0].journal_no;

  if (journalId) {
    await client.query(
      `
      UPDATE app_journal_entries
      SET docstatus = 'submitted',
        posting_date = $1,
        party_type = 'customer',
        party_id = $2,
        party_name = $3,
        reference_no = $4,
        remarks = $5,
        total_debit = $6,
        total_credit = $7
      WHERE id = $8
      `,
      [
        dateOnly(invoice.invoice_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || String(invoice.id),
        remarks,
        totalDebit,
        totalCredit,
        journalId,
      ],
    );
  } else {
    const result = await client.query(
      `
      INSERT INTO app_journal_entries (
        docstatus, journal_type, posting_date, party_type, party_id, party_name,
        reference_no, remarks, total_debit, total_credit
      )
      VALUES ('submitted', 'sales_invoice', $1, 'customer', $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [
        dateOnly(invoice.invoice_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || String(invoice.id),
        remarks,
        totalDebit,
        totalCredit,
      ],
    );
    journalId = Number(result.rows[0].id);
  }

  if (!journalNo) {
    journalNo = `JRN-${String(journalId).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
      [journalNo, journalId],
    );
  }

  await setVoucherDocstatus(client, 'app_journal_entries', journalId, 'submitted');
  const accountIds = await resolveAccountingAccounts(client, journalLines);
  await syncGeneratedJournalEntryLines(client, journalId, journalLines, accountIds);

  return { id: journalId, journal_no: journalNo };
}

function nonZeroAccountingLines(lines = []) {
  return lines
    .map((line) => ({
      ...line,
      debit: roundMoney(line.debit),
      credit: roundMoney(line.credit),
    }))
    .filter((line) => line.debit > 0 || line.credit > 0);
}

async function postCustomerPaymentGlEntry(client, invoice, payment) {
  if (!payment) {
    return;
  }
  const amount = roundMoney(payment.amount);
  if (amount <= 0) {
    return;
  }
  const party = {
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
  };

  await postGlEntry(client, {
    posting_date: dateOnly(payment.payment_date),
    voucher_type: 'customer_payment',
    voucher_id: Number(payment.id),
    voucher_no: `${invoice.invoice_no || invoice.id}-PAY-${String(payment.payment_no || payment.id).padStart(3, '0')}`,
    remarks: payment.reference || payment.notes || 'Customer payment',
    lines: [
      { account_key: paymentAccountKey(payment.method), debit: amount },
      { account_key: 'accounts_receivable', credit: amount, ...party },
    ],
  });
}

async function createOrUpdatePaymentJournalEntry(client, invoice, payment) {
  if (!payment) {
    return null;
  }
  const amount = roundMoney(payment.amount);
  if (amount <= 0) {
    return null;
  }

  const originalReference = String(payment.reference || '').trim();
  const externalReference = /^JRN-\d+$/.test(originalReference) ? '' : originalReference;
  const remarks = payment.notes || externalReference || `Payment for ${invoice.invoice_no || invoice.id}`;
  const journalLines = [
    {
      account_key: paymentAccountKey(payment.method),
      debit: amount,
      credit: 0,
      remarks,
    },
    {
      account_key: 'accounts_receivable',
      debit: 0,
      credit: amount,
      party_type: 'customer',
      party_id: invoice.customer_id || null,
      party_name: invoice.customer_name || null,
      remarks,
    },
  ];
  const accountIds = await resolveAccountingAccounts(client, journalLines);
  const journalId = payment.journal_entry_id ? Number(payment.journal_entry_id) : null;
  let savedJournalId = journalId;
  let journalNo;

  if (savedJournalId) {
    const { rows } = await client.query(
      `
      UPDATE app_journal_entries
      SET journal_type = 'payment_journal',
        posting_date = $1,
        party_type = 'customer',
        party_id = $2,
        party_name = $3,
        reference_no = $4,
        remarks = $5,
        total_debit = $6,
        total_credit = $6
      WHERE id = $7
      RETURNING journal_no
      `,
      [
        dateOnly(payment.payment_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || null,
        remarks,
        amount,
        savedJournalId,
      ],
    );
    if (rows[0]) {
      journalNo = rows[0].journal_no;
      if (!journalNo) {
        journalNo = `JRN-${String(savedJournalId).padStart(6, '0')}`;
        await client.query(
          'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
          [journalNo, savedJournalId],
        );
      }
    } else {
      savedJournalId = null;
    }
  }

  if (!savedJournalId) {
    const { rows } = await client.query(
      `
      INSERT INTO app_journal_entries (
        journal_type, posting_date, party_type, party_id, party_name, reference_no,
        remarks, total_debit, total_credit
      )
      VALUES ('payment_journal', $1, 'customer', $2, $3, $4, $5, $6, $6)
      RETURNING id
      `,
      [
        dateOnly(payment.payment_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || null,
        remarks,
        amount,
      ],
    );
    savedJournalId = Number(rows[0].id);
    journalNo = `JRN-${String(savedJournalId).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
      [journalNo, savedJournalId],
    );
  }

  await setVoucherDocstatus(client, 'app_journal_entries', savedJournalId, 'submitted');
  await syncGeneratedJournalEntryLines(client, savedJournalId, journalLines, accountIds);

  await postGlEntry(client, {
    posting_date: dateOnly(payment.payment_date),
    voucher_type: 'payment_journal',
    voucher_id: savedJournalId,
    voucher_no: journalNo,
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
    remarks,
    lines: journalLines.map((line, index) => ({
      account_id: accountIds[index],
      debit: line.debit,
      credit: line.credit,
      party_type: line.party_type,
      party_id: line.party_id,
      party_name: line.party_name,
      remarks: line.remarks,
    })),
  });
  await client.query(
    'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
    ['customer_payment', Number(payment.id)],
  );

  await client.query(
    `
    UPDATE app_invoice_payments
    SET reference = $1,
      journal_entry_id = $2
    WHERE id = $3
    `,
    [journalNo, savedJournalId, Number(payment.id)],
  );
  return { id: savedJournalId, journal_no: journalNo };
}

async function postStockEntryGlEntry(client, entry) {
  const entryType = String(entry.entryType || '').replace(/^stock_/, '');
  if (entryType === 'transfer') {
    await client.query(
      `
      DELETE FROM app_gl_entries
      WHERE voucher_type IN ('stock_transfer', 'stock_transfer_reversal')
        AND voucher_id = $1
      `,
      [Number(entry.id)],
    );
    return;
  }

  const { rows } = await client.query(
    `
    SELECT
      COALESCE(SUM(stock_value_change), 0)::float AS value_change
    FROM app_stock_ledger
    WHERE voucher_id = $1
      AND voucher_type = $2
      AND is_reversal = $3
    `,
    [Number(entry.id), `stock_${entryType}`, Boolean(entry.isReversal)],
  );
  const valueChange = roundMoney(rows[0] ? rows[0].value_change : 0);
  const amount = Math.abs(valueChange);
  if (amount <= 0) {
    await client.query(
      'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
      [stockVoucherType(entryType, entry.isReversal), Number(entry.id)],
    );
    return;
  }

  const lines = stockEntryGlLines(entryType, valueChange, Boolean(entry.isReversal));
  if (!lines.length) {
    return;
  }

  await postGlEntry(client, {
    posting_date: dateOnly(entry.postingDate),
    voucher_type: stockVoucherType(entryType, entry.isReversal),
    voucher_id: Number(entry.id),
    voucher_no: entry.entryNo,
    remarks: entry.remarks || stockEntryGlRemarks(entryType, entry.isReversal),
    is_reversal: Boolean(entry.isReversal),
    reversal_of_voucher_type: entry.isReversal ? `stock_${entryType}` : null,
    reversal_of_voucher_id: entry.isReversal ? Number(entry.id) : null,
    lines: lines.map((line) => ({ ...line, debit: line.debit || 0, credit: line.credit || 0 })),
  });
}

function stockEntryGlLines(entryType, valueChange, isReversal = false) {
  const amount = Math.abs(roundMoney(valueChange));
  if (amount <= 0) {
    return [];
  }
  if (entryType === 'opening') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'opening_equity', credit: amount },
      ]
      : [
        { account_key: 'opening_equity', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (entryType === 'purchase') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'accounts_payable', credit: amount },
      ]
      : [
        { account_key: 'accounts_payable', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (entryType === 'adjustment' || entryType === 'cancel') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'stock_adjustment_gain', credit: amount },
      ]
      : [
        { account_key: 'stock_adjustment_loss', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (isReversal) {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'stock_adjustment_gain', credit: amount },
      ]
      : [
        { account_key: 'stock_adjustment_loss', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  return [];
}

function stockVoucherType(entryType, isReversal = false) {
  return isReversal ? `stock_${entryType}_reversal` : `stock_${entryType}`;
}

function stockEntryGlRemarks(entryType, isReversal = false) {
  const label = entryType
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return isReversal ? `${label} cancellation` : `${label} stock entry`;
}

function paymentAccountKey(method) {
  const value = String(method || '').trim().toLowerCase();
  if (value === 'bank') {
    return 'bank';
  }
  if (value === 'mobile_money') {
    return 'mobile_money';
  }
  if (value === 'card') {
    return 'card_clearing';
  }
  if (value === 'other') {
    return 'cash';
  }
  return 'cash';
}

async function postGlEntry(client, entry) {
  const lines = (entry.lines || [])
    .map((line) => ({
      ...line,
      debit: roundMoney(line.debit),
      credit: roundMoney(line.credit),
    }))
    .filter((line) => line.debit > 0 || line.credit > 0);
  if (!lines.length) {
    return;
  }

  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit !== totalCredit) {
    const err = new Error(`GL entry is not balanced. Debit ${totalDebit}, credit ${totalCredit}.`);
    err.status = 400;
    throw err;
  }
  if (lines.some((line) => line.debit > 0 && line.credit > 0)) {
    const err = new Error('GL entry lines cannot contain both debit and credit.');
    err.status = 400;
    throw err;
  }

  await client.query(
    'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
    [entry.voucher_type, Number(entry.voucher_id)],
  );

  const accountIds = await resolveAccountingAccounts(client, lines);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(
      `
      INSERT INTO app_gl_entries (
        posting_date, account_id, party_type, party_id, party_name, voucher_type,
        voucher_id, voucher_no, line_no, debit, credit, remarks, is_reversal,
        reversal_of_voucher_type, reversal_of_voucher_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        entry.posting_date,
        accountIds[index],
        line.party_type || entry.party_type || null,
        line.party_id || entry.party_id || null,
        line.party_name || entry.party_name || null,
        entry.voucher_type,
        Number(entry.voucher_id),
        entry.voucher_no || null,
        index + 1,
        line.debit,
        line.credit,
        line.remarks || entry.remarks || null,
        Boolean(entry.is_reversal),
        entry.reversal_of_voucher_type || null,
        entry.reversal_of_voucher_id || null,
      ],
    );
  }
}

async function reverseVoucherGlEntries(client, voucherType, voucherId, postingDate) {
  const { rows } = await client.query(
    `SELECT account_id, party_type, party_id, party_name, voucher_no,
      debit::float, credit::float
     FROM app_gl_entries
     WHERE voucher_type = $1 AND voucher_id = $2 AND is_reversal = false
     ORDER BY line_no`,
    [voucherType, Number(voucherId)],
  );
  if (!rows.length) return;
  await postGlEntry(client, {
    posting_date: postingDate,
    voucher_type: `${voucherType}_cancellation`,
    voucher_id: Number(voucherId),
    voucher_no: rows[0].voucher_no,
    remarks: `Cancellation of ${rows[0].voucher_no || voucherType}`,
    is_reversal: true,
    reversal_of_voucher_type: voucherType,
    reversal_of_voucher_id: Number(voucherId),
    lines: rows.map((row) => ({
      account_id: row.account_id,
      party_type: row.party_type,
      party_id: row.party_id,
      party_name: row.party_name,
      debit: Number(row.credit || 0),
      credit: Number(row.debit || 0),
    })),
  });
}

async function resolveAccountingAccounts(client, lines) {
  const keys = [...new Set(lines.map((line) => line.account_key).filter(Boolean))];
  const accountIdsByKey = new Map();
  if (keys.length) {
    const { rows } = await client.query(
      `
      SELECT setting.setting_key, setting.account_id
      FROM app_accounting_settings setting
      WHERE setting.setting_key = ANY($1::text[])
      `,
      [keys],
    );
    for (const row of rows) {
      accountIdsByKey.set(row.setting_key, Number(row.account_id));
    }
  }

  return lines.map((line) => {
    if (line.account_id) {
      return Number(line.account_id);
    }
    const accountId = accountIdsByKey.get(line.account_key);
    if (!accountId) {
      const err = new Error(`Accounting account mapping is missing for ${line.account_key}.`);
      err.status = 500;
      throw err;
    }
    return accountId;
  });
}

function groupByInvoiceId(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const invoiceId = Number(row.invoice_pk ?? row.invoice_id);
    if (!grouped.has(invoiceId)) {
      grouped.set(invoiceId, []);
    }
    grouped.get(invoiceId).push(row);
  }
  return grouped;
}

function postgresItemToInvoiceItem(row) {
  return {
    ...recordAuditFields(row),
    id: Number(row.id),
    db_id: Number(row.id),
    line_no: Number(row.line_no),
    item_code: row.item_code,
    item_name: row.item_name,
    warehouse: row.warehouse,
    quantity: Number(row.quantity || 0),
    unit_price: Number(row.unit_price || 0),
    stock_at_sale: row.stock_at_sale == null ? null : Number(row.stock_at_sale),
    line_total: Number(row.line_total || 0),
    cost_rate: Number(row.cost_rate || 0),
    cost_amount: Number(row.cost_amount || 0),
    gross_profit: Number(row.gross_profit || 0),
  };
}

function postgresPaymentToInvoicePayment(row) {
  return {
    ...recordAuditFields(row),
    id: Number(row.payment_no),
    docstatus: row.docstatus || 'submitted',
    payment_date: dateOnly(row.payment_date),
    amount: Number(row.amount || 0),
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    created_at: toIsoString(row.created_at),
  };
}

function normalizeStockEntryItems(rows, entryType) {
  return (Array.isArray(rows) ? rows : []).reduce((items, row) => {
    const itemCode = String(row.item_code || '').trim();
    const itemName = String(row.item_name || itemCode).trim();
    const warehouse = String(row.warehouse || '').trim();
    const targetWarehouse = String(row.target_warehouse || '').trim() || null;
    const quantity = normalizeQuantity(row.quantity);
    const signedQuantity = entryType === 'adjustment'
      ? Number(Number(row.quantity || 0).toFixed(3))
      : quantity;
    const valuationRate = roundMoney(Math.max(0, Number(row.valuation_rate || 0)));
    if (!itemCode || !itemName || !warehouse || signedQuantity === 0) {
      return items;
    }
    if (entryType === 'transfer' && !targetWarehouse) {
      return items;
    }
    items.push({
      id: Number(row.id || 0),
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      target_warehouse: targetWarehouse,
      quantity: signedQuantity,
      valuation_rate: valuationRate,
    });
    return items;
  }, []);
}

function normalizeSupplierInfo(row = {}) {
  return {
    supplier_name: String(row.supplier_name || '').trim(),
    supplier_contact: String(row.supplier_contact || '').trim(),
    supplier_phone: String(row.supplier_phone || '').trim(),
    supplier_reference: String(row.supplier_reference || '').trim(),
  };
}

async function insertStockEntryItems(client, stockEntryId, items) {
  let lineNo = 0;
  for (const item of items) {
    lineNo += 1;
    await client.query(
      `
      INSERT INTO app_stock_entry_items (
        stock_entry_id, line_no, item_code, item_name, warehouse,
        target_warehouse, quantity, valuation_rate
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        stockEntryId,
        lineNo,
        item.item_code,
        item.item_name,
        item.warehouse,
        item.target_warehouse,
        item.quantity,
        item.valuation_rate,
      ],
    );
  }
}

async function syncStockEntryItems(client, stockEntryId, items) {
  const existingResult = await client.query(
    'SELECT id FROM app_stock_entry_items WHERE stock_entry_id = $1',
    [stockEntryId],
  );
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.id)));
  const seenIds = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const dbId = Number(item.id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      await client.query(
        `
        UPDATE app_stock_entry_items
        SET line_no = $1,
          item_code = $2,
          item_name = $3,
          warehouse = $4,
          target_warehouse = $5,
          quantity = $6,
          valuation_rate = $7
        WHERE id = $8
          AND stock_entry_id = $9
        `,
        [
          index + 1,
          item.item_code,
          item.item_name,
          item.warehouse,
          item.target_warehouse,
          item.quantity,
          item.valuation_rate,
          dbId,
          stockEntryId,
        ],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingIds) {
    if (!seenIds.has(dbId)) {
      await client.query('DELETE FROM app_stock_entry_items WHERE id = $1 AND stock_entry_id = $2', [dbId, stockEntryId]);
    }
  }

  const newItems = items.filter((item) => !(Number(item.id || 0) > 0 && existingIds.has(Number(item.id))));
  await insertStockEntryItems(client, stockEntryId, newItems);
}

async function postStockEntryMovements(client, { id, entryNo, entryType, postingDate, items }) {
  for (const item of items) {
    if (entryType === 'transfer') {
      const outgoing = await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'stock_transfer',
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: -Math.abs(item.quantity),
      });
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.target_warehouse,
        voucher_type: 'stock_transfer',
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: Math.abs(item.quantity),
        rate: outgoing.outgoing_rate,
      });
    } else {
      const qtyChange = entryType === 'adjustment'
        ? item.quantity
        : entryType === 'cancel'
          ? -Math.abs(item.quantity)
          : Math.abs(item.quantity);
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: `stock_${entryType}`,
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: qtyChange,
        rate: item.valuation_rate,
      });
    }
  }
}

async function applyPostgresStockMovement(client, movement) {
  const itemCode = String(movement.item_code || '').trim();
  const itemName = String(movement.item_name || itemCode).trim();
  const warehouse = String(movement.warehouse || '').trim();
  const qtyChange = Number(Number(movement.qty_change || 0).toFixed(3));
  if (!itemCode || !warehouse || qtyChange === 0) {
    const err = new Error('Stock movement requires item, warehouse, and quantity.');
    err.status = 400;
    throw err;
  }

  await client.query(
    `
    INSERT INTO app_stock_balances (item_code, warehouse, item_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (item_code, warehouse)
    DO UPDATE SET item_name = EXCLUDED.item_name
    `,
    [itemCode, warehouse, itemName],
  );
  const { rows } = await client.query(
    `
    SELECT *
    FROM app_stock_balances
    WHERE item_code = $1
      AND warehouse = $2
    FOR UPDATE
    `,
    [itemCode, warehouse],
  );
  const balance = rows[0];
  const previousQuantity = Number(balance.quantity || 0);
  const previousValue = Number(balance.stock_value || 0);
  const previousRate = Number(balance.valuation_rate || 0);

  let incomingRate = 0;
  let outgoingRate = 0;
  let valueChange = 0;
  if (qtyChange > 0) {
    incomingRate = roundMoney(Number(movement.rate || previousRate || 0));
    valueChange = roundMoney(qtyChange * incomingRate);
  } else {
    if (previousQuantity + qtyChange < -0.0005) {
      const err = new Error(`Insufficient stock for ${itemName} in ${warehouse}.`);
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: itemName,
        item_code: itemCode,
        warehouse,
        requested: Math.abs(qtyChange),
        available: previousQuantity,
      };
      throw err;
    }
    outgoingRate = roundMoney(Number(movement.force_outgoing_rate || previousRate));
    valueChange = -roundMoney(Math.abs(qtyChange) * outgoingRate);
  }

  const newQuantity = Number((previousQuantity + qtyChange).toFixed(3));
  const newValue = roundMoney(previousValue + valueChange);
  const newRate = newQuantity > 0 ? roundMoney(newValue / newQuantity) : 0;

  await client.query(
    `
    UPDATE app_stock_balances
    SET item_name = $1,
      quantity = $2,
      stock_value = $3,
      valuation_rate = $4,
      updated_at = now()
    WHERE item_code = $5
      AND warehouse = $6
    `,
    [itemName, newQuantity, newValue, newRate, itemCode, warehouse],
  );
  await client.query(
    `
    INSERT INTO app_stock_ledger (
      posting_date, item_code, item_name, warehouse, voucher_type, voucher_id, voucher_no,
      qty_change, incoming_rate, outgoing_rate, stock_value_change,
      qty_after_transaction, stock_value_after_transaction, is_reversal,
      reversal_of_voucher_id, reversal_of_voucher_no, remarks
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `,
    [
      movement.posting_date,
      itemCode,
      itemName,
      warehouse,
      movement.voucher_type,
      movement.voucher_id || null,
      movement.voucher_no || null,
      qtyChange,
      incomingRate,
      outgoingRate,
      valueChange,
      newQuantity,
      newValue,
      Boolean(movement.is_reversal),
      movement.reversal_of_voucher_id || null,
      movement.reversal_of_voucher_no || null,
      movement.remarks || null,
    ],
  );

  return {
    previous_quantity: previousQuantity,
    quantity: newQuantity,
    valuation_rate: newRate,
    incoming_rate: incomingRate,
    outgoing_rate: outgoingRate,
    stock_value_change: valueChange,
  };
}

function addReportFilters(where, params, filters = {}) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const entryType = String(filters.entry_type || '').trim();
  const status = String(filters.status || 'posted').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (from) {
    params.push(from);
    where.push(`l.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`l.posting_date <= $${params.length}`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`l.warehouse = $${params.length}`);
  }
  if (entryType) {
    params.push(entryType);
    where.push(`(
      (l.voucher_type LIKE 'stock_%' AND COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', '')) = $${params.length})
      OR (l.voucher_type = 'purchase' AND $${params.length} = 'purchase')
    )`);
  }
  if (status === 'posted') {
    where.push(`CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END IN ('submitted', 'cancelled')`);
  } else if (status) {
    params.push(status);
    where.push(`CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      l.posting_date::text LIKE $${params.length}
      OR LOWER(l.item_code) LIKE $${params.length}
      OR LOWER(l.item_name) LIKE $${params.length}
      OR LOWER(l.warehouse) LIKE $${params.length}
      OR LOWER(l.voucher_type) LIKE $${params.length}
      OR LOWER(COALESCE(l.voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(l.reversal_of_voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(l.remarks, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', ''))) LIKE $${params.length}
      OR LOWER(CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END) LIKE $${params.length}
      OR l.qty_change::text LIKE $${params.length}
      OR l.incoming_rate::text LIKE $${params.length}
      OR l.outgoing_rate::text LIKE $${params.length}
      OR l.stock_value_change::text LIKE $${params.length}
      OR l.qty_after_transaction::text LIKE $${params.length}
      OR l.stock_value_after_transaction::text LIKE $${params.length}
    )`);
  }
}

function reportFilterValues(filters = {}) {
  return {
    search: String(filters.search || '').trim(),
    warehouse: String(filters.warehouse || '').trim(),
    entry_type: String(filters.entry_type || '').trim(),
    status: String(filters.status || 'posted').trim(),
    from: String(filters.from || '').trim(),
    to: String(filters.to || '').trim(),
  };
}

function dateOnly(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function actorAuditValues() {
  const actor = auditActor();
  return {
    by: actor.name || null,
    by_user_id: actor.id || null,
    at: new Date().toISOString(),
  };
}

async function setVoucherDocstatus(client, table, id, status) {
  const actor = actorAuditValues();
  if (status === 'submitted') {
    await client.query(
      `UPDATE ${table}
       SET docstatus = 'submitted',
           submitted_by = $2,
           submitted_by_user_id = $3,
           submitted_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, actor.by, actor.by_user_id, actor.at],
    );
    return;
  }
  if (status === 'cancelled') {
    await client.query(
      `UPDATE ${table}
       SET docstatus = 'cancelled',
           cancelled_by = $2,
           cancelled_by_user_id = $3,
           cancelled_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, actor.by, actor.by_user_id, actor.at],
    );
    return;
  }
  throw new Error('Unsupported voucher docstatus change.');
}

function toIsoString(value) {
  if (!value) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function nullableIsoString(value) {
  return value ? toIsoString(value) : null;
}

async function readStore() {
  await initStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  return JSON.parse(raw);
}

async function writeStore(store) {
  let previous = { invoices: [] };
  try { previous = JSON.parse(await fs.readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  stampRecordList(store.invoices, previous.invoices);
  const tmp = `${dataFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, dataFile);
}

function roundMoney(value) {
  return Math.round(Number(value || 0));
}

function numberValue(value) {
  return Number(value || 0);
}

function optionalValue(value) {
  return String(value || '').trim() || null;
}

function requiredValue(value, message) {
  const normalized = optionalValue(value);
  if (!normalized) {
    const err = new Error(message);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function normalizeQuantity(value) {
  return Math.max(0, Number(Number(value || 0).toFixed(3)));
}

function normalizeStockQuantity(value) {
  const quantity = Number(value || 0);
  const rounded = Math.round(quantity);
  return Math.abs(quantity - rounded) <= 0.0015
    ? rounded
    : Number(quantity.toFixed(3));
}

function isSubmitted(invoice) {
  return (invoice.docstatus || 'submitted') === 'submitted';
}

function buildInvoiceData(payload) {
  if (!isValidIsoDate(payload.invoice_date)) {
    const err = new Error('Choose a valid invoice date.');
    err.status = 400;
    throw err;
  }
  if (payload.due_date && !isValidIsoDate(payload.due_date)) {
    const err = new Error('Choose a valid due date.');
    err.status = 400;
    throw err;
  }
  const items = (payload.items || [])
    .map((item) => {
      const dbId = Number(item.db_id || item.id || 0);
      return {
        id: 0,
        db_id: Number.isFinite(dbId) ? dbId : 0,
        item_code: String(item.item_code || '').trim(),
        item_name: String(item.item_name || '').trim(),
        warehouse: String(item.warehouse || '').trim() || null,
        quantity: normalizeQuantity(item.quantity),
        unit_price: roundMoney(item.unit_price),
        stock_at_sale: item.stock_at_sale === '' || item.stock_at_sale == null
          ? null
          : Number(item.stock_at_sale),
      };
    })
    .filter((item) => item.item_code && item.item_name && item.quantity > 0);

  if (!items.length) {
    const err = new Error('Add at least one invoice item.');
    err.status = 400;
    throw err;
  }

  const subtotal = items.reduce((sum, item, index) => {
    item.id = index + 1;
    item.line_no = index + 1;
    item.line_total = roundMoney(item.quantity * item.unit_price);
    return sum + item.line_total;
  }, 0);
  const discount = Math.max(0, Number(payload.discount_amount || 0));
  const tax = Math.max(0, Number(payload.tax_amount || 0));
  const total = roundMoney(Math.max(0, subtotal - discount + tax));
  const payments = buildInvoicePayments(payload, total);
  const amountPaid = sumPayments(payments);
  const status = paymentStatus(total, amountPaid);

  return {
    invoice_date: payload.invoice_date,
    due_date: payload.due_date || null,
    customer_id: payload.customer_id || null,
    customer_name: payload.customer_name,
    customer_phone: payload.customer_phone || null,
    notes: payload.notes || null,
    subtotal: roundMoney(subtotal),
    tax_amount: roundMoney(tax),
    discount_amount: roundMoney(discount),
    total,
    amount_paid: roundMoney(amountPaid),
    status,
    payments,
    items,
  };
}

function normalizeJournalEntryPayload(payload) {
  const journalType = String(payload.journal_type || '').trim();
  if (!JOURNAL_TYPES.includes(journalType)) {
    const err = new Error('Choose a valid journal type.');
    err.status = 400;
    throw err;
  }
  const postingDate = String(payload.posting_date || '').trim();
  if (!isValidIsoDate(postingDate)) {
    const err = new Error('Choose a valid posting date.');
    err.status = 400;
    throw err;
  }
  const lines = (payload.lines || [])
    .map((line, index) => ({
      id: Number(line.id || 0),
      line_no: index + 1,
      account_id: Number(line.account_id),
      debit: roundMoney(line.debit),
      credit: roundMoney(line.credit),
      remarks: String(line.remarks || '').trim() || null,
    }))
    .filter((line) => Number.isFinite(line.account_id) && (line.debit > 0 || line.credit > 0));

  if (lines.length < 2) {
    const err = new Error('Add at least two journal lines.');
    err.status = 400;
    throw err;
  }
  if (lines.some((line) => line.debit > 0 && line.credit > 0)) {
    const err = new Error('A journal line cannot have both debit and credit.');
    err.status = 400;
    throw err;
  }

  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit !== totalCredit) {
    const err = new Error('Journal debits and credits must balance.');
    err.status = 400;
    throw err;
  }

  return {
    journal_type: journalType,
    posting_date: postingDate,
    party_type: String(payload.party_type || '').trim() || null,
    party_id: String(payload.party_id || '').trim() || null,
    party_name: String(payload.party_name || '').trim() || null,
    reference_no: String(payload.reference_no || '').trim() || null,
    remarks: String(payload.remarks || '').trim() || null,
    total_debit: totalDebit,
    total_credit: totalCredit,
    lines: lines.map((line, index) => ({ ...line, line_no: index + 1 })),
  };
}

function normalizeAccountingAccountPayload(payload) {
  const accountCode = String(payload.account_code || '').trim();
  const accountName = String(payload.account_name || '').trim();
  const accountType = String(payload.account_type || '').trim();
  const normalBalance = String(payload.normal_balance || '').trim();
  if (!accountCode) {
    const err = new Error('Account code is required.');
    err.status = 400;
    throw err;
  }
  if (!accountName) {
    const err = new Error('Account name is required.');
    err.status = 400;
    throw err;
  }
  if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(accountType)) {
    const err = new Error('Choose a valid account type.');
    err.status = 400;
    throw err;
  }
  if (!['debit', 'credit'].includes(normalBalance)) {
    const err = new Error('Choose a valid normal balance.');
    err.status = 400;
    throw err;
  }
  return {
    account_code: accountCode,
    account_name: accountName,
    account_type: accountType,
    normal_balance: normalBalance,
  };
}

function formatTrialBalanceRow(row) {
  const opening = Number(row.opening_balance || 0);
  const closing = Number(row.closing_balance || 0);
  return {
    account_code: row.account_code,
    account_name: row.account_name,
    account_type: row.account_type,
    normal_balance: row.normal_balance,
    opening_debit: opening > 0 ? roundMoney(opening) : 0,
    opening_credit: opening < 0 ? roundMoney(Math.abs(opening)) : 0,
    period_debit: roundMoney(row.period_debit),
    period_credit: roundMoney(row.period_credit),
    closing_debit: closing > 0 ? roundMoney(closing) : 0,
    closing_credit: closing < 0 ? roundMoney(Math.abs(closing)) : 0,
  };
}

function journalTypeLabel(type) {
  if (type === 'cash_receipt') {
    return 'Cash Receipt';
  }
  if (type === 'payment_journal') {
    return 'Payment Journal';
  }
  if (type === 'sales_invoice') {
    return 'Sales Invoice';
  }
  if (type === 'customer_payment') {
    return 'Customer Payment';
  }
  if (String(type || '').startsWith('stock_')) {
    return String(type)
      .replace(/^stock_/, '')
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return 'Journal Entry';
}

function buildInvoicePayments(payload, total) {
  const rows = Array.isArray(payload.payments) ? payload.payments : [];
  const payments = rows.reduce((list, row) => {
    const amount = roundMoney(Math.max(0, Number(row.amount || 0)));
    if (amount <= 0) {
      return list;
    }
    const method = String(row.method || 'cash').trim().toLowerCase();
    if (!PAYMENT_METHODS.has(method)) {
      const err = new Error('Choose a valid payment method.');
      err.status = 400;
      throw err;
    }
    list.push({
      id: list.length + 1,
      payment_date: String(row.payment_date || row.date || payload.invoice_date || '').trim(),
      amount,
      method,
      reference: String(row.reference || '').trim() || null,
      notes: String(row.notes || '').trim() || null,
      created_at: row.created_at || new Date().toISOString(),
    });
    return list;
  }, []);

  if (!payments.length) {
    const legacyAmount = roundMoney(Math.max(0, Number(payload.amount_paid || 0)));
    if (legacyAmount > 0) {
      payments.push({
        id: 1,
        payment_date: payload.invoice_date,
        amount: legacyAmount,
        method: 'cash',
        reference: null,
        notes: 'Initial payment',
        created_at: new Date().toISOString(),
      });
    }
  }

  if (payments.some((payment) => !payment.payment_date)) {
    const err = new Error('Payment date is required.');
    err.status = 400;
    throw err;
  }
  if (payments.some((payment) => !payment.method)) {
    const err = new Error('Payment method is required.');
    err.status = 400;
    throw err;
  }
  if (sumPayments(payments) > Number(total || 0)) {
    const err = new Error('Total payments cannot exceed the invoice total.');
    err.status = 400;
    throw err;
  }

  return payments;
}

function buildPaymentData(payload, existingPayments, existingId = null, existingCreatedAt = null) {
  const amount = roundMoney(Math.max(0, Number(payload.amount || 0)));
  if (amount <= 0) {
    const err = new Error('Payment amount must be greater than zero.');
    err.status = 400;
    throw err;
  }

  const paymentDate = String(payload.payment_date || '').trim();
  if (!isValidIsoDate(paymentDate)) {
    const err = new Error('Choose a valid payment date.');
    err.status = 400;
    throw err;
  }

  const method = String(payload.method || '').trim().toLowerCase();
  if (!PAYMENT_METHODS.has(method)) {
    const err = new Error('Choose a valid payment method.');
    err.status = 400;
    throw err;
  }

  const nextId = existingId || existingPayments.reduce((max, payment) => Math.max(max, Number(payment.id || 0)), 0) + 1;
  return {
    id: nextId,
    payment_date: paymentDate,
    amount,
    method,
    reference: String(payload.reference || '').trim() || null,
    notes: String(payload.notes || '').trim() || null,
    created_at: existingCreatedAt || new Date().toISOString(),
  };
}

function normalizeInvoiceTotals(invoice) {
  const hasItems = Array.isArray(invoice.items) && invoice.items.length > 0;
  const items = (invoice.items || []).map((item, index) => {
    const quantity = normalizeQuantity(item.quantity);
    const unitPrice = roundMoney(item.unit_price);
    return {
      ...item,
      id: Number(item.id || index + 1),
      quantity,
      unit_price: unitPrice,
      line_total: roundMoney(quantity * unitPrice),
    };
  });
  const subtotal = hasItems
    ? items.reduce((sum, item) => sum + Number(item.line_total || 0), 0)
    : roundMoney(invoice.subtotal);
  const discount = roundMoney(invoice.discount_amount);
  const tax = roundMoney(invoice.tax_amount);
  const total = hasItems
    ? roundMoney(Math.max(0, subtotal - discount + tax))
    : roundMoney(invoice.total);
  const docstatus = invoice.docstatus || 'submitted';
  const payments = docstatus === 'draft' ? [] : normalizePayments(invoice);
  const amountPaid = docstatus === 'draft' ? 0 : sumPayments(payments);

  Object.assign(invoice, {
    is_cash_sale: invoice.is_cash_sale ?? payments.some((payment) => (
      String(payment.notes || '').trim().toLowerCase() === 'cash sale'
      && Number(payment.amount) >= total && total > 0
    )),
    items,
    subtotal: roundMoney(subtotal),
    discount_amount: discount,
    tax_amount: tax,
    total,
    payments,
    amount_paid: amountPaid,
    status: paymentStatus(total, amountPaid),
  });

  return invoice;
}

function normalizePayments(invoice) {
  if (Array.isArray(invoice.payments) && invoice.payments.length) {
    return invoice.payments.map((payment, index) => ({
      ...recordAuditFields(payment),
      id: Number(payment.id || index + 1),
      payment_date: payment.payment_date || payment.date || invoice.invoice_date,
      amount: roundMoney(Math.max(0, Number(payment.amount || 0))),
      docstatus: payment.docstatus || 'submitted',
      method: payment.method || 'cash',
      reference: payment.reference || null,
      notes: payment.notes || null,
      created_at: payment.created_at || invoice.created_at || new Date().toISOString(),
    })).filter((payment) => payment.amount > 0);
  }

  const legacyAmount = roundMoney(Math.max(0, Number(invoice.amount_paid || 0)));
  if (legacyAmount <= 0) {
    return [];
  }
  return [{
    id: 1,
    payment_date: invoice.invoice_date,
    amount: legacyAmount,
    docstatus: 'submitted',
    method: 'legacy',
    reference: null,
    notes: 'Recorded before payment history was added',
    created_at: invoice.created_at || new Date().toISOString(),
  }];
}

function applyPaymentTotals(invoice) {
  const amountPaid = roundMoney(sumPayments(invoice.payments || []));
  invoice.amount_paid = amountPaid;
  invoice.status = paymentStatus(invoice.total, amountPaid);
}

function sumPayments(payments) {
  return roundMoney((payments || []).reduce((sum, payment) => (
    payment.docstatus === 'cancelled' ? sum : sum + Number(payment.amount || 0)
  ), 0));
}

function paymentStatus(total, amountPaid) {
  const invoiceTotal = Number(total || 0);
  const paid = Number(amountPaid || 0);
  if (paid <= 0) {
    return 'unpaid';
  }
  return paid >= invoiceTotal ? 'paid' : 'partial';
}

function buildCustomerStatement(invoices, customerKey) {
  const rows = [];
  for (const invoice of invoices.filter((row) => customerReportKey(row) === customerKey)) {
    rows.push({
      date: invoice.invoice_date,
      type: 'Invoice',
      reference: invoice.invoice_no,
      description: invoice.notes || 'Invoice issued',
      debit: roundMoney(invoice.total),
      credit: 0,
      invoice_id: invoice.id,
      balance_due: roundMoney(Math.max(0, Number(invoice.total || 0) - Number(invoice.amount_paid || 0))),
    });

    for (const payment of normalizePayments(invoice).filter((row) => row.docstatus === 'submitted')) {
      rows.push({
        date: payment.payment_date,
        type: 'Payment',
        reference: payment.reference || invoice.invoice_no,
        description: payment.method,
        debit: 0,
        credit: roundMoney(payment.amount),
        invoice_id: invoice.id,
      });
    }
  }

  rows.sort((a, b) => (
    String(a.date).localeCompare(String(b.date))
    || typeSort(a.type) - typeSort(b.type)
    || Number(a.invoice_id || 0) - Number(b.invoice_id || 0)
  ));

  let balance = 0;
  return rows.map((row) => {
    balance = roundMoney(balance + Number(row.debit || 0) - Number(row.credit || 0));
    return { ...row, balance };
  });
}

function filterStatementByDate(statement, from, to) {
  return statement.filter((entry) => dateInRange(entry.date, from, to));
}

function customerReportKey(invoice) {
  return String(invoice.customer_id || invoice.customer_name || '').trim();
}

function customerMatchesSearch(customer, search) {
  return matchesSearchPattern(customer.customer_name, search)
    || matchesSearchPattern(customer.customer_id, search)
    || matchesSearchPattern(customer.invoice_count, search)
    || matchesSearchPattern(customer.invoice_total, search)
    || matchesSearchPattern(customer.paid_total, search)
    || matchesSearchPattern(customer.current, search)
    || matchesSearchPattern(customer.days_1_30, search)
    || matchesSearchPattern(customer.days_31_60, search)
    || matchesSearchPattern(customer.days_61_90, search)
    || matchesSearchPattern(customer.days_over_90, search)
    || matchesSearchPattern(customer.balance_due, search);
}

function sqlLikePattern(value) {
  const pattern = String(value || '').trim().toLowerCase();
  if (!pattern.includes('%')) {
    return `%${pattern}%`;
  }
  return pattern.endsWith('%') ? pattern : `${pattern}%`;
}

function paginationOptions(options = {}, defaultLimit = 50, maxLimit = 200) {
  const requestedPage = Number(options.page || 1);
  const requestedLimit = Number(options.page_size || options.pageSize || options.limit || defaultLimit);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), maxLimit)
    : defaultLimit;
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function paginationResult(total, pagination) {
  const normalizedTotal = Number(total || 0);
  const totalPages = Math.max(1, Math.ceil(normalizedTotal / pagination.limit));
  const start = normalizedTotal ? pagination.offset + 1 : 0;
  const end = Math.min(pagination.offset + pagination.limit, normalizedTotal);
  return {
    page: pagination.page,
    limit: pagination.limit,
    offset: pagination.offset,
    total: normalizedTotal,
    total_pages: totalPages,
    start,
    end,
  };
}

function matchesSearchPattern(value, pattern) {
  const text = normalizeSearchText(value);
  const search = normalizeSearchPattern(pattern);
  if (!search) {
    return true;
  }
  if (!search.includes('%')) {
    return text.includes(search);
  }
  return orderedWildcardMatch(text, search);
}

function matchesSearchFields(values, pattern) {
  const search = String(pattern || '').trim();
  if (!search) {
    return true;
  }
  const combined = normalizeSearchText(values.filter(Boolean).join(' '));
  return matchesSearchPattern(combined, search)
    || values.some((value) => matchesSearchPattern(value, search));
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchPattern(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wildcardRegex(pattern) {
  const search = String(pattern);
  const source = search
    .split('%')
    .map(escapeRegex)
    .join('.*');
  return new RegExp(`${search.startsWith('%') ? '' : '^'}${source}`, 'i');
}

function orderedWildcardMatch(text, pattern) {
  const startsAtBeginning = !pattern.startsWith('%');
  const terms = pattern.split('%').filter(Boolean);
  if (!terms.length) {
    return true;
  }
  let position = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const found = text.indexOf(terms[index], position);
    if (found === -1) {
      return false;
    }
    if (index === 0 && startsAtBeginning && found !== 0) {
      return false;
    }
    position = found + terms[index].length;
  }
  return true;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateInRange(date, from, to) {
  const value = String(date || '').slice(0, 10);
  if (from && value < from) {
    return false;
  }
  if (to && value > to) {
    return false;
  }
  return true;
}

function agingBucket(invoice) {
  const basisDate = new Date(`${invoice.due_date || invoice.invoice_date}T00:00:00Z`);
  if (Number.isNaN(basisDate.getTime())) {
    return 'current';
  }
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ageDays = Math.floor((todayUtc - basisDate.getTime()) / 86400000);
  if (ageDays <= 0) {
    return 'current';
  }
  if (ageDays <= 30) {
    return 'days_1_30';
  }
  if (ageDays <= 60) {
    return 'days_31_60';
  }
  if (ageDays <= 90) {
    return 'days_61_90';
  }
  return 'days_over_90';
}

function emptyDebtorSummary() {
  return {
    customer_count: 0,
    invoice_total: 0,
    paid_total: 0,
    balance_due: 0,
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_over_90: 0,
  };
}

function roundReportMoney(row) {
  for (const key of [
    'invoice_total',
    'paid_total',
    'balance_due',
    'current',
    'days_1_30',
    'days_31_60',
    'days_61_90',
    'days_over_90',
    'sales_amount',
    'cost_amount',
    'gross_profit',
  ]) {
    row[key] = roundMoney(row[key]);
  }
  return row;
}

function typeSort(type) {
  return type === 'Invoice' ? 0 : 1;
}

module.exports = {
  getCompanyInformation,
  saveCompanyInformation,
  initStore,
  allInvoices,
  paginatedInvoices,
  invoiceWarehouses,
  findInvoice,
  invoiceForPayment,
  createInvoice,
  createCashSaleInvoice,
  submitCashSaleInvoice,
  updateInvoice,
  submitInvoice,
  cancelInvoice,
  addInvoicePayment,
  cancelInvoicePayment,
  invoiceSummary,
  topDebtors,
  debtorReport,
  stockSummary,
  stockBalances,
  localStockQuantity,
  masterItemsWithStock,
  masterItems,
  masterCustomers,
  masterSuppliers,
  masterWarehouses,
  masterEmployees,
  masterCostCenters,
  masterOptions,
  findMasterRecord,
  findMasterItem,
  findMasterCustomer,
  findMasterSupplier,
  findMasterEmployee,
  findMasterCostCenter,
  createMasterRecord,
  updateMasterRecord,
  submitMasterRecord,
  cancelMasterRecord,
  createStockEntry,
  loadStockEntry,
  stockEntryCancelTemplate,
  searchStockEntriesForCancel,
  updateStockEntry,
  cancelStockEntry,
  updateStockEntrySupplierInfo,
  stockLedgerReport,
  stockLedgerVoucherDetails,
  stockMovementReport,
  stockMovementDetails,
  grossProfitReport,
  generalLedgerReport,
  generalLedgerFilterOptions,
  generalLedgerAccountOptions,
  generalLedgerPartyOptions,
  journalReferenceOptions,
  trialBalanceReport,
  profitAndLossReport,
  balanceSheetReport,
  backfillAccountingGl,
  accountingAccounts,
  postableAccountingAccounts,
  createAccountingAccount,
  journalEntries,
  findJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  submitJournalEntry,
  cancelJournalEntry,
  getPostgresPool,
  closeStore,
  withPostgresTransaction,
  applyPostgresStockMovement,
  postGlEntry,
  reverseVoucherGlEntries,
};
