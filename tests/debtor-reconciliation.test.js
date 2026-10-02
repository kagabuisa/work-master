const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('debtor ageing and statements reconcile to posted Accounts Receivable', {
  skip: process.env.DEBTOR_TEST_POSTGRES !== '1',
}, async () => {
  try {
    const report = await store.debtorReport({ page_size: 200 });
    const { rows } = await store.getPostgresPool().query(`
      SELECT COALESCE(SUM(gl.debit - gl.credit), 0)::float AS balance
      FROM app_gl_entries gl
      JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
        AND setting.account_id = gl.account_id
    `);
    assert.equal(
      Math.round((report.summary.unallocated_balance
        + report.summary.allocated_balance) * 100),
      Math.round(Number(rows[0].balance) * 100),
    );
    for (const debtor of report.debtors) {
      const aged = debtor.current + debtor.days_1_30 + debtor.days_31_60
        + debtor.days_61_90 + debtor.days_over_90 + debtor.unallocated;
      assert.equal(Math.round(aged * 100), Math.round(debtor.balance_due * 100));
      const detail = await store.debtorReport({ customer: debtor.customer_key });
      assert.equal(
        Math.round(Number(detail.statement.at(-1)?.balance || 0) * 100),
        Math.round(debtor.balance_due * 100),
      );
    }
  } finally {
    await store.closeStore();
  }
});
