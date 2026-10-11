'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

function loadCacheWithInvoiceList(list) {
  const original = store.paginatedInvoices;
  store.paginatedInvoices = list;
  const path = require.resolve('../src/web/cache');
  delete require.cache[path];
  const cache = require('../src/web/cache');
  return { cache, restore: () => { store.paginatedInvoices = original; delete require.cache[path]; } };
}

test('simultaneous invoice-list misses share a query and invalidation cannot restore stale data', async () => {
  const pending = [];
  const { cache, restore } = loadCacheWithInvoiceList(() => new Promise((resolve) => pending.push(resolve)));
  try {
    const first = cache.cachedInvoiceList({ q: 'same' });
    const duplicate = cache.cachedInvoiceList({ q: 'same' });
    assert.equal(pending.length, 1);

    cache.clearInvoiceListCache();
    const fresh = cache.cachedInvoiceList({ q: 'same' });
    assert.equal(pending.length, 2);
    pending[0]({ rows: ['old'] });
    pending[1]({ rows: ['new'] });
    assert.deepEqual(await first, { rows: ['old'] });
    assert.deepEqual(await duplicate, { rows: ['old'] });
    assert.deepEqual(await fresh, { rows: ['new'] });
    assert.deepEqual(await cache.cachedInvoiceList({ q: 'same' }), { rows: ['new'] });
    assert.equal(pending.length, 2);
  } finally {
    restore();
  }
});

test('invoice-list cache evicts old filter combinations at its entry limit', async () => {
  let calls = 0;
  const { cache, restore } = loadCacheWithInvoiceList(async () => ({ rows: [++calls] }));
  try {
    for (let i = 0; i < 201; i += 1) await cache.cachedInvoiceList({ q: String(i) });
    await cache.cachedInvoiceList({ q: '0' });
    assert.equal(calls, 202);
  } finally {
    restore();
  }
});

test('invoice counts omit payment joins without search and preserve scoped filters', async () => {
  const core = require('../src/core');
  const original = core.getPostgresPool;
  const modulePath = require.resolve('../src/domain/sales');
  const queries = [];
  core.getPostgresPool = () => ({ query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes('COUNT(*)::int AS total') ? [{ total: 0 }] : [] };
  } });
  delete require.cache[modulePath];
  try {
    const { paginatedPostgresInvoices } = require('../src/domain/sales');
    const filters = { ownerId: '7', ownerEmployeeId: 'E7', allowedGroups: ['retail'],
      warehouse: 'Main', from: '2026-01-01', to: '2026-10-01' };
    await paginatedPostgresInvoices(filters);
    const count = queries.find(query => query.sql.includes('COUNT(*)'));
    assert.match(count.sql, /FROM app_invoices invoice/);
    assert.doesNotMatch(count.sql, /app_invoice_payments|app_journal_entry_lines/);
    assert.match(count.sql, /invoice.invoicer_id/);
    assert.match(count.sql, /app_master_customers/);
    assert.match(count.sql, /item.warehouse/);
    assert.deepEqual(count.params, ['7', 'E7', ['retail'], '2026-01-01', '2026-10-01', 'Main']);
    queries.length = 0;
    await paginatedPostgresInvoices({ ...filters, search: 'partial' });
    const searchCount = queries.find(query => query.sql.includes('COUNT(*)'));
    assert.match(searchCount.sql, /app_invoice_payments/);
    assert.match(searchCount.sql, /app_journal_entry_lines/);
    assert.match(searchCount.sql, /LOWER\(status\)/);
  } finally {
    core.getPostgresPool = original;
    delete require.cache[modulePath];
  }
});
