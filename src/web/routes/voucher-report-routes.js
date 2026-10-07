'use strict';

const { selectedCategories, allowedNamedListValues, deniedNamedListValues } = require('../../access');
const { purchaseMoney, money } = require('../format');
const { reportConfig, voucherReport, validateColumns, loadSavedColumns,
  saveColumns, resetColumns, columnsRedirect, exportCsv } = require('../voucher-report');
const { voucherOwnerId } = require('../../voucher-ownership');

function registerVoucherReportRoutes(router, kind) {
  const config = reportConfig(kind);
  const path = `${config.basePath}/report`;
  const optionsFor = async (req) => ({
    ...req.query,
    ownerId: voucherOwnerId(req.currentUser),
    savedColumns: await loadSavedColumns(config, req.currentUser.id),
    ...kind === 'journals' ? {
      allowedAccounts: allowedNamedListValues(req.currentUser, 'accounts'),
      deniedAccounts: deniedNamedListValues(req.currentUser, 'accounts'),
    } : {
      allowedTypes: selectedCategories(req.currentUser, 'suppliers'),
      allowedWarehouses: allowedNamedListValues(req.currentUser, 'warehouses'),
      deniedWarehouses: deniedNamedListValues(req.currentUser, 'warehouses'),
    },
  });

  router.get(path, async (req, res, next) => {
    try {
      const report = await voucherReport(kind, await optionsFor(req));
      res.render('voucher-report', {
        config, report, money: kind === 'journals' ? money : purchaseMoney,
        query: new URLSearchParams(req.originalUrl.split('?')[1] || ''),
        columnsNotice: req.query.columns_saved === '1' ? 'Default columns saved.'
          : req.query.columns_reset === '1' ? 'App default columns restored.' : null,
      });
    } catch (err) { next(err); }
  });

  router.post(`${path}/columns`, async (req, res, next) => {
    try {
      await saveColumns(config, req.currentUser.id, validateColumns(config, req.body.columns));
      res.redirect(303, columnsRedirect(config, req.body, 'columns_saved'));
    } catch (err) { next(err); }
  });

  router.post(`${path}/columns/reset`, async (req, res, next) => {
    try {
      await resetColumns(config, req.currentUser.id);
      res.redirect(303, columnsRedirect(config, req.body, 'columns_reset'));
    } catch (err) { next(err); }
  });

  router.get(`${path}/export`, async (req, res, next) => {
    try { await exportCsv(res, config, await optionsFor(req)); }
    catch (err) { if (res.headersSent) res.destroy(err); else next(err); }
  });
}

module.exports = { registerVoucherReportRoutes };
