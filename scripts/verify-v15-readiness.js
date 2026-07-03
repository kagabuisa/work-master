const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v15-readiness-verification.json');
const outMd = path.join(__dirname, '..', 'audits', 'v15-readiness-verification.md');
const evaluationPath = path.join(__dirname, '..', 'audits', 'v6-v15-master-data-settings-evaluation.json');
const phase2Path = path.join(__dirname, '..', 'audits', 'v15-master-data-phase2-import-log.json');
const phase3Path = path.join(__dirname, '..', 'audits', 'v15-master-data-phase3-verification.json');
const phase4Path = path.join(__dirname, '..', 'audits', 'v15-master-data-phase4-import-log.json');
const phase5Path = path.join(__dirname, '..', 'audits', 'v15-master-data-phase5-import-log.json');
const categoryUpdatePath = path.join(__dirname, '..', 'audits', 'v15-item-category-update-log.json');

const LISTS = [
  { label: 'Company', old: 'Company' },
  { label: 'Fiscal Year', old: 'Fiscal Year' },
  { label: 'Currency', old: 'Currency' },
  { label: 'Account', old: 'Account' },
  { label: 'Cost Center', old: 'Cost Center' },
  { label: 'Warehouse Type', old: 'Warehouse Type' },
  { label: 'Warehouse', old: 'Warehouse' },
  { label: 'UOM', old: 'UOM' },
  { label: 'Brand', old: 'Brand' },
  { label: 'Item Group', old: 'Item Group' },
  { label: 'Price List', old: 'Price List' },
  { label: 'Branch', old: 'Branch' },
  { label: 'Mode of Payment', old: 'Mode of Payment' },
  { label: 'Supplier', old: 'Supplier' },
  { label: 'Customer', old: 'Customer' },
  { label: 'Employee', old: 'Employee' },
  { label: 'Item Category', old: 'Item Category' },
  { label: 'Item', old: 'Item' },
  { label: 'Item Price', old: 'Item Price' },
  { label: 'Department', old: 'Department' },
  { label: 'Designation', old: 'Designation' },
  { label: 'Employment Type', old: 'Employment Type' },
  { label: 'Holiday List', old: 'Holiday List' },
  { label: 'Territory', old: 'Territory' },
  { label: 'Customer Group', old: 'Customer Group' },
  { label: 'Supplier Group', old: 'Supplier Type' },
  { label: 'Terms and Conditions', old: 'Terms and Conditions' },
  { label: 'Purchase Taxes and Charges Template', old: 'Purchase Taxes and Charges Template' },
  { label: 'Contact', old: 'Contact' },
  { label: 'Address', old: 'Address' },
];

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

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [table],
  );
  return Boolean(rows[0].n);
}

async function oldCount(conn, doctype) {
  const table = `tab${doctype}`;
  if (!(await tableExists(conn, table))) return null;
  const [rows] = await conn.query(`select count(*) n from \`${table.replace(/`/g, '``')}\``);
  return Number(rows[0].n);
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

async function v15Count(base, cookie, doctype, filters) {
  const qs = new URLSearchParams({ doctype });
  if (filters) qs.set('filters', JSON.stringify(filters));
  const result = await requestJson(base, cookie, `/api/method/frappe.client.get_count?${qs}`);
  return Number(result.message);
}

function latestSourceCount(label, rawOld, logs) {
  if (logs.phase3.summary && logs.phase3.summary[label]) return logs.phase3.summary[label].source;
  if (logs.phase4.counts && logs.phase4.counts[label]) {
    return label === 'Item Price'
      ? logs.phase4.counts[label].latest_unique_source
      : logs.phase4.counts[label].source;
  }
  if (logs.phase5.counts && logs.phase5.counts[label]) return logs.phase5.counts[label].source;
  if (logs.phase2.counts && logs.phase2.counts[label]) return logs.phase2.counts[label].source;
  return rawOld;
}

function verificationFor(label, logs, evaluation) {
  const live = evaluation.master_data && evaluation.master_data[label];
  if (live && live.missing_count === 0) return { matched: live.matched, missing: 0, source: live.source_count };
  if (logs.phase3.summary && logs.phase3.summary[label]) return logs.phase3.summary[label];
  return null;
}

function classify(row, logs, evaluation) {
  const verification = verificationFor(row.label, logs, evaluation);
  if (verification && Number(verification.missing) === 0) return 'ok';

  if (row.label === 'Item Price') {
    const counts = logs.phase4.counts && logs.phase4.counts['Item Price'];
    if (counts && counts.latest_unique_source === row.v15) return 'ok';
  }

  if (row.label === 'Address') {
    const counts = logs.phase5.counts && logs.phase5.counts.Address;
    if (counts && counts.failed === 0 && counts.created === row.v15) return 'review';
  }

  if (row.old === null || row.v15 === null) return 'review';
  return row.v15 >= row.old ? 'ok' : 'short';
}

function settingWarnings(evaluation) {
  const warnings = [];
  const defaultCompanyOnly = (doctype, result) => (
    doctype === 'Global Defaults'
    && result.field_diff_count === 1
    && result.field_diffs
    && result.field_diffs[0]
    && result.field_diffs[0].field === 'default_company'
  );

  for (const [doctype, result] of Object.entries(evaluation.settings || {})) {
    if (result.error) {
      warnings.push(`${doctype}: ${result.error}`);
      continue;
    }
    if (defaultCompanyOnly(doctype, result)) continue;
    if (result.field_diff_count) {
      warnings.push(`${doctype}: ${result.field_diff_count} comparable setting difference(s)`);
    }
  }
  return warnings;
}

function markdownTable(headers, rows) {
  const clean = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => clean(row[header])).join(' | ')} |`),
  ].join('\n');
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# ERPNext v15 Readiness Verification');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Target: ${report.target}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push(markdownTable(
    ['List', 'Old/Expected', 'V15', 'Delta', 'Status'],
    report.counts.map((row) => ({
      List: row.label,
      'Old/Expected': row.old_expected,
      V15: row.v15,
      Delta: row.delta,
      Status: row.status,
    })),
  ));
  lines.push('');
  lines.push('## Blockers');
  lines.push('');
  lines.push(...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ['- None found in this verification.']));
  lines.push('');
  lines.push('## Warnings / Review');
  lines.push('');
  lines.push(...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ['- None.']));
  lines.push('');
  lines.push('## Specific Checks');
  lines.push('');
  lines.push(`- Blank Item Category in v15 Items: ${report.specific_checks.blank_item_category_count}`);
  lines.push(`- Latest unique v6 Item Price rows expected in v15: ${report.specific_checks.latest_unique_item_prices}`);
  lines.push(`- Historical duplicate v6 Item Price rows intentionally skipped: ${report.specific_checks.duplicate_old_item_prices_skipped}`);
  lines.push(`- Address rows skipped because they had no valid Customer/Supplier/Company link: ${report.specific_checks.addresses_skipped_no_link}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const oldConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });

  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);

  const logs = {
    phase2: readJson(phase2Path),
    phase3: readJson(phase3Path),
    phase4: readJson(phase4Path),
    phase5: readJson(phase5Path),
    categoryUpdate: readJson(categoryUpdatePath),
  };
  const evaluation = readJson(evaluationPath);

  const counts = [];
  for (const spec of LISTS) {
    const rawOld = await oldCount(oldConn, spec.old);
    const expected = latestSourceCount(spec.label, rawOld, logs);
    const live = await v15Count(base, cookie, spec.label);
    const row = {
      label: spec.label,
      old_doctype: spec.old,
      old_raw: rawOld,
      old_expected: expected,
      v15: live,
      delta: live - expected,
    };
    row.status = classify({ ...row, old: expected }, logs, evaluation);
    counts.push(row);
  }

  await oldConn.end();

  const blankItemCategory = await v15Count(base, cookie, 'Item', { item_category: ['in', ['', null]] });
  const itemPriceCounts = logs.phase4.counts && logs.phase4.counts['Item Price'] ? logs.phase4.counts['Item Price'] : {};
  const addressCounts = logs.phase5.counts && logs.phase5.counts.Address ? logs.phase5.counts.Address : {};

  const blockers = [];
  for (const row of counts) {
    if (row.status === 'short') blockers.push(`${row.label}: v15 has ${row.v15}, expected ${row.old_expected}.`);
  }
  if (blankItemCategory) blockers.push(`Item: ${blankItemCategory} v15 item(s) still have blank Item Category.`);

  const warnings = [];
  for (const row of counts.filter((item) => item.status === 'review')) {
    warnings.push(`${row.label}: v15 has ${row.v15}, expected ${row.old_expected}; review note applies.`);
  }
  if (addressCounts.skipped_no_link) {
    warnings.push(`Address: ${addressCounts.skipped_no_link} old address row(s) were skipped because no valid target link could be mapped.`);
  }
  warnings.push(...settingWarnings(evaluation));

  const report = {
    generated_at: new Date().toISOString(),
    target: base,
    counts,
    blockers,
    warnings,
    specific_checks: {
      blank_item_category_count: blankItemCategory,
      latest_unique_item_prices: itemPriceCounts.latest_unique_source || null,
      duplicate_old_item_prices_skipped: itemPriceCounts.duplicate_old_rows_skipped || 0,
      addresses_skipped_no_link: addressCounts.skipped_no_link || 0,
    },
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, buildMarkdown(report));

  console.log(JSON.stringify({
    blockers: report.blockers,
    warnings: report.warnings,
    blank_item_category_count: blankItemCategory,
  }, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
