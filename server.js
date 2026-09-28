const express = require('express');
const compression = require('compression');
const multer = require('multer');
const path = require('path');
const { listDirectory, downloadableFile, saveUploads } = require('./src/project-files');
const {
  initStore,
  getCompanyInformation,
  saveCompanyInformation,
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
  createAccountingAccount,
  journalEntries,
  findJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  submitJournalEntry,
  cancelJournalEntry,
} = require('./src/store');
const { DEFAULT_IMPORT_FROM, importSalesInvoicesFromMysql } = require('./src/sales-invoice-importer');
const { initAuth } = require('./src/auth');
const { installAuth } = require('./src/auth-http');
const { invoiceFormState } = require('./src/invoice-form-state');
const { selectedCategories, scopeRestricted, allowedInvoicePriceLists, requireInvoicePriceList,
  namedPriceListsForActions, warehouseAllowed, allowedNamedListValues,
  deniedNamedListValues } = require('./src/access');

function warehouseAccessOptions(user) {
  return { allowedWarehouses: allowedNamedListValues(user, 'warehouses'),
    deniedWarehouses: deniedNamedListValues(user, 'warehouses') };
}

function accountAccessOptions(user) {
  return { allowedAccounts: allowedNamedListValues(user, 'accounts'),
    deniedAccounts: deniedNamedListValues(user, 'accounts') };
}
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
require('dotenv').config({ quiet: true });

const app = express();
const port = Number(process.env.PORT || 3000);
const DASHBOARD_CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 15000);
const INVOICE_LIST_CACHE_MS = Number(process.env.INVOICE_LIST_CACHE_MS || 10000);
const STATIC_MAX_AGE = process.env.STATIC_MAX_AGE || '3600';
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 300);
const DEFAULT_OPTION_GROUPS = [
  'item_category',
  'stock_uom',
  'customer_group',
  'territory',
  'supplier_type',
  'warehouse_type',
];
let storeReady = false;
let storeInitPromise = null;
let dashboardCache = null;
let salesInvoiceImportRunning = false;
let lastSalesInvoiceImport = null;
const invoiceListCache = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.disable('x-powered-by');
app.locals.assetVersion = Date.now();
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

async function dashboardData() {
  const now = Date.now();
  if (dashboardCache && dashboardCache.expiresAt > now) {
    return dashboardCache.data;
  }
  const [summary, invoicePage, debtors] = await Promise.all([
    invoiceSummary(),
    paginatedInvoices({ limit: 10 }),
    topDebtors(),
  ]);
  const data = { summary, recent: invoicePage.rows, debtors };
  dashboardCache = {
    data,
    expiresAt: now + DASHBOARD_CACHE_MS,
  };
  return data;
}

function clearDashboardCache() {
  dashboardCache = null;
}

function invoiceListCacheKey(query = {}) {
  return JSON.stringify({
    q: String(query.q || ''),
    from: String(query.from || ''),
    to: String(query.to || ''),
    warehouse: String(query.warehouse || ''),
    page: String(query.page || '1'),
    page_size: String(query.page_size || ''),
    allowedGroups: query.allowedGroups || null,
  });
}

async function cachedInvoiceList(query = {}) {
  const key = invoiceListCacheKey(query);
  const cached = invoiceListCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }
  const search = String(query.q || '').trim();
  const data = await paginatedInvoices({
    search,
    from: query.from,
    to: query.to,
    warehouse: query.warehouse,
    page: query.page,
    page_size: query.page_size,
    allowedGroups: query.allowedGroups,
  });
  invoiceListCache.set(key, { data, expiresAt: now + INVOICE_LIST_CACHE_MS });
  return data;
}

function clearInvoiceListCache() {
  invoiceListCache.clear();
}

function clearInvoiceCaches() {
  clearDashboardCache();
  clearInvoiceListCache();
}

function salesInvoiceSyncView(queryStatus = '') {
  return {
    import_from: DEFAULT_IMPORT_FROM,
    running: salesInvoiceImportRunning,
    query_status: String(queryStatus || ''),
    last: lastSalesInvoiceImport,
  };
}

app.get('/invoices/new', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.render('new-invoice', { today, invoice: null, items: [] });
});

app.get('/reports/debtors', async (req, res, next) => {
  try {
    const report = await debtorReport({
      search: req.query.q,
      customer: req.query.customer,
      from: req.query.from,
      to: req.query.to,
      statementFrom: req.query.statement_from,
      statementTo: req.query.statement_to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    const paymentData = req.query.view === 'payment' && report.paymentInvoiceId
      ? await loadInvoice(report.paymentInvoiceId)
      : null;
    res.render('debtor-report', {
      report,
      paymentData,
      query: req.query,
      today: todayString(),
      money,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/purchases', async (req, res, next) => {
  try {
    const result = await listPurchases({ ...req.query, allowedTypes: selectedCategories(req.currentUser, 'suppliers') });
    res.render('purchases', { result, query: req.query, money: purchaseMoney });
  } catch (err) { next(err); }
});

app.get('/purchases/new', (_req, res) => {
  res.render('purchase-form', {
    purchase: { posting_date: todayString(), due_date: '', items: [{}] },
    error: null,
  });
});

app.post('/purchases', async (req, res) => {
  const purchase = purchasePayload(req.body);
  try {
    const id = await createPurchase(purchase);
    res.redirect(`/purchases/${id}`);
  } catch (err) {
    const duplicateReference = err.code === '23505' && err.constraint === 'app_purchases_supplier_reference_idx';
    res.status(duplicateReference ? 400 : err.status || 500).render('purchase-form', {
      purchase,
      error: duplicateReference ? 'This supplier reference is already used on another purchase.' : err.message,
    });
  }
});

app.get('/purchases/payments/:id', async (req, res, next) => {
  try {
    const purchaseId = await purchaseForPayment(req.params.id);
    res.redirect(`/purchases/${purchaseId}`);
  } catch (err) { next(err); }
});

app.get('/purchases/payments/:id/drawer', async (req, res, next) => {
  try {
    const purchaseId = await purchaseForPayment(req.params.id);
    const purchase = await loadPurchase(purchaseId);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-drawer', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
  } catch (err) { next(err); }
});

app.get('/purchases/:id', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.render('purchase', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
  } catch (err) { next(err); }
});

app.post('/purchases/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('purchases', req.params.id); res.redirect(303, '/purchases'); }
  catch (error) { next(error); }
});

app.get('/purchases/:id/drawer', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-drawer', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
  } catch (err) { next(err); }
});

app.get('/purchases/:id/edit', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    if (purchase.docstatus !== 'draft') {
      const err = new Error('Only draft purchases can be edited.');
      err.status = 400;
      throw err;
    }
    res.render('purchase-form', { purchase, error: null });
  } catch (err) { next(err); }
});

app.post('/purchases/:id', async (req, res) => {
  const purchase = { ...purchasePayload(req.body), id: Number(req.params.id) };
  try {
    await updatePurchase(req.params.id, purchase);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    const duplicateReference = err.code === '23505' && err.constraint === 'app_purchases_supplier_reference_idx';
    res.status(duplicateReference ? 400 : err.status || 500).render('purchase-form', {
      purchase,
      error: duplicateReference ? 'This supplier reference is already used on another purchase.' : err.message,
    });
  }
});

app.post('/purchases/:id/submit', async (req, res) => {
  try {
    await submitPurchase(req.params.id);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/purchases/:id/cancel', async (req, res) => {
  try {
    await cancelPurchase(req.params.id);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/purchases/:id/payments', async (req, res) => {
  try {
    await addPurchasePayment(req.params.id, req.body);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/purchases/:id/payments/:paymentNo/cancel', async (req, res) => {
  try {
    await cancelPurchasePayment(req.params.id, req.params.paymentNo);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/settings', async (req, res, next) => {
  try {
    res.render('settings', {
      company: await getCompanyInformation(),
      companySaved: req.query.company === 'saved',
      companyError: null,
      salesInvoiceSync: salesInvoiceSyncView(req.query.sync),
    });
  } catch (err) { next(err); }
});

function projectFilesAdmin(req, res, next) {
  if (req.currentUser.role !== 'admin') {
    const error = new Error('Your account does not have permission for this action.');
    error.status = 403;
    return next(error);
  }
  return next();
}

const projectUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10, parts: 12 },
}).array('files', 10);

async function renderProjectFiles(req, res, options = {}) {
  const listing = await listDirectory(String(options.dir ?? req.query.dir ?? ''));
  res.set('Cache-Control', 'private, no-store');
  res.status(options.status || 200).render('project-files', {
    ...listing,
    error: options.error || null,
    uploaded: Number(req.query.uploaded) || 0,
  });
}

app.get('/settings/files', projectFilesAdmin, async (req, res, next) => {
  try { await renderProjectFiles(req, res); } catch (error) { next(error); }
});

app.get('/settings/files/download', projectFilesAdmin, async (req, res, next) => {
  try {
    const file = await downloadableFile(req.query.path);
    res.set('Cache-Control', 'private, no-store');
    res.download(file.filePath, file.name, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

app.post('/settings/files/upload', projectFilesAdmin, (req, res, next) => {
  projectUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 20 MB or smaller.'
          : uploadError.code === 'LIMIT_FILE_COUNT' ? 'Choose up to 10 files at a time.'
            : 'The upload could not be completed.';
        await renderProjectFiles(req, res, { dir: 'uploads', error: message, status: 400 });
        return;
      }
      if (!req.files?.length) {
        await renderProjectFiles(req, res, { dir: 'uploads', error: 'Choose at least one file to upload.', status: 400 });
        return;
      }
      const saved = await saveUploads(req.files);
      res.redirect(303, `/settings/files?dir=uploads&uploaded=${saved.length}`);
    } catch (error) {
      if (error.status === 400) {
        try { await renderProjectFiles(req, res, { dir: 'uploads', error: error.message, status: 400 }); }
        catch (renderError) { next(renderError); }
      } else next(error);
    }
  });
});

app.post('/settings/company-information', async (req, res, next) => {
  try {
    await saveCompanyInformation(req.body);
    res.redirect(303, '/settings?company=saved');
  } catch (err) {
    if (err.status === 400) {
      res.status(400).render('settings', {
        company: req.body,
        companySaved: false,
        companyError: err.message,
        salesInvoiceSync: salesInvoiceSyncView(),
      });
      return;
    }
    next(err);
  }
});

app.post('/settings/erpnext-sync/sales-invoices', async (_req, res, next) => {
  if (salesInvoiceImportRunning) {
    lastSalesInvoiceImport = {
      ok: false,
      running: true,
      finished_at: new Date().toISOString(),
      message: 'Sales invoice import is already running.',
    };
    res.redirect('/settings?sync=running');
    return;
  }

  salesInvoiceImportRunning = true;
  try {
    const startedAt = new Date();
    const summary = await importSalesInvoicesFromMysql({ from: DEFAULT_IMPORT_FROM });
    lastSalesInvoiceImport = {
      ok: true,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      summary,
    };
    clearInvoiceCaches();
    res.redirect('/settings?sync=success');
  } catch (err) {
    lastSalesInvoiceImport = {
      ok: false,
      finished_at: new Date().toISOString(),
      message: err.message || 'Sales invoice import failed.',
    };
    res.redirect('/settings?sync=failed');
  } finally {
    salesInvoiceImportRunning = false;
  }
});

app.get('/settings/:list/new', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    await renderMasterForm(res, { config, record: newMasterRecord(config, req.query), error: null, mode: 'new' });
  } catch (err) {
    next(err);
  }
});

function newMasterRecord(config, query = {}) {
  if (config.key === 'price-lists') return { currency: 'UGX', price_type: 'selling' };
  if (config.key !== 'options') {
    return {};
  }
  return {
    option_group: String(query.group || '').trim(),
    option_value: String(query.value || '').trim(),
  };
}

app.get('/settings/:list/:id/edit', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    const id = decodeURIComponent(req.params.id);
    const record = await findVisibleMasterRecord(config, id);
    if (!record) {
      const err = new Error(`${config.singular} not found.`);
      err.status = 404;
      throw err;
    }
    await renderMasterForm(res, {
      config, record, error: null, mode: 'edit',
      editSubmitted: record.docstatus === 'submitted'
        && (config.key === 'price-lists' ? res.locals.canPriceListAction(record.price_list, 'edit')
          : res.locals.can(`masters.${config.key}.edit`))
        && (config.key !== 'price-lists' || req.query.editing === '1'),
    });
  } catch (err) {
    next(err);
  }
});

async function renderMasterForm(res, { config, record, error, mode, editSubmitted = false }) {
  if (config.key !== 'item-prices' && config.key !== 'price-lists' && mode === 'edit') {
    record.active = record.disabled === '0' && record.docstatus === 'submitted' ? 1 : 0;
  }
  const optionValues = await masterFormOptions(config);
  const neighbors = mode === 'edit'
    ? config.key === 'price-lists' ? await priceListNeighbors(record.price_list)
      : await masterRecordNeighbors(config.key, record[config.idField])
    : null;
  if (config.key === 'customers' || config.key === 'suppliers') {
    const allowed = selectedCategories(res.locals.currentUser, config.key);
    const group = config.key === 'customers' ? 'customer_group' : 'supplier_type';
    if (allowed !== null) {
      const scopedValues = res.locals.currentUser.scopes[config.key].values;
      optionValues[group] = [...new Set([...(optionValues[group] || []), ...scopedValues]
        .filter((value) => allowed.includes(value.trim().toLowerCase())))].sort((a, b) => a.localeCompare(b));
    }
  }
  res.render('master-form', { config, record, error, mode, optionValues, editSubmitted, neighbors });
}

async function masterFormOptions(config) {
  const groups = [...new Set(config.fields
    .map((field) => field.optionGroup)
    .filter(Boolean))];
  const entries = await Promise.all(groups.map(async (group) => {
    const rows = await masterOptions({ group, limit: 500 });
    let values = rows.map((row) => row.option_value);
    if (group === 'option_group') {
      const existingGroups = (await masterOptions({ limit: 500 })).map((row) => row.option_group);
      values = [...DEFAULT_OPTION_GROUPS, ...existingGroups];
    }
    return [group, [...new Set(values)].sort((a, b) => a.localeCompare(b))];
  }));
  return Object.fromEntries(entries);
}

async function findVisibleMasterRecord(config, id) {
  const exactId = String(id || '').trim();
  const localRecord = await config.finder(exactId);
  if (localRecord) {
    return localRecord;
  }
  const rows = await config.loader({ search: exactId, limit: 500 });
  return rows.find((row) => String(row[config.idField] || '') === exactId) || null;
}

app.get('/settings/:list', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    const search = String(req.query.q || '').trim();
    const priceList = config.key === 'item-prices' ? String(req.query.price_list || '').trim() : '';
    const itemCode = config.key === 'item-prices' ? String(req.query.item_code || '').trim() : '';
    const itemCodeExact = req.query.item_code_exact === '1';
    const priceListOptions = config.key === 'item-prices'
      ? (await itemPriceListFilters()).filter((name) => res.locals.can('masters.item-prices.view')
        || namedPriceListsForActions(req.currentUser, ['create']).includes(name)) : [];
    const rows = await config.loader({
      search,
      priceList,
      priceListExact: priceListOptions.includes(priceList),
      itemCode,
      itemCodeExact,
      limit: 50,
      page: req.query.page,
      page_size: req.query.page_size,
      paginate: true,
      allowedGroups: config.key === 'customers' ? selectedCategories(req.currentUser, 'customers') : undefined,
      allowedTypes: config.key === 'suppliers' ? selectedCategories(req.currentUser, 'suppliers') : undefined,
      ...(config.key === 'warehouses' ? warehouseAccessOptions(req.currentUser) : {}),
      allowedPriceLists: config.key === 'price-lists' && !res.locals.can('masters.price-lists.view')
        ? allowedInvoicePriceLists(req.currentUser) || undefined
        : config.key === 'item-prices' && !res.locals.can('masters.item-prices.view')
          ? namedPriceListsForActions(req.currentUser, ['create']) : undefined,
      deniedPriceLists: config.key === 'price-lists' ? (req.currentUser.permission_denials || [])
        .filter((key) => key.startsWith('invoice.price-list.view:'))
        .map((key) => key.slice('invoice.price-list.view:'.length)) : undefined,
    });
    if (config.key !== 'item-prices' && config.key !== 'price-lists') {
      for (const row of rows) row.active = row.disabled === '0' && row.docstatus === 'submitted' ? 1 : 0;
    }
    res.render('master-list', { config, rows, pagination: rows.pagination, query: req.query, search,
      priceList, priceListOptions, itemCode, itemCodeExact });
  } catch (err) {
    next(err);
  }
});

app.post('/settings/price-lists/:id/active', async (req, res, next) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const active = req.body.active === '1' ? true : req.body.active === '0' ? false : null;
    await setPriceListActive(id, active);
    if (req.body.return_to === 'edit') {
      res.redirect(303, `/settings/price-lists/${encodeURIComponent(id)}/edit?editing=1`);
      return;
    }
    const query = new URLSearchParams();
    for (const key of ['q', 'page', 'page_size']) {
      if (req.body[key]) query.set(key, String(req.body[key]));
    }
    res.redirect(303, `/settings/price-lists${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

app.post('/settings/:list/:id/active', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    if (config.key === 'price-lists') { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
    const id = decodeURIComponent(req.params.id);
    const active = req.body.active === '1' ? true : req.body.active === '0' ? false : null;
    await setMasterRecordActive(config.key, id, active);
    if (req.body.return_to === 'edit') {
      res.redirect(303, `/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
      return;
    }
    const query = new URLSearchParams();
    for (const key of ['q', 'price_list', 'item_code', 'item_code_exact', 'page', 'page_size']) if (req.body[key]) query.set(key, String(req.body[key]));
    res.redirect(303, `/settings/${config.key}${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

app.post('/settings/price-lists/:id/delete', async (req, res, next) => {
  try {
    await deletePriceList(decodeURIComponent(req.params.id));
    const query = new URLSearchParams();
    for (const key of ['q', 'page', 'page_size']) {
      if (req.body[key]) query.set(key, String(req.body[key]));
    }
    res.redirect(303, `/settings/price-lists${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

app.post('/settings/:list/:id/delete', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    await deleteMasterRecord(config.key, decodeURIComponent(req.params.id));
    const query = new URLSearchParams();
    for (const key of ['q', 'price_list', 'item_code', 'item_code_exact', 'page', 'page_size']) if (req.body[key]) query.set(key, String(req.body[key]));
    res.redirect(303, `/settings/${config.key}${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

app.post('/settings/:list/:id', async (req, res, next) => {
  const config = masterListConfig(req.params.list);
  const id = decodeURIComponent(req.params.id);
  try {
    await updateMasterRecord(config.key, id, req.body);
    res.redirect(`/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
  } catch (err) {
    if (err.status === 403) return next(err);
    res.status(err.status || 500);
    const persisted = await config.finder(id);
    await renderMasterForm(res, {
      config,
      record: { ...persisted, ...req.body, [config.idField]: id },
      error: err.message || `Could not update ${config.singular.toLowerCase()}.`,
      mode: 'edit',
      editSubmitted: persisted?.docstatus === 'submitted'
        && (config.key === 'price-lists' ? res.locals.canPriceListAction(persisted?.price_list, 'edit')
          : res.locals.can(`masters.${config.key}.edit`)),
    });
  }
});

app.post('/settings/:list', async (req, res, next) => {
  const config = masterListConfig(req.params.list);
  try {
    const id = await createMasterRecord(config.key, req.body);
    res.redirect(`/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
  } catch (err) {
    if (err.code === '23505') {
      err.message = `${config.singular} already exists.`;
      err.status = 400;
    }
    res.status(err.status || 500);
    await renderMasterForm(res, {
      config,
      record: req.body,
      error: err.message || `Could not create ${config.singular.toLowerCase()}.`,
      mode: 'new',
    });
  }
});

app.get('/stock', async (req, res, next) => {
  try {
    const [summary, balances] = await Promise.all([
      stockSummary(),
      stockBalances({
        search: req.query.q,
        warehouse: req.query.warehouse,
        page: req.query.page,
        page_size: req.query.page_size,
      }),
    ]);
    res.render('stock', {
      summary,
      balances,
      pagination: balances.pagination,
      query: req.query,
      filters: {
        search: String(req.query.q || '').trim(),
        warehouse: String(req.query.warehouse || '').trim(),
      },
      money,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/stock/entries/new', (req, res) => {
  const defaultEntryType = req.query.entry_type === 'purchase' ? 'purchase' : 'opening';
  res.render('stock-entry', { today: todayString(), error: null, entry: null, items: [], defaultEntryType });
});

app.post('/stock/entries', async (req, res, next) => {
  try {
    const id = await createStockEntry(parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?voucher_id=${id}`);
  } catch (err) {
    res.status(err.status || 500).render('stock-entry', {
      today: req.body.posting_date || todayString(),
      error: err.message || 'Could not save stock entry.',
      entry: null,
      items: [],
    });
  }
});

app.get('/stock/entries/:id/edit', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    if ((data.entry.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft stock entries can be edited.');
      err.status = 400;
      throw err;
    }
    res.render('stock-entry', {
      today: data.entry.posting_date,
      error: null,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/stock/entries/:id', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    res.render('stock-entry', {
      today: data.entry.posting_date,
      error: null,
      readOnly: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/stock/entries/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('stock', req.params.id); res.redirect(303, '/stock'); }
  catch (error) { next(error); }
});

app.get('/stock/entries/:id/drawer', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('stock-entry-drawer', { ...data, money });
  } catch (err) {
    next(err);
  }
});

app.post('/stock/entries/:id', async (req, res, next) => {
  try {
    const id = await updateStockEntry(req.params.id, parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?status=${req.body.action === 'save_draft' ? 'draft' : 'submitted'}&voucher_id=${id}`);
  } catch (err) {
    try {
      const data = await loadStockEntry(req.params.id);
      res.status(err.status || 500).render('stock-entry', {
        today: req.body.posting_date || data.entry.posting_date || todayString(),
        error: err.message || 'Could not save stock entry.',
        ...data,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

app.get('/reports/stock-ledger', async (req, res, next) => {
  try {
    const report = await stockLedgerReport({
      search: req.query.q,
      warehouse: req.query.warehouse,
      entry_type: req.query.entry_type,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('stock-ledger', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/stock-ledger/vouchers/:type/:id', async (req, res, next) => {
  try {
    const details = await stockLedgerVoucherDetails(req.params.type, req.params.id);
    if (!details) {
      res.status(404).json({ error: 'Voucher not found.' });
      return;
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
});

app.post('/stock/entries/:id/supplier', async (req, res, next) => {
  try {
    const supplier = await updateStockEntrySupplierInfo(req.params.id, req.body);
    res.json({ supplier });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save supplier information.' });
  }
});

app.post('/stock/entries/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelStockEntry(req.params.id, req.body);
    res.json({ id, status: 'cancelled' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not cancel stock entry.' });
  }
});

app.get('/reports/stock-movement', async (req, res, next) => {
  try {
    const report = await stockMovementReport({
      search: req.query.q,
      warehouse: req.query.warehouse,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('stock-movement', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/stock-movement/details', async (req, res, next) => {
  try {
    const details = await stockMovementDetails({
      item_code: req.query.item_code,
      warehouse: req.query.warehouse,
      direction: req.query.direction,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(details);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load stock movement details.' });
  }
});

app.get('/reports/gross-profit', async (req, res, next) => {
  try {
    const report = await grossProfitReport({
      search: req.query.q,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('gross-profit', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/general-ledger', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.q,
      account: req.query.account,
      party: req.query.party,
      voucher_type: req.query.voucher_type,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    };
    const [report, filterOptions] = await Promise.all([
      generalLedgerReport(filters),
      generalLedgerFilterOptions(),
    ]);
    res.render('general-ledger', { report, filterOptions, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/trial-balance', async (req, res, next) => {
  try {
    const report = await trialBalanceReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('trial-balance', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/profit-and-loss', async (req, res, next) => {
  try {
    const report = await profitAndLossReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('profit-and-loss', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/balance-sheet', async (req, res, next) => {
  try {
    const report = await balanceSheetReport({
      as_of: req.query.as_of,
    });
    res.render('balance-sheet', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await accountingAccounts(accountAccessOptions(req.currentUser));
    res.render('accounts', { accounts });
  } catch (err) {
    next(err);
  }
});

app.get('/accounts/new', (_req, res) => {
  res.render('account-form', {
    account: {
      account_type: 'expense',
      normal_balance: 'debit',
    },
    error: null,
  });
});

app.post('/accounts', async (req, res, next) => {
  try {
    await createAccountingAccount({
      account_code: req.body.account_code,
      account_name: req.body.account_name,
      account_type: req.body.account_type,
      normal_balance: req.body.normal_balance,
    });
    res.redirect('/accounts');
  } catch (err) {
    if (err.code === '23505') {
      err.message = 'An account with that code already exists.';
      err.status = 400;
    }
    res.status(err.status || 500).render('account-form', {
      account: {
        account_code: req.body.account_code,
        account_name: req.body.account_name,
        account_type: req.body.account_type,
        normal_balance: req.body.normal_balance,
      },
      error: err.message || 'Could not create account.',
    });
  }
});

app.get('/journals', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const journals = await journalEntries({
      search,
      journal_type: req.query.journal_type,
      status: req.query.status,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('journals', { journals, pagination: journals.pagination, query: req.query, search, money, journalTypeLabel });
  } catch (err) {
    next(err);
  }
});

app.get('/journals/new', async (req, res, next) => {
  try {
    const accounts = await postableAccountingAccounts(accountAccessOptions(req.currentUser));
    res.render('journal-entry', {
      accounts,
      journal: {
        journal_type: req.query.type || 'cash_receipt',
        posting_date: todayString(),
        lines: [],
      },
      today: todayString(),
      error: null,
      readOnly: false,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/journals', async (req, res, next) => {
  try {
    const payload = parseJournalEntryPayload(req.body);
    await validateJournalParty(payload);
    const id = await createJournalEntry(payload, { submit: req.body.action !== 'save_draft' });
    res.redirect(`/journals/${id}`);
  } catch (err) {
    try {
      const accounts = await postableAccountingAccounts(accountAccessOptions(req.currentUser));
      res.status(err.status || 500).render('journal-entry', {
        accounts,
        journal: journalPayloadForRender(req.body),
        today: todayString(),
        error: err.message || 'Could not save journal entry.',
        readOnly: false,
        money,
        journalTypeLabel,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

app.get('/journals/:id/edit', async (req, res, next) => {
  try {
    const [accounts, journal] = await Promise.all([
      postableAccountingAccounts(accountAccessOptions(req.currentUser)), findJournalEntry(req.params.id)]);
    if (!journal) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (journal.docstatus !== 'draft') { const error = new Error('Only draft journals can be edited.'); error.status = 400; throw error; }
    res.render('journal-entry', { accounts, journal, today: todayString(), error: null, readOnly: false, money, journalTypeLabel });
  } catch (err) { next(err); }
});

app.post('/journals/:id', async (req, res, next) => {
  try {
    const payload = parseJournalEntryPayload(req.body);
    await validateJournalParty(payload);
    await updateJournalEntry(req.params.id, payload);
    res.redirect(`/journals/${req.params.id}`);
  } catch (err) { next(err); }
});

app.post('/journals/:id/submit', async (req, res, next) => {
  try {
    await submitJournalEntry(req.params.id);
    res.redirect(`/journals/${req.params.id}`);
  } catch (err) { next(err); }
});

app.get('/journals/:id', async (req, res, next) => {
  try {
    const [accounts, journal] = await Promise.all([
      postableAccountingAccounts(accountAccessOptions(req.currentUser)),
      findJournalEntry(req.params.id),
    ]);
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    res.render('journal-entry', {
      accounts,
      journal,
      today: todayString(),
      error: null,
      readOnly: true,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/journals/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('journals', req.params.id); res.redirect(303, '/journals'); }
  catch (error) { next(error); }
});

app.get('/journals/:id/drawer', async (req, res, next) => {
  try {
    const journal = await findJournalEntry(req.params.id);
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    res.set('Cache-Control', 'private, max-age=10');
    res.render('journal-drawer', { journal, money, journalTypeLabel });
  } catch (err) {
    next(err);
  }
});

app.post('/journals/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelJournalEntry(req.params.id);
    res.redirect(`/journals/${id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/invoices', async (req, res, next) => {
  let id;
  try {
    const payload = await buildInvoicePayload(req.body, req.currentUser);
    if (req.body.action === 'cash_sale') {
      const payment = cashSalePayment(payload, req.body);
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
      id = await createCashSaleInvoice(payload, payment);
    } else if (req.body.action === 'submit_invoice') {
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
      id = await createInvoice({ ...payload, payments: [], amount_paid: 0 });
      await submitInvoice(id);
    } else {
      id = await createInvoice({ ...payload, payments: [], amount_paid: 0 });
    }
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (id) {
      clearInvoiceCaches();
      res.redirect(`/invoices/${id}?error=${encodeURIComponent('Invoice saved, but submission failed. Review it before submitting again.')}`);
      return;
    }
    renderInvoiceFormError(res, req.body, null, err);
  }
});

app.get('/invoices', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const [result, warehouses] = await Promise.all([
      cachedInvoiceList({ ...req.query, allowedGroups: selectedCategories(req.currentUser, 'customers') }),
      invoiceWarehouseOptions(req.currentUser),
    ]);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoices', {
      invoices: result.rows,
      pagination: result.pagination,
      query: req.query,
      search,
      warehouses,
      money,
    });
  } catch (err) {
    next(err);
  }
});

async function invoiceWarehouseOptions(user) {
  const [usedWarehouses, masterRows] = await Promise.all([
    invoiceWarehouses().catch(() => []),
    masterWarehouses({ limit: 200, ...warehouseAccessOptions(user) }).catch(() => []),
  ]);
  return [...new Set([
    ...usedWarehouses,
    ...masterRows.map((row) => row.warehouse || row).filter(Boolean),
  ])].filter((name) => warehouseAllowed(user, name)).sort();
}

app.get('/invoices/:id/edit', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    if ((data.invoice.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Submitted invoices cannot be edited.');
      err.status = 400;
      throw err;
    }
    res.render('new-invoice', {
      ...data,
      today: data.invoice.invoice_date,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id', async (req, res, next) => {
  try {
    const payload = await buildInvoicePayload(req.body, req.currentUser);
    const action = String(req.body.action || '').trim();
    if (action === 'cash_sale' || action === 'submit_invoice') {
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
    }
    const id = await updateInvoice(req.params.id, { ...payload, payments: [], amount_paid: 0 });
    if (action === 'cash_sale') {
      const payment = cashSalePayment(payload, req.body);
      await submitCashSaleInvoice(id, payment);
    } else if (action === 'submit_invoice') {
      await submitInvoice(id);
    }
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    try {
      const savedInvoice = await findInvoice(req.params.id);
      if (!savedInvoice || (savedInvoice.docstatus || 'submitted') !== 'draft') {
        next(err);
        return;
      }
      renderInvoiceFormError(res, req.body, savedInvoice, err);
    } catch (loadErr) {
      // The store may still be unavailable; keep the user's edits without
      // requiring another successful read just to display the form.
      renderInvoiceFormError(res, req.body, { id: req.params.id, invoice_no: req.params.id }, err);
    }
  }
});

app.post('/invoices/:id/submit', async (req, res, next) => {
  try {
    const invoice = await findInvoice(req.params.id);
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    requireInvoicePriceList(req.currentUser, invoice.price_list);
    const warehouse = invoice.items && invoice.items[0] ? invoice.items[0].warehouse : '';
    await validateDbItems(invoice.items, warehouse, { checkStock: true });
    const id = await submitInvoice(req.params.id);
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      try {
        const data = await loadInvoice(req.params.id);
        res.status(400).render('new-invoice', {
          ...data,
          today: data.invoice.invoice_date,
          stockWarning: err.stockWarning,
        });
        return;
      } catch (loadErr) {
        next(loadErr);
        return;
      }
    }
    next(err);
  }
});

app.post('/invoices/:id/submit-cash-sale', async (req, res, next) => {
  try {
    const invoice = await findInvoice(req.params.id);
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    requireInvoicePriceList(req.currentUser, invoice.price_list);
    const warehouse = invoice.items && invoice.items[0] ? invoice.items[0].warehouse : '';
    await validateDbItems(invoice.items, warehouse, { checkStock: true });
    const amount = Math.round(Number(invoice.total || 0));
    if (amount <= 0) {
      const err = new Error('Invoice total must be greater than zero.');
      err.status = 400;
      throw err;
    }
    const id = await submitCashSaleInvoice(req.params.id, {
      payment_date: req.body.payment_date || invoice.invoice_date || todayString(),
      amount,
      method: req.body.cash_sale_method || 'cash',
      reference: req.body.cash_sale_reference || '',
      notes: req.body.cash_sale_notes || 'Cash sale',
    });
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      try {
        const data = await loadInvoice(req.params.id);
        res.status(400).render('new-invoice', {
          ...data,
          today: data.invoice.invoice_date,
          stockWarning: err.stockWarning,
        });
        return;
      } catch (loadErr) {
        next(loadErr);
        return;
      }
    }
    if (err.status === 400) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

app.post('/invoices/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelInvoice(req.params.id);
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (err.status === 400) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

app.get('/invoices/payments/:id', async (req, res, next) => {
  try {
    const invoiceId = await invoiceForPayment(req.params.id);
    res.redirect(`/invoices/${invoiceId}`);
  } catch (err) { next(err); }
});

app.get('/invoices/payments/:id/drawer', async (req, res, next) => {
  try {
    const invoiceId = await invoiceForPayment(req.params.id);
    const data = await loadInvoice(invoiceId);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoice-drawer', {
      ...data,
      today: todayString(),
      money,
      error: req.query.error || null,
      returnTo: '/invoices',
    });
  } catch (err) { next(err); }
});

app.get('/invoices/:id', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice', { ...data, today: todayString(), money, error: req.query.error || null });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('sales', req.params.id); clearInvoiceCaches(); res.redirect(303, '/invoices'); }
  catch (error) { next(error); }
});

app.get('/invoices/:id/drawer', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    const returnTo = typeof req.query.return_to === 'string' && req.query.return_to.startsWith('/invoices?')
      ? req.query.return_to
      : '/invoices';
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoice-drawer', {
      ...data,
      today: todayString(),
      money,
      error: req.query.error || null,
      returnTo,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/payments', async (req, res, next) => {
  try {
    const id = await addInvoicePayment(req.params.id, {
      payment_date: req.body.payment_date,
      amount: req.body.amount,
      method: req.body.method,
      reference: req.body.reference,
      notes: req.body.notes,
    });
    clearInvoiceCaches();
    res.redirect(paymentReturnPath(req.body.return_to, id));
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/payments/:paymentId', async (req, res, next) => {
  res.status(405).send('Payments cannot be edited. Cancel the payment and record a new one.');
});

app.post('/invoices/:id/payments/:paymentId/cancel', async (req, res, next) => {
  try {
    const id = await cancelInvoicePayment(req.params.id, req.params.paymentId);
    clearInvoiceCaches();
    res.redirect(paymentReturnPath(req.body.return_to, id));
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

app.get('/invoices/:id/print', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice-print', { ...data, money });
  } catch (err) {
    next(err);
  }
});

app.get('/api/items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const warehouse = String(req.query.warehouse || '').trim();
    const priceList = String(req.query.price_list || '').trim();
    if (!warehouse) {
      res.status(400).json({ error: 'Warehouse is required.' });
      return;
    }
    if (!warehouseAllowed(req.currentUser, warehouse)) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    if (!priceList) { res.status(400).json({ error: 'Price list is required.' }); return; }
    requireInvoicePriceList(req.currentUser, priceList);
    res.json(await masterItemsWithStock({ search, warehouse, priceList, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

app.post('/api/invoice-item-prices', async (req, res, next) => {
  try {
    const priceListName = String(req.body.price_list || '').trim();
    const itemCodes = Array.isArray(req.body.item_codes)
      ? [...new Set(req.body.item_codes.map((code) => String(code || '').trim()).filter(Boolean))] : [];
    if (!priceListName || !itemCodes.length || itemCodes.length > 200) {
      res.status(400).json({ error: 'Choose a price list and up to 200 invoice items.' });
      return;
    }
    requireInvoicePriceList(req.currentUser, priceListName);
    const priceList = await findMasterRecord('price-lists', priceListName);
    if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
      res.status(400).json({ error: 'Select an active UGX selling price list.' });
      return;
    }
    const prices = await invoiceItemPrices(itemCodes, priceListName);
    if (prices.length !== itemCodes.length) {
      res.status(400).json({ error: 'One or more invoice items are no longer available.' });
      return;
    }
    res.json(prices);
  } catch (err) { next(err); }
});

app.get('/api/price-lists', async (req, res, next) => {
  try {
    const rows = await masterPriceLists({ search: String(req.query.q || ''), priceType: String(req.query.type || ''),
      allowedPriceLists: req.query.invoice === '1' ? allowedInvoicePriceLists(req.currentUser)
        : req.query.item_price === '1' && !['view', 'create', 'edit'].some((action) =>
          res.locals.can(`masters.item-prices.${action}`))
          ? namedPriceListsForActions(req.currentUser, ['create']) : undefined,
      deniedPriceLists: req.query.invoice === '1' ? (req.currentUser.permission_denials || [])
        .filter((key) => key.startsWith('invoice.price-list.view:'))
        .map((key) => key.slice('invoice.price-list.view:'.length)) : undefined,
      currency: ['buying', 'selling'].includes(String(req.query.type || '')) ? 'UGX' : undefined, limit: 200 });
    res.json(rows.map((row) => ({ value: row.price_list, label: `${row.currency} · ${row.type_label}` })));
  } catch (err) { next(err); }
});

app.get('/api/pricing-items', async (req, res, next) => {
  try {
    const rows = await masterItems({ search: String(req.query.q || ''), limit: 25 });
    res.json(rows.map((row) => ({ value: row.item_code, label: `${row.item_name} · ${row.stock_uom || ''}` })));
  } catch (err) { next(err); }
});

app.get('/api/item-price-codes', async (req, res, next) => {
  try {
    const codes = await itemPriceCodeSuggestions({
      search: String(req.query.q || ''),
      priceList: String(req.query.price_list || ''),
      priceListExact: req.query.price_list_exact === '1',
      limit: 20,
    });
    res.json(codes);
  } catch (err) { next(err); }
});

app.get('/api/master-items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterItems({ search, priceList: String(req.query.price_list || ''), limit: 50 }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/report-items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const rows = await masterItems({ search, limit: 50 });
    res.json(rows.map((row) => ({ item_code: row.item_code, item_name: row.item_name })));
  } catch (err) { next(err); }
});

app.get('/api/stock-balance', async (req, res, next) => {
  try {
    const itemCode = String(req.query.item_code || '').trim();
    const warehouse = String(req.query.warehouse || '').trim();
    if (!itemCode || !warehouse) {
      res.json({ quantity: 0, valuation_rate: 0, stock_value: 0 });
      return;
    }
    if (!warehouseAllowed(req.currentUser, warehouse)) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    const balance = await localStockQuantity(itemCode, warehouse);
    res.json({
      quantity: normalizeStockQuantity(balance.quantity),
      valuation_rate: Number(balance.valuation_rate || 0),
      stock_value: Number(balance.stock_value || 0),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stock-entry-cancel-template', async (req, res, next) => {
  try {
    const template = await stockEntryCancelTemplate(req.query.entry);
    if (template.items.some((item) => item.warehouse && !warehouseAllowed(req.currentUser, item.warehouse)
        || item.target_warehouse && !warehouseAllowed(req.currentUser, item.target_warehouse))) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    res.json(template);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load stock entry.' });
  }
});

app.get('/api/stock-entries', async (req, res, next) => {
  try {
    const entries = await searchStockEntriesForCancel(req.query.q);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

app.get('/api/warehouses', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const localWarehouses = await masterWarehouses({ search, limit: 50, ...warehouseAccessOptions(req.currentUser) });
    res.json(localWarehouses.map((row) => row.warehouse));
  } catch (err) {
    next(err);
  }
});

app.get('/api/report-warehouses', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const rows = await masterWarehouses({ search, limit: 50, ...warehouseAccessOptions(req.currentUser) });
    res.json(rows.map((row) => row.warehouse));
  } catch (err) { next(err); }
});

app.get('/api/customers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterCustomers({ search, limit: 25, allowedGroups: selectedCategories(req.currentUser, 'customers') }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/suppliers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterSuppliers({ search, limit: 25, allowedTypes: selectedCategories(req.currentUser, 'suppliers') }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/cost-centers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterCostCenters({ search, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/general-ledger/accounts', async (req, res, next) => {
  try {
    res.json(await generalLedgerAccountOptions(req.query.q, accountAccessOptions(req.currentUser)));
  } catch (err) {
    next(err);
  }
});

app.get('/api/general-ledger/parties', async (req, res, next) => {
  try {
    res.json(await generalLedgerPartyOptions(req.query.q));
  } catch (err) {
    next(err);
  }
});

app.get('/api/employees', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterEmployees({ search, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/journal-reference-options', async (req, res, next) => {
  try {
    const references = await journalReferenceOptions({
      party_type: req.query.party_type,
      party_id: req.query.party_id,
      party_name: req.query.party_name,
      search: req.query.q,
    });
    res.json(references);
  } catch (err) {
    next(err);
  }
});

function masterListConfig(key) {
  const configs = {
    'price-lists': {
      key: 'price-lists', staticLabels: true, idField: 'price_list', title: 'Price Lists', singular: 'Price List',
      newLabel: 'New Price List', editLabel: 'Edit Price List', createSubmitLabel: 'Save', editSubmitLabel: 'Save',
      finder: (id) => findMasterRecord('price-lists', id),
      loader: (options) => masterPriceLists({ ...options, includeDisabled: true }),
      columns: [
        { key: 'price_list', label: 'Price List', strong: true },
        { key: 'currency', label: 'Currency' },
        { key: 'type_label', label: 'Buying/Selling' },
        { key: 'pricelist_type', label: 'Pricelist Type', fallback: 'Unspecified' },
      ],
      fields: [
        { name: 'price_list', label: 'Price List Name', required: true, maxlength: 140, lockedOnEdit: true, placeholder: 'Retail Selling' },
        { name: 'currency', label: 'Currency', required: true, maxlength: 3, placeholder: 'UGX' },
        { name: 'price_type', label: 'Buying/Selling', type: 'select', required: true, options: [
          { value: 'selling', label: 'Selling' }, { value: 'buying', label: 'Buying' }, { value: 'both', label: 'Buying and Selling' },
        ] },
        { name: 'pricelist_type', label: 'Pricelist Type', type: 'select', required: true, options: [
          { value: '', label: 'Select pricelist type' },
          { value: 'Retail', label: 'Retail' }, { value: 'Wholesale', label: 'Wholesale' },
          { value: 'Distribution', label: 'Distribution' },
        ] },
      ],
      hint: 'The name stays fixed after creation. Currency can change until item prices are added.',
    },
    'item-prices': {
      key: 'item-prices', staticLabels: true, idField: 'id', title: 'Item Prices', singular: 'Item Price',
      newLabel: 'New Item Price', editLabel: 'Edit Item Price',
      finder: (id) => findMasterRecord('item-prices', id),
      loader: (options) => masterItemPrices({ ...options, includeDisabled: true }),
      columns: [
        { key: 'item_code', label: 'Item Code', strong: true },
        { key: 'price_list', label: 'Price List' }, { key: 'currency', label: 'Currency' },
        { key: 'stock_uom', label: 'UOM' }, { key: 'price_list_rate', label: 'Rate' },
      ],
      fields: [
        { name: 'item_code', label: 'Item', section: 'Item and rate', required: true, lookup: '/api/pricing-items', placeholder: 'Search item code or name' },
        { name: 'price_list', label: 'Price List', required: true, lookup: '/api/price-lists?item_price=1', placeholder: 'Search active price lists' },
        { name: 'price_list_rate', label: 'Rate (price list currency)', type: 'number', required: true, min: 0, step: '0.000001' },
        { name: 'item_name', label: 'Item Name' },
        { name: 'item_description', label: 'Item Description', type: 'textarea', className: 'wide' },
        { name: 'currency', label: 'Currency', maxlength: 3 },
        { name: 'buying', label: 'Buying', type: 'select', options: [
          { value: '', label: 'From price list' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' },
        ] },
        { name: 'selling', label: 'Selling', type: 'select', options: [
          { value: '', label: 'From price list' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' },
        ] },
        { name: 'price_type', label: 'Price Type' },
        { name: 'erpnext_type', label: 'ERPNext Type', editOnly: true, readonly: true },
        { name: 'item_category', label: 'Item Category' },
        { name: 'cost_center', label: 'Cost Center', section: 'Cost and price history' },
        { name: 'cost', label: 'Cost', type: 'number', step: '0.000001' },
        { name: 'unit_cost', label: 'Unit Cost', type: 'number', step: '0.000001' },
        { name: 'new_price', label: 'New Price', type: 'number', step: '0.000001' },
        { name: 'old_price', label: 'Old Price', type: 'number', step: '0.000001' },
        { name: 'margin', label: 'Margin', type: 'number', step: '0.000001' },
        { name: 'price_update', label: 'Price Update' },
        { name: 'price_update_on', label: 'Price Update On', type: 'date' },
        { name: 'stock_balance', label: 'Stock Balance', section: 'Stock and packaging', type: 'number', step: '0.000001' },
        { name: 'incarton', label: 'In Carton', type: 'number', step: '0.000001' },
        { name: 'carton_price', label: 'Carton Price', type: 'number', step: '0.000001' },
        { name: 'dealer_price', label: 'Dealer Price', type: 'number', step: '0.000001' },
        { name: 'promo_start_date', label: 'Promo Start Date', section: 'Promotion', type: 'date' },
        { name: 'promo_expiry_date', label: 'Promo Expiry Date', type: 'date' },
        { name: 'promo_warehouse', label: 'Promo Warehouse' },
        { name: 'promo_customer', label: 'Promo Customer' },
        { name: 'warehouse_type', label: 'Warehouse Type' },
        { name: 'promo_rate', label: 'Promo Rate', type: 'number', step: '0.000001' },
        { name: 'promo_qty', label: 'Promo Qty', type: 'number', step: '0.000001' },
        { name: 'erpnext_name', label: 'ERPNext ID', section: 'ERPNext source', editOnly: true, readonly: true },
        { name: 'erpnext_created_at', label: 'ERPNext Created', editOnly: true, readonly: true },
        { name: 'erpnext_modified_at', label: 'ERPNext Modified', editOnly: true, readonly: true },
        { name: 'erpnext_owner', label: 'ERPNext Owner', editOnly: true, readonly: true },
        { name: 'erpnext_modified_by', label: 'ERPNext Modified By', editOnly: true, readonly: true },
      ],
      hint: 'An active item price overrides the item’s default base rate for this price list. New item prices are saved inactive.',
    },
    items: {
      key: 'items',
      idField: 'item_code',
      title: 'Items',
      singular: 'Item',
      newLabel: 'New Item',
      editLabel: 'Edit Item',
      finder: (id) => findMasterRecord('items', id),
      loader: (options) => masterItems({ ...options, includeDisabled: true }),
      columns: [
        { key: 'item_code', label: 'Code', strong: true },
        { key: 'item_name', label: 'Item' },
        { key: 'stock_uom', label: 'UOM' },
        { key: 'category', label: 'Category' },
        { key: 'default_rate', label: 'Default Rate' },
        { key: 'unit_cost', label: 'Unit Cost' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'item_code', label: 'Item Code', required: true, placeholder: 'ITEM-001', lockedOnEdit: true },
        { name: 'item_name', label: 'Item Name', required: true, placeholder: 'Finished Product' },
        { name: 'stock_uom', label: 'Stock UOM', placeholder: 'Nos', optionGroup: 'stock_uom' },
        { name: 'category', label: 'Category', placeholder: 'Products', optionGroup: 'item_category' },
        { name: 'default_rate', label: 'Default Rate', type: 'number', step: '1', min: '0', placeholder: '0' },
        { name: 'unit_cost', label: 'Unit Cost', type: 'number', step: '1', min: '0', placeholder: '0' },
        { name: 'markup', label: 'Markup', type: 'number', step: '0.01', min: '0', placeholder: '0' },
        { name: 'qty_per_carton', label: 'Qty per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'cbm_per_carton', label: 'CBM per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'weight_per_carton', label: 'Weight per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'import_fob', label: 'Import FOB', type: 'number', step: '0.01', min: '0', placeholder: '0' },
        { name: 'exporter', label: 'Exporter', placeholder: 'Exporter name' },
        {
          name: 'source',
          label: 'Source',
          type: 'select',
          options: [
            { value: '', label: '' },
            { value: 'Local', label: 'Local' },
            { value: 'Import', label: 'Import' },
          ],
        },
        { name: 'photo_count_id', label: 'Photo Count ID', placeholder: 'Photo Count ID' },
        { name: 'description', label: 'Description', type: 'textarea', className: 'wide' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Enabled' },
            { value: '1', label: 'Disabled' },
          ],
        },
      ],
    },
    customers: {
      key: 'customers',
      idField: 'customer_id',
      title: 'Customers',
      singular: 'Customer',
      newLabel: 'New Customer',
      editLabel: 'Edit Customer',
      finder: (id) => findMasterRecord('customers', id),
      loader: (options) => masterCustomers({ ...options, includeDisabled: true }),
      columns: [
        { key: 'customer_name', label: 'Customer', strong: true, secondaryKey: 'customer_id' },
        { key: 'tin', label: 'TIN' },
        { key: 'customer_group', label: 'Group' },
        { key: 'territory', label: 'Territory' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'customer_id', label: 'Customer ID', placeholder: 'Leave blank to use customer name', lockedOnEdit: true },
        { name: 'customer_name', label: 'Customer Name', required: true, placeholder: 'Customer Ltd' },
        { name: 'tin', label: 'TIN (Tax Identification Number)', maxlength: 100 },
        { name: 'customer_group', label: 'Group', placeholder: 'Commercial', optionGroup: 'customer_group' },
        { name: 'territory', label: 'Territory', placeholder: 'Uganda', optionGroup: 'territory' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    suppliers: {
      key: 'suppliers',
      idField: 'supplier_id',
      title: 'Suppliers',
      singular: 'Supplier',
      newLabel: 'New Supplier',
      editLabel: 'Edit Supplier',
      finder: (id) => findMasterRecord('suppliers', id),
      loader: (options) => masterSuppliers({ ...options, includeDisabled: true }),
      columns: [
        { key: 'supplier_id', label: 'ID', strong: true },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'supplier_type', label: 'Type' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'supplier_id', label: 'Supplier ID', placeholder: 'Leave blank to use supplier name', lockedOnEdit: true },
        { name: 'supplier_name', label: 'Supplier Name', required: true, placeholder: 'Supplier Ltd' },
        { name: 'supplier_type', label: 'Type', placeholder: 'Local', optionGroup: 'supplier_type' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    warehouses: {
      key: 'warehouses',
      idField: 'warehouse',
      title: 'Warehouses',
      singular: 'Warehouse',
      newLabel: 'New Warehouse',
      editLabel: 'Edit Warehouse',
      finder: (id) => findMasterRecord('warehouses', id),
      loader: (options) => masterWarehouses({ ...options, includeDisabled: true }),
      columns: [
        { key: 'warehouse', label: 'Warehouse', strong: true },
        { key: 'warehouse_type', label: 'Type' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'warehouse', label: 'Warehouse Name', required: true, placeholder: 'Main Warehouse', lockedOnEdit: true },
        { name: 'warehouse_type', label: 'Warehouse Type', type: 'option-select', optionGroup: 'warehouse_type' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Enabled' },
            { value: '1', label: 'Disabled' },
          ],
        },
      ],
    },
    employees: {
      key: 'employees',
      idField: 'employee_id',
      title: 'Employees',
      singular: 'Employee',
      newLabel: 'New Employee',
      editLabel: 'Edit Employee',
      finder: (id) => findMasterRecord('employees', id),
      loader: (options) => masterEmployees({ ...options, includeDisabled: true }),
      columns: [
        { key: 'employee_id', label: 'ID', strong: true },
        { key: 'employee_name', label: 'Employee' },
        { key: 'department', label: 'Department' },
        { key: 'designation', label: 'Designation' },
        { key: 'phone', label: 'Phone' },
        { key: 'status_label', label: 'Status' },
      ],
      fields: [
        { name: 'employee_id', label: 'Employee ID', placeholder: 'Leave blank to use employee name', lockedOnEdit: true },
        { name: 'employee_name', label: 'Employee Name', required: true, placeholder: 'Employee Name' },
        { name: 'status', label: 'Employment Status', placeholder: 'Active' },
        { name: 'company', label: 'Company', placeholder: 'Company name' },
        { name: 'department', label: 'Department', placeholder: 'Department' },
        { name: 'designation', label: 'Designation', placeholder: 'Role / title' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    options: {
      key: 'options',
      idField: 'id',
      title: 'Options',
      singular: 'Option',
      newLabel: 'New Option',
      editLabel: 'Edit Option',
      finder: (id) => findMasterRecord('options', id),
      loader: (options) => masterOptions({ ...options, includeDisabled: true }),
      columns: [
        { key: 'option_group', label: 'Group', strong: true },
        { key: 'option_value', label: 'Value' },
      ],
      fields: [
        { name: 'option_group', label: 'Group', required: true, placeholder: 'item_category', optionGroup: 'option_group' },
        { name: 'option_value', label: 'Value', required: true, placeholder: 'Finished Goods' },
      ],
    },
  };
  const config = configs[key];
  if (!config) {
    const err = new Error('Master list not found.');
    err.status = 404;
    throw err;
  }
  config.staticLabels = true;
  config.createSubmitLabel = 'Save';
  config.editSubmitLabel = 'Update';
  config.fields = config.fields.filter((field) => field.name !== 'disabled');
  config.columns = config.columns.filter((column) => !['status', 'status_label'].includes(column.key));
  return config;
}

async function findDbCustomer(customerId) {
  const id = String(customerId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterCustomer(id);
}

async function findDbSupplier(supplierId) {
  const id = String(supplierId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterSupplier(id);
}

async function findDbEmployee(employeeId) {
  const id = String(employeeId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterEmployee(id);
}

async function validateDbItems(items, warehouse, options = {}) {
  const checkStock = options.checkStock === true;
  const selectedWarehouse = String(warehouse || '').trim();
  if (!selectedWarehouse) {
    const err = new Error('Select a warehouse.');
    err.status = 400;
    throw err;
  }

  const validated = [];
  for (const item of items || []) {
    const itemCode = String(item.item_code || '').trim();
    const quantity = normalizeItemQuantity(item.quantity);
    if (!itemCode || quantity <= 0) {
      continue;
    }

    const dbItem = await findDbItem(itemCode);
    if (!dbItem) {
      const err = new Error(`Item ${itemCode} is not available in ${selectedWarehouse}.`);
      err.status = 400;
      throw err;
    }
    const localBalance = await localStockQuantity(dbItem.item_code, selectedWarehouse);
    const available = normalizeStockQuantity(localBalance.quantity);
    if (checkStock && quantity > available) {
      const err = new Error(`Adjust quantity for ${dbItem.item_name}.`);
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: dbItem.item_name,
        item_code: dbItem.item_code,
        warehouse: selectedWarehouse,
        requested: quantity,
        available,
      };
      throw err;
    }

    validated.push({
      ...item,
      item_code: dbItem.item_code,
      item_name: dbItem.item_name,
      warehouse: selectedWarehouse,
      quantity,
      stock_at_sale: available,
    });
  }

  return validated;
}

async function findDbItem(itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) {
    return null;
  }
  return findMasterItem(code);
}

function normalizeStockQuantity(value) {
  const quantity = Number(value || 0);
  const rounded = Math.round(quantity);
  return Math.abs(quantity - rounded) <= 0.0015
    ? rounded
    : Number(quantity.toFixed(3));
}

function normalizeItemQuantity(value) {
  return Math.max(0, Number(Number(value || 0).toFixed(3)));
}

async function loadInvoice(id) {
  const invoice = await findInvoice(id);
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  return { invoice, items: invoice.items || [], company: await getCompanyInformation() };
}

function renderInvoiceFormError(res, body, savedInvoice, err) {
  const status = err instanceof SyntaxError ? 400 : err.status || 500;
  res.status(status).render('new-invoice', {
    ...invoiceFormState(body, savedInvoice),
    stockWarning: err.stockWarning || null,
    formError: status < 500 ? (err instanceof SyntaxError ? 'Could not read the invoice items. Review them and try again.' : err.message) : 'Could not save the invoice. Please try again.',
  });
}

async function buildInvoicePayload(body, user) {
  const payload = {
    invoice_date: body.invoice_date,
    due_date: body.due_date,
    customer_id: body.customer_id,
    customer_name: String(body.customer_name || '').trim(),
    customer_phone: String(body.customer_phone || '').trim(),
    price_list: String(body.price_list || '').trim(),
    warehouse: String(body.warehouse || '').trim(),
    notes: String(body.notes || '').trim(),
    discount_amount: body.discount_amount,
    tax_amount: body.tax_amount,
    amount_paid: body.amount_paid,
    items: JSON.parse(body.items_json || '[]'),
    payments: JSON.parse(body.payments_json || '[]'),
  };
  if (!payload.customer_name) {
    const err = new Error('Customer name is required.');
    err.status = 400;
    throw err;
  }
  const customer = await findDbCustomer(payload.customer_id);
  if (!customer) {
    const err = new Error('Select a customer from the database.');
    err.status = 400;
    throw err;
  }
  payload.customer_id = customer.customer_id;
  payload.customer_name = customer.customer_name;
  const priceList = await findMasterRecord('price-lists', payload.price_list);
  if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
    const err = new Error('Select an active UGX selling price list.'); err.status = 400; throw err;
  }
  requireInvoicePriceList(user, payload.price_list);
  payload.items = await validateDbItems(payload.items, payload.warehouse);
  return payload;
}

function cashSalePayment(payload, body = {}) {
  const amount = invoicePayloadTotal(payload);
  if (amount <= 0) {
    const err = new Error('Cash sale total must be greater than zero.');
    err.status = 400;
    throw err;
  }
  return {
    payment_date: body.payment_date || payload.invoice_date || todayString(),
    amount,
    method: body.cash_sale_method || 'cash',
    reference: body.cash_sale_reference || '',
    notes: body.cash_sale_notes || 'Cash sale',
  };
}

function invoicePayloadTotal(payload) {
  const subtotal = (payload.items || []).reduce((sum, item) => (
    sum + (Number(item.quantity || 0) * Number(item.unit_price || 0))
  ), 0);
  const discount = Math.max(0, Number(payload.discount_amount || 0));
  const tax = Math.max(0, Number(payload.tax_amount || 0));
  return Math.round(Math.max(0, subtotal - discount + tax));
}

function purchasePayload(body) {
  const ids = arrayField(body.item_id);
  const codes = arrayField(body.item_code);
  const names = arrayField(body.item_name);
  const warehouses = arrayField(body.warehouse);
  const quantities = arrayField(body.quantity);
  const prices = arrayField(body.unit_price);
  return {
    posting_date: body.posting_date,
    due_date: body.due_date,
    supplier_id: body.supplier_id,
    supplier_name: body.supplier_name,
    price_list: body.price_list,
    supplier_reference: body.supplier_reference,
    remarks: body.remarks,
    items: codes.map((itemCode, index) => ({
      id: ids[index],
      item_code: itemCode,
      item_name: names[index],
      warehouse: warehouses[index],
      quantity: quantities[index],
      unit_price: prices[index],
    })).filter((item) => item.item_code || item.warehouse || item.quantity || item.unit_price),
  };
}

function parseStockEntryPayload(body) {
  const ids = arrayField(body.id);
  const itemCodes = arrayField(body.item_code);
  const itemNames = arrayField(body.item_name);
  const warehouses = arrayField(body.warehouse);
  const targetWarehouses = arrayField(body.target_warehouse);
  const quantities = arrayField(body.quantity);
  const valuationRates = arrayField(body.valuation_rate);
  return {
    entry_type: body.entry_type,
    action: body.action,
    posting_date: body.posting_date,
    remarks: body.remarks,
    supplier_name: body.supplier_name,
    supplier_contact: body.supplier_contact,
    supplier_phone: body.supplier_phone,
    supplier_reference: body.supplier_reference,
    items: itemCodes.map((itemCode, index) => ({
      id: ids[index],
      item_code: itemCode,
      item_name: itemNames[index],
      warehouse: warehouses[index],
      target_warehouse: targetWarehouses[index],
      quantity: quantities[index],
      valuation_rate: valuationRates[index],
    })),
  };
}

function parseJournalEntryPayload(body) {
  const ids = arrayField(body.line_id);
  const accountIds = arrayField(body.account_id);
  const debits = arrayField(body.debit);
  const credits = arrayField(body.credit);
  const remarks = arrayField(body.line_remarks);
  return {
    journal_type: body.journal_type,
    posting_date: body.posting_date,
    party_type: body.party_type,
    party_id: body.party_id,
    party_name: body.party_name,
    reference_no: body.reference_no,
    remarks: body.remarks,
    lines: accountIds.map((accountId, index) => ({
      id: ids[index],
      account_id: accountId,
      debit: debits[index],
      credit: credits[index],
      remarks: remarks[index],
    })),
  };
}

async function validateJournalParty(payload) {
  const partyType = String(payload.party_type || '').trim();
  const partyId = String(payload.party_id || '').trim();
  if (!partyType) {
    payload.party_id = '';
    payload.party_name = '';
    return;
  }
  if (!['customer', 'supplier', 'employee'].includes(partyType)) {
    const err = new Error('Choose a valid party type.');
    err.status = 400;
    throw err;
  }
  if (!partyId) {
    const err = new Error('Select a party from the database.');
    err.status = 400;
    throw err;
  }

  let party;
  if (partyType === 'customer') {
    party = await findDbCustomer(partyId);
    payload.party_name = party ? party.customer_name : '';
  } else if (partyType === 'supplier') {
    party = await findDbSupplier(partyId);
    payload.party_name = party ? party.supplier_name : '';
  } else {
    party = await findDbEmployee(partyId);
    payload.party_name = party ? party.employee_name : '';
  }
  if (!party) {
    const err = new Error(`Select a valid ${partyType} from the database.`);
    err.status = 400;
    throw err;
  }
  payload.party_id = partyId;
}

function journalPayloadForRender(body) {
  const payload = parseJournalEntryPayload(body);
  return {
    ...payload,
    lines: payload.lines.map((line, index) => ({
      ...line,
      line_no: index + 1,
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0),
    })),
  };
}

function journalTypeLabel(type) {
  if (type === 'cash_receipt') {
    return 'Cash Receipt';
  }
  if (type === 'payment_journal') {
    return 'Payment Journal';
  }
  return 'Journal Entry';
}

function arrayField(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

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

function money(value) {
  return Number(value || 0).toLocaleString('en-UG', {
    style: 'currency',
    currency: 'UGX',
    currencyDisplay: 'code',
    maximumFractionDigits: 0,
  }).replace('UGX', 'Ugx');
}

function purchaseMoney(value) {
  return `Ugx ${Number(value || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;
}

function paymentReturnPath(value, invoiceId) {
  const returnTo = String(value || '');
  if (returnTo.startsWith('/reports/debtors?') || returnTo.startsWith('/invoices?')) {
    return returnTo;
  }
  return `/invoices/${invoiceId}`;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const exposeMessage = status < 500 && status !== 503;
  if (!exposeMessage) {
    console.error('request_error', {
      status,
      message: err.message,
      stack: err.stack,
      method: _req.method,
      path: _req.originalUrl,
    });
  }
  res.status(status).render('error', {
    status,
    message: exposeMessage
      ? err.message || 'Server error'
      : 'Something went wrong. Please try again or contact support.',
  });
});

ensureStoreInitialized()
  .catch((err) => {
    console.error('Store initialization failed:', err.message);
    console.error('The app will keep running and retry when requests arrive.');
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`Work Master running on http://localhost:${port}`);
    });
  });
