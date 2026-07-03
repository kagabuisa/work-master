const express = require('express');
const path = require('path');
const { pool } = require('./src/db');
const {
  initStore,
  allInvoices,
  findInvoice,
  createInvoice,
  updateInvoice,
  submitInvoice,
  addInvoicePayment,
  updateInvoicePayment,
  invoiceSummary,
  topDebtors,
  debtorReport,
  stockSummary,
  stockBalances,
  localStockQuantity,
  createStockEntry,
  loadStockEntry,
  stockEntryCancelTemplate,
  searchStockEntriesForCancel,
  updateStockEntry,
  cancelStockEntry,
  updateStockEntrySupplierInfo,
  stockLedgerReport,
  stockLedgerVoucherDetails,
  stockMovementReport,
  grossProfitReport,
  generalLedgerReport,
  generalLedgerFilterOptions,
  journalReferenceOptions,
  trialBalanceReport,
  profitAndLossReport,
  balanceSheetReport,
  accountingAccounts,
  postableAccountingAccounts,
  createAccountingAccount,
  journalEntries,
  findJournalEntry,
  createJournalEntry,
} = require('./src/store');
require('dotenv').config({ quiet: true });

const app = express();
const port = Number(process.env.PORT || 3000);
let storeReady = false;
let storeInitPromise = null;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

app.use(async (_req, _res, next) => {
  try {
    await ensureStoreInitialized();
    next();
  } catch (err) {
    const wrapped = new Error(`Database is not ready: ${err.message}`);
    wrapped.status = 503;
    next(wrapped);
  }
});

function ensureStoreInitialized() {
  if (storeReady) {
    return Promise.resolve();
  }
  if (!storeInitPromise) {
    storeInitPromise = initStore()
      .then(() => {
        storeReady = true;
      })
      .catch((err) => {
        storeInitPromise = null;
        throw err;
      });
  }
  return storeInitPromise;
}

app.get('/', async (_req, res, next) => {
  try {
    const summary = await invoiceSummary();
    const recent = (await allInvoices()).slice(0, 10);
    const debtors = await topDebtors();
    res.render('index', { summary, recent, debtors, money });
  } catch (err) {
    next(err);
  }
});

app.get('/invoices/new', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.render('new-invoice', { today, invoice: null, items: [] });
});

app.get('/reports/debtors', async (req, res, next) => {
  try {
    const report = await debtorReport({
      search: req.query.q,
      customer: req.query.customer,
      from: req.query.from,
      to: req.query.to,
    });
    res.render('debtor-report', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/purchases', (_req, res) => {
  res.redirect('/reports/stock-ledger?entry_type=purchase');
});

app.get('/settings', (_req, res) => {
  res.render('settings');
});

app.get('/stock', async (req, res, next) => {
  try {
    const [summary, balances] = await Promise.all([
      stockSummary(),
      stockBalances({
        search: req.query.q,
        warehouse: req.query.warehouse,
      }),
    ]);
    res.render('stock', {
      summary,
      balances,
      filters: {
        search: String(req.query.q || '').trim(),
        warehouse: String(req.query.warehouse || '').trim(),
      },
      money,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/stock/entries/new', (_req, res) => {
  res.render('stock-entry', { today: todayString(), error: null, entry: null, items: [] });
});

app.post('/stock/entries', async (req, res, next) => {
  try {
    const id = await createStockEntry(parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?voucher_id=${id}`);
  } catch (err) {
    res.status(err.status || 500).render('stock-entry', {
      today: req.body.posting_date || todayString(),
      error: err.message || 'Could not save stock entry.',
      entry: null,
      items: [],
    });
  }
});

app.get('/stock/entries/:id/edit', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    if ((data.entry.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft stock entries can be edited.');
      err.status = 400;
      throw err;
    }
    res.render('stock-entry', {
      today: data.entry.posting_date,
      error: null,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/stock/entries/:id', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    res.render('stock-entry', {
      today: data.entry.posting_date,
      error: null,
      readOnly: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/stock/entries/:id', async (req, res, next) => {
  try {
    const id = await updateStockEntry(req.params.id, parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?status=${req.body.action === 'save_draft' ? 'draft' : 'submitted'}&voucher_id=${id}`);
  } catch (err) {
    try {
      const data = await loadStockEntry(req.params.id);
      res.status(err.status || 500).render('stock-entry', {
        today: req.body.posting_date || data.entry.posting_date || todayString(),
        error: err.message || 'Could not save stock entry.',
        ...data,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

app.get('/reports/stock-ledger', async (req, res, next) => {
  try {
    const report = await stockLedgerReport({
      search: req.query.q,
      warehouse: req.query.warehouse,
      entry_type: req.query.entry_type,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
    });
    res.render('stock-ledger', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/stock-ledger/vouchers/:type/:id', async (req, res, next) => {
  try {
    const details = await stockLedgerVoucherDetails(req.params.type, req.params.id);
    if (!details) {
      res.status(404).json({ error: 'Voucher not found.' });
      return;
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
});

app.post('/stock/entries/:id/supplier', async (req, res, next) => {
  try {
    const supplier = await updateStockEntrySupplierInfo(req.params.id, req.body);
    res.json({ supplier });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save supplier information.' });
  }
});

app.post('/stock/entries/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelStockEntry(req.params.id, req.body);
    res.json({ id, status: 'cancelled' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not cancel stock entry.' });
  }
});

app.get('/reports/stock-movement', async (req, res, next) => {
  try {
    const report = await stockMovementReport({
      search: req.query.q,
      warehouse: req.query.warehouse,
      from: req.query.from,
      to: req.query.to,
    });
    res.render('stock-movement', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/gross-profit', async (req, res, next) => {
  try {
    const report = await grossProfitReport({
      search: req.query.q,
      from: req.query.from,
      to: req.query.to,
    });
    res.render('gross-profit', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/general-ledger', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.q,
      account: req.query.account,
      party: req.query.party,
      voucher_type: req.query.voucher_type,
      from: req.query.from,
      to: req.query.to,
    };
    const [report, filterOptions] = await Promise.all([
      generalLedgerReport(filters),
      generalLedgerFilterOptions(),
    ]);
    res.render('general-ledger', { report, filterOptions, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/trial-balance', async (req, res, next) => {
  try {
    const report = await trialBalanceReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('trial-balance', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/profit-and-loss', async (req, res, next) => {
  try {
    const report = await profitAndLossReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('profit-and-loss', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/balance-sheet', async (req, res, next) => {
  try {
    const report = await balanceSheetReport({
      as_of: req.query.as_of,
    });
    res.render('balance-sheet', { report, money });
  } catch (err) {
    next(err);
  }
});

app.get('/accounts', async (_req, res, next) => {
  try {
    const accounts = await accountingAccounts();
    res.render('accounts', { accounts });
  } catch (err) {
    next(err);
  }
});

app.get('/accounts/new', (_req, res) => {
  res.render('account-form', {
    account: {
      account_type: 'expense',
      normal_balance: 'debit',
    },
    error: null,
  });
});

app.post('/accounts', async (req, res, next) => {
  try {
    await createAccountingAccount({
      account_code: req.body.account_code,
      account_name: req.body.account_name,
      account_type: req.body.account_type,
      normal_balance: req.body.normal_balance,
    });
    res.redirect('/accounts');
  } catch (err) {
    if (err.code === '23505') {
      err.message = 'An account with that code already exists.';
      err.status = 400;
    }
    res.status(err.status || 500).render('account-form', {
      account: {
        account_code: req.body.account_code,
        account_name: req.body.account_name,
        account_type: req.body.account_type,
        normal_balance: req.body.normal_balance,
      },
      error: err.message || 'Could not create account.',
    });
  }
});

app.get('/journals', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const journals = await journalEntries({ search });
    res.render('journals', { journals, search, money, journalTypeLabel });
  } catch (err) {
    next(err);
  }
});

app.get('/journals/new', async (req, res, next) => {
  try {
    const accounts = await postableAccountingAccounts();
    res.render('journal-entry', {
      accounts,
      journal: {
        journal_type: req.query.type || 'cash_receipt',
        posting_date: todayString(),
        lines: [],
      },
      today: todayString(),
      error: null,
      readOnly: false,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/journals', async (req, res, next) => {
  try {
    const payload = parseJournalEntryPayload(req.body);
    await validateJournalParty(payload);
    const id = await createJournalEntry(payload);
    res.redirect(`/journals/${id}`);
  } catch (err) {
    try {
      const accounts = await postableAccountingAccounts();
      res.status(err.status || 500).render('journal-entry', {
        accounts,
        journal: journalPayloadForRender(req.body),
        today: todayString(),
        error: err.message || 'Could not save journal entry.',
        readOnly: false,
        money,
        journalTypeLabel,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

app.get('/journals/:id', async (req, res, next) => {
  try {
    const [accounts, journal] = await Promise.all([
      postableAccountingAccounts(),
      findJournalEntry(req.params.id),
    ]);
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    res.render('journal-entry', {
      accounts,
      journal,
      today: todayString(),
      error: null,
      readOnly: true,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices', async (req, res, next) => {
  try {
    const payload = await buildInvoicePayload(req.body);
    const id = await createInvoice(payload);
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    next(err);
  }
});

app.get('/invoices', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    let invoices = await allInvoices();
    if (search) {
      invoices = invoices.filter((invoice) => (
        matchesSearchPattern(invoice.invoice_no, search)
        || matchesSearchPattern(invoice.invoice_date, search)
        || matchesSearchPattern(invoice.customer_name, search)
        || matchesSearchPattern(invoice.total, search)
        || matchesSearchPattern(invoice.amount_paid, search)
        || matchesSearchPattern(invoice.status, search)
        || matchesSearchPattern(invoice.docstatus || 'submitted', search)
      ));
    }
    invoices = invoices.slice(0, 100);
    res.render('invoices', { invoices, search, money });
  } catch (err) {
    next(err);
  }
});

app.get('/invoices/:id/edit', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    if ((data.invoice.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Submitted invoices cannot be edited.');
      err.status = 400;
      throw err;
    }
    res.render('new-invoice', {
      ...data,
      today: data.invoice.invoice_date,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id', async (req, res, next) => {
  try {
    const payload = await buildInvoicePayload(req.body);
    const id = await updateInvoice(req.params.id, payload);
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/submit', async (req, res, next) => {
  try {
    const invoice = await findInvoice(req.params.id);
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    const warehouse = invoice.items && invoice.items[0] ? invoice.items[0].warehouse : '';
    await validateDbItems(invoice.items, warehouse, { checkStock: true });
    const id = await submitInvoice(req.params.id);
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      try {
        const data = await loadInvoice(req.params.id);
        res.status(400).render('new-invoice', {
          ...data,
          today: data.invoice.invoice_date,
          stockWarning: err.stockWarning,
        });
        return;
      } catch (loadErr) {
        next(loadErr);
        return;
      }
    }
    next(err);
  }
});

app.get('/invoices/:id', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice', { ...data, today: todayString(), money });
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/payments', async (req, res, next) => {
  try {
    const id = await addInvoicePayment(req.params.id, {
      payment_date: req.body.payment_date,
      amount: req.body.amount,
      method: req.body.method,
      reference: req.body.reference,
      notes: req.body.notes,
    });
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/invoices/:id/payments/:paymentId', async (req, res, next) => {
  try {
    const id = await updateInvoicePayment(req.params.id, req.params.paymentId, {
      payment_date: req.body.payment_date,
      amount: req.body.amount,
      method: req.body.method,
      reference: req.body.reference,
      notes: req.body.notes,
    });
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    next(err);
  }
});

app.get('/invoices/:id/print', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice-print', { ...data, money });
  } catch (err) {
    next(err);
  }
});

app.get('/api/items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const q = sqlLikePattern(search);
    const warehouse = String(req.query.warehouse || '').trim();
    if (!warehouse) {
      res.status(400).json({ error: 'Warehouse is required.' });
      return;
    }
    const [items] = await pool.query(
      `
      SELECT
        i.name AS item_code,
        i.item_name,
        i.stock_uom,
        i.category,
        i.description,
        ROUND(COALESCE(price.price_list_rate, i.rrp, i.rwp, i.cost, i.last_purchase_rate, 0), 0) AS unit_price,
        ? AS warehouse
      FROM \`tabItem\` i
      LEFT JOIN (
        SELECT item_code, MAX(price_list_rate) AS price_list_rate
        FROM \`tabItem Price\`
        WHERE selling = 1
        GROUP BY item_code
      ) price ON price.item_code = i.name
      WHERE COALESCE(i.disabled, 0) = 0
        AND COALESCE(i.is_sales_item, 1) = 1
        AND (
          i.name LIKE ?
          OR i.item_name LIKE ?
          OR i.description LIKE ?
          OR i.category LIKE ?
          OR i.stock_uom LIKE ?
          OR ROUND(COALESCE(price.price_list_rate, i.rrp, i.rwp, i.cost, i.last_purchase_rate, 0), 0) LIKE ?
        )
      ORDER BY i.item_name
      LIMIT 100
      `,
      [warehouse, q, q, q, q, q, q],
    );
    const filtered = items
      .filter((item) => matchesSearchFields([
        item.item_code,
        item.item_name,
        item.stock_uom,
        item.description,
        item.category,
        item.unit_price,
        item.warehouse,
      ], search))
      .slice(0, 25);
    const withStock = await Promise.all(filtered.map(async (item) => {
      const balance = await localStockQuantity(item.item_code, warehouse);
      return {
        ...item,
        stock_balance: normalizeStockQuantity(balance.quantity),
        valuation_rate: Number(balance.valuation_rate || 0),
      };
    }));
    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

app.get('/api/master-items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const q = sqlLikePattern(search);
    const [items] = await pool.query(
      `
      SELECT
        i.name AS item_code,
        i.item_name,
        i.stock_uom,
        i.category,
        i.description,
        ROUND(COALESCE(price.price_list_rate, i.rrp, i.rwp, i.cost, i.last_purchase_rate, 0), 0) AS default_rate
      FROM \`tabItem\` i
      LEFT JOIN (
        SELECT item_code, MAX(price_list_rate) AS price_list_rate
        FROM \`tabItem Price\`
        WHERE buying = 1 OR selling = 1
        GROUP BY item_code
      ) price ON price.item_code = i.name
      WHERE COALESCE(i.disabled, 0) = 0
        AND (
          i.name LIKE ?
          OR i.item_name LIKE ?
          OR i.description LIKE ?
          OR i.category LIKE ?
          OR i.stock_uom LIKE ?
          OR ROUND(COALESCE(price.price_list_rate, i.rrp, i.rwp, i.cost, i.last_purchase_rate, 0), 0) LIKE ?
        )
      ORDER BY i.item_name
      LIMIT 100
      `,
      [q, q, q, q, q, q],
    );
    res.json(items
      .filter((item) => matchesSearchFields([
        item.item_code,
        item.item_name,
        item.stock_uom,
        item.description,
        item.category,
        item.default_rate,
      ], search))
      .slice(0, 50));
  } catch (err) {
    next(err);
  }
});

app.get('/api/stock-balance', async (req, res, next) => {
  try {
    const itemCode = String(req.query.item_code || '').trim();
    const warehouse = String(req.query.warehouse || '').trim();
    if (!itemCode || !warehouse) {
      res.json({ quantity: 0, valuation_rate: 0, stock_value: 0 });
      return;
    }
    let balance = await localStockQuantity(itemCode, warehouse);
    if (!Number(balance.quantity || 0) && !Number(balance.stock_value || 0)) {
      balance = await erpStockQuantity(itemCode, warehouse);
    }
    res.json({
      quantity: normalizeStockQuantity(balance.quantity),
      valuation_rate: Number(balance.valuation_rate || 0),
      stock_value: Number(balance.stock_value || 0),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stock-entry-cancel-template', async (req, res, next) => {
  try {
    const template = await stockEntryCancelTemplate(req.query.entry);
    res.json(template);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load stock entry.' });
  }
});

app.get('/api/stock-entries', async (req, res, next) => {
  try {
    const entries = await searchStockEntriesForCancel(req.query.q);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

app.get('/api/warehouses', async (_req, res, next) => {
  try {
    let warehouses;
    try {
      [warehouses] = await pool.query(
        `
        SELECT name AS warehouse
        FROM \`tabWarehouse\`
        WHERE COALESCE(disabled, 0) = 0
          AND COALESCE(is_group, 0) = 0
        ORDER BY name
        `,
      );
    } catch {
      [warehouses] = await pool.query(
        `
        SELECT Warehouse AS warehouse
        FROM stock_balance
        WHERE Warehouse IS NOT NULL
          AND Warehouse <> ''
        GROUP BY Warehouse
        ORDER BY Warehouse
        `,
      );
    }
    res.json(warehouses.map((row) => row.warehouse));
  } catch (err) {
    next(err);
  }
});

app.get('/api/customers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const q = sqlLikePattern(search);
    const [customers] = await pool.query(
      `
      SELECT name AS customer_id, customer_name, territory, customer_group
      FROM \`tabCustomer\`
      WHERE COALESCE(disabled, 0) = 0
        AND (name LIKE ? OR customer_name LIKE ? OR territory LIKE ? OR customer_group LIKE ?)
      ORDER BY customer_name
      LIMIT 100
      `,
      [q, q, q, q],
    );
    res.json(customers
      .filter((customer) => matchesSearchFields([
        customer.customer_id,
        customer.customer_name,
        customer.territory,
        customer.customer_group,
      ], search))
      .slice(0, 25));
  } catch (err) {
    next(err);
  }
});

app.get('/api/suppliers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const q = sqlLikePattern(search);
    const [suppliers] = await pool.query(
      `
      SELECT name AS supplier_id, supplier_name
      FROM \`tabSupplier\`
      WHERE name LIKE ? OR supplier_name LIKE ?
      ORDER BY supplier_name
      LIMIT 100
      `,
      [q, q],
    );
    res.json(suppliers
      .filter((supplier) => matchesSearchFields([
        supplier.supplier_id,
        supplier.supplier_name,
      ], search))
      .slice(0, 25));
  } catch (err) {
    next(err);
  }
});

app.get('/api/employees', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const q = sqlLikePattern(search);
    const [employees] = await pool.query(
      `
      SELECT name AS employee_id, employee_name
      FROM \`tabEmployee\`
      WHERE name LIKE ? OR employee_name LIKE ?
      ORDER BY employee_name
      LIMIT 100
      `,
      [q, q],
    );
    res.json(employees
      .filter((employee) => matchesSearchFields([
        employee.employee_id,
        employee.employee_name,
      ], search))
      .slice(0, 25));
  } catch (err) {
    next(err);
  }
});

app.get('/api/journal-reference-options', async (req, res, next) => {
  try {
    const references = await journalReferenceOptions({
      party_type: req.query.party_type,
      party_id: req.query.party_id,
      party_name: req.query.party_name,
      search: req.query.q,
    });
    res.json(references);
  } catch (err) {
    next(err);
  }
});

async function findDbCustomer(customerId) {
  const id = String(customerId || '').trim();
  if (!id) {
    return null;
  }
  const [customers] = await pool.query(
    `
    SELECT name AS customer_id, customer_name
    FROM \`tabCustomer\`
    WHERE name = ?
      AND COALESCE(disabled, 0) = 0
    LIMIT 1
    `,
    [id],
  );
  return customers[0] || null;
}

async function findDbSupplier(supplierId) {
  const id = String(supplierId || '').trim();
  if (!id) {
    return null;
  }
  const [suppliers] = await pool.query(
    `
    SELECT name AS supplier_id, supplier_name
    FROM \`tabSupplier\`
    WHERE name = ?
    LIMIT 1
    `,
    [id],
  );
  return suppliers[0] || null;
}

async function findDbEmployee(employeeId) {
  const id = String(employeeId || '').trim();
  if (!id) {
    return null;
  }
  const [employees] = await pool.query(
    `
    SELECT name AS employee_id, employee_name
    FROM \`tabEmployee\`
    WHERE name = ?
    LIMIT 1
    `,
    [id],
  );
  return employees[0] || null;
}

async function validateDbItems(items, warehouse, options = {}) {
  const checkStock = options.checkStock === true;
  const selectedWarehouse = String(warehouse || '').trim();
  if (!selectedWarehouse) {
    const err = new Error('Select a warehouse.');
    err.status = 400;
    throw err;
  }

  const validated = [];
  for (const item of items || []) {
    const itemCode = String(item.item_code || '').trim();
    const quantity = normalizeItemQuantity(item.quantity);
    if (!itemCode || quantity <= 0) {
      continue;
    }

    const [rows] = await pool.query(
      `
      SELECT
        i.name AS item_code,
        i.item_name
      FROM \`tabItem\` i
      WHERE i.name = ?
        AND COALESCE(i.disabled, 0) = 0
        AND COALESCE(i.is_sales_item, 1) = 1
      LIMIT 1
      `,
      [itemCode],
    );

    const dbItem = rows[0];
    if (!dbItem) {
      const err = new Error(`Item ${itemCode} is not available in ${selectedWarehouse}.`);
      err.status = 400;
      throw err;
    }
    const localBalance = await localStockQuantity(dbItem.item_code, selectedWarehouse);
    const available = normalizeStockQuantity(localBalance.quantity);
    if (checkStock && quantity > available) {
      const err = new Error(`Adjust quantity for ${dbItem.item_name}.`);
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: dbItem.item_name,
        item_code: dbItem.item_code,
        warehouse: selectedWarehouse,
        requested: quantity,
        available,
      };
      throw err;
    }

    validated.push({
      ...item,
      item_code: dbItem.item_code,
      item_name: dbItem.item_name,
      warehouse: selectedWarehouse,
      quantity,
      stock_at_sale: available,
    });
  }

  return validated;
}

function normalizeStockQuantity(value) {
  const quantity = Number(value || 0);
  const rounded = Math.round(quantity);
  return Math.abs(quantity - rounded) <= 0.0015
    ? rounded
    : Number(quantity.toFixed(3));
}

function normalizeItemQuantity(value) {
  return Math.max(0, Number(Number(value || 0).toFixed(3)));
}

async function loadInvoice(id) {
  const invoice = await findInvoice(id);
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  return { invoice, items: invoice.items || [] };
}

async function buildInvoicePayload(body) {
  const payload = {
    invoice_date: body.invoice_date,
    due_date: body.due_date,
    customer_id: body.customer_id,
    customer_name: String(body.customer_name || '').trim(),
    customer_phone: String(body.customer_phone || '').trim(),
    warehouse: String(body.warehouse || '').trim(),
    notes: String(body.notes || '').trim(),
    discount_amount: body.discount_amount,
    tax_amount: body.tax_amount,
    amount_paid: body.amount_paid,
    items: JSON.parse(body.items_json || '[]'),
    payments: JSON.parse(body.payments_json || '[]'),
  };
  if (!payload.customer_name) {
    const err = new Error('Customer name is required.');
    err.status = 400;
    throw err;
  }
  const customer = await findDbCustomer(payload.customer_id);
  if (!customer) {
    const err = new Error('Select a customer from the database.');
    err.status = 400;
    throw err;
  }
  payload.customer_id = customer.customer_id;
  payload.customer_name = customer.customer_name;
  payload.items = await validateDbItems(payload.items, payload.warehouse);
  return payload;
}

function parseStockEntryPayload(body) {
  const itemCodes = arrayField(body.item_code);
  const itemNames = arrayField(body.item_name);
  const warehouses = arrayField(body.warehouse);
  const targetWarehouses = arrayField(body.target_warehouse);
  const quantities = arrayField(body.quantity);
  const valuationRates = arrayField(body.valuation_rate);
  return {
    entry_type: body.entry_type,
    action: body.action,
    posting_date: body.posting_date,
    remarks: body.remarks,
    supplier_name: body.supplier_name,
    supplier_contact: body.supplier_contact,
    supplier_phone: body.supplier_phone,
    supplier_reference: body.supplier_reference,
    items: itemCodes.map((itemCode, index) => ({
      item_code: itemCode,
      item_name: itemNames[index],
      warehouse: warehouses[index],
      target_warehouse: targetWarehouses[index],
      quantity: quantities[index],
      valuation_rate: valuationRates[index],
    })),
  };
}

function parseJournalEntryPayload(body) {
  const accountIds = arrayField(body.account_id);
  const debits = arrayField(body.debit);
  const credits = arrayField(body.credit);
  const remarks = arrayField(body.line_remarks);
  return {
    journal_type: body.journal_type,
    posting_date: body.posting_date,
    party_type: body.party_type,
    party_id: body.party_id,
    party_name: body.party_name,
    reference_no: body.reference_no,
    remarks: body.remarks,
    lines: accountIds.map((accountId, index) => ({
      account_id: accountId,
      debit: debits[index],
      credit: credits[index],
      remarks: remarks[index],
    })),
  };
}

async function validateJournalParty(payload) {
  const partyType = String(payload.party_type || '').trim();
  const partyId = String(payload.party_id || '').trim();
  if (!partyType) {
    payload.party_id = '';
    payload.party_name = '';
    return;
  }
  if (!['customer', 'supplier', 'employee'].includes(partyType)) {
    const err = new Error('Choose a valid party type.');
    err.status = 400;
    throw err;
  }
  if (!partyId) {
    const err = new Error('Select a party from the database.');
    err.status = 400;
    throw err;
  }

  let party;
  if (partyType === 'customer') {
    party = await findDbCustomer(partyId);
    payload.party_name = party ? party.customer_name : '';
  } else if (partyType === 'supplier') {
    party = await findDbSupplier(partyId);
    payload.party_name = party ? party.supplier_name : '';
  } else {
    party = await findDbEmployee(partyId);
    payload.party_name = party ? party.employee_name : '';
  }
  if (!party) {
    const err = new Error(`Select a valid ${partyType} from the database.`);
    err.status = 400;
    throw err;
  }
  payload.party_id = partyId;
}

function journalPayloadForRender(body) {
  const payload = parseJournalEntryPayload(body);
  return {
    ...payload,
    lines: payload.lines.map((line, index) => ({
      ...line,
      line_no: index + 1,
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0),
    })),
  };
}

function journalTypeLabel(type) {
  if (type === 'cash_receipt') {
    return 'Cash Receipt';
  }
  if (type === 'payment_journal') {
    return 'Payment Journal';
  }
  return 'Journal Entry';
}

function arrayField(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

async function erpStockQuantity(itemCode, warehouse) {
  const [rows] = await pool.query(
    `
    SELECT
      COALESCE(SUM(StockBalance), 0) AS quantity,
      COALESCE(SUM(StockValue), 0) AS stock_value,
      COALESCE(MAX(UnitCost), 0) AS valuation_rate
    FROM stock_balance
    WHERE ItemName = ?
      AND Warehouse = ?
    `,
    [String(itemCode || '').trim(), String(warehouse || '').trim()],
  );
  return rows[0] || { quantity: 0, stock_value: 0, valuation_rate: 0 };
}

function sqlLikePattern(value) {
  const pattern = String(value || '').trim();
  if (!pattern.includes('%')) {
    return `%${pattern}%`;
  }
  return pattern.endsWith('%') ? pattern : `${pattern}%`;
}

function sqlCandidatePattern(value) {
  const pattern = String(value || '').trim();
  if (!pattern) {
    return '%';
  }
  if (!pattern.includes('%')) {
    return `%${pattern}%`;
  }
  return '%';
}

function matchesSearchPattern(value, pattern) {
  const text = normalizeSearchText(value);
  const search = normalizeSearchPattern(pattern);
  if (!search) {
    return true;
  }
  if (!search.includes('%')) {
    return text.includes(search);
  }
  return orderedWildcardMatch(text, search);
}

function matchesSearchFields(values, pattern) {
  const search = String(pattern || '').trim();
  if (!search) {
    return true;
  }
  const combined = normalizeSearchText(values.filter(Boolean).join(' '));
  return matchesSearchPattern(combined, search)
    || values.some((value) => matchesSearchPattern(value, search));
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchPattern(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wildcardRegex(pattern) {
  const search = String(pattern);
  const source = search
    .split('%')
    .map(escapeRegex)
    .join('.*');
  return new RegExp(`${search.startsWith('%') ? '' : '^'}${source}`, 'i');
}

function orderedWildcardMatch(text, pattern) {
  const startsAtBeginning = !pattern.startsWith('%');
  const terms = pattern.split('%').filter(Boolean);
  if (!terms.length) {
    return true;
  }
  let position = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const found = text.indexOf(terms[index], position);
    if (found === -1) {
      return false;
    }
    if (index === 0 && startsAtBeginning && found !== 0) {
      return false;
    }
    position = found + terms[index].length;
  }
  return true;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function money(value) {
  return Number(value || 0).toLocaleString('en-UG', {
    style: 'currency',
    currency: 'UGX',
    maximumFractionDigits: 0,
  });
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).render('error', { status, message: err.message || 'Server error' });
});

ensureStoreInitialized()
  .catch((err) => {
    console.error('Store initialization failed:', err.message);
    console.error('The app will keep running and retry when requests arrive.');
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`Invoice app running on http://localhost:${port}`);
    });
  });
