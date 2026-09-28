const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { PERMISSIONS, ROLE_RECORD_TYPES, applyPermissionOverrides, normalizePermissions } = require('../src/auth');
const { permissionCheck, scopeCheck } = require('../src/authorize');
const { allowedInvoicePriceLists, invoicePriceListAllowed, priceListActionAllowed,
  warehouseAllowed, accountAllowed, allowedNamedListValues } = require('../src/access');

test('every voucher exposes all six actions and Delete checks its own permission', () => {
  const routes = { sales: '/invoices/4/delete', purchases: '/purchases/4/delete',
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
