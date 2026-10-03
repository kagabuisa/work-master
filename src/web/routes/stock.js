'use strict';
// /stock routes. Mounted at /stock by server.js.
const express = require('express');
const { money, todayString } = require('../format');
const { currentPostingDate } = require('../../posting-time');
const { parseStockEntryPayload } = require('../parsers');
const {
  stockSummary,
  stockBalances,
  createStockEntry,
  loadStockEntry,
  updateStockEntry,
  updateStockEntrySupplierInfo,
  cancelStockEntry,
  updateVoucherPostingTime,
  deleteDraftVoucher,
} = require('../../store');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [summary, balances] = await Promise.all([
      stockSummary(),
      stockBalances({
        search: req.query.q,
        warehouse: req.query.warehouse,
        page: req.query.page,
        page_size: req.query.page_size,
      }),
    ]);
    res.render('stock', {
      summary,
      balances,
      pagination: balances.pagination,
      query: req.query,
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

router.get('/entries/new', (req, res) => {
  const defaultEntryType = req.query.entry_type === 'purchase' ? 'purchase' : 'opening';
  res.render('stock-entry', { today: currentPostingDate(), error: null, entry: null, items: [], defaultEntryType });
});

router.post('/entries', async (req, res, next) => {
  try {
    const id = await createStockEntry(parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?voucher_id=${id}`);
  } catch (err) {
    res.status(err.status || 500).render('stock-entry', {
      today: req.body.posting_date || todayString(),
      postingTime: req.body.posting_time,
      error: err.message || 'Could not save stock entry.',
      entry: null,
      items: [],
    });
  }
});

router.get('/entries/:id/edit', async (req, res, next) => {
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

router.get('/entries/:id', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    res.render('stock-entry', {
      today: data.entry.posting_date,
      error: req.query.error || null,
      readOnly: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/entries/:id/posting-time', async (req, res, next) => {
  try {
    await updateVoucherPostingTime('stock', req.params.id, req.body.posting_time);
    res.redirect(303, `/stock/entries/${req.params.id}`);
  } catch (err) {
    if (err.status === 400) return res.redirect(303, `/stock/entries/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/entries/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('stock', req.params.id); res.redirect(303, '/stock'); }
  catch (error) { next(error); }
});

router.get('/entries/:id/drawer', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('stock-entry-drawer', { ...data, money });
  } catch (err) {
    next(err);
  }
});

router.post('/entries/:id', async (req, res, next) => {
  try {
    const id = await updateStockEntry(req.params.id, parseStockEntryPayload(req.body));
    res.redirect(`/reports/stock-ledger?status=${req.body.action === 'save_draft' ? 'draft' : 'submitted'}&voucher_id=${id}`);
  } catch (err) {
    try {
      const data = await loadStockEntry(req.params.id);
      res.status(err.status || 500).render('stock-entry', {
        today: req.body.posting_date || data.entry.posting_date || todayString(),
        postingTime: req.body.posting_time,
        error: err.message || 'Could not save stock entry.',
        ...data,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

router.post('/entries/:id/supplier', async (req, res, next) => {
  try {
    const supplier = await updateStockEntrySupplierInfo(req.params.id, req.body);
    res.json({ supplier });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save supplier information.' });
  }
});

router.post('/entries/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelStockEntry(req.params.id, req.body);
    res.json({ id, status: 'cancelled' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not cancel stock entry.' });
  }
});

module.exports = router;
