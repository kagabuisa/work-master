const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const dataPath = path.join(__dirname, '..', 'audits', 'old-master-data-phase1.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-import-log.json');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function flag(value) {
  if (value === 'Yes') return 1;
  if (value === 'No') return 0;
  return Number(value || 0) ? 1 : 0;
}

function dateOnly(value) {
  if (!value) return value;
  return new Date(value).toISOString().slice(0, 10);
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

async function fetchAllResource(base, cookie, doctype, fields, filters = []) {
  const pageLength = 500;
  let start = 0;
  const rows = [];
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_start: String(start),
      limit_page_length: String(pageLength),
    });
    const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < pageLength) break;
    start += pageLength;
  }
  return rows;
}

function clean(doc) {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined || doc[key] === null || doc[key] === '') delete doc[key];
  }
  return doc;
}

function makeContext(data, targetCompanies) {
  const oldCompany = data.doctypes.Company[0];
  const targetCompany = targetCompanies.find((company) => company.abbr === oldCompany.abbr) || targetCompanies[0];
  const companyMap = new Map([[oldCompany.name, targetCompany.name]]);
  const rootCostCenterMap = new Map([
    [`${oldCompany.name} - ${oldCompany.abbr}`, `${targetCompany.name} - ${targetCompany.abbr}`],
  ]);
  return { oldCompany, targetCompany, companyMap, rootCostCenterMap };
}

function mapCompany(ctx, value) {
  return ctx.companyMap.get(value) || value;
}

function mapCostCenter(ctx, value) {
  return ctx.rootCostCenterMap.get(value) || value;
}

function currencyPayload(row) {
  return clean({
    doctype: 'Currency',
    name: row.name,
    currency_name: row.currency_name || row.name,
    symbol: row.symbol,
    enabled: flag(row.enabled),
    fraction: row.fraction,
    fraction_units: row.fraction_units,
    number_format: row.number_format,
  });
}

function fiscalYearPayload(row) {
  return clean({
    doctype: 'Fiscal Year',
    name: row.name,
    year: row.year || row.name,
    year_start_date: dateOnly(row.year_start_date),
    year_end_date: dateOnly(row.year_end_date),
    disabled: flag(row.disabled),
  });
}

function uomPayload(row) {
  return clean({
    doctype: 'UOM',
    name: row.name,
    uom_name: row.uom_name || row.name,
    must_be_whole_number: flag(row.must_be_whole_number),
  });
}

function brandPayload(row) {
  return clean({
    doctype: 'Brand',
    name: row.name,
    brand: row.brand || row.name,
    description: row.description,
  });
}

function branchPayload(row) {
  return clean({
    doctype: 'Branch',
    name: row.name,
    branch: row.branch || row.name,
  });
}

function warehouseTypePayload(row) {
  return clean({
    doctype: 'Warehouse Type',
    name: row.name,
    warehouse_type: row.warehouse_type || row.name,
  });
}

function itemGroupPayload(row) {
  return clean({
    doctype: 'Item Group',
    name: row.name,
    item_group_name: row.item_group_name || row.name,
    parent_item_group: row.parent_item_group,
    is_group: flag(row.is_group),
  });
}

function priceListPayload(row) {
  return clean({
    doctype: 'Price List',
    name: row.name,
    price_list_name: row.name,
    currency: row.currency,
    enabled: flag(row.enabled),
    buying: flag(row.buying),
    selling: flag(row.selling),
  });
}

function costCenterPayload(ctx, row) {
  return clean({
    doctype: 'Cost Center',
    name: mapCostCenter(ctx, row.name),
    cost_center_name: row.cost_center_name || row.name,
    company: mapCompany(ctx, row.company),
    parent_cost_center: mapCostCenter(ctx, row.parent_cost_center),
    is_group: flag(row.is_group),
    cost_center_type: row.cost_center_type,
  });
}

function accountPayload(ctx, row, existingCostCenters, accountNameMap) {
  const accountTypeMap = new Map([
    ['Warehouse', 'Stock'],
  ]);
  return clean({
    doctype: 'Account',
    name: row.name,
    account_name: row.account_name || row.name,
    company: mapCompany(ctx, row.company),
    parent_account: accountNameMap.get(row.parent_account) || row.parent_account,
    is_group: flag(row.is_group),
    root_type: row.root_type,
    report_type: row.report_type,
    account_type: accountTypeMap.get(row.account_type) || row.account_type,
    account_currency: row.account_currency,
    freeze_account: row.freeze_account === 'Yes' ? 'Yes' : 'No',
    tax_rate: row.tax_rate,
    cost_center: row.cost_center && existingCostCenters.has(mapCostCenter(ctx, row.cost_center))
      ? mapCostCenter(ctx, row.cost_center)
      : undefined,
  });
}

function stripCompanySuffix(name, abbr) {
  return String(name || '').replace(new RegExp(`\\s+-\\s+${abbr}$`), '');
}

function makeWarehouseAbbr(row) {
  if (row.warehouse_abbreviation) return row.warehouse_abbreviation;
  return String(row.name || row.warehouse_name || 'WH')
    .replace(/\s+-\s+SACL$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 10)
    .toUpperCase() || 'WH';
}

function warehousePayload(ctx, row, existingAccounts, existingCostCenters, accountNameMap, existingBranches) {
  const createAccountUnder = accountNameMap.get(row.create_account_under) || row.create_account_under;
  const fallbackCostCenter = existingCostCenters.has('CPU CTC - SACL') ? 'CPU CTC - SACL' : undefined;
  return clean({
    doctype: 'Warehouse',
    name: row.name,
    warehouse_name: stripCompanySuffix(row.name, ctx.targetCompany.abbr),
    company: mapCompany(ctx, row.company),
    disabled: flag(row.disabled),
    warehouse_type: row.warehouse_type,
    cost_center: row.cost_center && existingCostCenters.has(mapCostCenter(ctx, row.cost_center))
      ? mapCostCenter(ctx, row.cost_center)
      : fallbackCostCenter,
    create_account_under: createAccountUnder && existingAccounts.has(createAccountUnder)
      ? createAccountUnder
      : undefined,
    city: row.city,
    address_line_1: row.address_line_1,
    address_line_2: row.address_line_2,
    phone_no: row.phone_no,
    mobile_no: row.mobile_no,
    email_id: row.email_id,
    warehouse_abbreviation: makeWarehouseAbbr(row),
    code: row.code,
    branch: row.branch && existingBranches.has(row.branch) ? row.branch : undefined,
  });
}

async function importList({ base, cookie, apply, log, doctype, rows, existingNames, makePayload }) {
  const existingLower = new Set([...existingNames].map((name) => String(name).toLowerCase()));
  for (const row of rows) {
    const payload = makePayload(row);
    const name = payload.name || row.name;
    if (existingNames.has(name) || existingLower.has(String(name).toLowerCase())) {
      log.counts[doctype].skipped_existing += 1;
      continue;
    }
    if (!apply) {
      log.counts[doctype].dry_run_create += 1;
      continue;
    }
    try {
      await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      existingNames.add(name);
      existingLower.add(String(name).toLowerCase());
      log.counts[doctype].created += 1;
    } catch (err) {
      log.counts[doctype].failed += 1;
      log.results.push({
        doctype,
        name,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }
}

async function importAccounts({ base, cookie, apply, log, rows, existingNames, existingRows, ctx, existingCostCenters }) {
  const accountNameMap = new Map();
  const existingByAccountNameRoot = new Map();
  const existingByAccountName = new Map();
  for (const row of existingRows) {
    if (row.account_name && row.root_type) existingByAccountNameRoot.set(`${row.account_name}::${row.root_type}`, row.name);
    if (row.account_name && !existingByAccountName.has(row.account_name)) existingByAccountName.set(row.account_name, row.name);
  }

  for (const row of rows) {
    if (existingNames.has(row.name)) {
      accountNameMap.set(row.name, row.name);
      log.counts.Account.skipped_existing += 1;
      continue;
    }
    const rootMatch = existingByAccountNameRoot.get(`${row.account_name}::${row.root_type}`);
    if (rootMatch) {
      accountNameMap.set(row.name, rootMatch);
      log.counts.Account.skipped_existing += 1;
      log.results.push({ doctype: 'Account', name: row.name, status: 'mapped_existing_account', target: rootMatch });
      continue;
    }
    const nameMatch = existingByAccountName.get(row.account_name);
    if (nameMatch && flag(row.is_group)) {
      accountNameMap.set(row.name, nameMatch);
      log.counts.Account.skipped_existing += 1;
      log.results.push({ doctype: 'Account', name: row.name, status: 'mapped_existing_account', target: nameMatch });
      continue;
    }

    const payload = accountPayload(ctx, row, existingCostCenters, accountNameMap);
    if (row.parent_account && !payload.parent_account) {
      log.counts.Account.failed += 1;
      log.results.push({
        doctype: 'Account',
        name: row.name,
        status: 'failed_missing_parent_mapping',
        parent_account: row.parent_account,
      });
      continue;
    }
    if (!row.parent_account) {
      log.counts.Account.failed += 1;
      log.results.push({
        doctype: 'Account',
        name: row.name,
        status: 'failed_unmapped_root_account',
      });
      continue;
    }

    if (!apply) {
      log.counts.Account.dry_run_create += 1;
      accountNameMap.set(row.name, row.name);
      continue;
    }
    try {
      const created = await requestJson(base, cookie, '/api/resource/Account', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const targetName = (created.data && created.data.name) || row.name;
      existingNames.add(targetName);
      accountNameMap.set(row.name, targetName);
      log.counts.Account.created += 1;
    } catch (err) {
      log.counts.Account.failed += 1;
      log.results.push({
        doctype: 'Account',
        name: row.name,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }
  return accountNameMap;
}

function initCounts(log, doctypes) {
  for (const doctype of doctypes) {
    log.counts[doctype] = {
      source: 0,
      skipped_existing: 0,
      dry_run_create: 0,
      created: 0,
      failed: 0,
    };
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const targetCompanies = await fetchAllResource(base, cookie, 'Company', ['name', 'abbr', 'default_currency']);
  const ctx = makeContext(data, targetCompanies);

  const order = ['Currency', 'Fiscal Year', 'UOM', 'Brand', 'Branch', 'Warehouse Type', 'Item Group', 'Price List', 'Cost Center', 'Account', 'Warehouse'];
  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    company_mapping: Object.fromEntries(ctx.companyMap),
    counts: {},
    results: [],
  };
  initCounts(log, order);
  for (const doctype of order) log.counts[doctype].source = data.doctypes[doctype].length;

  const existing = {};
  const existingRows = {};
  for (const doctype of order) {
    const fields = doctype === 'Account'
      ? ['name', 'account_name', 'root_type', 'is_group']
      : ['name'];
    existingRows[doctype] = await fetchAllResource(base, cookie, doctype, fields);
    existing[doctype] = new Set(existingRows[doctype].map((row) => row.name));
  }

  await importList({ base, cookie, apply, log, doctype: 'Currency', rows: data.doctypes.Currency, existingNames: existing.Currency, makePayload: currencyPayload });
  await importList({ base, cookie, apply, log, doctype: 'Fiscal Year', rows: data.doctypes['Fiscal Year'], existingNames: existing['Fiscal Year'], makePayload: fiscalYearPayload });
  await importList({ base, cookie, apply, log, doctype: 'UOM', rows: data.doctypes.UOM, existingNames: existing.UOM, makePayload: uomPayload });
  await importList({ base, cookie, apply, log, doctype: 'Brand', rows: data.doctypes.Brand, existingNames: existing.Brand, makePayload: brandPayload });
  await importList({ base, cookie, apply, log, doctype: 'Branch', rows: data.doctypes.Branch, existingNames: existing.Branch, makePayload: branchPayload });
  await importList({ base, cookie, apply, log, doctype: 'Warehouse Type', rows: data.doctypes['Warehouse Type'], existingNames: existing['Warehouse Type'], makePayload: warehouseTypePayload });
  await importList({ base, cookie, apply, log, doctype: 'Item Group', rows: data.doctypes['Item Group'], existingNames: existing['Item Group'], makePayload: itemGroupPayload });
  await importList({ base, cookie, apply, log, doctype: 'Price List', rows: data.doctypes['Price List'], existingNames: existing['Price List'], makePayload: priceListPayload });
  await importList({
    base,
    cookie,
    apply,
    log,
    doctype: 'Cost Center',
    rows: data.doctypes['Cost Center'],
    existingNames: existing['Cost Center'],
    makePayload: (row) => costCenterPayload(ctx, row),
  });
  const accountNameMap = await importAccounts({
    base,
    cookie,
    apply,
    log,
    rows: data.doctypes.Account,
    existingNames: existing.Account,
    existingRows: existingRows.Account,
    ctx,
    existingCostCenters: existing['Cost Center'],
  });
  await importList({
    base,
    cookie,
    apply,
    log,
    doctype: 'Warehouse',
    rows: data.doctypes.Warehouse,
    existingNames: existing.Warehouse,
    makePayload: (row) => warehousePayload(ctx, row, existing.Account, existing['Cost Center'], accountNameMap, existing.Branch),
  });

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to import phase 1 master data.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
