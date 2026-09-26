const { pool: mysqlPool } = require('./db');
const { initStore, getPostgresPool } = require('./store');

const DEFAULT_IMPORT_FROM = '2026-09-23';

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function quantity(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function text(value) {
  return String(value || '').trim();
}

function dateOnly(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function statusFor(total, amountPaid) {
  if (amountPaid <= 0) {
    return 'unpaid';
  }
  return amountPaid >= total ? 'paid' : 'partial';
}

async function mysqlColumns(tableName) {
  const [rows] = await mysqlPool.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [tableName],
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
}

function sqlColumn(alias, columns, names, fallbackSql = 'NULL') {
  for (const name of names) {
    if (columns.has(name)) {
      return `${alias}.\`${name}\``;
    }
  }
  return fallbackSql;
}

function sqlNumber(alias, columns, names, fallbackSql = '0') {
  return `COALESCE(${sqlColumn(alias, columns, names, fallbackSql)}, 0)`;
}

async function fetchSalesInvoices(from) {
  const invoiceColumns = await mysqlColumns('tabSales Invoice');
  const itemColumns = await mysqlColumns('tabSales Invoice Item');
  const returnFilters = [];
  if (invoiceColumns.has('is_return')) {
    returnFilters.push('AND COALESCE(si.`is_return`, 0) = 0');
  }
  if (invoiceColumns.has('return_against')) {
    returnFilters.push("AND COALESCE(si.`return_against`, '') = ''");
  }

  const [invoices] = await mysqlPool.query(
    `
    SELECT
      si.\`name\` AS invoice_no,
      ${sqlColumn('si', invoiceColumns, ['posting_date'])} AS invoice_date,
      ${sqlColumn('si', invoiceColumns, ['due_date'])} AS due_date,
      ${sqlColumn('si', invoiceColumns, ['customer'])} AS customer_id,
      ${sqlColumn('si', invoiceColumns, ['customer_name'], sqlColumn('si', invoiceColumns, ['customer']))} AS customer_name,
      ${sqlColumn('si', invoiceColumns, ['contact_mobile', 'mobile_no', 'contact_phone', 'phone'])} AS customer_phone,
      ${sqlColumn('si', invoiceColumns, ['remarks', 'remark', 'terms'])} AS notes,
      ${sqlNumber('si', invoiceColumns, ['base_net_total', 'net_total'])} AS subtotal,
      ${sqlNumber('si', invoiceColumns, ['base_total_taxes_and_charges', 'total_taxes_and_charges'])} AS tax_amount,
      ${sqlNumber('si', invoiceColumns, ['base_discount_amount', 'discount_amount'])} AS discount_amount,
      ${sqlNumber('si', invoiceColumns, ['base_grand_total', 'grand_total', 'rounded_total'])} AS total,
      ${sqlNumber('si', invoiceColumns, ['outstanding_amount'], sqlNumber('si', invoiceColumns, ['base_grand_total', 'grand_total', 'rounded_total']))} AS outstanding_amount
    FROM \`tabSales Invoice\` si
    WHERE si.\`docstatus\` = 1
      AND si.\`posting_date\` >= ?
      ${returnFilters.join('\n      ')}
    ORDER BY si.\`posting_date\`, si.\`name\`
    `,
    [from],
  );

  if (!invoices.length) {
    return { invoices, itemsByInvoice: new Map() };
  }

  const invoiceNos = invoices.map((invoice) => invoice.invoice_no);
  const [items] = await mysqlPool.query(
    `
    SELECT
      sii.\`parent\` AS invoice_no,
      ${sqlNumber('sii', itemColumns, ['idx'])} AS line_no,
      ${sqlColumn('sii', itemColumns, ['item_code'])} AS item_code,
      ${sqlColumn('sii', itemColumns, ['item_name', 'description'], sqlColumn('sii', itemColumns, ['item_code']))} AS item_name,
      ${sqlColumn('sii', itemColumns, ['warehouse'])} AS warehouse,
      ${sqlNumber('sii', itemColumns, ['qty'])} AS quantity,
      ${sqlNumber('sii', itemColumns, ['base_net_rate', 'base_rate', 'net_rate', 'rate'])} AS unit_price,
      ${sqlNumber('sii', itemColumns, ['base_net_amount', 'base_amount', 'net_amount', 'amount'])} AS line_total
    FROM \`tabSales Invoice Item\` sii
    WHERE sii.\`parent\` IN (?)
    ORDER BY sii.\`parent\`, sii.\`idx\`
    `,
    [invoiceNos],
  );

  const itemsByInvoice = new Map();
  for (const item of items) {
    const list = itemsByInvoice.get(item.invoice_no) || [];
    list.push({
      line_no: Number(item.line_no || list.length + 1),
      item_code: text(item.item_code),
      item_name: text(item.item_name || item.item_code),
      warehouse: text(item.warehouse) || null,
      quantity: quantity(item.quantity),
      unit_price: money(item.unit_price),
      line_total: money(item.line_total),
    });
    itemsByInvoice.set(item.invoice_no, list);
  }

  return { invoices, itemsByInvoice };
}

function normalizeInvoice(row, items) {
  const total = money(row.total);
  const outstanding = Math.max(0, money(row.outstanding_amount));
  const amountPaid = money(Math.min(total, Math.max(0, total - outstanding)));
  return {
    invoice_no: text(row.invoice_no),
    invoice_date: dateOnly(row.invoice_date),
    due_date: dateOnly(row.due_date),
    customer_id: text(row.customer_id) || null,
    customer_name: text(row.customer_name || row.customer_id || 'Unknown Customer'),
    customer_phone: text(row.customer_phone) || null,
    notes: text(row.notes) || null,
    subtotal: money(row.subtotal),
    tax_amount: money(row.tax_amount),
    discount_amount: money(row.discount_amount),
    total,
    amount_paid: amountPaid,
    status: statusFor(total, amountPaid),
    items: items.filter((item) => item.item_code && item.item_name && item.quantity > 0),
  };
}

async function insertInvoice(client, invoice) {
  const { rows } = await client.query(
    `
    INSERT INTO app_invoices (
      invoice_no, docstatus, invoice_date, due_date, customer_id, customer_name,
      customer_phone, notes, subtotal, tax_amount, discount_amount, total,
      amount_paid, status, submitted_by, submitted_by_user_id, submitted_at
    )
    VALUES (
      $1, 'submitted', $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      $12, $13, 'System', NULL, now()
    )
    ON CONFLICT (invoice_no) DO NOTHING
    RETURNING id
    `,
    [
      invoice.invoice_no,
      invoice.invoice_date,
      invoice.due_date,
      invoice.customer_id,
      invoice.customer_name,
      invoice.customer_phone,
      invoice.notes,
      invoice.subtotal,
      invoice.tax_amount,
      invoice.discount_amount,
      invoice.total,
      invoice.amount_paid,
      invoice.status,
    ],
  );
  if (!rows.length) return null;
  const invoiceId = Number(rows[0].id);

  for (const item of invoice.items) {
    await client.query(
      `
      INSERT INTO app_invoice_items (
        invoice_pk, invoice_id, invoice_no, line_no, item_code, item_name, warehouse,
        quantity, unit_price, stock_at_sale, line_total, cost_rate, cost_amount, gross_profit
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 0, 0, 0)
      `,
      [
        invoiceId,
        invoice.invoice_no,
        item.line_no,
        item.item_code,
        item.item_name,
        item.warehouse,
        item.quantity,
        item.unit_price,
        item.line_total,
      ],
    );
  }

  if (invoice.amount_paid > 0) {
    await client.query(
      `
      INSERT INTO app_invoice_payments (
        invoice_id, payment_no, payment_date, amount, method, reference, notes, created_at
      )
      VALUES ($1, 1, $2, $3, 'legacy', $4, $5, now())
      `,
      [
        invoiceId,
        invoice.invoice_date,
        invoice.amount_paid,
        invoice.invoice_no,
        'Payment total imported from ERPNext outstanding amount.',
      ],
    );
  }

  return invoiceId;
}

async function importSalesInvoicesFromMysql(options = {}) {
  const from = String(options.from || process.env.SALES_INVOICE_IMPORT_FROM || DEFAULT_IMPORT_FROM).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error('Use date format YYYY-MM-DD for SALES_INVOICE_IMPORT_FROM or --from=YYYY-MM-DD.');
  }
  if (String(process.env.INVOICE_STORE || '').toLowerCase() !== 'postgres') {
    throw new Error('Sales invoice import requires INVOICE_STORE=postgres.');
  }

  await initStore();
  const { invoices, itemsByInvoice } = await fetchSalesInvoices(from);
  const client = await getPostgresPool().connect();
  const summary = {
    import_from: from,
    mysql_invoices: invoices.length,
    imported: 0,
    skipped_existing: 0,
    skipped_no_items: 0,
    paid_rows_created: 0,
  };

  try {
    await client.query('BEGIN');
    for (const sourceInvoice of invoices) {
      const invoiceItems = itemsByInvoice.get(sourceInvoice.invoice_no) || [];
      const invoice = normalizeInvoice(sourceInvoice, invoiceItems);
      if (!invoice.items.length) {
        summary.skipped_no_items += 1;
        continue;
      }
      const invoiceId = await insertInvoice(client, invoice);
      if (!invoiceId) {
        summary.skipped_existing += 1;
        continue;
      }
      summary.imported += 1;
      if (invoice.amount_paid > 0) {
        summary.paid_rows_created += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      tables: ['public.app_invoices', 'public.app_invoice_items', 'public.app_invoice_payments'],
    },
    ...summary,
  };
}

module.exports = {
  DEFAULT_IMPORT_FROM,
  importSalesInvoicesFromMysql,
};
