'use strict';
// Single source of truth for the golden-master report set.
//
// Shared by tests/golden-accounting.test.js (which asserts against the snapshot)
// and scripts/capture-golden.js (which rewrites it), so a report added here is
// always covered by both the check and the refresh command.

const store = require('../../src/store');
const { normalizeGolden } = require('./golden-seed');

async function buildGoldenReports() {
  return {
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
}

async function captureGoldenReports() {
  return normalizeGolden(await buildGoldenReports());
}

module.exports = { buildGoldenReports, captureGoldenReports };
