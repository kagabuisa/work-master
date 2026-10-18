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

test('website list facade retains no completed financial rows and forwards access/count options', async () => {
  let rows=['before'];const seen=[];
  const {cache,restore}=loadCacheWithInvoiceList(async options=>{seen.push(options);return {rows:[...rows]};});
  try {
    assert.deepEqual((await cache.cachedInvoiceList({q:'same',ownerId:'7',allowedGroups:['retail']})).rows,['before']);
    rows=['after'];
    assert.deepEqual((await cache.cachedInvoiceList({q:'same',ownerId:'7',allowedGroups:['retail']})).rows,['after']);
    assert.equal(seen[0].includeTotal,false);assert.equal(seen[0].ownerId,'7');
    assert.deepEqual(seen[0].allowedGroups,['retail']);
    await cache.cachedInvoiceList({exact_total:'1'});assert.equal(seen[2].includeTotal,true);
  } finally {restore();}
});

test('completed invoice filter combinations are not retained', async () => {
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
  const fake = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes('COUNT(*)::int AS total') ? [{ total: 0 }] : [] };
  }, release() {} };
  fake.connect = async () => fake;
  core.getPostgresPool = () => fake;
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
