'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('display-setting requests share a refresh and a save keeps the newest settings cached', async () => {
  const pool = store.getPostgresPool();
  const originalQuery = pool.query;
  let resolveRead;
  let reads = 0;
  pool.query = async (sql) => {
    if (sql.startsWith('SELECT date_format')) {
      reads += 1;
      return new Promise((resolve) => { resolveRead = resolve; });
    }
    if (sql.includes('INSERT INTO app_display_settings')) return { rows: [] };
    throw new Error('Unexpected query');
  };
  try {
    const first = store.getDateTimeSettings();
    const second = store.getDateTimeSettings();
    assert.equal(reads, 1);
    const saved = { date_format: 'DD/MM/YYYY', time_format: '12h' };
    assert.deepEqual(await store.saveDateTimeSettings(saved), saved);
    resolveRead({ rows: [{ date_format: 'YYYY-MM-DD', time_format: '24h' }] });
    await Promise.all([first, second]);
    assert.deepEqual(await store.getDateTimeSettings(), saved);
    assert.equal(reads, 1);
  } finally {
    pool.query = originalQuery;
    await store.closeStore();
  }
});
