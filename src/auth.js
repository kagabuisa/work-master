const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { getPostgresPool } = require('./store');
const { REPORTS } = require('./report-permissions');
const { initRecordAudit, stampRecordList } = require('./audit');

const scrypt = promisify(crypto.scrypt);
const authFile = path.join(__dirname, '..', 'data', 'auth.json');
const SESSION_DAYS = 7;
const PASSWORD_MIN_LENGTH = 12;
const MASTER_LISTS = [
  ['customers', 'Customers'], ['suppliers', 'Suppliers'], ['items', 'Items'],
  ['price-lists', 'Price Lists'], ['item-prices', 'Item Prices'],
  ['warehouses', 'Warehouses'], ['employees', 'Employees'], ['cost-centers', 'Cost Centers'], ['options', 'Options'],
];
const VOUCHER_TYPES = [
  ['sales', 'Sales invoices', ['view', 'create', 'edit', 'submit', 'cancel', 'delete']],
  ['purchases', 'Purchases', ['view', 'create', 'edit', 'submit', 'cancel', 'delete']],
  ['purchase-orders', 'Purchase orders', ['view', 'create', 'edit', 'submit', 'cancel', 'delete']],
  ['stock', 'Stock entries', ['view', 'create', 'edit', 'submit', 'cancel', 'delete']],
  ['journals', 'Journals', ['view', 'create', 'edit', 'submit', 'cancel', 'delete']],
];
const PERMISSIONS = [
  ...MASTER_LISTS.flatMap(([key, label]) => ['view', 'create', 'edit', 'submit', 'cancel', 'delete']
    .map((action) => ({ key: `masters.${key}.${action}`,
      label: `${action[0].toUpperCase()}${action.slice(1)} ${label}`, group: 'Master lists' }))),
  ...VOUCHER_TYPES.flatMap(([key, label, actions]) => actions.map((action) => (
    { key: `vouchers.${key}.${action}`, label: `${action[0].toUpperCase()}${action.slice(1)} ${label}`, group: 'Vouchers' }
  ))),
  ...['sales', 'purchases'].flatMap((key) => [
    { key: `payments.${key}.record`, label: `Record ${key === 'sales' ? 'customer' : 'supplier'} payments`, group: 'Payments' },
    { key: `payments.${key}.cancel`, label: `Cancel ${key === 'sales' ? 'customer' : 'supplier'} payments`, group: 'Payments' },
  ]),
  { key: 'accounts.view', label: 'View chart of accounts', group: 'Accounts and reports' },
  { key: 'accounts.manage', label: 'Create and edit accounts', group: 'Accounts and reports' },
  ...REPORTS.map((report) => ({ key: report.permission, label: `View ${report.label}`, group: 'Reports' })),
  { key: 'sync.run', label: 'Run ERPNext sync', group: 'Administration' },
];
const RECORD_ACTIONS = ['create', 'view', 'edit', 'submit', 'cancel', 'delete'];
const RECORD_TITLES = {
  sales: 'Sales Invoice', purchases: 'Purchase', 'purchase-orders': 'Purchase Order', stock: 'Stock Entry', journals: 'Journal Entry',
  'price-lists': 'Price List', 'item-prices': 'Item Price',
  customers: 'Customer', suppliers: 'Supplier', items: 'Item', warehouses: 'Warehouse', employees: 'Employee', 'cost-centers': 'Cost Center', options: 'Option',
};
const ROLE_RECORD_TYPES = [
  ...VOUCHER_TYPES.map(([key, , actions]) => ({ key: `vouchers.${key}`, label: RECORD_TITLES[key], group: 'Voucher types',
    actions, permissions: Object.fromEntries(actions.map((action) => [action, `vouchers.${key}.${action}`])) })),
  ...MASTER_LISTS.map(([key]) => ({ key: `masters.${key}`, label: RECORD_TITLES[key], group: 'Master lists',
    actions: ['view', 'create', 'edit', 'submit', 'cancel', 'delete'],
    permissions: Object.fromEntries(['view', 'create', 'edit', 'submit', 'cancel', 'delete']
      .map((action) => [action, `masters.${key}.${action}`])) })),
  { key: 'payments.sales', label: 'Customer Payment', group: 'Payments', actions: ['create', 'cancel'],
    permissions: { create: 'payments.sales.record', cancel: 'payments.sales.cancel' } },
  { key: 'payments.purchases', label: 'Supplier Payment', group: 'Payments', actions: ['create', 'cancel'],
    permissions: { create: 'payments.purchases.record', cancel: 'payments.purchases.cancel' } },
  ...REPORTS.map((report) => ({ key: `reports.${report.slug}`, label: report.label,
    group: 'Reports', actions: ['view'], permissions: { view: report.permission } })),
  { key: 'accounts', label: 'Accounts', group: 'Accounts', actions: ['create'], permissions: { create: 'accounts.manage' } },
  { key: 'chart-of-accounts', label: 'Chart of Accounts', group: 'Accounts', actions: ['view'], permissions: { view: 'accounts.view' } },
];
const RECORD_PERMISSION_KEYS = new Set(ROLE_RECORD_TYPES.flatMap((type) => Object.values(type.permissions)));
const EXTRA_PERMISSIONS = PERMISSIONS.filter((permission) => !RECORD_PERMISSION_KEYS.has(permission.key));
const ROUTINE_PERMISSIONS = PERMISSIONS.filter((item) => !item.key.startsWith('masters.')
  && !item.key.endsWith('.cancel') && !item.key.endsWith('.delete') && item.key !== 'sync.run').map((item) => item.key);
const PREVIOUS_ROUTINE_PERMISSIONS = [...ROUTINE_PERMISSIONS,
  ...PERMISSIONS.filter((item) => item.key.startsWith('masters.') && item.key.endsWith('.view')).map((item) => item.key)];
const OLDER_ROUTINE_PERMISSIONS = PREVIOUS_ROUTINE_PERMISSIONS.filter((permission) =>
  !['vouchers.journals.edit', 'vouchers.journals.submit'].includes(permission));
const ELEVATED_PERMISSIONS = PERMISSIONS.filter((item) => item.key.endsWith('.cancel') || item.key === 'sync.run'
  || item.key.startsWith('masters.') && !item.key.endsWith('.view')).map((item) => item.key);
const DEFAULT_SCOPES = { customers: { mode: 'all', values: [] }, suppliers: { mode: 'all', values: [] },
  invoicePriceLists: { mode: 'all', values: [] }, warehouses: { mode: 'all', values: [] },
  accounts: { mode: 'all', values: [] } };
const BUILT_IN_ROLES = [
  { slug: 'standard', name: 'Standard', permissions: ROUTINE_PERMISSIONS },
  { slug: 'privileged', name: 'Privileged', permissions: PERMISSIONS.map((item) => item.key) },
  { slug: 'admin', name: 'Admin', permissions: PERMISSIONS.map((item) => item.key) },
  { slug: 'retail', name: 'Retail', permissions: ROUTINE_PERMISSIONS },
  { slug: 'wholesale', name: 'Wholesale', permissions: ROUTINE_PERMISSIONS },
  { slug: 'finance', name: 'Finance', permissions: ROUTINE_PERMISSIONS },
  { slug: 'logistics', name: 'Logistics', permissions: ROUTINE_PERMISSIONS },
  { slug: 'management', name: 'Management', permissions: ROUTINE_PERMISSIONS },
];

function normalizeScopes(value = DEFAULT_SCOPES) {
  const scopes = {};
  for (const kind of ['customers', 'suppliers', 'invoicePriceLists', 'warehouses', 'accounts']) {
    const input = value?.[kind] || DEFAULT_SCOPES[kind];
    const mode = input.mode;
    if (!['all', 'selected'].includes(mode)) {
      const error = new Error(`Choose a valid ${kind} scope.`); error.status = 400; throw error;
    }
    const raw = Array.isArray(input.values) ? input.values : input.values ? [input.values] : [];
    if (raw.length > (['invoicePriceLists', 'warehouses', 'accounts'].includes(kind) ? 5000 : 200)
        || raw.some((entry) => typeof entry !== 'string' || !entry.trim()
        || entry.length > (['invoicePriceLists', 'warehouses', 'accounts'].includes(kind) ? 140 : 100))) {
      const error = new Error(`Choose valid ${kind} categories.`); error.status = 400; throw error;
    }
    scopes[kind] = { mode, values: mode === 'selected' ? [...new Set(raw.map((entry) => entry.trim()))] : [] };
  }
  return scopes;
}

function normalizeInvoicePriceListScope(mode, values) {
  const raw = values === undefined ? [] : Array.isArray(values) ? values : [values];
  if (!['all', 'selected'].includes(mode) || raw.length > 5000
      || raw.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 140)) {
    const error = new Error('Choose valid invoice price lists.'); error.status = 400; throw error;
  }
  return { mode, values: mode === 'selected' ? [...new Set(raw.map((entry) => entry.trim()))] : [] };
}

function migratePermissions(oldPermissions) {
  const old = new Set(Array.isArray(oldPermissions) ? oldPermissions : []);
  const result = new Set(ROUTINE_PERMISSIONS);
  if (old.has('settings.manage')) {
    for (const item of PERMISSIONS.filter((entry) => entry.key.startsWith('masters.'))) result.add(item.key);
  }
  if (old.has('vouchers.cancel')) {
    for (const item of PERMISSIONS.filter((entry) => entry.key.endsWith('.cancel'))) result.add(item.key);
  }
  if (old.has('sync.run')) result.add('sync.run');
  return [...result];
}

function migrateCurrentPermissions(role) {
  const previous = role.permissions_version < 2 ? migratePermissions(role.permissions) : role.permissions;
  const allowed = new Set(PERMISSIONS.map((permission) => permission.key));
  const filtered = previous.filter((permission) => allowed.has(permission)
    || validInvoicePriceListPermission(permission) || validNamedListPermission(permission));
  if (previous.includes('reports.view')) {
    for (const report of REPORTS) if (!filtered.includes(report.permission)) filtered.push(report.permission);
  }
  if (role.permissions_version < 10 && BUILT_IN_ROLES.some((entry) => entry.slug === role.slug)) {
    for (const action of ['view', 'create', 'edit', 'submit', 'cancel', 'delete']) {
      if (filtered.includes(`vouchers.purchases.${action}`)) filtered.push(`vouchers.purchase-orders.${action}`);
    }
  }
  const lowPrivilegeRole = ['standard', 'retail', 'wholesale', 'finance', 'logistics', 'management'].includes(role.slug);
  const matchesRoutine = (list) => filtered.length === list.length
    && filtered.every((permission) => list.includes(permission));
  if (lowPrivilegeRole && (matchesRoutine(PREVIOUS_ROUTINE_PERMISSIONS)
      || matchesRoutine(OLDER_ROUTINE_PERMISSIONS))) return ROUTINE_PERMISSIONS;
  if (role.permissions_version < 6) {
    if (role.slug === 'privileged' || role.slug === 'admin') return PERMISSIONS.map((permission) => permission.key);
    if (filtered.includes('vouchers.journals.create')) {
      filtered.push('vouchers.journals.edit', 'vouchers.journals.submit');
    }
  }
  return filtered;
}

function normalizePermissions(value) {
  const items = value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value];
  const allowed = new Set(PERMISSIONS.map((permission) => permission.key));
  if (items.some((permission) => typeof permission !== 'string' || !allowed.has(permission)
      && !validInvoicePriceListPermission(permission) && !validNamedListPermission(permission))) {
    const error = new Error('Choose valid role permissions.'); error.status = 400; throw error;
  }
  const permissions = new Set(items);
  for (const permission of items) {
    if (/^(masters|vouchers)\.[^.]+\.(create|edit|submit|cancel|delete)$/.test(permission)) {
      permissions.add(permission.replace(/\.(create|edit|submit|cancel|delete)$/, '.view'));
    }
    if (permission.startsWith('payments.sales.')) permissions.add('vouchers.sales.view');
    if (permission.startsWith('payments.purchases.')) permissions.add('vouchers.purchases.view');
    if (permission === 'accounts.manage') permissions.add('accounts.view');
  }
  return [...permissions];
}

function validatePermissionKeys(value) {
  const items = value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value];
  const allowed = new Set(PERMISSIONS.map((permission) => permission.key));
  if (items.some((permission) => typeof permission !== 'string' || !allowed.has(permission)
      && !validInvoicePriceListPermission(permission) && !validNamedListPermission(permission))) {
    const error = new Error('Choose valid permissions.'); error.status = 400; throw error;
  }
  return [...new Set(items)];
}

function applyPermissionOverrides(rolePermissions, grants = [], denials = []) {
  const effective = new Set(Array.isArray(rolePermissions) ? rolePermissions : []);
  for (const permission of Array.isArray(grants) ? grants : []) effective.add(permission);
  for (const permission of Array.isArray(denials) ? denials : []) effective.delete(permission);
  return [...effective];
}

function validInvoicePriceListPermission(permission) {
  const match = /^invoice\.price-list\.(view|create|edit|submit|cancel|delete):(.+)$/.exec(String(permission || ''));
  return Boolean(match && match[2].length <= 140 && match[2] === match[2].trim());
}

function validNamedListPermission(permission) {
  const match = /^(warehouse|account)\.view:(.+)$/.exec(String(permission || ''));
  return Boolean(match && match[2].length <= 140 && match[2] === match[2].trim());
}

function cleanRoleName(value) {
  const name = String(value || '').trim();
  if (name.length < 3 || name.length > 64) {
    const error = new Error('Role name must be 3–64 characters.'); error.status = 400; throw error;
  }
  return name;
}

function roleSlug(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug.length < 3 || slug.length > 64) {
    const error = new Error('Role name must contain at least three letters or numbers.'); error.status = 400; throw error;
  }
  return slug;
}

function usePostgres() {
  return String(process.env.INVOICE_STORE || '').toLowerCase() === 'postgres';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, parts[1], expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

async function readAuthFile() {
  return JSON.parse(await fs.readFile(authFile, 'utf8'));
}

async function writeAuthFile(data) {
  const previous = await readAuthFile();
  for (const collection of ['users', 'roles', 'sessions']) {
    if (Array.isArray(data[collection])) stampRecordList(data[collection], previous[collection]);
  }
  const temporary = `${authFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temporary, authFile);
}

async function initAuth() {
  if (usePostgres()) {
    const pool = getPostgresPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        must_change_password BOOLEAN NOT NULL DEFAULT false,
        role TEXT NOT NULL DEFAULT 'standard',
        permission_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
        permission_denials JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS permission_grants JSONB NOT NULL DEFAULT '[]'::jsonb");
    await pool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS permission_denials JSONB NOT NULL DEFAULT '[]'::jsonb");
    const roleColumn = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'app_users' AND column_name = 'role'
    `);
    if (!roleColumn.rowCount) {
      await pool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'standard'");
      await pool.query(`
        UPDATE app_users SET role = 'admin'
        WHERE id = (SELECT id FROM app_users ORDER BY CASE WHEN username = 'admin' THEN 0 ELSE 1 END, id LIMIT 1)
      `);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_roles (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        scopes JSONB NOT NULL DEFAULT '{"customers":{"mode":"all","values":[]},"suppliers":{"mode":"all","values":[]}}'::jsonb,
        permissions_version INTEGER NOT NULL DEFAULT 10,
        built_in BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '{"customers":{"mode":"all","values":[]},"suppliers":{"mode":"all","values":[]}}'::jsonb`);
    await pool.query('ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS permissions_version INTEGER NOT NULL DEFAULT 1');
    await initRecordAudit(pool, ['app_users', 'app_roles']);
    for (const role of BUILT_IN_ROLES) {
      await pool.query(
        'INSERT INTO app_roles (slug, name, permissions, built_in, permissions_version) VALUES ($1, $2, $3::jsonb, true, 10) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, built_in = true',
        [role.slug, role.name, JSON.stringify(role.permissions)],
      );
    }
    const oldRoles = await pool.query('SELECT slug, permissions, scopes, permissions_version FROM app_roles WHERE permissions_version < 10');
    for (const role of oldRoles.rows) {
      await pool.query('UPDATE app_roles SET permissions = $1::jsonb, scopes = $2::jsonb, permissions_version = 10 WHERE slug = $3',
        [JSON.stringify(migrateCurrentPermissions(role)),
          JSON.stringify(role.permissions_version >= 9 ? role.scopes : DEFAULT_SCOPES), role.slug]);
    }
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_role_fkey') THEN
          ALTER TABLE app_users ADD CONSTRAINT app_users_role_fkey FOREIGN KEY (role) REFERENCES app_roles(slug) ON DELETE RESTRICT;
        END IF;
      END $$
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_user_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS app_user_sessions_user_idx ON app_user_sessions(user_id)');
    await initRecordAudit(pool, ['app_user_sessions']);
    return;
  }
  await fs.mkdir(path.dirname(authFile), { recursive: true });
  try {
    await fs.writeFile(authFile, JSON.stringify({ nextId: 1, users: [], sessions: [] }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const data = await readAuthFile();
  let changed = false;
  if (data.users.some((user) => !user.role)) {
    const first = data.users.find((user) => user.username === 'admin') || data.users[0];
    for (const user of data.users) user.role = user.id === first?.id ? 'admin' : 'standard';
    changed = true;
  }
  if (!Array.isArray(data.roles)) {
    data.roles = [];
    changed = true;
  }
  for (const builtIn of BUILT_IN_ROLES) {
    const role = data.roles.find((row) => row.slug === builtIn.slug);
    if (!role) {
      data.roles.push({ ...builtIn, scopes: structuredClone(DEFAULT_SCOPES), permissions_version: 10, built_in: true });
      changed = true;
    } else if (!role.built_in || role.name !== builtIn.name) {
      role.built_in = true;
      role.name = builtIn.name;
      changed = true;
    }
  }
  for (const role of data.roles) {
    if (!role.permissions_version || role.permissions_version < 10) {
      const previousVersion = role.permissions_version || 1;
      role.permissions = migrateCurrentPermissions({ ...role, permissions_version: role.permissions_version || 1 });
      if (previousVersion < 9) role.scopes = structuredClone(DEFAULT_SCOPES);
      role.permissions_version = 10;
      changed = true;
    }
    if (!role.scopes) { role.scopes = structuredClone(DEFAULT_SCOPES); changed = true; }
  }
  if (changed) await writeAuthFile(data);
}

async function listRoles() {
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(`
      SELECT r.slug, r.name, r.permissions, r.scopes, r.built_in, COUNT(u.id)::int AS user_count
      FROM app_roles r LEFT JOIN app_users u ON u.role = r.slug
      GROUP BY r.slug ORDER BY r.built_in DESC, r.name
    `);
    return rows;
  }
  const data = await readAuthFile();
  return data.roles.map((role) => ({ ...role, user_count: data.users.filter((user) => user.role === role.slug).length }))
    .sort((a, b) => Number(b.built_in) - Number(a.built_in) || a.name.localeCompare(b.name));
}

async function validateRole(role) {
  if (typeof role !== 'string' || !(await listRoles()).some((item) => item.slug === role)) {
    const error = new Error('Choose an existing role.'); error.status = 400; throw error;
  }
  return role;
}

async function createRole(nameValue, permissionValues, scopeValues = DEFAULT_SCOPES) {
  const name = cleanRoleName(nameValue);
  const slug = roleSlug(name);
  const permissions = normalizePermissions(permissionValues);
  const scopes = normalizeScopes(scopeValues);
  if (usePostgres()) {
    try {
      const { rows } = await getPostgresPool().query(
        'INSERT INTO app_roles (slug, name, permissions, scopes, permissions_version) VALUES ($1, $2, $3::jsonb, $4::jsonb, 10) RETURNING slug, name, permissions, scopes, built_in',
        [slug, name, JSON.stringify(permissions), JSON.stringify(scopes)],
      );
      return rows[0];
    } catch (error) {
      if (error.code === '23505') { error.message = 'A role with that name already exists.'; error.status = 409; }
      throw error;
    }
  }
  const data = await readAuthFile();
  if (data.roles.some((role) => role.slug === slug)) {
    const error = new Error('A role with that name already exists.'); error.status = 409; throw error;
  }
  const role = { slug, name, permissions, scopes, permissions_version: 10, built_in: false };
  data.roles.push(role);
  await writeAuthFile(data);
  return role;
}

async function updateRole(slug, nameValue, permissionValues, scopeValues = DEFAULT_SCOPES) {
  const name = cleanRoleName(nameValue);
  const permissions = normalizePermissions(permissionValues);
  const scopes = normalizeScopes(scopeValues);
  if (slug === 'admin') { const error = new Error('Admin permissions cannot be changed.'); error.status = 400; throw error; }
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(
      'UPDATE app_roles SET name = CASE WHEN built_in THEN name ELSE $1 END, permissions = $2::jsonb, scopes = $3::jsonb, permissions_version = 10 WHERE slug = $4 RETURNING slug',
      [name, JSON.stringify(permissions), JSON.stringify(scopes), slug],
    );
    if (!rows[0]) { const error = new Error('Role not found.'); error.status = 404; throw error; }
    return;
  }
  const data = await readAuthFile();
  const role = data.roles.find((row) => row.slug === slug);
  if (!role) { const error = new Error('Role not found.'); error.status = 404; throw error; }
  if (!role.built_in) role.name = name;
  role.permissions = permissions;
  role.scopes = scopes;
  await writeAuthFile(data);
}

async function updateRoleDetails(slug, nameValue, scopeValues) {
  const name = cleanRoleName(nameValue);
  const scopes = scopeValues === undefined ? undefined : normalizeScopes(scopeValues);
  if (slug === 'admin') { const error = new Error('Admin permissions cannot be changed.'); error.status = 400; throw error; }
  if (usePostgres()) {
    const { rowCount } = scopes === undefined
      ? await getPostgresPool().query('UPDATE app_roles SET name = CASE WHEN built_in THEN name ELSE $1 END WHERE slug = $2', [name, slug])
      : await getPostgresPool().query(
        'UPDATE app_roles SET name = CASE WHEN built_in THEN name ELSE $1 END, scopes = $2::jsonb WHERE slug = $3',
        [name, JSON.stringify(scopes), slug],
      );
    if (!rowCount) { const error = new Error('Role not found.'); error.status = 404; throw error; }
    return;
  }
  const data = await readAuthFile();
  const role = data.roles.find((row) => row.slug === slug);
  if (!role) { const error = new Error('Role not found.'); error.status = 404; throw error; }
  if (!role.built_in) role.name = name;
  if (scopes !== undefined) role.scopes = scopes;
  await writeAuthFile(data);
}

const INVOICE_PRICE_LIST_TYPE_PREFIX = 'invoice-price-list:';
const INVOICE_PRICE_LIST_ACTIONS = ['create', 'view', 'edit', 'submit', 'cancel', 'delete'];
const invoicePriceListPermission = (action, name) => `invoice.price-list.${action}:${name}`;
const NAMED_LISTS = [
  { prefix: 'warehouse:', scope: 'warehouses', permission: 'warehouse.view:',
    query: 'SELECT warehouse AS name FROM app_master_warehouses WHERE is_group = false ORDER BY warehouse' },
  { prefix: 'account:', scope: 'accounts', permission: 'account.view:',
    query: 'SELECT id::text AS name FROM app_accounts ORDER BY account_code, account_name' },
];

function nextInvoicePriceListScope(current, activeNames, name, grant) {
  const values = new Set(current?.mode === 'selected' ? current.values || [] : activeNames);
  if (grant) values.add(name); else values.delete(name);
  return normalizeInvoicePriceListScope('selected', [...values]);
}

async function saveRoleNamedListPermissions(slug, typeKey, actions) {
  if (slug === 'admin') { const error = new Error('Admin permissions cannot be changed.'); error.status = 400; throw error; }
  const type = NAMED_LISTS.find((item) => String(typeKey || '').startsWith(item.prefix));
  const name = type && String(typeKey).slice(type.prefix.length);
  if (!type || !name || !usePostgres() || actions.some((action) => action !== 'view')) {
    const error = new Error('Choose valid list permissions.'); error.status = 400; throw error;
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const lists = (await client.query(type.query)).rows.map((row) => row.name);
    if (!lists.includes(name)) { const error = new Error('Choose an existing list entry.'); error.status = 400; throw error; }
    const { rows } = await client.query('SELECT scopes FROM app_roles WHERE slug = $1 FOR UPDATE', [slug]);
    if (!rows[0]) { const error = new Error('Role not found.'); error.status = 404; throw error; }
    const scope = nextInvoicePriceListScope(rows[0].scopes?.[type.scope], lists, name, actions.includes('view'));
    await client.query(`UPDATE app_roles SET scopes = jsonb_set(COALESCE(scopes, '{}'::jsonb),
      $1::text[], $2::jsonb, true) WHERE slug = $3`, [[type.scope], JSON.stringify(scope), slug]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function saveRoleInvoicePriceListPermissions(slug, typeKey, actions) {
  if (slug === 'admin') { const error = new Error('Admin permissions cannot be changed.'); error.status = 400; throw error; }
  const name = String(typeKey || '').startsWith(INVOICE_PRICE_LIST_TYPE_PREFIX)
    ? String(typeKey).slice(INVOICE_PRICE_LIST_TYPE_PREFIX.length) : '';
  if (!name || !usePostgres() || actions.some((action) => !INVOICE_PRICE_LIST_ACTIONS.includes(action))) {
    const error = new Error('Choose valid price list permissions.'); error.status = 400; throw error;
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: lists } = await client.query(`
      SELECT price_list FROM app_master_price_lists
      WHERE currency = 'UGX'
        AND price_type IN ('selling', 'both') ORDER BY price_list`);
    if (!lists.some((row) => row.price_list === name)) {
      const error = new Error('Choose an active UGX selling price list.'); error.status = 400; throw error;
    }
    const { rows } = await client.query('SELECT scopes, permissions FROM app_roles WHERE slug = $1 FOR UPDATE', [slug]);
    if (!rows[0]) { const error = new Error('Role not found.'); error.status = 404; throw error; }
    const current = rows[0].scopes?.invoicePriceLists;
    const scope = nextInvoicePriceListScope(current, lists.map((row) => row.price_list), name, actions.length > 0);
    const rowPermissions = new Set(INVOICE_PRICE_LIST_ACTIONS.map((action) => invoicePriceListPermission(action, name)));
    const permissions = normalizePermissions([
      ...rows[0].permissions.filter((key) => !rowPermissions.has(key)),
      ...actions.filter((action) => action !== 'view').map((action) => invoicePriceListPermission(action, name)),
    ]);
    await client.query(`UPDATE app_roles SET scopes = jsonb_set(COALESCE(scopes, '{}'::jsonb),
      '{invoicePriceLists}', $1::jsonb, true), permissions = $2::jsonb WHERE slug = $3`,
    [JSON.stringify(scope), JSON.stringify(permissions), slug]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function mutateRolePermissions(slug, change) {
  if (slug === 'admin') { const error = new Error('Admin permissions cannot be changed.'); error.status = 400; throw error; }
  if (usePostgres()) {
    const client = await getPostgresPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT permissions FROM app_roles WHERE slug = $1 FOR UPDATE', [slug]);
      if (!rows[0]) { const error = new Error('Role not found.'); error.status = 404; throw error; }
      const permissions = normalizePermissions(change(rows[0].permissions));
      await client.query('UPDATE app_roles SET permissions = $1::jsonb WHERE slug = $2', [JSON.stringify(permissions), slug]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return;
  }
  const data = await readAuthFile();
  const role = data.roles.find((row) => row.slug === slug);
  if (!role) { const error = new Error('Role not found.'); error.status = 404; throw error; }
  role.permissions = normalizePermissions(change(role.permissions));
  await writeAuthFile(data);
}

async function saveRoleRecordPermissions(slug, typeKey, actionValues) {
  const namedType = NAMED_LISTS.find((item) => String(typeKey || '').startsWith(item.prefix));
  if (namedType) {
    const actions = actionValues === undefined ? [] : Array.isArray(actionValues) ? actionValues : [actionValues];
    if (!actions.length) { const error = new Error('Choose Read, or remove the row.'); error.status = 400; throw error; }
    return saveRoleNamedListPermissions(slug, typeKey, actions);
  }
  if (String(typeKey || '').startsWith(INVOICE_PRICE_LIST_TYPE_PREFIX)) {
    const actions = actionValues === undefined ? [] : Array.isArray(actionValues) ? actionValues : [actionValues];
    if (!actions.length) { const error = new Error('Choose at least one permission, or remove the row.'); error.status = 400; throw error; }
    return saveRoleInvoicePriceListPermissions(slug, typeKey, actions);
  }
  const type = ROLE_RECORD_TYPES.find((item) => item.key === typeKey);
  if (!type) { const error = new Error('Choose a valid record type.'); error.status = 400; throw error; }
  const actions = actionValues === undefined ? [] : Array.isArray(actionValues) ? actionValues : [actionValues];
  if (actions.some((action) => !type.actions.includes(action))) {
    const error = new Error('Choose valid actions for this record type.'); error.status = 400; throw error;
  }
  if (!actions.length) { const error = new Error('Choose at least one permission, or remove the row.'); error.status = 400; throw error; }
  const rowPermissions = new Set(Object.values(type.permissions));
  await mutateRolePermissions(slug, (current) => [
    ...current.filter((permission) => !rowPermissions.has(permission)),
    ...actions.map((action) => type.permissions[action]),
  ]);
}

async function removeRoleRecordPermissions(slug, typeKey) {
  if (NAMED_LISTS.some((item) => String(typeKey || '').startsWith(item.prefix))) {
    return saveRoleNamedListPermissions(slug, typeKey, []);
  }
  if (String(typeKey || '').startsWith(INVOICE_PRICE_LIST_TYPE_PREFIX)) {
    return saveRoleInvoicePriceListPermissions(slug, typeKey, []);
  }
  const type = ROLE_RECORD_TYPES.find((item) => item.key === typeKey);
  if (!type) {
    const error = new Error('Choose a valid record type.'); error.status = 400; throw error;
  }
  const rowPermissions = new Set(Object.values(type.permissions));
  await mutateRolePermissions(slug, (current) => current.filter((permission) =>
    !rowPermissions.has(permission)
    && !(typeKey === 'vouchers.sales' && permission.startsWith('payments.sales.'))
    && !(typeKey === 'vouchers.purchases' && permission.startsWith('payments.purchases.'))
    && !(typeKey === 'chart-of-accounts' && permission === 'accounts.manage')));
}

async function saveRoleExtraPermissions(slug, values) {
  const items = values === undefined ? [] : Array.isArray(values) ? values : [values];
  const allowed = new Set(EXTRA_PERMISSIONS.map((permission) => permission.key));
  if (items.some((item) => !allowed.has(item))) {
    const error = new Error('Choose valid additional permissions.'); error.status = 400; throw error;
  }
  await mutateRolePermissions(slug, (current) => [...current.filter((permission) => !allowed.has(permission)), ...items]);
}

async function deleteRole(slug) {
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(
      'DELETE FROM app_roles WHERE slug = $1 AND built_in = false AND NOT EXISTS (SELECT 1 FROM app_users WHERE role = $1) RETURNING slug',
      [slug],
    );
    if (!rows[0]) { const error = new Error('Role not found or still assigned to users.'); error.status = 400; throw error; }
    return;
  }
  const data = await readAuthFile();
  const role = data.roles.find((row) => row.slug === slug && !row.built_in);
  if (!role || data.users.some((user) => user.role === slug)) {
    const error = new Error('Role not found or still assigned to users.'); error.status = 400; throw error;
  }
  data.roles = data.roles.filter((row) => row.slug !== slug);
  await writeAuthFile(data);
}

async function userCount() {
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query('SELECT COUNT(*)::int AS count FROM app_users');
    return rows[0].count;
  }
  return (await readAuthFile()).users.length;
}

function cleanUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    const error = new Error('Username must be 3–64 letters, numbers, dots, underscores, or hyphens.');
    error.status = 400;
    throw error;
  }
  return username;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    const error = new Error(`Password must have at least ${PASSWORD_MIN_LENGTH} characters.`);
    error.status = 400;
    throw error;
  }
}

async function createUser(usernameValue, password, options = {}) {
  const username = cleanUsername(usernameValue);
  validatePassword(password);
  const hash = await passwordHash(password);
  const mustChange = Boolean(options.mustChangePassword);
  const role = options.role ? await validateRole(options.role) : await userCount() === 0 ? 'admin' : 'standard';
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(
      'INSERT INTO app_users (username, password_hash, must_change_password, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
      [username, hash, mustChange, role],
    );
    return rows[0];
  }
  const data = await readAuthFile();
  if (data.users.some((user) => user.username === username)) {
    const error = new Error('Username already exists.');
    error.status = 409;
    throw error;
  }
  const user = { id: data.nextId++, username, password_hash: hash, active: true, must_change_password: mustChange, role,
    permission_grants: [], permission_denials: [] };
  data.users.push(user);
  await writeAuthFile(data);
  return { id: user.id, username: user.username, role: user.role };
}

async function findUser(username) {
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(
      'SELECT id, username, password_hash, active, must_change_password, role FROM app_users WHERE username = $1',
      [username],
    );
    return rows[0] || null;
  }
  return (await readAuthFile()).users.find((user) => user.username === username) || null;
}

async function authenticate(usernameValue, password) {
  const username = String(usernameValue || '').trim().toLowerCase();
  const user = await findUser(username);
  if (!user || !user.active) {
    await scrypt(String(password || ''), 'work-master-missing-user', 64);
    return null;
  }
  if (!await verifyPassword(String(password || ''), user.password_hash)) return null;
  return { id: Number(user.id), username: user.username, role: user.role, must_change_password: Boolean(user.must_change_password) };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  if (usePostgres()) {
    await getPostgresPool().query('DELETE FROM app_user_sessions WHERE expires_at <= now()');
    await getPostgresPool().query(
      'INSERT INTO app_user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hash, userId, expiresAt],
    );
  } else {
    const data = await readAuthFile();
    data.sessions = data.sessions.filter((session) => Date.parse(session.expires_at) > Date.now());
    data.sessions.push({ token_hash: hash, user_id: userId, expires_at: expiresAt.toISOString() });
    await writeAuthFile(data);
  }
  return token;
}

async function sessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const hash = tokenHash(token);
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(`
      SELECT u.id, u.username, u.must_change_password, u.role, u.permission_grants, u.permission_denials,
             COALESCE(r.name, u.role) AS role_name,
             COALESCE(r.permissions, '[]'::jsonb) AS permissions,
             COALESCE(r.scopes, '{"customers":{"mode":"all","values":[]},"suppliers":{"mode":"all","values":[]}}'::jsonb) AS scopes
      FROM app_user_sessions s
      JOIN app_users u ON u.id = s.user_id
      LEFT JOIN app_roles r ON r.slug = u.role
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true
    `, [hash]);
    const user = rows[0];
    if (user) user.permissions = applyPermissionOverrides(user.permissions, user.permission_grants, user.permission_denials);
    return user || null;
  }
  const data = await readAuthFile();
  const session = data.sessions.find((row) => row.token_hash === hash && Date.parse(row.expires_at) > Date.now());
  const user = session && data.users.find((row) => row.id === session.user_id && row.active);
  const role = user && data.roles.find((row) => row.slug === user.role);
  return user ? { id: user.id, username: user.username, role: user.role, role_name: role?.name || user.role,
    permissions: applyPermissionOverrides(role?.permissions || [], user.permission_grants, user.permission_denials),
    permission_grants: user.permission_grants || [], permission_denials: user.permission_denials || [],
    scopes: role?.scopes || DEFAULT_SCOPES,
    must_change_password: user.must_change_password } : null;
}

async function listUsers() {
  if (usePostgres()) {
    const { rows } = await getPostgresPool().query(
      'SELECT id, username, role, active, must_change_password, permission_grants, permission_denials, created_at FROM app_users ORDER BY username',
    );
    return rows;
  }
  return (await readAuthFile()).users.map(({ id, username, role, active, must_change_password, permission_grants, permission_denials }) => (
    { id, username, role, active, must_change_password, permission_grants: permission_grants || [], permission_denials: permission_denials || [] }
  )).sort((a, b) => a.username.localeCompare(b.username));
}

async function saveUserPermissionOverrides(targetId, grants, denials) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id < 1) { const error = new Error('User not found.'); error.status = 404; throw error; }
  const additions = validatePermissionKeys(grants);
  const removals = validatePermissionKeys(denials);
  if (additions.some((key) => removals.includes(key))) {
    const error = new Error('A permission cannot be both allowed and denied.'); error.status = 400; throw error;
  }
  if (usePostgres()) {
    const result = await getPostgresPool().query(
      `UPDATE app_users SET permission_grants = $1::jsonb, permission_denials = $2::jsonb
       WHERE id = $3 AND role <> 'admin'`, [JSON.stringify(additions), JSON.stringify(removals), id],
    );
    if (!result.rowCount) { const error = new Error('User not found or has full Admin access.'); error.status = 404; throw error; }
    return;
  }
  const data = await readAuthFile();
  const user = data.users.find((row) => row.id === id && row.role !== 'admin');
  if (!user) { const error = new Error('User not found or has full Admin access.'); error.status = 404; throw error; }
  user.permission_grants = additions;
  user.permission_denials = removals;
  await writeAuthFile(data);
}

async function updateUserAccess(actorId, targetId, changes) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('User not found.'); error.status = 404; throw error;
  }
  if (changes.role !== undefined) await validateRole(changes.role);
  if (changes.active !== undefined && typeof changes.active !== 'boolean') {
    const error = new Error('Invalid account status.'); error.status = 400; throw error;
  }
  if (usePostgres()) {
    const client = await getPostgresPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724091)');
      const { rows } = await client.query('SELECT id, role, active FROM app_users WHERE id = $1 FOR UPDATE', [id]);
      const user = rows[0];
      if (!user) { const error = new Error('User not found.'); error.status = 404; throw error; }
      const role = changes.role ?? user.role;
      const active = changes.active ?? user.active;
      if (Number(actorId) === id && (role !== 'admin' || !active)) {
        const error = new Error('You cannot remove your own admin access.'); error.status = 400; throw error;
      }
      if (user.role === 'admin' && user.active && (role !== 'admin' || !active)) {
        const count = await client.query("SELECT COUNT(*)::int AS n FROM app_users WHERE role = 'admin' AND active = true");
        if (count.rows[0].n <= 1) {
          const error = new Error('At least one active admin is required.'); error.status = 400; throw error;
        }
      }
      if (role === user.role && active === user.active) {
        await client.query('COMMIT');
        return;
      }
      await client.query('UPDATE app_users SET role = $1, active = $2 WHERE id = $3', [role, active, id]);
      await client.query('DELETE FROM app_user_sessions WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return;
  }
  const data = await readAuthFile();
  const user = data.users.find((row) => row.id === id);
  if (!user) { const error = new Error('User not found.'); error.status = 404; throw error; }
  const role = changes.role ?? user.role;
  const active = changes.active ?? user.active;
  if (Number(actorId) === id && (role !== 'admin' || !active)) {
    const error = new Error('You cannot remove your own admin access.'); error.status = 400; throw error;
  }
  if (user.role === 'admin' && user.active && (role !== 'admin' || !active)
      && data.users.filter((row) => row.role === 'admin' && row.active).length <= 1) {
    const error = new Error('At least one active admin is required.'); error.status = 400; throw error;
  }
  if (role === user.role && active === user.active) return;
  user.role = role;
  user.active = active;
  data.sessions = data.sessions.filter((session) => session.user_id !== id);
  await writeAuthFile(data);
}

async function deleteSession(token) {
  if (!token) return;
  const hash = tokenHash(token);
  if (usePostgres()) {
    await getPostgresPool().query('DELETE FROM app_user_sessions WHERE token_hash = $1', [hash]);
  } else {
    const data = await readAuthFile();
    data.sessions = data.sessions.filter((session) => session.token_hash !== hash);
    await writeAuthFile(data);
  }
}

async function changePassword(userId, oldPassword, newPassword) {
  validatePassword(newPassword);
  if (usePostgres()) {
    const pool = getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      if (!rows[0] || !await verifyPassword(oldPassword, rows[0].password_hash)) {
        const error = new Error('Current password is incorrect.');
        error.status = 400;
        throw error;
      }
      await client.query('UPDATE app_users SET password_hash = $1, must_change_password = false WHERE id = $2', [await passwordHash(newPassword), userId]);
      await client.query('DELETE FROM app_user_sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  const data = await readAuthFile();
  const user = data.users.find((row) => row.id === userId);
  if (!user || !await verifyPassword(oldPassword, user.password_hash)) {
    const error = new Error('Current password is incorrect.');
    error.status = 400;
    throw error;
  }
  user.password_hash = await passwordHash(newPassword);
  user.must_change_password = false;
  data.sessions = data.sessions.filter((session) => session.user_id !== userId);
  await writeAuthFile(data);
}

async function resetUserPassword(usernameValue, newPassword) {
  const username = cleanUsername(usernameValue);
  validatePassword(newPassword);
  const hash = await passwordHash(newPassword);
  if (usePostgres()) {
    const pool = getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'UPDATE app_users SET password_hash = $1, must_change_password = true WHERE username = $2 RETURNING id',
        [hash, username],
      );
      if (!rows[0]) {
        const error = new Error('Username does not exist. Use user:create to add it.');
        error.status = 404;
        throw error;
      }
      await client.query('DELETE FROM app_user_sessions WHERE user_id = $1', [rows[0].id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  const data = await readAuthFile();
  const user = data.users.find((row) => row.username === username);
  if (!user) {
    const error = new Error('Username does not exist. Use user:create to add it.');
    error.status = 404;
    throw error;
  }
  user.password_hash = hash;
  user.must_change_password = true;
  data.sessions = data.sessions.filter((session) => session.user_id !== user.id);
  await writeAuthFile(data);
}

module.exports = {
  SESSION_DAYS,
  initAuth,
  userCount,
  createUser,
  authenticate,
  createSession,
  sessionUser,
  deleteSession,
  changePassword,
  resetUserPassword,
  PERMISSIONS,
  normalizePermissions,
  applyPermissionOverrides,
  ROLE_RECORD_TYPES,
  RECORD_ACTIONS,
  EXTRA_PERMISSIONS,
  DEFAULT_SCOPES,
  nextInvoicePriceListScope,
  listRoles,
  createRole,
  updateRole,
  updateRoleDetails,
  saveRoleRecordPermissions,
  removeRoleRecordPermissions,
  saveRoleExtraPermissions,
  deleteRole,
  listUsers,
  saveUserPermissionOverrides,
  updateUserAccess,
};
