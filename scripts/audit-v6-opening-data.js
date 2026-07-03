const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outJson = path.join(__dirname, '..', 'audits', 'v6-opening-data-audit.json');
const outMd = path.join(__dirname, '..', 'audits', 'v6-opening-data-audit.md');

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

async function v15Count(base, cookie, doctype, filters) {
  const qs = new URLSearchParams({ doctype });
  if (filters) qs.set('filters', JSON.stringify(filters));
  const result = await requestJson(base, cookie, `/api/method/frappe.client.get_count?${qs}`);
  return Number(result.message);
}

async function one(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows[0] || {};
}

async function many(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
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
  lines.push('# ERPNext v6 Opening Data Audit');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Old database: \`${report.old_source.database}\``);
  lines.push(`V15 target: ${report.v15_target}`);
  lines.push('');
  lines.push('## Cutoff Signals');
  lines.push('');
  lines.push(markdownTable(
    ['Area', 'Rows', 'Min Date', 'Max Date'],
    [
      { Area: 'GL Entry', Rows: report.cutoff.gl_entries, 'Min Date': report.cutoff.gl_min_date, 'Max Date': report.cutoff.gl_max_date },
      { Area: 'Stock Ledger Entry', Rows: report.cutoff.stock_ledger_entries, 'Min Date': report.cutoff.sle_min_date, 'Max Date': report.cutoff.sle_max_date },
    ],
  ));
  lines.push('');
  lines.push('## V15 Transaction Counts');
  lines.push('');
  lines.push(markdownTable(
    ['DocType', 'Count'],
    Object.entries(report.v15_transaction_counts).map(([doctype, count]) => ({ DocType: doctype, Count: count })),
  ));
  lines.push('');
  lines.push('## Accounting Opening');
  lines.push('');
  lines.push(`- Non-zero account balances: ${report.accounting.nonzero_account_balances}`);
  lines.push(`- Total debit balance: ${report.accounting.total_debit_balance}`);
  lines.push(`- Total credit balance: ${report.accounting.total_credit_balance}`);
  lines.push(`- Net balance check: ${report.accounting.net_balance}`);
  lines.push(`- Non-zero party balances: ${report.accounting.nonzero_party_balances}`);
  lines.push('');
  lines.push('Top account balances by absolute value:');
  lines.push('');
  lines.push(markdownTable(
    ['Account', 'Balance'],
    report.accounting.top_accounts.map((row) => ({ Account: row.account, Balance: row.balance })),
  ));
  lines.push('');
  lines.push('## Stock Opening');
  lines.push('');
  lines.push(`- Non-zero item/warehouse bins: ${report.stock.nonzero_bins}`);
  lines.push(`- Total stock value from Bin: ${report.stock.total_stock_value}`);
  lines.push(`- Negative quantity bins: ${report.stock.negative_qty_bins}`);
  lines.push(`- Negative value bins: ${report.stock.negative_value_bins}`);
  lines.push('');
  lines.push('Top stock bins by absolute value:');
  lines.push('');
  lines.push(markdownTable(
    ['Item', 'Warehouse', 'Qty', 'Value'],
    report.stock.top_bins.map((row) => ({
      Item: row.item_code,
      Warehouse: row.warehouse,
      Qty: row.actual_qty,
      Value: row.stock_value,
    })),
  ));
  lines.push('');
  lines.push('## Outstanding Invoices');
  lines.push('');
  lines.push(markdownTable(
    ['Type', 'Count', 'Total Outstanding'],
    [
      {
        Type: 'Sales Invoice',
        Count: report.outstanding.sales_invoice.count,
        'Total Outstanding': report.outstanding.sales_invoice.total_outstanding,
      },
      {
        Type: 'Purchase Invoice',
        Count: report.outstanding.purchase_invoice.count,
        'Total Outstanding': report.outstanding.purchase_invoice.total_outstanding,
      },
    ],
  ));
  lines.push('');
  lines.push('## Recommended Next Step');
  lines.push('');
  lines.push('- Confirm the opening cutoff date to use for v15. The latest v6 GL and stock dates are shown above.');
  lines.push('- After the cutoff is confirmed, prepare opening Journal Entry lines from the account balances and Stock Reconciliation rows from the non-zero bins.');
  lines.push('- Importing open Sales/Purchase Invoices separately is better than only using party balances if invoice-level aging and allocation history must continue in v15.');
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
  const glCutoff = await one(oldConn, `
    select count(*) rows_count, min(posting_date) min_date, max(posting_date) max_date
    from \`tabGL Entry\`
    where ifnull(docstatus, 1) < 2
  `);
  const sleCutoff = await one(oldConn, `
    select count(*) rows_count, min(posting_date) min_date, max(posting_date) max_date
    from \`tabStock Ledger Entry\`
    where ifnull(is_cancelled, 0) = 0
  `);

  const accountSummary = await one(oldConn, `
    select
      count(*) nonzero_account_balances,
      sum(case when balance > 0 then balance else 0 end) total_debit_balance,
      sum(case when balance < 0 then -balance else 0 end) total_credit_balance,
      sum(balance) net_balance
    from (
      select account, round(sum(debit) - sum(credit), 2) balance
      from \`tabGL Entry\`
      where ifnull(docstatus, 1) < 2
      group by account
    ) balances
    where abs(balance) >= 0.01
  `);
  const topAccounts = await many(oldConn, `
    select account, balance
    from (
      select account, round(sum(debit) - sum(credit), 2) balance
      from \`tabGL Entry\`
      where ifnull(docstatus, 1) < 2
      group by account
    ) balances
    where abs(balance) >= 0.01
    order by abs(balance) desc
    limit 20
  `);
  const partySummary = await one(oldConn, `
    select count(*) nonzero_party_balances
    from (
      select party_type, party, round(sum(debit) - sum(credit), 2) balance
      from \`tabGL Entry\`
      where ifnull(docstatus, 1) < 2 and ifnull(party, '') != ''
      group by party_type, party
    ) balances
    where abs(balance) >= 0.01
  `);

  const stockSummary = await one(oldConn, `
    select
      count(*) nonzero_bins,
      round(sum(stock_value), 2) total_stock_value,
      sum(case when actual_qty < 0 then 1 else 0 end) negative_qty_bins,
      sum(case when stock_value < 0 then 1 else 0 end) negative_value_bins
    from \`tabBin\`
    where abs(ifnull(actual_qty, 0)) >= 0.000001 or abs(ifnull(stock_value, 0)) >= 0.01
  `);
  const topBins = await many(oldConn, `
    select item_code, warehouse, actual_qty, round(stock_value, 2) stock_value
    from \`tabBin\`
    where abs(ifnull(actual_qty, 0)) >= 0.000001 or abs(ifnull(stock_value, 0)) >= 0.01
    order by abs(stock_value) desc
    limit 20
  `);

  const salesOutstanding = await one(oldConn, `
    select count(*) count, round(sum(outstanding_amount), 2) total_outstanding
    from \`tabSales Invoice\`
    where docstatus = 1 and abs(ifnull(outstanding_amount, 0)) >= 0.01
  `);
  const purchaseOutstanding = await one(oldConn, `
    select count(*) count, round(sum(outstanding_amount), 2) total_outstanding
    from \`tabPurchase Invoice\`
    where docstatus = 1 and abs(ifnull(outstanding_amount, 0)) >= 0.01
  `);

  await oldConn.end();

  const transactionDoctypes = [
    'GL Entry',
    'Stock Ledger Entry',
    'Sales Invoice',
    'Purchase Invoice',
    'Journal Entry',
    'Stock Entry',
    'Stock Reconciliation',
    'Payment Entry',
  ];
  const v15TransactionCounts = {};
  for (const doctype of transactionDoctypes) {
    v15TransactionCounts[doctype] = await v15Count(base, cookie, doctype);
  }

  const report = {
    generated_at: new Date().toISOString(),
    old_source: {
      database: dbInfo.database_name,
      database_version: dbInfo.database_version,
    },
    v15_target: base,
    cutoff: {
      gl_entries: Number(glCutoff.rows_count || 0),
      gl_min_date: glCutoff.min_date,
      gl_max_date: glCutoff.max_date,
      stock_ledger_entries: Number(sleCutoff.rows_count || 0),
      sle_min_date: sleCutoff.min_date,
      sle_max_date: sleCutoff.max_date,
    },
    v15_transaction_counts: v15TransactionCounts,
    accounting: {
      nonzero_account_balances: Number(accountSummary.nonzero_account_balances || 0),
      total_debit_balance: money(accountSummary.total_debit_balance),
      total_credit_balance: money(accountSummary.total_credit_balance),
      net_balance: money(accountSummary.net_balance),
      nonzero_party_balances: Number(partySummary.nonzero_party_balances || 0),
      top_accounts: topAccounts.map((row) => ({ account: row.account, balance: money(row.balance) })),
    },
    stock: {
      nonzero_bins: Number(stockSummary.nonzero_bins || 0),
      total_stock_value: money(stockSummary.total_stock_value),
      negative_qty_bins: Number(stockSummary.negative_qty_bins || 0),
      negative_value_bins: Number(stockSummary.negative_value_bins || 0),
      top_bins: topBins.map((row) => ({
        item_code: row.item_code,
        warehouse: row.warehouse,
        actual_qty: Number(row.actual_qty || 0),
        stock_value: money(row.stock_value),
      })),
    },
    outstanding: {
      sales_invoice: {
        count: Number(salesOutstanding.count || 0),
        total_outstanding: money(salesOutstanding.total_outstanding),
      },
      purchase_invoice: {
        count: Number(purchaseOutstanding.count || 0),
        total_outstanding: money(purchaseOutstanding.total_outstanding),
      },
    },
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, buildMarkdown(report));
  console.log(JSON.stringify({
    cutoff: report.cutoff,
    accounting: report.accounting,
    stock: {
      nonzero_bins: report.stock.nonzero_bins,
      total_stock_value: report.stock.total_stock_value,
      negative_qty_bins: report.stock.negative_qty_bins,
    },
    outstanding: report.outstanding,
    v15_transaction_counts: report.v15_transaction_counts,
  }, null, 2));
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
