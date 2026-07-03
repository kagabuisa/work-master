const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v6-v15-master-data-settings-evaluation.json');
const outMd = path.join(__dirname, '..', 'audits', 'v6-v15-master-data-settings-evaluation.md');
const priorVerificationPath = path.join(__dirname, '..', 'audits', 'v15-master-data-phase1-verification.json');

const MASTER_DOCTYPES = [
  {
    name: 'Company',
    order: 'name',
    fields: [
      'name',
      'company_name',
      'abbr',
      'default_currency',
      'country',
      'domain',
      'default_holiday_list',
      'default_letter_head',
      'default_payable_account',
      'default_receivable_account',
      'default_income_account',
      'default_expense_account',
      'cost_center',
      'round_off_account',
    ],
  },
  {
    name: 'Currency',
    fields: ['name', 'currency_name', 'symbol', 'enabled', 'fraction', 'fraction_units', 'number_format'],
  },
  {
    name: 'Fiscal Year',
    order: 'year_start_date, name',
    fields: ['name', 'year', 'year_start_date', 'year_end_date', 'disabled'],
  },
  {
    name: 'UOM',
    fields: ['name', 'uom_name', 'must_be_whole_number'],
  },
  {
    name: 'Brand',
    fields: ['name', 'brand', 'description'],
  },
  {
    name: 'Branch',
    fields: ['name', 'branch'],
  },
  {
    name: 'Warehouse Type',
    fields: ['name', 'warehouse_type'],
  },
  {
    name: 'Item Group',
    order: 'lft, name',
    fields: ['name', 'item_group_name', 'parent_item_group', 'is_group'],
  },
  {
    name: 'Price List',
    fields: ['name', 'price_list_name', 'currency', 'enabled', 'buying', 'selling'],
  },
  {
    name: 'Cost Center',
    order: 'lft, name',
    fields: ['name', 'cost_center_name', 'company', 'parent_cost_center', 'is_group', 'cost_center_type'],
  },
  {
    name: 'Warehouse',
    fields: [
      'name',
      'warehouse_name',
      'company',
      'disabled',
      'warehouse_type',
      'cost_center',
      'create_account_under',
      'city',
      'address_line_1',
      'address_line_2',
      'phone_no',
      'mobile_no',
      'email_id',
      'warehouse_abbreviation',
      'branch',
    ],
  },
  {
    name: 'Account',
    order: 'lft, name',
    fields: [
      'name',
      'account_name',
      'company',
      'parent_account',
      'is_group',
      'root_type',
      'report_type',
      'account_type',
      'account_currency',
      'freeze_account',
      'tax_rate',
      'cost_center',
    ],
  },
];

const SETTINGS_DOCTYPES = [
  'System Settings',
  'Global Defaults',
  'Accounts Settings',
  'Stock Settings',
  'Selling Settings',
  'Buying Settings',
  'HR Settings',
  'Manufacturing Settings',
  'Print Settings',
  'Features Setup',
  'Website Settings',
];

const IGNORED_FIELDS = new Set([
  'name',
  'owner',
  'creation',
  'modified',
  'modified_by',
  'docstatus',
  'idx',
  'parent',
  'parentfield',
  'parenttype',
  '_assign',
  '_comments',
  '_liked_by',
  '_user_tags',
  'lft',
  'rgt',
  'old_parent',
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

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [table],
  );
  return Boolean(rows[0].n);
}

async function columns(conn, table) {
  if (!(await tableExists(conn, table))) return [];
  const [rows] = await conn.query(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position',
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function oldRows(conn, doctype, requestedFields, order = 'name') {
  const table = `tab${doctype}`;
  const existing = await columns(conn, table);
  if (!existing.length) return { rows: [], fields: [], missingFields: requestedFields };
  const fieldSet = new Set(existing);
  const fields = requestedFields.filter((field) => fieldSet.has(field));
  const orderFields = String(order)
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  const safeOrder = orderFields.every((field) => fieldSet.has(field)) ? order : 'name';
  const [rows] = await conn.query(
    `select ${fields.map(sqlIdent).join(', ')} from ${sqlIdent(table)} order by ${safeOrder}`,
  );
  return { rows, fields, missingFields: requestedFields.filter((field) => !fieldSet.has(field)) };
}

async function oldSettings(conn, doctype) {
  const [rows] = await conn.query(
    'select field, value from tabSingles where doctype = ? order by field',
    [doctype],
  );
  return Object.fromEntries(rows.map((row) => [row.field, row.value]));
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

async function fetchAllResource(base, cookie, doctype, fields) {
  const pageLength = 500;
  let start = 0;
  const rows = [];
  while (true) {
    const qs = new URLSearchParams({
      fields: JSON.stringify(fields),
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

async function fetchDocFields(base, cookie, doctype) {
  try {
    const result = await requestJson(
      base,
      cookie,
      `/api/resource/DocType/${encodeURIComponent(doctype)}`,
    );
    const data = result.data || {};
    return new Set([
      'name',
      'owner',
      'creation',
      'modified',
      'modified_by',
      'docstatus',
      'idx',
      ...(data.fields || []).map((field) => field.fieldname).filter(Boolean),
    ]);
  } catch {
    return null;
  }
}

async function fetchSingle(base, cookie, doctype) {
  try {
    const result = await requestJson(
      base,
      cookie,
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(doctype)}`,
    );
    return { data: result.data || {}, error: null };
  } catch (err) {
    return { data: {}, error: `${err.message}${err.status ? ` (${err.status})` : ''}` };
  }
}

function readPriorMaps() {
  if (!fs.existsSync(priorVerificationPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(priorVerificationPath, 'utf8')).maps || {};
  } catch {
    return {};
  }
}

function normalizeScalar(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2} 00:00:00/.test(text)) return text.slice(0, 10);
  return text;
}

function equivalent(a, b) {
  const boolMap = new Map([
    ['yes', '1'],
    ['no', '0'],
    ['true', '1'],
    ['false', '0'],
  ]);
  const rawLeft = normalizeScalar(a);
  const rawRight = normalizeScalar(b);
  const left = boolMap.get(rawLeft.toLowerCase()) || rawLeft;
  const right = boolMap.get(rawRight.toLowerCase()) || rawRight;
  if (left === right) return true;
  if (/^-?\d+(\.\d+)?$/.test(left) && /^-?\d+(\.\d+)?$/.test(right)) {
    return Number(left) === Number(right);
  }
  return false;
}

function mapValue(value, field, maps) {
  const normalized = normalizeScalar(value);
  if (!normalized) return normalized;
  const mapNames = {
    company: 'Company',
    parent_cost_center: 'Cost Center',
    cost_center: 'Cost Center',
    parent_account: 'Account',
    create_account_under: 'Account',
    default_payable_account: 'Account',
    default_receivable_account: 'Account',
    default_income_account: 'Account',
    default_expense_account: 'Account',
    round_off_account: 'Account',
    branch: 'Branch',
    currency: 'Currency',
    default_currency: 'Currency',
    account_currency: 'Currency',
    warehouse_type: 'Warehouse Type',
    parent_item_group: 'Item Group',
  };
  const mapName = mapNames[field];
  return (mapName && maps[mapName] && maps[mapName][normalized]) || normalized;
}

function targetName(sourceName, doctype, maps) {
  return (maps[doctype] && maps[doctype][sourceName]) || sourceName;
}

function addCompanyMap(maps, oldCompanies, targetCompanies) {
  if (!maps.Company) maps.Company = {};
  for (const oldCompany of oldCompanies) {
    const targetCompany = targetCompanies.find((row) => row.abbr && row.abbr === oldCompany.abbr);
    if (targetCompany) {
      maps.Company[oldCompany.name] = targetCompany.name;
      maps.Company[`${oldCompany.name} - ${oldCompany.abbr}`] = `${targetCompany.name} - ${targetCompany.abbr}`;
    }
  }
}

function compareRows({ doctype, old, target, fields, maps }) {
  const targetByName = new Map(target.map((row) => [row.name, row]));
  const missing = [];
  const fieldDiffs = [];
  let matched = 0;

  for (const oldRow of old) {
    const mappedName = targetName(oldRow.name, doctype, maps);
    const targetRow = targetByName.get(mappedName);
    if (!targetRow) {
      missing.push({ source_name: oldRow.name, expected_target_name: mappedName });
      continue;
    }
    matched += 1;
    for (const field of fields) {
      if (IGNORED_FIELDS.has(field)) continue;
      if (!(field in oldRow) || !(field in targetRow)) continue;
      const oldValue = mapValue(oldRow[field], field, maps);
      const newValue = normalizeScalar(targetRow[field]);
      if (!equivalent(oldValue, newValue)) {
        fieldDiffs.push({
          name: oldRow.name,
          target_name: mappedName,
          field,
          old_value: normalizeScalar(oldRow[field]),
          expected_after_mapping: oldValue,
          v15_value: newValue,
        });
      }
    }
  }

  return {
    source_count: old.length,
    target_count: target.length,
    matched,
    missing_count: missing.length,
    field_diff_count: fieldDiffs.length,
    missing,
    field_diffs: fieldDiffs,
  };
}

function comparableSettingFields(oldDoc, newDoc) {
  const ignored = new Set([...IGNORED_FIELDS, 'app_name', 'user']);
  return Object.keys(oldDoc)
    .filter((field) => !ignored.has(field))
    .filter((field) => Object.prototype.hasOwnProperty.call(newDoc, field));
}

function compareSettings(doctype, oldDoc, newDoc, maps) {
  const fields = comparableSettingFields(oldDoc, newDoc);
  const fieldDiffs = [];
  for (const field of fields) {
    const oldValue = mapValue(oldDoc[field], field, maps);
    const newValue = normalizeScalar(newDoc[field]);
    if (!equivalent(oldValue, newValue)) {
      fieldDiffs.push({
        field,
        old_value: normalizeScalar(oldDoc[field]),
        expected_after_mapping: oldValue,
        v15_value: newValue,
      });
    }
  }
  return {
    old_field_count: Object.keys(oldDoc).length,
    comparable_field_count: fields.length,
    field_diff_count: fieldDiffs.length,
    fields_missing_in_v15: Object.keys(oldDoc)
      .filter((field) => !IGNORED_FIELDS.has(field))
      .filter((field) => !Object.prototype.hasOwnProperty.call(newDoc, field)),
    field_diffs: fieldDiffs,
  };
}

function markdownTable(headers, rows) {
  const clean = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => clean(row[header])).join(' | ')} |`),
  ].join('\n');
}

function buildMarkdown(evaluation) {
  const lines = [];
  lines.push('# ERPNext v6 to v15 Master Data and Settings Evaluation');
  lines.push('');
  lines.push(`Generated: ${evaluation.generated_at}`);
  lines.push(`Old source: MySQL database \`${evaluation.old_source.database}\``);
  lines.push(`New target: ${evaluation.new_target.url}`);
  lines.push('');
  lines.push('## Objective');
  lines.push('');
  lines.push('Check whether ERPNext v15 matches the ERPNext v6 setup for phase 1 master data and important singleton settings. This is read-only and compares live systems using the credentials in `.env`.');
  lines.push('');
  lines.push('## Master Data Summary');
  lines.push('');
  lines.push(markdownTable(
    ['DocType', 'Old', 'v15', 'Matched', 'Missing', 'Field Diffs'],
    Object.entries(evaluation.master_data).map(([doctype, result]) => ({
      DocType: doctype,
      Old: result.source_count,
      v15: result.target_count,
      Matched: result.matched,
      Missing: result.missing_count,
      'Field Diffs': result.field_diff_count,
    })),
  ));
  lines.push('');
  lines.push('## Settings Summary');
  lines.push('');
  lines.push(markdownTable(
    ['Settings', 'Comparable Fields', 'Field Diffs', 'Missing/Unavailable'],
    Object.entries(evaluation.settings).map(([doctype, result]) => ({
      Settings: doctype,
      'Comparable Fields': result.comparable_field_count || 0,
      'Field Diffs': result.field_diff_count || 0,
      'Missing/Unavailable': result.error || result.fields_missing_in_v15.length,
    })),
  ));
  lines.push('');
  lines.push('## Priority Gaps');
  lines.push('');
  const gaps = [];
  for (const [doctype, result] of Object.entries(evaluation.master_data)) {
    for (const row of result.missing.slice(0, 20)) {
      gaps.push(`- ${doctype}: missing \`${row.source_name}\` as \`${row.expected_target_name}\`.`);
    }
    for (const row of result.field_diffs.slice(0, 10)) {
      gaps.push(`- ${doctype} \`${row.name}\`: ${row.field} old=\`${row.old_value}\`, v15=\`${row.v15_value}\`.`);
    }
  }
  for (const [doctype, result] of Object.entries(evaluation.settings)) {
    if (result.error) {
      gaps.push(`- ${doctype}: could not read v15 settings (${result.error}).`);
      continue;
    }
    for (const row of result.field_diffs.slice(0, 10)) {
      gaps.push(`- ${doctype}: ${row.field} old=\`${row.old_value}\`, v15=\`${row.v15_value}\`.`);
    }
  }
  lines.push(...(gaps.length ? gaps : ['- No missing master records or comparable setting differences were found.']));
  lines.push('');
  lines.push(`Full machine-readable details: \`${path.relative(path.join(__dirname, '..'), outJson)}\``);
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
  const maps = readPriorMaps();

  const [[dbInfo]] = await oldConn.query('select database() database_name, version() database_version');
  const oldCompanyResult = await oldRows(oldConn, 'Company', MASTER_DOCTYPES[0].fields, 'name');
  const targetCompanyRows = await fetchAllResource(base, cookie, 'Company', ['name', 'abbr', 'company_name']);
  addCompanyMap(maps, oldCompanyResult.rows, targetCompanyRows);
  const evaluation = {
    generated_at: new Date().toISOString(),
    old_source: {
      type: 'mysql',
      database: dbInfo.database_name,
      database_version: dbInfo.database_version,
    },
    new_target: {
      type: 'frappe_api',
      url: base,
    },
    objective: 'Match ERPNext v6 master data and important settings in ERPNext v15.',
    master_data: {},
    settings: {},
  };

  for (const spec of MASTER_DOCTYPES) {
    const oldResult = await oldRows(oldConn, spec.name, spec.fields, spec.order || 'name');
    const targetDocFields = await fetchDocFields(base, cookie, spec.name);
    const targetFields = [...new Set(['name', ...oldResult.fields])]
      .filter((field) => !targetDocFields || targetDocFields.has(field));
    const comparableFields = oldResult.fields.filter((field) => targetFields.includes(field));
    const targetRows = await fetchAllResource(base, cookie, spec.name, targetFields);
    evaluation.master_data[spec.name] = {
      ...compareRows({
        doctype: spec.name,
        old: oldResult.rows,
        target: targetRows,
        fields: comparableFields,
        maps,
      }),
      old_missing_fields: oldResult.missingFields,
      v15_missing_fields: oldResult.fields.filter((field) => !targetFields.includes(field)),
    };
  }

  for (const doctype of SETTINGS_DOCTYPES) {
    const oldDoc = await oldSettings(oldConn, doctype);
    const { data: newDoc, error } = await fetchSingle(base, cookie, doctype);
    evaluation.settings[doctype] = error
      ? { old_field_count: Object.keys(oldDoc).length, comparable_field_count: 0, field_diff_count: 0, fields_missing_in_v15: [], field_diffs: [], error }
      : compareSettings(doctype, oldDoc, newDoc, maps);
  }

  await oldConn.end();
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(evaluation, null, 2)}\n`);
  fs.writeFileSync(outMd, buildMarkdown(evaluation));

  const summary = {
    master_data: Object.fromEntries(
      Object.entries(evaluation.master_data).map(([doctype, result]) => [
        doctype,
        {
          old: result.source_count,
          v15: result.target_count,
          matched: result.matched,
          missing: result.missing_count,
          field_diffs: result.field_diff_count,
        },
      ]),
    ),
    settings: Object.fromEntries(
      Object.entries(evaluation.settings).map(([doctype, result]) => [
        doctype,
        {
          comparable_fields: result.comparable_field_count,
          field_diffs: result.field_diff_count,
          missing_or_unavailable: result.error || result.fields_missing_in_v15.length,
        },
      ]),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
