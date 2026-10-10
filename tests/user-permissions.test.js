const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { renderView } = require('./helpers/render-view');
const { PERMISSIONS, ROLE_RECORD_TYPES, applyPermissionOverrides, normalizePermissions } = require('../src/auth');
const { can, permissionCheck, scopeCheck } = require('../src/authorize');
const { csvLine, selectedColumns, validateSavedColumns, columns: invoiceReportColumns } = require('../src/web/invoice-report');
const { reportConfig, voucherReport, selectedColumns: voucherSelectedColumns,
  validateColumns: validateVoucherColumns, columnsRedirect } = require('../src/web/voucher-report');
const { allowedInvoicePriceLists, allowedPurchasePriceLists, invoicePriceListAllowed,
  purchasePriceListAllowed, priceListActionAllowed,
  warehouseAllowed, accountAllowed, allowedNamedListValues, journalAccountAccess,
  journalAccountsAllowed } = require('../src/access');
const { voucherOwnerId, voucherEmployeeId, addVoucherOwnerFilter, addStockLedgerOwnerFilter,
  voucherOwnedByUser } = require('../src/voucher-ownership');
const { activePermissionPriceLists } = require('../src/permission-price-lists');
const { addGeneralLedgerAccessFilter } = require('../src/domain/ledger');
const { homeSections } = require('../src/web/home-navigation');
const { journalEntries } = require('../src/store');

test('journal list filters restricted accounts even for the creator', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] };
  } };
  await journalEntries({ pool, ownerId: '12',
    allowedAccounts: ['3', '4'], deniedAccounts: ['5'] });
  assert.equal(calls.length, 2);
  for (const { sql, params } of calls) {
    assert.match(sql, /app_journal_entries\.created_by_user_id = \$1/);
    assert.match(sql, /restricted\.account_id::text <> ALL\(\$2::text\[\]\)/);
    assert.match(sql, /restricted\.account_id::text = ANY\(\$3::text\[\]\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM app_journal_entry_lines restricted/);
    assert.doesNotMatch(sql, /created_by_user_id = \$\d+ OR NOT EXISTS/);
    assert.deepEqual(params.slice(0, 3), ['12', ['3', '4'], ['5']]);
  }
});

test('journal creator still needs line account Read permission', async () => {
  const user = { id: 12, role: 'standard', scopes: {
    accounts: { mode: 'selected', values: ['3'] },
  } };
  let rows = [{ creator_id: '12', account_id: '5', account_code: '5000' }];
  const pool = { query: async () => ({ rows }) };
  assert.deepEqual(await journalAccountAccess(user, 519, { pool }), {
    allowed: false, restrictedAccounts: ['5000'], isCreator: true,
  });
  assert.equal(await journalAccountsAllowed(user, 519, { pool }), false);
  assert.deepEqual(await journalAccountAccess({ ...user, id: 13 }, 519, { pool }), {
    allowed: false, restrictedAccounts: ['5000'], isCreator: false,
  });
  rows = [{ creator_id: '12', account_id: '3', account_code: '3000' }];
  assert.equal(await journalAccountsAllowed(user, 519, { pool }), true);
  rows = [];
  assert.equal(await journalAccountsAllowed(user, 519, { pool }), false);
});

test('permission types include every active price list, including buying lists', async () => {
  const rows = [{ price_list: 'Import Price' }, { price_list: 'Standard Buying' }];
  const client = { query: async (sql) => {
    assert.match(sql, /active = 1/);
    assert.match(sql, /docstatus = 'submitted'/);
    assert.doesNotMatch(sql, /price_type|currency/);
    return { rows };
  } };
  assert.deepEqual(await activePermissionPriceLists(client), rows);
});

test('Standard users can open only vouchers they created', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: params[0] === 7 && params[1] === '12' ? [{ '?column?': 1 }] : [] };
  } };
  const standard = { id: 12, role: 'standard' };
  assert.equal(voucherOwnerId(standard), '12');
  assert.equal(voucherOwnerId({ id: 12, role: 'privileged' }), null);
  for (const kind of ['sales', 'purchases', 'purchase-orders', 'stock', 'journals']) {
    assert.equal(await voucherOwnedByUser(standard, kind, 7, pool), true, kind);
    assert.equal(await voucherOwnedByUser(standard, kind, 8, pool), false, kind);
  }
  assert.equal(await voucherOwnedByUser(standard, 'sales', 'invalid', pool), false);
  assert.equal(await voucherOwnedByUser({ id: 13, role: 'admin' }, 'sales', 8, pool), true);
  assert.equal(queries.length, 10);
  assert(queries.every(({ sql, params }) => sql.includes('created_by_user_id = $2')
    && params[1] === '12'));

  const assigned = { ...standard, record_access: { employee_id: 'EMP-ISA' } };
  assert.equal(voucherEmployeeId(assigned), 'EMP-ISA');
  const assignedPool = { query: async (sql, params) => {
    assert.match(sql, /created_by_user_id = \$2 OR invoicer_id = \$3/);
    assert.deepEqual(params, [8, '12', 'EMP-ISA']);
    return { rows: [{ '?column?': 1 }] };
  } };
  assert.equal(await voucherOwnedByUser(assigned, 'sales', 8, assignedPool), true);
});

test('voucher list and stock ledger filters bind the Standard user ID', () => {
  const where = [];
  const params = [];
  addVoucherOwnerFilter(where, params, 'invoice', '12');
  addStockLedgerOwnerFilter(where, params, 'ledger', '12');
  assert.match(where[0], /invoice\.created_by_user_id = \$1/);
  assert.match(where[1], /owned_stock\.created_by_user_id = \$2/);
  assert.match(where[1], /owned_purchase\.created_by_user_id = \$2/);
  assert.match(where[1], /owned_invoice\.created_by_user_id = \$2/);
  assert.deepEqual(params, ['12', '12']);
  const assignedWhere = [];
  const assignedParams = [];
  addVoucherOwnerFilter(assignedWhere, assignedParams, 'invoice', '12', 'EMP-ISA');
  assert.match(assignedWhere[0], /invoice\.created_by_user_id = \$1 OR invoice\.invoicer_id = \$2/);
  assert.deepEqual(assignedParams, ['12', 'EMP-ISA']);
});

test('Standard users can open scoped General Ledger with Read, but not unscoped reports', () => {
  const standard = { id: 12, role: 'standard', permissions: [
    'reports.daily-activity.view', 'reports.debtors.view', 'reports.general-ledger.view',
    'reports.stock-ledger.view',
  ] };
  for (const report of ['daily-activity', 'debtors']) {
    assert.equal(can(standard, `reports.${report}.view`), false);
    assert.equal(permissionCheck({ currentUser: standard, path: `/reports/${report}`,
      method: 'GET', body: {} }), false);
  }
  assert.equal(can(standard, 'reports.general-ledger.view'), true);
  assert.equal(permissionCheck({ currentUser: standard, path: '/reports/general-ledger',
    method: 'GET', body: {} }), true);
  assert.equal(permissionCheck({ currentUser: standard, path: '/api/general-ledger/parties',
    method: 'GET', body: {} }), true);
  assert.equal(can({ ...standard, permissions: [] }, 'reports.general-ledger.view'), false);
  assert.equal(can(standard, 'reports.stock-ledger.view'), true);
  assert.equal(can({ ...standard, role: 'privileged' }, 'reports.debtors.view'), true);
});

test('Standard General Ledger filters rows to owned vouchers and permitted accounts', () => {
  const where = [];
  const params = [];
  addGeneralLedgerAccessFilter(where, params, { ownerId: '12', ownerEmployeeId: 'EMP-12',
    allowedAccounts: ['7'], deniedAccounts: ['9'] });
  assert.deepEqual(params, [['7'], ['9'], '12', 'EMP-12']);
  const sql = where.join(' AND ');
  assert.match(sql, /gl\.account_id::text = ANY\(\$1::text\[\]\)/);
  assert.match(sql, /gl\.account_id::text <> ALL\(\$2::text\[\]\)/);
  assert.match(sql, /i\.created_by_user_id = \$3 OR i\.invoicer_id = \$4/);
  for (const source of ['app_invoices', 'app_invoice_payments', 'app_purchases',
    'app_purchase_payments', 'app_journal_entries', 'app_stock_entries']) {
    assert.match(sql, new RegExp(source));
  }
  assert.match(sql, /COALESCE\(gl\.reversal_of_voucher_id, gl\.voucher_id\)/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM app_journal_entry_lines/);
});

test('Standard General Ledger respects selected customer and supplier categories', async () => {
  const user = { id: 12, role: 'standard', scopes: {
    customers: { mode: 'selected', values: ['Retail'] },
    suppliers: { mode: 'selected', values: ['Local'] },
  } };
  assert.equal(await scopeCheck({ currentUser: user, path: '/reports/general-ledger', method: 'GET', body: {} }), true);
  assert.equal(await scopeCheck({ currentUser: user, path: '/api/general-ledger/parties', method: 'GET', body: {} }), true);
  assert.equal(await scopeCheck({ currentUser: { ...user, role: 'privileged' },
    path: '/reports/general-ledger', method: 'GET', body: {} }), false);
  const where = [];
  const params = [];
  addGeneralLedgerAccessFilter(where, params, { ownerId: '12', customerGroups: ['retail'], supplierTypes: ['local'] });
  assert.deepEqual(params, [['retail'], ['local'], '12', '']);
  const sql = where.join(' AND ');
  assert.match(sql, /LOWER\(customer\.customer_group\) = ANY\(\$1::text\[\]\)/);
  assert.match(sql, /LOWER\(supplier\.supplier_type\) = ANY\(\$2::text\[\]\)/);
  assert.doesNotMatch(sql, /app_journal_entries|app_stock_entries/);
});

test('Standard user with General Ledger Read sees the report link even with category scopes', async () => {
  const user = { id: 12, role: 'standard', scopes: {
    customers: { mode: 'selected', values: ['Retail'] },
    suppliers: { mode: 'all', values: [] },
  }, permissions: ['reports.general-ledger.view'] };
  const availableReports = [{ slug: 'general-ledger', label: 'General Ledger', href: '/reports/general-ledger' }];
  const sections = homeSections(user, { can: (permission) => can(user, permission), availableReports });
  assert.equal(sections.find((section) => section.name === 'Reports')?.href, '/reports/general-ledger');
  const html = await renderView(path.join(__dirname, '..', 'views', 'module-nav.ejs'), {
    currentUser: user, availableReports, can: (permission) => can(user, permission), activeModule: 'report',
  });
  assert.match(html, /href="\/reports\/general-ledger"/);
});

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

test('cancelled invoice deletion is shown only to admins, and submitted invoices cannot be deleted', async () => {
  const view = path.join(__dirname, '..', 'views', 'invoice-actions.ejs');
  const base = { can: () => true, invoicePriceListAllowed: () => true, receiptAccounts: [] };
  const render = (role, docstatus) => renderView(view, {
    ...base, currentUser: { role }, invoice: { id: 4, docstatus, total: 100 },
  });
  assert.match(await render('admin', 'cancelled'), /action="\/invoices\/4\/delete"/);
  assert.doesNotMatch(await render('standard', 'cancelled'), /action="\/invoices\/4\/delete"/);
  assert.doesNotMatch(await render('admin', 'submitted'), /action="\/invoices\/4\/delete"/);
});

test('sales invoice CSV export requires report access and protects profit columns', () => {
  const route = '/invoices/report/export';
  const request = (permissions, method = 'GET') => ({ currentUser: { role: 'standard', permissions },
    path: route, method, body: {} });
  assert.equal(permissionCheck(request(['vouchers.sales.view'])), true);
  assert.equal(permissionCheck(request([])), false);
  assert.equal(permissionCheck(request(['vouchers.sales.view'], 'POST')), false);
  assert.deepEqual(selectedColumns({ columns_applied: '1', columns: ['invoice_no', 'gross_profit'] },
    invoiceReportColumns.filter((column) => column.key !== 'gross_profit')), ['invoice_no']);
});

test('sales invoice report column defaults can be saved per user and temporarily overridden', () => {
  const savedColumns = ['invoice_no', 'customer_name', 'gross_profit'];
  assert.deepEqual(selectedColumns({ savedColumns }, invoiceReportColumns), savedColumns);
  assert.deepEqual(selectedColumns({ savedColumns, columns_applied: '1', columns: ['item_code'] }, invoiceReportColumns),
    ['item_code']);
  assert.deepEqual(selectedColumns({ savedColumns },
    invoiceReportColumns.filter((column) => column.key !== 'gross_profit')),
  ['invoice_no', 'customer_name']);
  assert.deepEqual(validateSavedColumns(['customer_name', 'invoice_no'], false),
    ['invoice_no', 'customer_name']);
  assert.throws(() => validateSavedColumns(['gross_profit'], false), /available report column/);
  assert.throws(() => validateSavedColumns([], true), /at least one/);
  for (const route of ['/invoices/report/columns', '/invoices/report/columns/reset']) {
    const request = (permissions, method = 'POST') => ({ currentUser: { role: 'standard', permissions },
      path: route, method, body: {} });
    assert.equal(permissionCheck(request(['vouchers.sales.view'])), true);
    assert.equal(permissionCheck(request([])), false);
    assert.equal(permissionCheck(request(['vouchers.sales.view'], 'GET')), false);
  }
});

test('sales invoice report shows controls to save and restore column defaults', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'invoice-report.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', username: 'admin' }, can: () => true,
    availableReports: [], warehouses: [], money: String, formatDate: String,
    report: { filters: { search: '', from: '', to: '', status: '', warehouse: '', item: '', category: '' },
      columns: [{ key: 'invoice_no', label: 'Invoice' }], selectedColumns: ['invoice_no'],
      hasSavedColumns: true, rows: [], pagination: { start: 0, end: 0, total: 0, page: 1, total_pages: 1 } },
    query: new URLSearchParams(), columnsNotice: 'Default columns saved.',
  });
  assert.match(html, /Save as default/);
  assert.match(html, /Restore app default/);
  assert.match(html, /Default columns saved\./);
  assert.match(html, /<button type="submit">Apply<\/button>[\s\S]*?href="\/invoices\/report">Reset<\/a>[\s\S]*?formaction="\/invoices\/report\/export"[^>]*>Download<\/button>/);
});

test('sales invoice CSV escapes quotes, newlines and spreadsheet formulas', () => {
  assert.equal(csvLine(['Invoice', 'Customer']), '"Invoice","Customer"\r\n');
  assert.equal(csvLine(['INV-1', 'A "quoted", customer\nsecond line', '=HYPERLINK("bad")', -5, null, true]),
    '"INV-1","A ""quoted"", customer\nsecond line","\'=HYPERLINK(""bad"")",-5,"","Yes"\r\n');
});

test('purchase and journal report routes require their own voucher view permission', () => {
  for (const [base, permission] of [
    ['/purchases', 'vouchers.purchases.view'],
    ['/purchase-orders', 'vouchers.purchase-orders.view'],
    ['/journals', 'vouchers.journals.view'],
  ]) {
    for (const [suffix, method] of [['', 'GET'], ['/export', 'GET'],
      ['/columns', 'POST'], ['/columns/reset', 'POST']]) {
      const request = (permissions) => ({ currentUser: { role: 'standard', permissions },
        path: `${base}/report${suffix}`, method, body: {} });
      assert.equal(permissionCheck(request([permission])), true);
      assert.equal(permissionCheck(request([])), false);
      assert.equal(permissionCheck({ ...request([permission]), method: method === 'GET' ? 'POST' : 'GET' }), false);
    }
  }
});

test('each voucher report keeps its own default and validates selectable columns', () => {
  for (const kind of ['purchases', 'purchase-orders', 'journals']) {
    const config = reportConfig(kind);
    assert.deepEqual(voucherSelectedColumns(config), config.defaults);
    assert.deepEqual(voucherSelectedColumns(config, { savedColumns: [config.firstColumn] }), [config.firstColumn]);
    assert.deepEqual(voucherSelectedColumns(config, { savedColumns: [config.firstColumn],
      columns_applied: '1', columns: [config.columns[1].key] }), [config.columns[1].key]);
    assert.deepEqual(validateVoucherColumns(config, [config.columns[1].key, config.firstColumn]),
      [config.firstColumn, config.columns[1].key]);
    assert.throws(() => validateVoucherColumns(config, ['gross_profit']), /available report column/);
  }
  const journals = reportConfig('journals');
  assert(journals.columns.some((column) => column.key === 'user' && column.label === 'User'));
  assert.deepEqual(voucherSelectedColumns(journals, { columns_applied: '1', columns: ['journal_no', 'user'] }),
    ['journal_no', 'user']);
});

test('purchase and journal reports query lines with their access scopes', async () => {
  for (const kind of ['purchases', 'purchase-orders', 'journals']) {
    const calls = [];
    const pool = { query: async (sql, values) => {
      calls.push({ sql, values });
      return sql.includes('count(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] };
    } };
    await voucherReport(kind, {
      pool, q: 'sample', from: '2026-01-01', to: '2026-01-31', status: 'submitted',
      ...kind === 'journals' ? { account: 'cash', user: 'Kagabui',
        allowedAccounts: ['12'], deniedAccounts: ['13'] }
        : { item: 'bolt', category: 'hardware', allowedTypes: ['materials'],
          allowedWarehouses: ['Main'], deniedWarehouses: ['Other'] },
    });
    const rowSql = calls[0].sql;
    assert.match(rowSql, /LEFT JOIN app_\w+ (?:line|account)/);
    assert.match(rowSql, /line\.line_no/);
    assert.match(rowSql, /LIMIT \$\d+ OFFSET \$\d+/);
    assert.equal(calls.length, 2);
    if (kind === 'journals') {
      assert.match(rowSql, /LEFT JOIN app_users creator ON creator\.id::text = j\.created_by_user_id/);
      assert.match(rowSql, /creator\.username AS "user"/);
      assert.match(rowSql, /lower\(coalesce\(creator\.username::text, ''\)\) LIKE \$\d+/);
      assert.match(rowSql, /lower\(coalesce\(creator\.username, ''\)\) LIKE \$\d+/);
      assert(calls.every(({ values }) => values.includes('%kagabui%')));
      assert.match(rowSql, /app_journal_entry_lines restricted/);
      assert.match(rowSql, /NOT EXISTS \(SELECT 1 FROM app_journal_entry_lines restricted/);
      assert.doesNotMatch(rowSql, /created_by_user_id = \$\d+ OR NOT EXISTS/);
      assert.match(rowSql, /account\.account_name/);
    } else {
      assert.match(rowSql, /app_master_suppliers supplier/);
      assert.match(rowSql, /restricted\.warehouse/);
      assert.match(rowSql, /master\.category/);
    }
  }
});

test('voucher report subtabs render filters, columns and CSV controls', async () => {
  for (const kind of ['purchases', 'purchase-orders', 'journals']) {
    const config = reportConfig(kind);
    const html = await renderView(path.join(__dirname, '..', 'views', 'voucher-report.ejs'), {
      assetVersion: 'test', currentUser: { role: 'admin', username: 'admin' }, can: () => true,
      availableReports: [], config, money: String, formatDate: String,
      report: { filters: { search: '', from: '', to: '', status: '', warehouse: '', item: '',
        category: '', journal_type: '', account: '', user: kind === 'journals' ? 'Kagabui' : '' }, columns: config.columns,
      selectedColumns: config.defaults, hasSavedColumns: true, rows: [],
      pagination: { start: 0, end: 0, total: 0, page: 1, total_pages: 1 } },
      query: new URLSearchParams(), columnsNotice: null,
    });
    assert.match(html, new RegExp(`action="${config.basePath}/report"`));
    assert.match(html, />Download<\/button>/);
    assert.match(html, new RegExp(`<button type="submit">Apply</button>[\\s\\S]*?href="${config.basePath}/report">Reset</a>[\\s\\S]*?formaction="${config.basePath}/report/export"[^>]*>Download</button>`));
    assert.match(html, /Save as default/);
    assert.match(html, /Restore app default/);
    if (kind === 'journals') {
      assert.match(html, /placeholder="Journal, party, account or user"/);
      assert.match(html, /<label>User<input name="user" value="Kagabui"/);
      assert.match(columnsRedirect(config, { user: 'Kagabui' }, 'columns_saved'), /user=Kagabui/);
    }
  }
});

test('cost centers use master list permissions and vouchers can search them', async () => {
  const record = ROLE_RECORD_TYPES.find((entry) => entry.key === 'masters.cost-centers');
  assert(record);
  assert.deepEqual(record.actions, ['view', 'create', 'edit', 'submit', 'cancel', 'delete']);
  const request = (permissions, path, method = 'GET') => ({ currentUser: { role: 'standard', permissions }, path, method, body: {} });
  assert.equal(permissionCheck(request(['masters.cost-centers.view'], '/settings/cost-centers')), true);
  assert.equal(permissionCheck(request(['masters.cost-centers.edit'], '/settings/cost-centers/CC-1/edit')), true);
  assert.equal(permissionCheck(request(['masters.cost-centers.view'], '/settings/cost-centers/CC-1', 'POST')), false);
  assert.equal(permissionCheck(request(['vouchers.sales.create'], '/api/cost-centers')), true);
  for (const permission of ['vouchers.purchases.create', 'vouchers.purchase-orders.create',
    'vouchers.stock.create', 'vouchers.journals.create']) {
    assert.equal(permissionCheck(request([permission], '/api/cost-centers')), true);
  }
  const assigned = { role: 'standard', permissions: ['vouchers.purchase-orders.create'],
    record_access: { cost_center: 'Main' }, permission_grants: [], permission_denials: [] };
  assert.equal(await scopeCheck({ currentUser: assigned, path: '/purchase-orders', method: 'POST',
    body: { cost_center: 'Main' } }), true);
  assert.equal(await scopeCheck({ currentUser: assigned, path: '/purchase-orders', method: 'POST',
    body: { cost_center: 'Other' } }), false);
});

test('submitted cost centers expose an editable master form', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'master-form.ejs'), {
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

test('assigned sales lists do not hide permitted buying lists on purchase orders', async () => {
  const user = { role: 'standard', permissions: ['vouchers.purchase-orders.create'],
    record_access: { retail_price_list: 'Retail' },
    scopes: { invoicePriceLists: { mode: 'selected', values: ['Buying'] } },
    permission_grants: [], permission_denials: [] };
  assert.deepEqual(allowedInvoicePriceLists(user), ['Retail', 'Buying']);
  assert.deepEqual(allowedPurchasePriceLists(user), ['Buying', 'Standard Buying']);
  assert.equal(invoicePriceListAllowed(user, 'Buying'), true);
  assert.equal(purchasePriceListAllowed(user, 'Retail'), false);
  assert.equal(purchasePriceListAllowed(user, 'Buying'), true);
  assert.equal(purchasePriceListAllowed(user, 'Standard Buying'), true);
  assert.equal(await scopeCheck({ currentUser: user, path: '/purchase-orders', method: 'POST',
    body: { price_list: 'Buying' } }), true);
  assert.equal(await scopeCheck({ currentUser: user, path: '/purchase-orders', method: 'POST',
    body: { price_list: 'Other' } }), false);
  user.permission_denials = ['invoice.price-list.view:Buying'];
  assert.deepEqual(allowedInvoicePriceLists(user), ['Retail']);
  assert.deepEqual(allowedPurchasePriceLists(user), ['Standard Buying']);
  assert.equal(purchasePriceListAllowed(user, 'Buying'), false);
  user.permission_denials.push('invoice.price-list.view:Standard Buying');
  assert.deepEqual(allowedPurchasePriceLists(user), []);
  assert.equal(purchasePriceListAllowed(user, 'Standard Buying'), false);
  const viewer = { ...user, permissions: [], permission_denials: [] };
  assert.deepEqual(allowedPurchasePriceLists(viewer), ['Buying']);
  user.scopes.invoicePriceLists = { mode: 'all', values: [] };
  user.permission_denials = [];
  assert.equal(allowedPurchasePriceLists(user), null);
  assert.equal(purchasePriceListAllowed(user, 'Standard Buying'), true);
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

test('sales invoice report requires sales view and permits scoped users to reach filtered report', async () => {
  const user = { role: 'standard', permissions: ['vouchers.sales.view'],
    scopes: { customers: { mode: 'selected', values: ['Retail'] },
      warehouses: { mode: 'selected', values: ['Main'] } } };
  const request = { currentUser: user, path: '/invoices/report', method: 'GET', body: {} };
  assert.equal(permissionCheck(request), true);
  assert.equal(await scopeCheck(request), true);
  assert.equal(permissionCheck({ ...request, method: 'POST' }), false);
  assert.equal(permissionCheck({ ...request, currentUser: { ...user, permissions: [] } }), false);
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
  const html = await renderView(path.join(__dirname, '..', 'views', 'roles.ejs'), {
    assetVersion: 'test', activeTab: 'users', error: null, notice: null,
    currentUser: { id: 1, username: 'admin', role: 'admin', scopes: {} },
    can: () => true, availableReports: [], roles: [role], selectedRole: role,
    users: [user], selectedUser: user, selectedUserRole: role,
    inheritedPermissions: role.permissions, userPermissions: role.permissions,
    defaultUserPermissionKeys: [],
    recordTypes: ROLE_RECORD_TYPES, recordActions: ['create', 'view', 'edit', 'submit', 'cancel', 'delete'],
    extraPermissions: [],
  });
  for (const required of ['data-auto-permissions', 'data-role-add-row',
    '/settings/users/2/permissions/row',
    '/settings/users/2/permissions/extra', '/settings/users/2/permissions/reset']) {
    assert(html.includes(required), `Missing ${required}`);
  }
  assert(!html.includes('<th>Remove</th>'));
  assert(!html.includes('data-label="Remove"'));
  assert(!html.includes('data-user-permissions'));
});

test('warehouse and buying price list records appear under their master lists in both permission forms', async () => {
  const role = { slug: 'standard', name: 'Standard', user_count: 1, permissions: [], scopes: {} };
  const user = { id: 2, username: 'worker', role: 'standard' };
  const priceList = { key: 'invoice-price-list:Standard Buying', label: 'Standard Buying',
    group: 'Price lists', parentKey: 'masters.price-lists', actions: ['view'],
    permissions: { view: 'invoice.price-list.view:Standard Buying' } };
  const warehouse = { key: 'warehouse:Main Warehouse', label: 'Main Warehouse',
    group: 'Warehouse list', parentKey: 'masters.warehouses', actions: ['view'],
    permissions: { view: 'warehouse.view:Main Warehouse' } };
  const account = { key: 'account:7', label: '1100 · Bank', group: 'Accounts list',
    parentKey: 'chart-of-accounts', parentAliases: ['accounts'], actions: ['view'],
    permissions: { view: 'account.view:7' } };
  const locals = { assetVersion: 'test', error: null, notice: null,
    currentUser: { id: 1, username: 'admin', role: 'admin', scopes: {} },
    can: () => true, availableReports: [], roles: [role], selectedRole: role,
    users: [user], selectedUser: user, selectedUserRole: role,
    inheritedPermissions: [], userPermissions: [], defaultUserPermissionKeys: [],
    recordTypes: [ROLE_RECORD_TYPES.find((type) => type.key === 'masters.price-lists'),
      ROLE_RECORD_TYPES.find((type) => type.key === 'masters.warehouses'),
      ROLE_RECORD_TYPES.find((type) => type.key === 'accounts'),
      ROLE_RECORD_TYPES.find((type) => type.key === 'chart-of-accounts'), priceList, warehouse, account],
    recordActions: ['create', 'view', 'edit', 'submit', 'cancel', 'delete'],
    extraPermissions: [] };
  for (const activeTab of ['permissions', 'users']) {
    const html = await renderView(path.join(__dirname, '..', 'views', 'roles.ejs'),
      { ...locals, activeTab });
    assert.match(html, /data-permission-type/);
    assert.match(html, /data-granular-record/);
    assert.match(html, /value="masters.warehouses"[^>]*>Warehouse<\/option>/);
    assert.match(html, /value="warehouse:Main Warehouse" data-parents="masters.warehouses"[^>]*>Main Warehouse<\/option>/);
    assert.match(html, /value="masters.price-lists"[^>]*>Price List<\/option>/);
    assert.match(html, /value="invoice-price-list:Standard Buying" data-parents="masters.price-lists"[^>]*>Standard Buying<\/option>/);
    assert.match(html, /value="account:7" data-parents="chart-of-accounts,accounts"[^>]*>1100 · Bank<\/option>/);
  }
});

test('specific warehouse and account choices filter records and reject duplicate permission rows', () => {
  const listeners = {};
  const broadOptions = [
    { value: '', dataset: {} },
    { value: 'masters.warehouses', dataset: { actions: 'view,create' } },
    { value: 'accounts', dataset: { actions: 'create' } },
  ];
  const specificOptions = [
    { value: '', dataset: {} },
    { value: 'warehouse:Main Warehouse', dataset: { parents: 'masters.warehouses', actions: 'view' } },
    { value: 'account:7', dataset: { parents: 'chart-of-accounts,accounts', actions: 'view' } },
  ];
  const broad = { value: '', options: broadOptions,
    get selectedOptions() { return this.options.filter((option) => option.value === this.value); },
    addEventListener(name, handler) { listeners[`broad:${name}`] = handler; } };
  const specific = { value: '', disabled: true, options: specificOptions,
    get selectedOptions() { return this.options.filter((option) => option.value === this.value); },
    replaceChildren(...options) { this.options = options; },
    addEventListener(name, handler) { listeners[`specific:${name}`] = handler; } };
  const hiddenType = { value: '' };
  const actions = ['view', 'create'].map((value) => ({ value, disabled: false,
    checked: false, parentElement: { hidden: false } }));
  const form = {
    querySelector(selector) { return ({ '[data-permission-type]': broad,
      '[data-granular-record]': specific, '[data-record-type]': hiddenType })[selector]; },
    querySelectorAll() { return actions; },
    addEventListener(name, handler) { listeners[`form:${name}`] = handler; },
  };
  const table = { addEventListener() {},
    querySelectorAll() { return [{ value: 'account:7' }]; } };
  const status = { textContent: '' };
  const document = {
    addEventListener(name, handler) { listeners[name] = handler; },
    querySelector(selector) { return ({ '[data-role-add-row]': form,
      '[data-auto-permissions]': table, '[data-permission-status]': status })[selector] || null; },
  };
  const enhanced = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'roles.js'), 'utf8'), {
    document,
    enhancePermissionSelect(select) {
      enhanced.push(select);
      return { refresh() {} };
    },
  });
  listeners.DOMContentLoaded();
  assert.deepEqual(enhanced, [broad, specific]);
  broad.value = 'masters.warehouses';
  listeners['broad:change']();
  assert.equal(specific.disabled, false);
  assert.deepEqual(specific.options.map((option) => option.value), ['', 'warehouse:Main Warehouse']);
  assert.equal(hiddenType.value, 'masters.warehouses');
  specific.value = 'warehouse:Main Warehouse';
  listeners['specific:change']();
  assert.equal(hiddenType.value, 'warehouse:Main Warehouse');
  assert.equal(actions.find((action) => action.value === 'create').disabled, true);
  let blocked = false;
  listeners['form:submit']({ preventDefault() { blocked = true; } });
  assert.equal(blocked, false);
  broad.value = 'accounts';
  listeners['broad:change']();
  assert.deepEqual(specific.options.map((option) => option.value), ['', 'account:7']);
  specific.value = 'account:7';
  listeners['specific:change']();
  assert.equal(hiddenType.value, 'account:7');
  listeners['form:submit']({ preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
  assert.match(status.textContent, /already in the table/);
});
