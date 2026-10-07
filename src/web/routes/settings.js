'use strict';
// /settings routes and the master-data form/list helpers. Mounted at the app root.
const express = require('express');
const multer = require('multer');
const { getCompanyInformation, saveCompanyInformation, saveDateTimeSettings, masterOptions, itemPriceListFilters, setPriceListActive, setMasterRecordActive, deletePriceList, deleteMasterRecord, updateMasterRecord, createMasterRecord, masterRecordNeighbors, priceListNeighbors } = require('../../store');
const { listDirectory, downloadableFile, saveUploads } = require('../../project-files');
const { DEFAULT_IMPORT_FROM, importSalesInvoicesFromMysql } = require('../../sales-invoice-importer');
const { selectedCategories, namedPriceListsForActions, allowedInvoicePriceLists,
  allowedMasterRecordIds, deniedMasterRecordIds } = require('../../access');
const { warehouseAccessOptions } = require('../helpers');
const { clearInvoiceCaches, salesInvoiceSyncView, syncState } = require('../cache');
const { masterListConfig } = require('../master-lists');

const DEFAULT_OPTION_GROUPS = ['item_category', 'stock_uom', 'customer_group', 'territory', 'supplier_type', 'warehouse_type'];

const router = express.Router();

router.get('/settings', async (req, res, next) => {
  try {
    res.render('settings', {
      company: await getCompanyInformation(),
      companySaved: req.query.company === 'saved',
      companyError: null,
      dateTimeSaved: req.query.date_time === 'saved',
      dateTimeError: null,
      salesInvoiceSync: salesInvoiceSyncView(req.query.sync),
    });
  } catch (err) { next(err); }
});

function projectFilesAdmin(req, res, next) {
  if (req.currentUser.role !== 'admin') {
    const error = new Error('Your account does not have permission for this action.');
    error.status = 403;
    return next(error);
  }
  return next();
}

const projectUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10, parts: 12 },
}).array('files', 10);

async function renderProjectFiles(req, res, options = {}) {
  const listing = await listDirectory(String(options.dir ?? req.query.dir ?? ''));
  res.set('Cache-Control', 'private, no-store');
  res.status(options.status || 200).render('project-files', {
    ...listing,
    error: options.error || null,
    uploaded: Number(req.query.uploaded) || 0,
  });
}

router.get('/settings/files', projectFilesAdmin, async (req, res, next) => {
  try { await renderProjectFiles(req, res); } catch (error) { next(error); }
});

router.get('/settings/files/download', projectFilesAdmin, async (req, res, next) => {
  try {
    const file = await downloadableFile(req.query.path);
    res.set('Cache-Control', 'private, no-store');
    res.download(file.filePath, file.name, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

router.post('/settings/files/upload', projectFilesAdmin, (req, res, next) => {
  projectUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 20 MB or smaller.'
          : uploadError.code === 'LIMIT_FILE_COUNT' ? 'Choose up to 10 files at a time.'
            : 'The upload could not be completed.';
        await renderProjectFiles(req, res, { dir: 'uploads', error: message, status: 400 });
        return;
      }
      if (!req.files?.length) {
        await renderProjectFiles(req, res, { dir: 'uploads', error: 'Choose at least one file to upload.', status: 400 });
        return;
      }
      const saved = await saveUploads(req.files);
      res.redirect(303, `/settings/files?dir=uploads&uploaded=${saved.length}`);
    } catch (error) {
      if (error.status === 400) {
        try { await renderProjectFiles(req, res, { dir: 'uploads', error: error.message, status: 400 }); }
        catch (renderError) { next(renderError); }
      } else next(error);
    }
  });
});

router.post('/settings/company-information', async (req, res, next) => {
  try {
    await saveCompanyInformation(req.body);
    res.redirect(303, '/settings?company=saved');
  } catch (err) {
    if (err.status === 400) {
      res.status(400).render('settings', {
        company: req.body,
        companySaved: false,
        companyError: err.message,
        dateTimeSaved: false,
        dateTimeError: null,
        salesInvoiceSync: salesInvoiceSyncView(),
      });
      return;
    }
    next(err);
  }
});

router.post('/settings/date-time', async (req, res, next) => {
  try {
    await saveDateTimeSettings(req.body);
    res.redirect(303, '/settings?date_time=saved');
  } catch (error) {
    if (error.status === 400) {
      res.status(400).render('settings', {
        company: await getCompanyInformation(),
        companySaved: false,
        companyError: null,
        dateTimeSettings: req.body,
        dateTimeSaved: false,
        dateTimeError: error.message,
        salesInvoiceSync: salesInvoiceSyncView(),
      });
      return;
    }
    next(error);
  }
});

router.post('/settings/erpnext-sync/sales-invoices', async (_req, res, next) => {
  if (syncState.running) {
    syncState.last = {
      ok: false,
      running: true,
      finished_at: new Date().toISOString(),
      message: 'Sales invoice import is already running.',
    };
    res.redirect('/settings?sync=running');
    return;
  }

  syncState.running = true;
  try {
    const startedAt = new Date();
    const summary = await importSalesInvoicesFromMysql({ from: DEFAULT_IMPORT_FROM });
    syncState.last = {
      ok: true,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      summary,
    };
    clearInvoiceCaches();
    res.redirect('/settings?sync=success');
  } catch (err) {
    syncState.last = {
      ok: false,
      finished_at: new Date().toISOString(),
      message: err.message || 'Sales invoice import failed.',
    };
    res.redirect('/settings?sync=failed');
  } finally {
    syncState.running = false;
  }
});

router.get('/settings/:list/new', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    await renderMasterForm(res, { config, record: newMasterRecord(config, req.query), error: null, mode: 'new' });
  } catch (err) {
    next(err);
  }
});

function newMasterRecord(config, query = {}) {
  if (config.key === 'price-lists') return { currency: 'UGX', price_type: 'selling' };
  if (config.key !== 'options') {
    return {};
  }
  return {
    option_group: String(query.group || '').trim(),
    option_value: String(query.value || '').trim(),
  };
}

router.get('/settings/:list/:id/edit', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    const id = decodeURIComponent(req.params.id);
    const record = await findVisibleMasterRecord(config, id);
    if (!record) {
      const err = new Error(`${config.singular} not found.`);
      err.status = 404;
      throw err;
    }
    await renderMasterForm(res, {
      config, record, error: null, mode: 'edit',
      editSubmitted: record.docstatus === 'submitted'
        && (config.key === 'price-lists' ? res.locals.canPriceListAction(record.price_list, 'edit')
          : res.locals.can(`masters.${config.key}.edit`))
        && (config.key !== 'price-lists' || req.query.editing === '1'),
    });
  } catch (err) {
    next(err);
  }
});

async function renderMasterForm(res, { config, record, error, mode, editSubmitted = false }) {
  if (config.key !== 'item-prices' && config.key !== 'price-lists' && mode === 'edit') {
    record.active = record.disabled === '0' && record.docstatus === 'submitted' ? 1 : 0;
  }
  const optionValues = await masterFormOptions(config);
  const neighbors = mode === 'edit'
    ? config.key === 'price-lists' ? await priceListNeighbors(record.price_list)
      : await masterRecordNeighbors(config.key, record[config.idField])
    : null;
  if (config.key === 'customers' || config.key === 'suppliers') {
    const allowed = selectedCategories(res.locals.currentUser, config.key);
    const group = config.key === 'customers' ? 'customer_group' : 'supplier_type';
    if (allowed !== null) {
      const scopedValues = res.locals.currentUser.scopes[config.key].values;
      optionValues[group] = [...new Set([...(optionValues[group] || []), ...scopedValues]
        .filter((value) => allowed.includes(value.trim().toLowerCase())))].sort((a, b) => a.localeCompare(b));
    }
  }
  res.render('master-form', { config, record, error, mode, optionValues, editSubmitted, neighbors });
}

async function masterFormOptions(config) {
  const groups = [...new Set(config.fields
    .map((field) => field.optionGroup)
    .filter(Boolean))];
  const entries = await Promise.all(groups.map(async (group) => {
    const rows = await masterOptions({ group, limit: 500 });
    let values = rows.map((row) => row.option_value);
    if (group === 'option_group') {
      const existingGroups = (await masterOptions({ limit: 500 })).map((row) => row.option_group);
      values = [...DEFAULT_OPTION_GROUPS, ...existingGroups];
    }
    return [group, [...new Set(values)].sort((a, b) => a.localeCompare(b))];
  }));
  return Object.fromEntries(entries);
}

async function findVisibleMasterRecord(config, id) {
  const exactId = String(id || '').trim();
  const localRecord = await config.finder(exactId);
  if (localRecord) {
    return localRecord;
  }
  const rows = await config.loader({ search: exactId, limit: 500 });
  return rows.find((row) => String(row[config.idField] || '') === exactId) || null;
}

router.get('/settings/:list', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    const search = String(req.query.q || '').trim();
    const priceList = config.key === 'item-prices' ? String(req.query.price_list || '').trim() : '';
    const itemCode = config.key === 'item-prices' ? String(req.query.item_code || '').trim() : '';
    const itemCodeExact = req.query.item_code_exact === '1';
    const priceListOptions = config.key === 'item-prices'
      ? (await itemPriceListFilters()).filter((name) => res.locals.can('masters.item-prices.view')
        || namedPriceListsForActions(req.currentUser, ['create']).includes(name)) : [];
    const rows = await config.loader({
      search,
      priceList,
      priceListExact: priceListOptions.includes(priceList),
      itemCode,
      itemCodeExact,
      limit: 50,
      page: req.query.page,
      page_size: req.query.page_size,
      paginate: true,
      allowedGroups: config.key === 'customers' ? selectedCategories(req.currentUser, 'customers') : undefined,
      allowedTypes: config.key === 'suppliers' ? selectedCategories(req.currentUser, 'suppliers') : undefined,
      ...(config.key === 'warehouses' ? warehouseAccessOptions(req.currentUser) : {}),
      allowedIds: ['cost-centers', 'employees'].includes(config.key)
        ? allowedMasterRecordIds(req.currentUser, config.key) : undefined,
      deniedIds: ['cost-centers', 'employees'].includes(config.key)
        ? deniedMasterRecordIds(req.currentUser, config.key) : undefined,
      allowedPriceLists: config.key === 'price-lists'
        && (req.currentUser.record_access?.retail_price_list
          || req.currentUser.record_access?.wholesale_price_list
          || !res.locals.can('masters.price-lists.view'))
        ? allowedInvoicePriceLists(req.currentUser) || undefined
        : config.key === 'item-prices' && !res.locals.can('masters.item-prices.view')
          ? namedPriceListsForActions(req.currentUser, ['create']) : undefined,
      deniedPriceLists: config.key === 'price-lists' ? (req.currentUser.permission_denials || [])
        .filter((key) => key.startsWith('invoice.price-list.view:'))
        .map((key) => key.slice('invoice.price-list.view:'.length)) : undefined,
    });
    if (config.key !== 'item-prices' && config.key !== 'price-lists') {
      for (const row of rows) row.active = row.disabled === '0' && row.docstatus === 'submitted' ? 1 : 0;
    }
    res.render('master-list', { config, rows, pagination: rows.pagination, query: req.query, search,
      priceList, priceListOptions, itemCode, itemCodeExact });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/price-lists/:id/active', async (req, res, next) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const active = req.body.active === '1' ? true : req.body.active === '0' ? false : null;
    await setPriceListActive(id, active);
    if (req.body.return_to === 'edit') {
      res.redirect(303, `/settings/price-lists/${encodeURIComponent(id)}/edit?editing=1`);
      return;
    }
    const query = new URLSearchParams();
    for (const key of ['q', 'page', 'page_size']) {
      if (req.body[key]) query.set(key, String(req.body[key]));
    }
    res.redirect(303, `/settings/price-lists${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

router.post('/settings/:list/:id/active', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    if (config.key === 'price-lists') { const error = new Error('Unknown master list.'); error.status = 404; throw error; }
    const id = decodeURIComponent(req.params.id);
    const active = req.body.active === '1' ? true : req.body.active === '0' ? false : null;
    await setMasterRecordActive(config.key, id, active);
    if (req.body.return_to === 'edit') {
      res.redirect(303, `/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
      return;
    }
    const query = new URLSearchParams();
    for (const key of ['q', 'price_list', 'item_code', 'item_code_exact', 'page', 'page_size']) if (req.body[key]) query.set(key, String(req.body[key]));
    res.redirect(303, `/settings/${config.key}${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

router.post('/settings/price-lists/:id/delete', async (req, res, next) => {
  try {
    await deletePriceList(decodeURIComponent(req.params.id));
    const query = new URLSearchParams();
    for (const key of ['q', 'page', 'page_size']) {
      if (req.body[key]) query.set(key, String(req.body[key]));
    }
    res.redirect(303, `/settings/price-lists${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

router.post('/settings/:list/:id/delete', async (req, res, next) => {
  try {
    const config = masterListConfig(req.params.list);
    await deleteMasterRecord(config.key, decodeURIComponent(req.params.id));
    const query = new URLSearchParams();
    for (const key of ['q', 'price_list', 'item_code', 'item_code_exact', 'page', 'page_size']) if (req.body[key]) query.set(key, String(req.body[key]));
    res.redirect(303, `/settings/${config.key}${query.size ? `?${query}` : ''}`);
  } catch (err) { next(err); }
});

router.post('/settings/:list/:id', async (req, res, next) => {
  const id = decodeURIComponent(req.params.id);
  const config = masterListConfig(req.params.list);
  try {
    await updateMasterRecord(config.key, id, req.body);
    res.redirect(`/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
  } catch (err) {
    if (err.status === 403) return next(err);
    res.status(err.status || 500);
    const persisted = await config.finder(id);
    await renderMasterForm(res, {
      config,
      record: { ...persisted, ...req.body, [config.idField]: id },
      error: err.message || `Could not update ${config.singular.toLowerCase()}.`,
      mode: 'edit',
      editSubmitted: persisted?.docstatus === 'submitted'
        && (config.key === 'price-lists' ? res.locals.canPriceListAction(persisted?.price_list, 'edit')
          : res.locals.can(`masters.${config.key}.edit`)),
    });
  }
});

router.post('/settings/:list', async (req, res, next) => {
  const config = masterListConfig(req.params.list);
  try {
    const id = await createMasterRecord(config.key, req.body);
    res.redirect(`/settings/${config.key}/${encodeURIComponent(id)}/edit?editing=1`);
  } catch (err) {
    if (err.code === '23505') {
      err.message = `${config.singular} already exists.`;
      err.status = 400;
    }
    res.status(err.status || 500);
    await renderMasterForm(res, {
      config,
      record: req.body,
      error: err.message || `Could not create ${config.singular.toLowerCase()}.`,
      mode: 'new',
    });
  }
});


module.exports = router;
