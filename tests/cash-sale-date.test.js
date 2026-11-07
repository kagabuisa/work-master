'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cashSalePaymentData } = require('../src/domain/sales');

test('cash sale payment always uses the saved invoice posting date', () => {
  const payment = cashSalePaymentData({
    invoice_date: '2026-11-06',
    total: 250,
  }, {
    payment_date: '2026-10-01',
    amount: 250,
    account_id: 7,
  });

  assert.equal(payment.payment_date, '2026-11-06');
  assert.equal(payment.amount, 250);
});

test('cash sale UI does not expose an editable payment date', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/cash-sale.js'), 'utf8');
  assert.doesNotMatch(source, /name="payment_date"/);
  assert.match(source, /data-cash-date/);
  assert.match(source, /payment uses the invoice posting date/i);
});
