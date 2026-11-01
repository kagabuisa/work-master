'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { installHealthRoutes } = require('../src/health');
const { renderMetrics } = require('../src/metrics');
const requestMetrics = require('../src/request-metrics');
const { renderEnvironment, runtimeEnvironment } = require('../src/runtime-environment');
const { readSecret } = require('../src/secrets');

async function start(checkDatabase, isReady = () => true, options = {}) {
  const app = express();
  installHealthRoutes(app, { isReady, checkDatabase, ...options });
  const server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('liveness does not depend on database readiness', async () => {
  const app = await start(() => { throw new Error('database unavailable'); }, () => false);
  try {
    const response = await fetch(`${app.url}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('readiness checks initialization and the database', async () => {
  let ready = false;
  let checks = 0;
  const app = await start(async () => { checks += 1; }, () => ready);
  try {
    let response = await fetch(`${app.url}/readyz`);
    assert.equal(response.status, 503);
    assert.equal(checks, 0);

    ready = true;
    response = await fetch(`${app.url}/readyz`);
    assert.equal(response.status, 200);
    assert.equal(checks, 1);
    assert.deepEqual(await response.json(), { status: 'ready' });
  } finally {
    await app.close();
  }
});

test('readiness fails closed when the database check fails', async () => {
  const app = await start(async () => { throw new Error('database unavailable'); });
  try {
    const response = await fetch(`${app.url}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'not_ready' });
  } finally {
    await app.close();
  }
});

test('metrics require a token when accessed through a proxy', async () => {
  const token = 'monitoring-token-fixture';
  const app = await start(async () => {}, () => true, {
    monitoringAccessToken: token,
    metrics: ({ ready }) => `work_master_ready ${ready ? 1 : 0}\n`,
  });
  try {
    let response = await fetch(`${app.url}/metrics`, { headers: { 'X-Forwarded-For': '198.51.100.10' } });
    assert.equal(response.status, 401);
    response = await fetch(`${app.url}/metrics`, {
      headers: { 'X-Forwarded-For': '198.51.100.10', Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.equal(await response.text(), 'work_master_ready 1\n');
    response = await fetch(`${app.url}/metrics`);
    assert.equal(response.status, 200, 'direct loopback scrape remains available');
  } finally {
    await app.close();
  }
});

test('metrics rendering exposes bounded application and PostgreSQL signals', () => {
  const text = renderMetrics({ ready: true });
  assert.match(text, /^work_master_up 1$/m);
  assert.match(text, /^work_master_ready 1$/m);
  assert.match(text, /# TYPE work_master_postgres_pool_connections gauge/);
  assert.match(text, /# TYPE work_master_http_requests_total counter/);
  assert.doesNotMatch(text, /authorization|cookie|request_body/i);
});

test('application request metrics use bounded route groups', () => {
  let calls = 0;
  for (const pathValue of ['/', '/invoices/123', '/reports/general-ledger', '/api/v1/invoices/secret-id',
    '/healthz', '/unclassified/private-id']) {
    const listeners = {};
    const response = {
      statusCode: 200,
      writableFinished: true,
      once(event, listener) { listeners[event] = listener; },
    };
    requestMetrics.observeRequest({ path: pathValue, method: 'GET' }, response, () => { calls += 1; });
    listeners.finish?.();
  }
  assert.equal(calls, 6);
  const rows = requestMetrics.snapshot();
  assert(rows.some(row => row.group === 'invoices'));
  assert(rows.some(row => row.group === 'reports'));
  assert(rows.some(row => row.group === 'api.v1'));
  assert(rows.some(row => row.group === 'other'));
  assert(!rows.some(row => row.group.includes('secret') || row.group.includes('private')));
});

test('runtime environment excludes owner and unrelated credentials', () => {
  const source = {
    POSTGRES_DB: 'work_master',
    POSTGRES_USER: 'owner',
    POSTGRES_PASSWORD: 'owner-secret',
    POSTGRES_RUNTIME_USER: 'runtime',
    POSTGRES_RUNTIME_PASSWORD: 'runtime-secret',
    OPENAI_API_KEY: 'ai-secret',
    MONITORING_TOKEN: 'monitoring-secret',
    ERPNEXT_PASSWORD: 'erp-secret',
    AWS_ACCESS_KEY_ID: 'aws-id',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    github_token: 'github-secret',
    github_username: 'github-user',
    WORK_MASTER_TEST_PASSWORD: 'test-secret',
    ERPNEXT_URL: 'https://erp.example',
    BROWSER_LOGIN_IP_LIMIT: '100',
  };
  const runtime = runtimeEnvironment(source);
  assert.equal(runtime.POSTGRES_RUNTIME_USER, 'runtime');
  assert.equal(runtime.POSTGRES_RUNTIME_PASSWORD, 'runtime-secret');
  assert.equal(runtime.ERPNEXT_URL, 'https://erp.example');
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'OPENAI_API_KEY', 'MONITORING_TOKEN', 'ERPNEXT_PASSWORD',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'github_token', 'github_username',
    'WORK_MASTER_TEST_PASSWORD']) {
    assert.equal(key in runtime, false);
  }
  assert.throws(() => runtimeEnvironment({ POSTGRES_DB: 'work_master' }), /POSTGRES_RUNTIME/);
  assert.equal(renderEnvironment({ A: 'plain', B: 'has space' }), 'A=plain\nB="has space"\n');
});

test('secret files take precedence over process environment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-secrets-'));
  const file = path.join(directory, 'token');
  try {
    fs.writeFileSync(file, 'file-secret\n', { mode: 0o600 });
    assert.equal(readSecret('MONITORING_TOKEN', {
      MONITORING_TOKEN: 'environment-secret',
      MONITORING_TOKEN_FILE: file,
    }), 'file-secret');
    assert.equal(readSecret('MONITORING_TOKEN', { MONITORING_TOKEN: 'environment-secret' }), 'environment-secret');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
