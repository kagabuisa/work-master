'use strict';
// /invoices routes and their helpers. Mounted at the app root (full paths).
const express = require('express');
const { money, todayString, paymentReturnPath } = require('../format');
const invoiceMath = require('../../shared/invoice-math');
const { currentPostingDate, currentPostingTime } = require('../../posting-time');
const { invoiceFormState, duplicateInvoiceFormState } = require('../../invoice-form-state');
const { warehouseAccessOptions } = require('../helpers');
const { findDbCustomer } = require('../parties');
const { cachedInvoiceList, clearInvoiceCaches } = require('../cache');
const { invoiceReport, validateSavedColumns, loadSavedColumns, saveDefaultColumns,
  resetDefaultColumns, csvLine, EXPORT_PAGE_SIZE } = require('../invoice-report');
const { selectedCategories, warehouseAllowed, invoicePriceListAllowed, allowedNamedListValues, deniedNamedListValues, requireInvoicePriceList, accountAllowed } = require('../../access');
const { findInvoice, getCompanyInformation, findMasterItem, findMasterRecord, localStockQuantity, createInvoice, submitInvoice, createCashSaleInvoice, submitCashSaleInvoice, updateInvoice, cancelInvoice, updateInvoiceNonSystemNumber, updateVoucherPostingTime, deleteDraftVoucher, addInvoicePayment, cancelInvoicePayment, invoiceForPayment, invoiceWarehouses, masterWarehouses } = require('../../store');
const { voucherOwnerId, voucherEmployeeId } = require('../../voucher-ownership');

const router = express.Router();

function requireReceiptAccount(user, value) {
  if (!value) { const error = new Error('Choose a cash or bank account.'); error.status = 400; throw error; }
  if (!accountAllowed(user, value)) {
    const error = new Error('Your account cannot use the selected payment account.');
    error.status = 403;
    throw error;
  }
}

async function defaultSalesPriceList(user) {
  const assigned = user.record_access?.retail_price_list;
  for (const name of [...new Set([assigned, 'Retail Pricelist'].filter(Boolean))]) {
    if (!invoicePriceListAllowed(user, name)) continue;
    const list = await findMasterRecord('price-lists', name);
    if (list && list.active === 1 && list.docstatus === 'submitted'
        && list.currency === 'UGX' && ['selling', 'both'].includes(list.price_type)) return name;
  }
  return '';
}

router.get('/invoices/new', async (req, res, next) => {
  try {
    const today = currentPostingDate();
    const employeeId = req.currentUser.record_access?.employee_id;
    const employee = employeeId && await findMasterRecord('employees', employeeId);
    const defaultWarehouse = req.currentUser.record_access?.warehouse;
    const defaultRetailPriceList = await defaultSalesPriceList(req.currentUser);
    const invoice = {
      ...(employee ? { invoicer_id: employee.employee_id, invoicer: employee.employee_name } : {}),
      ...(defaultWarehouse && warehouseAllowed(req.currentUser, defaultWarehouse)
        ? { warehouse: defaultWarehouse } : {}),
      ...(defaultRetailPriceList ? { price_list: defaultRetailPriceList } : {}),
    };
    res.render('new-invoice', { today, invoice: Object.keys(invoice).length ? invoice : null, items: [] });
  } catch (err) {
    next(err);
  }
});

router.post('/invoices', async (req, res, next) => {
  let id;
  try {
    const payload = await buildInvoicePayload(req.body, req.currentUser);
    if (req.body.action === 'cash_sale') {
      requireReceiptAccount(req.currentUser, req.body.cash_sale_account_id);
      const payment = cashSalePayment(payload, req.body);
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
      id = await createCashSaleInvoice(payload, payment);
    } else if (req.body.action === 'submit_invoice') {
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
      id = await createInvoice({ ...payload, payments: [], amount_paid: 0 });
      await submitInvoice(id);
    } else {
      id = await createInvoice({ ...payload, payments: [], amount_paid: 0 });
    }
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    logInvoiceSaveError(err, 'create', req.body.action);
    if (id) {
      clearInvoiceCaches();
      res.redirect(`/invoices/${id}?error=${encodeURIComponent('Invoice saved, but submission failed. Review it before submitting again.')}`);
      return;
    }
    renderInvoiceFormError(res, req.body, null, err);
  }
});

router.get('/invoices', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const [result, warehouses] = await Promise.all([
      cachedInvoiceList({ ...req.query, allowedGroups: selectedCategories(req.currentUser, 'customers'),
        ownerId: voucherOwnerId(req.currentUser), ownerEmployeeId: voucherEmployeeId(req.currentUser) }),
      invoiceWarehouseOptions(req.currentUser),
    ]);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoices', {
      invoices: result.rows,
      pagination: result.pagination,
      query: req.query,
      search,
      warehouses,
      money,
    });
  } catch (err) {
    next(err);
  }
});

async function invoiceReportOptions(req, res) {
  return {
    ...req.query,
    savedColumns: await loadSavedColumns(req.currentUser.id),
    allowedGroups: selectedCategories(req.currentUser, 'customers'),
    ownerId: voucherOwnerId(req.currentUser),
    ownerEmployeeId: voucherEmployeeId(req.currentUser),
    allowedWarehouses: allowedNamedListValues(req.currentUser, 'warehouses'),
    deniedWarehouses: deniedNamedListValues(req.currentUser, 'warehouses'),
    canViewProfit: res.locals.can('reports.gross-profit.view'),
  };
}

router.get('/invoices/report', async (req, res, next) => {
  try {
    const [report, warehouses] = await Promise.all([
      invoiceReportOptions(req, res).then(invoiceReport),
      invoiceWarehouseOptions(req.currentUser),
    ]);
    res.render('invoice-report', {
      report,
      warehouses,
      query: new URLSearchParams(req.originalUrl.split('?')[1] || ''),
      money,
      columnsNotice: req.query.columns_saved === '1' ? 'Default columns saved.'
        : req.query.columns_reset === '1' ? 'App default columns restored.' : null,
    });
  } catch (err) {
    next(err);
  }
});

function reportColumnsRedirect(body, notice) {
  const params = new URLSearchParams();
  for (const key of ['q', 'from', 'to', 'status', 'warehouse', 'item', 'category']) {
    if (typeof body[key] === 'string' && body[key].trim()) params.set(key, body[key].trim());
  }
  params.set(notice, '1');
  return `/invoices/report?${params}`;
}

router.post('/invoices/report/columns', async (req, res, next) => {
  try {
    const selected = validateSavedColumns(req.body.columns, res.locals.can('reports.gross-profit.view'));
    await saveDefaultColumns(req.currentUser.id, selected);
    res.redirect(303, reportColumnsRedirect(req.body, 'columns_saved'));
  } catch (err) { next(err); }
});

router.post('/invoices/report/columns/reset', async (req, res, next) => {
  try {
    await resetDefaultColumns(req.currentUser.id);
    res.redirect(303, reportColumnsRedirect(req.body, 'columns_reset'));
  } catch (err) { next(err); }
});

router.get('/invoices/report/export', async (req, res, next) => {
  try {
    const options = await invoiceReportOptions(req, res);
    let page = 1;
    let report = await invoiceReport({ ...options, exportPage: true, page });
    const shownColumns = report.columns.filter((column) => report.selectedColumns.includes(column.key));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sales-invoices-report.csv"',
      'Cache-Control': 'private, no-store',
    });
    res.write(`\uFEFF${csvLine(shownColumns.map((column) => column.label))}`);
    while (!res.destroyed) {
      for (const row of report.rows) {
        if (res.destroyed) return;
        if (!res.write(csvLine(shownColumns.map((column) => row[column.key])))) {
          await new Promise((resolve) => {
            const resume = () => { res.off('drain', resume); res.off('close', resume); resolve(); };
            res.once('drain', resume);
            res.once('close', resume);
          });
        }
      }
      if (report.rows.length < EXPORT_PAGE_SIZE) break;
      page += 1;
      report = await invoiceReport({ ...options, exportPage: true, page });
    }
    if (!res.destroyed) res.end();
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else next(err);
  }
});

async function invoiceWarehouseOptions(user) {
  const [usedWarehouses, masterRows] = await Promise.all([
    invoiceWarehouses().catch(() => []),
    masterWarehouses({ limit: 200, ...warehouseAccessOptions(user) }).catch(() => []),
  ]);
  return [...new Set([
    ...usedWarehouses,
    ...masterRows.map((row) => row.warehouse || row).filter(Boolean),
  ])].filter((name) => warehouseAllowed(user, name)).sort();
}

router.get('/invoices/:id/edit', async (req, res, next) => {
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

router.get('/invoices/:id/duplicate', async (req, res, next) => {
  try {
    const { invoice } = await loadInvoice(req.params.id);
    const duplicate = duplicateInvoiceFormState(invoice, {
      invoiceDate: currentPostingDate(),
      postingTime: currentPostingTime(),
    });
    duplicate.items = await Promise.all(duplicate.items.map(async (item) => ({
      ...item,
      warehouse: duplicate.invoice.warehouse,
      stock_at_sale: normalizeStockQuantity((await localStockQuantity(
        item.item_code, duplicate.invoice.warehouse,
      )).quantity),
    })));
    res.render('new-invoice', {
      ...duplicate,
      duplicateOf: invoice.invoice_no,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/invoices/:id/posting-time', async (req, res, next) => {
  try {
    await updateVoucherPostingTime('sales', req.params.id, req.body.posting_time);
    clearInvoiceCaches();
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    if (err.status === 400) return res.redirect(303, `/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/invoices/:id/non-system-invoice', async (req, res, next) => {
  try {
    await updateInvoiceNonSystemNumber(req.params.id, req.body.non_system_invoice);
    clearInvoiceCaches();
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    if (err.status === 400) return res.redirect(303, `/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/invoices/:id', async (req, res, next) => {
  try {
    const payload = await buildInvoicePayload(req.body, req.currentUser);
    const action = String(req.body.action || '').trim();
    if (action === 'cash_sale') requireReceiptAccount(req.currentUser, req.body.cash_sale_account_id);
    if (action === 'cash_sale' || action === 'submit_invoice') {
      await validateDbItems(payload.items, payload.warehouse, { checkStock: true });
    }
    const id = await updateInvoice(req.params.id, { ...payload, payments: [], amount_paid: 0 });
    if (action === 'cash_sale') {
      const payment = cashSalePayment(payload, req.body);
      await submitCashSaleInvoice(id, payment);
    } else if (action === 'submit_invoice') {
      await submitInvoice(id);
    }
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    logInvoiceSaveError(err, 'edit', req.body.action);
    try {
      const savedInvoice = await findInvoice(req.params.id);
      if (!savedInvoice || (savedInvoice.docstatus || 'submitted') !== 'draft') {
        next(err);
        return;
      }
      renderInvoiceFormError(res, req.body, savedInvoice, err);
    } catch (loadErr) {
      // The store may still be unavailable; keep the user's edits without
      // requiring another successful read just to display the form.
      renderInvoiceFormError(res, req.body, { id: req.params.id, invoice_no: req.params.id }, err);
    }
  }
});

router.post('/invoices/:id/submit', async (req, res, next) => {
  try {
    const invoice = await findInvoice(req.params.id);
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    requireInvoicePriceList(req.currentUser, invoice.price_list);
    const warehouse = invoice.items && invoice.items[0] ? invoice.items[0].warehouse : '';
    await validateDbItems(invoice.items, warehouse, { checkStock: true });
    const id = await submitInvoice(req.params.id);
    clearInvoiceCaches();
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

router.post('/invoices/:id/submit-cash-sale', async (req, res, next) => {
  try {
    requireReceiptAccount(req.currentUser, req.body.cash_sale_account_id);
    const invoice = await findInvoice(req.params.id);
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    requireInvoicePriceList(req.currentUser, invoice.price_list);
    const warehouse = invoice.items && invoice.items[0] ? invoice.items[0].warehouse : '';
    await validateDbItems(invoice.items, warehouse, { checkStock: true });
    const amount = Math.round(Number(invoice.total || 0));
    if (amount <= 0) {
      const err = new Error('Invoice total must be greater than zero.');
      err.status = 400;
      throw err;
    }
    const id = await submitCashSaleInvoice(req.params.id, {
      payment_date: req.body.payment_date || invoice.invoice_date || todayString(),
      amount,
      account_id: req.body.cash_sale_account_id,
      reference: req.body.cash_sale_reference || '',
      notes: req.body.cash_sale_notes || 'Cash sale',
    });
    clearInvoiceCaches();
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
    if (err.status === 400) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

router.post('/invoices/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelInvoice(req.params.id);
    clearInvoiceCaches();
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (err.status === 400) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

router.get('/invoices/payments/:id', async (req, res, next) => {
  try {
    const invoiceId = await invoiceForPayment(req.params.id);
    res.redirect(`/invoices/${invoiceId}`);
  } catch (err) { next(err); }
});

router.get('/invoices/payments/:id/drawer', async (req, res, next) => {
  try {
    const invoiceId = await invoiceForPayment(req.params.id);
    const data = await loadInvoice(invoiceId);
    const payment = (data.invoice.payments || []).find((row) => Number(row.payment_record_id) === Number(req.params.id));
    if (!payment) {
      const err = new Error('Invoice payment not found.');
      err.status = 404;
      throw err;
    }
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoice-payment-drawer', { invoice: data.invoice, payment, money });
  } catch (err) { next(err); }
});

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice', { ...data, today: todayString(), money, error: req.query.error || null });
  } catch (err) {
    next(err);
  }
});

router.post('/invoices/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('sales', req.params.id, { allowCancelled: req.currentUser.role === 'admin' }); clearInvoiceCaches(); res.redirect(303, '/invoices'); }
  catch (error) { next(error); }
});

router.get('/invoices/:id/drawer', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    const returnTo = typeof req.query.return_to === 'string' && req.query.return_to.startsWith('/invoices?')
      ? req.query.return_to
      : '/invoices';
    res.set('Cache-Control', 'private, max-age=10');
    res.render('invoice-drawer', {
      ...data,
      today: todayString(),
      money,
      error: req.query.error || null,
      returnTo,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/invoices/:id/payments', async (req, res, next) => {
  try {
    requireReceiptAccount(req.currentUser, req.body.account_id);
    const id = await addInvoicePayment(req.params.id, {
      payment_date: req.body.payment_date,
      amount: req.body.amount,
      account_id: req.body.account_id,
      reference: req.body.reference,
      notes: req.body.notes,
    });
    clearInvoiceCaches();
    res.redirect(paymentReturnPath(req.body.return_to, id));
  } catch (err) {
    if (err.status === 400) {
      const returnPath = paymentReturnPath(req.body.return_to, req.params.id);
      res.redirect(`${returnPath}${returnPath.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

router.post('/invoices/:id/payments/:paymentId', async (req, res, next) => {
  res.status(405).send('Payments cannot be edited. Cancel the payment and record a new one.');
});

router.post('/invoices/:id/payments/:paymentId/cancel', async (req, res, next) => {
  try {
    const id = await cancelInvoicePayment(req.params.id, req.params.paymentId);
    clearInvoiceCaches();
    res.redirect(paymentReturnPath(req.body.return_to, id));
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      res.redirect(`/invoices/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      return;
    }
    next(err);
  }
});

router.get('/invoices/:id/print', async (req, res, next) => {
  try {
    const data = await loadInvoice(req.params.id);
    res.render('invoice-print', { ...data, money });
  } catch (err) {
    next(err);
  }
});

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

    const dbItem = await findDbItem(itemCode);
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

async function findDbItem(itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) {
    return null;
  }
  return findMasterItem(code);
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
  return { invoice, items: invoice.items || [], company: await getCompanyInformation() };
}

function renderInvoiceFormError(res, body, savedInvoice, err) {
  const status = err instanceof SyntaxError ? 400 : err.status || 500;
  res.status(status).render('new-invoice', {
    ...invoiceFormState(body, savedInvoice),
    stockWarning: err.stockWarning || null,
    formError: status < 500 ? (err instanceof SyntaxError ? 'Could not read the invoice items. Review them and try again.' : err.message) : 'Could not save the invoice. Please try again.',
  });
}

function logInvoiceSaveError(err, operation, action) {
  if ((err.status || 500) < 500) return;
  console.error('invoice_save_error', {
    operation,
    action: String(action || 'save_draft'),
    code: err.code,
    message: err.message,
    stack: err.stack,
  });
}

async function buildInvoicePayload(body, user) {
  const payload = {
    invoice_date: body.invoice_date,
    posting_time: body.posting_time,
    due_date: body.due_date,
    non_system_invoice: body.ext_invoice ?? body.non_system_invoice,
    customer_id: body.customer_id,
    customer_name: String(body.customer_name || '').trim(),
    customer_phone: String(body.customer_phone || '').trim(),
    price_list: String(body.price_list || '').trim(),
    cost_center: String(body.cost_center || '').trim(),
    invoicer_id: String(body.invoicer_id || '').trim(),
    invoicer: String(body.invoicer || '').trim(),
    warehouse: String(body.warehouse || '').trim(),
    notes: String(body.notes || '').trim(),
    discount_amount: body.discount_amount,
    tax_amount: body.tax_amount,
    amount_paid: body.amount_paid,
    items: JSON.parse(body.items_json || '[]'),
    payments: JSON.parse(body.payments_json || '[]'),
  };
  if (Array.isArray(payload.payments)) {
    for (const payment of payload.payments) requireReceiptAccount(user, payment?.account_id);
  }
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
  const priceList = await findMasterRecord('price-lists', payload.price_list);
  if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
    const err = new Error('Select an active UGX selling price list.'); err.status = 400; throw err;
  }
  requireInvoicePriceList(user, payload.price_list);
  if (payload.cost_center) {
    const costCenter = await findMasterRecord('cost_centers', payload.cost_center);
    if (!costCenter || costCenter.is_group || costCenter.disabled === '1') {
      const err = new Error('Select an enabled cost center.'); err.status = 400; throw err;
    }
  }
  const invoicer = payload.invoicer_id && await findMasterRecord('employees', payload.invoicer_id);
  if (!invoicer || (invoicer.disabled === '1'
      && payload.invoicer_id !== user?.record_access?.employee_id)) {
    const err = new Error('Select an invoicer from the employee list.'); err.status = 400; throw err;
  }
  payload.invoicer = invoicer.employee_name;
  payload.items = await validateDbItems(payload.items, payload.warehouse);
  return payload;
}

function cashSalePayment(payload, body = {}) {
  const amount = invoicePayloadTotal(payload);
  if (amount <= 0) {
    const err = new Error('Cash sale total must be greater than zero.');
    err.status = 400;
    throw err;
  }
  return {
    payment_date: body.payment_date || payload.invoice_date || todayString(),
    amount,
    account_id: body.cash_sale_account_id,
    reference: body.cash_sale_reference || '',
    notes: body.cash_sale_notes || 'Cash sale',
  };
}

function invoicePayloadTotal(payload) {
  return invoiceMath.grandTotal(payload.items, payload.discount_amount, payload.tax_amount);
}

module.exports = router;
