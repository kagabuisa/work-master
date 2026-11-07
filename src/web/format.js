'use strict';
// Shared HTTP formatting helpers used by the route modules.

const currencyFormat = new Intl.NumberFormat('en-UG', {
  style: 'currency', currency: 'UGX', currencyDisplay: 'code', maximumFractionDigits: 0,
});
const numberFormat = new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 });
const financialFormat = new Intl.NumberFormat('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SMALL_NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER_GROUPS = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];

function money(value) {
  return currencyFormat.format(Number(value || 0)).replace('UGX', 'Ugx');
}
function purchaseMoney(value) {
  return `Ugx ${numberFormat.format(Number(value || 0))}`;
}
function financialMoney(value) {
  return `Ugx ${financialFormat.format(Number(value || 0))}`;
}

function rateMoney(value) {
  const [whole, decimal] = String(require('../lib/money').storedRateValue(value)).split('.');
  return `Ugx ${numberFormat.format(Number(whole))}${decimal ? '.' + decimal : ''}`;
}

function underOneThousand(value) {
  const number = Math.trunc(value);
  const parts = [];
  if (number >= 100) {
    parts.push(`${SMALL_NUMBER_WORDS[Math.floor(number / 100)]} hundred`);
    if (number % 100) parts.push('and');
  }
  const remainder = number % 100;
  if (remainder < 20) {
    if (remainder) parts.push(SMALL_NUMBER_WORDS[remainder]);
  } else {
    const tens = TENS_WORDS[Math.floor(remainder / 10)];
    const units = remainder % 10;
    parts.push(units ? `${tens}-${SMALL_NUMBER_WORDS[units]}` : tens);
  }
  return parts.join(' ');
}

function integerInWords(value) {
  let number = Math.trunc(value);
  if (!number) return SMALL_NUMBER_WORDS[0];
  const groups = [];
  let groupIndex = 0;
  while (number > 0 && groupIndex < NUMBER_GROUPS.length) {
    const groupValue = number % 1000;
    if (groupValue) {
      const words = underOneThousand(groupValue);
      groups.unshift(`${words}${NUMBER_GROUPS[groupIndex] ? ` ${NUMBER_GROUPS[groupIndex]}` : ''}`);
    }
    number = Math.floor(number / 1000);
    groupIndex += 1;
  }
  if (number > 0) return numberFormat.format(value);
  return groups.join(' ');
}

function amountInWords(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  const negative = amount < 0;
  const rounded = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(rounded / 100);
  const cents = rounded % 100;
  let words = `${integerInWords(whole)} Ugx`;
  if (cents) words += ` and ${integerInWords(cents)} ${cents === 1 ? 'cent' : 'cents'}`;
  words = `${negative ? 'minus ' : ''}${words} only`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function paymentReturnPath(value, invoiceId) {
  const returnTo = String(value || '');
  if (returnTo.startsWith('/reports/debtors?') || returnTo.startsWith('/invoices?')) {
    return returnTo;
  }
  return `/invoices/${invoiceId}`;
}

function todayString() {
  return require('../posting-time').currentPostingDate();
}

module.exports = {
  money, rateMoney, purchaseMoney, financialMoney, amountInWords, paymentReturnPath, todayString,
};
