'use strict';

function homeSections(user, locals) {
  const { can, availableReports = [] } = locals;
  const scoped = user.role !== 'admin' && ['customers', 'suppliers']
    .some((kind) => user.scopes?.[kind]?.mode === 'selected');
  const supplierScoped = user.role !== 'admin' && user.scopes?.suppliers?.mode === 'selected';
  const sections = [];
  const add = (name, description, links, tone) => {
    if (links.length) sections.push({ name, description, href: links[0].href, links, tone });
  };
  const link = (permission, label, href) => can(permission) ? [{ label, href }] : [];

  add('Sales', 'Invoices, cash sales and customer balances.', [
    ...link('vouchers.sales.view', 'Sales Invoices', '/invoices'),
    ...link('vouchers.sales.create', 'New Sales Invoice', '/invoices/new'),
    ...(!scoped ? link('reports.debtors.view', 'Debtors', '/reports/debtors') : []),
  ], 'sales');

  add('Purchases', 'Supplier invoices and purchase orders.', [
    ...link('vouchers.purchases.view', 'Purchase Invoices', '/purchases'),
    ...link('vouchers.purchase-orders.view', 'Purchase Orders', '/purchase-orders'),
    ...link('vouchers.purchases.create', 'New Purchase Invoice', '/purchases/new'),
    ...link('vouchers.purchase-orders.create', 'New Purchase Order', '/purchase-orders/new'),
  ], 'purchases');

  add('Stocks', 'Entries, balances and physical counts.', [
    ...(!supplierScoped ? link('vouchers.stock.view', 'Stock Entries', '/stock/entries') : []),
    ...link('vouchers.stock.view', 'Stock Balance', '/stock'),
    ...(!supplierScoped ? link('vouchers.stock.create', 'New Stock Entry', '/stock/entries/new') : []),
    ...(!supplierScoped ? link('vouchers.stock.view', 'Stock Reconciliation', '/stock/reconciliations') : []),
  ], 'stock');

  add('Accounts', 'Chart of accounts and journal entries.', [
    ...(can('accounts.view') || locals.canViewNamedAccounts
      ? [{ label: 'Chart of Accounts', href: '/accounts' }] : []),
    ...(!scoped ? link('vouchers.journals.view', 'Journals', '/journals') : []),
    ...(!scoped ? link('vouchers.journals.create', 'New Journal Entry', '/journals/new') : []),
  ], 'accounts');

  add('HR', 'Employees, attendance, leave, payroll and employee balances.', [
    ...link('hr.employees.view', 'Employees', '/hr/employees'),
    ...link('hr.attendance.view', 'Attendance', '/hr/attendance'),
    ...link('hr.leave.view', 'Leave', '/hr/leave'),
    ...link('hr.payroll.view', 'Payroll', '/hr/payroll'),
    ...link('hr.money.view', 'Employee Money', '/hr/money'),
    ...link('hr.settings.view', 'HR Settings', '/hr/settings'),
  ], 'accounts');

  const visibleReports = scoped ? (user.role === 'standard'
    ? availableReports.filter((report) => report.slug === 'general-ledger') : []) : availableReports;
  add('Reports', 'Financial, sales and stock reporting.', visibleReports.map((report) => ({
    label: report.label, href: report.href,
  })), 'reports');

  const masterLinks = [
    ['customers', 'Customers'], ['suppliers', 'Suppliers'], ['items', 'Items'],
    ['price-lists', 'Price Lists'], ['item-prices', 'Item Prices'],
    ['warehouses', 'Warehouses'], ['employees', 'Employees'],
    ['cost-centers', 'Cost Centers'], ['options', 'Options'],
  ].flatMap(([key, label]) => {
    const named = key === 'price-lists' && locals.canManageNamedPriceLists
      || key === 'warehouses' && locals.canViewNamedWarehouses
      || key === 'employees' && locals.canViewAssignedEmployees
      || key === 'cost-centers' && locals.canViewAssignedCostCenters
      || key === 'item-prices' && locals.canCreateItemPrice;
    return can(`masters.${key}.view`) || named ? [{ label, href: `/settings/${key}` }] : [];
  });
  add('Master Data', 'The records that keep your workflows moving.', masterLinks, 'masters');

  add('Administration', 'Workspace settings and access control.', [
    ...(user.role === 'admin' || can('sync.run') ? [{ label: 'Application Settings', href: '/settings' }] : []),
    ...(user.role === 'admin' ? [
      { label: 'Users', href: '/settings/users' },
      { label: 'Roles & Permissions', href: '/settings/roles' },
      { label: 'Project Files', href: '/settings/files' },
    ] : []),
  ], 'admin');

  return sections;
}

module.exports = { homeSections };
