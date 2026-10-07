const crypto = require('node:crypto');
const { runWithAuditUser } = require('./audit');
const { REPORTS } = require('./report-permissions');
const { can, permissionCheck, scopeCheck } = require('./authorize');
const { getPostgresPool } = require('./store');
const { activePermissionPriceLists } = require('./permission-price-lists');
const { recordAccessChoices, selectedLabels, validateRecordAccess,
  defaultRecordPermissions } = require('./user-record-access');
const { invoicePriceListAllowed, priceListActionAllowed, anyNamedPriceListAction,
  anyNamedListView, allowedInvoicePriceLists, allowedNamedListValues,
  allowedMasterRecordIds } = require('./access');
const {
  SESSION_DAYS,
  userCount,
  authenticate,
  createSession,
  sessionUser,
  deleteSession,
  changePassword,
  createUser,
  listUsers,
  saveUserPermissionOverrides,
  applyPermissionOverrides,
  resetUserPassword,
  updateUserAccess,
  ROLE_RECORD_TYPES,
  RECORD_ACTIONS,
  EXTRA_PERMISSIONS,
  listRoles,
  createRole,
  updateRoleDetails,
  saveRoleRecordPermissions,
  removeRoleRecordPermissions,
  saveRoleExtraPermissions,
  deleteRole,
} = require('./auth');

const COOKIE_NAME = 'wm_session';
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;

function sessionToken(req) {
  const header = String(req.headers.cookie || '');
  const pair = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return pair ? pair.slice(COOKIE_NAME.length + 1) : '';
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400000,
  });
}

function safeNext(value) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !path.startsWith('/login')
    ? path : '/';
}

function allowedRequestHosts(req) {
  const hosts = new Set();
  for (const value of [req.get('host'), req.hostname, req.get('x-forwarded-host')]) {
    if (!value) continue;
    for (const part of String(value).split(',')) {
      const host = part.trim();
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

function rejectCrossOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const fetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return res.status(403).send('Request origin is not allowed.');
  }
  if (['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return next();
  }

  const origin = req.get('origin');
  if (!origin) {
    return next();
  }

  try {
    const originHost = new URL(origin).host;
    if (!allowedRequestHosts(req).has(originHost)) {
      return res.status(403).send('Request origin is not allowed.');
    }
  } catch {
    return res.status(403).send('Request origin is not allowed.');
  }
  return next();
}

function loginKey(req, username) {
  return `${req.ip}|${String(username || '').trim().toLowerCase()}`;
}

function pruneLoginFailures(now) {
  for (const [key, state] of loginFailures) {
    if (state.until <= now) {
      loginFailures.delete(key);
    }
  }
}

function denyAccess(req, res) {
  const message = req.accessDeniedReason || 'Your account does not have permission for this action.';
  if (req.path.startsWith('/api/') || req.get('accept')?.includes('application/json')
      || req.get('content-type')?.includes('application/json')) {
    res.status(403).json({ error: message });
  } else {
    res.status(403).render('error', { status: 403, message });
  }
}

function requireAdmin(req, res, next) {
  return req.currentUser.role === 'admin' ? next() : denyAccess(req, res);
}

async function availableInvoicePriceLists() {
  return activePermissionPriceLists(getPostgresPool());
}

async function availablePermissionLists() {
  const invoicePriceLists = await availableInvoicePriceLists();
  const [warehouses, accounts, costCenters, employees] = await Promise.all([
    getPostgresPool().query('SELECT warehouse FROM app_master_warehouses WHERE is_group = false ORDER BY warehouse'),
    getPostgresPool().query('SELECT id::text AS id, account_code, account_name FROM app_accounts ORDER BY account_code, account_name'),
    getPostgresPool().query('SELECT cost_center, cost_center_name FROM app_master_cost_centers WHERE is_group = false ORDER BY cost_center_name, cost_center'),
    getPostgresPool().query('SELECT employee_id, employee_name FROM app_master_employees ORDER BY employee_name, employee_id'),
  ]);
  return { invoicePriceLists, warehouses: warehouses.rows, accounts: accounts.rows,
    costCenters: costCenters.rows, employees: employees.rows };
}

function effectiveRolePermissions(role, lists) {
  if (!role) return [];
  const visible = (kind, values) => {
    const scope = role.scopes?.[kind];
    const allowed = scope?.mode === 'selected' ? new Set(scope.values || []) : null;
    return allowed === null ? values : values.filter((value) => allowed.has(value));
  };
  return [...role.permissions,
    ...visible('invoicePriceLists', lists.invoicePriceLists.map((row) => row.price_list))
      .map((name) => `invoice.price-list.view:${name}`),
    ...visible('warehouses', lists.warehouses.map((row) => row.warehouse))
      .map((name) => `warehouse.view:${name}`),
    ...visible('accounts', lists.accounts.map((row) => row.id))
      .map((id) => `account.view:${id}`)];
}

function priceListRecordTypes(invoicePriceLists) {
  return invoicePriceLists.map(({ price_list: name }) => ({
    key: `invoice-price-list:${name}`, label: name, group: 'Price lists', parentKey: 'masters.price-lists',
    actions: RECORD_ACTIONS, permissions: Object.fromEntries(RECORD_ACTIONS.map((action) =>
      [action, `invoice.price-list.${action}:${name}`])),
  }));
}

function namedListRecordTypes(lists, includeMasterRecords = false) {
  return [
    ...lists.warehouses.map((row) => ({ key: `warehouse:${row.warehouse}`, label: row.warehouse,
      group: 'Warehouse list', parentKey: 'masters.warehouses', actions: ['view'], permissions: { view: `warehouse.view:${row.warehouse}` } })),
    ...lists.accounts.map((row) => ({ key: `account:${row.id}`,
      label: `${row.account_code || row.id} · ${row.account_name}`, group: 'Accounts list',
      parentKey: 'chart-of-accounts', parentAliases: ['accounts'],
      actions: ['view'], permissions: { view: `account.view:${row.id}` } })),
    ...(includeMasterRecords ? [
      ...lists.costCenters.map((row) => ({ key: `cost-center:${row.cost_center}`,
        label: `${row.cost_center_name} · ${row.cost_center}`, group: 'Cost Center list', parentKey: 'masters.cost-centers',
        actions: ['view'], permissions: { view: `cost-center.view:${row.cost_center}` } })),
      ...lists.employees.map((row) => ({ key: `employee:${row.employee_id}`,
        label: `${row.employee_name} · ${row.employee_id}`, group: 'Employee list', parentKey: 'masters.employees',
        actions: ['view'], permissions: { view: `employee.view:${row.employee_id}` } })),
    ] : []),
  ];
}

async function userPermissionContext(id) {
  const user = (await listUsers()).find((row) => Number(row.id) === Number(id));
  if (!user) { const error = new Error('User not found.'); error.status = 404; throw error; }
  if (user.role === 'admin') { const error = new Error('Admin has full access.'); error.status = 400; throw error; }
  const role = (await listRoles()).find((row) => row.slug === user.role);
  const lists = await availablePermissionLists();
  const types = [...ROLE_RECORD_TYPES, ...priceListRecordTypes(lists.invoicePriceLists),
    ...namedListRecordTypes(lists, true)];
  const inherited = effectiveRolePermissions(role, lists);
  return { user, types, inherited,
    effective: applyPermissionOverrides(inherited, user.permission_grants, user.permission_denials) };
}

async function saveUserEffectivePermissions(context, desired, forceGrants = [], preserveNamed = true) {
  const inherited = new Set(context.inherited);
  const effective = new Set(desired);
  const defaults = defaultRecordPermissions(context.user.record_access);
  const namedPrefixes = ['warehouse.view:', 'invoice.price-list.view:', 'cost-center.view:', 'employee.view:'];
  const preserved = preserveNamed ? (context.user.permission_grants || [])
    .filter((key) => effective.has(key) && namedPrefixes.some((prefix) => key.startsWith(prefix))) : [];
  const grants = [...new Set([
    ...[...effective].filter((key) => !inherited.has(key)), ...defaults, ...preserved, ...forceGrants,
  ])];
  const defaultSet = new Set(defaults);
  await saveUserPermissionOverrides(context.user.id,
    grants,
    [...inherited].filter((key) => !effective.has(key) && !defaultSet.has(key)));
  return [...effective];
}

function displayedUserPermissions(inherited, user, lists) {
  const effective = new Set(applyPermissionOverrides(inherited, user.permission_grants, user.permission_denials));
  if (user.record_access?.warehouse) {
    for (const key of effective) if (key.startsWith('warehouse.view:')) effective.delete(key);
    const allowed = allowedNamedListValues(user, 'warehouses');
    for (const name of allowed === null ? lists.warehouses.map((row) => row.warehouse) : allowed) {
      effective.add(`warehouse.view:${name}`);
    }
  }
  if (user.record_access?.retail_price_list || user.record_access?.wholesale_price_list) {
    for (const key of effective) if (key.startsWith('invoice.price-list.view:')) effective.delete(key);
    const allowed = allowedInvoicePriceLists(user);
    for (const name of allowed === null ? lists.invoicePriceLists.map((row) => row.price_list) : allowed) {
      effective.add(`invoice.price-list.view:${name}`);
    }
  }
  return [...effective];
}

function installAuth(app) {
  app.use(rejectCrossOrigin);

  app.get('/login', async (req, res, next) => {
    try {
      if (await sessionUser(sessionToken(req))) return res.redirect('/');
      res.set('Cache-Control', 'no-store');
      res.render('login', { error: req.query.expired === '1' ? 'Your session ended. Please log in again.' : null,
        username: '', nextPath: safeNext(req.query.next), setupNeeded: await userCount() === 0 });
    } catch (error) { next(error); }
  });

  app.post('/login', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const nextPath = safeNext(req.body.next);
    pruneLoginFailures(Date.now());
    const key = loginKey(req, username);
    const state = loginFailures.get(key);
    if (state && state.until > Date.now() && state.count >= LOGIN_ATTEMPT_LIMIT) {
      res.status(429).render('login', { error: 'Too many attempts. Try again in 15 minutes.', username, nextPath, setupNeeded: false });
      return;
    }
    try {
      const user = await authenticate(username, password);
      if (!user) {
        const current = state && state.until > Date.now() ? state : { count: 0, until: Date.now() + LOGIN_WINDOW_MS };
        current.count += 1;
        loginFailures.set(key, current);
        res.status(401).render('login', { error: 'Invalid username or password.', username, nextPath, setupNeeded: await userCount() === 0 });
        return;
      }
      loginFailures.delete(key);
      setSessionCookie(req, res, await runWithAuditUser(user, () => createSession(user.id)));
      res.redirect(303, user.must_change_password ? '/account/password' : nextPath);
    } catch (error) { next(error); }
  });

  app.post('/logout', async (req, res, next) => {
    try {
      await deleteSession(sessionToken(req));
      res.clearCookie(COOKIE_NAME, { path: '/' });
      res.redirect(303, '/login');
    } catch (error) { next(error); }
  });

  app.use(async (req, res, next) => {
    try {
      const token = sessionToken(req);
      const user = await sessionUser(token);
      if (!user) {
        if (token) res.clearCookie(COOKIE_NAME, { path: '/' });
        if (req.path.startsWith('/api/') || req.get('accept')?.includes('application/json')) {
          res.status(401).json({ error: 'Login required.' });
        } else {
          res.redirect(303, `/login?expired=${token ? '1' : '0'}&next=${encodeURIComponent(safeNext(req.originalUrl))}`);
        }
        return;
      }
      req.currentUser = user;
      res.locals.currentUser = user;
      res.locals.can = (permission) => can(user, permission);
      res.locals.invoicePriceListAllowed = (name) => invoicePriceListAllowed(user, name);
      res.locals.canPriceListAction = (name, action) => priceListActionAllowed(user, name, action);
      res.locals.canCreateItemPrice = can(user, 'masters.item-prices.create') || anyNamedPriceListAction(user, 'create');
      res.locals.canManageNamedPriceLists = ['view', 'edit', 'submit', 'cancel', 'delete']
        .some((action) => anyNamedPriceListAction(user, action));
      res.locals.canViewNamedWarehouses = anyNamedListView(user, 'warehouses');
      res.locals.canViewNamedAccounts = anyNamedListView(user, 'accounts');
      res.locals.canViewAssignedCostCenters = (allowedMasterRecordIds(user, 'cost-centers') || []).length > 0;
      res.locals.canViewAssignedEmployees = (allowedMasterRecordIds(user, 'employees') || []).length > 0;
      res.locals.availableReports = REPORTS.filter((report) => can(user, report.permission));
      if (user.must_change_password && req.path !== '/account/password') {
        res.redirect(303, '/account/password');
        return;
      }
      runWithAuditUser(user, next);
    } catch (error) { next(error); }
  });

  app.post('/session/activity', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendStatus(204);
  });

  app.get('/account/password', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('change-password', { error: null, success: null });
  });

  app.post('/account/password', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    if (newPassword !== String(req.body.confirm_password || '')) {
      res.status(400).render('change-password', { error: 'New passwords do not match.', success: null });
      return;
    }
    try {
      await changePassword(req.currentUser.id, currentPassword, newPassword);
      setSessionCookie(req, res, await createSession(req.currentUser.id));
      res.redirect(303, '/');
    } catch (error) {
      if (error.status === 400) {
        res.status(400).render('change-password', { error: error.message, success: null });
      } else {
        next(error);
      }
    }
  });

  async function renderUsers(req, res, options = {}) {
    res.set('Cache-Control', 'no-store');
    res.status(options.status || 200).render('users', {
      users: await listUsers(),
      roles: await listRoles(),
      choices: await recordAccessChoices(),
      selected: options.selected || {},
      error: options.error || null,
      created: options.created || null,
    });
  }

  app.get('/settings/users', requireAdmin, async (req, res, next) => {
    try { await renderUsers(req, res); } catch (error) { next(error); }
  });

  app.post('/settings/users', requireAdmin, async (req, res, next) => {
    try {
      const record_access = validateRecordAccess(req.body, await recordAccessChoices());
      const password = crypto.randomBytes(24).toString('base64url');
      const user = await createUser(req.body.username, password,
        { role: req.body.role, mustChangePassword: true, record_access });
      await renderUsers(req, res, { created: { username: user.username, password } });
    } catch (error) {
      try { await renderUsers(req, res, { status: error.status || (error.code === '23505' ? 409 : 500),
        error: error.code === '23505' ? 'Username already exists.' : error.message,
        selected: req.body }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/users/:id/access', requireAdmin, async (req, res, next) => {
    try {
      await updateUserAccess(req.currentUser.id, req.params.id, {
        role: req.body.role,
        active: req.body.active === 'on',
      });
      res.redirect(303, '/settings/users');
    } catch (error) {
      try { await renderUsers(req, res, { status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  async function renderUserEdit(req, res, options = {}) {
    const user = (await listUsers()).find((row) => Number(row.id) === Number(req.params.id));
    if (!user) { const error = new Error('User not found.'); error.status = 404; throw error; }
    const choices = await recordAccessChoices();
    res.set('Cache-Control', 'no-store');
    res.status(options.status || 200).render('user-edit', {
      user, roles: await listRoles(), choices,
      selected: options.selected || selectedLabels(user.record_access, choices),
      role: options.role || user.role,
      active: options.active === undefined ? user.active : options.active,
      error: options.error || null,
    });
  }

  app.get('/settings/users/:id/edit', requireAdmin, async (req, res, next) => {
    try { await renderUserEdit(req, res); } catch (error) { next(error); }
  });

  app.post('/settings/users/:id/edit', requireAdmin, async (req, res, next) => {
    try {
      const choices = await recordAccessChoices();
      const record_access = validateRecordAccess(req.body, choices);
      await updateUserAccess(req.currentUser.id, req.params.id, {
        role: req.body.role, active: req.body.active === 'on', record_access,
      });
      res.redirect(303, '/settings/users');
    } catch (error) {
      try { await renderUserEdit(req, res, { status: error.status || 500, error: error.message,
        selected: Object.fromEntries(['warehouse', 'cost_center', 'employee_id',
          'retail_price_list', 'wholesale_price_list'].map((field) => [field, String(req.body[field] || '')])),
        role: req.body.role, active: req.body.active === 'on' }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/users/:id/reset', requireAdmin, async (req, res, next) => {
    try {
      const user = (await listUsers()).find((row) => Number(row.id) === Number(req.params.id));
      if (!user) { const error = new Error('User not found.'); error.status = 404; throw error; }
      const password = crypto.randomBytes(24).toString('base64url');
      await resetUserPassword(user.username, password);
      await renderUsers(req, res, { created: { username: user.username, password } });
    } catch (error) {
      try { await renderUsers(req, res, { status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  async function renderRoles(req, res, options = {}) {
    const roles = await listRoles();
    const users = await listUsers();
    const activeTab = options.activeTab || (['roles', 'users'].includes(req.query.tab) ? req.query.tab : 'permissions');
    const selectedUser = users.find((user) => Number(user.id) === Number(options.selectedUser || req.query.user))
      || users.find((user) => user.role !== 'admin') || users[0] || null;
    const selectedRole = roles.find((role) => role.slug === (options.selectedRole || req.query.role)) || roles.find((role) => role.slug === 'standard') || roles[0];
    const lists = await availablePermissionLists();
    const recordTypes = [...ROLE_RECORD_TYPES, ...priceListRecordTypes(lists.invoicePriceLists),
      ...namedListRecordTypes(lists, activeTab === 'users')];
    if (selectedRole) selectedRole.permissions = effectiveRolePermissions(selectedRole, lists);
    const userRole = selectedUser && roles.find((role) => role.slug === selectedUser.role);
    const inheritedPermissions = effectiveRolePermissions(userRole, lists);
    const userPermissions = selectedUser
      ? displayedUserPermissions(inheritedPermissions, selectedUser, lists) : [];
    res.set('Cache-Control', 'no-store');
    res.status(options.status || 200).render('roles', {
      roles,
      users,
      selectedUser,
      activeTab,
      inheritedPermissions,
      userPermissions,
      defaultUserPermissionKeys: defaultRecordPermissions(selectedUser?.record_access),
      selectedUserRole: userRole,
      selectedRole,
      recordTypes,
      recordActions: RECORD_ACTIONS,
      extraPermissions: EXTRA_PERMISSIONS,
      error: options.error || null,
      notice: options.notice || null,
    });
  }

  app.get('/settings/roles', requireAdmin, async (req, res, next) => {
    try { await renderRoles(req, res); } catch (error) { next(error); }
  });

  async function finishUserPermissionChange(req, res, next, change) {
    try {
      const context = await userPermissionContext(req.params.id);
      const permissions = await change(context);
      if (req.get('Accept')?.includes('application/json')) return res.json({ permissions });
      res.redirect(303, `/settings/roles?tab=users&user=${context.user.id}`);
    } catch (error) {
      if (req.get('Accept')?.includes('application/json')) return res.status(error.status || 500).json({ error: error.message });
      try { await renderRoles(req, res, { activeTab: 'users', selectedUser: req.params.id,
        status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  }

  app.post('/settings/users/:id/permissions/row', requireAdmin, (req, res, next) =>
    finishUserPermissionChange(req, res, next, async (context) => {
      const type = context.types.find((item) => item.key === req.body.record_type);
      if (!type) { const error = new Error('Choose a valid record type.'); error.status = 400; throw error; }
      const actions = req.body.actions === undefined ? [] : Array.isArray(req.body.actions) ? req.body.actions : [req.body.actions];
      if (!actions.length || actions.some((action) => !type.actions.includes(action))) {
        const error = new Error('Choose valid actions for this record type.'); error.status = 400; throw error;
      }
      const desired = new Set(context.effective);
      for (const permission of Object.values(type.permissions)) desired.delete(permission);
      for (const action of actions) desired.add(type.permissions[action]);
      if (type.permissions.view && actions.some((action) => action !== 'view')) desired.add(type.permissions.view);
      if (type.key === 'payments.sales') desired.add('vouchers.sales.view');
      if (type.key === 'payments.purchases') desired.add('vouchers.purchases.view');
      if (type.key === 'accounts') desired.add('accounts.view');
      const forceGrant = type.permissions.view && (type.key.startsWith('warehouse:')
        && context.user.record_access?.warehouse
        || type.key.startsWith('invoice-price-list:')
          && (context.user.record_access?.retail_price_list || context.user.record_access?.wholesale_price_list))
        ? [type.permissions.view] : [];
      return saveUserEffectivePermissions(context, desired, forceGrant);
    }));

  app.post('/settings/users/:id/permissions/row/remove', requireAdmin, (req, res, next) =>
    finishUserPermissionChange(req, res, next, async (context) => {
      const type = context.types.find((item) => item.key === req.body.record_type);
      if (!type) { const error = new Error('Choose a valid record type.'); error.status = 400; throw error; }
      if (defaultRecordPermissions(context.user.record_access).includes(type.permissions.view)) {
        const error = new Error('Change this default selection on the Edit user page.'); error.status = 400; throw error;
      }
      const desired = new Set(context.effective);
      for (const permission of Object.values(type.permissions)) desired.delete(permission);
      if (type.key === 'vouchers.sales') for (const permission of desired) {
        if (permission.startsWith('payments.sales.')) desired.delete(permission);
      }
      if (type.key === 'vouchers.purchases') for (const permission of desired) {
        if (permission.startsWith('payments.purchases.')) desired.delete(permission);
      }
      if (type.key === 'chart-of-accounts') desired.delete('accounts.manage');
      return saveUserEffectivePermissions(context, desired);
    }));

  app.post('/settings/users/:id/permissions/extra', requireAdmin, (req, res, next) =>
    finishUserPermissionChange(req, res, next, async (context) => {
      const requested = req.body.permissions === undefined ? [] : Array.isArray(req.body.permissions)
        ? req.body.permissions : [req.body.permissions];
      const allowed = new Set(EXTRA_PERMISSIONS.map((permission) => permission.key));
      if (requested.some((permission) => !allowed.has(permission))) {
        const error = new Error('Choose valid additional permissions.'); error.status = 400; throw error;
      }
      const desired = new Set(context.effective);
      for (const permission of allowed) desired.delete(permission);
      for (const permission of requested) desired.add(permission);
      return saveUserEffectivePermissions(context, desired);
    }));

  app.post('/settings/users/:id/permissions/reset', requireAdmin, (req, res, next) =>
    finishUserPermissionChange(req, res, next, async (context) =>
      saveUserEffectivePermissions(context, context.inherited, [], false)));

  app.post('/settings/roles', requireAdmin, async (req, res, next) => {
    try {
      const role = await createRole(req.body.name, []);
      res.redirect(303, `/settings/roles?tab=roles&role=${encodeURIComponent(role.slug)}`);
    } catch (error) {
      try { await renderRoles(req, res, { activeTab: 'roles', status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/roles/:slug/permissions', requireAdmin, async (req, res, next) => {
    try {
      await saveRoleRecordPermissions(req.params.slug, req.body.record_type, req.body.actions);
      if (req.get('Accept') === 'application/json') {
        const role = (await listRoles()).find((item) => item.slug === req.params.slug);
        return res.json({ permissions: effectiveRolePermissions(role, await availablePermissionLists()) });
      }
      res.redirect(303, `/settings/roles?role=${encodeURIComponent(req.params.slug)}`);
    } catch (error) {
      if (req.get('Accept') === 'application/json') return res.status(error.status || 500).json({ error: error.message });
      try { await renderRoles(req, res, { selectedRole: req.params.slug, status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/roles/:slug/permissions/remove', requireAdmin, async (req, res, next) => {
    try {
      await removeRoleRecordPermissions(req.params.slug, req.body.record_type);
      if (req.get('Accept') === 'application/json') {
        const role = (await listRoles()).find((item) => item.slug === req.params.slug);
        return res.json({ permissions: effectiveRolePermissions(role, await availablePermissionLists()) });
      }
      res.redirect(303, `/settings/roles?role=${encodeURIComponent(req.params.slug)}`);
    } catch (error) {
      if (req.get('Accept') === 'application/json') return res.status(error.status || 500).json({ error: error.message });
      try { await renderRoles(req, res, { selectedRole: req.params.slug, status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/roles/:slug/permissions/extra', requireAdmin, async (req, res, next) => {
    try {
      await saveRoleExtraPermissions(req.params.slug, req.body.permissions);
      res.redirect(303, `/settings/roles?role=${encodeURIComponent(req.params.slug)}`);
    } catch (error) {
      try { await renderRoles(req, res, { selectedRole: req.params.slug, status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/roles/:slug', requireAdmin, async (req, res, next) => {
    try {
      await updateRoleDetails(req.params.slug, req.body.name);
      res.redirect(303, `/settings/roles?tab=roles&role=${encodeURIComponent(req.params.slug)}`);
    } catch (error) {
      try { await renderRoles(req, res, { activeTab: 'roles', selectedRole: req.params.slug, status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.post('/settings/roles/:slug/delete', requireAdmin, async (req, res, next) => {
    try {
      await deleteRole(req.params.slug);
      res.redirect(303, '/settings/roles?tab=roles');
    } catch (error) {
      try { await renderRoles(req, res, { activeTab: 'roles', status: error.status || 500, error: error.message }); }
      catch (renderError) { next(renderError); }
    }
  });

  app.use(async (req, res, next) => {
    try {
      if (!permissionCheck(req)) {
        if (req.method === 'GET' && /^\/journals(?:\/\d+(?:\/drawer)?)?$/.test(req.path)) {
          req.accessDeniedReason = req.path === '/journals'
            ? 'Your account needs Journal Read permission to view journals.'
            : 'Your account needs Journal Read permission to open this journal.';
        }
        return denyAccess(req, res);
      }
      if (!await scopeCheck(req)) return denyAccess(req, res);
      return next();
    } catch (error) { return next(error); }
  });
}

module.exports = { installAuth };
