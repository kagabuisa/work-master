(function (root, factory) {
  // Single source of truth for invoice money math, shared by the Node server
  // (CommonJS) and the browser (global). Keep this file dependency-free.
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InvoiceMath = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // UGX is a zero-decimal currency: money is rounded to whole units everywhere.
  function roundMoney(value) {
    return Math.round(Number(value || 0));
  }

  // Sum of quantity * unit_price across line items.
  function subtotal(items) {
    return (items || []).reduce((sum, item) => (
      sum + (Number(item.quantity || 0) * Number(item.unit_price || 0))
    ), 0);
  }

  // Grand total: subtotal minus discount plus tax, never negative, rounded.
  function grandTotal(items, discount, tax) {
    const d = Math.max(0, Number(discount || 0));
    const t = Math.max(0, Number(tax || 0));
    return roundMoney(Math.max(0, subtotal(items) - d + t));
  }

  // Total of payment amounts, rounded.
  function paidTotal(payments) {
    return roundMoney((payments || []).reduce((sum, payment) => (
      sum + Number(payment.amount || 0)
    ), 0));
  }

  // Canonical status (lowercase, matching the database). Display casing is a
  // UI concern and stays in the view/client layer.
  function paymentStatus(total, amountPaid) {
    const invoiceTotal = Number(total || 0);
    const paid = Number(amountPaid || 0);
    if (paid <= 0) {
      return 'unpaid';
    }
    return paid >= invoiceTotal ? 'paid' : 'partial';
  }

  return { roundMoney, subtotal, grandTotal, paidTotal, paymentStatus };
}));
