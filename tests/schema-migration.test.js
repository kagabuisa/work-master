'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { seedGoldenData } = require('./helpers/golden-seed');

test('version 1 upgrades once without duplicating accounting postings', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const before = (await pool.query(`
      SELECT (SELECT count(*)::int FROM app_gl_entries) AS gl,
        (SELECT count(*)::int FROM app_journal_entries) AS journals
    `)).rows[0];
    await pool.query('DELETE FROM wm_schema_version WHERE version IN (2, 3)');
    await pool.query("INSERT INTO wm_schema_version (version, name) VALUES (1, 'baseline')");

    await store.initStore();
    assert.deepEqual((await pool.query('SELECT version FROM wm_schema_version ORDER BY version')).rows,
      [{ version: 1 }, { version: 2 }, { version: 3 }]);
    await store.initStore();
    const after = (await pool.query(`
      SELECT (SELECT count(*)::int FROM app_gl_entries) AS gl,
        (SELECT count(*)::int FROM app_journal_entries) AS journals
    `)).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await store.closeStore();
  }
});
