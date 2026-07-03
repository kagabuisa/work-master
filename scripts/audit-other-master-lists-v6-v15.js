const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v6-v15-other-master-lists-audit.json');
const outMd = path.join(__dirname, '..', 'audits', 'v6-v15-other-master-lists-audit.md');

const ALREADY_COVERED = new Set([
  'Account',
  'Address',
  'Brand',
  'Branch',
  'Company',
  'Contact',
  'Cost Center',
  'Currency',
  'Customer',
  'Customer Group',
  'Department',
  'Designation',
  'Employee',
  'Employment Type',
  'Fiscal Year',
  'Holiday List',
  'Item',
  'Item Category',
  'Item Group',
  'Item Price',
  'Mode of Payment',
  'Price List',
  'Purchase Taxes and Charges Template',
  'Supplier',
  'Supplier Group',
  'Supplier Type',
  'Terms and Conditions',
  'Territory',
  'UOM',
  'Warehouse',
  'Warehouse Type',
]);

const TRANSACTION_OR_HISTORY = new Set([
  'Attendance',
  'Bin',
  'C-Form',
  'Communication',
  'Delivery Note',
  'File',
  'GL Entry',
  'Journal Entry',
  'Lead',
  'Leave Allocation',
  'Leave Application',
  'Payment Request',
  'Period Closing Voucher',
  'Production Order',
  'Purchase Invoice',
  'Purchase Order',
  'Purchase Receipt',
  'Quotation',
  'Sales Invoice',
  'Sales Order',
  'Salary Slip',
  'Stock Entry',
  'Stock Ledger Entry',
  'Stock Reconciliation',
  'Supplier Quotation',
  'ToDo',
  'Version',
]);

const CHILD_OR_SYSTEM = new Set([
  'Custom Field',
  'Custom Script',
  'DocField',
  'DocPerm',
  'DocType',
  'Module Def',
  'Print Format',
  'Property Setter',
  'Report',
  'Role',
  'UserRole',
  'Workflow',
  'Workflow Action',
  'Workflow State',
  'Workflow Transition',
]);

const START_USE_PRIORITY = {
  'Sales Person': 'should_import',
  'Sales Team': 'should_import_child_if_parent_transactions_later',
  'POS Profile': 'review_if_pos_used',
  'Pricing Rule': 'review_if_discount_rules_used',
  'Letter Head': 'should_import',
  'Naming Series': 'settings_review',
  'Shipping Rule': 'review_if_shipping_charges_used',
  'Tax Rule': 'review_if_tax_rules_used',
  'Monthly Distribution': 'optional_budgeting',
  'Payment Gateway': 'optional_online_payments',
  'Payment Gateway Account': 'optional_online_payments',
  'SMS Settings': 'optional_notifications',
  'Email Account': 'optional_notifications',
  'Email Digest': 'optional_notifications',
  'Notification Control': 'optional_notifications',
  'Leave Type': 'should_import_if_hr_used',
  'Salary Component': 'should_import_if_payroll_used',
  'Salary Structure': 'should_import_if_payroll_used',
  'Vehicle': 'optional_custom_operations',
  'Driver': 'optional_custom_operations',
  'Motor Vehicle': 'optional_custom_operations',
  'Approved Discounts': 'review_if_sales_discount_control_used',
  'Area': 'optional_custom_operations',
  'Ext Links': 'optional_custom_operations',
  'Performance charges': 'optional_custom_operations',
};

const OPTIONAL_HISTORY_CUSTOM = new Set([
  'Asset Register',
  'Audit Report',
  'CPU Daily Delivery Report',
  'Daily Activity Report',
  'Deli Details',
  'Delivery Details',
  'Delivery Difference Report',
  'Gate  Pass',
  'Net Asset Value - Balance Sheet',
  'Order Report',
  'Payment Voucher',
  'Pending Payments',
  'Sales report',
  'Shop visit',
  'Shop Visit Details',
  'Trip Plan-Report',
  'Vehicle Log',
  'Vehicle Log Book',
]);

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

function sqlIdent(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function columns(conn, table) {
  const [rows] = await conn.query(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position',
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [table],
  );
  return Boolean(rows[0].n);
}

async function tableCount(conn, doctype) {
  const table = `tab${doctype}`;
  if (!(await tableExists(conn, table))) return null;
  const [rows] = await conn.query(`select count(*) n from ${sqlIdent(table)}`);
  return Number(rows[0].n);
}

async function sampleNames(conn, doctype, limit = 5) {
  const table = `tab${doctype}`;
  if (!(await tableExists(conn, table))) return [];
  const cols = await columns(conn, table);
  const order = cols.includes('modified') ? 'modified desc' : 'name';
  const [rows] = await conn.query(`select name from ${sqlIdent(table)} order by ${order} limit ${Number(limit)}`);
  return rows.map((row) => row.name);
}

async function oldNames(conn, doctype, limit = 5000) {
  const table = `tab${doctype}`;
  if (!(await tableExists(conn, table))) return [];
  const [rows] = await conn.query(`select name from ${sqlIdent(table)} order by name limit ${Number(limit)}`);
  return rows.map((row) => row.name);
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

async function requestJson(base, cookie, resourcePath) {
  const response = await fetch(`${base}${resourcePath}`, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', cookie },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`GET ${resourcePath} failed ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchAllResource(base, cookie, doctype, fields, filters) {
  const rows = [];
  const pageLength = 500;
  let start = 0;
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
      limit_start: String(start),
      limit_page_length: String(pageLength),
    });
    if (filters) qs.set('filters', JSON.stringify(filters));
    const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < pageLength) break;
    start += pageLength;
  }
  return rows;
}

async function v15Count(base, cookie, doctype) {
  const qs = new URLSearchParams({ doctype });
  const result = await requestJson(base, cookie, `/api/method/frappe.client.get_count?${qs}`);
  return Number(result.message);
}

function categoryFor(row) {
  if (ALREADY_COVERED.has(row.name)) return 'covered';
  if (TRANSACTION_OR_HISTORY.has(row.name)) return 'transaction_or_history';
  if (CHILD_OR_SYSTEM.has(row.name)) return 'customization_or_system';
  if (Number(row.issingle || 0)) return 'singleton_setting';
  if (Number(row.istable || 0)) return 'child_table';
  if (OPTIONAL_HISTORY_CUSTOM.has(row.name)) return 'optional_custom_history';
  return 'candidate_master_or_setup';
}

function priorityFor(row, count) {
  if (count === 0) return 'empty_skip';
  if (START_USE_PRIORITY[row.name]) return START_USE_PRIORITY[row.name];
  const category = categoryFor(row);
  if (category === 'covered') return 'already_verified';
  if (category === 'transaction_or_history') return 'ignore_transaction_data';
  if (category === 'singleton_setting') return 'settings_review';
  if (category === 'customization_or_system') return 'already_handled_as_customization';
  if (category === 'child_table') return 'child_table_review_only';
  if (category === 'optional_custom_history') return 'optional_history';
  if (Number(row.custom || 0)) return 'review_custom_master';
  return 'review_standard_setup';
}

function statusFor(result) {
  if (result.old_count === 0) return 'empty';
  if (!result.v15_doctype_exists) return 'doctype_missing_in_v15';
  if (result.v15_count === null) return 'v15_count_error';
  if (result.matchable && result.missing_names.length === 0) return 'records_match_by_name';
  if (result.matchable && result.missing_names.length) return 'records_missing_by_name';
  return result.v15_count > 0 ? 'v15_has_records_unmapped' : 'v15_empty';
}

function recommendedAction(result) {
  if (result.priority === 'ignore_transaction_data') return 'Do not migrate for starting v15; transaction/history data is excluded.';
  if (result.priority === 'already_verified') return 'Already covered by earlier master-data verification/import.';
  if (result.priority === 'empty_skip') return 'No v6 records.';
  if (!result.v15_doctype_exists) {
    if (result.category === 'optional_custom_history') return 'Optional historical/custom operational records; not required to start.';
    return 'Review whether this v6 custom/legacy DocType is still needed; v15 DocType is absent.';
  }
  if (result.status === 'records_missing_by_name' || result.status === 'v15_empty') {
    if (result.priority.startsWith('optional')) return 'Optional; import only if the workflow is still used.';
    if (result.priority.includes('review')) return 'Review fields and import if this setup is used in daily operations.';
    return 'Import or configure before go-live if this workflow is used.';
  }
  return 'No immediate action for starting v15.';
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
  lines.push('# ERPNext v6 Other Master/Setup Lists Audit');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Old database: \`${report.old_source.database}\``);
  lines.push(`V15 target: ${report.v15_target}`);
  lines.push('');
  lines.push('Scope: reusable master/setup lists only. Transaction/opening data is intentionally excluded from recommendations.');
  lines.push('');

  lines.push('## Start-Use Review Items');
  lines.push('');
  const reviewRows = report.results
    .filter((row) => row.old_count > 0)
    .filter((row) => !['covered', 'transaction_or_history', 'customization_or_system'].includes(row.category))
    .filter((row) => !['empty_skip', 'already_verified', 'ignore_transaction_data'].includes(row.priority))
    .sort((a, b) => {
      const rank = (value) => {
        if (String(value).startsWith('should_import')) return 0;
        if (String(value).startsWith('review_if')) return 1;
        if (String(value).startsWith('settings')) return 2;
        if (String(value).startsWith('review_custom')) return 3;
        if (String(value).startsWith('optional')) return 4;
        return 5;
      };
      return rank(a.priority) - rank(b.priority) || b.old_count - a.old_count || a.name.localeCompare(b.name);
    });
  lines.push(markdownTable(
    ['DocType', 'Priority', 'Old', 'V15 DocType', 'V15 Records', 'Status', 'Sample Missing/Old Records'],
    reviewRows.map((row) => ({
      DocType: row.name,
      Priority: row.priority,
      Old: row.old_count,
      'V15 DocType': row.v15_doctype_exists ? 'yes' : 'no',
      'V15 Records': row.v15_count === null ? '' : row.v15_count,
      Status: row.status,
      'Sample Missing/Old Records': (row.missing_names.length ? row.missing_names : row.sample_names).slice(0, 5).join(', '),
    })),
  ));
  lines.push('');

  lines.push('## Recommended Actions');
  lines.push('');
  const actions = reviewRows
    .filter((row) => !['records_match_by_name', 'v15_has_records_unmapped'].includes(row.status) || row.priority.startsWith('should_import'))
    .slice(0, 40)
    .map((row) => `- ${row.name}: ${row.recommended_action}`);
  lines.push(...(actions.length ? actions : ['- No additional start-use master/setup action found.']));
  lines.push('');

  lines.push('## Covered Earlier');
  lines.push('');
  const coveredRows = report.results.filter((row) => row.old_count > 0 && row.category === 'covered');
  lines.push(markdownTable(
    ['DocType', 'Old', 'V15 Records', 'Status'],
    coveredRows.map((row) => ({
      DocType: row.name,
      Old: row.old_count,
      'V15 Records': row.v15_count === null ? '' : row.v15_count,
      Status: row.status,
    })),
  ));
  lines.push('');

  lines.push('## Transaction/History Excluded');
  lines.push('');
  const excludedRows = report.results
    .filter((row) => row.old_count > 0 && row.category === 'transaction_or_history')
    .sort((a, b) => b.old_count - a.old_count);
  lines.push(markdownTable(
    ['DocType', 'Old Records', 'Reason'],
    excludedRows.map((row) => ({
      DocType: row.name,
      'Old Records': row.old_count,
      Reason: 'Transaction/history data excluded by request.',
    })),
  ));
  lines.push('');

  lines.push('## Machine-Readable Details');
  lines.push('');
  lines.push(`Full JSON: \`${path.relative(path.join(__dirname, '..'), outJson)}\``);
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

  const [[dbInfo]] = await oldConn.query('select database() database_name, version() database_version');
  const [oldDocTypes] = await oldConn.query(`
    select name, module, ifnull(custom, 0) custom, ifnull(istable, 0) istable,
      ifnull(issingle, 0) issingle, ifnull(is_submittable, 0) is_submittable
    from tabDocType
    order by module, name
  `);

  const v15DocTypes = await fetchAllResource(base, cookie, 'DocType', ['name', 'istable', 'issingle', 'custom']);
  const v15DocTypeNames = new Set(v15DocTypes.map((row) => row.name));
  const results = [];

  for (const oldDocType of oldDocTypes) {
    const oldCount = Number(oldDocType.issingle || 0) ? null : await tableCount(oldConn, oldDocType.name);
    const sample = Number(oldDocType.issingle || 0) ? [] : await sampleNames(oldConn, oldDocType.name);
    const category = categoryFor(oldDocType);
    const priority = priorityFor(oldDocType, oldCount || 0);
    const exists = v15DocTypeNames.has(oldDocType.name);
    let targetCount = null;
    let countError = null;
    let missingNames = [];
    let matchable = false;

    if (exists && oldCount !== null) {
      try {
        targetCount = await v15Count(base, cookie, oldDocType.name);
        if (oldCount > 0 && oldCount <= 2000 && !Number(oldDocType.istable || 0)) {
          matchable = true;
          const oldNameList = await oldNames(oldConn, oldDocType.name);
          const targetRows = await fetchAllResource(base, cookie, oldDocType.name, ['name']);
          const targetNames = new Set(targetRows.map((row) => row.name));
          missingNames = oldNameList.filter((name) => !targetNames.has(name));
        }
      } catch (err) {
        countError = err.message;
      }
    }

    const row = {
      name: oldDocType.name,
      module: oldDocType.module,
      custom: Number(oldDocType.custom || 0),
      istable: Number(oldDocType.istable || 0),
      issingle: Number(oldDocType.issingle || 0),
      is_submittable: Number(oldDocType.is_submittable || 0),
      category,
      priority,
      old_count: oldCount,
      sample_names: sample,
      v15_doctype_exists: exists,
      v15_count: targetCount,
      v15_count_error: countError,
      matchable,
      missing_count: missingNames.length,
      missing_names: missingNames.slice(0, 25),
    };
    row.status = statusFor(row);
    row.recommended_action = recommendedAction(row);
    results.push(row);
  }

  await oldConn.end();

  const report = {
    generated_at: new Date().toISOString(),
    old_source: {
      database: dbInfo.database_name,
      database_version: dbInfo.database_version,
    },
    v15_target: base,
    summary: {
      old_doctypes_checked: results.length,
      old_doctypes_with_records: results.filter((row) => row.old_count > 0).length,
      start_use_review_items: results
        .filter((row) => row.old_count > 0)
        .filter((row) => !['covered', 'transaction_or_history', 'customization_or_system'].includes(row.category)).length,
      missing_v15_doctype_with_records: results.filter((row) => row.old_count > 0 && !row.v15_doctype_exists).length,
      records_missing_by_name: results.filter((row) => row.status === 'records_missing_by_name').length,
    },
    results,
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, buildMarkdown(report));

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
