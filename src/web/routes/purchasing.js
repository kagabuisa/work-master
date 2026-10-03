'use strict';
// /purchase-orders and /purchases routes. Mounted at the app root.
const express = require('express');
const { purchaseMoney, todayString } = require('../format');
const { currentPostingDate, currentPostingTime } = require('../../posting-time');
const { arrayField } = require('../parsers');
const { selectedCategories, purchaseOrderAllowed, voucherWarehousesAllowed } = require('../../access');
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
const { updateVoucherPostingTime, deleteDraftVoucher } = require('../../store');

const router = express.Router();

function purchasePayload(body) {
  const ids = arrayField(body.item_id);
  const orderItemIds = arrayField(body.purchase_order_item_id);
  const codes = arrayField(body.item_code);
  const names = arrayField(body.item_name);
  const warehouses = arrayField(body.warehouse);
  const quantities = arrayField(body.quantity);
  const prices = arrayField(body.unit_price);
  return {
    posting_date: body.posting_date,
    posting_time: body.posting_time,
    due_date: body.due_date,
    supplier_id: body.supplier_id,
    supplier_name: body.supplier_name,
    price_list: body.price_list,
    purchase_order_id: body.purchase_order_id,
    supplier_reference: body.supplier_reference,
    remarks: body.remarks,
    items: codes.map((itemCode, index) => ({
      id: ids[index],
      purchase_order_item_id: orderItemIds[index],
      item_code: itemCode,
      item_name: names[index],
      warehouse: warehouses[index],
      quantity: quantities[index],
      unit_price: prices[index],
    })).filter((item) => item.item_code || item.warehouse || item.quantity || item.unit_price),
  };
}

async function receivableOrdersForUser(user) {
  const available = await listReceivablePurchaseOrders();
  return (await Promise.all(available.map(async (order) =>
    await purchaseOrderAllowed(user, order.id)
    && await voucherWarehousesAllowed(user, 'purchase-orders', order.id) ? order : null))).filter(Boolean);
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
    supplier_id: order.supplier_id, supplier_name: order.supplier_name, price_list: order.price_list, items };
}

router.get('/purchase-orders', async (req, res, next) => {
  try {
    const result = await listPurchaseOrders({ ...req.query,
      allowedTypes: selectedCategories(req.currentUser, 'suppliers') });
    res.render('purchase-orders', { result, query: req.query, money: purchaseMoney });
  } catch (err) { next(err); }
});

router.get('/purchase-orders/new', (_req, res) => {
  res.render('purchase-order-form', {
    purchase: { posting_date: currentPostingDate(), posting_time: currentPostingTime(), due_date: '', items: [{}] },
    error: null,
  });
});

router.post('/purchase-orders', async (req, res) => {
  const purchase = purchasePayload(req.body);
  try { res.redirect(303, `/purchase-orders/${await createPurchaseOrder(purchase)}`); }
  catch (err) { res.status(err.status || 500).render('purchase-order-form', { purchase, error: err.message }); }
});

router.get('/purchase-orders/:id', async (req, res, next) => {
  try { res.render('purchase-order', { order: await loadPurchaseOrder(req.params.id),
    money: purchaseMoney, error: req.query.error || null }); }
  catch (err) { next(err); }
});

router.get('/purchase-orders/:id/edit', async (req, res, next) => {
  try {
    const purchase = await loadPurchaseOrder(req.params.id);
    if (purchase.docstatus !== 'draft') { const err = new Error('Only draft purchase orders can be edited.'); err.status = 400; throw err; }
    res.render('purchase-order-form', { purchase, error: null });
  } catch (err) { next(err); }
});

router.post('/purchase-orders/:id', async (req, res) => {
  const purchase = { ...purchasePayload(req.body), id: Number(req.params.id) };
  try { await updatePurchaseOrder(req.params.id, purchase); res.redirect(303, `/purchase-orders/${req.params.id}`); }
  catch (err) { res.status(err.status || 500).render('purchase-order-form', { purchase, error: err.message }); }
});

for (const [action, handler] of [['submit', submitPurchaseOrder], ['cancel', cancelPurchaseOrder]]) {
  router.post(`/purchase-orders/:id/${action}`, async (req, res) => {
    try { await handler(req.params.id); res.redirect(303, `/purchase-orders/${req.params.id}`); }
    catch (err) { res.redirect(303, `/purchase-orders/${req.params.id}?error=${encodeURIComponent(err.message)}`); }
  });
}

router.post('/purchase-orders/:id/delete', async (req, res, next) => {
  try { await deleteDraftPurchaseOrder(req.params.id); res.redirect(303, '/purchase-orders'); }
  catch (err) { next(err); }
});

router.get('/purchases', async (req, res, next) => {
  try {
    const result = await listPurchases({ ...req.query, allowedTypes: selectedCategories(req.currentUser, 'suppliers') });
    res.render('purchases', { result, query: req.query, money: purchaseMoney });
  } catch (err) { next(err); }
});

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
    res.render('purchase-drawer', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
  } catch (err) { next(err); }
});

router.get('/purchases/:id', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.render('purchase', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
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
  try { await deleteDraftVoucher('purchases', req.params.id); res.redirect(303, '/purchases'); }
  catch (error) { next(error); }
});

router.get('/purchases/:id/drawer', async (req, res, next) => {
  try {
    const purchase = await loadPurchase(req.params.id);
    res.set('Cache-Control', 'private, max-age=10');
    res.render('purchase-drawer', { purchase, today: todayString(), money: purchaseMoney, error: req.query.error || null });
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
    const purchaseOrders = purchase.purchase_order_id ? [] : await receivableOrdersForUser(req.currentUser);
    if (req.query.purchase_order_id) {
      if (purchase.purchase_order_id) {
        const err = new Error('This invoice is already linked to a purchase order.'); err.status = 400; throw err;
      }
      Object.assign(purchase, await fillPurchaseFromOrder(req.currentUser, purchase, req.query.purchase_order_id));
    }
    res.render('purchase-form', { purchase, purchaseOrders, error: null });
  } catch (err) { next(err); }
});

router.post('/purchases/:id', async (req, res) => {
  const purchase = { ...purchasePayload(req.body), id: Number(req.params.id) };
  try {
    await updatePurchase(req.params.id, purchase);
    res.redirect(`/purchases/${req.params.id}`);
  } catch (err) {
    const duplicateReference = err.code === '23505' && err.constraint === 'app_purchases_supplier_reference_idx';
    res.status(duplicateReference ? 400 : err.status || 500).render('purchase-form', {
      purchase,
      error: duplicateReference ? 'This supplier reference is already used on another purchase.' : err.message,
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
