'use strict';
// Invoice data-freshness cache + ERPNext sync state, shared by the dashboard,
// the sales routes, and the settings routes.
const { invoiceSummary, paginatedInvoices, topDebtors } = require('../store');
const { getPostgresPool } = require('../core');
const { invalidateFinancialReads } = require('../read-cache');
const { DEFAULT_IMPORT_FROM } = require('../sales-invoice-importer');

const DASHBOARD_CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 15000);

let dashboardCache = null;

const syncState = { running: false, last: null };

async function dashboardData() {
  const now = Date.now();
  if (dashboardCache && dashboardCache.expiresAt > now) {
    return dashboardCache.data;
  }
  const [summary, invoicePage, debtors] = await Promise.all([
    invoiceSummary(),
    paginatedInvoices({ limit: 10, includeTotal: false }),
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
    exact_total: query.exact_total === '1',
    q: String(query.q || ''),
    from: String(query.from || ''),
    to: String(query.to || ''),
    warehouse: String(query.warehouse || ''),
    page: String(query.page || '1'),
    page_size: String(query.page_size || ''),
    allowedGroups: query.allowedGroups || null,
    ownerId: query.ownerId ?? null,
    ownerEmployeeId: query.ownerEmployeeId ?? null,
  });
}

// The domain shares identical in-flight reads by full filter/access scope.
// Completed financial rows are not retained here, so API/import writes are visible.
async function cachedInvoiceList(query = {}) {
  return paginatedInvoices({ includeTotal: query.exact_total === '1',
    search: String(query.q || '').trim(), from: query.from, to: query.to,
    warehouse: query.warehouse, page: query.page, page_size: query.page_size,
    allowedGroups: query.allowedGroups, ownerId: query.ownerId,
    ownerEmployeeId: query.ownerEmployeeId });
}
function clearInvoiceListCache() {
  invalidateFinancialReads(getPostgresPool(), ['invoice-list']);
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
