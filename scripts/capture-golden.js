'use strict';
// Seeds a fresh *_golden database and captures the money-critical reports into
// tests/fixtures/golden-reports.json. Re-run after any intentional behaviour change
// to regenerate the golden master.

process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '55432';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'work_master_golden';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || '';

const fs = require('node:fs');
const path = require('node:path');
const { seedGoldenData, normalizeGolden } = require('../tests/helpers/golden-seed');
const store = require('../src/store');

async function main() {
  const summary = await seedGoldenData();
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
  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'golden-reports.json'), JSON.stringify(normalizeGolden(reports), null, 2));
  console.log('captured golden-reports.json');
  console.log('seed summary:', JSON.stringify(summary));
  await store.closeStore();
  process.exit(0);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
