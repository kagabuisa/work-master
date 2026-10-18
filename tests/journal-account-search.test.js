const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { journalAccountMatches } = require('../public/journal-account-match');
const { scriptJson } = require('../src/web/script-json');
const { normalizeJournalEntryPayload, validateJournalAccountSides } = require('../src/domain/normalization');

test('saved journal details and drawer show cost center and distinct line references without a header reference', async () => {
  const locals = {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], journal: { id: 1, journal_no: 'JRN-000001', journal_type: 'payment_journal',
      cost_center: 'JOURNAL-CC', lines: [{ account_id: 5, reference_no: 'PUR-A' },
        { account_id: 5, reference_no: 'PUR-B' }, { account_id: 5, reference_no: 'PUR-A' }] },
    accounts: [], error: null, readOnly: true, today: '2026-10-02', money: String,
    currentPostingTime: () => '12:00', scriptJson,
  };
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), locals);
  assert.match(html, /value="JOURNAL-CC"/);
  assert.match(html, /value="PUR-A, PUR-B" readonly aria-label="References"/);
  const drawer = await renderView(path.join(__dirname, '..', 'views', 'journal-drawer.ejs'),
    { ...locals, journalTypeLabel: () => 'Payment Journal' });
  assert.match(drawer, /<span>Cost Center<\/span><strong>JOURNAL-CC<\/strong>/);
  assert.match(drawer, /<span>References<\/span><strong>PUR-A, PUR-B<\/strong>/);
  const editable = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'),
    { ...locals, readOnly: false, accounts: [{ id: 5, account_code: '2101', account_name: 'Payable' }] });
  assert.match(editable, /value="JOURNAL-CC"/);
  assert.match(editable, /name="line_reference_no" value="PUR-A"/);
  assert.match(editable, /name="line_reference_no" value="PUR-B"/);
});

test('journal cannot debit and credit the same account', () => {
  const payload = { journal_type: 'journal_entry', posting_date: '2026-10-07', posting_time: '12:00',
    lines: [{ account_id: 5, debit: 100 }, { account_id: 5, credit: 100 }] };
  assert.throws(() => normalizeJournalEntryPayload(payload), {
    status: 400, message: 'The same account cannot be used for both debit and credit in one journal.',
  });
  assert.throws(() => validateJournalAccountSides([
    { account_id: 5, debit: 100, credit: 0 }, { account_id: '5', debit: 0, credit: 100 },
  ]), { status: 400 });

  const valid = normalizeJournalEntryPayload({ ...payload, lines: [
    { account_id: 5, debit: 60 }, { account_id: 5, debit: 40 }, { account_id: 6, credit: 100 },
  ] });
  assert.equal(valid.lines.length, 3);
});

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
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], journal: { lines: [{ account_id: 5, debit: 100 }, {}] },
    accounts: [{ id: 5, account_code: '1102', account_name: 'Main Bank Account' }],
    error: null, readOnly: false, today: '2026-10-02', money: String,
    currentPostingTime: () => '12:00', formatTimestamp: String,
    scriptJson,
  });
  assert.match(html, /data-account-search/);
  assert.match(html, /name="line_reference_no"/);
  assert.match(html, /list="journal-purchase-invoices"/);
  assert.match(html, /name="account_id" value="5"/);
  assert.match(html, /value="Main Bank Account"/);
  assert.match(html, /journal-account-match\.js/);
  assert.match(html, /journal-entry\.js\?v=test/);
  const accountData = html.match(/<script id="journal-account-data" type="application\/json">([^<]*)<\/script>/);
  assert(accountData);
  assert.deepEqual(JSON.parse(accountData[1]), [{ id: '5', code: '1102', name: 'Main Bank Account' }]);
  assert.doesNotMatch(html, /data-account-results/);
});
