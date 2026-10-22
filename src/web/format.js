'use strict';
// Shared HTTP formatting helpers used by the route modules.

const currencyFormat = new Intl.NumberFormat('en-UG', {
  style: 'currency', currency: 'UGX', currencyDisplay: 'code', maximumFractionDigits: 0,
});
const numberFormat = new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 });
function money(value) {
  return currencyFormat.format(Number(value || 0)).replace('UGX', 'Ugx');
}
function purchaseMoney(value) {
  return `Ugx ${numberFormat.format(Number(value || 0))}`;
}

function rateMoney(value) {
  const [whole, decimal] = String(require('../lib/money').storedRateValue(value)).split('.');
  return `Ugx ${numberFormat.format(Number(whole))}${decimal ? '.' + decimal : ''}`;
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

module.exports = { money, rateMoney, purchaseMoney, paymentReturnPath, todayString };
