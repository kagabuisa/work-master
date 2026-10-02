const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { PERMISSIONS, ROLE_RECORD_TYPES, applyPermissionOverrides, normalizePermissions } = require('../src/auth');
const { permissionCheck, scopeCheck } = require('../src/authorize');
const { allowedInvoicePriceLists, invoicePriceListAllowed, priceListActionAllowed,
  warehouseAllowed, accountAllowed, allowedNamedListValues } = require('../src/access');

test('project file browsing, downloading, and uploading are admin only', () => {
  const request = (role, route, method) => ({ currentUser: { role, permissions: [] }, path: route, method, body: {} });
  for (const [route, method] of [
    ['/settings/files', 'GET'],
    ['/settings/files/download', 'GET'],
    ['/settings/files/upload', 'POST'],
  ]) {
    assert.equal(permissionCheck(request('admin', route, method)), true, `${method} ${route} should allow admin`);
    assert.equal(permissionCheck(request('standard', route, method)), false, `${method} ${route} should deny standard users`);
  }
  assert.equal(permissionCheck(request('admin', '/settings/files/upload', 'GET')), false);
  assert.equal(permissionCheck(request('admin', '/settings/files/download', 'POST')), false);
});

test('every voucher exposes all six actions and Delete checks its own permission', () => {
  const routes = { sales: '/invoices/4/delete', purchases: '/purchases/4/delete',
    'purchase-orders': '/purchase-orders/4/delete',
    stock: '/stock/entries/4/delete', journals: '/journals/4/delete' };
  for (const [type, route] of Object.entries(routes)) {
    const row = ROLE_RECORD_TYPES.find((entry) => entry.key === `vouchers.${type}`);
    assert.deepEqual(row.actions, ['view', 'create', 'edit', 'submit', 'cancel', 'delete']);
    assert(PERMISSIONS.some((entry) => entry.key === `vouchers.${type}.delete`));
    const request = (permissions, method = 'POST') => ({ currentUser: { role: 'standard', permissions },
      path: route, method, body: {} });
    assert.equal(permissionCheck(request([`vouchers.${type}.edit`])), false);
    assert.equal(permissionCheck(request([`vouchers.${type}.delete`])), true);
    assert.equal(permissionCheck(request([`vouchers.${type}.delete`], 'GET')), false);
  }
});

test('cost centers use master list permissions and sales can search them', () => {
  const record = ROLE_RECORD_TYPES.find((entry) => entry.key === 'masters.cost-centers');
  assert(record);
  assert.deepEqual(record.actions, ['view', 'create', 'edit', 'submit', 'cancel', 'delete']);
  const request = (permissions, path, method = 'GET') => ({ currentUser: { role: 'standard', permissions }, path, method, body: {} });
  assert.equal(permissionCheck(request(['masters.cost-centers.view'], '/settings/cost-centers')), true);
  assert.equal(permissionCheck(request(['masters.cost-centers.edit'], '/settings/cost-centers/CC-1/edit')), true);
  assert.equal(permissionCheck(request(['masters.cost-centers.view'], '/settings/cost-centers/CC-1', 'POST')), false);
  assert.equal(permissionCheck(request(['vouchers.sales.create'], '/api/cost-centers')), true);
});

test('submitted cost centers expose an editable master form', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'master-form.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', username: 'test' }, can: () => true,
    availableReports: [], error: null, mode: 'edit', editSubmitted: true,
    neighbors: { previous: null, next: null }, optionValues: {},
    config: { key: 'cost-centers', idField: 'cost_center', title: 'Cost Centers', singular: 'Cost Center',
      editLabel: 'Edit Cost Center', fields: [{ name: 'cost_center_name', label: 'Cost Center Name', required: true }] },
    record: { cost_center: 'CC-1', cost_center_name: 'Retail', docstatus: 'submitted', active: 1 },
  });
  assert.match(html, /Save Cost Center<\/button>/);
  assert.doesNotMatch(html, /data-pricelist-change-tracking/);
});

test('user grants and denials override inherited role permissions', () => {
  const effective = applyPermissionOverrides(['vouchers.sales.view', 'vouchers.sales.edit'],
    ['vouchers.sales.submit'], ['vouchers.sales.edit']);
  assert.deepEqual(effective, ['vouchers.sales.view', 'vouchers.sales.submit']);
  assert.equal(permissionCheck({ currentUser: { role: 'standard', permissions: effective },
    path: '/invoices/4/edit', method: 'GET', body: {} }), false);
});

test('named price list user overrides affect use and actions', () => {
  const user = { role: 'standard', permissions: ['masters.price-lists.edit'],
    scopes: { invoicePriceLists: { mode: 'selected', values: ['Retail'] } },
    permission_grants: ['invoice.price-list.view:Wholesale'],
    permission_denials: ['invoice.price-list.view:Retail', 'invoice.price-list.edit:Wholesale'] };
  assert.deepEqual(allowedInvoicePriceLists(user), ['Wholesale']);
  assert.equal(invoicePriceListAllowed(user, 'Retail'), false);
  assert.equal(invoicePriceListAllowed(user, 'Wholesale'), true);
  assert.equal(priceListActionAllowed(user, 'Wholesale', 'edit'), false);
});

test('individual warehouse and account Read permissions scope list and voucher use', async () => {
  assert.deepEqual(normalizePermissions(['warehouse.view:Main', 'account.view:9']),
    ['warehouse.view:Main', 'account.view:9']);
  assert.throws(() => normalizePermissions(['warehouse.view:']), { status: 400 });
  const user = { role: 'standard', permissions: [], scopes: {
    warehouses: { mode: 'selected', values: ['Main'] }, accounts: { mode: 'selected', values: ['7'] },
  }, permission_grants: ['warehouse.view:Overflow', 'account.view:9'],
  permission_denials: ['warehouse.view:Main', 'account.view:7'] };
  assert.deepEqual(allowedNamedListValues(user, 'warehouses'), ['Overflow']);
  assert.deepEqual(allowedNamedListValues(user, 'accounts'), ['9']);
  assert.equal(warehouseAllowed(user, 'Main'), false);
  assert.equal(warehouseAllowed(user, 'Overflow'), true);
  assert.equal(accountAllowed(user, 7), false);
  assert.equal(accountAllowed(user, 9), true);
  assert(permissionCheck({ currentUser: user, path: '/settings/warehouses', method: 'GET', body: {} }));
  assert(permissionCheck({ currentUser: user, path: '/accounts', method: 'GET', body: {} }));
  assert.equal(await scopeCheck({ currentUser: user, path: '/invoices', method: 'POST',
    body: { warehouse: ['Main'] } }), false);
  assert.equal(await scopeCheck({ currentUser: user, path: '/journals', method: 'POST',
    body: { account_id: ['7'] } }), false);
});

test('chart of accounts editing requires account management permission', () => {
  const request = (permissions, path, method = 'GET') => ({
    currentUser: { role: 'standard', permissions }, path, method, body: {},
  });
  assert.equal(permissionCheck(request(['accounts.view'], '/accounts/12/edit')), false);
  assert.equal(permissionCheck(request(['accounts.view'], '/accounts/12', 'POST')), false);
  assert.equal(permissionCheck(request(['accounts.manage'], '/accounts/12/edit')), true);
  assert.equal(permissionCheck(request(['accounts.manage'], '/accounts/12', 'POST')), true);
  assert.equal(permissionCheck(request(['accounts.view'], '/accounts/12', 'GET')), false);
});

test('changing voucher posting time requires edit permission', () => {
  for (const [type, route] of Object.entries({
    sales: '/invoices/4/posting-time', purchases: '/purchases/4/posting-time',
    stock: '/stock/entries/4/posting-time', journals: '/journals/4/posting-time',
  })) {
    const request = (permissions, method) => ({ currentUser: { role: 'standard', permissions },
      path: route, method, body: {} });
    assert.equal(permissionCheck(request([`vouchers.${type}.view`], 'POST')), false);
    assert.equal(permissionCheck(request([`vouchers.${type}.edit`], 'POST')), true);
    assert.equal(permissionCheck(request([`vouchers.${type}.edit`], 'GET')), false);
  }
});

test('changing a non-system invoice number requires sales edit permission', () => {
  const request = (permissions, method) => ({ currentUser: { role: 'standard', permissions },
    path: '/invoices/4/non-system-invoice', method, body: {} });
  assert.equal(permissionCheck(request(['vouchers.sales.view'], 'POST')), false);
  assert.equal(permissionCheck(request(['vouchers.sales.edit'], 'POST')), true);
  assert.equal(permissionCheck(request(['vouchers.sales.edit'], 'GET')), false);
});

test('date and time display settings can only be changed by an admin', () => {
  const request = (role, method) => ({ currentUser: { role, permissions: [] },
    path: '/settings/date-time', method, body: {} });
  assert.equal(permissionCheck(request('admin', 'POST')), true);
  assert.equal(permissionCheck(request('admin', 'GET')), false);
  assert.equal(permissionCheck(request('standard', 'POST')), false);
});

test('user permissions use the role row workflow', async () => {
  const role = { slug: 'standard', name: 'Standard', user_count: 1,
    permissions: ['vouchers.sales.view'], scopes: {} };
  const user = { id: 2, username: 'worker', role: 'standard' };
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'roles.ejs'), {
    assetVersion: 'test', activeTab: 'users', error: null, notice: null,
    currentUser: { id: 1, username: 'admin', role: 'admin', scopes: {} },
    can: () => true, availableReports: [], roles: [role], selectedRole: role,
    users: [user], selectedUser: user, selectedUserRole: role,
    inheritedPermissions: role.permissions, userPermissions: role.permissions,
    recordTypes: ROLE_RECORD_TYPES, recordActions: ['create', 'view', 'edit', 'submit', 'cancel', 'delete'],
    extraPermissions: [],
  });
  for (const required of ['data-auto-permissions', 'data-role-add-row',
    '/settings/users/2/permissions/row', '/settings/users/2/permissions/row/remove',
    '/settings/users/2/permissions/extra', '/settings/users/2/permissions/reset']) {
    assert(html.includes(required), `Missing ${required}`);
  }
  assert(!html.includes('data-user-permissions'));
});
