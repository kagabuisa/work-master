'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonical, atomicMutation, permanentPayment } = require('../src/api/transactions');
const { requireAction } = require('../src/api/policy');
const { validateScopes } = require('../src/api/security');

test('API scope checks narrow account permissions and canonical JSON rejects invalid values', () => {
  const actor = { kind: 'integration', scopes: ['invoices:read'], user: { role: 'standard', permissions: ['vouchers.sales.view'] } };
  requireAction(actor, 'invoices:read', 'vouchers.sales.view');
  assert.throws(() => requireAction(actor, 'invoices:create', 'vouchers.sales.view'), /cannot perform/);
  assert.throws(() => requireAction(actor, 'invoices:read', 'vouchers.sales.create'), /cannot perform/);
  assert.equal(canonical({ b: [1, '2'], a: true }), canonical({ a: true, b: [1, '2'] }));
  assert.throws(() => canonical({ a: NaN }), /valid JSON/);
  assert.throws(() => canonical({ a: undefined }), /valid JSON/);
  assert.throws(() => validateScopes(['invoices:read', 'invoices:read']), /unique supported/);
  assert.throws(() => validateScopes(['admin']), /unique supported/);
});

test('API authentication, transactional retries and website payment parity', {
  skip: process.env.API_TEST_POSTGRES !== '1', timeout: 120000,
}, async t => {
  const store = require('../src/store');
  const users = require('../src/auth');
  const apiAuth = require('../src/api/auth');
  const domain = require('../src/domain/sales');
  const { seedGoldenData, FIXED } = require('./helpers/golden-seed');
  const { withPostgresTransaction } = require('../src/core');
  const { runWithAuditUser } = require('../src/audit');
  const { apiContext, apiErrors } = require('../src/api/errors');
  const express = require('express');
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let server;
  try {
    const seeded = await seedGoldenData();
    const admin = await users.createUser('api-admin', 'OriginalPass123!', { role: 'admin' });
    const standard = await users.createUser('api-user', 'OriginalPass123!', { role: 'standard' });
    const temporary = await users.createUser('api-temp', 'OriginalPass123!', { role: 'standard', mustChangePassword: true });
    const app = express();
    app.use('/api/v1', apiContext);
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/v1', require('../src/api/router'));
    // Exercise the real legacy cookie middleware as well as the new API router.
    require('../src/auth-http').installAuth(app);
    app.get('/', (req, res) => res.json({ username: req.currentUser.username }));
    app.use(require('../src/web/routes/sales'));
    app.use(apiErrors);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { token, method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(base + path, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, headers: response.headers, data };
    };
    const signIn = async username => {
      const response = await request('/api/v1/auth/login', { method: 'POST', body: { username, password: 'OriginalPass123!' } });
      assert.equal(response.status, 200); return response.data.data;
    };
    let adminTokens = await signIn(admin.username);
    const normalTokens = await signIn(standard.username);
    const pool = store.getPostgresPool();

    await t.test('opaque credentials, JSON errors, mixed authentication and legacy cookies', async () => {
      const me = await request('/api/v1/me', { token: normalTokens.access_token });
      assert.equal(me.status, 200); assert.equal(me.data.data.username, standard.username);
      assert.equal(me.headers.get('cache-control'), 'no-store');
      assert.match(me.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
      assert.equal('password_hash' in me.data.data, false);
      assert.equal((await request('/api/v1/me')).status, 401);
      assert.equal((await request('/api/v1/auth/login', { method: 'POST', body: { username: admin.username, password: 'OriginalPass123!', extra: 'rejected' } })).status, 400);
      assert.equal((await request('/api/v1/me', { token: normalTokens.refresh_token })).status, 401);
      assert.equal((await request('/api/v1/unknown', { token: normalTokens.access_token })).status, 404);
      assert.equal((await request('/api/v1/me', { token: normalTokens.access_token, method: 'HEAD' })).status, 404);
      assert.equal((await request('/api/v1/me', { token: normalTokens.access_token, headers: { Cookie: 'wm_session=abc' } })).status, 400);
      assert.equal((await request('/api/v1/me', { token: normalTokens.access_token, headers: { Origin: 'https://evil.example' } })).status, 403);
      const cookie = await users.createSession(admin.id);
      assert.equal((await request('/', { headers: { Cookie: `wm_session=${cookie}` } })).data.username, admin.username);
      const malformed = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
      assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.message, 'Malformed JSON body.');
      const sessions = JSON.stringify((await pool.query('SELECT * FROM wm_api_sessions')).rows);
      assert.equal(sessions.includes(normalTokens.access_token), false);
      assert.equal(sessions.includes(normalTokens.refresh_token), false);
    });

    await t.test('temporary-password users are restricted and changing password revokes every session', async () => {
      const tokens = await signIn(temporary.username);
      assert.equal(tokens.password_change_required, true);
      assert.equal((await request('/api/v1/me', { token: tokens.access_token })).data.error.code, 'password_change_required');
      assert.equal((await request('/api/v1/auth/password', { method: 'POST', token: tokens.access_token,
        body: { current_password: 'OriginalPass123!', new_password: 'ChangedPass123!' } })).status, 200);
      assert.equal((await request('/api/v1/me', { token: tokens.access_token })).status, 401);
      assert.equal((await pool.query('SELECT must_change_password FROM app_users WHERE id=$1', [temporary.id])).rows[0].must_change_password, false);
    });

    await t.test('concurrent refresh reuse revokes the family, including the winning access token', async () => {
      const tokens = await signIn(standard.username);
      const results = await Promise.all([1, 2].map(() => request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: tokens.refresh_token } })));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
      const winner = results.find(r => r.status === 200).data.data;
      assert.equal((await request('/api/v1/me', { token: winner.access_token })).status, 401);
      const next = await signIn(standard.username);
      const rotated = await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: next.refresh_token } });
      assert.equal(rotated.status, 200);
      assert.equal((await request('/api/v1/me', { token: next.access_token })).status, 401);
      assert.equal((await request('/api/v1/auth/logout', { method: 'POST', token: rotated.data.data.access_token, body: {} })).status, 200);
      assert.equal((await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: rotated.data.data.refresh_token } })).status, 401);
    });

    await t.test('website password reset invalidates mobile access and refresh without changing browser behavior', async () => {
      const tokens = await signIn(standard.username);
      await users.resetUserPassword(standard.username, 'ResetPassword123!');
      assert.equal((await request('/api/v1/me', { token: tokens.access_token })).status, 401);
      assert.equal((await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: tokens.refresh_token } })).status, 401);
    });

    let integration;
    await t.test('non-admin integration accounts, scope restrictions, overlap rotation and revocation', async () => {
      const limited = await users.createUser('api-nonadmin', 'OriginalPass123!', { role: 'standard' });
      const limitedTokens = await signIn(limited.username);
      assert.equal((await request('/api/v1/integration-accounts', { method: 'POST', token: limitedTokens.access_token,
        body: { username: 'forbidden-service', role: 'standard', scopes: ['invoices:read'] } })).status, 403);
      assert.equal((await request('/api/v1/integration-accounts', { method: 'POST', token: normalTokens.access_token,
        body: { username: 'forbidden-service', role: 'standard', scopes: ['invoices:read'] } })).status, 401);
      const created = await request('/api/v1/integration-accounts', { method: 'POST', token: adminTokens.access_token,
        body: { username: 'api-service', role: 'standard', scopes: ['invoices:read'] } });
      assert.equal(created.status, 201); integration = created.data.data;
      const listing = await request('/api/v1/integration-credentials', { token: adminTokens.access_token });
      assert.equal(listing.status, 200);
      assert(listing.data.data.some(row => row.id === integration.id));
      assert.equal(JSON.stringify(listing.data).includes(integration.token), false);
      assert.equal((await request('/api/v1/integration-credentials', { token: integration.token })).status, 403);
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 200);
      await users.resetUserPassword('api-service', 'ServicePassword123!');
      assert.equal(await users.authenticate('api-service', 'ServicePassword123!'), null);
      await assert.rejects(users.createSession(integration.user_id), { status: 401 });
      // Reset implies a password-change restriction; administrators must deliberately
      // clear it before continuing credential use. The account remains noninteractive.
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 401);
      await pool.query('UPDATE app_users SET must_change_password=false WHERE id=$1', [integration.user_id]);
      const actor = await apiAuth.resolveBearer(integration.token, crypto.randomUUID());
      assert.throws(() => requireAction(actor, 'payments:record', 'payments.sales.record'), /cannot perform/);
      const rotated = await request('/api/v1/integration-credentials', { method: 'POST', token: adminTokens.access_token,
        body: { user_id: integration.user_id, scopes: ['invoices:read'] } });
      assert.equal(rotated.status, 201);
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 200);
      assert.equal((await request('/api/v1/integration-credentials/' + integration.id + '/revoke', { method: 'POST', token: adminTokens.access_token, body: {} })).status, 200);
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 401);
      integration = rotated.data.data;
      await pool.query('UPDATE app_users SET active=false WHERE id=$1', [integration.user_id]);
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 401);
      await pool.query('UPDATE app_users SET active=true WHERE id=$1', [integration.user_id]);
      await pool.query("UPDATE wm_api_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [integration.id]);
      assert.equal((await request('/api/v1/me', { token: integration.token })).status, 401);
    });

    await t.test('mobile expiry and inactive accounts reject access immediately', async () => {
      const user = await users.createUser('api-expiry', 'OriginalPass123!', { role: 'standard' });
      const tokens = await signIn(user.username);
      await pool.query("UPDATE wm_api_sessions SET access_expires_at=now()-interval '1 second' WHERE user_id=$1", [user.id]);
      assert.equal((await request('/api/v1/me', { token: tokens.access_token })).status, 401);
      const refreshed = await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: tokens.refresh_token } });
      assert.equal(refreshed.status, 200);
      await pool.query('UPDATE app_users SET active=false WHERE id=$1', [user.id]);
      assert.equal((await request('/api/v1/me', { token: refreshed.data.data.access_token })).status, 401);
      await pool.query('UPDATE app_users SET active=true WHERE id=$1', [user.id]);
      await pool.query("UPDATE wm_api_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [user.id]);
      assert.equal((await request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshed.data.data.refresh_token } })).status, 401);
    });

    await t.test('shared invoice policy preserves creator ownership and warehouse restrictions', async () => {
      const { requireInvoice } = require('../src/api/policy');
      const user = await users.createUser('api-scope', 'OriginalPass123!', { role: 'standard' });
      const owned = await runWithAuditUser(user, () => store.createInvoice({ invoice_date: FIXED.date,
        customer_id: FIXED.customerId, customer_name: FIXED.customerName,
        items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 1, unit_price: 100 }] }));
      const tokens = await signIn(user.username);
      let actor = await apiAuth.resolveBearer(tokens.access_token, crypto.randomUUID());
      assert.equal((await requireInvoice(actor, owned, 'invoices:read', 'vouchers.sales.view')).id, owned);
      await assert.rejects(requireInvoice(actor, seeded.invoiceId, 'invoices:read', 'vouchers.sales.view'), /Invoice not found/);
      await pool.query('UPDATE app_users SET permission_denials=$1::jsonb WHERE id=$2', [JSON.stringify(['warehouse.view:' + FIXED.warehouse]), user.id]);
      actor = await apiAuth.resolveBearer(tokens.access_token, crypto.randomUUID());
      await assert.rejects(requireInvoice(actor, owned, 'invoices:read', 'vouchers.sales.view'), /Invoice not found/);
    });

    await t.test('existing payment wrapper and transaction-aware extraction have identical financial effects', async () => {
      const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
      const payload = { invoice_date: FIXED.date, customer_id: FIXED.customerId, customer_name: FIXED.customerName,
        items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 1, unit_price: 100 }] };
      const first = await store.createInvoice(payload), second = await store.createInvoice(payload);
      await store.submitInvoice(first);
      await withPostgresTransaction(client => domain.submitPostgresInvoiceInTransaction(client, second));
      const receipt = { payment_date: FIXED.date, amount: 40, account_id: cash, reference: 'unchanged-reference' };
      assert.equal(await store.addInvoicePayment(first, receipt), first);
      assert.equal(await withPostgresTransaction(client => domain.addPostgresInvoicePaymentInTransaction(client, second, receipt)), second);
      const summarize = async id => {
        const invoice = await store.findInvoice(id);
        const payment = invoice.payments[0];
        // Existing posting replaces the payment reference with its own journal
        // number. The numbers differ between independent vouchers by design.
        assert.match(payment.reference, /^JRN-\d+$/);
        const ledger = (await pool.query(`SELECT account_id,debit::text,credit::text FROM app_gl_entries
          WHERE voucher_id=$1 AND voucher_type='payment_journal' ORDER BY line_no`, [payment.journal_entry_id])).rows;
        return { total: invoice.total, amount_paid: invoice.amount_paid, method: payment.method,
          amount: payment.amount, reference: '<generated journal number>', ledger };
      };
      assert.deepEqual(await summarize(first), await summarize(second));
      // Website duplicate references are still allowed; no new financial-table constraint.
      await store.addInvoicePayment(first, { ...receipt, amount: 10 });
      assert.equal((await store.findInvoice(first)).amount_paid, 50);
      await assert.rejects(store.addInvoicePayment(first, { ...receipt, amount: 100 }), /cannot exceed/);
      await assert.rejects(withPostgresTransaction(client => domain.addPostgresInvoicePaymentInTransaction(client, second, { ...receipt, amount: 100 })), /cannot exceed/);
      const cookie = await users.createSession(admin.id);
      const website = await fetch(base + `/invoices/${first}/payments`, { method: 'POST', redirect: 'manual',
        headers: { Cookie: `wm_session=${cookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payment_date: FIXED.date, amount: '5', account_id: String(cash), reference: 'unchanged-reference' }) });
      assert.equal(website.status, 302);
      assert.equal(website.headers.get('location'), `/invoices/${first}`);
      assert.equal((await store.findInvoice(first)).amount_paid, 55);
    });

    await t.test('shared sales service uses current permissions and posts one-invoice receipts only once', async () => {
      const { executeInvoiceOperation } = require('../src/services/sales');
      const actor = await apiAuth.resolveBearer(adminTokens.access_token, crypto.randomUUID());
      const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
      const payload = { payment_date: FIXED.date, amount: 5, account_id: cash,
        external_source: 'shared-adapter', external_reference: 'shared-1' };
      const receipts = await Promise.all([1, 2].map(() => executeInvoiceOperation(actor, 'payment.record', seeded.invoiceId, 'shared-key', payload)));
      assert.deepEqual(receipts[0].body, receipts[1].body);
      const saved = (await pool.query('SELECT invoice_id,journal_entry_id FROM app_invoice_payments WHERE id=$1', [receipts[0].body.data.id])).rows[0];
      assert.equal(Number(saved.invoice_id), seeded.invoiceId); assert(saved.journal_entry_id);
      const retry = await executeInvoiceOperation(actor, 'payment.record', seeded.invoiceId, 'shared-new-key', payload);
      assert.deepEqual(retry.body, receipts[0].body);
      await assert.rejects(executeInvoiceOperation(actor, 'payment.record', seeded.invoiceId, 'missing-account', { ...payload, account_id: null }), /Choose a cash or bank account/);
      await assert.rejects(executeInvoiceOperation(actor, 'payment.record', seeded.invoiceId, 'shared-key', { ...payload, amount: 6 }), /different payload/);
    });

    await t.test('idempotent financial transaction commits one payment, permanent reference and linked audit', async () => {
      const actor = await apiAuth.resolveBearer(adminTokens.access_token, crypto.randomUUID());
      const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
      const payload = { payment_date: FIXED.date, amount: 10, account_id: cash };
      const before = Number((await pool.query('SELECT count(*) FROM app_invoice_payments WHERE invoice_id=$1', [seeded.invoiceId])).rows[0].count);
      const policy = async (client, fresh) => requireAction(fresh, 'payments:record', 'payments.sales.record');
      const mutation = async (client, fresh) => {
        const data = await permanentPayment(client, fresh, seeded.invoiceId, 'provider', 'ref-1', payload, async tx => {
          await domain.addPostgresInvoicePaymentInTransaction(tx, seeded.invoiceId, payload);
          return { invoice_id: String(seeded.invoiceId), receipt: 'recorded' };
        });
        return { status: 201, data, resource: { type: 'invoice', id: seeded.invoiceId } };
      };
      const call = key => atomicMutation(actor, 'payment.record', `/invoices/${seeded.invoiceId}/payments`, key, payload, policy, mutation);
      const results = await Promise.all([call('same-key'), call('same-key')]);
      assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
      assert.deepEqual(results[0].body, results[1].body);
      // A lost response retry and even a NEW key cannot repeat this provider reference.
      await call('same-key'); await call('new-key');
      assert.equal(Number((await pool.query('SELECT count(*) FROM app_invoice_payments WHERE invoice_id=$1', [seeded.invoiceId])).rows[0].count), before + 1);
      await pool.query("UPDATE wm_api_idempotency SET expires_at=now()-interval '1 second' WHERE key='same-key'");
      await call('same-key');
      assert.equal(Number((await pool.query('SELECT count(*) FROM app_invoice_payments WHERE invoice_id=$1', [seeded.invoiceId])).rows[0].count), before + 1);
      await assert.rejects(atomicMutation(actor, 'payment.record', `/invoices/${seeded.invoiceId}/payments`, 'new-key', { ...payload, amount: 11 }, policy, mutation), /different payload/);
      await assert.rejects(withPostgresTransaction(client => permanentPayment(client, actor, seeded.invoiceId, 'provider', 'ref-1', { ...payload, amount: 11 }, () => assert.fail('must not post'))), /different payment/);
      const audit = (await pool.query("SELECT * FROM wm_api_audit WHERE operation='payment.record' AND outcome='committed' LIMIT 1")).rows[0];
      assert.equal(String(audit.actor_id), String(admin.id)); assert.equal(audit.session_id, actor.sessionId);
      const stamped = (await pool.query('SELECT created_by_user_id FROM app_invoice_payments WHERE invoice_id=$1 ORDER BY id DESC LIMIT 1', [seeded.invoiceId])).rows[0];
      assert.equal(stamped.created_by_user_id, String(admin.id));
      await apiAuth.logout(actor);
      await assert.rejects(call('new-key'), /no longer valid/);
      adminTokens = await signIn(admin.username);
    });

    await t.test('audit failure rolls back payment, accounting effects and retry records together', async () => {
      const actor = await apiAuth.resolveBearer(adminTokens.access_token, crypto.randomUUID());
      const count = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM app_invoice_payments) AS payments,
        (SELECT count(*)::int FROM app_gl_entries) AS gl,(SELECT count(*)::int FROM app_journal_entries) AS journals`)).rows[0];
      const before = await count();
      const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
      const broken = { ...actor, requestId: 'invalid-uuid' };
      await assert.rejects(atomicMutation(broken, 'payment.failure', '/payments/test', 'rollback', {}, async () => {}, async client => {
        await domain.addPostgresInvoicePaymentInTransaction(client, seeded.invoiceId, { payment_date: FIXED.date, amount: 5, account_id: cash });
        return { status: 201, data: { ok: true } };
      }));
      assert.deepEqual(await count(), before);
      assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='rollback'")).rowCount, 0);
    });

    await t.test('permission changes are resolved before replay, and API writes preserve current website grants', async () => {
      const user = await users.createUser('api-replay', 'OriginalPass123!', { role: 'standard' });
      const tokens = await signIn(user.username);
      const actor = await apiAuth.resolveBearer(tokens.access_token, crypto.randomUUID());
      const permission = 'payments.sales.record';
      await pool.query('UPDATE app_users SET permission_grants=$1::jsonb WHERE id=$2', [JSON.stringify([permission]), user.id]);
      const call = () => atomicMutation(actor, 'permission.test', '/permission/test', 'key', {}, async (client, fresh) => requireAction(fresh, 'payments:record', permission), async () => ({ status: 200, data: { ok: true } }));
      await call();
      await pool.query('UPDATE app_users SET permission_denials=$1::jsonb WHERE id=$2', [JSON.stringify([permission]), user.id]);
      await assert.rejects(call(), /cannot perform/);
      assert((await pool.query('SELECT permission_denials FROM app_users WHERE id=$1', [user.id])).rows[0].permission_denials.includes(permission));
    });

    await t.test('throttling is database-backed and production rejects plain HTTP', async () => {
      const { rateLimit } = require('../src/api/security');
      let retry;
      const res = { set: (key, value) => { if (key === 'Retry-After') retry = value; } };
      await rateLimit({}, res, 'test', 'same-account', 1, 60);
      await assert.rejects(rateLimit({}, res, 'test', 'same-account', 1, 60), /Too many/);
      assert(Number(retry) > 0);
      process.env.NODE_ENV = 'production';
      assert.equal((await request('/api/v1/me', { token: adminTokens.access_token })).data.error.code, 'https_required');
      process.env.NODE_ENV = 'test';
      const auditText = JSON.stringify((await pool.query('SELECT * FROM wm_api_audit')).rows);
      assert.equal(auditText.includes(adminTokens.access_token), false);
      assert.equal(auditText.includes('OriginalPass123!'), false);
    });

    await t.test('cleanup removes expired families and retries without deleting payment references or audit', async () => {
      const { spawnSync } = require('node:child_process');
      const before = (await pool.query(`SELECT (SELECT count(*)::int FROM wm_api_payment_references) AS refs,
        (SELECT count(*)::int FROM wm_api_audit) AS audit`)).rows[0];
      await pool.query("UPDATE wm_api_sessions SET expires_at=now()-interval '1 second'");
      await pool.query("UPDATE wm_api_idempotency SET expires_at=now()-interval '1 second'");
      const cleaned = spawnSync(process.execPath, ['scripts/api-cleanup.js'], { encoding: 'utf8', env: process.env });
      assert.equal(cleaned.status, 0, cleaned.stderr);
      assert.deepEqual((await pool.query(`SELECT (SELECT count(*)::int FROM wm_api_payment_references) AS refs,
        (SELECT count(*)::int FROM wm_api_audit) AS audit`)).rows[0], before);
      assert.equal((await pool.query('SELECT 1 FROM wm_api_sessions')).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM wm_api_refresh_tokens')).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM wm_api_idempotency')).rowCount, 0);
    });
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    await store.closeStore();
  }
});
