'use strict';
// /stock routes. Mounted at /stock by server.js.
const express = require('express');
const multer = require('multer');
const { createCountSheet, readCountSheet, countSheetFilename, MAX_COUNT_FILE_BYTES } = require('../../stock-count-sheet');
const { can } = require('../../authorize');
const { withPostgresTransaction } = require('../../core');
const { listAttachments, saveAttachments, findAttachment, deleteAttachment, MAX_SCAN_BYTES, MAX_SCAN_FILES } = require('../../reconciliation-attachments');
const { voucherOwnedByUser } = require('../../voucher-ownership');
const { money, todayString } = require('../format');
const { currentPostingDate, currentPostingTime } = require('../../posting-time');
const { parseStockEntryPayload } = require('../parsers');
const { applyReconciliationRatePolicy } = require('../reconciliation-rates');
const { warehouseAllowed } = require('../../access');
const { warehouseAccessOptions } = require('../helpers');
const { voucherOwnerId } = require('../../voucher-ownership');
const { csvLine } = require('../invoice-report');
const {
  stockSummary,
  stockBalances,
  listStockEntries,
  createStockEntry,
  loadStockEntry,
  updateStockEntry,
  updateStockEntrySupplierInfo,
  cancelStockEntry,
  updateVoucherPostingTime,
  deleteDraftVoucher,
  getPostgresPool,
} = require('../../store');

const router = express.Router();

function reconciliationView(entry = null, items = [], error = null, warehouse = '', balances = []) {
  return { entry, items, error, balances, warehouse: warehouse || items[0]?.warehouse || '',
    today: currentPostingDate(), postingTime: currentPostingTime() };
}

async function reconciliationBalances(items) {
  if (!items.length) return [];
  const warehouse = items[0].warehouse;
  const codes = items.map((item) => item.item_code);
  const { rows } = await getPostgresPool().query(`SELECT item_code, quantity::float, valuation_rate::float
    FROM app_stock_balances WHERE warehouse = $1 AND item_code = ANY($2::text[])`, [warehouse, codes]);
  return rows;
}

async function loadReconciliation(id) {
  const data = await loadStockEntry(id);
  if (data.entry.entry_type !== 'reconciliation') {
    const err = new Error('Stock reconciliation not found.'); err.status = 404; throw err;
  }
  return data;
}

async function reconciliationPayload(body, user, existingItems = []) {
  const warehouse = String(body.warehouse || '').trim();
  if (!warehouse) { const err = new Error('Choose a warehouse.'); err.status = 400; throw err; }
  const warehouseResult = await getPostgresPool().query(`SELECT 1 FROM app_master_warehouses
    WHERE warehouse = $1 AND disabled = false AND is_group = false`, [warehouse]);
  if (!warehouseResult.rows.length) {
    const err = new Error('Choose an active warehouse.'); err.status = 400; throw err;
  }
  const payload = parseStockEntryPayload(body);
  payload.entry_type = 'reconciliation';
  payload.items = payload.items.filter((item) => String(item.item_code || '').trim())
    .map((item) => ({ ...item, warehouse, target_warehouse: '' }));
  if (!payload.items.length) { const err = new Error('Add at least one item to count.'); err.status = 400; throw err; }
  const codes = [...new Set(payload.items.map((item) => String(item.item_code).trim()))];
  const itemResult = await getPostgresPool().query(`SELECT item_code, item_name FROM app_master_items
    WHERE item_code = ANY($1::text[]) AND disabled = false`, [codes]);
  const names = new Map(itemResult.rows.map((item) => [item.item_code, item.item_name]));
  for (const item of payload.items) {
    if (!names.has(String(item.item_code).trim())) {
      const err = new Error(`Item ${item.item_code} is not active.`); err.status = 400; throw err;
    }
    item.item_name = names.get(String(item.item_code).trim());
  }
  if (user?.role !== 'admin') {
    const { rows: balances } = await getPostgresPool().query(`SELECT item_code, valuation_rate::float
      FROM app_stock_balances WHERE warehouse = $1 AND item_code = ANY($2::text[])`, [warehouse, codes]);
    payload.items = applyReconciliationRatePolicy(payload.items, user, balances, existingItems);
  }
  return payload;
}

function countSheetError(message, status = 400) {
  const error = new Error(message); error.status = status; return error;
}

async function countSheetContext(req, importing = false) {
  const source = importing ? req.body || {} : req.query;
  const warehouse = String(source.warehouse || '').trim();
  if (!warehouse || !warehouseAllowed(req.currentUser, warehouse)) throw countSheetError('Choose a permitted warehouse.', 403);
  const { rows } = await getPostgresPool().query(`SELECT 1 FROM app_master_warehouses
    WHERE warehouse=$1 AND disabled=false AND is_group=false`, [warehouse]);
  if (!rows.length) throw countSheetError('Choose an active warehouse.');
  let data = null;
  if (source.voucher_id) {
    if (!/^\d+$/.test(String(source.voucher_id)) || !await voucherOwnedByUser(req.currentUser, 'stock', source.voucher_id)) {
      throw countSheetError('This reconciliation is not available to your account.', 403);
    }
    data = await loadReconciliation(source.voucher_id);
    if (data.items.some((item) => item.warehouse !== warehouse)) throw countSheetError('The count sheet must use the voucher warehouse.');
    if (importing && (!can(req.currentUser, 'vouchers.stock.edit') || data.entry.docstatus !== 'draft')) {
      throw countSheetError('Only an editable draft reconciliation can receive a count sheet.', 403);
    }
  } else if (importing && !can(req.currentUser, 'vouchers.stock.create')) {
    throw countSheetError('Stock Entry Create permission is required for a new count.', 403);
  }
  return { warehouse, data };
}

router.get('/reconciliations/count-sheet-template', async (req, res, next) => {
  try {
    const { warehouse, data } = await countSheetContext(req);
    const codes = (data?.items || []).map((item) => item.item_code);
    const { rows } = await getPostgresPool().query(`SELECT item.item_code, item.item_name,
      COALESCE(balance.quantity, 0)::float AS quantity
      FROM app_master_items item
      LEFT JOIN app_stock_balances balance ON balance.item_code=item.item_code AND balance.warehouse=$1
      WHERE item.disabled=false AND (balance.quantity > 0 OR item.item_code=ANY($2::text[]))
      ORDER BY item.item_name, item.item_code`, [warehouse, codes]);
    const workbook = await createCountSheet(warehouse, rows);
    res.set('Cache-Control', 'private, no-store');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.attachment(countSheetFilename(data?.entry.entry_no, warehouse));
    res.send(workbook);
  } catch (error) { next(error); }
});

const countSheetUpload = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COUNT_FILE_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 500 },
  fileFilter(_req, file, callback) {
    callback(/\.xlsx$/i.test(file.originalname) ? null : countSheetError('Upload an Excel .xlsx count sheet.'), /\.xlsx$/i.test(file.originalname));
  },
}).single('count_sheet');

router.post('/reconciliations/count-sheet-upload', (req, res) => {
  countSheetUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) throw countSheetError(uploadError.code === 'LIMIT_FILE_SIZE' ? 'Count sheets must be no larger than 5 MB.' : 'Upload one Excel .xlsx count sheet, no larger than 5 MB.');
      if (!req.file) throw countSheetError('Choose an Excel count sheet (.xlsx).');
      const { warehouse, data } = await countSheetContext(req, true);
      const counts = await readCountSheet(req.file?.buffer, warehouse);
      const codes = counts.map((item) => item.item_code);
      const { rows: items } = await getPostgresPool().query(`SELECT item.item_code, item.item_name,
        COALESCE(balance.quantity, 0)::float AS book, COALESCE(balance.valuation_rate, 0)::float AS rate
        FROM app_master_items item
        LEFT JOIN app_stock_balances balance ON balance.item_code=item.item_code AND balance.warehouse=$1
        WHERE item.item_code=ANY($2::text[]) AND item.disabled=false`, [warehouse, codes]);
      const byCode = new Map(items.map((item) => [item.item_code, item]));
      const existing = new Map((data?.items || []).map((item) => [item.item_code, item]));
      const imported = counts.map((count) => {
        const item = byCode.get(count.item_code);
        if (!item) throw countSheetError(`Row ${count.sheet_row}: item ${count.item_code} is unknown or inactive.`);
        return { code: item.item_code, name: item.item_name, book: item.book, counted: count.quantity,
          rate: Number(existing.get(item.item_code)?.valuation_rate || item.rate), bookRate: item.rate };
      });
      res.set('Cache-Control', 'private, no-store');
      res.json({ warehouse, items: imported });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not import the count sheet. Try again.' });
    }
  });
});

router.get('/reconciliations/warehouse-stock', async (req, res, next) => {
  try {
    const warehouse = String(req.query.warehouse || '').trim();
    if (!warehouse || !warehouseAllowed(req.currentUser, warehouse)) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    const { rows } = await getPostgresPool().query(`SELECT item_code, item_name,
      quantity::float, valuation_rate::float, stock_value::float
      FROM app_stock_balances WHERE warehouse = $1 AND quantity > 0
      ORDER BY item_name, item_code`, [warehouse]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/reconciliations', async (req, res, next) => {
  try {
    const result = await listStockEntries({ ...req.query, entry_type: 'reconciliation',
      ownerId: voucherOwnerId(req.currentUser),
      ...warehouseAccessOptions(req.currentUser) });
    res.render('stock-reconciliations', { result, query: req.query });
  } catch (err) { next(err); }
});

router.get('/reconciliations/new', (_req, res) => {
  res.render('stock-reconciliation', reconciliationView());
});

router.post('/reconciliations', async (req, res) => {
  try {
    const id = await createStockEntry(await reconciliationPayload(req.body, req.currentUser));
    res.redirect(303, `/stock/reconciliations/${id}`);
  } catch (err) {
    const items = parseStockEntryPayload(req.body).items;
    res.status(err.status || 500).render('stock-reconciliation', reconciliationView({
      posting_date: req.body.posting_date, posting_time: req.body.posting_time,
      cost_center: req.body.cost_center,
      remarks: req.body.remarks, docstatus: 'draft', entry_type: 'reconciliation',
    }, items, err.message, req.body.warehouse));
  }
});

router.get('/reconciliations/:id/attachments', async (req, res, next) => {
  try {
    await loadReconciliation(req.params.id);
    const files = await listAttachments(getPostgresPool(), req.params.id);
    res.set('Cache-Control', 'private, no-store');
    res.json(files.map((file) => ({ ...file, uploaded_time: res.locals.formatTimestamp(file.uploaded_at) })));
  } catch (error) { next(error); }
});

router.get('/reconciliations/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    await loadReconciliation(req.params.id);
    const file = await findAttachment(getPostgresPool(), req.params.id, req.params.attachmentId);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(file.content_type);
    res.attachment(file.file_name);
    res.send(file.content);
  } catch (error) { next(error); }
});

const scanUpload = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCAN_BYTES, files: MAX_SCAN_FILES, fields: 0, parts: MAX_SCAN_FILES },
}).array('scans', MAX_SCAN_FILES);

function scanResponse(req, res, error, count = 0) {
  if (req.get('accept')?.includes('application/json')) {
    return error ? res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update scanned sheets.' })
      : res.json({ uploaded: count });
  }
  res.redirect(303, `/stock/reconciliations/${req.params.id}${error ? `?error=${encodeURIComponent(error.status ? error.message : 'Could not update scanned sheets.')}` : ''}`);
}

router.post('/reconciliations/:id/attachments', (req, res) => {
  scanUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) throw countSheetError('Upload up to three PDF, JPG, PNG, CSV, or Excel (.xls/.xlsx) sheets, each no larger than 10 MB.');
      await loadReconciliation(req.params.id);
      const count = await withPostgresTransaction((client) => saveAttachments(client, req.params.id, req.files, req.currentUser));
      scanResponse(req, res, null, count);
    } catch (error) { scanResponse(req, res, error); }
  });
});

router.post('/reconciliations/:id/attachments/:attachmentId/delete', async (req, res) => {
  try {
    await loadReconciliation(req.params.id);
    await deleteAttachment(getPostgresPool(), req.params.id, req.params.attachmentId);
    scanResponse(req, res, null);
  } catch (error) { scanResponse(req, res, error); }
});

router.get('/reconciliations/:id/edit', async (req, res, next) => {
  try {
    const data = await loadReconciliation(req.params.id);
    if (data.entry.docstatus !== 'draft') {
      const err = new Error('Draft stock reconciliation not found.'); err.status = 404; throw err;
    }
    res.render('stock-reconciliation', reconciliationView(data.entry, data.items));
  } catch (err) { next(err); }
});

router.get('/reconciliations/:id', async (req, res, next) => {
  try {
    const data = await loadReconciliation(req.params.id);
    const balances = data.entry.docstatus === 'draft' ? await reconciliationBalances(data.items) : [];
    res.render('stock-reconciliation', {
      ...reconciliationView(data.entry, data.items, req.query.error || null, '', balances), readOnly: true,
    });
  } catch (err) { next(err); }
});

router.post('/reconciliations/:id', async (req, res, next) => {
  try {
    const current = await loadReconciliation(req.params.id);
    if (current.entry.docstatus !== 'draft') {
      const err = new Error('Draft stock reconciliation not found.'); err.status = 404; throw err;
    }
    await updateStockEntry(req.params.id, await reconciliationPayload(req.body, req.currentUser, current.items));
    res.redirect(303, `/stock/reconciliations/${req.params.id}`);
  } catch (err) {
    if (err.status === 404) return next(err);
    const items = parseStockEntryPayload(req.body).items;
    res.status(err.status || 500).render('stock-reconciliation', reconciliationView({
      id: Number(req.params.id), entry_no: `REC-${String(req.params.id).padStart(6, '0')}`,
      posting_date: req.body.posting_date, posting_time: req.body.posting_time,
      cost_center: req.body.cost_center,
      remarks: req.body.remarks, docstatus: 'draft', entry_type: 'reconciliation',
    }, items, err.message, req.body.warehouse));
  }
});

router.post('/reconciliations/:id/submit', async (req, res, next) => {
  try {
    const current = await loadReconciliation(req.params.id);
    if (current.entry.docstatus !== 'draft') {
      const err = new Error('Only draft reconciliations can be submitted.'); err.status = 400; throw err;
    }
    await updateStockEntry(req.params.id, {
      entry_type: 'reconciliation', action: 'submit',
      posting_date: current.entry.posting_date, posting_time: current.entry.posting_time,
      cost_center: current.entry.cost_center,
      remarks: current.entry.remarks,
      items: current.items.map((item) => ({
        id: item.id, item_code: item.item_code, item_name: item.item_name,
        warehouse: item.warehouse, quantity: item.quantity, valuation_rate: item.valuation_rate,
      })),
    });
    res.redirect(303, `/stock/reconciliations/${req.params.id}`);
  } catch (err) {
    if (err.status === 404) return next(err);
    if (err.status === 400) return res.redirect(303, `/stock/reconciliations/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/reconciliations/:id/delete', async (req, res, next) => {
  try { await loadReconciliation(req.params.id); await deleteDraftVoucher('stock', req.params.id, { allowCancelled: req.currentUser.role === 'admin' }); res.redirect(303, '/stock'); }
  catch (err) { next(err); }
});

router.post('/reconciliations/:id/cancel', async (req, res, next) => {
  try { await loadReconciliation(req.params.id); await cancelStockEntry(req.params.id, req.body); res.redirect(303, `/stock/reconciliations/${req.params.id}`); }
  catch (err) {
    if (err.status === 400) return res.redirect(303, `/stock/reconciliations/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const options = { search: req.query.q, warehouse: req.query.warehouse, page_size: 200 };
    let page = 1;
    let balances = await stockBalances({ ...options, page });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="stock-balance.csv"',
      'Cache-Control': 'private, no-store',
    });
    res.write(`\uFEFF${csvLine(['Item Code', 'Warehouse', 'Quantity', 'Valuation Rate', 'Stock Value'])}`);
    while (!res.destroyed) {
      for (const row of balances) {
        if (res.destroyed) return;
        if (!res.write(csvLine([row.item_code, row.warehouse, row.quantity, row.valuation_rate, row.stock_value]))) {
          await new Promise((resolve) => {
            const resume = () => { res.off('drain', resume); res.off('close', resume); resolve(); };
            res.once('drain', resume);
            res.once('close', resume);
          });
        }
      }
      if (balances.length < options.page_size) break;
      balances = await stockBalances({ ...options, page: ++page });
    }
    if (!res.destroyed) res.end();
  } catch (err) { next(err); }
});

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

router.get('/entries', async (req, res, next) => {
  try {
    const result = await listStockEntries({ ...req.query, excludeReconciliations: true,
      ownerId: voucherOwnerId(req.currentUser),
      ...warehouseAccessOptions(req.currentUser) });
    res.render('stock-entries', { result, query: req.query });
  } catch (err) { next(err); }
});

router.get('/entries/new', (req, res) => {
  if (req.query.entry_type === 'reconciliation') return res.redirect(302, '/stock/reconciliations/new');
  const defaultEntryType = ['purchase', 'reconciliation'].includes(req.query.entry_type)
    ? req.query.entry_type : 'opening';
  res.render('stock-entry', { today: currentPostingDate(), error: null, entry: null, items: [], defaultEntryType });
});

router.post('/entries', async (req, res, next) => {
  try {
    const payload = req.body.entry_type === 'reconciliation'
      ? await reconciliationPayload(req.body, req.currentUser) : parseStockEntryPayload(req.body);
    const id = await createStockEntry(payload);
    res.redirect(req.body.entry_type === 'reconciliation'
      ? `/stock/reconciliations/${id}` : `/reports/stock-ledger?voucher_id=${id}`);
  } catch (err) {
    if (req.body.entry_type === 'reconciliation') {
      return res.status(err.status || 500).render('stock-reconciliation', reconciliationView({
        posting_date: req.body.posting_date, posting_time: req.body.posting_time,
        cost_center: req.body.cost_center,
        remarks: req.body.remarks, docstatus: 'draft', entry_type: 'reconciliation',
      }, parseStockEntryPayload(req.body).items, err.message, req.body.warehouse));
    }
    res.status(err.status || 500).render('stock-entry', {
      today: req.body.posting_date || todayString(),
      postingTime: req.body.posting_time,
      error: err.message || 'Could not save stock entry.',
      entry: null,
      attemptedCostCenter: req.body.cost_center || '',
      items: [],
    });
  }
});

router.get('/entries/:id/edit', async (req, res, next) => {
  try {
    const data = await loadStockEntry(req.params.id);
    if (data.entry.entry_type === 'reconciliation') return res.redirect(302, `/stock/reconciliations/${req.params.id}/edit`);
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
    if (data.entry.entry_type === 'reconciliation') return res.redirect(302, `/stock/reconciliations/${req.params.id}`);
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
  try { await deleteDraftVoucher('stock', req.params.id, { allowCancelled: req.currentUser.role === 'admin' }); res.redirect(303, '/stock'); }
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
    const current = await loadStockEntry(req.params.id);
    const payload = current.entry.entry_type === 'reconciliation' || req.body.entry_type === 'reconciliation'
      ? await reconciliationPayload(req.body, req.currentUser, current.items) : parseStockEntryPayload(req.body);
    const id = await updateStockEntry(req.params.id, payload);
    res.redirect(`/reports/stock-ledger?status=${req.body.action === 'save_draft' ? 'draft' : 'submitted'}&voucher_id=${id}`);
  } catch (err) {
    try {
      const data = await loadStockEntry(req.params.id);
      res.status(err.status || 500).render('stock-entry', {
        today: req.body.posting_date || data.entry.posting_date || todayString(),
        postingTime: req.body.posting_time,
        error: err.message || 'Could not save stock entry.',
        ...data,
        attemptedCostCenter: req.body.cost_center || '',
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
