'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const store = require('../src/store');
const auth = require('../src/auth');
const { runWithAuditUser } = require('../src/audit');

test('browser invoice lists and payment routes enforce parent scopes before counts and pagination', {
  skip: process.env.API_TEST_POSTGRES !== '1',
}, async () => {
  let server;
  const pool = store.getPostgresPool();
  try {
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await store.initStore();
    await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group)
      VALUES ('RETAIL','Retail customer','Retail'),('WHOLESALE','Wholesale customer','Wholesale')`);
    const role = await auth.createRole('Browser sales reader', ['vouchers.sales.view']);
    const warehouseReader = await auth.createUser('warehouse-reader', 'Review password 123!',
      { role: role.slug, record_access: { warehouse: 'Allowed' } });
    const deniedReader = await auth.createUser('warehouse-denial', 'Review password 123!', { role: role.slug });
    await auth.saveUserPermissionOverrides(deniedReader.id, [], ['warehouse.view:Hidden']);
    const customerRole = await auth.createRole('Customer sales reader', ['vouchers.sales.view'],
      { customers: { mode: 'selected', values: ['Retail'] } });
    const customerReader = await auth.createUser('customer-reader', 'Review password 123!', { role: customerRole.slug });
    const standardReader = await auth.createUser('standard-reader', 'Review password 123!', { role: 'standard' });
    const admin = await auth.createUser('access-admin', 'Review password 123!', { role: 'admin' });
    const addInvoice = (number, warehouses, customer = 'RETAIL', owner = admin) => runWithAuditUser(owner, async () => {
      const id = (await pool.query(`INSERT INTO app_invoices(invoice_no,invoice_date,customer_id,customer_name,total,subtotal,docstatus)
        VALUES($1,'2026-01-01',$2,$2,150000,150000,'submitted') RETURNING id`, [number, customer])).rows[0].id;
      for (const [index, warehouse] of warehouses.entries()) await pool.query(`INSERT INTO app_invoice_items
        (invoice_pk,invoice_id,invoice_no,line_no,item_code,item_name,warehouse,quantity,unit_price,line_total)
        VALUES($1,$1,$2,$3,'TEST','Test item',$4,1,150000,150000)`, [id, number, index + 1, warehouse]);
      const payment = (await pool.query(`INSERT INTO app_invoice_payments(invoice_id,payment_no,payment_date,amount,method)
        VALUES($1,1,'2026-01-01',150000,'cash') RETURNING id`, [id])).rows[0].id;
      return { id: String(id), payment: String(payment) };
    });
    const allowed = await addInvoice('ACCESS-ALLOWED', ['Allowed']);
    const wholesale = await addInvoice('ACCESS-WHOLESALE', ['Allowed'], 'WHOLESALE');
    const owned = await addInvoice('ACCESS-OWNED', ['Allowed'], 'RETAIL', standardReader);
    const hidden = await addInvoice('ACCESS-HIDDEN', ['Hidden']);
    const mixed = await addInvoice('ACCESS-MIXED', ['Allowed', 'Hidden']);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    // Keep real authentication, authorization and route queries; inspect the
    // rendered data without depending on unrelated template presentation.
    app.use((_req, res, next) => { res.render = (view, data) => res.json({ view, ...data }); next(); });
    require('../src/auth-http').installAuth(app);
    app.use(require('../src/web/routes/sales'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
    const root = `http://127.0.0.1:${server.address().port}`;
    const sessions = new Map();
    for (const user of [warehouseReader, deniedReader, customerReader, standardReader, admin]) sessions.set(user.id, await auth.createSession(user.id));
    const request = (user, path) => fetch(root + path, { redirect: 'manual',
      headers: { Cookie: `wm_session=${sessions.get(user.id)}`, Accept: 'application/json' } });
    for (const user of [warehouseReader, deniedReader]) {
      const page = await request(user, '/invoices?exact_total=1&page_size=1');
      assert.equal(page.status, 200);
      const data = await page.json();
      assert.equal(data.pagination.total, 3);
      assert.deepEqual(data.invoices.map(row => String(row.id)), [owned.id]);
      const second = await (await request(user, '/invoices?exact_total=1&page_size=1&page=2')).json();
      assert.deepEqual(second.invoices.map(row => String(row.id)), [wholesale.id]);
      const forbiddenFilter = await (await request(user, '/invoices?warehouse=Hidden&exact_total=1')).json();
      assert.equal(forbiddenFilter.pagination.total, 0);
      assert.deepEqual(forbiddenFilter.invoices, []);
      for (const invoice of [hidden, mixed]) for (const path of [`/invoices/${invoice.id}`,
        `/invoices/payments/${invoice.payment}`, `/invoices/payments/${invoice.payment}/drawer`]) {
        assert.equal((await request(user, path)).status, 403, path);
      }
      assert.equal((await request(user, `/invoices/payments/${allowed.payment}`)).status, 302);
      assert.equal((await request(user, `/invoices/payments/${allowed.payment}/drawer`)).status, 200);
    }
    for (const path of [`/invoices/${wholesale.id}`, `/invoices/payments/${wholesale.payment}`,
      `/invoices/payments/${wholesale.payment}/drawer`]) assert.equal((await request(customerReader, path)).status, 403);
    assert.equal((await request(customerReader, `/invoices/payments/${allowed.payment}/drawer`)).status, 200);
    assert.equal((await request(standardReader, `/invoices/payments/${allowed.payment}/drawer`)).status, 403);
    assert.equal((await request(standardReader, `/invoices/payments/${owned.payment}/drawer`)).status, 200);
    assert.equal((await request(admin, `/invoices/payments/${hidden.payment}/drawer`)).status, 200);
    assert.equal((await (await request(admin, '/invoices?exact_total=1')).json()).pagination.total, 5);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await store.closeStore();
  }
});
