'use strict';
// Invoice data-freshness cache + ERPNext sync state, shared by the dashboard,
// the sales routes, and the settings routes.
const { invoiceSummary, paginatedInvoices, topDebtors } = require('../store');
const { DEFAULT_IMPORT_FROM } = require('../sales-invoice-importer');

const DASHBOARD_CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 15000);
const INVOICE_LIST_CACHE_MS = Number(process.env.INVOICE_LIST_CACHE_MS || 10000);

let dashboardCache = null;
const invoiceListCache = new Map();

const syncState = { running: false, last: null };

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
    running: syncState.running,
    query_status: String(queryStatus || ''),
    last: syncState.last,
  };
}

module.exports = {
  dashboardData,
  clearDashboardCache,
  clearInvoiceCaches,
  cachedInvoiceList,
  invoiceListCacheKey,
  clearInvoiceListCache,
  salesInvoiceSyncView,
  syncState,
};
