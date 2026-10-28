'use strict';
// /reports routes. Mounted at /reports by server.js.
const express = require('express');
const { dailyActivityReport, dailyActivityVoucher } = require('../daily-activity');
const { localDailyActivityReport, localDailyActivityVoucher } = require('../local-daily-activity');
const { createDailyActivity, dailyActivityFormOptions, UNIT_TYPES, DELIVERY_OPTIONS } = require('../daily-activity-create');
const { voucherOwnerId, voucherEmployeeId } = require('../../voucher-ownership');
const { accountAccessOptions, hrLedgerAccessOptions, warehouseAccessOptions } = require('../helpers');
const { ADMIN_REPORT_SLUGS } = require('../../report-permissions');
const { selectedCategories } = require('../../access');
const { money, financialMoney, todayString } = require('../format');
const {
  debtorReport,
  stockLedgerReport,
  stockLedgerVoucherDetails,
  stockMovementReport,
  stockMovementDetails,
  grossProfitReport,
  generalLedgerReport,
  generalLedgerFilterOptions,
  trialBalanceReport,
  profitAndLossReport,
  balanceSheetReport,
  findInvoice,
  getCompanyInformation,
} = require('../../store');

const { sendCustomerStatementPdf } = require('../customer-statement-pdf');
const { sendGeneralLedgerDownload } = require('../ledger-export-jobs');
const router = express.Router();
router.use((req, res, next) => {
  if (ADMIN_REPORT_SLUGS.has(req.path.split('/')[1]) && req.currentUser?.role !== 'admin') {
    return res.status(403).send('Only administrators can view this report.');
  }
  next();
});

function dailyActivityError(err, req, res, next) {
  if (err.code !== 'DAILY_ACTIVITY_SOURCE_UNAVAILABLE') return next(err);
  console.error('daily_activity_source_unavailable', {
    path: req.path, code: err.cause?.code || 'MISSING_CONFIGURATION',
  });
  res.status(503).render('error', { status: 503, message: err.message });
}

router.get('/daily-activity', async (req, res, next) => {
  try {
    const report = await localDailyActivityReport(req.query, req.currentUser);
    res.render('daily-activity', { report, query: req.query, money });
  } catch (err) { dailyActivityError(err, req, res, next); }
});

function dailyActivityForm(res, record, options, error = '') {
  return res.render('daily-activity-form', { record, options, error, unitTypes: UNIT_TYPES,
    deliveryOptions: DELIVERY_OPTIONS });
}

router.get('/daily-activity/new', async (req, res, next) => {
  try {
    const options = await dailyActivityFormOptions(req.currentUser);
    dailyActivityForm(res, { date: todayString(), unit_type: 'Shop', sales: '0', expense: '0',
      packages_received: '0', leads: '0', delivery_differences: 'No' }, options);
  } catch (err) { dailyActivityError(err, req, res, next); }
});

router.post('/daily-activity', async (req, res, next) => {
  try {
    const voucher = await createDailyActivity(req.body, req.currentUser);
    res.redirect(303, `/reports/daily-activity/${encodeURIComponent(voucher.name)}`);
  } catch (err) {
    if ([400, 403, 503].includes(err.status)) {
      const options = await dailyActivityFormOptions(req.currentUser).catch(() => ({ shops: [], warehouses: [] }));
      return dailyActivityForm(res.status(err.status), req.body, options, err.message);
    }
    next(err);
  }
});

router.get('/daily-activity/reference', async (req, res, next) => {
  try {
    const report = await dailyActivityReport(req.query);
    report.source = 'erpnext';
    report.basePath = '/reports/daily-activity/reference';
    report.rows = report.rows.map(row => ({ ...row, href: `${report.basePath}/${encodeURIComponent(row.name)}` }));
    res.render('daily-activity', { report, query: req.query, money });
  } catch (err) { dailyActivityError(err, req, res, next); }
});

router.get('/daily-activity/reference/:name', async (req, res, next) => {
  try {
    const voucher = await dailyActivityVoucher(req.params.name);
    if (!voucher) return res.status(404).render('error', { status: 404, message: 'ERPNext reference voucher not found.' });
    voucher.source = 'erpnext';
    res.render('daily-activity-voucher', { voucher, money });
  } catch (err) { dailyActivityError(err, req, res, next); }
});

router.get('/daily-activity/:name', async (req, res, next) => {
  try {
    const voucher = await localDailyActivityVoucher(req.params.name, req.currentUser);
    if (!voucher) { const error = new Error('Daily Activity Report voucher not found.'); error.status = 404; throw error; }
    res.render('daily-activity-voucher', { voucher, money });
  } catch (err) { dailyActivityError(err, req, res, next); }
});

async function loadInvoice(id) {
  const invoice = await findInvoice(id);
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  return { invoice, items: invoice.items || [], company: await getCompanyInformation() };
}

router.get('/debtors', async (req, res, next) => {
  try {
    const report = await debtorReport({
      search: req.query.q,
      customer: req.query.customer,
      from: req.query.from,
      to: req.query.to,
      statementFrom: req.query.statement_from,
      statementTo: req.query.statement_to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    if (req.query.format === 'pdf') {
      if (!req.query.customer || !report.selected) {
        return res.status(404).send('Customer statement not found.');
      }
      return await sendCustomerStatementPdf(res, report, await getCompanyInformation(), res.locals.formatDate);
    }
    const paymentData = req.query.view === 'payment' && report.paymentInvoiceId
      ? await loadInvoice(report.paymentInvoiceId)
      : null;
    res.render('debtor-report', {
      report,
      paymentData,
      query: req.query,
      today: todayString(),
      money,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/stock-ledger', async (req, res, next) => {
  try {
    const report = await stockLedgerReport({
      ...warehouseAccessOptions(req.currentUser),
      ownerId: voucherOwnerId(req.currentUser),
      ownerEmployeeId: voucherEmployeeId(req.currentUser),
      search: req.query.q,
      warehouse: req.query.warehouse,
      entry_type: req.query.entry_type,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('stock-ledger', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

router.get('/stock-ledger/vouchers/:type/:id', async (req, res, next) => {
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

router.get('/stock-movement', async (req, res, next) => {
  try {
    const report = await stockMovementReport({
      ...warehouseAccessOptions(req.currentUser),
      ownerId: voucherOwnerId(req.currentUser),
      ownerEmployeeId: voucherEmployeeId(req.currentUser),
      search: req.query.q,
      warehouse: req.query.warehouse,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('stock-movement', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

router.get('/stock-movement/details', async (req, res, next) => {
  try {
    const details = await stockMovementDetails({
      ...warehouseAccessOptions(req.currentUser),
      ownerId: voucherOwnerId(req.currentUser),
      ownerEmployeeId: voucherEmployeeId(req.currentUser),
      item_code: req.query.item_code,
      warehouse: req.query.warehouse,
      direction: req.query.direction,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(details);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load stock movement details.' });
  }
});

router.get('/gross-profit', async (req, res, next) => {
  try {
    const report = await grossProfitReport({
      ownerId: voucherOwnerId(req.currentUser),
      ownerEmployeeId: voucherEmployeeId(req.currentUser),
      search: req.query.q,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    });
    res.render('gross-profit', { report, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.q,
      account: req.query.account,
      party: req.query.party,
      party_scope: req.query.party_scope === 'lines' ? 'lines' : 'related',
      group_by: req.query.group_by,
      voucher_id: req.query.voucher_id,
      voucher_type: req.query.voucher_type,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    };
    const format = String(req.query.format || '').toLowerCase();
    if (format && !['csv', 'xlsx', 'pdf'].includes(format)) {
      const error = new Error('Choose CSV, Excel, or PDF.'); error.status = 400; throw error;
    }
    const access = { ...hrLedgerAccessOptions(req.currentUser), ownerId: voucherOwnerId(req.currentUser),
      ownerEmployeeId: voucherEmployeeId(req.currentUser),
      customerGroups: selectedCategories(req.currentUser, 'customers'),
      supplierTypes: selectedCategories(req.currentUser, 'suppliers'),
      ...accountAccessOptions(req.currentUser) };
    if (format) return await sendGeneralLedgerDownload(req, res, filters, access, format);
    const [report, filterOptions] = await Promise.all([
      generalLedgerReport(filters, access), generalLedgerFilterOptions(),
    ]);
    res.render('general-ledger', { report, filterOptions, query: req.query, money });
  } catch (err) {
    next(err);
  }
});

router.get('/trial-balance', async (req, res, next) => {
  try {
    const report = await trialBalanceReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('trial-balance', { report, money: financialMoney });
  } catch (err) {
    next(err);
  }
});

router.get('/profit-and-loss', async (req, res, next) => {
  try {
    const report = await profitAndLossReport({
      from: req.query.from,
      to: req.query.to,
    });
    res.render('profit-and-loss', { report, money: financialMoney });
  } catch (err) {
    next(err);
  }
});

router.get('/balance-sheet', async (req, res, next) => {
  try {
    const report = await balanceSheetReport({
      as_of: req.query.as_of,
    });
    res.render('balance-sheet', { report, money: financialMoney });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
