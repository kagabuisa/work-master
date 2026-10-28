'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const store = require('../src/store');
const auth = require('../src/auth');
const { hash } = require('../src/api/security');

test('browser login budgets persist in PostgreSQL independently by IP and username', {
  skip: process.env.API_TEST_POSTGRES !== '1', timeout: 120000,
}, async t => {
  let server;
  const pool = store.getPostgresPool();
  const password = 'Browser password 123!';
  const usernameKey = name => hash(`browser-login-username:${name}`);
  const ipKey = ip => hash(`browser-login-ip:${ip}`);
  async function start() {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.urlencoded({ extended: false }));
    app.use((_req, res, next) => { res.render = (view, data) => res.json({ view, ...data }); next(); });
    // Reload the HTTP module so a process-local Map cannot satisfy persistence.
    delete require.cache[require.resolve('../src/auth-http')];
    require('../src/auth-http').installAuth(app);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'Request failed' }));
    server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
  }
  const login = (username, ip, suppliedPassword = 'Incorrect password') => fetch(`http://127.0.0.1:${server.address().port}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    body: new URLSearchParams({ username, password: suppliedPassword }),
  });
  const counter = async key => (await pool.query('SELECT count,reset_at FROM wm_api_rate_limits WHERE key=$1', [key])).rows[0];
  const assertLimited = response => {
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(response.headers.get('set-cookie'), null);
  };
  try {
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await auth.createUser('browser-success', password, { role: 'standard' });
    await start();

    await t.test('changing IP does not reset a normalized username budget', async () => {
      for (let i = 1; i <= 5; i++) assert.equal((await login('  Browser-Target  ', `203.0.113.${i}`)).status, 401);
      assert.equal((await counter(usernameKey('browser-target'))).count, 5);
      const before = (await counter(usernameKey('browser-target'))).reset_at.toISOString();
      assertLimited(await login('browser-target', '203.0.113.6'));
      assert.equal((await counter(usernameKey('browser-target'))).reset_at.toISOString(), before, 'blocked attempts do not extend the window');
      assert.equal((await login('another-target', '203.0.113.7')).status, 401);
    });
    await t.test('changing username does not reset an IP budget', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await login(`ip-target-${i}`, '198.51.100.1')).status, 401);
      assertLimited(await login('ip-target-blocked', '198.51.100.1'));
      assert.equal(await counter(usernameKey('ip-target-blocked')), undefined, 'an exhausted IP cannot consume another account budget');
      assert.equal((await counter(ipKey('198.51.100.1'))).count, 21);
    });
    await t.test('new app instances retain the existing lockout', async () => {
      await new Promise(resolve => server.close(resolve));server = null;
      await start();
      assertLimited(await login('browser-target', '203.0.113.8'));
      assertLimited(await login('fresh-user', '198.51.100.1'));
    });
    await t.test('atomic reservations enforce limits on simultaneous requests', async () => {
      const usernames = await Promise.all(Array.from({ length: 10 }, (_, i) => login('concurrent-target', `203.0.114.${i + 1}`)));
      assert.equal(usernames.filter(response => response.status === 401).length, 5);
      assert.equal(usernames.filter(response => response.status === 429).length, 5);
      const ips = await Promise.all(Array.from({ length: 25 }, (_, i) => login(`concurrent-ip-${i}`, '198.51.100.2')));
      assert.equal(ips.filter(response => response.status === 401).length, 20);
      assert.equal(ips.filter(response => response.status === 429).length, 5);
    });
    await t.test('successful login clears only the username counter and issues a session', async () => {
      for (let i = 0; i < 4; i++) assert.equal((await login('browser-success', '198.51.100.3')).status, 401);
      const success = await login(' BROWSER-SUCCESS ', '198.51.100.3', password);
      assert.equal(success.status, 303);
      assert.match(success.headers.get('set-cookie'), /^wm_session=/);
      assert.equal(await counter(usernameKey('browser-success')), undefined);
      assert.equal((await counter(ipKey('198.51.100.3'))).count, 5);
      assert.equal((await login('browser-success', '198.51.100.3')).status, 401);
      assert.equal((await counter(usernameKey('browser-success'))).count, 1);
    });
    await t.test('expired budgets start a fresh window, independent of API budgets', async () => {
      await pool.query('UPDATE wm_api_rate_limits SET reset_at=now()-interval \'1 second\' WHERE key=ANY($1::text[])',
        [[usernameKey('browser-target'), ipKey('198.51.100.1')]]);
      assert.equal((await login('browser-target', '198.51.100.1')).status, 401);
      for (const key of [usernameKey('browser-target'), ipKey('198.51.100.1')]) {
        const row = await counter(key);assert.equal(row.count, 1);assert.ok(row.reset_at > new Date());
      }
      await pool.query(`INSERT INTO wm_api_rate_limits(key,count,reset_at) VALUES($1,999,now()+interval '15 minutes')`,
        [hash('login-account:api-only-target')]);
      assert.equal((await login('api-only-target', '198.51.100.4')).status, 401);
      const rows = (await pool.query('SELECT key FROM wm_api_rate_limits')).rows;
      assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.key)), 'stored keys contain hashes, not plaintext IPs or usernames');
    });
    await t.test('counter storage failure never bypasses throttling or creates a session', async () => {
      const before = Number((await pool.query('SELECT count(*) AS count FROM app_user_sessions')).rows[0].count);
      await pool.query('ALTER TABLE wm_api_rate_limits RENAME TO unavailable_login_limits');
      try {
        const response = await login('browser-success', '198.51.100.5', password);
        assert.equal(response.status, 500);assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(Number((await pool.query('SELECT count(*) AS count FROM app_user_sessions')).rows[0].count), before);
      } finally { await pool.query('ALTER TABLE unavailable_login_limits RENAME TO wm_api_rate_limits'); }
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await store.closeStore();
  }
});
