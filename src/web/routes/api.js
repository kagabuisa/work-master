'use strict';
// /api lookup routes. Mounted at /api by server.js.
const express = require('express');
const { warehouseAllowed, allowedInvoicePriceLists, namedPriceListsForActions,
  selectedCategories, requireInvoicePriceList } = require('../../access');
const { warehouseAccessOptions, accountAccessOptions } = require('../helpers');
const { normalizeStockQuantity } = require('../../lib/quantity');
const {
  masterItemsWithStock,
  invoiceItemPrices,
  findMasterRecord,
  masterPriceLists,
  masterItems,
  itemPriceCodeSuggestions,
  localStockQuantity,
  stockEntryCancelTemplate,
  searchStockEntriesForCancel,
  masterWarehouses,
  masterCustomers,
  masterSuppliers,
  masterCostCenters,
  masterEmployees,
  generalLedgerAccountOptions,
  generalLedgerPartyOptions,
  journalReferenceOptions,
} = require('../../store');

const router = express.Router();

router.get('/items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const warehouse = String(req.query.warehouse || '').trim();
    const priceList = String(req.query.price_list || '').trim();
    if (!warehouse) {
      res.status(400).json({ error: 'Warehouse is required.' });
      return;
    }
    if (!warehouseAllowed(req.currentUser, warehouse)) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    if (!priceList) { res.status(400).json({ error: 'Price list is required.' }); return; }
    requireInvoicePriceList(req.currentUser, priceList);
    res.json(await masterItemsWithStock({ search, warehouse, priceList, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

router.post('/invoice-item-prices', async (req, res, next) => {
  try {
    const priceListName = String(req.body.price_list || '').trim();
    const itemCodes = Array.isArray(req.body.item_codes)
      ? [...new Set(req.body.item_codes.map((code) => String(code || '').trim()).filter(Boolean))] : [];
    if (!priceListName || !itemCodes.length || itemCodes.length > 200) {
      res.status(400).json({ error: 'Choose a price list and up to 200 invoice items.' });
      return;
    }
    requireInvoicePriceList(req.currentUser, priceListName);
    const priceList = await findMasterRecord('price-lists', priceListName);
    if (!priceList || priceList.active !== 1 || priceList.currency !== 'UGX' || !['selling', 'both'].includes(priceList.price_type)) {
      res.status(400).json({ error: 'Select an active UGX selling price list.' });
      return;
    }
    const prices = await invoiceItemPrices(itemCodes, priceListName);
    if (prices.length !== itemCodes.length) {
      res.status(400).json({ error: 'One or more invoice items are no longer available.' });
      return;
    }
    res.json(prices);
  } catch (err) { next(err); }
});

router.get('/price-lists', async (req, res, next) => {
  try {
    const rows = await masterPriceLists({ search: String(req.query.q || ''), priceType: String(req.query.type || ''),
      allowedPriceLists: req.query.invoice === '1' ? allowedInvoicePriceLists(req.currentUser)
        : req.query.item_price === '1' && !['view', 'create', 'edit'].some((action) =>
          res.locals.can(`masters.item-prices.${action}`))
          ? namedPriceListsForActions(req.currentUser, ['create']) : undefined,
      deniedPriceLists: req.query.invoice === '1' ? (req.currentUser.permission_denials || [])
        .filter((key) => key.startsWith('invoice.price-list.view:'))
        .map((key) => key.slice('invoice.price-list.view:'.length)) : undefined,
      currency: ['buying', 'selling'].includes(String(req.query.type || '')) ? 'UGX' : undefined, limit: 200 });
    res.json(rows.map((row) => ({ value: row.price_list, label: `${row.currency} · ${row.type_label}` })));
  } catch (err) { next(err); }
});

router.get('/pricing-items', async (req, res, next) => {
  try {
    const rows = await masterItems({ search: String(req.query.q || ''), limit: 25 });
    res.json(rows.map((row) => ({ value: row.item_code, label: `${row.item_name} · ${row.stock_uom || ''}` })));
  } catch (err) { next(err); }
});

router.get('/item-price-codes', async (req, res, next) => {
  try {
    const codes = await itemPriceCodeSuggestions({
      search: String(req.query.q || ''),
      priceList: String(req.query.price_list || ''),
      priceListExact: req.query.price_list_exact === '1',
      limit: 20,
    });
    res.json(codes);
  } catch (err) { next(err); }
});

router.get('/master-items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterItems({ search, priceList: String(req.query.price_list || ''), limit: 50 }));
  } catch (err) {
    next(err);
  }
});

router.get('/report-items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const rows = await masterItems({ search, limit: 50 });
    res.json(rows.map((row) => ({ item_code: row.item_code, item_name: row.item_name })));
  } catch (err) { next(err); }
});

router.get('/stock-balance', async (req, res, next) => {
  try {
    const itemCode = String(req.query.item_code || '').trim();
    const warehouse = String(req.query.warehouse || '').trim();
    if (!itemCode || !warehouse) {
      res.json({ quantity: 0, valuation_rate: 0, stock_value: 0 });
      return;
    }
    if (!warehouseAllowed(req.currentUser, warehouse)) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    const balance = await localStockQuantity(itemCode, warehouse);
    res.json({
      quantity: normalizeStockQuantity(balance.quantity),
      valuation_rate: Number(balance.valuation_rate || 0),
      stock_value: Number(balance.stock_value || 0),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/stock-entry-cancel-template', async (req, res, next) => {
  try {
    const template = await stockEntryCancelTemplate(req.query.entry);
    if (template.items.some((item) => item.warehouse && !warehouseAllowed(req.currentUser, item.warehouse)
        || item.target_warehouse && !warehouseAllowed(req.currentUser, item.target_warehouse))) {
      res.status(403).json({ error: 'Warehouse is not permitted.' }); return;
    }
    res.json(template);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load stock entry.' });
  }
});

router.get('/stock-entries', async (req, res, next) => {
  try {
    const entries = await searchStockEntriesForCancel(req.query.q);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.get('/warehouses', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const localWarehouses = await masterWarehouses({ search, limit: 50, ...warehouseAccessOptions(req.currentUser) });
    res.json(localWarehouses.map((row) => row.warehouse));
  } catch (err) {
    next(err);
  }
});

router.get('/report-warehouses', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const rows = await masterWarehouses({ search, limit: 50, ...warehouseAccessOptions(req.currentUser) });
    res.json(rows.map((row) => row.warehouse));
  } catch (err) { next(err); }
});

router.get('/customers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterCustomers({ search, limit: 25, allowedGroups: selectedCategories(req.currentUser, 'customers') }));
  } catch (err) {
    next(err);
  }
});

router.get('/suppliers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterSuppliers({ search, limit: 25, allowedTypes: selectedCategories(req.currentUser, 'suppliers') }));
  } catch (err) {
    next(err);
  }
});

router.get('/cost-centers', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterCostCenters({ search, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger/accounts', async (req, res, next) => {
  try {
    res.json(await generalLedgerAccountOptions(req.query.q, accountAccessOptions(req.currentUser)));
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger/parties', async (req, res, next) => {
  try {
    res.json(await generalLedgerPartyOptions(req.query.q));
  } catch (err) {
    next(err);
  }
});

router.get('/employees', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    res.json(await masterEmployees({ search, limit: 25 }));
  } catch (err) {
    next(err);
  }
});

router.get('/journal-reference-options', async (req, res, next) => {
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

module.exports = router;
