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
