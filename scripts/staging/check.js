'use strict';
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const store = require('../../src/store');
const { guard } = require('./seed');
const { validateResponse } = require('../../tests/helpers/api-contract');
const { benchmark, options } = require('../benchmark-api');
const { currentPostingDate } = require('../../src/posting-time');
const STATE = '/staging-state/credentials.json';
const REPORT = '/staging-state/acceptance.json';
const agent = new https.Agent({ ca: fs.readFileSync('/staging-state/tls/ca.crt'), rejectUnauthorized: true });
let stage = 'guard';
const report = { timestamp: new Date().toISOString(), run_id: crypto.randomUUID(), environment: 'isolated-local-staging',
  real_client_acceptance: false, requests: [], checks: [], resources: [] };

async function request(path, { method = 'GET', token, body, key, headers = {}, expected } = {}) {
  const response = await new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = https.request('https://staging-proxy:8443' + path, { agent, method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(encoded === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
        ...(key ? { 'Idempotency-Key': key } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); } catch { reject(new Error('Expected API JSON')); } });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Staging timeout'))); req.on('error', reject); req.end(encoded);
  });
  report.requests.push({ method, route: path.split('?')[0].replace(/\/[1-9][0-9]*(?=\/|$)/g, '/:id'), status: response.status,
    request_id: response.headers['x-request-id'] || null });
  if (expected !== undefined) assert.equal(response.status, expected);
  const resource = path.replace(/^\/api\/v1/, '').split('?')[0];
  if (resource.startsWith('/invoices') || ['/me', '/customers', '/suppliers', '/items', '/warehouses', '/price-lists', '/cost-centers', '/stock-balances', '/sales-options'].includes(resource)) {
    validateResponse(resource, method.toLowerCase(), response.status, response.body);
  }
  return response;
}

async function website(path, { method = 'GET', form, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const body = form === undefined ? null : new URLSearchParams(form).toString();
    const req = https.request('https://staging-proxy:8443' + path, { agent, method, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Origin: 'https://staging-proxy:8443' }) } }, res => {
      let html = ''; res.on('data', chunk => { html += chunk; }); res.on('error', reject);
      res.on('end', () => { report.requests.push({ method, route: path.replace(/\/[1-9][0-9]*(?=\/|$)/g, '/:id'), status: res.statusCode, request_id: null });
        resolve({ status: res.statusCode, headers: res.headers, html }); });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Staging timeout'))); req.on('error', reject); req.end(body);
  });
}

async function main() {
  const pool = store.getPostgresPool(); await guard(pool);
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const prefix = report.run_id;
  const postingDate = currentPostingDate();
  stage = 'TLS and proxy';
  const denied = await request('/api/v1/me', { expected: 401 }); assert.equal(denied.body.error.code, 'unauthorized');
  const direct = await new Promise((resolve, reject) => {
    http.get('http://staging-app:3020/api/v1/me', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(direct, 403); report.checks.push('trusted-CA HTTPS, proxy separation and production HTTP rejection');
  const login = async user => (await request('/api/v1/auth/login', { method: 'POST', body: user, expected: 200 })).body.data;
  const admin = await login(state.admin); let mobile = await login(state.mobile);
  stage = 'mobile rotation';
  const oldAccess = mobile.access_token;
  mobile = (await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: mobile.refresh_token }, expected: 200 })).body.data;
  await request('/api/v1/me', { token: oldAccess, expected: 401 });
  await request('/api/v1/me', { token: mobile.access_token, headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': 'spoofed' }, expected: 200 });
  report.checks.push('mobile refresh rotation and overwritten forwarded headers');
  stage = 'integration credential';
  const scopes = ['masters:read', 'stock:read', 'invoices:read', 'invoices:create', 'invoices:submit', 'payments:record'];
  const integration = state.integration
    ? (await request('/api/v1/integration-credentials', { method: 'POST', token: admin.access_token,
      body: { user_id: state.integration.user_id, scopes }, expected: 201 })).body.data
    : (await request('/api/v1/integration-accounts', { method: 'POST', token: admin.access_token,
      body: { username: 'staging-integration', role: state.fixture.role, scopes }, expected: 201 })).body.data;
  // Persist issuance immediately; a later failed check must not lose account identity.
  const previous = state.integration;
  state.integration = integration; fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  if (previous) await request(`/api/v1/integration-credentials/${previous.id}/revoke`, { method: 'POST', token: admin.access_token, body: {}, expected: 200 });
  const amount = await pool.query("SELECT quantity FROM app_stock_balances WHERE item_code='STG-I1' AND warehouse='Staging Main'");
  const beforeStock = Number(amount.rows[0].quantity);

  for (const [label, token] of [['mobile', mobile.access_token], ['integration', integration.token]]) {
    stage = label + ' read isolation';
    const me = (await request('/api/v1/me', { token, expected: 200 })).body.data;
    const customers = await request('/api/v1/customers', { token, expected: 200 });
    assert.deepEqual(customers.body.data.map(row => row.id), ['STG-C1']);
    const warehouses = await request('/api/v1/warehouses', { token, expected: 200 });
    assert.deepEqual(warehouses.body.data.map(row => row.id), ['Staging Main']);
    await request('/api/v1/suppliers', { token, expected: 403 });
    const items = await request('/api/v1/items?price_list=Staging%20Retail', { token, expected: 200 });
    assert(items.body.data.some(row => row.id === 'STG-I1')); assert(items.body.data.every(row => !Object.hasOwn(row, 'unit_cost')));
    const lists = await request('/api/v1/price-lists', { token, expected: 200 }); assert.deepEqual(lists.body.data.map(row => row.id), ['Staging Retail']);
    const centers = await request('/api/v1/cost-centers', { token, expected: 200 }); assert(centers.body.data.some(row => row.id === 'STG-CC1'));
    const stock = await request('/api/v1/stock-balances?warehouse=Staging%20Main', { token, expected: 200 }); assert(stock.body.data.some(row => row.item_code === 'STG-I1'));
    const invoicers = await request('/api/v1/sales-options?purpose=invoicing', { token, expected: 200 }); assert(invoicers.body.data.invoicers.some(row => row.id === 'STG-E1'));
    await request(`/api/v1/invoices/${state.fixture.hidden}`, { token, expected: 404 });
    await request(`/api/v1/invoices/${state.fixture.hidden}/payments`, { token, expected: 404 });
    const selectors = await request('/api/v1/sales-options?purpose=payments', { token, expected: 200 });
    assert.deepEqual(selectors.body.data.receiving_accounts.map(row => row.id), [state.fixture.cash]);
    await request('/api/v1/stock-balances?warehouse=Staging%20Hidden', { token, expected: 403 });
    report.checks.push(label + ' scoped reads and concealed resources');
    stage = label + ' financial flow';
    const draft = { customer_id: 'STG-C1', warehouse: 'Staging Main', price_list: 'Staging Retail', invoicer_id: 'STG-E1',
      invoice_date: postingDate, items: [{ item_code: 'STG-I1', quantity: '1.25', unit_price: '100.50' }] };
    const createKey = prefix + '-' + label + '-create';
    const create = () => request('/api/v1/invoices', { method: 'POST', token, key: createKey, body: draft, expected: 201 });
    const created = await Promise.all([create(), create()]); assert.deepEqual(created[0].body, created[1].body);
    const id = created[0].body.data.id; assert.equal(Number(created[0].body.data.total), 126);
    const submit = () => request(`/api/v1/invoices/${id}/submit`, { method: 'POST', token, key: prefix + '-' + label + '-submit', body: {}, expected: 200 });
    const submissions = await Promise.all([submit(), submit()]); assert.deepEqual(submissions[0].body, submissions[1].body);
    const payment = { payment_date: postingDate, amount: '50.50', account_id: state.fixture.cash,
      external_source: 'local-staging', external_reference: prefix + '-' + label };
    const pay = (key, body = payment, expected = 201) => request(`/api/v1/invoices/${id}/payments`, { method: 'POST', token, key, body, expected });
    const payKey = prefix + '-' + label + '-payment';
    const paid = await Promise.all([pay(payKey), pay(payKey)]); assert.deepEqual(paid[0].body, paid[1].body);
    assert.deepEqual((await pay(payKey + '-new')).body, paid[0].body);
    await pay(payKey + '-conflict', { ...payment, amount: '52' }, 409);
    await pay(payKey + '-hidden-account', { ...payment, external_reference: prefix + '-forbidden', account_id: state.fixture.bank }, 403);
    const detail = await request(`/api/v1/invoices/${id}`, { token, expected: 200 });
    assert.equal(Number(detail.body.data.amount_paid), 51); assert.equal(Number(detail.body.data.balance_due), 75);
    const receipts = await request(`/api/v1/invoices/${id}/payments`, { token, expected: 200 });
    assert.equal(receipts.body.data.length, 1); assert.equal(receipts.body.data[0].id, paid[0].body.data.id);
    const invoice = await store.findInvoice(id); assert.equal(invoice.created_by_user_id, me.id);
    assert.equal(invoice.payments[0].method, 'cash');
    assert.equal((await pool.query("SELECT 1 FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [id])).rowCount, 1);
    const record = (await pool.query('SELECT * FROM app_invoice_payments WHERE id=$1', [paid[0].body.data.id])).rows[0];
    const gl = (await pool.query("SELECT debit,credit FROM app_gl_entries WHERE voucher_type='payment_journal' AND voucher_id=$1", [record.journal_entry_id])).rows;
    assert(gl.length > 0); assert.equal(gl.reduce((sum, row) => sum + Number(row.debit), 0), 51);
    assert.equal(gl.reduce((sum, row) => sum + Number(row.credit), 0), 51);
    const audit = (await pool.query("SELECT * FROM wm_api_audit WHERE operation='payment.record' AND outcome='committed' AND resource_id=$1 ORDER BY id LIMIT 1", [paid[0].body.data.id])).rows[0];
    assert.equal(audit.actor_id, me.id); assert(paid.some(result => result.headers['x-request-id'] === audit.request_id));
    report.resources.push({ client: label, invoice_id: id, receipt_id: paid[0].body.data.id, total: 126, paid: 51 });
    report.checks.push(label + ' HTTPS creation/submission/receipt, retries, GL/stock/audit and website-reader reconciliation');
  }
  assert.equal(Number((await pool.query("SELECT quantity FROM app_stock_balances WHERE item_code='STG-I1' AND warehouse='Staging Main'")).rows[0].quantity), beforeStock - 2.5);
  stage = 'HTTPS website reconciliation';
  const loggedIn = await website('/login', { method: 'POST', form: state.mobile }); assert.equal(loggedIn.status, 303);
  const setCookie = loggedIn.headers['set-cookie'].find(value => value.startsWith('wm_session='));
  assert(/;\s*Secure(?:;|$)/.test(setCookie)); assert(/;\s*HttpOnly(?:;|$)/.test(setCookie));
  const cookie = setCookie.split(';')[0];
  for (const resource of report.resources) {
    const page = await website(`/invoices/${resource.invoice_id}`, { cookie }); assert.equal(page.status, 200);
    assert(page.html.includes((await store.findInvoice(resource.invoice_id)).invoice_no));
  }
  assert.equal((await website('/logout', { method: 'POST', cookie, form: {} })).status, 303);
  report.checks.push('HTTPS website cookie security and both API invoices visible through website detail pages');
  stage = 'failed submission';
  const excessive = { customer_id: 'STG-C1', warehouse: 'Staging Main', price_list: 'Staging Retail', invoicer_id: 'STG-E1', invoice_date: postingDate,
    items: [{ item_code: 'STG-I1', quantity: '100000', unit_price: '1' }] };
  const invoiceCount = async () => Number((await pool.query('SELECT count(*) AS count FROM app_invoices')).rows[0].count);
  const beforeRejectedDraft = await invoiceCount();
  await request('/api/v1/invoices', { method: 'POST', token: mobile.access_token,
    key: prefix + '-insufficient-draft', body: excessive, expected: 422 });
  assert.equal(await invoiceCount(), beforeRejectedDraft);
  report.checks.push('insufficient-stock draft rejected without creating an invoice');
  // Future drafts are allowed, while posting them is forbidden. Exercise a
  // genuine submission failure without consuming or altering the reusable stock.
  const futureDate = new Date(`${currentPostingDate()}T12:00:00Z`);
  futureDate.setUTCDate(futureDate.getUTCDate() + 1);
  const futureDraft = { ...excessive, invoice_date: futureDate.toISOString().slice(0, 10),
    items: [{ item_code: 'STG-I1', quantity: '1', unit_price: '1' }] };
  const failedDraft = await request('/api/v1/invoices', { method: 'POST', token: mobile.access_token,
    key: prefix + '-failed-draft', body: futureDraft, expected: 201 });
  const deniedSubmit = await request(`/api/v1/invoices/${failedDraft.body.data.id}/submit`, {
    method: 'POST', token: mobile.access_token, key: prefix + '-failed-submit', body: {}, expected: 400 });
  assert.equal(deniedSubmit.body.error.code, 'future_posting_date');
  assert.equal((await store.findInvoice(failedDraft.body.data.id)).docstatus, 'draft');
  report.checks.push('failed submission retains draft');
  stage = 'scope and revocation';
  const narrow = (await request('/api/v1/integration-credentials', { method: 'POST', token: admin.access_token,
    body: { user_id: integration.user_id, scopes: ['invoices:read'] }, expected: 201 })).body.data;
  await request('/api/v1/invoices', { method: 'POST', token: narrow.token, key: prefix + '-narrow', body: excessive, expected: 403 });
  await request(`/api/v1/integration-credentials/${narrow.id}/revoke`, { method: 'POST', token: admin.access_token, body: {}, expected: 200 });
  await request('/api/v1/me', { token: narrow.token, expected: 401 });
  const replacement = (await request('/api/v1/integration-credentials', { method: 'POST', token: admin.access_token, body: { user_id: integration.user_id, scopes }, expected: 201 })).body.data;
  state.integration = replacement; fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await request(`/api/v1/integration-credentials/${integration.id}/revoke`, { method: 'POST', token: admin.access_token, body: {}, expected: 200 });
  const resource = report.resources.find(row => row.client === 'integration');
  await request(`/api/v1/invoices/${resource.invoice_id}/payments`, { method: 'POST', token: integration.token,
    key: prefix + '-integration-payment', body: { payment_date: postingDate, amount: '50.50', account_id: state.fixture.cash,
      external_source: 'local-staging', external_reference: prefix + '-integration' }, expected: 401 });
  report.checks.push('scope narrowing, overlapping rotation and denied revoked replay');
  stage = 'bounded read load';
  report.read_load = await benchmark(options(['--url=https://staging-proxy:8443/api/v1', '--requests=10', '--concurrency=2', '--interval_ms=100'], { API_BENCHMARK_TOKEN: replacement.token }));
  assert.equal(report.read_load.failed, 0); report.checks.push('trusted-CA bounded read-load tool');
  await request('/api/v1/auth/logout', { method: 'POST', token: mobile.access_token, body: {}, expected: 200 });
  await request('/api/v1/me', { token: mobile.access_token, expected: 401 });
  await request('/api/v1/auth/logout', { method: 'POST', token: admin.access_token, body: {}, expected: 200 });
  report.checks.push('mobile/admin session logout'); report.passed = true;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'local_staging_acceptance', passed: true, checks: report.checks.length,
    https_requests: report.requests.length, synthetic_invoices: 3, read_load_failed: report.read_load.failed, real_client_acceptance: false }));
}
main().catch(() => {
  report.passed = false; report.failed_stage = stage;
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); } catch { /* No sensitive fallback logging. */ }
  console.error('Local staging acceptance failed at: ' + stage); process.exitCode = 1;
}).finally(async () => { agent.destroy(); await store.closeStore(); });
