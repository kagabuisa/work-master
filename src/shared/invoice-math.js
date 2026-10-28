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

  function invalidAmount(message) {
    const error = new Error(message || 'Enter a finite amount within supported storage bounds.');
    error.status = 400;
    return error;
  }

  // Parse decimal text before arithmetic. Number inputs are supported for legacy
  // callers, but rates received as strings must never pass through Number first.
  function fraction(value) {
    const text = String(value == null || value === '' ? 0 : value).trim();
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
    if (!match || !(match[2] || match[3]) || text.length > 400) throw invalidAmount();
    const exponent = Number(match[4] || 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 308) throw invalidAmount();
    const scale = (match[3] || '').length - exponent;
    const digits = BigInt((match[2] || '') + (match[3] || ''));
    const numerator = (match[1] === '-' ? -digits : digits) * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
    return [numerator, scale > 0 ? 10n ** BigInt(scale) : 1n];
  }

  // Round half away from zero, matching PostgreSQL numeric round(). Whole UGX
  // values stay safe integers; intermediate multiplication/division uses BigInt.
  function roundedRatio(numerator, denominator) {
    if (denominator <= 0n) throw invalidAmount();
    const sign = numerator < 0n ? -1n : 1n;
    const absolute = numerator * sign;
    const result = Number(sign * ((absolute * 2n + denominator) / (2n * denominator)));
    if (!Number.isSafeInteger(result)) throw invalidAmount();
    return result;
  }

  function roundMoney(value) {
    return roundedRatio.apply(null, fraction(value));
  }

  function decimalValue(value, places, maximum) {
    const parts = fraction(value), scale = 10n ** BigInt(places);
    const bound = fraction(maximum);
    if (parts[0] < 0n || parts[0] * scale % parts[1] !== 0n
      || parts[0] * bound[1] > bound[0] * parts[1]) throw invalidAmount();
    const scaled = parts[0] * scale / parts[1];
    const decimal = String(scaled % scale).padStart(places, '0').replace(/0+$/, '');
    return `${scaled / scale}${decimal ? '.' + decimal : ''}`;
  }

  function multiplyMoney(left, right) {
    const a = fraction(left), b = fraction(right);
    return roundedRatio(a[0] * b[0], a[1] * b[1]);
  }

  function prorateMoney(value, quantity, totalQuantity) {
    const a = fraction(value), b = fraction(quantity), c = fraction(totalQuantity);
    return roundedRatio(a[0] * b[0] * c[1], a[1] * b[1] * c[0]);
  }

  function formatRate(parts) {
    if (parts[0] * 1000000n % parts[1] !== 0n) {
      throw invalidAmount('Enter a nonnegative rate up to 999999999999 with at most six decimal places.');
    }
    const scaled = parts[0] * 1000000n / parts[1];
    const absolute = scaled < 0n ? -scaled : scaled;
    const decimal = String(absolute % 1000000n).padStart(6, '0').replace(/0+$/, '');
    // Preserve the existing number shape for whole rates; fractional rates stay
    // decimal strings, including values beyond IEEE-754's fractional precision.
    return decimal ? `${scaled < 0n ? '-' : ''}${absolute / 1000000n}.${decimal}` : Number(scaled / 1000000n);
  }

  function storedRateValue(value) {
    // Historical read/display paths retain signed saved rates. New inputs use
    // rateValue's business bounds instead of making old documents unreadable.
    return formatRate(fraction(value));
  }

  function rateValue(value) {
    const parts = fraction(value);
    if (parts[0] < 0n || parts[0] > 999999999999n * parts[1]) {
      throw invalidAmount('Enter a nonnegative rate up to 999999999999 with at most six decimal places.');
    }
    return formatRate(parts);
  }

  function lineTotal(item) {
    return multiplyMoney(item.quantity, rateValue(item.unit_price));
  }

  function subtotal(items) {
    return roundMoney((items || []).reduce((sum, item) => sum + lineTotal(item), 0));
  }

  function invoiceTotals(items, discount, tax) {
    const amount = subtotal(items);
    const d = Math.min(amount, Math.max(0, roundMoney(discount)));
    const t = Math.max(0, roundMoney(tax));
    return { subtotal: amount, discount_amount: d, tax_amount: t, total: roundMoney(amount - d + t) };
  }

  function grandTotal(items, discount, tax) {
    return invoiceTotals(items, discount, tax).total;
  }

  // Total of payment amounts, rounded.
  function paidTotal(payments) {
    return roundMoney((payments || []).reduce((sum, payment) => (
      sum + roundMoney(payment.amount)
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

  return { roundMoney, multiplyMoney, prorateMoney, rateValue, storedRateValue, decimalValue, lineTotal, subtotal, invoiceTotals,
    grandTotal, paidTotal, paymentStatus };
}));
