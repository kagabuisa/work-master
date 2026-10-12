'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draft, createDailyActivity, dailyActivityFormOptions } = require('../src/web/daily-activity-create');
const { permissionCheck } = require('../src/authorize');
const { renderView } = require('./helpers/render-view');
const input = { date: '2026-10-12', shop: 'Main', warehouse: 'Main Warehouse', unit_type: 'Shop',
  sales: '200', expense: '25', expense_details: 'Fuel', packages_received: '2', delivery_differences: 'No' };

test('new daily activity validates required fields and whitelists draft fields', () => {
  const doc = draft({ ...input, docstatus: '1', name: 'fake', sales_invoiced: '999' });
  assert.equal(doc.docstatus, 0);
  assert.equal(doc.banked, 175);
  assert.equal(doc.shop, 'Main');
  assert.equal(doc.expense_details, 'Fuel');
  assert.equal(doc.name, undefined);
  assert.equal(doc.sales_invoiced, undefined);
  for (const invalid of [{ date: '2026-02-30' }, { shop: '' }, { warehouse: '' }, { unit_type: 'invalid' },
    { sales: '-1' }, { expense: 'NaN' }, { packages_received: '1.5' }, { expense_details: '' },
    { delivery_differences: 'invalid' }, { unit_type: 'Field Sales(FiSa)', leads: '' }, { shop: ['Main'] }]) {
    assert.throws(() => draft({ ...input, ...invalid }), { status: 400 });
  }
});

test('daily activity creation requires Read and Create and is denied to Standard', () => {
  const check = (role, permissions, method, route) => permissionCheck({ currentUser: { role, permissions }, method, path: route });
  const grants = ['reports.daily-activity.view', 'reports.daily-activity.create'];
  for (const [method, route] of [['GET', '/reports/daily-activity/new'], ['POST', '/reports/daily-activity']]) {
    assert.equal(check('privileged', [grants[0]], method, route), false);
    assert.equal(check('privileged', [grants[1]], method, route), false);
    assert.equal(check('privileged', grants, method, route), true);
    assert.equal(check('standard', grants, method, route), false);
    assert.equal(check('admin', [], method, route), true);
  }
  assert.equal(check('admin', [], 'DELETE', '/reports/daily-activity/new'), false);
  assert.equal(check('admin', [], 'POST', '/reports/daily-activity/DAR-1'), false);
});

test('new daily activity form renders required fields and preserves rejected input safely', async () => {
  const html = await renderView(path.resolve(__dirname, '../views/daily-activity-form.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true, availableReports: [],
    record: { ...input, expense_details: '<script>bad</script>' }, options: { shops: ['Main'], warehouses: ['Main Warehouse'] },
    error: 'Check required fields', unitTypes: ['Shop', 'Field Sales(FiSa)'], deliveryOptions: ['No'],
  });
  assert.match(html, /action="\/reports\/daily-activity"/);
  assert.match(html, /Save draft/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /Check required fields/);
});

test('local Daily Activity saves and reports audited drafts without ERPNext', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { localDailyActivityReport, localDailyActivityVoucher } = require('../src/web/local-daily-activity');
  const pool = store.getPostgresPool();
  const originalFetch = global.fetch;
  global.fetch = async () => { assert.fail('Local Daily Activity must never contact ERPNext'); };
  const user = { role: 'admin', id: 42, username: 'Daily Activity Creator' };
  try {
    const db = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(db, /_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await store.initStore();
    await pool.query("INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES('Main','Main'),('Other','Other')");
    await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES('Main Warehouse'),('Other Warehouse')");
    const options = await dailyActivityFormOptions(user);
    assert.ok(options.shops.includes('Main'));
    assert.ok(options.warehouses.includes('Main Warehouse'));
    const [first, second] = await Promise.all([createDailyActivity(input, user), createDailyActivity(input, user)]);
    assert.notEqual(first.name, second.name);
    assert.equal(first.created_by_user_id, '42');
    assert.equal(first.created_by, user.username);
    assert.equal(first.docstatus, 0);
    assert.equal(Number(first.banked), 175);
    const voucher = await localDailyActivityVoucher(first.name, user);
    assert.equal(voucher.expense_details, 'Fuel');
    let report = await localDailyActivityReport({ from: input.date, to: input.date }, user);
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.sales, 400);
    assert.equal(report.summary.banked, 350);
    report = await localDailyActivityReport({ from: input.date, to: input.date, q: first.name, status: '0' }, user);
    assert.equal(report.summary.total, 1);
    await assert.rejects(() => createDailyActivity({ ...input, warehouse: 'missing' }, user), { status: 400 });
    await assert.rejects(() => createDailyActivity({ ...input, shop: 'missing' }, user), { status: 400 });
    await assert.rejects(() => createDailyActivity({ ...input, stock_entry_number: 'missing' }, user), { status: 400 });
    const restricted = { role: 'finance', record_access: { cost_center: 'Other' },
      scopes: { warehouses: { mode: 'selected', values: ['Other Warehouse'] } } };
    await assert.rejects(() => createDailyActivity(input, restricted), { status: 403 });
    assert.equal(await localDailyActivityVoucher(first.name, restricted), null);
    assert.equal((await localDailyActivityReport({ from: input.date, to: input.date }, restricted)).summary.total, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM app_daily_activity_reports')).rows[0].total, 2);

    const express = require('express');
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../views'));
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { req.currentUser = user; Object.assign(res.locals, { assetVersion: 'test',
      currentUser: user, can: () => true, availableReports: [], formatDate: value => value,
      dateTimeSettings: { date_format: 'YYYY-MM-DD', time_format: 'HH:mm' }, formatTimestamp: value => String(value) }); next(); });
    app.use('/reports', require('../src/web/routes/reports'));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      // Restore native fetch for localhost HTTP; API calls remain unnecessary.
      global.fetch = originalFetch;
      const form = await fetch(base + '/reports/daily-activity/new');
      assert.equal(form.status, 200);
      assert.match(await form.text(), /Save draft/);
      const save = await fetch(base + '/reports/daily-activity', { method: 'POST',
        body: new URLSearchParams(input), redirect: 'manual' });
      assert.equal(save.status, 303);
      assert.match(save.headers.get('location'), /^\/reports\/daily-activity\/DAR-\d+$/);
      const invalid = await fetch(base + '/reports/daily-activity', { method: 'POST',
        body: new URLSearchParams({ ...input, expense_details: '' }) });
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /Expense details is required/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { global.fetch = originalFetch; await store.closeStore(); }
});
