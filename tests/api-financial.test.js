'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invoiceCreate, paymentCreate } = require('../src/api/financial-input');

const draft = (overrides = {}) => ({ customer_id: 'C1', warehouse: 'Main', price_list: 'Retail',
  invoicer_id: 'E1', invoice_date: '2026-10-01', posting_time: '09:30:45',
  items: [{ item_code: 'I1', quantity: '1.125', unit_price: '100.50' }], ...overrides });
const receipt = (account, reference, overrides = {}) => ({ payment_date: '2026-10-01', amount: '10',
  account_id: String(account), external_source: 'provider', external_reference: reference, ...overrides });

test('financial input rejects lossy decimals, invalid dates, unbounded and undocumented fields', () => {
  assert.deepEqual(invoiceCreate(draft()), draft());
  for (const value of [1, true, null, '', 'NaN', 'Infinity', '1e2', '-1', '01', ' 1', '1.0001', '100000000000']) {
    assert.throws(() => invoiceCreate(draft({ items: [{ item_code: 'I1', quantity: value, unit_price: '10' }] })), { status: 400 });
  }
  for (const value of ['0', '0.000']) assert.throws(() => invoiceCreate(draft({ items: [{ item_code: 'I1', quantity: value, unit_price: '0' }] })), { status: 400 });
  for (const value of ['2026-02-30', '0000-01-01', '2026-1-01', null]) assert.throws(() => invoiceCreate(draft({ invoice_date: value })), { status: 400 });
  for (const value of ['24:00', '09:60', '09:30:60', null]) assert.throws(() => invoiceCreate(draft({ posting_time: value })), { status: 400 });
  for (const extra of [{ customer_name: 'Forged' }, { payments: [] }, { amount_paid: '1' }, { total: '1' },
    { is_cash_sale: true }, { notes: 'x'.repeat(4001) }, { notes: '\0' }, { items: [] },
    { items: Array(201).fill(draft().items[0]) }, { items: [{ ...draft().items[0], warehouse: 'Secret' }] },
    { items: [{ ...draft().items[0], unit_price: '1.001' }] }]) assert.throws(() => invoiceCreate(draft(extra)), { status: 400 });
  assert.equal(invoiceCreate(draft({ items: Array(200).fill(draft().items[0]) })).items.length, 200);
  for (const extra of [{ method: 'bank' }, { invoice_id: '1' }, { reference: 'unprotected' },
    { account_id: '9007199254740992' }, { amount: '0' }, { external_reference: '' }, { external_source: ' provider' }]) {
    assert.throws(() => paymentCreate(receipt(1, 'test', extra)), { status: 400 });
  }
});

test('financial HTTP routes preserve accounting and protect retries, scopes and rollback', {
  skip: process.env.API_TEST_POSTGRES !== '1', timeout: 120000,
}, async t => {
  const express = require('express');
  const store = require('../src/store');
  const auth = require('../src/auth');
  const { runWithAuditUser } = require('../src/audit');
  const { apiContext, apiErrors } = require('../src/api/errors');
  const { cachedInvoiceList, clearInvoiceCaches } = require('../src/web/cache');
  const { validateResponse } = require('./helpers/api-contract');
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let server;
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    const admin = await auth.createUser('financial-admin', 'FinancialPass123!', { role: 'admin' });
    const other = await auth.createUser('financial-other', 'FinancialPass123!', { role: 'admin' });
    const standard = await auth.createUser('financial-standard', 'FinancialPass123!', { role: 'standard' });
    const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
    const bank = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1120'")).rows[0].id;
    const ar = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1100'")).rows[0].id;
    const permissions = ['vouchers.sales.create', 'vouchers.sales.submit', 'vouchers.sales.view', 'payments.sales.record'];
    const role = await auth.createRole('API Financial Tester', permissions, {
      customers: { mode: 'selected', values: ['retail'] }, warehouses: { mode: 'selected', values: ['Main'] },
      invoicePriceLists: { mode: 'selected', values: ['Retail'] }, accounts: { mode: 'selected', values: [String(cash)] },
    });
    const user = await auth.createUser('financial-user', 'FinancialPass123!', { role: role.slug,
      record_access: { employee_id: 'E1', cost_center: 'CC1' } });
    await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,docstatus) VALUES
      ('C1','Authoritative Customer','Retail','submitted'),('C2','Hidden Customer','Wholesale','submitted');
      INSERT INTO app_master_warehouses(warehouse,docstatus) VALUES ('Main','submitted'),('Secret','submitted');
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active,docstatus) VALUES
      ('Retail','UGX','selling',1,'submitted'),('Secret','UGX','selling',1,'submitted');
      INSERT INTO app_master_employees(employee_id,employee_name,status,disabled) VALUES
      ('E1','Authoritative Invoicer','Active',false),('E2','Hidden Invoicer','Active',false);
      INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES ('CC1','Allowed Center'),('CC2','Hidden Center');
      INSERT INTO app_master_items(item_code,item_name,stock_uom,docstatus) VALUES
      ('I1','First Item','Each','submitted'),('SCARCE','Scarce Item','Each','submitted');
      INSERT INTO app_master_item_prices(item_code,price_list,price_list_rate,active) VALUES ('I1','Retail',999,1);`);
    await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
      { item_code: 'I1', item_name: 'First Item', warehouse: 'Main', quantity: 100, valuation_rate: 20 },
      { item_code: 'I1', item_name: 'First Item', warehouse: 'Secret', quantity: 100, valuation_rate: 20 },
      { item_code: 'SCARCE', item_name: 'Scarce Item', warehouse: 'Main', quantity: 1, valuation_rate: 10 },
    ] });
    const app = express();
    app.use('/api/v1', apiContext); app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: false }));
    app.use('/api/v1', require('../src/api/router'));
    require('../src/auth-http').installAuth(app);
    app.use(require('../src/web/routes/sales')); app.use(apiErrors);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tokens = new Map();
    const request = async (path, { token = tokens.get(user.id), method = 'POST', body = {}, key, headers = {} } = {}) => {
      const response = await fetch(base + '/api/v1' + path, { method, headers: { Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (['/invoices', '/invoices/{id}/submit', '/invoices/{id}/payments'].includes(path.replace(/\/[1-9][0-9]*(?=\/|$)/, '/{id}'))) {
        validateResponse(path, method.toLowerCase(), response.status, result);
      }
      return { status: response.status, body: result, headers: response.headers };
    };
    for (const account of [admin, other, standard, user]) {
      const response = await request('/auth/login', { token: '', body: { username: account.username, password: 'FinancialPass123!' }, headers: { Authorization: '' } });
      assert.equal(response.status, 200); tokens.set(account.id, response.body.data.access_token);
    }
    const create = (key, body = draft(), token) => request('/invoices', { key, body, ...(token ? { token } : {}) });
    const submit = (id, key, token) => request(`/invoices/${id}/submit`, { key, ...(token ? { token } : {}) });
    const pay = (id, key, body, token) => request(`/invoices/${id}/payments`, { key, body, ...(token ? { token } : {}) });
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoices i) invoices,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_invoice_items i) items,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM app_invoice_payments p) payments,
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM app_journal_entries j) journals,
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM app_journal_entry_lines j) journal_lines,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) gl,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app_stock_ledger s) stock_ledger,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY item_code,warehouse) FROM app_stock_balances s) stock,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_id,source,reference) FROM wm_api_payment_references r) refs,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_id,operation,resource_path,key) FROM wm_api_idempotency r) retries`)).rows[0];
    let main;

    await t.test('draft HTTP validation fails before mutation and does not consume keys', async () => {
      const before = await snapshot();
      for (const body of [draft({ total: '1' }), draft({ payments: [] }), draft({ invoice_date: '2026-02-30' }),
        draft({ items: [{ item_code: 'I1', quantity: 1, unit_price: '10' }] }), draft({ items: Array(201).fill(draft().items[0]) }),
        draft({ notes: 'x'.repeat(4001) })]) assert.equal((await create('invalid-draft', body)).status, 400);
      for (const key of [undefined, '', 'x'.repeat(129), 'has space']) assert.equal((await create(key)).body.error.code, 'idempotency_key_required');
      assert.equal((await request('/invoices?extra=1', { key: 'query', body: draft() })).status, 400);
      assert.equal((await request('/invoices', { key: 'wrong-media', body: draft(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await request('/invoices', { token: '', key: 'unauthorized', body: draft() })).status, 401);
      assert.equal((await request('/invoices', { key: 'mixed', body: draft(), headers: { Cookie: 'wm_session=abc' } })).status, 400);
      assert.equal((await request('/invoices', { key: 'large-body', body: draft({ notes: 'x'.repeat(1024 * 1024) }) })).status, 413);
      const malformed = await fetch(base + '/api/v1/invoices', { method: 'POST', headers: {
        Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'malformed' }, body: '{broken' });
      assert.equal(malformed.status, 400); validateResponse('/invoices', 'post', 400, await malformed.json());
      const duplicateHeader = await new Promise((resolve, reject) => {
        const req = require('node:http').request(base + '/api/v1/invoices', { method: 'POST', headers: [
          'Host', new URL(base).host, 'Content-Length', String(Buffer.byteLength(JSON.stringify(draft()))),
          'Authorization', `Bearer ${tokens.get(user.id)}`, 'Content-Type', 'application/json',
          'Idempotency-Key', 'first', 'Idempotency-Key', 'second' ] }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; });
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
        });
        req.on('error', reject); req.end(JSON.stringify(draft()));
      });
      assert.equal(duplicateHeader.status, 400); assert.equal(duplicateHeader.body.error.code, 'idempotency_key_required');
      assert.deepEqual(await snapshot(), before);
      assert.equal(before.invoices, null);
      assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='invalid-draft'")).rowCount, 0);
    });

    await t.test('create commits authoritative draft totals, attribution and website cache visibility; concurrent retries match', async () => {
      clearInvoiceCaches();
      const cached = await cachedInvoiceList({});
      const body = draft({ tax_amount: '7.25', discount_amount: '2.25', cost_center: 'CC1', non_system_invoice: 'EXT-1' });
      const results = await Promise.all([create('main-create', body), create('main-create', body)]);
      assert.deepEqual(results.map(r => r.status), [201, 201]); assert.deepEqual(results[0].body, results[1].body);
      main = results[0].body.data.id;
      assert.equal(Number(results[0].body.data.total), 119);
      assert.equal(results[0].body.data.docstatus, 'draft');
      assert.equal(results[0].headers.get('cache-control'), 'no-store');
      const saved = await store.findInvoice(main);
      assert.equal(saved.customer_name, 'Authoritative Customer'); assert.equal(saved.invoicer, 'Authoritative Invoicer');
      assert.equal(saved.items[0].item_name, 'First Item'); assert.equal(saved.items[0].unit_price, 101);
      assert.equal(saved.items[0].quantity, 1.125); assert.equal(saved.created_by_user_id, String(user.id));
      assert.equal(saved.posting_time, '09:30'); assert.equal(saved.amount_paid, 0);
      assert.equal((await cachedInvoiceList({})).pagination.total, cached.pagination.total + 1);
      await pool.query("UPDATE app_master_customers SET customer_name='Changed Customer',disabled=true WHERE customer_id='C1'");
      assert.deepEqual((await create('main-create', body)).body, results[0].body);
      assert.equal((await create('disabled-customer', draft())).status, 422);
      await pool.query("UPDATE app_master_customers SET disabled=false WHERE customer_id='C1'");
      assert.equal((await create('main-create', { ...body, tax_amount: '8' })).body.error.code, 'idempotency_conflict');
      const detail = await request('/invoices/' + main, { method: 'GET' }); assert.equal(detail.status, 200);
      assert.equal(Number(detail.body.data.total), 119); assert.equal('created_by_user_id' in detail.body.data, false);
    });

    await t.test('draft creation enforces all reference restrictions and current permissions, including replay resource visibility', async () => {
      const before = await snapshot();
      for (const extra of [{ customer_id: 'C2' }, { warehouse: 'Secret' }, { price_list: 'Secret' }, { invoicer_id: 'E2' }, { cost_center: 'CC2' }]) {
        assert.equal((await create('scoped-draft', draft(extra))).status, 403);
      }
      assert.deepEqual(await snapshot(), before);
      const own = await create('visibility-create');
      await pool.query("UPDATE app_invoice_items SET warehouse='Secret' WHERE invoice_pk=$1", [own.body.data.id]);
      assert.equal((await create('visibility-create')).status, 404);
      await pool.query("UPDATE app_users SET permission_denials='[\"vouchers.sales.create\"]'::jsonb WHERE id=$1", [user.id]);
      assert.equal((await create('visibility-create')).status, 403);
      await pool.query("UPDATE app_users SET permission_denials='[]'::jsonb WHERE id=$1", [user.id]);
    });

    await t.test('submission contract and state checks retain drafts; concurrent HTTP retries post once', async () => {
      const path = `/invoices/${main}/submit`;
      assert.equal((await request(path, { key: 'main-submit', body: { submit: true } })).status, 400);
      assert.equal((await submit(main)).status, 400);
      const cached = await cachedInvoiceList({});
      const results = await Promise.all([submit(main, 'main-submit'), submit(main, 'main-submit')]);
      assert.deepEqual(results.map(r => r.status), [200, 200]); assert.deepEqual(results[0].body, results[1].body);
      assert.equal(results[0].body.data.docstatus, 'submitted'); assert.equal(Number(results[0].body.data.total), 119);
      assert.equal((await pool.query("SELECT 1 FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [main])).rowCount, 1);
      assert.equal((await submit(main, 'second-submit')).body.error.code, 'state_conflict');
      assert.equal((await cachedInvoiceList({})).rows.find(row => String(row.id) === main).docstatus, 'submitted');
      assert.equal(cached.rows.find(row => String(row.id) === main).docstatus, 'draft');
      const tooMany = (await create('insufficient-create', draft({ items: [{ item_code: 'I1', quantity: '101', unit_price: '100' }] }))).body.data.id;
      const before = await snapshot();
      assert.equal((await submit(tooMany, 'insufficient-submit')).body.error.code, 'insufficient_stock');
      assert.deepEqual(await snapshot(), before); assert.equal((await store.findInvoice(tooMany)).docstatus, 'draft');
      await pool.query("UPDATE app_master_items SET disabled=true WHERE item_code='I1'");
      assert.equal((await submit(tooMany, 'inactive-submit')).status, 422);
      await pool.query("UPDATE app_master_items SET disabled=false WHERE item_code='I1'");
    });

    await t.test('scarce-stock HTTP contention across actors submits one invoice and leaves the other draft', async () => {
      const body = draft({ items: [{ item_code: 'SCARCE', quantity: '1', unit_price: '100' }] });
      const first = await create('scarce-a', body, tokens.get(admin.id));
      const second = await create('scarce-b', body, tokens.get(other.id));
      const results = await Promise.all([submit(first.body.data.id, 'scarce-submit', tokens.get(admin.id)),
        submit(second.body.data.id, 'scarce-submit', tokens.get(other.id))]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 422]);
      assert.equal((await pool.query("SELECT 1 FROM app_stock_ledger WHERE item_code='SCARCE' AND voucher_type='invoice'")).rowCount, 1);
      const invoices = await Promise.all([store.findInvoice(first.body.data.id), store.findInvoice(second.body.data.id)]);
      assert.deepEqual(invoices.map(i => i.docstatus).sort(), ['draft', 'submitted']);
    });

    await t.test('a discarded create response is recovered with the same key and no extra financial rows', async () => {
      const response = await fetch(base + '/api/v1/invoices', { method: 'POST', headers: {
        Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'discarded-response' }, body: JSON.stringify(draft()) });
      assert.equal(response.status, 201);
      await response.body.cancel(); // Client deliberately discards the committed response.
      const saved = (await pool.query("SELECT response FROM wm_api_idempotency WHERE key='discarded-response'")).rows[0].response;
      const before = await snapshot();
      assert.deepEqual((await create('discarded-response')).body, saved);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('HTTP invoice lock timeout rolls back and the original key succeeds after the lock is released', async () => {
      const id = (await create('contention-create')).body.data.id;
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN'); await holder.query('SELECT id FROM app_invoices WHERE id=$1 FOR UPDATE', [id]);
        const before = await snapshot();
        const result = await submit(id, 'contention-submit');
        assert.equal(result.status, 409); assert.equal(result.body.error.code, 'operation_in_progress');
        assert.deepEqual(await snapshot(), before);
      } finally { await holder.query('ROLLBACK'); holder.release(); }
      assert.equal((await submit(id, 'contention-submit')).status, 200);
    });

    await t.test('payments require protected references and an eligible permitted account; state/overpayment errors roll back', async () => {
      const before = await snapshot();
      assert.equal((await pay(main, 'bad-payment', receipt(cash, 'missing', { external_reference: undefined }))).status, 400);
      assert.equal((await pay(main, 'bad-payment', receipt(cash, 'bad', { amount: 1 }))).status, 400);
      assert.equal((await pay(main, 'hidden-account', receipt(bank, 'hidden'))).status, 403);
      assert.equal((await pay(main, 'wrong-account', receipt(ar, 'wrong'), tokens.get(admin.id))).status, 422);
      assert.equal((await pay(main, 'overpay', receipt(cash, 'overpay', { amount: '120' }))).status, 422);
      assert.equal((await pay(main, 'round-zero', receipt(cash, 'round-zero', { amount: '0.49' }))).status, 422);
      assert.deepEqual(await snapshot(), before);
      const id = (await create('draft-payment')).body.data.id;
      assert.equal((await pay(id, 'draft-payment', receipt(cash, 'draft-payment'))).body.error.code, 'state_conflict');
    });

    await t.test('concurrent receipts and new-key reference retries create one payment/journal and audit-linked response', async () => {
      const body = receipt(cash, 'main-receipt', { amount: '20.50' });
      const prior = await cachedInvoiceList({});
      const results = await Promise.all([pay(main, 'main-pay', body), pay(main, 'main-pay', body)]);
      assert.deepEqual(results.map(r => r.status), [201, 201]); assert.deepEqual(results[0].body, results[1].body);
      const id = results[0].body.data.id;
      assert.deepEqual(Object.keys(results[0].body.data).sort(), ['id', 'invoice_id']);
      assert.deepEqual((await pay(main, 'new-pay-key', body)).body, results[0].body);
      assert.equal((await pay(main, 'main-pay', { ...body, amount: '22' })).body.error.code, 'idempotency_conflict');
      assert.equal((await pay(main, 'changed-reference', { ...body, amount: '22' })).body.error.code, 'payment_reference_conflict');
      assert.equal((await pool.query('SELECT 1 FROM app_invoice_payments WHERE invoice_id=$1', [main])).rowCount, 1);
      const saved = await store.findInvoice(main); assert.equal(saved.amount_paid, 21);
      assert.equal(saved.payments[0].method, 'cash'); assert.match(saved.payments[0].reference, /^JRN-/);
      assert.equal(Number((await cachedInvoiceList({})).rows.find(row => String(row.id) === main).amount_paid), 21);
      assert.equal(Number(prior.rows.find(row => String(row.id) === main).amount_paid), 0);
      const audit = (await pool.query("SELECT * FROM wm_api_audit WHERE operation='payment.record' AND outcome='committed' AND resource_id=$1 ORDER BY id LIMIT 1", [id])).rows[0];
      assert(results.some(result => result.headers.get('x-request-id') === audit.request_id));
      assert.equal(audit.actor_id, String(user.id)); assert(audit.session_id);
      const reads = await request(`/invoices/${main}/payments`, { method: 'GET' });
      assert.equal(reads.body.data[0].id, id); assert.equal(reads.body.data[0].amount, '21');
    });

    await t.test('different-key concurrent overpayments serialize against the existing balance rule', async () => {
      const id = (await create('race-payment')).body.data.id; await submit(id, 'race-payment-submit');
      const results = await Promise.all([pay(id, 'race-pay-a', receipt(cash, 'race-a', { amount: '80' })),
        pay(id, 'race-pay-b', receipt(cash, 'race-b', { amount: '80' }))]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 422]);
      assert.equal((await store.findInvoice(id)).amount_paid, 80);
    });

    await t.test('scope narrowing, role changes, Standard ownership and concealed IDs apply to financial HTTP', async () => {
      const created = await request('/integration-accounts', { token: tokens.get(admin.id), body: {
        username: 'financial-integration', role: role.slug, scopes: ['invoices:create', 'invoices:submit', 'payments:record', 'invoices:read'] } });
      assert.equal(created.status, 201);
      const integration = created.body.data.token;
      const made = await create('integration-create', draft(), integration); assert.equal(made.status, 201);
      const id = made.body.data.id; assert.equal((await submit(id, 'integration-submit', integration)).status, 200);
      const paid = await pay(id, 'integration-pay', receipt(cash, 'integration'), integration); assert.equal(paid.status, 201);
      const row = (await pool.query("SELECT * FROM wm_api_audit WHERE operation='payment.record' AND resource_id=$1", [paid.body.data.id])).rows[0];
      assert(row.credential_id); assert.equal(row.session_id, null);
      assert.equal((await store.findInvoice(id)).created_by_user_id, String(created.body.data.user_id));
      const narrow = await request('/integration-credentials', { token: tokens.get(admin.id), body: { user_id: String(created.body.data.user_id), scopes: ['invoices:read'] } });
      assert.equal((await create('narrow', draft(), narrow.body.data.token)).status, 403);
      assert.equal((await submit(id, 'integration-submit', narrow.body.data.token)).status, 403);
      assert.equal((await pay(id, 'integration-pay', receipt(cash, 'integration'), narrow.body.data.token)).status, 403);
      await pool.query("UPDATE app_users SET permission_denials='[\"payments.sales.record\"]'::jsonb WHERE id=$1", [created.body.data.user_id]);
      assert.equal((await pay(id, 'integration-pay', receipt(cash, 'integration'), integration)).status, 403);
      await pool.query("UPDATE app_users SET permission_denials='[]'::jsonb WHERE id=$1", [created.body.data.user_id]);
      await request(`/integration-credentials/${created.body.data.id}/revoke`, { token: tokens.get(admin.id) });
      assert.equal((await pay(id, 'integration-pay', receipt(cash, 'integration'), integration)).status, 401);
      for (const hidden of [main, '999999', '01', '9007199254740992']) {
        assert.equal((await submit(hidden, 'hidden', tokens.get(standard.id))).status, 404);
        assert.equal((await pay(hidden, 'hidden', receipt(cash, 'hidden'), tokens.get(standard.id))).status, 404);
      }
      await pool.query('UPDATE app_users SET record_access=$1::jsonb WHERE id=$2', [JSON.stringify({ employee_id: 'E1' }), standard.id]);
      assert.equal((await pay(main, 'employee-exception', receipt(cash, 'employee'), tokens.get(standard.id))).status, 201);
      await pool.query("UPDATE app_users SET permission_denials='[\"payments.sales.record\"]'::jsonb WHERE id=$1", [standard.id]);
      assert.equal((await pay(main, 'employee-exception', receipt(cash, 'employee'), tokens.get(standard.id))).status, 403);
    });

    await t.test('faults in audit or retry storage fully roll back each HTTP financial operation', async () => {
      const id = (await create('fault-draft')).body.data.id;
      for (const table of ['wm_api_audit', 'wm_api_idempotency']) {
        await pool.query(`CREATE FUNCTION financial_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected financial test failure'; END $$;
          CREATE TRIGGER financial_test_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION financial_test_fault()`);
        try {
          for (const action of [() => create('fault-create'), () => submit(id, 'fault-submit'),
            () => pay(main, 'fault-pay', receipt(cash, 'fault-' + table))]) {
            const before = await snapshot(); const result = await action();
            assert.equal(result.status, 500); assert.equal(result.body.error.message, 'The service could not complete the request.');
            assert.deepEqual(await snapshot(), before);
          }
        } finally { await pool.query(`DROP TRIGGER financial_test_fault ON ${table}; DROP FUNCTION financial_test_fault()`); }
      }
      assert.equal((await submit(id, 'fault-submit')).status, 200);
      assert.equal((await pay(main, 'fault-pay', receipt(cash, 'fault-wm_api_idempotency'))).status, 201);
    });

    await t.test('HTTP and website services match totals, stock, ledger, derived bank method and existing journal allocations', async () => {
      const body = draft({ items: [{ item_code: 'I1', quantity: '1.125', unit_price: '100.50' }], discount_amount: '2.25', tax_amount: '7.25' });
      const api = await create('parity-create', body, tokens.get(admin.id)); const id = api.body.data.id;
      await submit(id, 'parity-submit', tokens.get(admin.id));
      const websitePayload = await require('../src/services/sales-validation').buildInvoicePayload({ ...body,
        customer_name: 'Ignored', items_json: JSON.stringify(body.items) }, admin);
      const web = await runWithAuditUser(admin, () => store.createInvoice(websitePayload)); await store.submitInvoice(web);
      const addAllocation = async invoiceId => store.createJournalEntry({ journal_type: 'cash_receipt', posting_date: '2026-10-01',
        party_type: 'customer', party_id: 'C1', party_name: 'Changed Customer', reference_no: (await store.findInvoice(invoiceId)).invoice_no,
        lines: [{ account_id: cash, debit: 5, credit: 0 }, { account_id: ar, debit: 0, credit: 5 }] });
      await addAllocation(id); await addAllocation(web);
      const payment = receipt(bank, 'parity', { amount: '30.50' });
      assert.equal((await pay(id, 'parity-pay', payment, tokens.get(admin.id))).status, 201);
      const cookie = await auth.createSession(admin.id);
      const response = await fetch(base + `/invoices/${web}/payments`, { method: 'POST', redirect: 'manual',
        headers: { Cookie: `wm_session=${cookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payment_date: payment.payment_date, amount: payment.amount, account_id: String(bank), reference: 'website-reference' }) });
      assert.equal(response.status, 302);
      const summarize = async invoiceId => {
        const invoice = await store.findInvoice(invoiceId); const p = invoice.payments.find(row => row.payment_record_id);
        const gl = (await pool.query(`SELECT account_id,debit::text,credit::text FROM app_gl_entries
          WHERE (voucher_type='sales_invoice' AND voucher_id=$1) OR (voucher_type='payment_journal' AND voucher_id=$2)
          ORDER BY voucher_type,line_no`, [invoiceId, p.journal_entry_id])).rows;
        const stock = (await pool.query("SELECT qty_change::text,outgoing_rate::text FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [invoiceId])).rows;
        return { subtotal: invoice.subtotal, total: invoice.total, amount_paid: invoice.amount_paid, status: invoice.status,
          item: { quantity: invoice.items[0].quantity, rate: invoice.items[0].unit_price, total: invoice.items[0].line_total },
          payment: { amount: p.amount, method: p.method }, gl, stock };
      };
      assert.deepEqual(await summarize(id), await summarize(web));
      assert.equal((await summarize(id)).amount_paid, 36); assert.equal((await summarize(id)).payment.method, 'bank');
      const before = await snapshot();
      assert.equal((await pay(id, 'allocation-overpay', receipt(bank, 'allocation-overpay', { amount: '84' }), tokens.get(admin.id))).status, 422);
      assert.deepEqual(await snapshot(), before);
      // Website reference reuse remains allowed by its existing workflow.
      await store.addInvoicePayment(web, { payment_date: '2026-10-01', amount: 1, account_id: bank, reference: 'website-reference' });
      assert.equal((await store.findInvoice(web)).amount_paid, 37);
    });

    await t.test('payment reference protection survives key expiry and website cancellation without reposting', async () => {
      const body = receipt(cash, 'cancelled-reference');
      const first = await pay(main, 'cancelled-pay', body); assert.equal(first.status, 201);
      const payment = (await store.findInvoice(main)).payments.find(row => String(row.payment_record_id) === first.body.data.id);
      await store.cancelInvoicePayment(main, payment.id);
      await pool.query("UPDATE wm_api_idempotency SET expires_at=now()-interval '1 day' WHERE key='cancelled-pay'");
      const before = await snapshot();
      assert.deepEqual((await pay(main, 'after-cancel', body)).body, first.body);
      assert.equal((await pay(main, 'after-cancel-conflict', { ...body, amount: '11' })).status, 409);
      assert.deepEqual((await snapshot()).payments, before.payments);
      assert.deepEqual((await snapshot()).gl, before.gl);
      assert.equal((await pool.query('SELECT docstatus FROM app_invoice_payments WHERE id=$1', [first.body.data.id])).rows[0].docstatus, 'cancelled');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    clearInvoiceCaches();
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    await store.closeStore();
  }
});
