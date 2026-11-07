'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

let scryptCalls = 0;
const originalScrypt = crypto.scrypt;
crypto.scrypt = function countedScrypt(...args) {
  scryptCalls++;
  return originalScrypt.apply(this, args);
};

const store = require('../src/store');
const auth = require('../src/auth');
const apiAuth = require('../src/api/auth');
const { resetGoldenSchema } = require('./helpers/golden-seed');

test('browser and API login verify each successful password once and reject stale versions', {
  skip: process.env.API_TEST_POSTGRES !== '1',
  timeout: 120000,
}, async () => {
  const password = 'OneScryptLogin123!';
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    await auth.createUser('one-scrypt-login', password, { role: 'standard' });

    scryptCalls = 0;
    const browser = await auth.authenticateSession('one-scrypt-login', password);
    assert.ok(browser?.token);
    assert.equal(browser.user.username, 'one-scrypt-login');
    assert.equal(scryptCalls, 1, 'browser login must verify the password once');

    scryptCalls = 0;
    const api = await apiAuth.login('one-scrypt-login', password, crypto.randomUUID());
    assert.ok(api.access_token);
    assert.ok(api.refresh_token);
    assert.equal(scryptCalls, 1, 'API login must verify the password once');

    scryptCalls = 0;
    assert.equal(await auth.authenticateSession('one-scrypt-login', 'WrongPassword123!'), null);
    assert.equal(scryptCalls, 1, 'failed login retains one password hash');

    await auth.resetUserPassword('one-scrypt-login', 'ReplacementLogin123!');
    assert.equal(await auth.authenticateSession('one-scrypt-login', password), null);

    const verified = await auth.verifyCredentials('one-scrypt-login', 'ReplacementLogin123!');
    const lockedRow = (await pool.query(
      'SELECT password_hash FROM app_users WHERE username=$1',
      ['one-scrypt-login'],
    )).rows[0];
    assert.equal(auth.passwordVersionMatches(lockedRow, verified.passwordVersion), true);

    const replacementHash = await auth.passwordHash('AnotherReplacement123!');
    await pool.query('UPDATE app_users SET password_hash=$1 WHERE username=$2',
      [replacementHash, 'one-scrypt-login']);
    const changedRow = (await pool.query(
      'SELECT password_hash FROM app_users WHERE username=$1',
      ['one-scrypt-login'],
    )).rows[0];
    assert.equal(auth.passwordVersionMatches(changedRow, verified.passwordVersion), false,
      'a concurrent password change must invalidate the verified version');
  } finally {
    await store.closeStore();
  }
});
