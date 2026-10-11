'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('database pool settings have bounded waits and reject invalid configuration', () => {
  const { postgresPoolOptions, postgresPoolMetrics } = require('../src/core');
  const names = ['POSTGRES_POOL_MAX', 'POSTGRES_CONNECTION_TIMEOUT_MS',
    'POSTGRES_STATEMENT_TIMEOUT_MS', 'POSTGRES_IDLE_TIMEOUT_MS'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => delete process.env[name]);
    assert.deepEqual(postgresPoolOptions(), { max: 10, connectionTimeoutMillis: 10000,
      statement_timeout: 0, idleTimeoutMillis: 30000 });
    process.env.POSTGRES_POOL_MAX = '20';
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = '60000';
    assert.equal(postgresPoolOptions().max, 20);
    assert.equal(postgresPoolOptions().statement_timeout, 60000);
    for (const value of ['0', '-1', 'NaN', '1.5']) {
      process.env.POSTGRES_POOL_MAX = value;
      assert.throws(postgresPoolOptions, /POSTGRES_POOL_MAX/);
    }
    assert.deepEqual(postgresPoolMetrics(), { total: 0, idle: 0, waiting: 0 });
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('master lookup cancels superseded requests without displaying a failure', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const listeners = {};
  const pending = [];
  const list = { replaceChildren() {} };
  const status = { textContent: '' };
  const retry = { hidden: true, addEventListener() {} };
  const input = { value: '', dataset: { masterLookup: '/api/customers' },
    getAttribute: name => name === 'list' ? 'list' : 'status',
    parentElement: { querySelector: () => retry },
    addEventListener: (name, listener) => { listeners[name] = listener; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/master-lookups.js'), 'utf8'), {
    document: { querySelectorAll: () => [input], getElementById: id => id === 'list' ? list : status },
    window: { location: { origin: 'http://localhost' } }, URL, AbortController,
    setTimeout, clearTimeout,
    fetch: (url, options) => new Promise((resolve, reject) => {
      pending.push({ signal: options.signal, resolve });
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }),
  });
  const first = listeners.focus();
  const second = listeners.focus();
  assert.equal(pending[0].signal.aborted, true);
  await first;
  assert.equal(retry.hidden, true);
  pending[1].resolve({ ok: true, json: async () => [] });
  await second;
  assert.equal(status.textContent, 'No active submitted records match. Try a different search.');
});

test('HTTP benchmark suite uses report routes, distinct sessions and streamed bodies', async () => {
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const path = require('node:path');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, cookie: req.headers.cookie });
    res.write('part1');
    res.end('part2');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, PERF_COOKIE: '',
      PERF_COOKIES: JSON.stringify(['wm_session=user1', 'wm_session=user2']),
      PERF_SEARCH_TERMS: JSON.stringify(['partial']) };
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.join(__dirname, '../scripts/benchmark-suite.mjs'), `--url=${target}`,
        '--from=2024-01-01', '--to=2026-10-11', '--requests=2', '--concurrency=2', '--warmup=0'], { env });
    const report = JSON.parse(stdout);
    assert.equal(report.results.length, 5);
    assert.equal(requests.length, 10);
    assert.deepEqual(new Set(requests.map(req => req.cookie)), new Set(['wm_session=user1', 'wm_session=user2']));
    for (const result of report.results) {
      assert.equal(result.failed, 0);
      assert.equal(result.response_bytes, 20);
      assert.equal(result.warmup, 0);
      assert.equal(result.sessions, 2);
    }
    for (const format of ['csv', 'xlsx', 'pdf']) {
      assert.ok(requests.some(req => req.path.startsWith('/reports/general-ledger?') && req.path.includes(`format=${format}`)));
    }
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.writeHead(303, { Location: '/login' }); res.end(); });
    await assert.rejects(promisify(execFile)(process.execPath,
      [path.join(__dirname, '../scripts/benchmark-http.mjs'), `--url=${target}`, '--requests=2', '--concurrency=2'],
      { env }), error => JSON.parse(error.stdout).failed === 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PostgreSQL enforces configured query and connection-acquisition timeouts', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const { AuditPool } = require('../src/audit');
  const pool = new AuditPool({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    max: 1, connectionTimeoutMillis: 100, statement_timeout: 50 });
  let client;
  try {
    await assert.rejects(pool.query('SELECT pg_sleep(1)'), error => error.code === '57014');
    client = await pool.connect();
    await assert.rejects(pool.connect(), /timeout/i);
    assert.equal(pool.waitingCount, 0);
    client.release();
    client = null;
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
  } finally {
    client?.release();
    await pool.end();
  }
});
