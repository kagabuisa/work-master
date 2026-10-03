'use strict';
// Shared HTTP formatting helpers used by the route modules.

function money(value) {
  return Number(value || 0).toLocaleString('en-UG', {
    style: 'currency',
    currency: 'UGX',
    currencyDisplay: 'code',
    maximumFractionDigits: 0,
  }).replace('UGX', 'Ugx');
}

function purchaseMoney(value) {
  return `Ugx ${Number(value || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;
}

function paymentReturnPath(value, invoiceId) {
  const returnTo = String(value || '');
  if (returnTo.startsWith('/reports/debtors?') || returnTo.startsWith('/invoices?')) {
    return returnTo;
  }
  return `/invoices/${invoiceId}`;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { money, purchaseMoney, paymentReturnPath, todayString };
