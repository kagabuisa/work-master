const pricing = require('./pricing');
const { normalizePostingTime, storedPostingTime } = require('./posting-time');
const { DEFAULT_DATE_TIME_SETTINGS, normalizeDateTimeSettings, validateDateTimeSettings } = require('./date-time-format');
const { initRecordAudit, recordAuditFields } = require('./audit');
require('dotenv').config({ quiet: true });

const { roundMoney, numberValue, roundReportMoney } = require('./lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('./lib/quantity');
const { optionalValue, requiredValue } = require('./lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('./lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('./lib/search');
const { paginationOptions, paginationResult } = require('./lib/pagination');
const { getPostgresPool, closeStore, withPostgresTransaction } = require('./core');
const { STOCK_ENTRY_TYPES, DEFAULT_ACCOUNTS } = require('./constants');
const {
  masterItemsWithStock,
  masterItems,
  applySelectedItemPrices,
  invoiceItemPrices,
  masterCustomers,
  masterSuppliers,
  masterWarehouses,
  masterEmployees,
  masterCostCenters,
  masterPricingRecords,
  masterPriceLists,
  masterItemPrices,
  itemPriceListFilters,
  itemPriceCodeSuggestions,
  masterOptions,
  findMasterRecord,
  priceListNeighbors,
  masterRecordNeighbors,
  findMasterItem,
  findMasterCustomer,
  findMasterSupplier,
  findMasterWarehouse,
  findMasterEmployee,
  findMasterCostCenter,
  findMasterOption,
  createMasterRecord,
  setMasterRecordActive,
  setPriceListActive,
  deletePriceList,
  deleteMasterRecord,
  updateMasterRecord,
  createMasterItem,
  updateMasterItem,
  customerTin,
  createMasterCustomer,
  updateMasterCustomer,
  createMasterSupplier,
  updateMasterSupplier,
  createMasterWarehouse,
  updateMasterWarehouse,
  assertMasterUpdateApplied,
  createMasterEmployee,
  updateMasterEmployee,
  createMasterCostCenter,
  updateMasterCostCenter,
  createMasterOption,
  updateMasterOption,
} = require('./domain/master-data');

let dateTimeSettingsCache;
let dateTimeSettingsExpiresAt = 0;

async function initStore() {
  const { ensureSchema } = require('./migrate');
  await ensureSchema(getPostgresPool());
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
  const { rows } = await getPostgresPool().query('SELECT * FROM app_company_information WHERE id = 1');
  return { ...normalizeCompanyInformation(rows[0]?.details), ...recordAuditFields(rows[0]) };
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
  await getPostgresPool().query(`
    INSERT INTO app_company_information (id, details) VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details
  `, [JSON.stringify(company)]);
  return company;
}

async function getDateTimeSettings() {
  if (dateTimeSettingsCache && Date.now() < dateTimeSettingsExpiresAt) return dateTimeSettingsCache;
  const { rows } = await getPostgresPool().query('SELECT date_format, time_format FROM app_display_settings WHERE id = 1');
  dateTimeSettingsCache = normalizeDateTimeSettings(rows[0] || DEFAULT_DATE_TIME_SETTINGS);
  dateTimeSettingsExpiresAt = Date.now() + 30000;
  return dateTimeSettingsCache;
}

async function saveDateTimeSettings(payload) {
  const settings = validateDateTimeSettings(payload);
  await getPostgresPool().query(`
    INSERT INTO app_display_settings (id, date_format, time_format) VALUES (1, $1, $2)
    ON CONFLICT (id) DO UPDATE SET date_format = EXCLUDED.date_format, time_format = EXCLUDED.time_format
  `, [settings.date_format, settings.time_format]);
  dateTimeSettingsCache = settings;
  dateTimeSettingsExpiresAt = Date.now() + 30000;
  return settings;
}

const {
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
} = require('./domain/sales');
const {
  initPostgresStore,
  createPerformanceIndexes,
  migratePostgresInvoiceItems,
  seedDefaultAccounts,
  backfillDefaultAccountDetailTypes,
  backfillInvoicePostingTimes,
  syncPostgresInvoicePaymentTotals,
} = require('./domain/schema');
const {
  stockSummary,
  stockBalances,
  localStockQuantity,
  createStockEntry,
  loadStockEntry,
  stockEntryCancelTemplate,
  searchStockEntriesForCancel,
  updateStockEntry,
  updateStockEntrySupplierInfo,
  cancelStockEntry,
  validateStockEntryCancellation,
  stockLedgerReport,
  stockLedgerVoucherDetails,
  stockEntryDraftReport,
  stockMovementReport,
  stockMovementDetails,
  grossProfitReport,
} = require('./domain/inventory');
const {
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
} = require('./domain/ledger');
async function deleteDraftVoucher(kind, value) {
  const tables = { sales: 'app_invoices', purchases: 'app_purchases', stock: 'app_stock_entries', journals: 'app_journal_entries' };
  const table = tables[kind];
  const id = Number(value);
  if (!table || !Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Voucher not found.'); error.status = 404; throw error;
  }
  return withPostgresTransaction(async (client) => {
    const result = await client.query(`SELECT docstatus FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rowCount) { const error = new Error('Voucher not found.'); error.status = 404; throw error; }
    if (result.rows[0].docstatus !== 'draft') {
      const error = new Error('Only draft vouchers can be deleted.'); error.status = 400; throw error;
    }
    await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  });
}

async function updateVoucherPostingTime(kind, value, time) {
  const postingTime = normalizePostingTime(time, { required: true });
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Voucher not found.'); error.status = 404; throw error;
  }
  const tables = { sales: 'app_invoices', purchases: 'app_purchases', stock: 'app_stock_entries', journals: 'app_journal_entries' };
  const table = tables[kind];
  if (!table) { const error = new Error('Voucher not found.'); error.status = 404; throw error; }
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE ${table} SET posting_time = $2, updated_at = now()
       WHERE id = $1 AND docstatus = 'draft' RETURNING *`,
      [id, postingTime],
    );
    if (!rows.length) {
      const { rows: existing } = await client.query(`SELECT docstatus FROM ${table} WHERE id = $1`, [id]);
      if (!existing.length) { const error = new Error('Voucher not found.'); error.status = 404; throw error; }
      const error = new Error('Posting time can only be changed on draft vouchers.'); error.status = 400; throw error;
    }
    if (kind === 'sales') {
      await client.query(`UPDATE app_journal_entries SET posting_time = $2
        WHERE journal_type = 'sales_invoice' AND reference_no = $1`, [rows[0].invoice_no, postingTime]);
    }
    return id;
  });
}

async function updateInvoiceNonSystemNumber(value, input) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Invoice not found.'); error.status = 404; throw error;
  }
  const nonSystemInvoice = normalizeNonSystemInvoice(input);
  const result = await getPostgresPool().query(
    "UPDATE app_invoices SET non_system_invoice = $2, updated_at = now() WHERE id = $1 AND docstatus = 'draft' RETURNING id",
    [id, nonSystemInvoice],
  );
  if (!result.rowCount) {
    const { rows } = await getPostgresPool().query('SELECT docstatus FROM app_invoices WHERE id = $1', [id]);
    if (!rows.length) { const error = new Error('Invoice not found.'); error.status = 404; throw error; }
    const error = new Error('Non-System Invoice can only be changed on draft invoices.'); error.status = 400; throw error;
  }
  return id;
}

const {
  postSalesInvoiceGlEntry,
  salesInvoiceAccountingLines,
  createOrUpdateSalesInvoiceJournalEntry,
  nonZeroAccountingLines,
  postCustomerPaymentGlEntry,
  createOrUpdatePaymentJournalEntry,
  postStockEntryGlEntry,
  stockEntryGlLines,
  stockVoucherType,
  stockEntryGlRemarks,
  paymentAccountKey,
  postGlEntry,
  reverseVoucherGlEntries,
  resolveAccountingAccounts,
  groupByInvoiceId,
  postgresItemToInvoiceItem,
  postgresPaymentToInvoicePayment,
  normalizeStockEntryItems,
  normalizeSupplierInfo,
  insertStockEntryItems,
  syncStockEntryItems,
  postStockEntryMovements,
  applyPostgresStockMovement,
  addReportFilters,
  reportFilterValues,
  actorAuditValues,
  setVoucherDocstatus,
} = require('./domain/posting');

const {
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
} = require('./domain/normalization');
module.exports = {
  getCompanyInformation,
  saveCompanyInformation,
  getDateTimeSettings,
  saveDateTimeSettings,
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
  deleteDraftVoucher,
  updateVoucherPostingTime,
  updateInvoiceNonSystemNumber,
  addInvoicePayment,
  cancelInvoicePayment,
  invoiceSummary,
  topDebtors,
  debtorReport,
  stockSummary,
  stockBalances,
  localStockQuantity,
  masterItemsWithStock,
  invoiceItemPrices,
  masterItems,
  masterCustomers,
  masterSuppliers,
  masterWarehouses,
  masterEmployees,
  masterCostCenters,
  masterOptions,
  masterPriceLists,
  masterItemPrices,
  itemPriceListFilters,
  itemPriceCodeSuggestions,
  findMasterRecord,
  priceListNeighbors,
  masterRecordNeighbors,
  findMasterItem,
  findMasterCustomer,
  findMasterSupplier,
  findMasterEmployee,
  findMasterCostCenter,
  createMasterRecord,
  updateMasterRecord,
  setMasterRecordActive,
  setPriceListActive,
  deletePriceList,
  deleteMasterRecord,
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
  receivingAccounts,
  findAccountingAccount,
  createAccountingAccount,
  updateAccountingAccount,
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
