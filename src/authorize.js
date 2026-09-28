const {
  anyScopeRestricted,
  scopeRestricted,
  categoryAllowed,
  masterRecordAllowed,
  invoiceAllowed,
  purchaseAllowed,
  purchasePaymentAllowed,
  priceListActionAllowed,
  anyNamedPriceListAction,
  warehouseAllowed,
  accountAllowed,
  anyNamedListView,
  voucherWarehousesAllowed,
  journalAccountsAllowed,
} = require('./access');
const { REPORTS } = require('./report-permissions');

const MASTER_KEYS = new Set(['customers', 'suppliers', 'items', 'warehouses', 'employees', 'options', 'price-lists', 'item-prices']);

function can(user, permission) {
  return user?.role === 'admin' || Array.isArray(user?.permissions) && user.permissions.includes(permission);
}

function canAny(user, permissions) {
  return permissions.some((permission) => can(user, permission));
}

function permissionCheck(req) {
  const user = req.currentUser;
  const parts = req.path.split('/').filter(Boolean);
  const method = req.method;
  const has = (key) => can(user, key);
  const all = (...keys) => keys.every(has);

  if (!parts.length) return true;
  if (parts[0] === 'settings') {
    if (parts[1] === 'company-information') return user.role === 'admin';
    if (parts[1] === 'erpnext-sync') return has('sync.run');
    if (parts[1] === 'users' || parts[1] === 'roles') return user.role === 'admin';
    if (parts.length === 1) return user.role === 'admin' || has('sync.run')
      || [...MASTER_KEYS].some((key) => has(`masters.${key}.view`))
      || anyNamedListView(user, 'warehouses')
      || ['view', 'create', 'edit', 'submit', 'cancel', 'delete'].some((action) => anyNamedPriceListAction(user, action));
    const list = parts[1];
    if (!MASTER_KEYS.has(list)) return false;
    const prefix = `masters.${list}.`;
    if (list === 'price-lists') {
      if (parts.length === 2) return method === 'GET' && (has(prefix + 'view')
        || ['view', 'edit', 'submit', 'cancel', 'delete'].some((action) => anyNamedPriceListAction(user, action)))
        || method === 'POST' && has(prefix + 'create');
      if (parts[2] === 'new') return method === 'GET' && has(prefix + 'create');
      const name = decodeURIComponent(parts[2] || '');
      if (parts[3] === 'edit') return method === 'GET' && priceListActionAllowed(user, name, 'edit');
      if (parts[3] === 'active') return method === 'POST'
        && priceListActionAllowed(user, name, req.body.active === '1' ? 'submit' : 'cancel');
      if (parts[3] === 'delete') return method === 'POST' && priceListActionAllowed(user, name, 'delete');
      if (parts.length === 3) return method === 'POST'
        ? priceListActionAllowed(user, name, 'edit') : priceListActionAllowed(user, name, 'view');
      return false;
    }
    if (list === 'item-prices' && anyNamedPriceListAction(user, 'create')) {
      if (parts.length === 2 && method === 'GET') return true;
      if (parts.length === 2 && method === 'POST') return has(prefix + 'create')
        || priceListActionAllowed(user, req.body.price_list, 'create');
      if (parts[2] === 'new' && method === 'GET') return true;
    }
    if (list === 'warehouses' && parts.length === 2 && method === 'GET') {
      return has(prefix + 'view') || anyNamedListView(user, 'warehouses');
    }
    if (list === 'warehouses' && parts.length === 3 && method === 'GET') {
      return (has(prefix + 'view') || anyNamedListView(user, 'warehouses'))
        && warehouseAllowed(user, decodeURIComponent(parts[2]));
    }
    if (parts.length === 2) return has(prefix + (method === 'POST' ? 'create' : 'view'));
    if (parts[2] === 'new') return method === 'GET' && has(prefix + 'create');
    if (parts[3] === 'edit') return method === 'GET' && has(prefix + 'edit');
    if (parts[3] === 'active') return method === 'POST' && has(prefix + (req.body.active === '1' ? 'submit' : 'cancel'));
    if (parts[3] === 'delete') return method === 'POST' && has(prefix + 'delete');
    if (parts.length === 3) return has(prefix + (method === 'POST' ? 'edit' : 'view'));
    return false;
  }
  if (parts[0] === 'invoices') {
    const prefix = 'vouchers.sales.';
    if (parts.length === 1 && method === 'POST') {
      if (req.body.action === 'cash_sale') {
        return all(prefix + 'create', prefix + 'submit', 'payments.sales.record');
      }
      if (req.body.action === 'submit_invoice') {
        return all(prefix + 'create', prefix + 'submit');
      }
      return has(prefix + 'create');
    }
    if (parts.length === 1) return has(prefix + 'view');
    if (parts[1] === 'new') return has(prefix + 'create');
    if (parts[2] === 'payments') return has('payments.sales.' + (parts[4] === 'cancel' ? 'cancel' : 'record'));
    if (parts[2] === 'edit') return has(prefix + 'edit');
    if (parts[2] === 'submit') return has(prefix + 'submit');
    if (parts[2] === 'submit-cash-sale') return all(prefix + 'submit', 'payments.sales.record');
    if (parts[2] === 'cancel') return has(prefix + 'cancel');
    if (parts[2] === 'delete') return method === 'POST' && has(prefix + 'delete');
    if (parts.length === 2 && method === 'POST') {
      if (req.body.action === 'cash_sale') return all(prefix + 'edit', prefix + 'submit', 'payments.sales.record');
      if (req.body.action === 'submit_invoice') return all(prefix + 'edit', prefix + 'submit');
      return has(prefix + 'edit');
    }
    return has(prefix + (method === 'POST' ? 'edit' : 'view'));
  }
  if (parts[0] === 'purchases') {
    const prefix = 'vouchers.purchases.';
    if (parts.length === 1) return has(prefix + (method === 'POST' ? 'create' : 'view'));
    if (parts[1] === 'new') return has(prefix + 'create');
    if (parts[1] === 'payments') return has(prefix + 'view');
    if (parts[2] === 'payments') return has('payments.purchases.' + (parts[4] === 'cancel' ? 'cancel' : 'record'));
    if (parts[2] === 'edit') return has(prefix + 'edit');
    if (parts[2] === 'submit') return has(prefix + 'submit');
    if (parts[2] === 'cancel') return has(prefix + 'cancel');
    if (parts[2] === 'delete') return method === 'POST' && has(prefix + 'delete');
    return has(prefix + (method === 'POST' ? 'edit' : 'view'));
  }
  if (parts[0] === 'stock') {
    const prefix = 'vouchers.stock.';
    if (parts.length === 1) return has(prefix + 'view');
    if (parts[1] !== 'entries') return false;
    if (parts[2] === 'new') return has(prefix + 'create');
    if (parts.length === 2 && method === 'POST') {
      return all(prefix + 'create', ...(req.body.action === 'save_draft' ? [] : [prefix + 'submit']),
        ...(req.body.entry_type === 'cancel' ? [prefix + 'cancel'] : []));
    }
    if (parts[3] === 'cancel') return has(prefix + 'cancel');
    if (parts[3] === 'delete') return method === 'POST' && has(prefix + 'delete');
    if (parts[3] === 'supplier') return has(prefix + 'edit');
    if (parts[3] === 'edit') return has(prefix + 'edit');
    if (parts.length === 3 && method === 'POST') {
      return all(prefix + 'edit', ...(req.body.action === 'save_draft' ? [] : [prefix + 'submit']),
        ...(req.body.entry_type === 'cancel' ? [prefix + 'cancel'] : []));
    }
    return has(prefix + 'view');
  }
  if (parts[0] === 'journals') {
    if (parts.length === 1) return method === 'POST'
      ? all('vouchers.journals.create', ...(req.body.action === 'save_draft' ? [] : ['vouchers.journals.submit']))
      : has('vouchers.journals.view');
    if (parts[1] === 'new') return has('vouchers.journals.create');
    if (parts[2] === 'cancel') return has('vouchers.journals.cancel');
    if (parts[2] === 'delete') return method === 'POST' && has('vouchers.journals.delete');
    if (parts[2] === 'submit') return has('vouchers.journals.submit');
    if (parts[2] === 'edit' || method === 'POST') return has('vouchers.journals.edit');
    return has('vouchers.journals.view');
  }
  if (parts[0] === 'accounts') {
    return parts[1] === 'new' || method === 'POST' ? has('accounts.manage')
      : has('accounts.view') || anyNamedListView(user, 'accounts');
  }
  if (parts[0] === 'reports') {
    const report = REPORTS.find((item) => item.slug === parts[1]);
    return method === 'GET' && Boolean(report && has(report.permission));
  }
  if (parts[0] === 'api') {
    const name = parts[1];
    if (name === 'invoice-item-prices') return method === 'POST' && canAny(user,
      ['vouchers.sales.create', 'vouchers.sales.edit']);
    if (name === 'item-price-codes') return method === 'GET' && has('masters.item-prices.view');
    if (name === 'price-lists' || name === 'pricing-items') return method === 'GET' && (
      anyNamedPriceListAction(user, 'create') || canAny(user,
        ['masters.item-prices.view', ...(name === 'price-lists'
          ? ['masters.price-lists.view', 'vouchers.sales.create', 'vouchers.sales.edit', 'vouchers.purchases.create', 'vouchers.purchases.edit']
          : ['masters.items.view'])]));
    if (name === 'customers') return canAny(user, ['masters.customers.view', 'vouchers.sales.create']);
    if (name === 'suppliers') return canAny(user, ['masters.suppliers.view', 'vouchers.purchases.create', 'vouchers.stock.create']);
    if (name === 'items' || name === 'master-items') return canAny(user,
      ['masters.items.view', 'vouchers.sales.create', 'vouchers.purchases.create', 'vouchers.stock.create']);
    if (name === 'report-items' || name === 'report-warehouses') return canAny(user,
      ['vouchers.stock.view', 'reports.stock-ledger.view', 'reports.stock-movement.view', 'reports.gross-profit.view']);
    if (name === 'warehouses' || name === 'stock-balance') return canAny(user,
      ['masters.warehouses.view', 'vouchers.sales.create', 'vouchers.purchases.create', 'vouchers.stock.create']);
    if (name === 'cost-centers' || name === 'employees') return has('vouchers.journals.create');
    if (name === 'stock-entry-cancel-template' || name === 'stock-entries') return has('vouchers.stock.cancel');
    if (name === 'general-ledger') return has('reports.general-ledger.view');
    if (name === 'journal-reference-options') return has('vouchers.journals.create');
    return false;
  }
  return true;
}

async function scopeCheck(req) {
  const user = req.currentUser;
  const parts = req.path.split('/').filter(Boolean);
  const method = req.method;
  if (user.role === 'admin') return true;
  if (anyScopeRestricted(user) && (parts[0] === 'reports' || parts[0] === 'journals'
      || parts[0] === 'api' && ['general-ledger', 'journal-reference-options'].includes(parts[1]))) return false;
  if (scopeRestricted(user, 'suppliers') && parts[0] === 'stock' && parts[1] === 'entries') return false;
  if (scopeRestricted(user, 'suppliers') && parts[0] === 'api'
      && ['stock-entry-cancel-template', 'stock-entries'].includes(parts[1])) return false;

  if (parts[0] === 'settings' && parts[1] === 'warehouses'
      && parts[2] && parts[2] !== 'new' && !warehouseAllowed(user, decodeURIComponent(parts[2]))) return false;

  if (method === 'POST' && ['invoices', 'purchases', 'stock'].includes(parts[0])) {
    for (const field of ['warehouse', 'target_warehouse']) {
      const values = Array.isArray(req.body[field]) ? req.body[field] : req.body[field] ? [req.body[field]] : [];
      if (values.some((value) => value && !warehouseAllowed(user, value))) return false;
    }
  }
  if (method === 'POST' && parts[0] === 'journals') {
    const ids = Array.isArray(req.body.account_id) ? req.body.account_id : req.body.account_id ? [req.body.account_id] : [];
    if (ids.some((id) => id && !accountAllowed(user, id))) return false;
  }

  if (parts[0] === 'settings' && ['customers', 'suppliers'].includes(parts[1])) {
    const kind = parts[1];
    if (parts[2] && parts[2] !== 'new' && !await masterRecordAllowed(user, kind, decodeURIComponent(parts[2]))) return false;
    if (method === 'POST' && !['submit', 'cancel'].includes(parts[3])) {
      const field = kind === 'customers' ? 'customer_group' : 'supplier_type';
      if (!categoryAllowed(user, kind, req.body[field])) return false;
    }
  }
  if (parts[0] === 'invoices') {
    if (parts[1] && parts[1] !== 'new' && !await invoiceAllowed(user, parts[1])) return false;
    if (parts[1] && parts[1] !== 'new' && parts[1] !== 'payments'
        && !await voucherWarehousesAllowed(user, 'sales', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2)
        && !await masterRecordAllowed(user, 'customers', req.body.customer_id)) return false;
  }
  if (parts[0] === 'purchases') {
    if (parts[1] === 'payments' && parts[2] && !await purchasePaymentAllowed(user, parts[2])) return false;
    if (parts[1] && parts[1] !== 'new' && parts[1] !== 'payments'
        && !await purchaseAllowed(user, parts[1])) return false;
    if (parts[1] && parts[1] !== 'new' && parts[1] !== 'payments'
        && !await voucherWarehousesAllowed(user, 'purchases', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2)
        && !await masterRecordAllowed(user, 'suppliers', req.body.supplier_id)) return false;
  }
  if (parts[0] === 'stock' && parts[1] === 'entries' && parts[2] && parts[2] !== 'new'
      && !await voucherWarehousesAllowed(user, 'stock', parts[2])) return false;
  if (parts[0] === 'journals' && parts[1] && parts[1] !== 'new'
      && !await journalAccountsAllowed(user, parts[1])) return false;
  return true;
}

module.exports = { can, permissionCheck, scopeCheck };
