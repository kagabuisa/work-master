'use strict';
// UGX amounts round to whole units. Selling rates retain six decimal places;
// quantity × rate and stock-value proportions round only after exact arithmetic.
// roundMoney is shared with the browser via src/shared/invoice-math.js.
const { roundMoney, multiplyMoney, prorateMoney, rateValue, storedRateValue } = require('../shared/invoice-math');

function numberValue(value) {
  return Number(value || 0);
}

const REPORT_MONEY_KEYS = [
  'invoice_total',
  'paid_total',
  'balance_due',
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_over_90',
  'unallocated',
  'sales_amount',
  'cost_amount',
  'gross_profit',
];

function roundReportMoney(row) {
  for (const key of REPORT_MONEY_KEYS) {
    row[key] = roundMoney(row[key]);
  }
  return row;
}

module.exports = { roundMoney, multiplyMoney, prorateMoney, rateValue, storedRateValue, numberValue, roundReportMoney };
