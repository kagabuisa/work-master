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

test('subtotal sums individually rounded quantity * unit_price amounts', () => {
  const items = [{ quantity: 2, unit_price: 100 }, { quantity: 3, unit_price: 50.5 }];
  assert.equal(invoiceMath.subtotal(items), 352);
});

test('grandTotal is subtotal - discount + tax, clamped at zero and rounded', () => {
  const items = [{ quantity: 2, unit_price: 100 }, { quantity: 3, unit_price: 50.5 }];
  // Rounded lines total 352, discount 40, tax 25 => 337.
  assert.equal(invoiceMath.grandTotal(items, 40, 25), 337);
  // discount exceeding subtotal clamps to zero
  assert.equal(invoiceMath.grandTotal([{ quantity: 1, unit_price: 10 }], 500, 0), 0);
  // negative discount/tax are ignored
  assert.equal(invoiceMath.grandTotal([{ quantity: 1, unit_price: 10 }], -5, -3), 10);
});

test('exact decimal line arithmetic and signed half rounding match PostgreSQL', () => {
  assert.equal(invoiceMath.lineTotal({ quantity: '1.005', unit_price: '100' }), 101);
  assert.equal(invoiceMath.lineTotal({ quantity: '1000', unit_price: '1.234567' }), 1235);
  assert.equal(invoiceMath.lineTotal({ quantity: '0.001', unit_price: '999999999998.999999' }), 1000000000);
  assert.equal(invoiceMath.rateValue('999999999998.999999'), '999999999998.999999');
  assert.equal(invoiceMath.rateValue('100.000000'), 100);
  assert.equal(invoiceMath.roundMoney('-0.5'), -1);
  assert.equal(invoiceMath.roundMoney('-100.5'), -101);
  for (const rate of ['NaN', 'Infinity', '-1', '0.1234567', '1000000000000']) {
    assert.throws(() => invoiceMath.rateValue(rate));
  }
  assert.throws(() => invoiceMath.roundMoney('9007199254740992'));
});

test('preview and save use identical line, adjustment and discount-cap rules', () => {
  const { buildInvoiceData, normalizeInvoiceTotals } = require('../src/domain/normalization');
  const item = { item_code: 'EXACT', item_name: 'Exact item', quantity: '0.005', unit_price: '100' };
  const payload = { invoice_date: '2026-01-15', items: [item, item], discount_amount: '0.49', tax_amount: '0.50' };
  const invoice = buildInvoiceData(payload);
  assert.equal(invoice.total, 3);
  assert.equal(invoice.total, invoiceMath.grandTotal(payload.items, payload.discount_amount, payload.tax_amount));
  assert.equal(invoice.total, invoice.subtotal - invoice.discount_amount + invoice.tax_amount);
  assert.deepEqual(invoiceMath.invoiceTotals([item], '500', '1'),
    { subtotal: 1, discount_amount: 1, tax_amount: 1, total: 1 });
  const historical = normalizeInvoiceTotals({ items: [item], subtotal: 500, discount_amount: 0, tax_amount: 0, total: 500 });
  assert.equal(historical.subtotal, 500);
  assert.equal(historical.total, 500, 'reading a saved invoice must not reprice its header');
  const historicalLine = normalizeInvoiceTotals({ items: [{ ...item, line_total: 123 }], subtotal: 123, total: 123 });
  assert.equal(historicalLine.items[0].line_total, 123);
  const signed = normalizeInvoiceTotals({ items: [{ ...item, unit_price: '-0.25', line_total: -1 }], subtotal: 123, total: 123 });
  assert.equal(signed.items[0].unit_price, '-0.25', 'historical signed rates remain readable');
  assert.equal(signed.items[0].line_total, -1);
});

test('stock issues use the locked value, with exact depletion and no rounded-rate drift', () => {
  assert.equal(invoiceMath.prorateMoney('302', '3', '3'), 302);
  assert.equal(invoiceMath.prorateMoney('302', '1', '3'), 101);
  assert.equal(invoiceMath.prorateMoney('201', '2', '2'), 201);
  assert.equal(invoiceMath.prorateMoney('800', '3', '15'), 160);
});

test('browser global and server share exact invoice calculations without external dependencies', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const context = { self: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/shared/invoice-math'), 'utf8'), context);
  for (const items of [[{ quantity: '1.005', unit_price: '100' }],
    [{ quantity: '1000', unit_price: '1.234567' }],
    [{ quantity: '.005', unit_price: 100 }, { quantity: '.005', unit_price: 100 }]]) {
    assert.equal(context.self.InvoiceMath.grandTotal(items, '.49', '.50'), invoiceMath.grandTotal(items, '.49', '.50'));
  }
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
