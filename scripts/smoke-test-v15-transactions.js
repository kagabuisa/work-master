const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v15-transaction-smoke-test-log.json');
const outMd = path.join(__dirname, '..', 'audits', 'v15-transaction-smoke-test-log.md');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
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

async function fetchAll(base, cookie, doctype, fields, filters, limit = 20) {
  const qs = new URLSearchParams({
    fields: JSON.stringify(fields),
    limit_page_length: String(limit),
  });
  if (filters) qs.set('filters', JSON.stringify(filters));
  const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
  return result.data || [];
}

async function first(base, cookie, doctype, fields, filters, label) {
  const rows = await fetchAll(base, cookie, doctype, fields, filters, 50);
  if (!rows.length) throw new Error(`No ${label || doctype} record found for smoke test.`);
  return rows[0];
}

async function createDoc(base, cookie, payload) {
  const result = await requestJson(base, cookie, `/api/resource/${encodeURIComponent(payload.doctype)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return result.data;
}

async function deleteDoc(base, cookie, doctype, name) {
  await requestJson(base, cookie, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

async function countDoc(base, cookie, doctype) {
  const qs = new URLSearchParams({ doctype });
  const result = await requestJson(base, cookie, `/api/method/frappe.client.get_count?${qs}`);
  return Number(result.message);
}

function resultOk(step, doc) {
  return { step, status: 'ok', doctype: doc.doctype, name: doc.name, docstatus: doc.docstatus };
}

function resultFail(step, err) {
  return {
    step,
    status: 'failed',
    error: err.message,
    response: err.body,
  };
}

function buildMarkdown(log) {
  const lines = [];
  lines.push('# ERPNext v15 Transaction Smoke Test');
  lines.push('');
  lines.push(`Generated: ${log.generated_at}`);
  lines.push(`Target: ${log.target}`);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push(log.ok ? '- PASS: draft transaction creation and cleanup completed.' : '- FAIL: one or more draft transaction checks failed.');
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('| Step | Status | Document | Cleanup |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of log.results) {
    const doc = row.name ? `${row.doctype} ${row.name}` : '';
    const cleanup = log.cleanup.find((item) => item.doctype === row.doctype && item.name === row.name);
    lines.push(`| ${row.step} | ${row.status} | ${doc} | ${cleanup ? cleanup.status : ''} |`);
  }
  lines.push('');
  lines.push('## Counts Before/After');
  lines.push('');
  lines.push('| DocType | Before | After |');
  lines.push('| --- | ---: | ---: |');
  for (const doctype of Object.keys(log.before_counts)) {
    lines.push(`| ${doctype} | ${log.before_counts[doctype]} | ${log.after_counts[doctype]} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const base = env('NEW_ERPNEXTV15_URL', 'New_ERPNEXTV15_URL').replace(/\/$/, '');
  const usr = env('NEW_ERPNEXTV15_USERNAME', 'New_ERPNEXTV15_USERNAME');
  const pwd = env('NEW_ERPNEXTV15_PASSWORD', 'New_ERPNEXTV15_PASSWORD');
  if (!base || !usr || !pwd) throw new Error('Missing v15 URL, username, or password env values.');
  const cookie = await login(base, usr, pwd);

  const doctypes = ['Sales Invoice', 'Purchase Invoice', 'Stock Entry', 'Payment Entry'];
  const log = {
    generated_at: new Date().toISOString(),
    target: base,
    before_counts: {},
    after_counts: {},
    context: {},
    results: [],
    cleanup: [],
    ok: false,
  };

  for (const doctype of doctypes) log.before_counts[doctype] = await countDoc(base, cookie, doctype);

  const company = await first(base, cookie, 'Company', ['name', 'default_currency'], null, 'Company');
  const customer = await first(base, cookie, 'Customer', ['name'], null, 'Customer');
  const supplier = await first(base, cookie, 'Supplier', ['name'], null, 'Supplier');
  const item = await first(
    base,
    cookie,
    'Item',
    ['name', 'item_code', 'item_name', 'stock_uom', 'is_stock_item', 'is_sales_item', 'is_purchase_item'],
    [['Item', 'disabled', '=', 0]],
    'enabled Item',
  );
  const warehouse = await first(base, cookie, 'Warehouse', ['name'], [['Warehouse', 'disabled', '=', 0]], 'enabled Warehouse');
  const employee = await first(base, cookie, 'Employee', ['name'], null, 'Employee');
  const costCenter = await first(base, cookie, 'Cost Center', ['name'], [['Cost Center', 'is_group', '=', 0]], 'leaf Cost Center');
  const receivable = await first(base, cookie, 'Account', ['name'], [['Account', 'account_type', '=', 'Receivable'], ['Account', 'is_group', '=', 0]], 'receivable Account');
  const cash = await first(base, cookie, 'Account', ['name'], [['Account', 'account_type', 'in', ['Cash', 'Bank']], ['Account', 'is_group', '=', 0]], 'cash/bank Account');
  log.context = {
    company: company.name,
    customer: customer.name,
    supplier: supplier.name,
    item: item.name,
    warehouse: warehouse.name,
    employee: employee.name,
    cost_center: costCenter.name,
    receivable_account: receivable.name,
    cash_or_bank_account: cash.name,
  };

  const created = [];
  const postingDate = today();
  const commonItem = clean({
    item_code: item.name,
    item_name: item.item_name || item.name,
    qty: 1,
    rate: 1,
    uom: item.stock_uom || 'Nos',
    conversion_factor: 1,
    warehouse: warehouse.name,
    cost_center: costCenter.name,
  });

  const tests = [
    {
      step: 'Sales Invoice draft',
      payload: clean({
        doctype: 'Sales Invoice',
        company: company.name,
        customer: customer.name,
        posting_date: postingDate,
        due_date: postingDate,
        currency: company.default_currency || 'UGX',
        invoice_by: employee.name,
        warehoused: warehouse.name,
        update_stock: 0,
        items: [commonItem],
      }),
    },
    {
      step: 'Purchase Invoice draft',
      payload: clean({
        doctype: 'Purchase Invoice',
        company: company.name,
        supplier: supplier.name,
        posting_date: postingDate,
        due_date: postingDate,
        bill_no: `SMOKE-${Date.now()}`,
        bill_date: postingDate,
        currency: company.default_currency || 'UGX',
        update_stock: 0,
        items: [commonItem],
      }),
    },
    {
      step: 'Stock Entry draft',
      payload: clean({
        doctype: 'Stock Entry',
        company: company.name,
        purpose: 'Material Receipt',
        stock_entry_type: 'Material Receipt',
        transfer_type: 'Warehouse transfer',
        posting_date: postingDate,
        items: [clean({
          item_code: item.name,
          item_name: item.item_name || item.name,
          qty: 1,
          transfer_qty: 1,
          t_warehouse: warehouse.name,
          stock_uom: item.stock_uom || 'Nos',
          uom: item.stock_uom || 'Nos',
          conversion_factor: 1,
          basic_rate: 1,
          cost_center: costCenter.name,
        })],
      }),
    },
    {
      step: 'Payment Entry draft',
      payload: clean({
        doctype: 'Payment Entry',
        company: company.name,
        payment_type: 'Receive',
        party_type: 'Customer',
        party: customer.name,
        posting_date: postingDate,
        paid_from: receivable.name,
        paid_to: cash.name,
        paid_amount: 1,
        received_amount: 1,
        reference_no: `SMOKE-${Date.now()}`,
        reference_date: postingDate,
        source_exchange_rate: 1,
        target_exchange_rate: 1,
      }),
    },
  ];

  try {
    for (const test of tests) {
      try {
        const doc = await createDoc(base, cookie, test.payload);
        created.push({ doctype: doc.doctype || test.payload.doctype, name: doc.name });
        log.results.push(resultOk(test.step, { doctype: doc.doctype || test.payload.doctype, name: doc.name, docstatus: doc.docstatus }));
      } catch (err) {
        log.results.push(resultFail(test.step, err));
      }
    }
  } finally {
    for (const doc of created.reverse()) {
      try {
        await deleteDoc(base, cookie, doc.doctype, doc.name);
        log.cleanup.push({ ...doc, status: 'deleted' });
      } catch (err) {
        log.cleanup.push({ ...doc, status: 'failed', error: err.message, response: err.body });
      }
    }
    for (const doctype of doctypes) log.after_counts[doctype] = await countDoc(base, cookie, doctype);
    log.ok = log.results.every((row) => row.status === 'ok')
      && log.cleanup.every((row) => row.status === 'deleted')
      && doctypes.every((doctype) => log.before_counts[doctype] === log.after_counts[doctype]);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, `${JSON.stringify(log, null, 2)}\n`);
    fs.writeFileSync(outMd, buildMarkdown(log));
  }

  console.log(JSON.stringify({
    ok: log.ok,
    results: log.results,
    cleanup: log.cleanup,
    before_counts: log.before_counts,
    after_counts: log.after_counts,
  }, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
  if (!log.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
