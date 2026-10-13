'use strict';
// Called only by the disposable Docker restore drill. No application .env.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const store = require('../src/store');
const auth = require('../src/auth');
const apiAuth = require('../src/api/auth');
const { executeInvoiceOperation } = require('../src/services/sales');

async function fingerprints(pool, financialOnly = false) {
  const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result = {};
  for (const { tablename } of rows) {
    if (financialOnly && !['app_invoices', 'app_invoice_items', 'app_invoice_payments', 'app_journal_entries',
      'app_journal_entry_lines', 'app_gl_entries', 'app_stock_balances', 'app_stock_ledger', 'wm_api_payment_references'].includes(tablename)) continue;
    const identifier = '"' + tablename.replace(/"/g, '""') + '"';
    const records = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM public.${identifier} t ORDER BY to_jsonb(t)::text`)).rows;
    result[tablename] = { count: records.length, sha256: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex') };
  }
  return result;
}

async function main() {
  if (process.env.API_RECOVERY_DRILL !== '1' || !['seed', 'verify'].includes(process.argv[2]) || !process.argv[3]) {
    throw new Error('Use the isolated Docker recovery procedure.');
  }
  const pool = store.getPostgresPool();
  const name = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  if (!/^work_master_(source|restore)_hr_test$/.test(name)) throw new Error('Recovery drill requires its dedicated *_hr_test databases.');
  const stateFile = process.argv[3];
  if (process.argv[2] === 'seed') {
    if ((await pool.query("SELECT to_regclass('public.app_users') AS existing")).rows[0].existing) throw new Error('Recovery seeding requires an empty database.');
    await store.initStore();
    const admin = await auth.createUser('recovery-admin', 'LocalRecoveryOnly123!', { role: 'admin' });
    const role = await auth.createRole('Recovery restricted', ['vouchers.sales.create', 'vouchers.sales.submit', 'vouchers.sales.view', 'payments.sales.record'],
      { customers: { mode: 'selected', values: ['retail'] }, warehouses: { mode: 'selected', values: ['Recovery Main'] }, invoicePriceLists: { mode: 'selected', values: ['Recovery Retail'] } });
    const mobile = await auth.createUser('recovery-mobile', 'LocalRecoveryOnly123!', { role: role.slug });
    const login = await apiAuth.login(mobile.username, 'LocalRecoveryOnly123!', crypto.randomUUID());
    const adminLogin = await apiAuth.login(admin.username, 'LocalRecoveryOnly123!', crypto.randomUUID());
    const adminActor = await apiAuth.resolveBearer(adminLogin.access_token, crypto.randomUUID());
    const integration = await apiAuth.createIntegration(adminActor, 'recovery-integration', role.slug,
      ['invoices:create', 'invoices:submit', 'invoices:read', 'payments:record']);
    const revoked = await apiAuth.rotateCredential(adminActor, integration.user_id, ['invoices:read']);
    await apiAuth.revokeCredential(adminActor, revoked.id);
    await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,docstatus) VALUES ('REC-C1','Recovery Customer','Retail','submitted');
      INSERT INTO app_master_warehouses(warehouse,docstatus) VALUES ('Recovery Main','submitted');
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active,docstatus) VALUES ('Recovery Retail','UGX','selling',1,'submitted');
      INSERT INTO app_master_employees(employee_id,employee_name,status) VALUES ('REC-E1','Recovery Invoicer','Active');
      INSERT INTO app_master_items(item_code,item_name,stock_uom,docstatus) VALUES ('REC-I1','Recovery Item','Each','submitted');`);
    await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
      { item_code: 'REC-I1', item_name: 'Recovery Item', warehouse: 'Recovery Main', quantity: 10, valuation_rate: 20 }] });
    const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
    const payload = { customer_id: 'REC-C1', warehouse: 'Recovery Main', price_list: 'Recovery Retail', invoicer_id: 'REC-E1',
      invoice_date: '2026-10-01', items: [{ item_code: 'REC-I1', quantity: '2', unit_price: '100' }] };
    const payment = { payment_date: '2026-10-01', amount: '50', account_id: String(cash), external_source: 'restore-drill', external_reference: 'REC-RECEIPT-1' };
    const actor = await apiAuth.resolveBearer(integration.token, crypto.randomUUID());
    const created = await executeInvoiceOperation(actor, 'invoice.create', null, 'recovery-create', payload);
    const id = created.body.data.id;
    await executeInvoiceOperation(actor, 'invoice.submit', id, 'recovery-submit', {});
    const paid = await executeInvoiceOperation(actor, 'payment.record', id, 'recovery-payment', payment);
    // Demo credentials are written only to a protected temporary fixture, never logs.
    fs.writeFileSync(stateFile, JSON.stringify({ tables: await fingerprints(pool), financial: await fingerprints(pool, true),
      tokens: { mobile: login.access_token, integration: integration.token, revoked: revoked.token },
      id, payload, payment, created: created.body, paid: paid.body }), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'api_restore_seed', tables: Object.keys((await fingerprints(pool))).length, financial_receipts: 1 }));
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(await fingerprints(pool), state.tables, 'Every public table must match the original backup');
  await store.initStore(); // Restored schema must support application initialization.
  assert(await apiAuth.resolveBearer(state.tokens.mobile, crypto.randomUUID()));
  assert.equal(await apiAuth.resolveBearer(state.tokens.revoked, crypto.randomUUID()), null);
  const actor = await apiAuth.resolveBearer(state.tokens.integration, crypto.randomUUID());
  assert(actor);
  const create = await executeInvoiceOperation(actor, 'invoice.create', null, 'recovery-create', state.payload);
  assert(create.replayed); assert.deepEqual(create.body, state.created);
  const submit = await executeInvoiceOperation(actor, 'invoice.submit', state.id, 'recovery-submit', {});
  assert(submit.replayed);
  const paid = await executeInvoiceOperation(actor, 'payment.record', state.id, 'recovery-payment', state.payment);
  assert(paid.replayed); assert.deepEqual(paid.body, state.paid);
  const newKey = await executeInvoiceOperation(actor, 'payment.record', state.id, 'recovery-new-key', state.payment);
  assert(newKey.referenceReplayed); assert.deepEqual(newKey.body, state.paid);
  assert.deepEqual(await fingerprints(pool, true), state.financial, 'Restored retry/reference protection must not repost financial effects');
  const next = await executeInvoiceOperation(actor, 'invoice.create', null, 'recovery-next', state.payload);
  assert(Number(next.body.data.id) > Number(state.id), 'Restored sequences must permit new records');
  console.log(JSON.stringify({ event: 'api_restore_verified', all_table_fingerprints_match: true,
    initialization: true, mobile_credential: true, integration_credential: true, revocation_preserved: true,
    retries_preserved: true, duplicate_reference_preserved: true, no_reposting: true, sequence_continuity: true }));
}
main().catch(() => { console.error('API restore verification failed; no credentials or database content were logged.'); process.exitCode = 1; }).finally(store.closeStore);
