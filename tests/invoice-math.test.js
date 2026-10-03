'use strict';
// Shared invoice math: verifies the single source of truth used by both the
// server (Node) and the browser (via the InvoiceMath global).
const test = require('node:test');
const assert = require('node:assert/strict');
const invoiceMath = require('../src/shared/invoice-math');
const { roundMoney } = require('../src/lib/money');
const { sumPayments, paymentStatus } = require('../src/domain/normalization');

test('roundMoney rounds to whole UGX units', () => {
  assert.equal(invoiceMath.roundMoney(0.4), 0);
  assert.equal(invoiceMath.roundMoney(0.5), 1);
  assert.equal(invoiceMath.roundMoney(1234.6), 1235);
  assert.equal(invoiceMath.roundMoney('9'), 9);
  assert.equal(invoiceMath.roundMoney(undefined), 0);
  assert.equal(invoiceMath.roundMoney(null), 0);
});

test('subtotal sums quantity * unit_price', () => {
  const items = [{ quantity: 2, unit_price: 100 }, { quantity: 3, unit_price: 50.5 }];
  assert.equal(invoiceMath.subtotal(items), 351.5);
});

test('grandTotal is subtotal - discount + tax, clamped at zero and rounded', () => {
  const items = [{ quantity: 2, unit_price: 100 }, { quantity: 3, unit_price: 50.5 }];
  // subtotal 351.5, discount 40, tax 25 => 336.5 => 337
  assert.equal(invoiceMath.grandTotal(items, 40, 25), 337);
  // discount exceeding subtotal clamps to zero
  assert.equal(invoiceMath.grandTotal([{ quantity: 1, unit_price: 10 }], 500, 0), 0);
  // negative discount/tax are ignored
  assert.equal(invoiceMath.grandTotal([{ quantity: 1, unit_price: 10 }], -5, -3), 10);
});

test('paidTotal sums payment amounts', () => {
  assert.equal(invoiceMath.paidTotal([{ amount: 100 }, { amount: 50.5 }]), 151);
  assert.equal(invoiceMath.paidTotal([]), 0);
});

test('paymentStatus is unpaid/paid/partial', () => {
  assert.equal(invoiceMath.paymentStatus(100, 0), 'unpaid');
  assert.equal(invoiceMath.paymentStatus(100, 100), 'paid');
  assert.equal(invoiceMath.paymentStatus(100, 150), 'paid');
  assert.equal(invoiceMath.paymentStatus(100, 50), 'partial');
});

test('lib/money roundMoney shares the same source of truth', () => {
  for (const value of [0.4, 0.5, 1234.6, 9, undefined, null]) {
    assert.equal(roundMoney(value), invoiceMath.roundMoney(value));
  }
});

test('normalization paymentStatus matches the shared module', () => {
  for (const [total, paid] of [[100, 0], [100, 100], [100, 150], [100, 50], [0, 0]]) {
    assert.equal(paymentStatus(total, paid), invoiceMath.paymentStatus(total, paid));
  }
});

test('normalization sumPayments excludes cancelled payments', () => {
  const payments = [
    { amount: 100, docstatus: 'draft' },
    { amount: 50, docstatus: 'cancelled' },
    { amount: 25, docstatus: 'submitted' },
  ];
  assert.equal(sumPayments(payments), 125);
});
