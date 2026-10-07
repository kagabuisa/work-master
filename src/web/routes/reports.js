'use strict';
// /reports routes. Mounted at /reports by server.js.
const express = require('express');
const { dailyActivityReport, dailyActivityVoucher } = require('../daily-activity');
const { voucherOwnerId, voucherEmployeeId } = require('../../voucher-ownership');
const { accountAccessOptions } = require('../helpers');
const { selectedCategories } = require('../../access');
const { money, todayString } = require('../format');
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

const router = express.Router();

router.get('/daily-activity', async (req, res, next) => {
  try {
    const report = await dailyActivityReport(req.query);
    res.render('daily-activity', { report, query: req.query, money });
  } catch (err) { next(err); }
});

router.get('/daily-activity/:name', async (req, res, next) => {
  try {
    const voucher = await dailyActivityVoucher(req.params.name);
    if (!voucher) { const error = new Error('Daily Activity Report voucher not found.'); error.status = 404; throw error; }
    res.render('daily-activity-voucher', { voucher, money });
  } catch (err) { next(err); }
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
      voucher_type: req.query.voucher_type,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      page_size: req.query.page_size,
    };
    const [report, filterOptions] = await Promise.all([
      generalLedgerReport(filters, { ownerId: voucherOwnerId(req.currentUser),
        ownerEmployeeId: voucherEmployeeId(req.currentUser),
        customerGroups: selectedCategories(req.currentUser, 'customers'),
        supplierTypes: selectedCategories(req.currentUser, 'suppliers'),
        ...accountAccessOptions(req.currentUser) }),
      generalLedgerFilterOptions(),
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
    res.render('trial-balance', { report, money });
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
    res.render('profit-and-loss', { report, money });
  } catch (err) {
    next(err);
  }
});

router.get('/balance-sheet', async (req, res, next) => {
  try {
    const report = await balanceSheetReport({
      as_of: req.query.as_of,
    });
    res.render('balance-sheet', { report, money });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
