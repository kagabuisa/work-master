'use strict';
// Money helpers. UGX is a zero-decimal currency, so money is rounded to whole
// units everywhere — this single source of truth keeps that consistent.
// roundMoney is shared with the browser via src/shared/invoice-math.js.
const { roundMoney } = require('../shared/invoice-math');

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

module.exports = { roundMoney, numberValue, roundReportMoney };
