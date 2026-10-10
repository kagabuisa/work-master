'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/store');
const { seedGoldenData, normalizeGolden } = require('./helpers/golden-seed');

// Golden-master safety net: re-seeds a fresh *_golden database and asserts the
// money-critical reports are byte-identical to the committed snapshot. Any
// structural refactor that changes a single posted figure trips this test.
test('accounting reports stay byte-identical to the golden master', {
  skip: process.env.GOLDEN_TEST_POSTGRES !== '1',
}, async () => {
  try {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'golden-reports.json'), 'utf8'),
    );

    const seed = await seedGoldenData();

    // Fast, human-readable spot checks before the full deep comparison.
    assert.deepEqual(seed, { openingId: 1, purchaseId: 2, adjustmentId: 3, invoiceId: 1, journalId: 3 });

    const reports = {
      accounts: await store.accountingAccounts(),
      journals: await store.journalEntries({}),
      trialBalance: await store.trialBalanceReport({}),
      profitAndLoss: await store.profitAndLossReport({}),
      balanceSheet: await store.balanceSheetReport({}),
      generalLedger: await store.generalLedgerReport({}),
      stockLedger: await store.stockLedgerReport({}),
      stockMovement: await store.stockMovementReport({}),
      grossProfit: await store.grossProfitReport({}),
      debtor: await store.debtorReport({ page_size: 200 }),
    };

    const ar = reports.trialBalance.rows.find((row) => row.account_code === '1100');
    assert.equal(ar.closing_debit, 394, 'Accounts Receivable closing balance');

    const actual = normalizeGolden(reports);
    assert.deepEqual(actual, fixture);
  } finally {
    await store.closeStore();
  }
});
