'use strict';

// Financial statements include two-decimal HR postings. Keep calculations in
// integer hundredths; whole-UGX invoice/stock rounding remains a separate policy.
function minor(value) {
  const text = String(value || 0);
  const match = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(text);
  if (!match) throw new Error('Financial amount must have at most two decimal places.');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0')));
}
function amount(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Financial report exceeds supported monetary bounds.');
  }
  return Number(value) / 100;
}
const reportMoney = value => amount(minor(value));
const subtractMoney = (left, right) => amount(minor(left) - minor(right));
const sumMoney = (rows, key) => amount(rows.reduce((sum, row) => sum + minor(row[key]), 0n));
module.exports = { minor, amount, reportMoney, subtractMoney, sumMoney };
