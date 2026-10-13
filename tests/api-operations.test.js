'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMonitor, configuration, routeTemplate } = require('../src/api/monitoring');
const { options, benchmark } = require('../scripts/benchmark-api');

test('API telemetry redacts sensitive input, bounds labels and counts completed/aborted requests once', () => {
  const records = [], monitor = createMonitor({ log: record => records.push(record) });
  const response = () => Object.assign(new EventEmitter(), { statusCode: 201, writableFinished: true });
  const req = { path: '/invoices/private-resource-id/payments', method: 'POST', requestId: 'safe-request-id',
    originalUrl: '/invoices/private-resource-id/payments?password=query-secret', body: { password: 'body-secret' },
    headers: { authorization: 'Bearer token-secret', cookie: 'cookie-secret', 'Idempotency-Key': 'retry-secret' },
    apiActor: { user: { id: 1, username: 'private-user' }, credentialId: 'credential-id' }, apiMutationOutcome: 'reference_replayed' };
  const res = response(); monitor.observe(req, res); res.emit('finish'); res.emit('close');
  assert.equal(records.length, 1); assert.equal(records[0].route, '/invoices/:id/payments');
  assert.equal(records[0].mutation_outcome, 'reference_replayed');
  for (const secret of ['query-secret', 'body-secret', 'token-secret', 'cookie-secret', 'retry-secret', 'private-resource-id', 'private-user']) assert(!JSON.stringify(records).includes(secret));
  const disconnected = response(); disconnected.writableFinished = false;
  monitor.observe({ path: '/untrusted-token-secret', method: 'ARBITRARY', requestId: 'second' }, disconnected);
  disconnected.emit('close'); disconnected.emit('finish');
  assert.equal(records.length, 2); assert.equal(records[1].status, 0); assert.equal(records[1].aborted, true);
  assert.equal(records[1].route, 'unmatched'); assert.equal(records[1].method, 'OTHER');
  const metrics = monitor.snapshot(); assert.equal(metrics.series.length, 2);
  for (const row of metrics.series) { assert.equal(row.requests, 1); assert.equal(row.latency_buckets.at(-1), 1); }
  assert.equal('actor_id' in metrics.series[0], false);
  assert.equal(routeTemplate('/invoices/42/submit/'), '/invoices/:id/submit');
  assert.equal(routeTemplate('/unknown/anything'), 'unmatched');
  const detached = monitor.snapshot(); detached.series[0].latency_buckets[0] = 99;
  assert.notEqual(monitor.snapshot().series[0].latency_buckets[0], 99);
  const failedSink = createMonitor({ log: () => { throw new Error('sink unavailable'); } });
  const safe = response(); failedSink.observe(req, safe); assert.doesNotThrow(() => safe.emit('finish'));
  assert.equal(failedSink.snapshot().series[0].requests, 1);
});

test('API monitoring settings reject invalid values and permit an explicit disable switch', () => {
  assert.deepEqual(configuration({}), { intervalMs: 60000, requestLogs: true, enabled: true });
  assert.deepEqual(configuration({ API_METRICS_INTERVAL_MS: '0', API_REQUEST_LOGS: 'false', API_V1_ENABLED: 'false' }), { intervalMs: 0, requestLogs: false, enabled: false });
  for (const env of [{ API_METRICS_INTERVAL_MS: '-1' }, { API_METRICS_INTERVAL_MS: 'NaN' }, { API_METRICS_INTERVAL_MS: '2147483648' },
    { API_REQUEST_LOGS: 'yes' }, { API_V1_ENABLED: '0' }]) assert.throws(() => configuration(env));
});

test('bearer load tool requires TLS and environment credentials, allowlists read routes and redacts reports', async () => {
  const token = 'a'.repeat(43), env = { API_BENCHMARK_TOKEN: token };
  const args = ['--url=https://example.test/api/v1'];
  assert.equal(options(args, env).concurrency, 1);
  for (const input of [ ['--url=http://example.test/api/v1'], ['--url=https://user:secret@example.test/api/v1'],
    ['--url=https://example.test/api/v1?token=secret'], [...args, '--resource=auth/login'], [...args, '--token=secret'],
    [...args, '--requests=0'], [...args, '--resource=stock-balances'], [...args, '--url=https://other.test/api/v1'] ]) assert.throws(() => options(input, env));
  assert.throws(() => options(args, {}));
  const http = require('node:http'); const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, authorization: req.headers.authorization, url: req.url });
    res.writeHead(seen.length === 2 ? 429 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [], private_data: 'never-in-report' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = options([`--url=http://127.0.0.1:${server.address().port}/api/v1`, '--allow_local_http=true',
      '--resource=stock-balances', '--warehouse=Private Warehouse', '--requests=3', '--concurrency=2', '--interval_ms=0'], env);
    const result = await benchmark(config);
    assert.equal(result.failed, 1); assert.deepEqual(result.statuses, { 200: 2, 429: 1 });
    assert(seen.every(req => req.method === 'GET' && req.authorization === 'Bearer ' + token));
    assert(!JSON.stringify(result).includes(token)); assert(!JSON.stringify(result).includes('Private Warehouse'));
    assert(!JSON.stringify(result).includes('never-in-report'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('API disable switch returns a JSON 503 before parsing/authentication while website requests still work', async () => {
  const express = require('express'); const { apiContext, apiErrors } = require('../src/api/errors');
  const app = express(); const previous = process.env.API_V1_ENABLED;
  app.use('/api/v1', apiContext); app.use(express.json());
  let calls = 0;
  app.post('/api/v1/invoices', (_req, res) => { calls++; res.json({ data: {} }); });
  app.get('/website', (_req, res) => res.send('website available')); app.use(apiErrors);
  const server = await new Promise(resolve => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
  try {
    process.env.API_V1_ENABLED = 'false';
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malformed' });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'api_disabled');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert(response.headers.get('x-request-id')); assert.equal(calls, 0);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/website`)).status, 200);
    process.env.API_V1_ENABLED = 'true';
    const enabled = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(enabled.status, 200); assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.API_V1_ENABLED; else process.env.API_V1_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
  }
});
