'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { resetGoldenSchema } = require('./helpers/golden-seed');

test('manual journal entries allow contra lines while preventing opposite normal balances', {
  skip: process.env.JOURNAL_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await resetGoldenSchema();
    const accounts = await store.accountingAccounts();
    const cash = accounts.find((account) => account.account_code === '1110');
    const equity = accounts.find((account) => account.account_code === '3000');
    const expense = accounts.find((account) => account.account_code === '5000');
    const taxPayable = accounts.find((account) => account.account_code === '2200');
    const payload = (debitAccount, creditAccount, amount = 10) => ({
      journal_type: 'journal_entry',
      posting_date: '2026-01-15',
      lines: [
        { account_id: debitAccount.id, debit: amount },
        { account_id: creditAccount.id, credit: amount },
      ],
    });

    await store.createJournalEntry(payload(cash, equity, 100));
    await store.createJournalEntry(payload(expense, cash, 60));
    for (const journalType of ['journal_entry', 'cash_receipt', 'payment_journal', 'sales_invoice']) {
      await assert.rejects(store.createJournalEntry({ ...payload(expense, cash, 41), journal_type: journalType }), {
        status: 400,
        message: 'Cash (1110) would have a credit balance of 1 after posting, but its normal balance is debit.',
      });
    }

    const draftId = await store.createJournalEntry(payload(expense, cash, 41), { submit: false });
    await store.updateJournalEntry(draftId, payload(expense, cash, 42));
    await assert.rejects(store.submitJournalEntry(draftId), {
      status: 400,
      message: 'Cash (1110) would have a credit balance of 2 after posting, but its normal balance is debit.',
    });

    await assert.rejects(store.createJournalEntry(payload(equity, taxPayable, 101)), {
      status: 400,
      message: 'Opening Equity (3000) would have a debit balance of 1 after posting, but its normal balance is credit.',
    });
    await store.createJournalEntry(payload(equity, taxPayable, 100));

    const concurrent = await Promise.allSettled([
      store.createJournalEntry(payload(expense, cash, 30)),
      store.createJournalEntry(payload(expense, cash, 30)),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
    assert.match(concurrent.find((result) => result.status === 'rejected').reason.message,
      /Cash \(1110\) would have a credit balance of 20 after posting/);
  } finally {
    await store.closeStore();
  }
});

test('journal cancellation reverses on the original posting date', {
  skip: process.env.JOURNAL_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await resetGoldenSchema();
    const accounts = await store.accountingAccounts();
    const cash = accounts.find((account) => account.account_code === '1110');
    const equity = accounts.find((account) => account.account_code === '3000');
    const id = await store.createJournalEntry({
      journal_type: 'journal_entry',
      posting_date: '2026-01-15',
      lines: [{ account_id: cash.id, debit: 100 }, { account_id: equity.id, credit: 100 }],
    });
    await store.cancelJournalEntry(id);

    const pool = store.getPostgresPool();
    const cancellationDates = (await pool.query(
      `SELECT DISTINCT posting_date::text AS posting_date
       FROM app_gl_entries
       WHERE voucher_type = 'journal_entry_cancellation' AND voucher_id = $1`,
      [id],
    )).rows.map((row) => row.posting_date);
    assert.deepEqual(cancellationDates, ['2026-01-15']);
    const balance = (await pool.query(
      'SELECT COALESCE(SUM(debit - credit), 0)::text AS balance FROM app_gl_entries WHERE account_id = $1',
      [cash.id],
    )).rows[0].balance;
    assert.equal(Number(balance), 0);
    assert.ok(Number((await pool.query(
      'SELECT EXTRACT(EPOCH FROM cancelled_at) AS cancelled_at FROM app_journal_entries WHERE id = $1',
      [id],
    )).rows[0].cancelled_at));
  } finally {
    await store.closeStore();
  }
});
