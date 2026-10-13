'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('../../src/store');
const auth = require('../../src/auth');
const { runWithAuditUser } = require('../../src/audit');
const FILE = '/staging-state/credentials.json';

async function guard(pool) {
  const name = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  if (process.env.API_STAGING !== '1' || name !== 'work_master_api_staging') throw new Error('Staging tools require the dedicated staging database.');
}

async function main() {
  const pool = store.getPostgresPool(); await guard(pool);
  if (fs.existsSync(FILE)) {
    const state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const existing = await auth.authenticate(state.admin.username, state.admin.password);
    if (!existing || existing.role !== 'admin' || !state.fixture) throw new Error('Existing staging seed needs review; no reset was performed.');
    console.log('Existing local staging seed retained.'); return;
  }
  if ((await pool.query("SELECT to_regclass('public.app_users') AS existing")).rows[0].existing) throw new Error('Refusing to seed a nonempty staging database without its credential file.');
  await store.initStore();
  const credentials = { admin: { username: 'staging-admin', password: crypto.randomBytes(32).toString('base64url') },
    mobile: { username: 'staging-mobile', password: crypto.randomBytes(32).toString('base64url') } };
  const admin = await auth.createUser(credentials.admin.username, credentials.admin.password, { role: 'admin' });
  const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
  const bank = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1120'")).rows[0].id;
  const role = await auth.createRole('Staging Sales Limited', ['vouchers.sales.create', 'vouchers.sales.submit', 'vouchers.sales.view', 'payments.sales.record'], {
    customers: { mode: 'selected', values: ['retail'] }, warehouses: { mode: 'selected', values: ['Staging Main'] },
    invoicePriceLists: { mode: 'selected', values: ['Staging Retail'] }, accounts: { mode: 'selected', values: [String(cash)] },
  });
  await auth.createUser(credentials.mobile.username, credentials.mobile.password, { role: role.slug,
    record_access: { employee_id: 'STG-E1', cost_center: 'STG-CC1' } });
  await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,docstatus) VALUES
    ('STG-C1','Staging Customer','Retail','submitted'),('STG-HIDDEN','Hidden Staging Customer','Wholesale','submitted');
    INSERT INTO app_master_warehouses(warehouse,docstatus) VALUES ('Staging Main','submitted'),('Staging Hidden','submitted');
    INSERT INTO app_master_price_lists(price_list,currency,price_type,active,docstatus) VALUES ('Staging Retail','UGX','selling',1,'submitted');
    INSERT INTO app_master_items(item_code,item_name,stock_uom,docstatus) VALUES ('STG-I1','Staging Item','Each','submitted');
    INSERT INTO app_master_employees(employee_id,employee_name,status) VALUES ('STG-E1','Staging Invoicer','Active');
    INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES ('STG-CC1','Staging Cost Center');`);
  await runWithAuditUser(admin, () => store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
    { item_code: 'STG-I1', item_name: 'Staging Item', warehouse: 'Staging Main', quantity: 1000, valuation_rate: 20 },
    { item_code: 'STG-I1', item_name: 'Staging Item', warehouse: 'Staging Hidden', quantity: 1000, valuation_rate: 20 },
  ] }));
  const hidden = await runWithAuditUser(admin, () => store.createInvoice({ customer_id: 'STG-HIDDEN', customer_name: 'Hidden Staging Customer',
    price_list: 'Staging Retail', invoicer_id: 'STG-E1', invoicer: 'Staging Invoicer', invoice_date: '2026-10-01',
    items: [{ item_code: 'STG-I1', item_name: 'Staging Item', warehouse: 'Staging Hidden', quantity: 1, unit_price: 100 }] }));
  credentials.fixture = { cash: String(cash), bank: String(bank), hidden: String(hidden), role: role.slug };
  fs.writeFileSync(FILE, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Synthetic local staging records and restricted accounts created; credentials are stored privately.');
}
if (require.main === module) main().catch(() => { console.error('Staging seeding failed; no credentials logged and no reset performed.'); process.exitCode = 1; }).finally(store.closeStore);
module.exports = { guard };
