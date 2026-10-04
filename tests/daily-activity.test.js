'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { pool } = require('../src/db');
const { normalizeFilters, voucherLink, dailyActivityReport, dailyActivityVoucher } = require('../src/web/daily-activity');
const { permissionCheck } = require('../src/authorize');

test('daily activity filters use a valid date range and ERPNext voucher status', () => {
  const filters = normalizeFilters({ from: '2026-10-01', to: '2026-10-04', shop: 'Kampala', status: '1', page: '2' });
  assert.deepEqual([filters.from, filters.to, filters.shop, filters.status, filters.page],
    ['2026-10-01', '2026-10-04', 'Kampala', '1', 2]);
  assert.throws(() => normalizeFilters({ from: '2026-10-05', to: '2026-10-04' }), /From date/);
  assert.equal(normalizeFilters({ status: 'invalid' }).status, '');
});

test('daily activity links to the ERPNext voucher and requires report permission', () => {
  assert.equal(voucherLink({ name: 'DAR-000012' }), '/reports/daily-activity/DAR-000012');
  const allowed = (permissions, path) => permissionCheck({ path, method: 'GET',
    currentUser: { role: 'standard', permissions } });
  assert.equal(allowed([], '/reports/daily-activity'), false);
  assert.equal(allowed(['reports.daily-activity.view'], '/reports/daily-activity/DAR-000012'), true);
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
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'daily-activity.ejs'), {
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
  const voucher = await ejs.renderFile(path.join(__dirname, '..', 'views', 'daily-activity-voucher.ejs'), {
    ...shared, voucher: { name: 'DAR-000012', date: '2026-10-04', shop: 'Main', status_label: 'Submitted',
      sales: 200, expense: 25, banked: 175, expense_details: 'Fuel', packages_received: 2,
      delivery_differences: 'No', comments_or_remarks: 'Closed early' },
  });
  assert.match(voucher, /Stock delivery report/);
  assert.match(voucher, /Closed early/);
});
