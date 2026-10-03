const express = require('express');
const compression = require('compression');
const path = require('path');
const { listDirectory, downloadableFile, saveUploads } = require('./src/project-files');
const {
  initStore,
  getCompanyInformation,
  saveCompanyInformation,
  getDateTimeSettings,
  saveDateTimeSettings,
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
  createMasterRecord,
  updateMasterRecord,
  setPriceListActive,
  setMasterRecordActive,
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
  usePostgresStore,
} = require('./src/store');
const { ACCOUNT_DETAIL_TYPES } = require('./src/account-detail-types');
const { currentPostingDate, currentPostingTime } = require('./src/posting-time');
const { formatDate, formatTime, formatDateTime, formatTimestamp } = require('./src/date-time-format');
const { initAuth } = require('./src/auth');
const { ensureSchema } = require('./src/migrate');
const { installAuth } = require('./src/auth-http');
const { invoiceFormState, duplicateInvoiceFormState } = require('./src/invoice-form-state');
const { selectedCategories, scopeRestricted, allowedInvoicePriceLists, requireInvoicePriceList,
  namedPriceListsForActions, warehouseAllowed, allowedNamedListValues,
  accountAllowed, purchaseOrderAllowed, voucherWarehousesAllowed,
  deniedNamedListValues } = require('./src/access');
const { money, purchaseMoney, paymentReturnPath, todayString } = require('./src/web/format');
const reportsRouter = require('./src/web/routes/reports');
const stockRouter = require('./src/web/routes/stock');
const purchasingRouter = require('./src/web/routes/purchasing');
const ledgerRouter = require('./src/web/routes/ledger');
const settingsRouter = require('./src/web/routes/settings');
const salesRouter = require('./src/web/routes/sales');
const { dashboardData, cachedInvoiceList, clearInvoiceCaches } = require('./src/web/cache');
const { warehouseAccessOptions, accountAccessOptions } = require('./src/web/helpers');
const apiRouter = require('./src/web/routes/api');

const {
  createPurchase,
  updatePurchase,
  listPurchases,
  loadPurchase,
  purchaseForPayment,
  submitPurchase,
  cancelPurchase,
  addPurchasePayment,
  cancelPurchasePayment,
} = require('./src/purchases');
const { createPurchaseOrder, updatePurchaseOrder, listPurchaseOrders, loadPurchaseOrder,
  listReceivablePurchaseOrders, submitPurchaseOrder, cancelPurchaseOrder, deleteDraftPurchaseOrder } = require('./src/purchase-orders');
require('dotenv').config({ quiet: true });

const app = express();
const port = Number(process.env.PORT || 3000);
const STATIC_MAX_AGE = process.env.STATIC_MAX_AGE || '3600';
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 300);
let storeReady = false;
let storeInitPromise = null;


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.disable('x-powered-by');
app.locals.assetVersion = Date.now();
app.locals.currentPostingTime = currentPostingTime;
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(compression({ threshold: 0 }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: Number(STATIC_MAX_AGE) * 1000,
  setHeaders(res) {
    res.setHeader('Cache-Control', `public, max-age=${STATIC_MAX_AGE}`);
  },
}));
app.use('/shared', express.static(path.join(__dirname, 'src', 'shared'), {
  etag: true,
  lastModified: true,
  maxAge: Number(STATIC_MAX_AGE) * 1000,
  setHeaders(res) {
    res.setHeader('Cache-Control', `public, max-age=${STATIC_MAX_AGE}`);
  },
}));
app.use(express.urlencoded({ extended: true, limit: '3mb', parameterLimit: 35000 }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMs >= SLOW_REQUEST_MS) {
      console.warn(`slow_request method=${req.method} path=${req.originalUrl} status=${res.statusCode} duration_ms=${elapsedMs.toFixed(1)}`);
    }
  });
  next();
});

app.use(async (_req, _res, next) => {
  try {
    await ensureStoreInitialized();
    next();
  } catch (err) {
    const wrapped = new Error(`Database is not ready: ${err.message}`);
    wrapped.status = 503;
    next(wrapped);
  }
});

function ensureStoreInitialized() {
  if (storeReady) {
    return Promise.resolve();
  }
  if (!storeInitPromise) {
    storeInitPromise = initStore()
      .then(() => initAuth())
      .then(() => (usePostgresStore() ? ensureSchema(getPostgresPool()) : undefined))
      .then(() => {
        storeReady = true;
      })
      .catch((err) => {
        storeInitPromise = null;
        throw err;
      });
  }
  return storeInitPromise;
}

app.use(async (_req, res, next) => {
  try {
    const settings = await getDateTimeSettings();
    res.locals.dateTimeSettings = settings;
    res.locals.formatDate = (value) => formatDate(value, settings);
    res.locals.formatTime = (value) => formatTime(value, settings);
    res.locals.formatDateTime = (date, time) => formatDateTime(date, time, settings);
    res.locals.formatTimestamp = (value, timeZone) => formatTimestamp(value, settings, timeZone);
    next();
  } catch (error) { next(error); }
});

installAuth(app);

app.get('/', async (req, res, next) => {
  try {
    if (!res.locals.can('vouchers.sales.view') || scopeRestricted(req.currentUser, 'customers')) {
      res.set('Cache-Control', 'private, no-store');
      res.render('index', { limited: true, summary: {}, recent: [], debtors: [], money });
      return;
    }
    const { summary, recent, debtors } = await dashboardData();
    res.set('Cache-Control', 'private, max-age=15');
    res.render('index', { summary, recent, debtors, money });
  } catch (err) {
    next(err);
  }
});

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/invoices') && req.path !== '/reports/debtors') return next();
  try {
    res.locals.receiptAccounts = await receivingAccounts(accountAccessOptions(req.currentUser));
    next();
  } catch (error) { next(error); }
});

app.use('/reports', reportsRouter);

app.use(purchasingRouter);

app.use(settingsRouter);

app.use('/stock', stockRouter);

app.use(ledgerRouter);

app.use(salesRouter);

app.use('/api', apiRouter);

function sqlCandidatePattern(value) {
  const pattern = String(value || '').trim();
  if (!pattern) {
    return '%';
  }
  if (!pattern.includes('%')) {
    return `%${pattern}%`;
  }
  return '%';
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

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const exposeMessage = status < 500 && status !== 503;
  const message = exposeMessage
    ? err.message || 'Server error'
    : 'Something went wrong. Please try again or contact support.';
  if (!exposeMessage) {
    console.error('request_error', {
      status,
      message: err.message,
      stack: err.stack,
      method: _req.method,
      path: _req.originalUrl,
    });
  }
  // /api/* is consumed by fetch() from public/*.js, which parses JSON. Rendering
  // the HTML error page for those requests produces a parse failure that hides the
  // real status and message, so answer API paths in the same shape as denyAccess.
  if (_req.path.startsWith('/api/')
      || _req.get('accept')?.includes('application/json')
      || _req.get('content-type')?.includes('application/json')) {
    res.status(status).json({ error: message });
    return;
  }
  res.status(status).render('error', { status, message });
});

// The session cookie is issued with `secure: req.secure` (src/auth-http.js), and
// app.set('trust proxy') controls whether X-Forwarded-Proto is believed. Behind a
// TLS-terminating proxy with the proxy untrusted, req.secure stays false and the
// session cookie is sent without Secure over what the operator believes is HTTPS.
// Refuse to start rather than serve in that state silently.
function assertSecureTransportConfiguration() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.ALLOW_INSECURE_COOKIES === 'true') return;
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const terminatingTls = Boolean(process.env.TLS_TERMINATED_PROXY);
  if (!trustProxy && !terminatingTls) {
    throw new Error(
      'Refusing to start in production with an insecure session cookie. '
      + 'Set TRUST_PROXY=true when a reverse proxy terminates TLS (so X-Forwarded-Proto '
      + 'is honoured and the session cookie is marked Secure), or set ALLOW_INSECURE_COOKIES=true '
      + 'to run without TLS on a trusted private network.',
    );
  }
}

ensureStoreInitialized()
  .catch((err) => {
    console.error('Store initialization failed:', err.message);
    console.error('The app will keep running and retry when requests arrive.');
  })
  .finally(() => {
    try {
      assertSecureTransportConfiguration();
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    app.listen(port, () => {
      console.log(`Work Master running on http://localhost:${port}`);
    });
  });
