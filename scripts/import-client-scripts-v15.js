const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const auditPath = path.join(__dirname, '..', 'audits', 'old-erpnext-v6-audit.json');
const logPath = path.join(__dirname, '..', 'audits', 'v15-client-script-import-log.json');

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

function scriptView(script) {
  return String(script || '').includes('frappe.listview_settings') ? 'List' : 'Form';
}

function syntaxError(script) {
  try {
    new Function(script || '');
    return '';
  } catch (err) {
    return err.message;
  }
}

function payload(script) {
  return {
    doctype: 'Client Script',
    name: `Migrated - ${script.dt} - ${scriptView(script.script)}`,
    dt: script.dt,
    view: scriptView(script.script),
    enabled: 1,
    script: script.script || '',
  };
}

function groupedScripts(customScripts) {
  const groups = new Map();
  for (const script of customScripts) {
    const view = scriptView(script.script);
    const key = `${script.dt}::${view}`;
    if (!groups.has(key)) groups.set(key, { dt: script.dt, view, sources: [] });
    groups.get(key).sources.push(script);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    source_name: group.sources.map((script) => script.name).join(' + '),
    script: group.sources
      .map((script) => `// Migrated from ERPNext v6 Custom Script: ${script.name}\n${script.script || ''}`)
      .join('\n\n'),
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');

  const cookie = await login(base, usr, pwd);
  const docTypes = new Set((await fetchAllResource(base, cookie, 'DocType', ['name'])).map((row) => row.name));
  const existingScripts = await fetchAllResource(
    base,
    cookie,
    'Client Script',
    ['name', 'dt', 'view', 'enabled', 'script'],
  );
  const existingByTarget = new Map(existingScripts.map((row) => [`${row.dt}::${row.view}`, row]));

  const log = {
    generated_at: new Date().toISOString(),
    apply,
    target: base,
    counts: {
      source_custom_scripts: audit.custom_scripts.length,
      attempted_create: 0,
      attempted_update: 0,
      created: 0,
      updated: 0,
      skipped_same_script: 0,
      skipped_missing_doctype: 0,
      skipped_syntax_error: 0,
      failed: 0,
    },
    results: [],
  };

  const scripts = groupedScripts(audit.custom_scripts);
  for (const source of scripts) {
    if (!docTypes.has(source.dt)) {
      log.counts.skipped_missing_doctype += 1;
      log.results.push({ name: source.name, dt: source.dt, status: 'skipped_missing_doctype' });
      continue;
    }

    const syntax = syntaxError(source.script);
    if (syntax) {
      log.counts.skipped_syntax_error += 1;
      log.results.push({ name: source.name, dt: source.dt, status: 'skipped_syntax_error', error: syntax });
      continue;
    }

    const data = {
      doctype: 'Client Script',
      name: `Migrated - ${source.dt} - ${source.view}`,
      dt: source.dt,
      view: source.view,
      enabled: 1,
      script: source.script,
    };
    const key = `${data.dt}::${data.view}`;
    const existing = existingByTarget.get(key);
    if (existing && String(existing.script || '') === data.script && Number(existing.enabled || 0) === 1) {
      log.counts.skipped_same_script += 1;
      log.results.push({ name: existing.name, dt: data.dt, view: data.view, status: 'skipped_same_script' });
      continue;
    }

    if (!apply) {
      log.results.push({
        source_name: source.source_name,
        target_name: existing && existing.name,
        dt: data.dt,
        view: data.view,
        status: existing ? 'dry_run_update' : 'dry_run_create',
        length: data.script.length,
      });
      continue;
    }

    try {
      if (existing) {
        log.counts.attempted_update += 1;
        await requestJson(base, cookie, `/api/resource/Client Script/${encodeURIComponent(existing.name)}`, {
          method: 'PUT',
          body: JSON.stringify({
            enabled: 1,
            script: data.script,
          }),
        });
        log.counts.updated += 1;
        log.results.push({ name: existing.name, dt: data.dt, view: data.view, status: 'updated' });
      } else {
        log.counts.attempted_create += 1;
        const created = await requestJson(base, cookie, '/api/resource/Client Script', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        existingByTarget.set(key, created.data || data);
        log.counts.created += 1;
        log.results.push({
          name: created.data && created.data.name,
          dt: data.dt,
          view: data.view,
          status: 'created',
        });
      }
    } catch (err) {
      log.counts.failed += 1;
      log.results.push({
        source_name: source.source_name,
        dt: data.dt,
        view: data.view,
        status: 'failed',
        error: err.message,
        response: err.body,
      });
    }
  }

  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log(JSON.stringify(log.counts, null, 2));
  console.log(`Wrote ${logPath}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create/update client scripts.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
