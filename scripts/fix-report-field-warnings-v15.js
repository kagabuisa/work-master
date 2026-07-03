const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const logPath = path.join(__dirname, '..', 'audits', 'v15-report-field-fix-log.json');

const fieldMap = new Map([
  ['Pending Payments::pending_amount', 'pending_payment'],
  ['Salary Slip::month', 'month2'],
  ['Item::category', 'item_category'],
]);

const dropFields = new Set([
  'Pricing Rule::item_code',
  'Pricing Rule::price',
  'Sales Invoice::mode_of_payment',
  'Salary Slip::fiscal_year',
  'Item::is_service_item',
  'Item::default_warehouse',
  'Item::net_weight',
  'maximum stock::remark',
]);

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
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
    err.body = body;
    throw err;
  }
  return body;
}

function normalizeDoctypeName(name) {
  const map = new Map([
    ['Difference Report', 'Delivery Difference Report'],
    ['Shop Maximum Stock', 'Warehouse Maximum Stock'],
  ]);
  return map.get(name) || name;
}

function patchReportJson(reportName, jsonText, changes) {
  if (!jsonText) return jsonText;
  const data = JSON.parse(jsonText);
  for (const key of ['filters', 'columns']) {
    if (!Array.isArray(data[key])) continue;
    const patched = [];
    for (const item of data[key]) {
      if (!Array.isArray(item) || !item[0] || !item[1]) {
        patched.push(item);
        continue;
      }
      const dtIndex = key === 'filters' ? 0 : 1;
      const fieldIndex = key === 'filters' ? 1 : 0;
      item[dtIndex] = normalizeDoctypeName(item[dtIndex]);
      const signature = `${item[dtIndex]}::${item[fieldIndex]}`;
      if (dropFields.has(signature)) {
        changes.push({ report: reportName, action: 'drop', type: key.slice(0, -1), doctype: item[dtIndex], field: item[fieldIndex] });
        continue;
      }
      if (fieldMap.has(signature)) {
        const oldField = item[fieldIndex];
        item[fieldIndex] = fieldMap.get(signature);
        changes.push({ report: reportName, action: 'rename', type: key.slice(0, -1), doctype: item[dtIndex], old_field: oldField, new_field: item[fieldIndex] });
      }
      patched.push(item);
    }
    data[key] = patched;
  }
  for (const key of ['sort_by', 'sort_by_next']) {
    if (!data[key] || typeof data[key] !== 'string') continue;
    const dot = data[key].lastIndexOf('.');
    if (dot < 1) continue;
    const dt = normalizeDoctypeName(data[key].slice(0, dot));
    const field = data[key].slice(dot + 1);
    const signature = `${dt}::${field}`;
    if (dropFields.has(signature)) {
      changes.push({ report: reportName, action: 'drop_sort', doctype: dt, field });
      data[key] = '';
    } else if (fieldMap.has(signature)) {
      data[key] = `${dt}.${fieldMap.get(signature)}`;
      changes.push({ report: reportName, action: 'rename_sort', doctype: dt, old_field: field, new_field: fieldMap.get(signature) });
    }
  }
  return JSON.stringify(data);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);

  const reportNames = [
    'Pending Payments',
    'Price-Rules',
    'Sales Invoice 29012020',
    'Sales Invoice Month range',
    'Sales invoice report',
    'Sales Invoice Summary 28-04-2023',
    'SALES SUMMARY BY PERIOD AND SELLING UNIT',
    'Monthly payslip report(MPR)',
    'Group Item List',
    'Itemlist Import',
    'ItemList-Item Code',
    'Product-Line Report',
  ];

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    reports_checked: reportNames.length,
    reports_changed: 0,
    reports_updated: 0,
    failed: 0,
    changes: [],
    results: [],
  };

  for (const name of reportNames) {
    try {
      const report = (await requestJson(base, cookie, `/api/resource/Report/${encodeURIComponent(name)}`)).data;
      const changes = [];
      const patchedJson = patchReportJson(name, report.json || '', changes);
      if (!changes.length) {
        log.results.push({ report: name, status: 'no_change' });
        continue;
      }
      log.reports_changed += 1;
      log.changes.push(...changes);
      if (!apply) {
        log.results.push({ report: name, status: 'dry_run_update', changes: changes.length });
        continue;
      }
      await requestJson(base, cookie, `/api/resource/Report/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ json: patchedJson }),
      });
      log.reports_updated += 1;
      log.results.push({ report: name, status: 'updated', changes: changes.length });
    } catch (err) {
      log.failed += 1;
      log.results.push({ report: name, status: 'failed', error: err.message, response: err.body });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify({
    reports_checked: log.reports_checked,
    reports_changed: log.reports_changed,
    reports_updated: log.reports_updated,
    failed: log.failed,
    changes: log.changes.length,
  }, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to update reports.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
