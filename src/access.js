const { getPostgresPool, findInvoice } = require('./store');
const { purchaseForPayment } = require('./purchases');

function selectedCategories(user, kind) {
  if (user?.role === 'admin') return null;
  const scope = user?.scopes?.[kind];
  if (!scope || scope.mode !== 'selected') return null;
  return Array.isArray(scope.values) ? scope.values.map((value) => String(value).trim().toLowerCase()) : [];
}

function scopeRestricted(user, kind) {
  return selectedCategories(user, kind) !== null;
}

function anyScopeRestricted(user) {
  return scopeRestricted(user, 'customers') || scopeRestricted(user, 'suppliers');
}

function categoryAllowed(user, kind, category) {
  const selected = selectedCategories(user, kind);
  return selected === null || selected.includes(String(category || '').trim().toLowerCase());
}

function allowedInvoicePriceLists(user) {
  if (user?.role === 'admin') return null;
  const scope = user?.scopes?.invoicePriceLists;
  if (!scope || scope.mode !== 'selected') return null;
  const names = new Set(Array.isArray(scope.values) ? scope.values : []);
  for (const permission of user?.permission_grants || []) {
    if (permission.startsWith('invoice.price-list.view:')) names.add(permission.slice('invoice.price-list.view:'.length));
  }
  for (const permission of user?.permission_denials || []) {
    if (permission.startsWith('invoice.price-list.view:')) names.delete(permission.slice('invoice.price-list.view:'.length));
  }
  return [...names];
}

function namedListAllowed(user, kind, value) {
  if (user?.role === 'admin') return true;
  const name = String(value || '').trim();
  const permission = `${kind === 'warehouses' ? 'warehouse' : 'account'}.view:${name}`;
  if (user?.permission_denials?.includes(permission)) return false;
  if (user?.permission_grants?.includes(permission)) return true;
  const scope = user?.scopes?.[kind];
  return scope?.mode !== 'selected' || (scope.values || []).includes(name);
}

function warehouseAllowed(user, name) { return namedListAllowed(user, 'warehouses', name); }
function accountAllowed(user, id) { return namedListAllowed(user, 'accounts', id); }

function allowedNamedListValues(user, kind) {
  if (user?.role === 'admin') return null;
  const scope = user?.scopes?.[kind];
  if (scope?.mode !== 'selected') return null;
  const prefix = kind === 'warehouses' ? 'warehouse.view:' : 'account.view:';
  const names = new Set(scope.values || []);
  for (const permission of user?.permission_grants || []) {
    if (permission.startsWith(prefix)) names.add(permission.slice(prefix.length));
  }
  for (const permission of user?.permission_denials || []) {
    if (permission.startsWith(prefix)) names.delete(permission.slice(prefix.length));
  }
  return [...names];
}

function deniedNamedListValues(user, kind) {
  const prefix = kind === 'warehouses' ? 'warehouse.view:' : 'account.view:';
  return (user?.permission_denials || []).filter((permission) => permission.startsWith(prefix))
    .map((permission) => permission.slice(prefix.length));
}

function anyNamedListView(user, kind) {
  if (user?.role === 'admin') return true;
  const allowed = allowedNamedListValues(user, kind);
  if (allowed !== null) return allowed.length > 0;
  const generic = kind === 'warehouses'
    ? ['masters.warehouses.view', 'vouchers.sales.create', 'vouchers.purchases.create', 'vouchers.purchase-orders.create', 'vouchers.stock.create']
    : ['accounts.view', 'vouchers.journals.create'];
  const prefix = kind === 'warehouses' ? 'warehouse.view:' : 'account.view:';
  return Boolean(generic.some((permission) => user?.permissions?.includes(permission))
    || user?.permission_grants?.some((permission) => permission.startsWith(prefix)));
}

function namedListRestricted(user, kind) {
  return user?.role !== 'admin' && (user?.scopes?.[kind]?.mode === 'selected'
    || deniedNamedListValues(user, kind).length > 0);
}

async function voucherWarehousesAllowed(user, kind, id) {
  if (!namedListRestricted(user, 'warehouses')) return true;
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return false;
  if (kind === 'sales') {
    const invoice = await findInvoice(id);
    return Boolean(invoice && (invoice.items || []).every((item) => !item.warehouse || warehouseAllowed(user, item.warehouse)));
  }
  const tables = { purchases: ['app_purchase_items', 'purchase_id'], 'purchase-orders': ['app_purchase_order_items', 'purchase_order_id'], stock: ['app_stock_entry_items', 'stock_entry_id'] };
  const [table, column] = tables[kind] || [];
  if (!table) return true;
  const { rows } = await getPostgresPool().query(
    `SELECT warehouse${kind === 'stock' ? ', target_warehouse' : ''} FROM ${table} WHERE ${column} = $1`, [id],
  );
  return rows.every((row) => (!row.warehouse || warehouseAllowed(user, row.warehouse))
    && (!row.target_warehouse || warehouseAllowed(user, row.target_warehouse)));
}

async function journalAccountsAllowed(user, id) {
  if (!namedListRestricted(user, 'accounts')) return true;
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return false;
  const { rows } = await getPostgresPool().query(
    'SELECT account_id::text AS account_id FROM app_journal_entry_lines WHERE journal_entry_id = $1', [id],
  );
  return rows.every((row) => accountAllowed(user, row.account_id));
}

function invoicePriceListAllowed(user, name) {
  if (user?.role === 'admin') return true;
  const permission = `invoice.price-list.view:${String(name || '').trim()}`;
  if (user?.permission_denials?.includes(permission)) return false;
  if (user?.permission_grants?.includes(permission)) return true;
  const allowed = allowedInvoicePriceLists(user);
  return allowed === null || allowed.includes(String(name || '').trim());
}

function requireInvoicePriceList(user, name) {
  if (invoicePriceListAllowed(user, name)) return;
  const error = new Error('This role cannot use the selected invoice price list.');
  error.status = 403;
  throw error;
}

function priceListActionAllowed(user, name, action) {
  if (user?.role === 'admin') return true;
  if (action === 'view') return invoicePriceListAllowed(user, name);
  if (!invoicePriceListAllowed(user, name)) return false;
  if (user?.permission_denials?.includes(`invoice.price-list.${action}:${String(name || '').trim()}`)) return false;
  return Boolean(user?.permissions?.includes(action === 'create' ? 'masters.item-prices.create' : `masters.price-lists.${action}`)
    || user?.permissions?.includes(`invoice.price-list.${action}:${String(name || '').trim()}`));
}

function anyNamedPriceListAction(user, action) {
  if (action === 'view') {
    const allowed = allowedInvoicePriceLists(user);
    return allowed === null ? user?.role === 'admin' || Boolean(user?.permissions?.some((key) =>
      ['vouchers.sales.create', 'vouchers.sales.edit', 'masters.price-lists.view'].includes(key)))
      || Boolean(user?.permission_grants?.some((key) => key.startsWith('invoice.price-list.view:')))
      : allowed.length > 0;
  }
  return user?.role === 'admin' || Boolean(user?.permissions?.some((key) =>
    key.startsWith(`invoice.price-list.${action}:`)));
}

function namedPriceListsForActions(user, actions) {
  const names = new Set();
  for (const key of user?.permissions || []) {
    for (const action of actions) {
      const prefix = `invoice.price-list.${action}:`;
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
  }
  return [...names];
}

async function masterRecordAllowed(user, kind, id) {
  if (!scopeRestricted(user, kind)) return true;
  const value = String(id || '').trim();
  if (!value) return false;
  const customer = kind === 'customers';
  const table = customer ? 'app_master_customers' : 'app_master_suppliers';
  const idField = customer ? 'customer_id' : 'supplier_id';
  const categoryField = customer ? 'customer_group' : 'supplier_type';
  const { rows } = await getPostgresPool().query(
    `SELECT ${categoryField} AS category FROM ${table} WHERE ${idField} = $1 LIMIT 1`, [value],
  );
  return Boolean(rows[0] && categoryAllowed(user, kind, rows[0].category));
}

async function invoiceAllowed(user, id) {
  if (!scopeRestricted(user, 'customers')) return true;
  const invoice = await findInvoice(id);
  return Boolean(invoice && await masterRecordAllowed(user, 'customers', invoice.customer_id));
}

async function purchaseAllowed(user, id) {
  if (!scopeRestricted(user, 'suppliers')) return true;
  const { rows } = await getPostgresPool().query('SELECT supplier_id FROM app_purchases WHERE id = $1', [id]);
  return Boolean(rows[0] && await masterRecordAllowed(user, 'suppliers', rows[0].supplier_id));
}

async function purchaseOrderAllowed(user, id) {
  if (!scopeRestricted(user, 'suppliers')) return true;
  const { rows } = await getPostgresPool().query('SELECT supplier_id FROM app_purchase_orders WHERE id = $1', [id]);
  return Boolean(rows[0] && await masterRecordAllowed(user, 'suppliers', rows[0].supplier_id));
}

async function purchasePaymentAllowed(user, paymentId) {
  if (!scopeRestricted(user, 'suppliers')) return true;
  try { return purchaseAllowed(user, await purchaseForPayment(paymentId)); }
  catch (error) { if (error.status === 404) return false; throw error; }
}

module.exports = {
  selectedCategories,
  scopeRestricted,
  anyScopeRestricted,
  categoryAllowed,
  allowedInvoicePriceLists,
  invoicePriceListAllowed,
  namedListAllowed,
  warehouseAllowed,
  accountAllowed,
  allowedNamedListValues,
  deniedNamedListValues,
  anyNamedListView,
  namedListRestricted,
  voucherWarehousesAllowed,
  journalAccountsAllowed,
  requireInvoicePriceList,
  priceListActionAllowed,
  anyNamedPriceListAction,
  namedPriceListsForActions,
  masterRecordAllowed,
  invoiceAllowed,
  purchaseAllowed,
  purchaseOrderAllowed,
  purchasePaymentAllowed,
};
