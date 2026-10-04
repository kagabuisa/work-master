'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('authentication uses PostgreSQL even when the former store selector is unset', async () => {
  const previous = process.env.INVOICE_STORE;
  const originalPool = store.getPostgresPool;
  const queries = [];
  store.getPostgresPool = () => ({
    query: async (sql) => {
      queries.push(sql);
      return { rows: [{ count: 7 }] };
    },
  });
  delete process.env.INVOICE_STORE;
  delete require.cache[require.resolve('../src/auth')];
  try {
    const auth = require('../src/auth');
    assert.equal(await auth.userCount(), 7);
    assert.match(queries[0], /FROM app_users/);
  } finally {
    store.getPostgresPool = originalPool;
    if (previous === undefined) delete process.env.INVOICE_STORE;
    else process.env.INVOICE_STORE = previous;
    delete require.cache[require.resolve('../src/auth')];
  }
});
