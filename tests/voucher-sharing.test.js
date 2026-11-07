'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { permissionCheck, scopeCheck } = require('../src/authorize');
const { validateSharedVoucherEdit } = require('../src/shared-voucher-edit');

const user = { id: 7, role: 'standard', permissions: [], scopes: {}, record_access: {} };

test('generic voucher shares allow exact read and draft-write routes only', async () => {
  const routes = [
    ['/invoices/12', '/invoices/12/drawer', '/invoices/12/edit'],
    ['/purchases/12', '/purchases/12/drawer', '/purchases/12/edit'],
    ['/purchase-orders/12', '/purchase-orders/12/drawer', '/purchase-orders/12/edit'],
    ['/journals/12', '/journals/12/drawer', '/journals/12/edit'],
    ['/stock/reconciliations/12', null, '/stock/reconciliations/12/edit'],
  ];
  for (const [detail, drawer, edit] of routes) {
    for (const url of [detail, drawer].filter(Boolean)) {
      const req = { currentUser: user, voucherSharedRead: true, path: url, method: 'GET', body: {} };
      assert.equal(permissionCheck(req), true, url);
      assert.equal(await scopeCheck(req), true, url);
      assert.equal(permissionCheck({ ...req, voucherSharedRead: false }), false, url);
    }
    assert.equal(permissionCheck({ currentUser: user, voucherSharedRead: true, path: edit, method: 'GET', body: {} }), false);
    assert.equal(permissionCheck({ currentUser: user, voucherSharedWrite: true, path: edit, method: 'GET', body: {} }), true);
    assert.equal(await scopeCheck({ currentUser: user, voucherSharedWrite: true, path: edit, method: 'GET', body: {} }), true);
    for (const action of ['', 'save_draft']) {
      assert.equal(permissionCheck({ currentUser: user, voucherSharedWrite: true,
        path: detail, method: 'POST', body: { action } }), true);
    }
    for (const suffix of ['submit', 'cancel', 'delete', 'posting-time', 'share', 'print', 'duplicate']) {
      assert.equal(permissionCheck({ currentUser: user, voucherSharedWrite: true,
        path: `${detail}/${suffix}`, method: 'POST', body: {} }), false, `${detail}/${suffix}`);
    }
  }
  assert.equal(permissionCheck({ currentUser: user, voucherSharedRead: true,
    path: '/invoices/12/print', method: 'GET', body: {} }), false);
  assert.equal(permissionCheck({ currentUser: user, path: '/shared-vouchers', method: 'GET' }), true);
  const journalViewer = { ...user, permissions: ['vouchers.journals.view'] };
  assert.equal(permissionCheck({ currentUser: journalViewer, path: '/journals/12/print', method: 'GET', body: {} }), true);
  assert.equal(permissionCheck({ currentUser: journalViewer, path: '/journals/12/duplicate', method: 'GET', body: {} }), false);
  const journalCreator = { ...journalViewer, permissions: ['vouchers.journals.view', 'vouchers.journals.create'] };
  assert.equal(permissionCheck({ currentUser: journalCreator, path: '/journals/12/duplicate', method: 'GET', body: {} }), true);
});

test('all five voucher details render owner sharing while recipients receive read-only actions', async () => {
  const sharing = {
    type: 'sales', label: 'Sales Invoice', endpoint: '/invoices/12/share', voucher_id: 12,
    users: [{ id: 9, username: 'reader' }],
    shares: [{ user_id: 9, username: 'reader', active: true, permission: 'read', granted_at: new Date('2026-01-01T00:00:00Z') }],
  };
  const common = {
    assetVersion: 'test', availableReports: [], currentUser: { id: 7, role: 'admin', username: 'owner' },
    can: () => true, money: value => `UGX ${value}`, rateMoney: value => String(value),
    formatDate: String, formatDateTime: (date, time) => `${date} ${time}`, formatTimestamp: String,
    today: '2026-01-15', error: null, scriptJson: JSON.stringify,
    currentPostingDate: () => '2026-01-15', currentPostingTime: () => '10:00',
  };
  const documents = [
    ['invoice.ejs', { invoice: {
      id: 12, invoice_no: 'INV-000012', docstatus: 'draft', invoice_date: '2026-01-15',
      customer_id: 'CUSTOMER', price_list: 'Retail', total: 100, amount_paid: 0,
      status: 'unpaid', items: [], payments: [], created_by: 'Owner', created_at: '2026-01-15T10:00:00Z',
    }, items: [] }],
    ['purchase.ejs', { purchase: {
      id: 12, purchase_no: 'PURINV-000012', docstatus: 'draft', posting_date: '2026-01-15',
      supplier_id: 'SUPPLIER', status: 'unpaid', total: 100, amount_paid: 0,
      items: [], payments: [], created_by: 'Owner', created_at: '2026-01-15T10:00:00Z',
    } }],
    ['purchase-order.ejs', { order: {
      id: 12, order_no: 'PO-000012', docstatus: 'draft', posting_date: '2026-01-15',
      supplier_id: 'SUPPLIER', price_list: 'Buying', total: 100, items: [],
      created_by: 'Owner', created_at: '2026-01-15T10:00:00Z',
    } }],
    ['journal-entry.ejs', { journal: {
      id: 12, journal_no: 'JRN-000012', docstatus: 'draft', journal_type: 'journal_entry',
      posting_date: '2026-01-15', lines: [], can_cancel: true, total_debit: 100, total_credit: 100,
      created_by: 'Owner', created_at: '2026-01-15T10:00:00Z',
    }, accounts: [], readOnly: true, journalTypeLabel: () => 'Journal Entry' }],
    ['stock-reconciliation.ejs', { entry: {
      id: 12, entry_no: 'REC-000012', entry_type: 'reconciliation', docstatus: 'draft',
      posting_date: '2026-01-15', cost_center: 'Main', created_by_user_id: '7',
      created_by: 'Owner', created_at: '2026-01-15T10:00:00Z',
    }, items: [], readOnly: true, warehouse: 'Main', balances: [], postingTime: '10:00' }],
  ];
  for (const [view, locals] of documents) {
    const owner = await renderView(path.join(__dirname, '..', 'views', view), {
      ...common, ...locals, sharing: { ...sharing,
        endpoint: view === 'invoice.ejs' ? '/invoices/12/share'
          : view === 'purchase.ejs' ? '/purchases/12/share'
            : view === 'purchase-order.ejs' ? '/purchase-orders/12/share'
              : view === 'journal-entry.ejs' ? '/journals/12/share'
                : '/stock/reconciliations/12/share' },
    });
    assert.match(owner, /data-entry-sharing-panel/, view);
    assert.match(owner, /Remove access for reader/, view);
    if (view === 'journal-entry.ejs') assert.match(owner, /href="#voucher-sharing">Share<\/a>/, view);
    assert.ok(owner.indexOf('data-entry-sharing-panel') < owner.indexOf('data-tracking-toggle'),
      `${view} sharing must precede tracking`);
    const shared = await renderView(path.join(__dirname, '..', 'views', view), {
      ...common, ...locals, sharing: null, sharedAccessOnly: true,
    });
    assert.doesNotMatch(shared, /data-entry-sharing-panel|name="permission"|Remove access for/, view);
    assert.doesNotMatch(shared, /\/submit(?:-cash-sale)?["']|\/cancel["']|\/delete["']|\/duplicate["']/, view);
  }
});

test('journal draft editors expose owner sharing controls', async () => {
  const sharing = {
    type: 'journals', label: 'Journal Entry', endpoint: '/journals/12/share', voucher_id: 12,
    users: [{ id: 9, username: 'reader' }], shares: [],
  };
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    assetVersion: 'test', availableReports: [], currentUser: { role: 'admin', scopes: {} },
    can: () => true, money: String, formatTimestamp: String, today: '2026-01-15', error: null,
    scriptJson: JSON.stringify, currentPostingTime: () => '10:00', journalTypeLabel: () => 'Journal Entry',
    accounts: [], sharing, readOnly: false,
    journal: {
      id: 12, journal_no: 'JRN-000012', journal_type: 'journal_entry', docstatus: 'draft',
      posting_date: '2026-01-15', posting_time: '10:00', can_cancel: true,
      total_debit: 100, total_credit: 100,
      lines: [{ account_id: 5, account_name: 'Cash', debit: 100 }, { account_id: 6, account_name: 'Equity', credit: 100 }],
    },
  });
  assert.match(html, /href="#voucher-sharing">Share<\/a>/);
  assert.match(html, /action="\/journals\/12\/share"/);
  assert.match(html, />Save Draft<\/button>/);
});

test('sharing is the final section before tracking in every voucher preview and drawer', async () => {
  const common = {
    assetVersion: 'test', availableReports: [], currentUser: { id: 7, role: 'admin', username: 'owner' },
    can: () => true, money: value => `UGX ${value}`, rateMoney: value => String(value),
    formatDate: String, formatDateTime: (date, time) => `${date} ${time}`, formatTimestamp: String,
    today: '2026-01-15', error: null, scriptJson: JSON.stringify,
    currentPostingDate: () => '2026-01-15', currentPostingTime: () => '10:00',
    created_by: 'owner', created_at: '2026-01-15T10:00:00Z',
  };
  const sharing = {
    label: 'Stock Entry', endpoint: '/stock/entries/12/share', voucher_id: 12,
    users: [{ id: 9, username: 'reader' }],
    shares: [{ user_id: 9, username: 'reader', active: true, permission: 'read', granted_at: '2026-01-15T10:00:00Z' }],
  };
  const invoice = {
    id: 12, invoice_no: 'INV-000012', docstatus: 'draft', invoice_date: '2026-01-15',
    customer_id: 'CUSTOMER', price_list: 'Retail', total: 100, amount_paid: 0,
    status: 'unpaid', items: [], payments: [], ...common,
  };
  const purchase = {
    id: 12, purchase_no: 'PURINV-000012', docstatus: 'draft', posting_date: '2026-01-15',
    supplier_id: 'SUPPLIER', status: 'unpaid', total: 100, amount_paid: 0,
    items: [], payments: [], ...common,
  };
  const order = {
    id: 12, order_no: 'PO-000012', docstatus: 'draft', posting_date: '2026-01-15',
    supplier_id: 'SUPPLIER', price_list: 'Buying', total: 100, items: [], ...common,
  };
  const journal = {
    id: 12, journal_no: 'JRN-000012', docstatus: 'draft', journal_type: 'journal_entry',
    posting_date: '2026-01-15', lines: [], can_cancel: true,
    total_debit: 100, total_credit: 100, ...common,
  };
  const stockEntry = {
    id: 12, entry_no: 'STK-000012', entry_type: 'transfer', docstatus: 'draft',
    posting_date: '2026-01-15', delivery_status: 'In Transit', created_by_user_id: '7', ...common,
  };
  const views = [
    ['invoice-drawer.ejs', {
      invoice, items: [], returnTo: '', sharing: {
        ...sharing, label: 'Sales Invoice', endpoint: '/invoices/12/share',
      },
    }],
    ['purchase-drawer.ejs', {
      purchase, sharing: {
        ...sharing, label: 'Purchase Invoice', endpoint: '/purchases/12/share',
      },
    }],
    ['purchase-order-drawer.ejs', {
      order, sharing: {
        ...sharing, label: 'Purchase Order', endpoint: '/purchase-orders/12/share',
      },
    }],
    ['journal-drawer.ejs', {
      journal, journalTypeLabel: () => 'Journal Entry', sharing: {
        ...sharing, label: 'Journal Entry', endpoint: '/journals/12/share',
      },
    }],
    ['stock-entry.ejs', {
      entry: stockEntry, items: [], readOnly: true, stockEntryTypeLabels: { transfer: 'Transfer' },
      canManageWorkflow: true, sharing,
    }],
    ['stock-entry-drawer.ejs', {
      entry: stockEntry, items: [], stockEntryTypeLabels: { transfer: 'Transfer' },
      canManageWorkflow: true, sharing,
    }],
  ];
  for (const [view, locals] of views) {
    const html = await renderView(path.join(__dirname, '..', 'views', view), { ...common, ...locals });
    const sharingIndex = html.indexOf('data-entry-sharing-panel');
    const trackingIndex = html.indexOf('data-tracking-toggle');
    assert.ok(sharingIndex >= 0, `${view} must render Sharing`);
    assert.ok(trackingIndex > sharingIndex, `${view} must render Sharing before Tracking`);
  }
});

test('shared vouchers page lists record-specific access and links', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'shared-vouchers.ejs'), {
    assetVersion: 'test', availableReports: [], currentUser: { id: 9, role: 'standard', username: 'reader' },
    can: () => false, formatDate: String, money: String, query: {},
    result: { rows: [{
      voucher_type: 'purchases', voucher_id: 44, label: 'Purchase Invoice',
      href: '/purchases/44', number: 'PURINV-000044', posting_date: '2026-01-15',
      party: 'SUPPLIER', amount: 500, docstatus: 'draft', permission: 'write',
    }], pagination: { total: 1, page: 1, limit: 25, total_pages: 1, start: 1, end: 1 } },
  });
  assert.match(html, /Shared vouchers/);
  assert.match(html, /href="\/purchases\/44">PURINV-000044/);
  assert.match(html, /Read &amp; write/);
});

test('shared writers cannot introduce warehouses outside their permitted scope', async () => {
  await assert.rejects(validateSharedVoucherEdit({
    id: 9, role: 'standard', permissions: [],
    scopes: { warehouses: { mode: 'selected', values: ['Main'] } },
    record_access: {},
  }, 'sales', {
    customer_id: 'CUSTOMER', price_list: 'Retail', invoicer_id: '', cost_center: '',
    warehouse: 'Main', items: [{ warehouse: 'Main' }],
  }, {
    customer_id: 'CUSTOMER', price_list: 'Retail', invoicer_id: '', cost_center: '',
    warehouse: 'Private warehouse', items: [],
  }), { status: 403 });
});

test('sharing persists across every voucher type and shared users can save only drafts', {
  skip: process.env.VOUCHER_SHARING_TEST_POSTGRES !== '1',
}, async () => {
  const express = require('express');
  const auth = require('../src/auth');
  const store = require('../src/store');
  const purchases = require('../src/purchases');
  const purchaseOrders = require('../src/purchase-orders');
  const sharing = require('../src/voucher-sharing');
  const stockWorkflow = require('../src/stock-entry-workflow');
  const { runWithAuditUser } = require('../src/audit');
  const { currentPostingDate } = require('../src/posting-time');
  const { FIXED, seedGoldenData } = require('./helpers/golden-seed');
  let server;
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const draftDate = currentPostingDate();
    await pool.query(`INSERT INTO app_master_items
      (item_code,item_name,disabled,is_sales_item,is_purchase_item)
      VALUES ($1,$2,false,true,true) ON CONFLICT(item_code) DO NOTHING`,
    [FIXED.itemCode, FIXED.itemName]);
    await pool.query(`INSERT INTO app_master_warehouses(warehouse,is_group,disabled)
      VALUES ($1,false,false) ON CONFLICT(warehouse) DO NOTHING`, [FIXED.warehouse]);
    await pool.query(`INSERT INTO app_master_employees
      (employee_id,employee_name,status,disabled,docstatus)
      VALUES ('SHARE-EMP','Sharing Employee','Active',false,'submitted')
      ON CONFLICT(employee_id) DO NOTHING`);
    await pool.query(`INSERT INTO app_master_price_lists
      (price_list,currency,price_type,active,docstatus) VALUES
      ('Retail','UGX','selling',1,'submitted'),('Buying','UGX','buying',1,'submitted')`);
    await pool.query(`INSERT INTO app_master_item_prices
      (item_code,price_list,price_list_rate,item_name,currency,selling,buying,active,docstatus)
      VALUES ($1,'Retail',100,$2,'UGX',1,0,1,'submitted'),
        ($1,'Buying',50,$2,'UGX',0,1,1,'submitted')`, [FIXED.itemCode, FIXED.itemName]);
    const owner = await auth.createUser('sharing-owner', 'SharingPassword123!', { role: 'standard' });
    const recipient = await auth.createUser('sharing-recipient', 'SharingPassword123!', { role: 'standard' });
    await auth.saveUserPermissionOverrides(recipient.id, [],
      auth.PERMISSIONS.filter((permission) => permission.key).map((permission) => permission.key));
    const accounts = await store.accountingAccounts();
    const account = (code) => accounts.find((row) => row.account_code === code).id;
    const baseInvoice = {
      invoice_date: draftDate, due_date: draftDate,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      customer_phone: FIXED.customerPhone, price_list: 'Retail',
      invoicer_id: 'SHARE-EMP', invoicer: 'Sharing Employee',
      warehouse: FIXED.warehouse, notes: 'Share draft', discount_amount: 0,
      tax_amount: 0, payments: [],
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 100 }],
    };
    const invoiceId = await runWithAuditUser(owner, () => store.createInvoice(baseInvoice));
    const purchaseId = await runWithAuditUser(owner, () => purchases.createPurchase({
      posting_date: draftDate, posting_time: '10:00', due_date: draftDate,
      supplier_id: FIXED.supplierRef, price_list: 'Buying', cost_center: '',
      purchase_order_id: '', supplier_reference: 'SHARE-PURCHASE',
      remarks: 'Share purchase', items: [{ item_code: FIXED.itemCode,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 50 }],
    }));
    const orderId = await runWithAuditUser(owner, () => purchaseOrders.createPurchaseOrder({
      posting_date: draftDate, posting_time: '10:00', due_date: draftDate,
      supplier_id: FIXED.supplierRef, price_list: 'Buying', warehouse: FIXED.warehouse,
      cost_center: '', supplier_reference: 'SHARE-ORDER', remarks: 'Share order',
      items: [{ item_code: FIXED.itemCode, warehouse: FIXED.warehouse,
        quantity: 1, unit_price: 50 }],
    }));
    const journalId = await runWithAuditUser(owner, () => store.createJournalEntry({
      journal_type: 'journal_entry', posting_date: draftDate, posting_time: '10:00',
      party_type: '', party_id: '', remarks: 'Share journal draft',
      lines: [
        { account_id: account('1120'), debit: 10, credit: 0, remarks: 'Debit' },
        { account_id: account('3000'), debit: 0, credit: 10, remarks: 'Credit' },
      ],
    }, { submit: false }));
    const reconciliationId = await runWithAuditUser(owner, () => store.createStockEntry({
      entry_type: 'reconciliation', action: 'save_draft',
      posting_date: draftDate, posting_time: '10:00', cost_center: '',
      remarks: 'Share reconciliation',
      items: [{ item_code: FIXED.itemCode, warehouse: FIXED.warehouse,
        quantity: 10, valuation_rate: 50 }],
    }));
    const stockId = await runWithAuditUser(owner, () => store.createStockEntry({
      entry_type: 'opening', action: 'save_draft',
      posting_date: draftDate, posting_time: '10:00', cost_center: '',
      remarks: 'Regular stock share',
      items: [{ item_code: FIXED.itemCode, warehouse: FIXED.warehouse,
        quantity: 1, valuation_rate: 50 }],
    }));
    const records = {
      sales: invoiceId, purchases: purchaseId, 'purchase-orders': orderId,
      journals: journalId, 'stock-reconciliations': reconciliationId,
    };
    const paths = {
      sales: `/invoices/${invoiceId}`,
      purchases: `/purchases/${purchaseId}`,
      'purchase-orders': `/purchase-orders/${orderId}`,
      journals: `/journals/${journalId}`,
      'stock-reconciliations': `/stock/reconciliations/${reconciliationId}`,
    };
    for (const type of Object.keys(records)) {
      await sharing.changeVoucherShare(owner, type, records[type], 'share', recipient.id, 'read');
    }
    await stockWorkflow.changeStockEntryWorkflow(owner, stockId, 'share', recipient.id, 'read');
    const listed = await sharing.listSharedVouchers(recipient);
    assert.equal(listed.pagination.total, 6);
    assert.deepEqual(new Set(listed.rows.map((row) => row.voucher_type)),
      new Set([...Object.keys(records), 'stock']));

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
      res.render = (view, locals, callback) => {
        if (callback) return renderView(path.join(__dirname, '..', 'views', `${view}.ejs`),
          { ...res.locals, ...locals }).then((html) => callback(null, html), callback);
        return res.json({ view, ...locals });
      };
      next();
    });
    require('../src/auth-http').installAuth(app);
    app.use(require('../src/web/routes/voucher-sharing'));
    app.use(require('../src/web/routes/purchasing'));
    app.use('/stock', require('../src/web/routes/stock'));
    app.use(require('../src/web/routes/ledger'));
    app.use(require('../src/web/routes/sales'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = await new Promise((resolve) => {
      const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
    });
    let token = await auth.createSession(recipient.id);
    const root = `http://127.0.0.1:${server.address().port}`;
    const requestAs = (sessionToken) => (url, options = {}) => fetch(root + url, {
      ...options, redirect: 'manual',
      headers: { Cookie: `wm_session=${sessionToken}`, Accept: 'application/json', ...options.headers },
    });
    const request = requestAs(token);
    await auth.saveUserPermissionOverrides(owner.id, [
      'vouchers.journals.view', 'vouchers.journals.create', 'vouchers.journals.edit',
    ], []);
    const ownerRequest = requestAs(await auth.createSession(owner.id));
    const ownerJournalEdit = await ownerRequest(`${paths.journals}/edit`);
    assert.equal(ownerJournalEdit.status, 200);
    const ownerJournalEditBody = await ownerJournalEdit.json();
    assert.equal(ownerJournalEditBody.sharing.endpoint, `${paths.journals}/share`);
    const journalPrint = await ownerRequest(`${paths.journals}/print`);
    assert.equal(journalPrint.status, 200);
    assert.equal((await journalPrint.json()).view, 'journal-print');
    const journalDuplicate = await ownerRequest(`${paths.journals}/duplicate`);
    assert.equal(journalDuplicate.status, 200);
    const journalDuplicateBody = await journalDuplicate.json();
    assert.equal(journalDuplicateBody.view, 'journal-entry');
    assert.equal(journalDuplicateBody.journal.id, undefined);
    assert.equal(journalDuplicateBody.journal.posting_date, draftDate);
    assert.equal(journalDuplicateBody.journal.lines.length, 2);

    for (const [type, url] of Object.entries(paths)) {
      const response = await request(url);
      assert.equal(response.status, 200, type);
      const body = await response.json();
      assert.equal(body.sharedAccessOnly, true, type);
      assert.equal(body.sharing, null, type);
      assert.equal((await request(`${url}/edit`)).status, 403, type);
      await sharing.changeVoucherShare(owner, type, records[type], 'share', recipient.id, 'write');
      assert.equal((await request(`${url}/edit`)).status, 200, type);
    }

    const invoiceData = await store.findInvoicePage(invoiceId);
    const invoiceBody = new URLSearchParams({
      invoice_date: draftDate, posting_time: invoiceData.invoice.posting_time || '10:00',
      due_date: draftDate, customer_id: FIXED.customerId,
      customer_name: FIXED.customerName, price_list: 'Retail',
      cost_center: '', invoicer_id: invoiceData.invoice.invoicer_id || '',
      invoicer: invoiceData.invoice.invoicer || '', warehouse: FIXED.warehouse,
      notes: 'Saved through invoice sharing', discount_amount: '0', tax_amount: '0',
      payments_json: '[]', items_json: JSON.stringify(invoiceData.items.map((item) => ({
        item_code: item.item_code, quantity: item.quantity, unit_price: item.unit_price,
      }))),
    });
    const saveInvoiceResponse = await request(paths.sales, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: invoiceBody.toString() });
    assert.equal(saveInvoiceResponse.status, 302, await saveInvoiceResponse.text());
    assert.equal((await store.findInvoicePage(invoiceId)).invoice.notes, 'Saved through invoice sharing');

    const purchase = await purchases.loadPurchase(purchaseId);
    const purchaseBody = new URLSearchParams({
      posting_date: draftDate, posting_time: purchase.posting_time || '10:00',
      due_date: draftDate, supplier_id: FIXED.supplierRef, supplier_name: FIXED.supplierName,
      price_list: 'Buying', cost_center: '', purchase_order_id: '',
      supplier_reference: 'SHARE-PURCHASE', remarks: 'Saved through purchase sharing',
    });
    for (const item of purchase.items) {
      purchaseBody.append('item_id', String(item.id));
      purchaseBody.append('item_name', item.item_name || '');
      purchaseBody.append('purchase_order_item_id', '');
      purchaseBody.append('item_code', item.item_code);
      purchaseBody.append('warehouse', item.warehouse);
      purchaseBody.append('quantity', String(item.quantity));
      purchaseBody.append('unit_price', String(item.unit_price));
    }
    assert.ok([302, 303].includes((await request(paths.purchases, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: purchaseBody.toString() })).status));
    assert.equal((await purchases.loadPurchase(purchaseId)).remarks, 'Saved through purchase sharing');

    const order = await purchaseOrders.loadPurchaseOrder(orderId);
    const orderBody = new URLSearchParams({
      posting_date: draftDate, posting_time: order.posting_time || '10:00',
      due_date: draftDate, supplier_id: FIXED.supplierRef, supplier_name: FIXED.supplierName,
      price_list: 'Buying', warehouse: FIXED.warehouse, cost_center: '',
      supplier_reference: 'SHARE-ORDER', remarks: 'Saved through order sharing',
    });
    for (const item of order.items) {
      orderBody.append('item_id', String(item.id));
      orderBody.append('item_name', item.item_name || '');
      orderBody.append('item_code', item.item_code);
      orderBody.append('quantity', String(item.quantity));
      orderBody.append('unit_price', String(item.unit_price));
    }
    assert.ok([302, 303].includes((await request(paths['purchase-orders'], { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: orderBody.toString() })).status));
    assert.equal((await purchaseOrders.loadPurchaseOrder(orderId)).remarks, 'Saved through order sharing');

    const journal = await store.findJournalEntry(journalId);
    const journalBody = new URLSearchParams({
      journal_type: journal.journal_type, posting_date: draftDate,
      posting_time: journal.posting_time || '10:00', cost_center: '',
      party_type: '', party_id: '', party_name: '', reference_no: '',
      remarks: 'Saved through journal sharing', action: 'save_draft',
    });
    for (const line of journal.lines) {
      journalBody.append('line_id', String(line.id));
      journalBody.append('account_id', String(line.account_id));
      journalBody.append('debit', String(line.debit));
      journalBody.append('credit', String(line.credit));
      journalBody.append('line_remarks', line.remarks || '');
      journalBody.append('line_reference_no', line.reference_no || '');
    }
    assert.ok([302, 303].includes((await request(paths.journals, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: journalBody.toString() })).status));
    assert.equal((await store.findJournalEntry(journalId)).remarks, 'Saved through journal sharing');

    const reconciliation = await store.loadStockEntry(reconciliationId);
    const reconciliationBody = new URLSearchParams({
      entry_type: 'reconciliation', action: 'save_draft', warehouse: FIXED.warehouse,
      posting_date: draftDate, posting_time: reconciliation.entry.posting_time || '10:00',
      cost_center: '', remarks: 'Saved through reconciliation sharing',
    });
    for (const item of reconciliation.items) {
      reconciliationBody.append('id', String(item.id));
      reconciliationBody.append('item_code', item.item_code);
      reconciliationBody.append('item_name', item.item_name || '');
      reconciliationBody.append('target_warehouse', '');
      reconciliationBody.append('quantity', String(item.quantity));
      reconciliationBody.append('valuation_rate', String(item.valuation_rate));
    }
    const saveReconciliationResponse = await request(paths['stock-reconciliations'], { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: reconciliationBody.toString() });
    assert.ok([302, 303].includes(saveReconciliationResponse.status),
      `${saveReconciliationResponse.status}: ${await saveReconciliationResponse.text()}`);
    assert.equal((await store.loadStockEntry(reconciliationId)).entry.remarks,
      'Saved through reconciliation sharing');

    for (const [type, url] of Object.entries(paths)) {
      for (const suffix of ['submit', 'cancel', 'delete', 'share']) {
        assert.equal((await request(`${url}/${suffix}`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })).status,
        403, `${type} ${suffix}`);
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.closeStore();
  }
});
