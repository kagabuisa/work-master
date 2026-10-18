'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readQuery, dates } = require('../src/api/query');
const { decimal, payment, invoice, company } = require('../src/api/serializers');

test('read contract bounds queries and preserves decimal text and stable legacy identities', () => {
  const { requireLookup } = require('../src/api/policy');
  const creator = { kind: 'mobile', user: { role: 'custom', permissions: ['vouchers.sales.create'] } };
  for (const lookup of ['customers', 'master-items', 'warehouses', 'price-lists', 'cost-centers']) {
    requireLookup(creator, 'masters:read', lookup);
  }
  assert.throws(() => requireLookup({ ...creator, kind: 'integration', scopes: ['invoices:read'] }, 'masters:read', 'customers'), /cannot read/);
  assert.deepEqual(readQuery({}), { page: 1, page_size: 50, search: '' });
  for (const query of [{ page: '0' }, { page_size: '201' }, { page: '1.5' }, { page: '1000001' },
    { q: ['a', 'b'] }, { extra: 'ignored' }, { q: 'x'.repeat(201) }]) assert.throws(() => readQuery(query), /query|integer/);
  assert.throws(() => dates({ from: '2026-02-30' }), /valid/);
  assert.throws(() => dates({ from: '2026-02-02', to: '2026-01-01' }), /follow/);
  assert.equal(decimal('9007199254740993.125'), '9007199254740993.125');
  assert.equal(decimal(1e-7), '0.0000001');
  assert.equal(payment({ id: 1, method: 'legacy', amount: 10 }, 7).id, 'legacy-7');
});

test('invoice display fields match the website without exposing internal identities or company audit', () => {
  const audit = { created_by: 'Operator', created_at: new Date('2026-10-13T08:00:00Z'),
    updated_by: 'Reviewer', updated_at: '2026-10-13T09:00:00Z', created_by_user_id: 'private-id' };
  const detail = invoice({ ...audit, id: 7, customer_phone: '+256700123456', is_cash_sale: true,
    submitted_by: 'Reviewer', submitted_at: '2026-10-13T09:00:00Z',
    items: [{ ...audit, item_code: 'I1', item_name: 'Item', cost_amount: 999 }] }, true);
  assert.equal(detail.customer_phone, '+256700123456'); assert.equal(detail.is_cash_sale, true);
  assert.equal(detail.created_by, 'Operator'); assert.equal(detail.submitted_by, 'Reviewer');
  assert.equal(detail.items[0].created_at, '2026-10-13T08:00:00.000Z');
  assert.equal('created_by_user_id' in detail, false); assert.equal('created_by_user_id' in detail.items[0], false);
  assert.equal('cost_amount' in detail.items[0], false);
  const receipt = payment({ ...audit, payment_record_id: 4, account_name: 'Cash', notes: 'Receipt notes' }, 7);
  assert.equal(receipt.account_name, 'Cash'); assert.equal(receipt.notes, 'Receipt notes');
  assert.equal('created_by_user_id' in receipt, false);
  const displayedCompany = company({ name: 'Example Company', address: 'Kampala', tax_id: 'TIN', ...audit, private_key: 'secret' });
  assert.equal(displayedCompany.name, 'Example Company'); assert.equal('created_by' in displayedCompany, false);
  assert.equal('private_key' in displayedCompany, false);
  assert.equal('customer_phone' in invoice({ id: 7 }), false);
});

test('versioned reads isolate master data, stock, invoices, receipts and sales selectors', {
  skip: process.env.API_TEST_POSTGRES !== '1', timeout: 120000,
}, async t => {
  const express = require('express');
  const crypto = require('node:crypto');
  const store = require('../src/store');
  const auth = require('../src/auth');
  const apiAuth = require('../src/api/auth');
  const { runWithAuditUser } = require('../src/audit');
  const { resetGoldenSchema } = require('./helpers/golden-seed');
  const { apiContext, apiErrors } = require('../src/api/errors');
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let server;
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    await store.saveCompanyInformation({ name: 'API Invoice Company', phone: '+256700111222' });
    await store.saveDateTimeSettings({ date_format: 'DD/MM/YYYY', time_format: '12h' });
    const admin = await auth.createUser('reads-admin', 'ReadsPassword123!', { role: 'admin' });
    const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
    const bank = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1120'")).rows[0].id;
    const ar = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1100'")).rows[0].id;
    const permissions = ['vouchers.sales.view', 'vouchers.sales.create', 'payments.sales.record',
      'masters.customers.view', 'masters.suppliers.view', 'masters.items.view', 'masters.warehouses.view',
      'masters.price-lists.view', 'masters.cost-centers.view'];
    const role = await auth.createRole('API Read Tester', permissions, {
      customers: { mode: 'selected', values: ['retail'] }, suppliers: { mode: 'selected', values: ['local'] },
      warehouses: { mode: 'selected', values: ['Main'] }, invoicePriceLists: { mode: 'selected', values: ['Retail'] },
      accounts: { mode: 'selected', values: [String(cash)] },
    });
    const reader = await auth.createUser('reads-user', 'ReadsPassword123!', { role: role.slug,
      record_access: { employee_id: 'E1', cost_center: 'CC1' } });
    const standard = await auth.createUser('reads-standard', 'ReadsPassword123!', { role: 'standard' });
    const noAccessRole = await auth.createRole('API No Read', []);
    const noAccess = await auth.createUser('reads-none', 'ReadsPassword123!', { role: noAccessRole.slug });
    await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,disabled,docstatus)
      VALUES ('C1','Alpha Customer','Retail',false,'submitted'),('C2','Beta Customer','Retail',false,'submitted'),
        ('C3','Secret Customer','Wholesale',false,'submitted'),('C4','Disabled Customer','Retail',true,'submitted');
      INSERT INTO app_master_suppliers(supplier_id,supplier_name,supplier_type,docstatus)
      VALUES ('S1','Local Supplier','Local','submitted'),('S2','Secret Supplier','Foreign','submitted');
      INSERT INTO app_master_warehouses(warehouse,is_group,disabled,docstatus) VALUES
        ('Main',false,false,'submitted'),('Secret',false,false,'submitted'),('Group',true,false,'submitted'),('Inactive',false,true,'submitted');
      INSERT INTO app_master_items(item_code,item_name,stock_uom,unit_cost,exporter,description,docstatus) VALUES
        ('I1','Alpha Item','Each',987654,'secret-exporter','Public description','submitted'),
        ('I2','Beta Item','Each',123456,'hidden-exporter','Second description','submitted');
      UPDATE app_master_items SET default_rate=125 WHERE item_code='I2';
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active,docstatus) VALUES
        ('Retail','UGX','selling',1,'submitted'),('Wholesale','UGX','both',1,'submitted'),
        ('Dollar','USD','selling',1,'submitted'),('Buying','UGX','buying',1,'submitted'),('Inactive','UGX','selling',0,'submitted');
      INSERT INTO app_master_item_prices(item_code,price_list,price_list_rate,active) VALUES ('I1','Retail',175,1);
      INSERT INTO app_master_employees(employee_id,employee_name,status,disabled,email,phone) VALUES
        ('E1','Permitted Invoicer','Active',false,'private-email@example.test','private-phone'),
        ('E2','Other Invoicer','Active',false,'secret-email@example.test','secret-phone'),('E3','Left Invoicer','Left',true,NULL,NULL);
      INSERT INTO app_master_cost_centers(cost_center,cost_center_name,is_group,disabled) VALUES
        ('CC1','Allowed Cost Center',false,false),('CC2','Other Cost Center',false,false),('CC3','Group Cost Center',true,false);
      INSERT INTO app_stock_balances(item_code,item_name,warehouse,quantity,valuation_rate,stock_value) VALUES
        ('I1','Alpha Item','Main',12.125,20,242.5),('I2','Beta Item','Main',5,30,150),('I1','Alpha Item','Secret',99,20,1980);
    `);
    // Seed matching history so stock exists before the invoices' posting time.
    await pool.query(`INSERT INTO app_stock_ledger
      (posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,voucher_no,
       qty_change,qty_after_transaction,incoming_rate,stock_value_change,stock_value_after_transaction)
      SELECT '2026-09-30',item_code,item_name,warehouse,'stock_opening',0,'READ-OPENING',
        quantity,quantity,valuation_rate,stock_value,stock_value FROM app_stock_balances`);
    const payload = (customer = 'C1', warehouse = 'Main', priceList = 'Retail') => ({
      invoice_date: '2026-10-01', customer_id: customer, customer_name: customer === 'C3' ? 'Secret Customer' : 'Alpha Customer',
      price_list: priceList, invoicer_id: 'E1', invoicer: 'Permitted Invoicer',
      items: [{ item_code: 'I1', item_name: 'Alpha Item', warehouse, quantity: 1, unit_price: 100 }],
    });
    const permitted = await runWithAuditUser(standard, () => store.createInvoice(payload()));
    await store.submitInvoice(permitted);
    await store.addInvoicePayment(permitted, { payment_date: '2026-10-01', amount: 10, account_id: cash });
    await store.addInvoicePayment(permitted, { payment_date: '2026-10-01', amount: 20, account_id: bank });
    const draft = await store.createInvoice(payload('C2'));
    const blockedCustomer = await store.createInvoice(payload('C3'));
    const blockedWarehouse = await store.createInvoice(payload('C1', 'Secret'));
    const blockedPrice = await store.createInvoice(payload('C1', 'Main', 'Wholesale'));
    const mixed = await store.createInvoice({ ...payload(), items: [...payload().items, ...payload('C1', 'Secret').items] });
    const otherOwner = await runWithAuditUser(admin, () => store.createInvoice({ ...payload(), invoicer_id: 'E2' }));
    const app = express();
    app.use('/api/v1', apiContext); app.use(express.json()); app.use('/api/v1', require('../src/api/router')); app.use(apiErrors);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = new Map();
    for (const user of [admin, reader, standard, noAccess]) {
      const response = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: 'ReadsPassword123!' }) });
      assert.equal(response.status, 200); tokens.set(user.username, (await response.json()).data.access_token);
    }
    const get = async (path, user = reader) => {
      const response = await fetch(base + path, { headers: { Authorization: `Bearer ${tokens.get(user.username)}` } });
      const body = await response.json();
      require('./helpers/api-contract').validateRead(path, response.status, body);
      return { status: response.status, body, headers: response.headers };
    };

    await t.test('master scope and active records are filtered before pagination and counts', async () => {
      const first = await get('/customers?page_size=1');
      assert.equal(first.status, 200); assert.deepEqual(first.body.meta, { page: 1, page_size: 1, total: 2 });
      assert.equal(first.body.data[0].id, 'C1');
      assert.equal((await get('/customers?page=2&page_size=1')).body.data[0].id, 'C2');
      assert.equal((await get('/customers?q=Secret')).body.meta.total, 0);
      assert.deepEqual((await get('/suppliers')).body.data.map(row => row.id), ['S1']);
      assert.deepEqual((await get('/warehouses')).body.data.map(row => row.id), ['Main']);
      assert.deepEqual((await get('/price-lists')).body.data.map(row => row.id), ['Retail']);
      assert.deepEqual((await get('/cost-centers')).body.data.map(row => row.id), ['CC1']);
      for (const path of ['/customers', '/suppliers', '/items', '/warehouses', '/price-lists', '/cost-centers', '/stock-balances?warehouse=Main', '/invoices']) {
        assert.equal((await get(path, noAccess)).status, 403, path);
      }
    });

    await t.test('item and invoicer search cannot infer hidden costs or private employee fields', async () => {
      const items = await get('/items');
      assert.equal(items.body.meta.total, 2);
      assert.equal('unit_cost' in items.body.data[0], false);
      assert.equal('unit_price' in items.body.data[0], false);
      assert.equal((await get('/items?q=987654')).body.meta.total, 0);
      assert.equal((await get('/items?q=secret-exporter')).body.meta.total, 0);
      const priced = await get('/items?price_list=Retail');
      assert.equal(priced.status, 200);
      assert.equal(priced.body.data.find(row => row.id === 'I1').unit_price, '175');
      assert.equal(priced.body.data.find(row => row.id === 'I1').has_list_price, true);
      assert.equal(priced.body.data.find(row => row.id === 'I2').unit_price, '125');
      assert.equal(priced.body.data.find(row => row.id === 'I2').has_list_price, false);
      assert.equal((await get('/items?price_list=Wholesale')).status, 403);
      assert.equal((await get('/items?price_list=Inactive', admin)).status, 422);
      const inStock = await get('/items?warehouse=Main&price_list=Retail&page_size=1');
      assert.equal(inStock.status,200); assert.equal(inStock.body.meta.total,2);
      assert.equal(inStock.body.data[0].stock_balance,'11.125'); assert.equal(inStock.body.data[0].warehouse,'Main');
      assert.equal('valuation_rate' in inStock.body.data[0],false);
      assert.equal((await get('/items?warehouse=Secret&price_list=Retail')).status,403);
      await pool.query("UPDATE app_stock_balances SET quantity=0 WHERE item_code='I2' AND warehouse='Main'");
      assert.equal((await get('/items?warehouse=Main&price_list=Retail')).body.meta.total,1);
      assert.equal((await get('/items?warehouse=Main&price_list=Retail&q=Beta')).body.meta.total,0);
      await pool.query("UPDATE app_stock_balances SET quantity=5 WHERE item_code='I2' AND warehouse='Main'");
      const options = await get('/sales-options?purpose=invoicing');
      assert.deepEqual(options.body.data.invoicers.map(row => row.id), ['E1']);
      assert.equal('email' in options.body.data.invoicers[0], false);
      assert.equal((await get('/sales-options?purpose=invoicing&q=private-email')).body.meta.total, 0);
      assert.equal((await get('/sales-options?purpose=invoicing&q=private-phone')).body.meta.total, 0);
      const accounts = await get('/sales-options?purpose=payments');
      assert.deepEqual(accounts.body.data.receiving_accounts.map(row => row.id), [String(cash)]);
      assert.equal((await get('/sales-options?purpose=payments', noAccess)).status, 403);
    });

    await t.test('stock filters stay within the required permitted warehouse and return decimal strings', async () => {
      const stocks = await get('/stock-balances?warehouse=Main&item_code=I1');
      assert.equal(stocks.status, 200); assert.equal(stocks.body.meta.total, 1);
      assert.equal(stocks.body.data[0].quantity, '11.125');
      assert.equal(typeof stocks.body.data[0].stock_value, 'string');
      assert.equal((await get('/stock-balances?warehouse=Secret')).status, 403);
      assert.equal((await get('/stock-balances')).status, 400);
      assert.equal((await get('/stock-balances?warehouse=Main&item_code=unknown')).body.meta.total, 0);
      assert.equal((await get('/stock-balances?warehouse=Main&page_size=1')).body.meta.total, 2);
    });

    await t.test('invoice counts and pages enforce customer, every line warehouse, price list and current permissions', async () => {
      const invoices = await get('/invoices?page_size=1&sort=id_asc');
      assert.equal(invoices.status, 200); assert.equal(invoices.body.meta.total, 3);
      assert.equal(invoices.body.data[0].id, String(permitted));
      assert.equal((await get('/invoices?page=2&page_size=1&sort=id_asc')).body.data[0].id, String(draft));
      assert.equal((await get('/invoices?q=Secret')).body.meta.total, 0);
      assert.equal((await get('/invoices?docstatus=submitted')).body.meta.total, 1);
      assert.equal((await get('/invoices?payment_status=partial&page_size=1')).body.meta.total, 1);
      assert.equal((await get('/invoices?payment_status=partial')).body.data[0].id, String(permitted));
      assert.equal((await get('/invoices?payment_status=unpaid')).body.meta.total, 2);
      assert.equal((await get('/invoices?payment_status=paid')).body.meta.total, 0);
      assert.equal((await get('/invoices?payment_status=unpaid&docstatus=submitted')).body.meta.total, 0);
      assert.equal((await get('/invoices?customer_id=C3')).body.meta.total, 0);
      assert.equal((await get('/invoices?warehouse=Secret')).status, 403);
      for (const id of [blockedCustomer, blockedWarehouse, blockedPrice, mixed, 999999]) {
        assert.equal((await get('/invoices/' + id)).status, 404);
        assert.equal((await get(`/invoices/${id}/payments`)).status, 404);
      }
      const detail = await get('/invoices/' + permitted);
      assert.equal(detail.body.data.total, '100'); assert.equal(detail.body.data.amount_paid, '30');
      assert.equal(detail.body.data.balance_due, '70');
      assert.equal(detail.body.data.items[0].quantity, '1');
      assert.equal(detail.body.data.company.name, 'API Invoice Company');
      assert.deepEqual(detail.body.data.display_settings, { date_format: 'DD/MM/YYYY', time_format: '12h' });
      assert.equal('created_by_user_id' in detail.body.data.company, false);
      assert.equal(detail.body.data.created_by, 'reads-standard');
      assert.equal(detail.body.data.items[0].created_by, 'reads-standard');
      assert.equal(typeof detail.body.data.customer_phone, 'string');
      assert.equal('created_by_user_id' in detail.body.data, false);
      assert.equal('cost_amount' in detail.body.data.items[0], false);
      assert.equal('payments' in detail.body.data, false);
      await pool.query('UPDATE app_users SET permission_denials=$1::jsonb WHERE id=$2', [JSON.stringify(['invoice.price-list.view:Retail']), reader.id]);
      assert.equal((await get('/invoices')).body.meta.total, 0);
      assert.equal((await get('/invoices/' + permitted)).status, 404);
      await pool.query("UPDATE app_users SET permission_denials='[]'::jsonb WHERE id=$1", [reader.id]);
    });

    await t.test('Standard ownership and assigned-invoicer exception agree across lists and details', async () => {
      assert.deepEqual((await get('/invoices', standard)).body.data.map(row => row.id), [String(permitted)]);
      assert.equal((await get('/invoices/' + otherOwner, standard)).status, 404);
      await pool.query('UPDATE app_users SET record_access=$1::jsonb WHERE id=$2', [JSON.stringify({ employee_id: 'E1' }), standard.id]);
      const result = await get('/invoices', standard);
      assert(result.body.data.some(row => row.id === String(draft)));
      assert.equal((await get('/invoices/' + draft, standard)).status, 200);
      assert.equal((await get('/invoices/' + otherOwner, standard)).status, 404);
    });

    await t.test('receipts inherit parent access and receiving-account restrictions before counts', async () => {
      const payments = await get(`/invoices/${permitted}/payments?page_size=1`);
      assert.equal(payments.status, 200); assert.equal(payments.body.meta.total, 1);
      assert.equal(typeof payments.body.data[0].account_name, 'string');
      assert.equal(typeof payments.body.data[0].notes, 'string');
      assert.equal('created_by_user_id' in payments.body.data[0], false);
      assert.equal(payments.body.data[0].amount, '10'); assert.equal(payments.body.data[0].account_id, String(cash));
      const hiddenReference = (await store.findInvoice(permitted)).payments.find(row => row.account_id === Number(bank)).reference;
      assert.equal((await get(`/invoices/${permitted}/payments?q=${encodeURIComponent(hiddenReference)}`)).body.meta.total, 0);
      const all = await get(`/invoices/${permitted}/payments`, admin);
      assert.equal(all.body.meta.total, 2);
      assert.equal((await get(`/invoices/${blockedWarehouse}/payments`)).status, 404);
      assert.equal((await get(`/invoices/${draft}/payments`)).body.meta.total, 0);
      // A journal allocation already supported by the app must be represented as
      // a distinct read source, without changing its allocation/posting rules.
      await store.createJournalEntry({ journal_type: 'cash_receipt', posting_date: '2026-10-01',
        party_type: 'customer', party_id: 'C1', party_name: 'Alpha Customer', reference_no: (await store.findInvoice(permitted)).invoice_no,
        lines: [{ account_id: cash, debit: 5, credit: 0 }, { account_id: ar, debit: 0, credit: 5 }] });
      const adminPayments = await get(`/invoices/${permitted}/payments`, admin);
      assert(adminPayments.body.data.some(row => row.source === 'journal_allocation' && row.id.startsWith('journal-')));
      assert.equal((await get(`/invoices/${permitted}/payments`)).body.meta.total, 1);
      const detail = (await get('/invoices/' + permitted)).body.data;
      const listed = (await get('/invoices')).body.data.find(row => row.id === String(permitted));
      assert.equal(detail.amount_paid, '35'); assert.equal(listed.amount_paid, detail.amount_paid);
      // Header totals retain the website's authorized invoice view; hiding an
      // account's individual receipts must not recalculate financial state.
      assert.equal(detail.balance_due, '65');
    });

    await t.test('integration scopes and account permissions both narrow reads, including selectors', async () => {
      const adminActor = await apiAuth.resolveBearer(tokens.get(admin.username), crypto.randomUUID());
      const service = await runWithAuditUser(admin, () => apiAuth.createIntegration(adminActor, 'reads-service', role.slug, ['masters:read']));
      tokens.set('reads-service', service.token); const serviceUser = { username: 'reads-service' };
      assert.equal((await get('/customers', serviceUser)).status, 200);
      assert.equal((await get('/invoices', serviceUser)).status, 403);
      assert.equal((await get('/stock-balances?warehouse=Main', serviceUser)).status, 403);
      assert.equal((await get('/sales-options?purpose=invoicing', serviceUser)).status, 403);
      const next = await runWithAuditUser(admin, () => apiAuth.rotateCredential(adminActor, service.user_id, ['invoices:read', 'stock:read', 'invoices:create', 'payments:record']));
      tokens.set(serviceUser.username, next.token);
      assert.equal((await get('/invoices', serviceUser)).body.meta.total, 3);
      assert.equal((await get('/invoices/' + blockedWarehouse, serviceUser)).status, 404);
      assert.equal((await get('/stock-balances?warehouse=Main', serviceUser)).status, 200);
      assert.equal((await get('/sales-options?purpose=invoicing', serviceUser)).status, 200);
      assert.equal((await get('/sales-options?purpose=payments', serviceUser)).status, 200);
      await pool.query('UPDATE app_users SET permission_denials=$1::jsonb WHERE id=$2', [JSON.stringify(['vouchers.sales.view']), service.user_id]);
      assert.equal((await get('/invoices', serviceUser)).status, 403);
    });

    await t.test('malformed queries fail explicitly and reads leave financial rows unchanged', async () => {
      for (const path of ['/items?includeDisabled=true', '/items?page_size=201', '/items?page=1&page=2',
        '/items?q[a]=b', '/invoices?sort=total;DROP', '/invoices?docstatus=anything', '/invoices?payment_status=anything', '/invoices?from=2026-02-30',
        '/invoices?from=2026-10-02&to=2026-10-01', `/invoices/${permitted}?q=anything`, '/sales-options']) {
        assert.equal((await get(path)).status, 400, path);
      }
      const snapshot = async () => (await pool.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM app_invoices i) AS invoices,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app_invoice_payments p) AS payments,
        (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM app_journal_entries j) AS journals,
        (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM app_gl_entries g) AS ledger`)).rows[0];
      const before = await snapshot();
      await get('/invoices'); await get('/invoices/' + permitted); await get(`/invoices/${permitted}/payments`);
      await get('/items?price_list=Retail'); await get('/stock-balances?warehouse=Main');
      assert.deepEqual(await snapshot(), before);
      assert((await pool.query("SELECT 1 FROM wm_api_audit WHERE operation='invoice.read' AND resource_id=$1", [String(permitted)])).rowCount);
    });
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    await store.closeStore();
  }
});
