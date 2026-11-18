'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/store');
const { seedGoldenData, normalizeGolden } = require('./helpers/golden-seed');
const { buildGoldenReports } = require('./helpers/golden-reports');

const REFRESH_HINT = [
  'Golden accounting reports changed.',
  '',
  'If the change is intentional, regenerate the committed snapshot and include it',
  'in the same commit as the code change:',
  '',
  '  POSTGRES_DB=work_master_golden npm run golden:update',
  '',
  'If it is not intentional, the diff below is the regression.',
  '',
].join('\n');

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

    const reports = await buildGoldenReports();
    const ar = reports.trialBalance.rows.find((row) => row.account_code === '1100');
    assert.equal(ar.closing_debit, 394, 'Accounts Receivable closing balance');

    const actual = normalizeGolden(reports);
    try {
      assert.deepEqual(actual, fixture);
    } catch (error) {
      throw new Error(`${REFRESH_HINT}\n${error.message}`, { cause: error });
    }
  } finally {
    await store.closeStore();
  }
});
