const { requireReceiptAccount } = require('../../services/sales-validation');
'use strict';
// /purchase-orders and /purchases routes. Mounted at the app root.
const express = require('express');
const { purchaseMoney } = require('../format');
const { currentPostingDate, currentPostingTime } = require('../../posting-time');
const { arrayField } = require('../parsers');
const { selectedCategories, purchaseOrderAllowed, voucherWarehousesAllowed,
  allowedNamedListValues, deniedNamedListValues } = require('../../access');
const {
  createPurchase,
  updatePurchase,
  listPurchases,
  loadPurchase,
  purchaseForPayment,
  submitPurchase,
  cancelPurchase,
  addPurchasePayment,
  cancelPurchasePayment,
} = require('../../purchases');
const {
  createPurchaseOrder,
  updatePurchaseOrder,
  listPurchaseOrders,
  loadPurchaseOrder,
  listReceivablePurchaseOrders,
  submitPurchaseOrder,
  cancelPurchaseOrder,
  deleteDraftPurchaseOrder,
} = require('../../purchase-orders');
const { updateVoucherPostingTime, deleteDraftVoucher, getCompanyInformation } = require('../../store');
const { registerVoucherReportRoutes } = require('./voucher-report-routes');
const { voucherOwnerId } = require('../../voucher-ownership');
const { warehouseAccessOptions } = require('../helpers');
const { voucherSharing, changeVoucherShare, deleteVoucherShares } = require('../../voucher-sharing');
const { validateSharedVoucherEdit } = require('../../shared-voucher-edit');

const router = express.Router();

function purchasePayload(body, { singleWarehouse = false } = {}) {
  const ids = arrayField(body.item_id);
  const orderItemIds = arrayField(body.purchase_order_item_id);
  const codes = arrayField(body.item_code);
  const names = arrayField(body.item_name);
  const warehouse = singleWarehouse ? String(body.warehouse || '').trim() : '';
  const warehouses = singleWarehouse ? [] : arrayField(body.warehouse);
  const quantities = arrayField(body.quantity);
  const prices = arrayField(body.unit_price);
  return {
    ...require("../../voucher-controls").requestFields(body),
    posting_date: body.posting_date,
    posting_time: body.posting_time,
    due_date: body.due_date,
    supplier_id: body.supplier_id,
    supplier_name: body.supplier_name,
    price_list: body.price_list,
    ...(singleWarehouse ? { warehouse } : {}),
    cost_center: body.cost_center,
    purchase_order_id: body.purchase_order_id,
    supplier_reference: body.supplier_reference,
    remarks: body.remarks,
    items: codes.map((itemCode, index) => ({
      id: ids[index],
      purchase_order_item_id: orderItemIds[index],
      item_code: itemCode,
      item_name: names[index],
      warehouse: singleWarehouse ? warehouse : warehouses[index],
      quantity: quantities[index],
      unit_price: prices[index],
    })).filter((item) => item.item_code || !singleWarehouse && item.warehouse || item.quantity || item.unit_price),
  };
}

async function receivableOrdersForUser(user) {
  return listReceivablePurchaseOrders({
    ownerId: voucherOwnerId(user),
    allowedTypes: selectedCategories(user, 'suppliers'),
    allowedWarehouses: allowedNamedListValues(user, 'warehouses'),
    deniedWarehouses: user?.role === 'admin' ? [] : deniedNamedListValues(user, 'warehouses'),
  });
}

async function fillPurchaseFromOrder(user, purchase, orderId) {
  const order = await loadPurchaseOrder(orderId);
  if (!await purchaseOrderAllowed(user, order.id)
    || !await voucherWarehousesAllowed(user, 'purchase-orders', order.id)) {
    const err = new Error('Purchase order is not available.'); err.status = 403; throw err;
  }
  if (order.docstatus !== 'submitted') {
    const err = new Error('Only submitted purchase orders can be received.'); err.status = 400; throw err;
  }
  const items = order.items.filter((item) => item.quantity > item.received).map((item) => ({
    purchase_order_item_id: item.id, item_code: item.item_code, item_name: item.item_name,
    warehouse: item.warehouse, quantity: Math.round((item.quantity - item.received) * 1000) / 1000,
    unit_price: item.unit_price,
  }));
  if (!items.length) { const err = new Error('This purchase order is fully received.'); err.status = 400; throw err; }
  return { ...purchase, purchase_order_id: order.id, purchase_order_no: order.order_no,
    supplier_id: order.supplier_id, supplier_name: order.supplier_name, price_list: order.price_list,
    cost_center: order.cost_center, items };
}

async function voucherShareView(req, type, record) {
  return {
    sharing: await voucherSharing(req.currentUser, type, record),
    sharedAccessOnly: Boolean(req.voucherSharedRead),
    sharedWriteAccess: Boolean(req.voucherSharedWrite),
  };
}

async function changeShare(req, res, next, type, loader) {
  const inlineSharing = req.get('x-requested-with') === 'XMLHttpRequest';
  try {
    await changeVoucherShare(req.currentUser, type, req.params.id,
      req.body.action === 'revoke' ? 'revoke' : 'share', req.body.user_id, req.body.permission || 'read');
    if (inlineSharing) {
      const record = await loader(req.params.id);
      const sharing = await voucherSharing(req.currentUser, type, record);
      return res.render('voucher-sharing', { sharing }, (error, html) => {
        if (error) return next(error);
        res.set('Cache-Control', 'private, no-store');
        res.json({ html });
      });
    }
    res.redirect(303, `/${type === 'purchase-orders' ? 'purchase-orders' : 'purchases'}/${req.params.id}`);
  } catch (error) {
    if (inlineSharing) return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Could not save sharing. Please try again.',
    });
    if (error.status === 400) {
      return res.redirect(303, `/${type === 'purchase-orders' ? 'purchase-orders' : 'purchases'}/${req.params.id}?error=${encodeURIComponent(error.message)}`);
    }
    next(error);
  }
}

function duplicateOrderState(order) {
  return {
    posting_date: currentPostingDate(),
    posting_time: currentPostingTime(),
    due_date: '',
    supplier_id: order.supplier_id,
    supplier_name: order.supplier_name,
    price_list: order.price_list,
    warehouse: order.warehouse,
    cost_center: order.cost_center,
    supplier_reference: '',
    remarks: order.remarks,
    items: (order.items || []).map((item) => ({
      item_code: item.item_code,
      item_name: item.item_name,
      warehouse: item.warehouse,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
    })),
  };
}

function duplicatePurchaseState(purchase) {
  return {
    posting_date: currentPostingDate(),
    posting_time: currentPostingTime(),
    due_date: '',
    supplier_id: purchase.supplier_id,
    supplier_name: purchase.supplier_name,
    price_list: purchase.price_list,
    cost_center: purchase.cost_center,
    supplier_reference: '',
    remarks: purchase.remarks,
    items: (purchase.items || []).map((item) => ({
      item_code: item.item_code,
      item_name: item.item_name,
      warehouse: item.warehouse,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
    })),
  };
}

router.get('/purchase-orders', async (req, res, next) => {
  try {
    const result = await listPurchaseOrders({ ...req.query, ownerId: voucherOwnerId(req.currentUser),
      allowedTypes: selectedCategories(req.currentUser, 'suppliers'), ...warehouseAccessOptions(req.currentUser) });
    res.render('purchase-orders', { result, query: req.query, money: purchaseMoney });
  } catch (err) { next(err); }
});

registerVoucherReportRoutes(router, 'purchase-orders');

router.get('/purchase-orders/new', (_req, res) => {
  res.render('purchase-order-form', {
    purchase: { posting_date: currentPostingDate(), posting_time: currentPostingTime(), due_date: '', items: [{}] },
    error: null,
  });
});

router.post('/purchase-orders', async (req, res) => {
  const purchase = purchasePayload(req.body, { singleWarehouse: true });
  try { res.redirect(303, `/purchase-orders/${await createPurchaseOrder(purchase)}`); }
  catch (err) { res.status(err.status || 500).render('purchase-order-form', { purchase, error: err.message }); }
});

router.get('/purchase-orders/:id/drawer', async (req, res, next) => {
  try {
    const order = await loadPurchaseOrder(req.params.id, req.voucherSharedRead
      ? {} : { ownerId: voucherOwnerId(req.currentUser) });
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-order-drawer', { order, money: purchaseMoney,
      error: req.query.error || null, ...await voucherShareView(req, 'purchase-orders', order) });
  } catch (err) { next(err); }
});

router.get('/purchase-orders/:id/duplicate', async (req, res, next) => {
  try {
    const order = await loadPurchaseOrder(req.params.id, { ownerId: voucherOwnerId(req.currentUser) });
    res.set('Cache-Control', 'private, no-store');
    res.render('purchase-order-form', {
      purchase: duplicateOrderState(order),
      duplicateOf: order.order_no,
      error: null,
    });
  } catch (err) { next(err); }
});

router.get('/purchase-orders/:id/print', async (req, res, next) => {
  try {
    const order = await loadPurchaseOrder(req.params.id, { ownerId: voucherOwnerId(req.currentUser) });
    res.set('Cache-Control', 'private, no-store');
    res.render('purchase-print', {
      kind: 'purchase-orders',
      record: order,
      money: purchaseMoney,
      company: await getCompanyInformation(),
    });
  } catch (err) { next(err); }
});

router.get('/purchase-orders/:id', async (req, res, next) => {
  try {
    const order = await loadPurchaseOrder(req.params.id, req.voucherSharedRead
      ? {} : { ownerId: voucherOwnerId(req.currentUser) });
    res.render('purchase-order', { order, money: purchaseMoney,
      error: req.query.error || null, ...await voucherShareView(req, 'purchase-orders', order) });
  }
  catch (err) { next(err); }
});

router.get('/purchase-orders/:id/edit', async (req, res, next) => {
  try {
    const purchase = await loadPurchaseOrder(req.params.id);
    if (purchase.docstatus !== 'draft') { const err = new Error('Only draft purchase orders can be edited.'); err.status = 400; throw err; }
    res.render('purchase-order-form', { purchase, error: null, sharing: null,
      sharedAccessOnly: Boolean(req.voucherSharedRead), sharedWriteAccess: Boolean(req.voucherSharedWrite) });
  } catch (err) { next(err); }
});

router.post('/purchase-orders/:id', async (req, res) => {
  const purchase = { ...purchasePayload(req.body, { singleWarehouse: true }), id: Number(req.params.id) };
  try {
    if (req.voucherSharedWrite) {
      const existing = await loadPurchaseOrder(req.params.id);
      await validateSharedVoucherEdit(req.currentUser, 'purchase-orders', existing, purchase);
    }
    await updatePurchaseOrder(req.params.id, purchase,
      req.voucherSharedWrite ? { sharedUser: req.currentUser } : {});
    res.redirect(303, `/purchase-orders/${req.params.id}`);
  }
  catch (err) { res.status(err.status || 500).render('purchase-order-form', { purchase, error: err.message,
    sharing: null, sharedAccessOnly: Boolean(req.voucherSharedRead),
    sharedWriteAccess: Boolean(req.voucherSharedWrite) }); }
});

router.post('/purchase-orders/:id/share', (req, res, next) => (
  changeShare(req, res, next, 'purchase-orders', (id) => loadPurchaseOrder(id))));

for (const [action, handler] of [['submit', submitPurchaseOrder], ['cancel', cancelPurchaseOrder]]) {
  router.post(`/purchase-orders/:id/${action}`, async (req, res) => {
    try { await handler(req.params.id); res.redirect(303, `/purchase-orders/${req.params.id}`); }
    catch (err) { res.redirect(303, `/purchase-orders/${req.params.id}?error=${encodeURIComponent(err.message)}`); }
  });
}

router.post('/purchase-orders/:id/delete', async (req, res, next) => {
  try { await deleteDraftPurchaseOrder(req.params.id, { allowCancelled: req.currentUser.role === 'admin' });
    await deleteVoucherShares('purchase-orders', req.params.id); res.redirect(303, '/purchase-orders'); }
  catch (err) { next(err); }
});

router.get('/purchases', async (req, res, next) => {
  try {
    const result = await listPurchases({ ...req.query, ownerId: voucherOwnerId(req.currentUser),
      allowedTypes: selectedCategories(req.currentUser, 'suppliers'), ...warehouseAccessOptions(req.currentUser) });
    res.render('purchases', { result, query: req.query, money: purchaseMoney });
  } catch (err) { next(err); }
});

registerVoucherReportRoutes(router, 'purchases');

router.get('/purchases/new', async (req, res, next) => {
  try {
    const purchaseOrders = await receivableOrdersForUser(req.currentUser);
    let purchase = { posting_date: currentPostingDate(), posting_time: currentPostingTime(), due_date: '', items: [{}] };
    if (req.query.purchase_order_id) {
      purchase = await fillPurchaseFromOrder(req.currentUser, purchase, req.query.purchase_order_id);
    }
    res.render('purchase-form', { purchase, purchaseOrders, error: null });
  } catch (err) { next(err); }
});

router.post('/purchases', async (req, res) => {
  const purchase = purchasePayload(req.body);
  try {
    const id = await createPurchase(purchase);
    res.redirect(`/purchases/${id}`);
  } catch (err) {
    const duplicateReference = err.code === '23505' && err.constraint === 'app_purchases_supplier_reference_idx';
    res.status(duplicateReference ? 400 : err.status || 500).render('purchase-form', {
      purchase,
      error: duplicateReference ? 'This supplier reference is already used on another purchase.' : err.message,
      draftPurchase: err.draftPurchase || null,
    });
  }
});

router.get('/purchases/payments/:id', async (req, res, next) => {
  try {
    const purchaseId = await purchaseForPayment(req.params.id);
    res.redirect(`/purchases/${purchaseId}`);
  } catch (err) { next(err); }
});

router.get('/purchases/payments/:id/drawer', async (req, res, next) => {
  try {
    const purchaseId = await purchaseForPayment(req.params.id);
    const purchase = await loadPurchase(purchaseId);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-drawer', { purchase, today: currentPostingDate(), money: purchaseMoney, error: req.query.error || null });
  } catch (err) { next(err); }
});

router.get('/purchases/:id/duplicate', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.set('Cache-Control', 'private, no-store');
    res.render('purchase-form', {
      purchase: duplicatePurchaseState(purchase),
      purchaseOrders: await receivableOrdersForUser(req.currentUser),
      duplicateOf: purchase.purchase_no,
      error: null,
    });
  } catch (err) { next(err); }
});

router.get('/purchases/:id/print', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.set('Cache-Control', 'private, no-store');
    res.render('purchase-print', {
      kind: 'purchases',
      record: purchase,
      money: purchaseMoney,
      company: await getCompanyInformation(),
    });
  } catch (err) { next(err); }
});

router.get('/purchases/:id', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.render('purchase', { purchase, today: currentPostingDate(), money: purchaseMoney,
      error: req.query.error || null, ...await voucherShareView(req, 'purchases', purchase) });
  } catch (err) { next(err); }
});

router.post('/purchases/:id/posting-time', async (req, res, next) => {
  try {
    await updateVoucherPostingTime('purchases', req.params.id, req.body.posting_time);
    res.redirect(303, `/purchases/${req.params.id}`);
  } catch (err) {
    if (err.status === 400) return res.redirect(303, `/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/purchases/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('purchases', req.params.id, { allowCancelled: req.currentUser.role === 'admin' });
    await deleteVoucherShares('purchases', req.params.id); res.redirect(303, '/purchases'); }
  catch (error) { next(error); }
});

router.post('/purchases/:id/share', (req, res, next) => (
  changeShare(req, res, next, 'purchases', (id) => loadPurchase(id))));

router.get('/purchases/:id/drawer', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-drawer', { purchase, today: currentPostingDate(), money: purchaseMoney,
      error: req.query.error || null, ...await voucherShareView(req, 'purchases', purchase) });
  } catch (err) { next(err); }
});

router.get('/purchases/:id/edit', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    if (purchase.docstatus !== 'draft') {
      const err = new Error('Only draft purchases can be edited.');
      err.status = 400;
      throw err;
    }
    const purchaseOrders = purchase.purchase_order_id || req.voucherSharedRead
      ? [] : await receivableOrdersForUser(req.currentUser);
    if (req.query.purchase_order_id) {
      if (purchase.purchase_order_id) {
        const err = new Error('This invoice is already linked to a purchase order.'); err.status = 400; throw err;
      }
      Object.assign(purchase, await fillPurchaseFromOrder(req.currentUser, purchase, req.query.purchase_order_id));
    }
    res.render('purchase-form', { purchase, purchaseOrders, error: null, sharing: null,
      sharedAccessOnly: Boolean(req.voucherSharedRead), sharedWriteAccess: Boolean(req.voucherSharedWrite) });
  } catch (err) { next(err); }
});

router.post('/purchases/:id', async (req, res) => {
  const purchase = { ...purchasePayload(req.body), id: Number(req.params.id) };
  try {
    if (req.voucherSharedWrite) {
      const existing = await loadPurchase(req.params.id);
      await validateSharedVoucherEdit(req.currentUser, 'purchases', existing, purchase);
    }
    await updatePurchase(req.params.id, purchase,
      req.voucherSharedWrite ? { sharedUser: req.currentUser } : {});
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    const duplicateReference = err.code === '23505' && err.constraint === 'app_purchases_supplier_reference_idx';
    res.status(duplicateReference ? 400 : err.status || 500).render('purchase-form', {
      purchase,
      error: duplicateReference ? 'This supplier reference is already used on another purchase.' : err.message,
      draftPurchase: err.draftPurchase || null,
      sharing: null,
      sharedAccessOnly: Boolean(req.voucherSharedRead),
      sharedWriteAccess: Boolean(req.voucherSharedWrite),
    });
  }
});

router.post('/purchases/:id/submit', async (req, res) => {
  try {
    await submitPurchase(req.params.id);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/purchases/:id/cancel', async (req, res) => {
  try {
    await cancelPurchase(req.params.id);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/purchases/:id/payments', async (req, res) => {
  try {
    requireReceiptAccount(req.currentUser, req.body.account_id);
    await addPurchasePayment(req.params.id, req.body);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/purchases/:id/payments/:paymentNo/cancel', async (req, res) => {
  try {
    await cancelPurchasePayment(req.params.id, req.params.paymentNo);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    res.redirect(`/purchases/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
