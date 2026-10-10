const {
  anyScopeRestricted,
  scopeRestricted,
  categoryAllowed,
  masterRecordAllowed,
  invoiceAllowed,
  purchaseAllowed,
  purchaseOrderAllowed,
  purchasePaymentAllowed,
  priceListActionAllowed,
  anyNamedPriceListAction,
  warehouseAllowed,
  accountAllowed,
  anyNamedListView,
  voucherWarehousesAllowed,
  journalAccountAccess,
  allowedMasterRecordIds,
  assignedMasterRecordAllowed,
  purchasePriceListAllowed,
} = require('./access');
const { REPORTS } = require('./report-permissions');
const { voucherOwnedByUser } = require('./voucher-ownership');
const { invoiceForPayment } = require('./store');
const { purchaseForPayment } = require('./purchases');

const MASTER_KEYS = new Set(['customers', 'suppliers', 'items', 'warehouses', 'employees', 'cost-centers', 'options', 'price-lists', 'item-prices']);
const UNSCOPED_VOUCHER_REPORTS = new Set([
  'reports.daily-activity.view', 'reports.debtors.view',
]);

function can(user, permission) {
  if (user?.role === 'standard' && UNSCOPED_VOUCHER_REPORTS.has(permission)) return false;
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
  if (parts[0] === 'hr') {
    const { permissionForHr, HR_AREAS } = require('./hr-policy');
    const permission = permissionForHr(req.path, method);
    return permission === 'any' ? HR_AREAS.some((area) => has(`hr.${area.key}.view`))
      : Boolean(permission && has(permission));
  }
  if (parts[0] === 'settings') {
    if (parts[1] === 'company-information') return user.role === 'admin';
    if (parts[1] === 'date-time') return parts.length === 2 && user.role === 'admin' && method === 'POST';
    if (parts[1] === 'erpnext-sync') return has('sync.run');
    if (parts[1] === 'users' || parts[1] === 'roles') return user.role === 'admin';
    if (parts[1] === 'files') {
      if (user.role !== 'admin') return false;
      if (parts.length === 2 || parts[2] === 'download' && parts.length === 3) {
        return method === 'GET' || method === 'HEAD';
      }
      return parts[2] === 'upload' && parts.length === 3 && method === 'POST';
    }
    if (parts.length === 1) return user.role === 'admin' || has('sync.run')
      || [...MASTER_KEYS].some((key) => has(`masters.${key}.view`))
      || anyNamedListView(user, 'warehouses')
      || ['cost-centers', 'employees'].some((kind) => (allowedMasterRecordIds(user, kind) || []).length > 0)
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
    if (['cost-centers', 'employees'].includes(list) && parts.length === 2 && method === 'GET'
      && (allowedMasterRecordIds(user, list) || []).length > 0) return true;
    if (['cost-centers', 'employees'].includes(list) && parts.length === 3 && method === 'GET'
      && (allowedMasterRecordIds(user, list) || []).length > 0) {
      return parts[2] !== 'new' && assignedMasterRecordAllowed(user, list, decodeURIComponent(parts[2]));
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
    if (parts[1] === 'report') return has(prefix + 'view') && (
      method === 'GET' && (parts.length === 2 || parts.length === 3 && parts[2] === 'export')
      || method === 'POST' && (parts.length === 3 && parts[2] === 'columns'
        || parts.length === 4 && parts[2] === 'columns' && parts[3] === 'reset')
    );
    if (parts[2] === 'payments') return has('payments.sales.' + (parts[4] === 'cancel' ? 'cancel' : 'record'));
    if (parts[2] === 'edit') return has(prefix + 'edit');
    if (parts[2] === 'duplicate') return method === 'GET' && all(prefix + 'view', prefix + 'create');
    if (parts[2] === 'posting-time') return method === 'POST' && has(prefix + 'edit');
    if (parts[2] === 'non-system-invoice') return method === 'POST' && has(prefix + 'edit');
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
    if (parts[1] === 'report') return has(prefix + 'view') && (
      method === 'GET' && (parts.length === 2 || parts.length === 3 && parts[2] === 'export')
      || method === 'POST' && (parts.length === 3 && parts[2] === 'columns'
        || parts.length === 4 && parts[2] === 'columns' && parts[3] === 'reset'));
    if (parts[1] === 'payments') return has(prefix + 'view');
    if (parts[2] === 'payments') return has('payments.purchases.' + (parts[4] === 'cancel' ? 'cancel' : 'record'));
    if (parts[2] === 'edit') return has(prefix + 'edit');
    if (parts[2] === 'posting-time') return method === 'POST' && has(prefix + 'edit');
    if (parts[2] === 'submit') return has(prefix + 'submit');
    if (parts[2] === 'cancel') return has(prefix + 'cancel');
    if (parts[2] === 'delete') return method === 'POST' && has(prefix + 'delete');
    return has(prefix + (method === 'POST' ? 'edit' : 'view'));
  }
  if (parts[0] === 'purchase-orders') {
    const prefix = 'vouchers.purchase-orders.';
    if (parts.length === 1) return has(prefix + (method === 'POST' ? 'create' : 'view'));
    if (parts[1] === 'new') return method === 'GET' && has(prefix + 'create');
    if (parts[1] === 'report') return has(prefix + 'view') && (
      method === 'GET' && (parts.length === 2 || parts.length === 3 && parts[2] === 'export')
      || method === 'POST' && (parts.length === 3 && parts[2] === 'columns'
        || parts.length === 4 && parts[2] === 'columns' && parts[3] === 'reset'));
    if (parts[2] === 'edit') return method === 'GET' && has(prefix + 'edit');
    if (parts[2] === 'submit') return method === 'POST' && has(prefix + 'submit');
    if (parts[2] === 'cancel') return method === 'POST' && has(prefix + 'cancel');
    if (parts[2] === 'delete') return method === 'POST' && has(prefix + 'delete');
    return has(prefix + (method === 'POST' ? 'edit' : 'view'));
  }
  if (parts[0] === 'stock') {
    const prefix = 'vouchers.stock.';
    if (parts.length === 1) return has(prefix + 'view');
    if (parts[1] === 'export') return parts.length === 2 && method === 'GET' && has(prefix + 'view');
    if (parts[1] === 'reconciliations') {
      if (parts[2] === 'count-sheet-template') return parts.length === 3 && method === 'GET' && canAny(user,
        [prefix + 'view', prefix + 'create', prefix + 'edit']);
      if (parts[2] === 'count-sheet-upload') return parts.length === 3 && method === 'POST' && canAny(user,
        [prefix + 'create', prefix + 'edit']);
      if (parts[2] === 'warehouse-stock') return parts.length === 3 && method === 'GET' && canAny(user,
        [prefix + 'create', prefix + 'edit']);
      if (parts[2] === 'new') return parts.length === 3 && method === 'GET' && has(prefix + 'create');
      if (parts.length === 2) return method === 'GET' ? has(prefix + 'view')
        : method === 'POST' && all(prefix + 'create',
          ...(req.body.action === 'save_draft' ? [] : [prefix + 'submit']));
      if (parts[3] === 'attachments') {
        if (parts.length === 4) return method === 'GET' ? canAny(user, [prefix + 'view', prefix + 'edit'])
          : method === 'POST' && has(prefix + 'edit');
        if (parts.length === 5) return method === 'GET' && canAny(user, [prefix + 'view', prefix + 'edit']);
        return parts.length === 6 && parts[5] === 'delete' && method === 'POST' && has(prefix + 'edit');
      }
      if (parts[3] === 'edit') return parts.length === 4 && method === 'GET' && has(prefix + 'edit');
      if (parts[3] === 'submit') return parts.length === 4 && method === 'POST' && has(prefix + 'submit');
      if (parts[3] === 'delete') return parts.length === 4 && method === 'POST' && has(prefix + 'delete');
      if (parts[3] === 'cancel') return parts.length === 4 && method === 'POST' && has(prefix + 'cancel');
      if (parts.length === 3 && method === 'POST') return all(prefix + 'edit',
        ...(req.body.action === 'save_draft' ? [] : [prefix + 'submit']));
      return parts.length === 3 && method === 'GET' && has(prefix + 'view');
    }
    if (parts[1] !== 'entries') return false;
    if (parts[2] === 'new') return has(prefix + 'create');
    if (parts.length === 2 && method === 'POST') {
      return all(prefix + 'create', ...(req.body.action === 'save_draft' ? [] : [prefix + 'submit']),
        ...(req.body.entry_type === 'cancel' ? [prefix + 'cancel'] : []));
    }
    if (parts[3] === 'cancel') return has(prefix + 'cancel');
    if (parts[3] === 'delete') return method === 'POST' && has(prefix + 'delete');
    if (parts[3] === 'supplier') return has(prefix + 'edit');
    if (parts[3] === 'posting-time') return method === 'POST' && has(prefix + 'edit');
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
    if (parts[1] === 'report') return has('vouchers.journals.view') && (
      method === 'GET' && (parts.length === 2 || parts.length === 3 && parts[2] === 'export')
      || method === 'POST' && (parts.length === 3 && parts[2] === 'columns'
        || parts.length === 4 && parts[2] === 'columns' && parts[3] === 'reset'));
    if (parts[2] === 'cancel') return has('vouchers.journals.cancel');
    if (parts[2] === 'delete') return method === 'POST' && has('vouchers.journals.delete');
    if (parts[2] === 'submit') return has('vouchers.journals.submit');
    if (parts[2] === 'posting-time') return method === 'POST' && has('vouchers.journals.edit');
    if (parts[2] === 'edit' || method === 'POST') return has('vouchers.journals.edit');
    return has('vouchers.journals.view');
  }
  if (parts[0] === 'accounts') {
    if (parts.length === 1) return method === 'POST' ? has('accounts.manage')
      : method === 'GET' && (has('accounts.view') || anyNamedListView(user, 'accounts'));
    if (parts[1] === 'new') return parts.length === 2 && method === 'GET' && has('accounts.manage');
    if (parts.length === 3 && parts[2] === 'edit') return method === 'GET' && has('accounts.manage');
    if (parts.length === 2 && method === 'POST') return has('accounts.manage');
    return false;
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
          ? ['masters.price-lists.view', 'vouchers.sales.create', 'vouchers.sales.edit', 'vouchers.purchases.create', 'vouchers.purchases.edit', 'vouchers.purchase-orders.create', 'vouchers.purchase-orders.edit']
          : ['masters.items.view'])]));
    if (name === 'customers') return canAny(user, ['masters.customers.view', 'vouchers.sales.create']);
    if (name === 'suppliers') return canAny(user, ['masters.suppliers.view', 'vouchers.purchases.create', 'vouchers.purchase-orders.create', 'vouchers.purchase-orders.edit', 'vouchers.stock.create']);
    if (name === 'items' || name === 'master-items') return canAny(user,
      ['masters.items.view', 'vouchers.sales.create', 'vouchers.purchases.create', 'vouchers.purchase-orders.create', 'vouchers.purchase-orders.edit', 'vouchers.stock.create', 'vouchers.stock.edit']);
    if (name === 'report-items' || name === 'report-warehouses') return canAny(user,
      ['vouchers.stock.view', 'reports.stock-ledger.view', 'reports.stock-movement.view', 'reports.gross-profit.view']);
    if (name === 'warehouses' || name === 'stock-balance') return canAny(user,
      ['masters.warehouses.view', 'vouchers.sales.create', 'vouchers.purchases.create', 'vouchers.purchase-orders.create', 'vouchers.purchase-orders.edit', 'vouchers.stock.create', 'vouchers.stock.edit']);
    if (name === 'cost-centers') return (allowedMasterRecordIds(user, 'cost-centers') || []).length > 0
      || canAny(user, ['masters.cost-centers.view', 'masters.cost-centers.create', 'masters.cost-centers.edit',
        'vouchers.sales.create', 'vouchers.sales.edit', 'vouchers.purchases.create', 'vouchers.purchases.edit',
        'vouchers.purchase-orders.create', 'vouchers.purchase-orders.edit', 'vouchers.stock.create',
        'vouchers.stock.edit', 'vouchers.journals.create', 'vouchers.journals.edit']);
    if (name === 'employees') return (allowedMasterRecordIds(user, 'employees') || []).length > 0
      || canAny(user, ['masters.employees.view', 'vouchers.sales.create', 'vouchers.sales.edit', 'vouchers.journals.create']);
    if (name === 'stock-entry-cancel-template' || name === 'stock-entries') return has('vouchers.stock.cancel');
    if (name === 'general-ledger') return has('reports.general-ledger.view');
    if (name === 'journal-reference-options') return has('vouchers.journals.create');
    return false;
  }
  // Fail closed. Every top-level route prefix the app registers is handled by an
  // explicit branch above, so reaching here means the path is unknown or
  // unclassified. Returning true would silently grant any newly added route to
  // every authenticated user; deny instead and add the branch when adding a route.
  return false;
}

async function scopeCheck(req) {
  const user = req.currentUser;
  const body = req.body || {};
  const parts = req.path.split('/').filter(Boolean);
  const method = req.method;
  if (user.role === 'admin') return true;
  const scopedStandardLedger = user.role === 'standard'
    && (parts[0] === 'reports' && parts[1] === 'general-ledger' && parts.length === 2
      || parts[0] === 'api' && parts[1] === 'general-ledger');
  if (anyScopeRestricted(user) && (parts[0] === 'reports' || parts[0] === 'journals'
      || parts[0] === 'api' && ['general-ledger', 'journal-reference-options'].includes(parts[1]))
      && !scopedStandardLedger) {
    if (parts[0] === 'journals') {
      req.accessDeniedReason = 'Your customer or supplier scope does not permit access to journals.';
    }
    return false;
  }
  if (scopeRestricted(user, 'suppliers') && parts[0] === 'stock'
      && ['entries', 'reconciliations'].includes(parts[1])) return false;
  if (scopeRestricted(user, 'suppliers') && parts[0] === 'api'
      && ['stock-entry-cancel-template', 'stock-entries'].includes(parts[1])) return false;

  if (parts[0] === 'settings' && parts[1] === 'warehouses'
      && parts[2] && parts[2] !== 'new' && !warehouseAllowed(user, decodeURIComponent(parts[2]))) return false;
  if (parts[0] === 'settings' && ['cost-centers', 'employees'].includes(parts[1])
      && parts[2] && parts[2] !== 'new'
      && !assignedMasterRecordAllowed(user, parts[1], decodeURIComponent(parts[2]))) return false;

  if (method === 'POST' && ['invoices', 'purchases', 'purchase-orders', 'stock'].includes(parts[0])) {
    for (const field of ['warehouse', 'target_warehouse']) {
      const values = Array.isArray(body[field]) ? body[field] : body[field] ? [body[field]] : [];
      if (values.some((value) => value && !warehouseAllowed(user, value))) return false;
    }
  }
  if (method === 'POST' && ['invoices', 'purchases', 'purchase-orders', 'stock', 'journals'].includes(parts[0])
      && body.cost_center
      && !assignedMasterRecordAllowed(user, 'cost-centers', body.cost_center)) return false;
  if (method === 'POST' && ['purchases', 'purchase-orders'].includes(parts[0])
      && (parts.length === 1 || parts.length === 2)
      && body.price_list && !purchasePriceListAllowed(user, body.price_list)) return false;
  if (method === 'POST' && parts[0] === 'journals') {
    const ids = Array.isArray(body.account_id) ? body.account_id : body.account_id ? [body.account_id] : [];
    if (ids.some((id) => id && !accountAllowed(user, id))) return false;
  }

  if (parts[0] === 'settings' && ['customers', 'suppliers'].includes(parts[1])) {
    const kind = parts[1];
    if (parts[2] && parts[2] !== 'new' && !await masterRecordAllowed(user, kind, decodeURIComponent(parts[2]))) return false;
    if (method === 'POST' && !['submit', 'cancel'].includes(parts[3])) {
      const field = kind === 'customers' ? 'customer_group' : 'supplier_type';
      if (!categoryAllowed(user, kind, body[field])) return false;
    }
  }
  if (parts[0] === 'invoices') {
    if (user.role === 'standard' && parts[1] === 'payments' && parts[2]) {
      const invoiceId = await invoiceForPayment(parts[2]).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
      if (!invoiceId || !await voucherOwnedByUser(user, 'sales', invoiceId)) return false;
    }
    if (parts[1] && !['new', 'report', 'payments'].includes(parts[1])
        && !await voucherOwnedByUser(user, 'sales', parts[1])) return false;
    if (parts[1] && !['new', 'report', 'payments'].includes(parts[1])
        && !await invoiceAllowed(user, parts[1])) return false;
    if (parts[1] && !['new', 'report', 'payments'].includes(parts[1])
        && !await voucherWarehousesAllowed(user, 'sales', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2)
        && !await masterRecordAllowed(user, 'customers', body.customer_id)) return false;
  }
  if (parts[0] === 'purchases') {
    if (user.role === 'standard' && parts[1] === 'payments' && parts[2]) {
      const purchaseId = await purchaseForPayment(parts[2]).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
      if (!purchaseId || !await voucherOwnedByUser(user, 'purchases', purchaseId)) return false;
    }
    if (parts[1] && !['new', 'payments', 'report'].includes(parts[1])
        && !await voucherOwnedByUser(user, 'purchases', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2) && body.purchase_order_id
        && (!await purchaseOrderAllowed(user, body.purchase_order_id)
          || !await voucherWarehousesAllowed(user, 'purchase-orders', body.purchase_order_id))) return false;
    if (parts[1] === 'payments' && parts[2] && !await purchasePaymentAllowed(user, parts[2])) return false;
    if (parts[1] && !['new', 'payments', 'report'].includes(parts[1])
        && !await purchaseAllowed(user, parts[1])) return false;
    if (parts[1] && !['new', 'payments', 'report'].includes(parts[1])
        && !await voucherWarehousesAllowed(user, 'purchases', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2)
        && !await masterRecordAllowed(user, 'suppliers', body.supplier_id)) return false;
  }
  if (parts[0] === 'purchase-orders') {
    if (parts[1] && !['new', 'report'].includes(parts[1]) && !await purchaseOrderAllowed(user, parts[1])) return false;
    if (parts[1] && !['new', 'report'].includes(parts[1])
        && !await voucherWarehousesAllowed(user, 'purchase-orders', parts[1])) return false;
    if (method === 'POST' && (parts.length === 1 || parts.length === 2)
        && !await masterRecordAllowed(user, 'suppliers', body.supplier_id)) return false;
  }
  if (parts[0] === 'stock' && parts[1] === 'entries' && parts[2] && parts[2] !== 'new'
      && !await voucherOwnedByUser(user, 'stock', parts[2])) return false;
  if (parts[0] === 'stock' && parts[1] === 'reconciliations' && parts[2]
      && !['new', 'warehouse-stock', 'count-sheet-template', 'count-sheet-upload'].includes(parts[2])
      && !await voucherOwnedByUser(user, 'stock', parts[2])) return false;
  if (parts[0] === 'stock' && parts[1] === 'entries' && parts[2] && parts[2] !== 'new'
      && !await voucherWarehousesAllowed(user, 'stock', parts[2])) return false;
  if (parts[0] === 'stock' && parts[1] === 'reconciliations' && parts[2]
      && !['new', 'warehouse-stock', 'count-sheet-template', 'count-sheet-upload'].includes(parts[2])
      && !await voucherWarehousesAllowed(user, 'stock', parts[2])) return false;
  if (parts[0] === 'journals' && parts[1] && !['new', 'report'].includes(parts[1])) {
    if (!await voucherOwnedByUser(user, 'journals', parts[1])) {
      req.accessDeniedReason = 'You cannot open this journal because it was not created by your account.';
      return false;
    }
    const access = await journalAccountAccess(user, parts[1]);
    if (!access.allowed) {
      req.accessDeniedReason = access.isCreator && access.restrictedAccounts.length
        ? `Account Read permission is missing for journal line account(s): ${access.restrictedAccounts.join(', ')}.`
        : 'You cannot open this journal because one or more line accounts are outside your permitted Account Read list.';
      return false;
    }
  }
  if (parts[0] === 'reports' && parts[1] === 'stock-ledger' && parts[2] === 'vouchers'
      && user.role === 'standard') {
    const kind = parts[3] === 'invoice' ? 'sales' : parts[3] === 'purchase' ? 'purchases'
      : parts[3]?.startsWith('stock_') ? 'stock' : null;
    if (!kind || !await voucherOwnedByUser(user, kind, parts[4])) return false;
  }
  return true;
}

module.exports = { can, permissionCheck, scopeCheck };
