'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderView } = require('./helpers/render-view');
const workflow = require('../src/stock-entry-workflow');
const { permissionCheck, scopeCheck } = require('../src/authorize');

test('shared read grants apply only to the detail and drawer GET routes', async () => {
  const currentUser = { id: 7, role: 'standard', permissions: [],
    scopes: { suppliers: { mode: 'selected', values: [] } } };
  for (const url of ['/stock/entries/12', '/stock/entries/12/drawer']) {
    const req = { currentUser, stockEntrySharedRead: true, path: url, method: 'GET', body: {} };
    assert.equal(permissionCheck(req), true);
    assert.equal(await scopeCheck(req), true);
    assert.equal(permissionCheck({ ...req, stockEntrySharedRead: false }), false);
    assert.equal(permissionCheck({ ...req, method: 'POST' }), false);
  }
  for (const url of ['/stock/entries/12/edit', '/stock/entries/12/duplicate', '/stock/entries/12/share',
    '/stock/entries/12/delivery', '/stock/entries/12/submit', '/stock/entries/12/cancel', '/stock/reconciliations/12']) {
    assert.equal(permissionCheck({ currentUser, path: url, method: 'POST', body: {}, stockEntrySharedRead: true }), false);
  }
  assert.equal(workflow.canManageStockEntry(currentUser, { created_by_user_id: '7' }), true);
  assert.equal(workflow.canManageStockEntry(currentUser, { created_by_user_id: null }), false);
  assert.equal(workflow.canManageStockEntry({ role: 'finance', id: 8 }, { created_by_user_id: '7' }), false);
  assert.equal(workflow.canManageStockEntry({ role: 'admin' }, { created_by_user_id: null }), true);
});

test('item values handle fractional quantities, negative adjustments, cleared and refreshed rates', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/stock-entry.js'), 'utf8');
  const fn = source.slice(source.indexOf('function updateStockEntryValues()'), source.indexOf('function updateRowsBalances()'));
  const row = (quantity, rate) => ({ quantity: { value: quantity }, rate: { value: rate }, output: {},
    querySelector(selector) { return selector.includes('quantity') ? this.quantity : selector.includes('valuation_rate') ? this.rate : this.output; } });
  const rows = [row('1.25', '10'), row('-0.25', '10'), row('', '40')];
  const total = {};
  const context = vm.createContext({ tableBody: { querySelectorAll: () => rows }, document: { querySelector: () => total } });
  vm.runInContext(fn + '\nupdateStockEntryValues();', context);
  assert.deepEqual(rows.map(r => r.output.textContent), ['13', '-2', '0']);
  assert.equal(total.textContent, '11');
  rows[0].rate.value = '20';
  rows.splice(1, 1);
  vm.runInContext('updateStockEntryValues()', context);
  assert.equal(rows[0].output.textContent, '25');
  assert.equal(total.textContent, '25');
});

test('shared write grants draft edit and delivery actions without posting or onward sharing', async () => {
  const base = { currentUser: { id: 7, role: 'standard', permissions: [], scopes: { suppliers: { mode: 'selected', values: [] } } }, stockEntrySharedWrite: true, body: {} };
  for (const [method, url, body] of [['GET', '/stock/entries/12/edit', {}],
    ['POST', '/stock/entries/12', { action: 'save_draft' }], ['POST', '/stock/entries/12/delivery', {}]]) {
    const req = { ...base, method, path: url, body };
    assert.equal(permissionCheck(req), true);
    assert.equal(await scopeCheck(req), true);
    assert.equal(permissionCheck({ ...req, stockEntrySharedWrite: false }), false);
  }
  for (const action of ['share', 'submit', 'cancel', 'delete', 'supplier', 'posting-time']) {
    assert.equal(permissionCheck({ ...base, method: 'POST', path: '/stock/entries/12/' + action }), false);
  }
  assert.equal(permissionCheck({ ...base, method: 'POST', path: '/stock/entries/12', body: { action: 'submit' } }), false);
});

test('full and drawer previews show values, delivery and owner sharing with read-only recipient actions', async () => {
  const locals = { assetVersion: 'test', currentUser: { id: 7, role: 'standard' }, can: () => true,
    availableReports: [], money: value => `Ugx ${value}`, today: '2026-10-18', error: null, readOnly: true,
    entry: { id: 12, entry_no: 'STK-12', entry_type: 'transfer', docstatus: 'draft', delivery_status: 'In Transit',
      created_by_user_id: '7', posting_date: '2026-10-18' },
    items: [{ item_code: 'ITEM', warehouse: 'Source', target_warehouse: 'Target', quantity: 1.25, valuation_rate: 10 }],
    deliveryStatuses: workflow.DELIVERY_STATUSES, canManageWorkflow: true,
    sharing: { users: [{ id: 9, username: 'reader' }], shares: [{ user_id: 9, username: 'reader', active: true, granted_at: new Date() }] } };
  for (const view of ['stock-entry.ejs', 'stock-entry-drawer.ejs']) {
    const html = await renderView(path.join(__dirname, '../views', view), locals);
    assert.match(html, /Item value \(UGX\)/);
    assert.match(html, /Ugx 13/);
    assert.match(html, /Total item value/);
    assert.match(html, /value="In Transit" selected/);
    assert.match(html, /name="permission"/);
    assert.match(html, /Read &amp; write/);
    assert.match(html, /Remove access for reader/);
    const shared = await renderView(path.join(__dirname, '../views', view), {
      ...locals, canManageWorkflow: false, sharing: null, sharedAccessOnly: true,
    });
    assert.match(shared, /<span>Delivery status<\/span><strong>In Transit/);
    assert.doesNotMatch(shared, /name="permission"|Save delivery status|Delete Draft|>Submit<|>Duplicate<|>Edit<\/a>/);
    const writer = await renderView(path.join(__dirname, '../views', view), {
      ...locals, canManageWorkflow: false, canUpdateDelivery: true, sharing: null, sharedAccessOnly: true, sharedWriteAccess: true,
    });
    assert.match(writer, />Edit<\/a>/);
    assert.match(writer, /Save delivery status/);
    assert.doesNotMatch(writer, /name="permission"|Delete Draft|>Submit<|>Duplicate<|Update permission/);
  }
});

test('delivery is a main field on new and edit forms and remains editable on submitted previews', async () => {
  const locals = { assetVersion: 'test', currentUser: { id: 7, role: 'standard' }, can: () => true,
    availableReports: [], today: '2026-10-18', currentPostingTime: () => '12:00',
    scriptJson: JSON.stringify, items: [], entry: null, error: null, money: String };
  for (const entry of [null, { id: 12, entry_type: 'transfer', docstatus: 'draft', posting_date: locals.today,
    created_by_user_id: '7', delivery_status: 'Picked & packed' }]) {
    const html = await renderView(path.join(__dirname, '../views/stock-entry.ejs'), { ...locals, entry });
    const mainFields = html.slice(html.indexOf('<section class="form-grid ui-form-grid">'), html.indexOf('id="stock-entry-item-status" class='));
    assert.match(mainFields, /name="delivery_status"/);
    for (const status of ['In Transit', 'Delivered', 'All Received']) assert.ok(mainFields.includes(status));
    assert.doesNotMatch(mainFields, /name="delivery_status" disabled/);
    if (entry) assert.match(mainFields, /value="Picked &amp; packed" selected/);
  }
  const writerEditor = await renderView(path.join(__dirname, '../views/stock-entry.ejs'), {
    ...locals, currentUser: { id: 9, role: 'standard' }, sharedWriteAccess: true,
    entry: { id: 12, entry_no: 'STK-12', entry_type: 'transfer', docstatus: 'draft', posting_date: locals.today,
      created_by_user_id: '7', delivery_status: 'In Transit' },
  });
  assert.match(writerEditor, /name="delivery_status"/);
  assert.doesNotMatch(writerEditor, /name="delivery_status" disabled|name="action" value="submit"/);
  assert.match(writerEditor, /Save Stock Entry/);
  const entry = { id: 12, entry_no: 'STK-12', entry_type: 'transfer', docstatus: 'submitted', posting_date: locals.today, delivery_status: 'In Transit' };
  for (const view of ['stock-entry.ejs', 'stock-entry-drawer.ejs']) {
    const html = await renderView(path.join(__dirname, '../views', view), { ...locals, entry, readOnly: true, canManageWorkflow: true });
    const mainFields = html.slice(html.indexOf('aria-label="Stock entry details"'), html.indexOf('aria-label="Stock entry items"'));
    assert.match(mainFields, /name="delivery_status"/);
    assert.match(mainFields, /action="\/stock\/entries\/12\/delivery"/);
    assert.match(mainFields, /Save delivery status/);
    assert.doesNotMatch(mainFields, /name="delivery_status" disabled/);
  }
});

test('stock delivery and sharing persist, reject unauthorized changes, and enforce HTTP read-only access', {
  skip: process.env.RECONCILIATION_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const auth = require('../src/auth');
  const { runWithAuditUser } = require('../src/audit');
  const { FIXED, seedGoldenData } = require('./helpers/golden-seed');
  let server;
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const owner = await auth.createUser('stock-owner', 'StockPassword123!', { role: 'standard' });
    const recipient = await auth.createUser('stock-reader', 'StockPassword123!', { role: 'standard' });
    const other = await auth.createUser('stock-other', 'StockPassword123!', { role: 'standard' });
    const admin = await auth.createUser('stock-admin', 'StockPassword123!', { role: 'admin' });
    await auth.saveUserPermissionOverrides(recipient.id, [], auth.PERMISSIONS.map(p => p.key));
    const draftPayload = { entry_type: 'opening',
      action: 'save_draft', posting_date: FIXED.date,
      items: [{ item_code: FIXED.itemCode, warehouse: FIXED.warehouse, quantity: 1.25, valuation_rate: 10 }] };
    const initialCount = (await pool.query('SELECT COUNT(*)::int n FROM app_stock_entries')).rows[0].n;
    await assert.rejects(runWithAuditUser(owner, () => store.createStockEntry({ ...draftPayload, delivery_status: 'Invalid' }, { deliveryUser: owner })), { status: 400 });
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_stock_entries')).rows[0].n, initialCount);
    const id = await runWithAuditUser(owner, () => store.createStockEntry({ ...draftPayload, delivery_status: 'Picked & packed' }, { deliveryUser: owner }));
    const data = await store.loadStockEntry(id);
    assert.equal(data.entry.delivery_status, 'Picked & packed');
    await runWithAuditUser(owner, () => store.updateStockEntry(id, { ...draftPayload, delivery_status: 'In Transit' }, { deliveryUser: owner }));
    assert.equal((await store.loadStockEntry(id)).entry.delivery_status, 'In Transit');
    const changedPayload = { ...draftPayload, remarks: 'Should roll back', delivery_status: 'Delivered' };
    await assert.rejects(runWithAuditUser(other, () => store.updateStockEntry(id, changedPayload, { deliveryUser: other })), { status: 403 });
    await assert.rejects(runWithAuditUser(owner, () => store.updateStockEntry(id, { ...changedPayload, delivery_status: 'Invalid' }, { deliveryUser: owner })), { status: 400 });
    assert.equal((await store.loadStockEntry(id)).entry.delivery_status, 'In Transit');
    assert.equal((await store.loadStockEntry(id)).entry.remarks, data.entry.remarks);
    await assert.rejects(workflow.changeStockEntryWorkflow(other, id, 'share', recipient.id), { status: 403 });
    await assert.rejects(workflow.changeStockEntryWorkflow(other, id, 'delivery', 'Delivered'), { status: 403 });
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'delivery', 'Invalid'), { status: 400 });
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'share', owner.id), { status: 400 });
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'share', admin.id), { status: 400 });
    const inactive = await auth.createUser('stock-inactive', 'StockPassword123!', { role: 'standard' });
    await pool.query('UPDATE app_users SET active=false WHERE id=$1', [inactive.id]);
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'share', inactive.id), { status: 400 });

    const express = require('express');
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
      res.render = (view, locals, callback) => {
        if (callback) return renderView(path.join(__dirname, '../views', `${view}.ejs`), { ...res.locals, ...locals })
          .then(html => callback(null, html), callback);
        return res.json({ view, ...locals });
      };
      next();
    });
    require('../src/auth-http').installAuth(app);
    app.use('/stock', require('../src/web/routes/stock'));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
    const token = await auth.createSession(recipient.id);
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = (pathname, options = {}) => fetch(url + pathname, {
      ...options, redirect: 'manual', headers: { Cookie: `wm_session=${token}`, Accept: 'application/json', ...options.headers },
    });
    assert.equal((await request(`/stock/entries/${id}`)).status, 403);
    await workflow.changeStockEntryWorkflow(owner, id, 'share', recipient.id);
    await workflow.changeStockEntryWorkflow(owner, id, 'share', recipient.id);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_stock_entry_shares WHERE stock_entry_id=$1', [id])).rows[0].n, 1);
    for (const pathname of [`/stock/entries/${id}`, `/stock/entries/${id}/drawer`]) {
      const response = await request(pathname);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const body = await response.json();
      assert.equal(Number(body.entry.id), Number(id));
      assert.equal(body.sharedAccessOnly, true);
      assert.equal(body.sharing, null);
    }
    const shared = await (await request('/stock/shared')).json();
    assert.deepEqual(shared.result.rows.map(row => row.id), [Number(id)]);
    assert.equal(shared.result.rows[0].total_value, 13);
    assert.equal((await request(`/stock/entries/${id + 1000}`)).status, 403);
    for (const action of ['edit', 'duplicate']) assert.equal((await request(`/stock/entries/${id}/${action}`)).status, 403);
    for (const action of ['share', 'delivery', 'submit', 'cancel', 'delete', 'supplier', 'posting-time']) {
      assert.equal((await request(`/stock/entries/${id}/${action}`, { method: 'POST' })).status, 403);
    }
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'share', recipient.id, 'invalid'), { status: 400 });
    await auth.saveUserPermissionOverrides(owner.id, ['vouchers.stock.view'], auth.PERMISSIONS.filter(p => p.key !== 'vouchers.stock.view').map(p => p.key));
    const sharingOwnerToken = await auth.createSession(owner.id);
    const grantWrite = await request(`/stock/entries/${id}/share`, { method: 'POST',
      headers: { Cookie: `wm_session=${sharingOwnerToken}`, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ user_id: String(recipient.id), permission: 'write' }).toString() });
    assert.equal(grantWrite.status, 200);
    assert.match((await grantWrite.json()).html, /data-entry-sharing-panel/);
    const invalidShare = await request(`/stock/entries/${id}/share`, { method: 'POST',
      headers: { Cookie: `wm_session=${sharingOwnerToken}`, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ user_id: String(recipient.id), permission: 'invalid' }).toString() });
    assert.equal(invalidShare.status, 400);
    assert.match((await invalidShare.json()).error, /Choose Read-only or Read & write/);
    assert.equal(await workflow.stockEntryShareAccess(recipient, id), 'write');
    assert.equal((await request(`/stock/entries/${id}/edit`)).status, 200);
    assert.equal((await (await request('/stock/shared')).json()).result.rows[0].share_permission, 'write');
    const editBody = new URLSearchParams({ entry_type: 'opening', action: 'save_draft', posting_date: FIXED.date,
      item_code: FIXED.itemCode, warehouse: FIXED.warehouse, quantity: '1.25', valuation_rate: '10',
      remarks: 'Edited through write sharing', delivery_status: 'In Transit' });
    const editResponse = await request(`/stock/entries/${id}`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: editBody.toString() });
    assert.equal(editResponse.status, 303);
    assert.equal(editResponse.headers.get('location'), `/stock/entries/${id}/edit`);
    const savedEditor = await request(editResponse.headers.get('location'));
    assert.equal(savedEditor.status, 200);
    const savedEditorBody = await savedEditor.json();
    assert.equal(savedEditorBody.entry.docstatus, 'draft');
    assert.equal(savedEditorBody.sharedWriteAccess, true);
    assert.equal((await store.loadStockEntry(id)).entry.remarks, 'Edited through write sharing');
    for (const action of ['share', 'submit', 'cancel', 'delete']) {
      assert.equal((await request(`/stock/entries/${id}/${action}`, { method: 'POST' })).status, 403);
    }
    const postAttempt = new URLSearchParams(editBody); postAttempt.set('action', 'submit');
    assert.equal((await request(`/stock/entries/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: postAttempt.toString() })).status, 403);
    const downgrade = await request(`/stock/entries/${id}/share`, { method: 'POST',
      headers: { Cookie: `wm_session=${sharingOwnerToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: String(recipient.id), permission: 'read' }).toString() });
    assert.equal(downgrade.status, 303);
    assert.equal((await request(`/stock/entries/${id}/edit`)).status, 403);
    assert.equal((await request(`/stock/entries/${id}/delivery`, { method: 'POST' })).status, 403);
    await assert.rejects(runWithAuditUser(recipient, () => store.updateStockEntry(id, draftPayload,
      { deliveryUser: recipient, sharedWrite: true })), { status: 403 });
    await workflow.changeStockEntryWorkflow(owner, id, 'share', recipient.id, 'write');
    await pool.query(`UPDATE app_users SET record_access='{"warehouse":"Unrelated warehouse"}'::jsonb WHERE id=$1`, [recipient.id]);
    const badWarehouse = new URLSearchParams(editBody); badWarehouse.set('warehouse', 'Unrelated private warehouse');
    assert.equal((await request(`/stock/entries/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: badWarehouse.toString() })).status, 403);
    assert.equal((await store.loadStockEntry(id)).items[0].warehouse, FIXED.warehouse);
    const beforeLedger = (await pool.query('SELECT COUNT(*)::int n FROM app_stock_ledger')).rows[0].n;
    for (const status of workflow.DELIVERY_STATUSES) {
      await workflow.changeStockEntryWorkflow(owner, id, 'delivery', status);
      assert.equal((await store.loadStockEntry(id)).entry.delivery_status, status);
      assert.equal((await store.listStockEntries({ sharedWithUserId: recipient.id, delivery_status: status })).pagination.total, 1);
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_stock_ledger')).rows[0].n, beforeLedger);
    await workflow.changeStockEntryWorkflow(admin, id, 'delivery', '');
    assert.equal((await store.loadStockEntry(id)).entry.delivery_status, '');
    const savedDraft = await store.loadStockEntry(id);
    await runWithAuditUser(owner, () => store.updateStockEntry(id, { ...savedDraft.entry, action: 'submit', items: savedDraft.items }));
    const postingSnapshot = async () => (await pool.query(`SELECT
      (SELECT to_jsonb(s) FROM app_stock_entries s WHERE id=$1) AS document,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM app_stock_entry_items i WHERE stock_entry_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) AS stock,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) AS accounting`, [id])).rows[0];
    const beforeDelivery = await postingSnapshot();
    await auth.saveUserPermissionOverrides(owner.id, ['vouchers.stock.view'], auth.PERMISSIONS.filter(p => p.key !== 'vouchers.stock.view').map(p => p.key));
    const ownerToken = await auth.createSession(owner.id);
    const deliveryResponse = await request(`/stock/entries/${id}/delivery`, { method: 'POST',
      headers: { Cookie: `wm_session=${ownerToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'delivery_status=Delivered' });
    assert.equal(deliveryResponse.status, 303);
    assert.equal((await store.loadStockEntry(id)).entry.delivery_status, 'Delivered');
    assert.deepEqual(await postingSnapshot(), beforeDelivery);
    const writerDelivery = await request(`/stock/entries/${id}/delivery`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'delivery_status=All+Received' });
    assert.equal(writerDelivery.status, 303);
    assert.equal((await store.loadStockEntry(id)).entry.delivery_status, 'All Received');
    assert.deepEqual(await postingSnapshot(), beforeDelivery);
    await workflow.changeStockEntryWorkflow(admin, id, 'revoke', recipient.id);
    assert.equal((await request(`/stock/entries/${id}`)).status, 403);
    assert.equal((await (await request('/stock/shared')).json()).result.pagination.total, 0);

    await pool.query("UPDATE app_stock_entries SET docstatus='cancelled' WHERE id=$1", [id]);
    await assert.rejects(workflow.changeStockEntryWorkflow(owner, id, 'delivery', 'Delivered'), { status: 400 });
    await workflow.changeStockEntryWorkflow(owner, id, 'share', recipient.id);
    assert.equal(await workflow.sharedStockEntry(recipient, id), true);
    await pool.query('DELETE FROM app_stock_entries WHERE id=$1', [id]);
    assert.equal(await workflow.sharedStockEntry(recipient, id), false);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_stock_entry_delivery WHERE stock_entry_id=$1', [id])).rows[0].n, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await store.closeStore();
  }
});
