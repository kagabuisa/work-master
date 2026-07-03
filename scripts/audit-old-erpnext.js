const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outDir = path.join(__dirname, '..', 'audits');

function sslConfig() {
  return ['1', 'true', 'required', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [table],
  );
  return Boolean(rows[0].n);
}

async function columns(conn, table) {
  const [rows] = await conn.query(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position',
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function safeRows(conn, table, select, order = 'modified desc') {
  if (!(await tableExists(conn, table))) return [];
  return conn.query(`select ${select} from \`${table}\` order by ${order}`).then(([rows]) => rows);
}

function groupCount(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || '(blank)';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function linesForTable(headers, rows) {
  const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => escape(row[header])).join(' | ')} |`),
  ];
}

function scriptPreview(script) {
  return String(script || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });

  const [[dbInfo]] = await conn.query('select database() db, version() db_version');
  const docTypeCols = await columns(conn, 'tabDocType');
  const hasCustomDoctypeFlag = docTypeCols.includes('custom');

  const customDocTypes = hasCustomDoctypeFlag
    ? await safeRows(
      conn,
      'tabDocType',
      'name, module, custom, istable, issingle, owner, modified',
      'module, name',
    ).then((rows) => rows.filter((row) => Number(row.custom) === 1))
    : [];

  const nonCoreDocTypes = await safeRows(
    conn,
    'tabDocType',
    'name, module, app, custom, istable, issingle, owner, modified',
    'module, name',
  ).then((rows) => rows.filter((row) => ![
    'Accounts', 'Buying', 'Core', 'Desk', 'Email', 'HR', 'Manufacturing', 'Projects',
    'Selling', 'Setup', 'Stock', 'Support', 'Utilities', 'Website',
  ].includes(row.module)));

  const docFieldCols = await columns(conn, 'tabDocField');
  const customDocTypeFieldSelect = [
    'parent',
    'idx',
    'fieldname',
    'label',
    'fieldtype',
    'options',
    'reqd',
    'hidden',
    'read_only',
    'in_list_view',
    'in_filter',
    docFieldCols.includes('default_value') ? 'default_value' : '`default` as default_value',
    'depends_on',
    docFieldCols.includes('mandatory_depends_on') ? 'mandatory_depends_on' : "'' as mandatory_depends_on",
    'description',
  ].join(', ');
  const customDocTypeFields = customDocTypes.length
    ? await conn.query(
      `select ${customDocTypeFieldSelect}
       from \`tabDocField\`
       where parent in (${customDocTypes.map(() => '?').join(',')})
       order by parent, idx`,
      customDocTypes.map((row) => row.name),
    ).then(([rows]) => rows)
    : [];

  const customFields = await safeRows(
    conn,
    'tabCustom Field',
    'name, dt, fieldname, label, fieldtype, options, insert_after, reqd, hidden, read_only, owner, modified',
    'dt, idx, name',
  );
  const propertySetters = await safeRows(
    conn,
    'tabProperty Setter',
    'name, doc_type, doctype_or_field, field_name, property, property_type, value, owner, modified',
    'doc_type, field_name, property',
  );
  const customScripts = await safeRows(
    conn,
    'tabCustom Script',
    'name, dt, script_type, script, owner, modified',
    'dt, script_type, name',
  );
  const workflows = await safeRows(
    conn,
    'tabWorkflow',
    'name, workflow_name, document_type, is_active, workflow_state_field, owner, modified',
    'document_type, name',
  );
  const workflowStates = await safeRows(
    conn,
    'tabWorkflow Document State',
    'parent, state, doc_status, allow_edit, update_field, update_value',
    'parent, idx',
  );
  const workflowTransitions = await safeRows(
    conn,
    'tabWorkflow Transition',
    'parent, state, action, allowed, next_state',
    'parent, idx',
  );
  const printFormatCols = await columns(conn, 'tabPrint Format');
  const printFormatSelect = [
    'name',
    'doc_type',
    printFormatCols.includes('module') ? 'module' : "'' as module",
    'standard',
    'disabled',
    'print_format_type',
    'print_format_builder',
    'custom_format',
    'owner',
    'modified',
  ].join(', ');
  const printFormats = await safeRows(conn, 'tabPrint Format', printFormatSelect, 'doc_type, name');
  const printFormatBodies = await safeRows(
    conn,
    'tabPrint Format',
    'name, doc_type, html, css, format_data',
    'doc_type, name',
  );
  const reports = await safeRows(
    conn,
    'tabReport',
    'name, report_name, ref_doctype, module, report_type, is_standard, disabled, owner, modified',
    'module, ref_doctype, name',
  );
  const reportBodies = await safeRows(
    conn,
    'tabReport',
    'name, report_name, ref_doctype, module, report_type, is_standard, javascript, json, query',
    'module, ref_doctype, name',
  );
  const roles = await safeRows(
    conn,
    'tabRole',
    'name, role_name, disabled, owner, modified',
    'name',
  );
  const customRoles = roles.filter((row) => String(row.owner || '').toLowerCase() !== 'administrator');
  const docPerms = await safeRows(
    conn,
    'tabDocPerm',
    'parent, role, permlevel, `read`, `write`, `create`, submit, cancel, `delete`, amend, report, export, import, set_user_permissions',
    'parent, role, permlevel',
  );
  const modules = await safeRows(conn, 'tabModule Def', 'name, module_name, app_name, owner, modified', 'name');
  const singles = await safeRows(conn, 'tabSingles', 'doctype, field, value', 'doctype, field');
  const installed = singles
    .filter((row) => row.doctype === 'Installed Applications')
    .map((row) => ({ app: row.field, version: row.value }));

  const audit = {
    generated_at: new Date().toISOString(),
    database: dbInfo,
    installed_applications: installed,
    counts: {
      custom_doctypes: customDocTypes.length,
      non_core_doctypes: nonCoreDocTypes.length,
      custom_fields: customFields.length,
      property_setters: propertySetters.length,
      custom_scripts: customScripts.length,
      workflows: workflows.length,
      workflow_states: workflowStates.length,
      workflow_transitions: workflowTransitions.length,
      print_formats: printFormats.length,
      reports: reports.length,
      roles: roles.length,
      custom_owner_roles: customRoles.length,
      doc_permissions: docPerms.length,
      modules: modules.length,
      custom_doctype_fields: customDocTypeFields.length,
    },
    group_counts: {
      custom_fields_by_doctype: groupCount(customFields, 'dt'),
      property_setters_by_doctype: groupCount(propertySetters, 'doc_type'),
      custom_scripts_by_doctype: groupCount(customScripts, 'dt'),
      reports_by_module: groupCount(reports, 'module'),
      print_formats_by_doctype: groupCount(printFormats, 'doc_type'),
    },
    custom_doctypes: customDocTypes,
    custom_doctype_fields: customDocTypeFields,
    non_core_doctypes: nonCoreDocTypes,
    custom_fields: customFields,
    property_setters: propertySetters,
    custom_scripts: customScripts,
    workflows,
    workflow_states: workflowStates,
    workflow_transitions: workflowTransitions,
    print_formats: printFormats,
    print_format_bodies: printFormatBodies,
    reports,
    report_bodies: reportBodies,
    roles,
    custom_owner_roles: customRoles,
    modules,
    doc_permissions: docPerms,
  };

  const jsonPath = path.join(outDir, 'old-erpnext-v6-audit.json');
  fs.writeFileSync(jsonPath, JSON.stringify(audit, null, 2));

  const report = [];
  report.push('# Old ERPNext v6 Customization Audit');
  report.push('');
  report.push(`Generated: ${audit.generated_at}`);
  report.push(`Database: ${dbInfo.db}`);
  report.push(`MariaDB: ${dbInfo.db_version}`);
  report.push('');
  report.push('## Summary');
  report.push('');
  report.push(...linesForTable(['Area', 'Count'], Object.entries({
    'Custom DocTypes': customDocTypes.length,
    'Non-core DocTypes': nonCoreDocTypes.length,
    'Custom Fields': customFields.length,
    'Property Setters': propertySetters.length,
    'Custom Scripts': customScripts.length,
    'Workflows': workflows.length,
    'Print Formats': printFormats.length,
    'Reports': reports.length,
    'Roles': roles.length,
    'DocPerm rows': docPerms.length,
    'Modules': modules.length,
  }).map(([Area, Count]) => ({ Area, Count }))));
  report.push('');
  report.push('## Installed Applications');
  report.push('');
  report.push(...linesForTable(['app', 'version'], installed.length ? installed : [{ app: '(not found in tabSingles)', version: '' }]));
  report.push('');
  report.push('## Custom Fields By DocType');
  report.push('');
  report.push(...linesForTable(
    ['DocType', 'Count'],
    Object.entries(audit.group_counts.custom_fields_by_doctype)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([DocType, Count]) => ({ DocType, Count })),
  ));
  report.push('');
  report.push('## Property Setters By DocType');
  report.push('');
  report.push(...linesForTable(
    ['DocType', 'Count'],
    Object.entries(audit.group_counts.property_setters_by_doctype)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([DocType, Count]) => ({ DocType, Count })),
  ));
  report.push('');
  report.push('## Custom Scripts');
  report.push('');
  report.push(...linesForTable(
    ['name', 'dt', 'script_type', 'preview'],
    customScripts.map((row) => ({
      name: row.name,
      dt: row.dt,
      script_type: row.script_type,
      preview: scriptPreview(row.script),
    })),
  ));
  report.push('');
  report.push('## Workflows');
  report.push('');
  report.push(...linesForTable(['name', 'workflow_name', 'document_type', 'is_active', 'workflow_state_field'], workflows));
  report.push('');
  report.push('## Print Formats');
  report.push('');
  report.push(...linesForTable(['name', 'doc_type', 'module', 'standard', 'disabled', 'print_format_type'], printFormats));
  report.push('');
  report.push('## Reports');
  report.push('');
  report.push(...linesForTable(['name', 'ref_doctype', 'module', 'report_type', 'is_standard', 'disabled'], reports));
  report.push('');
  report.push('## Custom Field Details');
  report.push('');
  report.push(...linesForTable(['dt', 'fieldname', 'label', 'fieldtype', 'options', 'insert_after', 'reqd', 'hidden', 'read_only'], customFields));
  report.push('');
  report.push('## Property Setter Details');
  report.push('');
  report.push(...linesForTable(['doc_type', 'doctype_or_field', 'field_name', 'property', 'property_type', 'value'], propertySetters));
  report.push('');
  report.push('## Migration Notes');
  report.push('');
  report.push('- Custom fields and property setters can usually be recreated in ERPNext 15, but each target DocType and field name must be verified because many standard DocTypes changed between v6 and v15.');
  report.push('- Custom Script records are legacy client scripts. Their JavaScript should be reviewed and rewritten for current Frappe form APIs where needed.');
  report.push('- Print formats from v6 may depend on old Jinja/context fields and need rendering tests in v15.');
  report.push('- Reports need classification before migration: Report Builder/Query/Script reports have different migration paths, and script reports may require filesystem app code.');
  report.push('- This database audit cannot detect custom Python apps, scheduler code, edited core files, or files stored outside the database.');

  const mdPath = path.join(outDir, 'old-erpnext-v6-audit.md');
  fs.writeFileSync(mdPath, `${report.join('\n')}\n`);
  await conn.end();

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
