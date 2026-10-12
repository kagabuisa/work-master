'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { pool } = require('../src/db');
const { normalizeFilters, voucherLink, dailyActivityReport, dailyActivityVoucher } = require('../src/web/daily-activity');
const { permissionCheck } = require('../src/authorize');

const sourceKeys = ['DB_HOST', 'DB_USER', 'DB_NAME', 'ERPNEXT_URL', 'ERPNEXT_USERNAME', 'ERPNEXT_PASSWORD'];
let originalEnv;
test.beforeEach(() => {
  originalEnv = sourceKeys.map((key) => process.env[key]);
  sourceKeys.forEach((key) => { process.env[key] = 'test-source'; });
  delete process.env.ERPNEXT_URL;
});
test.afterEach(() => {
  sourceKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
});

test('daily activity filters use a valid date range and ERPNext voucher status', () => {
  const filters = normalizeFilters({ from: '2026-10-01', to: '2026-10-04', shop: 'Kampala', status: '1', page: '2' });
  assert.deepEqual([filters.from, filters.to, filters.shop, filters.status, filters.page],
    ['2026-10-01', '2026-10-04', 'Kampala', '1', 2]);
  assert.throws(() => normalizeFilters({ from: '2026-10-05', to: '2026-10-04' }), /From date/);
  assert.equal(normalizeFilters({ status: 'invalid' }).status, '');
});

test('daily activity links to the ERPNext voucher and requires report permission', () => {
  assert.equal(voucherLink({ name: 'DAR-000012' }), '/reports/daily-activity/DAR-000012');
  const allowed = (role, permissions, path) => permissionCheck({ path, method: 'GET',
    currentUser: { role, permissions } });
  assert.equal(allowed('standard', [], '/reports/daily-activity'), false);
  assert.equal(allowed('standard', ['reports.daily-activity.view'], '/reports/daily-activity/DAR-000012'), false);
  assert.equal(allowed('privileged', ['reports.daily-activity.view'], '/reports/daily-activity/DAR-000012'), true);
});

test('daily activity queries the ERPNext voucher table with parameterized filters', async () => {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    if (calls.length === 1) return [[{ total: 1, sales: 200, expense: 25, banked: 175 }]];
    return [[{ name: 'DAR-000012', date: '2026-10-04', shop: 'Main', sales: 200,
      expense: 25, banked: 175, docstatus: 1 }]];
  };
  try {
    const report = await dailyActivityReport({ from: '2026-10-04', to: '2026-10-04', shop: 'Main', status: '1' });
    assert.match(calls[1].sql, /FROM `tabDaily Activity Report`/);
    assert.deepEqual(calls[1].values, ['2026-10-04', '2026-10-04', 1, '%Main%', 50, 0]);
    assert.equal(report.rows[0].href, '/reports/daily-activity/DAR-000012');
    assert.equal(report.summary.banked, 175);
  } finally { pool.query = original; }
});

test('daily activity voucher lookup uses its ERPNext name', async () => {
  const original = pool.query;
  pool.query = async (_sql, values) => {
    assert.deepEqual(values, ['DAR-000012']);
    return [[{ name: 'DAR-000012', docstatus: 1 }]];
  };
  try {
    assert.equal((await dailyActivityVoucher('DAR-000012')).status_label, 'Submitted');
    assert.equal(await dailyActivityVoucher('../bad'), null);
  } finally { pool.query = original; }
});

test('daily activity report and voucher render ERPNext fields', async () => {
  const shared = { assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], formatDate: (value) => value, money: (value) => `Ugx ${value}` };
  const html = await renderView(path.join(__dirname, '..', 'views', 'daily-activity.ejs'), {
    ...shared, query: {},
    report: { filters: { from: '2026-10-04', to: '2026-10-04', shop: '', status: '', search: '' },
      summary: { total: 1, sales: 200, expense: 25, banked: 175 },
      rows: [{ name: 'DAR-000012', href: '/reports/daily-activity/DAR-000012', date: '2026-10-04',
        shop: 'Main', sales: 200, expense: 25, expense_details: 'Fuel', packages_received: 2,
        status_label: 'Submitted' }],
      pagination: { page: 1, limit: 50, total: 1, total_pages: 1, offset: 0, start: 1, end: 1 } },
  });
  assert.match(html, /href="\/reports\/daily-activity\/DAR-000012">DAR-000012/);
  assert.match(html, /Fuel/);
  const voucher = await renderView(path.join(__dirname, '..', 'views', 'daily-activity-voucher.ejs'), {
    ...shared, voucher: { name: 'DAR-000012', date: '2026-10-04', shop: 'Main', status_label: 'Submitted',
      sales: 200, expense: 25, banked: 175, expense_details: 'Fuel', packages_received: 2,
      delivery_differences: 'No', comments_or_remarks: 'Closed early' },
  });
  assert.match(voucher, /Stock delivery report/);
  assert.match(voucher, /Closed early/);
});


test('daily activity rejects missing source settings without querying localhost', async () => {
  delete process.env.DB_HOST;
  const original = pool.query;
  pool.query = async () => { assert.fail('must not query an unconfigured source'); };
  try {
    for (const operation of [() => dailyActivityReport(), () => dailyActivityVoucher('DAR-000012')]) {
      await assert.rejects(operation, { status: 503, code: 'DAILY_ACTIVITY_SOURCE_UNAVAILABLE' });
    }
  } finally { pool.query = original; }
});

test('daily activity translates source failures but preserves unexpected errors', async () => {
  const original = pool.query;
  try {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR', 'ER_NO_SUCH_TABLE']) {
      const cause = Object.assign(new Error('private database detail'), { code });
      pool.query = async () => { throw cause; };
      for (const operation of [() => dailyActivityReport(), () => dailyActivityVoucher('DAR-000012')]) {
        await assert.rejects(operation, (error) => error.status === 503 && error.cause === cause
          && !error.message.includes('private database detail'));
      }
    }
    const unexpected = new Error('unexpected bug');
    pool.query = async () => { throw unexpected; };
    await assert.rejects(() => dailyActivityReport(), (error) => error === unexpected);
  } finally { pool.query = original; }
});

test('daily activity routes render a helpful 503 for an unconfigured source', async () => {
  delete process.env.DB_HOST;
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.assetVersion = 'test';
  app.use('/reports', require('../src/web/routes/reports'));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    for (const route of ['/reports/daily-activity/reference', '/reports/daily-activity/reference/DAR-000012']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
      assert.equal(response.status, 503);
      const html = await response.text();
      assert.match(html, /Ask an administrator to check the ERPNext connection/);
      assert.doesNotMatch(html, /Something went wrong/);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('daily activity uses configured ERPNext API for filtered totals, pages, and voucher details', async () => {
  process.env.ERPNEXT_URL = 'https://erp.example';
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.endsWith('/login')) return { ok: true, headers: { getSetCookie: () => ['sid=test; HttpOnly'] } };
    if (url.includes('/DAR-000012')) return { ok: true, json: async () => ({ data: {
      name: 'DAR-000012', 'cost center': 'Main', 'expense details': 'Fuel', docstatus: 1,
    } }) };
    const fields = JSON.parse(new URL(url).searchParams.get('fields'));
    return { ok: true, json: async () => ({ data: fields[0].startsWith('count(')
      ? [{ total: 51, sales: 200, expense: 25, banked: 175 }]
      : [{ name: 'DAR-000012', 'cost center': 'Main', 'expense details': 'Fuel', docstatus: 1 }] }) };
  };
  try {
    const report = await dailyActivityReport({ from: '2026-10-01', to: '2026-10-04',
      shop: 'Main', status: '0', page: '2' });
    assert.equal(report.rows[0].shop, 'Main');
    assert.equal(report.rows[0].expense_details, 'Fuel');
    assert.equal(report.summary.sales, 200);
    assert.equal(report.pagination.total_pages, 2);
    assert.deepEqual(JSON.parse(calls[1].url.searchParams.get('filters')), [
      ['date', '>=', '2026-10-01'], ['date', '<=', '2026-10-04'], ['docstatus', '=', 0],
      ['`cost center`', 'like', '%Main%'],
    ]);
    assert.equal(calls[2].url.searchParams.get('limit_start'), '50');
    assert.equal(calls[2].options.headers.cookie, 'sid=test');
    const searched = await dailyActivityReport({ q: 'fuel' });
    assert.equal(searched.summary.total, 1);
    assert.equal(searched.rows[0].expense_details, 'Fuel');
    assert.equal((await dailyActivityReport({ q: 'no match' })).summary.total, 0);
    const voucher = await dailyActivityVoucher('DAR-000012');
    assert.equal(voucher.status_label, 'Submitted');
    assert.equal(voucher.expense_details, 'Fuel');
  } finally { global.fetch = original; }
});

test('ERPNext API errors are safe and missing vouchers return null', async () => {
  process.env.ERPNEXT_URL = 'https://erp.example';
  const original = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(() => dailyActivityReport(), { status: 503, code: 'DAILY_ACTIVITY_SOURCE_UNAVAILABLE' });
    global.fetch = async (url) => url.endsWith('/login')
      ? { ok: true, headers: { getSetCookie: () => ['sid=test'] } }
      : { ok: false, status: 404 };
    assert.equal(await dailyActivityVoucher('missing'), null);
    global.fetch = async () => { throw new Error('private source detail'); };
    await assert.rejects(() => dailyActivityReport(), (error) => error.status === 503
      && !error.message.includes('private source detail'));
  } finally { global.fetch = original; }
});
