const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { journalAccountMatches } = require('../public/journal-account-match');
const { scriptJson } = require('../src/web/script-json');

test('journal account search matches code and name with percent wildcards', () => {
  const account = { code: '1102', name: 'Main Bank Account' };
  assert.equal(journalAccountMatches(account, '110'), true);
  assert.equal(journalAccountMatches(account, 'bank'), true);
  assert.equal(journalAccountMatches(account, '11%02'), true);
  assert.equal(journalAccountMatches(account, 'main%account'), true);
  assert.equal(journalAccountMatches(account, '%bank%'), true);
  assert.equal(journalAccountMatches(account, '11%99'), false);
  assert.equal(journalAccountMatches(account, 'main.*account'), false);
});

test('editable journal lines render account search with a separate account id', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], journal: { lines: [{ account_id: 5, debit: 100 }, {}] },
    accounts: [{ id: 5, account_code: '1102', account_name: 'Main Bank Account' }],
    error: null, readOnly: false, today: '2026-10-02', money: String,
    currentPostingTime: () => '12:00', formatTimestamp: String,
    scriptJson,
  });
  assert.match(html, /data-account-search/);
  assert.match(html, /name="account_id" value="5"/);
  assert.match(html, /value="1102 - Main Bank Account"/);
  assert.match(html, /journal-account-match\.js/);
  assert.match(html, /journal-entry\.js\?v=test/);
  const accountData = html.match(/<script id="journal-account-data" type="application\/json">([^<]*)<\/script>/);
  assert(accountData);
  assert.deepEqual(JSON.parse(accountData[1]), [{ id: '5', code: '1102', name: 'Main Bank Account' }]);
  assert.doesNotMatch(html, /data-account-results/);
});
