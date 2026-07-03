const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-purchase-tax-template-fix-log.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function sslConfig() {
  return ['1', 'true', 'required', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;
}

function flag(value) {
  return Number(value || 0) ? 1 : 0;
}

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

async function login(base, usr, pwd) {
  const response = await fetch(`${base}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ usr, pwd }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Login failed ${response.status}: ${text.slice(0, 300)}`);
  return (response.headers.get('set-cookie') || '')
    .split(/,(?=\s*\w+=)/)
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

async function requestJson(base, cookie, resourcePath, options = {}) {
  const response = await fetch(`${base}${resourcePath}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      cookie,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`${options.method || 'GET'} ${resourcePath} failed ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchAll(base, cookie, doctype, fields, filters = []) {
  const rows = [];
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_start: String(start),
      limit_page_length: '500',
    });
    const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < 500) break;
    start += 500;
  }
  return rows;
}

function accountNameFromHead(accountHead) {
  return String(accountHead || '').replace(/\s+-\s+SACL$/, '');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
    dateStrings: true,
  });
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  const cookie = await login(base, usr, pwd);

  const [templates] = await oldConn.query(
    "select * from `tabPurchase Taxes and Charges Template` where name in ('VAT18 - SACL', 'WITHOLDING TAX6 - SACL') order by name",
  );
  const [taxRows] = await oldConn.query(
    "select * from `tabPurchase Taxes and Charges` where parent in ('VAT18 - SACL', 'WITHOLDING TAX6 - SACL') order by parent, idx",
  );
  const childByParent = new Map();
  for (const row of taxRows) {
    if (!childByParent.has(row.parent)) childByParent.set(row.parent, []);
    childByParent.get(row.parent).push(row);
  }

  const company = 'SUPERTEX APA CO LTD';
  const parentAccount = '2300 - Duties and Taxes - SACL';
  const existingAccounts = new Set((await fetchAll(base, cookie, 'Account', ['name', 'account_name'])).flatMap((row) => [row.name, row.account_name]));
  const existingTemplates = new Set((await fetchAll(base, cookie, 'Purchase Taxes and Charges Template', ['name', 'title'])).flatMap((row) => [row.name, row.title]));
  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    accounts: { source: 0, skipped_existing: 0, dry_run_create: 0, created: 0, failed: 0 },
    templates: { source: templates.length, skipped_existing: 0, dry_run_create: 0, created: 0, failed: 0 },
    results: [],
  };

  const neededAccountHeads = [...new Set(taxRows.map((row) => row.account_head).filter(Boolean))];
  log.accounts.source = neededAccountHeads.length;
  for (const accountHead of neededAccountHeads) {
    const accountName = accountNameFromHead(accountHead);
    if (existingAccounts.has(accountHead) || existingAccounts.has(accountName)) {
      log.accounts.skipped_existing += 1;
      continue;
    }
    const payload = clean({
      doctype: 'Account',
      account_name: accountName,
      company,
      parent_account: parentAccount,
      root_type: 'Liability',
      report_type: 'Balance Sheet',
      account_type: 'Tax',
      is_group: 0,
      account_currency: 'UGX',
    });
    if (!apply) {
      log.accounts.dry_run_create += 1;
      log.results.push({ doctype: 'Account', name: accountHead, status: 'dry_run_create', payload });
      continue;
    }
    try {
      const result = await requestJson(base, cookie, '/api/resource/Account', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const target = result.data && result.data.name;
      existingAccounts.add(target);
      existingAccounts.add(accountName);
      log.accounts.created += 1;
      log.results.push({ doctype: 'Account', name: accountHead, status: 'created', target });
    } catch (err) {
      log.accounts.failed += 1;
      log.results.push({ doctype: 'Account', name: accountHead, status: 'failed', error: err.message, response: err.body, payload });
    }
  }

  const accountMap = new Map();
  for (const accountHead of neededAccountHeads) {
    const accountName = accountNameFromHead(accountHead);
    const matches = await fetchAll(base, cookie, 'Account', ['name', 'account_name'], [['Account', 'account_name', '=', accountName]]);
    accountMap.set(accountHead, (matches[0] && matches[0].name) || accountHead);
  }

  for (const template of templates) {
    if (existingTemplates.has(template.name) || existingTemplates.has(template.title)) {
      log.templates.skipped_existing += 1;
      continue;
    }
    const payload = clean({
      doctype: 'Purchase Taxes and Charges Template',
      title: template.title || template.name,
      is_default: flag(template.is_default),
      disabled: flag(template.disabled),
      company,
      taxes: (childByParent.get(template.name) || []).map((row) => clean({
        doctype: 'Purchase Taxes and Charges',
        charge_type: row.charge_type,
        account_head: accountMap.get(row.account_head) || row.account_head,
        description: row.description,
        rate: row.rate,
        cost_center: 'Main CTC - SACL',
        included_in_print_rate: flag(row.included_in_print_rate),
        category: row.category,
        add_deduct_tax: row.add_deduct_tax,
      })),
    });
    if (!apply) {
      log.templates.dry_run_create += 1;
      log.results.push({ doctype: 'Purchase Taxes and Charges Template', name: template.name, status: 'dry_run_create', payload });
      continue;
    }
    try {
      const result = await requestJson(base, cookie, '/api/resource/Purchase Taxes and Charges Template', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      log.templates.created += 1;
      log.results.push({ doctype: 'Purchase Taxes and Charges Template', name: template.name, status: 'created', target: result.data && result.data.name });
    } catch (err) {
      log.templates.failed += 1;
      log.results.push({ doctype: 'Purchase Taxes and Charges Template', name: template.name, status: 'failed', error: err.message, response: err.body, payload });
    }
  }

  await oldConn.end();
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify({ accounts: log.accounts, templates: log.templates }, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create missing tax accounts/templates.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
