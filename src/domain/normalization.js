'use strict';
// Invoice/payment normalisation and debtor display helpers, extracted from store.js.
const { PAYMENT_METHODS, JOURNAL_TYPES, DEFAULT_ACCOUNTS } = require('../constants');
const { normalizePostingTime, storedPostingTime } = require('../posting-time');
const { ACCOUNT_DETAIL_TYPES } = require('../account-detail-types');
const { recordAuditFields } = require('../audit');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const invoiceMath = require('../shared/invoice-math');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');

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
  const nonSystemInvoice = normalizeNonSystemInvoice(payload.non_system_invoice);
  const invoicer = String(payload.invoicer || '').trim();
  if (invoicer.length > 100) {
    const err = new Error('Invoicer must be 100 characters or fewer.');
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
    posting_time: normalizePostingTime(payload.posting_time),
    due_date: payload.due_date || null,
    non_system_invoice: nonSystemInvoice || null,
    customer_id: payload.customer_id || null,
    customer_name: payload.customer_name,
    customer_phone: payload.customer_phone || null,
    price_list: payload.price_list || null,
    cost_center: String(payload.cost_center || '').trim() || null,
    invoicer_id: String(payload.invoicer_id || '').trim() || null,
    invoicer: invoicer || null,
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

function normalizeNonSystemInvoice(value) {
  const normalized = String(value || '').trim();
  if (normalized.length > 100) {
    const error = new Error('Non-System Invoice must be 100 characters or fewer.');
    error.status = 400;
    throw error;
  }
  return normalized || null;
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
    posting_time: normalizePostingTime(payload.posting_time),
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
  const accountDetailType = String(payload.account_detail_type || '').trim();
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
    const err = new Error('Choose a valid root type.');
    err.status = 400;
    throw err;
  }
  if (accountDetailType && !ACCOUNT_DETAIL_TYPES.includes(accountDetailType)) {
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
    account_detail_type: accountDetailType || null,
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
    const accountId = paymentAccountId(row.account_id);
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
      account_id: accountId,
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

  const accountId = paymentAccountId(payload.account_id);
  const method = String(payload.method || (accountId ? 'cash' : '')).trim().toLowerCase();
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
    account_id: accountId,
    reference: String(payload.reference || '').trim() || null,
    notes: String(payload.notes || '').trim() || null,
    created_at: existingCreatedAt || new Date().toISOString(),
  };
}

function paymentAccountId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Choose a cash or bank account.'); error.status = 400; throw error;
  }
  return id;
}

function fallbackReceivingAccount(id) {
  const account = DEFAULT_ACCOUNTS.find((row) => Number(row.code) === Number(id)
    && ['Cash', 'Bank'].includes(row.detailType));
  if (!account) { const error = new Error('Choose a cash or bank account.'); error.status = 400; throw error; }
  return { account_name: account.name, account_detail_type: account.detailType };
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
    posting_time: storedPostingTime(invoice.posting_time),
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
      id: payment.journal_id ? payment.id : Number(payment.id || index + 1),
      journal_id: payment.journal_id || null,
      journal_entry_id: payment.journal_entry_id || null,
      payment_record_id: payment.payment_record_id || null,
      payment_date: payment.payment_date || payment.date || invoice.invoice_date,
      amount: roundMoney(Math.max(0, Number(payment.amount || 0))),
      docstatus: payment.docstatus || 'submitted',
      method: payment.method || 'cash',
      account_id: payment.account_id || null,
      account_name: payment.account_name || (payment.account_id
        ? fallbackReceivingAccount(payment.account_id).account_name : null),
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
  return invoiceMath.paidTotal((payments || []).filter((payment) => payment.docstatus !== 'cancelled'));
}

function paymentStatus(total, amountPaid) {
  return invoiceMath.paymentStatus(total, amountPaid);
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
  const filtered = statement.filter((entry) => dateInRange(entry.date, from, to));
  if (from) {
    const prior = statement.filter((entry) => String(entry.date) < from);
    if (prior.length) {
      const opening = prior[prior.length - 1].balance;
      filtered.unshift({
        date: from,
        type: 'Opening',
        reference: '',
        description: 'Balance brought forward',
        debit: 0,
        credit: 0,
        balance: opening,
      });
    }
  }
  return filtered;
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
    unallocated: 0,
  };
}

function typeSort(type) {
  return type === 'Invoice' ? 0 : 1;
}
module.exports = {
  isSubmitted,
  buildInvoiceData,
  normalizeNonSystemInvoice,
  normalizeJournalEntryPayload,
  normalizeAccountingAccountPayload,
  formatTrialBalanceRow,
  journalTypeLabel,
  buildInvoicePayments,
  buildPaymentData,
  paymentAccountId,
  fallbackReceivingAccount,
  normalizeInvoiceTotals,
  normalizePayments,
  applyPaymentTotals,
  sumPayments,
  paymentStatus,
  buildCustomerStatement,
  filterStatementByDate,
  customerReportKey,
  customerMatchesSearch,
  agingBucket,
  emptyDebtorSummary,
  typeSort,
};
