'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const checks = require('../scripts/verify-accounting');

function recordingPool(row) {
  let sql = '';
  return {
    pool: {
      query: async (value) => {
        sql = String(value);
        return { rows: [row] };
      },
    },
    sql: () => sql,
  };
}

test('accounting balance sheet verification includes posted inactive accounts', async () => {
  const recorder = recordingPool({
    assets: 100,
    liabilities: 40,
    equity: 10,
    income: 100,
    expenses: 50,
  });
  const result = await checks.balanceSheetCheck(recorder.pool);

  assert.equal(result.ok, true);
  assert.doesNotMatch(recorder.sql(), /account\.is_active/);
});

test('receivables verification includes manual journal receipts without double-counting linked payments', async () => {
  const recorder = recordingPool({
    invoice_total: 1000,
    paid_total: 400,
    expected_balance: 600,
    gl_balance: 600,
    difference: 0,
  });
  const result = await checks.accountsReceivableCheck(recorder.pool);
  const sql = recorder.sql();

  assert.equal(result.ok, true);
  assert.match(sql, /app_journal_entry_lines/);
  assert.match(sql, /app_invoice_payments linked_payment/);
  assert.match(sql, /journal\.docstatus = 'submitted'/);
  assert.match(sql, /setting_key = 'accounts_receivable'/);
});

test('inventory verification identifies stock entries without matching inventory accounting', async () => {
  let call = 0;
  const pool = {
    query: async () => {
      call += 1;
      if (call === 1) return { rows: [{ stock_value: 100, gl_balance: 60, difference: -40 }] };
      return {
        rows: [{
          id: 7,
          entry_no: 'STK-000007',
          entry_type: 'purchase',
          posting_date: '2026-01-02',
          stock_value: 40,
          inventory_value: 0,
          difference: 40,
        }],
      };
    },
  };
  const result = await checks.inventoryCheck(pool);

  assert.equal(result.ok, false);
  assert.equal(result.missing_stock_entries[0].entry_no, 'STK-000007');
  assert.equal(result.missing_stock_entries[0].difference, 40);
});
