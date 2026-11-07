const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { journalAccountMatches } = require('../public/journal-account-match');
const { scriptJson } = require('../src/web/script-json');
const { amountInWords } = require('../src/web/format');
const {
  normalizeJournalEntryPayload,
  validateJournalAccountSides,
  validateJournalProjectedBalances,
} = require('../src/domain/normalization');

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
  assert.match(html, /id="received-from-field" hidden/);
  assert.match(html, /<label id="paid-to-field" >/);
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

  const receipt = normalizeJournalEntryPayload({ ...payload, journal_type: 'cash_receipt',
    received_from: '  Walk-in payer  ', lines: [
      { account_id: 5, debit: 100 }, { account_id: 6, credit: 100 },
    ] });
  assert.equal(receipt.received_from, 'Walk-in payer');
  const payment = normalizeJournalEntryPayload({ ...payload, journal_type: 'payment_journal',
    received_from: 'Not applicable', paid_to: '  Example Payee  ', lines: [
      { account_id: 5, debit: 100 }, { account_id: 6, credit: 100 },
    ] });
  assert.equal(payment.received_from, null);
  assert.equal(payment.paid_to, 'Example Payee');
  assert.throws(() => normalizeJournalEntryPayload({ ...payload, journal_type: 'cash_receipt',
    received_from: 'x'.repeat(151), lines: [
      { account_id: 5, debit: 100 }, { account_id: 6, credit: 100 },
    ] }), /Received from must be 150 characters or fewer/);
  assert.throws(() => normalizeJournalEntryPayload({ ...payload, journal_type: 'payment_journal',
    paid_to: 'x'.repeat(151), lines: [
      { account_id: 5, debit: 100 }, { account_id: 6, credit: 100 },
    ] }), /Paid to must be 150 characters or fewer/);
});

test('journal entry postings cannot cross an account normal balance', () => {
  const accounts = [
    { id: 5, account_code: '1110', account_name: 'Cash', normal_balance: 'debit', balance: '100' },
    { id: 6, account_code: '3000', account_name: 'Opening Equity', normal_balance: 'credit', balance: '-100' },
  ];
  assert.doesNotThrow(() => validateJournalProjectedBalances([
    { account_id: 5, debit: 0, credit: 40 },
    { account_id: 6, debit: 40, credit: 0 },
  ], accounts));
  assert.doesNotThrow(() => validateJournalProjectedBalances([
    { account_id: 5, debit: 0, credit: 100 },
    { account_id: 6, debit: 100, credit: 0 },
  ], accounts));
  assert.throws(() => validateJournalProjectedBalances([
    { account_id: 5, debit: 0, credit: 101 },
    { account_id: 6, debit: 101, credit: 0 },
  ], accounts), {
    status: 400,
    message: 'Cash (1110) would have a credit balance of 1 after posting, but its normal balance is debit.',
  });
  assert.throws(() => validateJournalProjectedBalances([
    { account_id: 6, debit: 101, credit: 0 },
  ], [accounts[1]]), {
    status: 400,
    message: 'Opening Equity (3000) would have a debit balance of 1 after posting, but its normal balance is credit.',
  });
});

test('submitted manual journals expose cancel in the full-view action bar', async () => {
  const locals = {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} },
    can: () => true, availableReports: [], accounts: [], error: null, readOnly: true,
    today: '2026-10-02', money: String, currentPostingTime: () => '12:00',
    formatTimestamp: String, scriptJson, journalTypeLabel: () => 'Journal Entry', sharing: null,
    journal: {
      id: 12, journal_no: 'JRN-000012', journal_type: 'journal_entry', docstatus: 'submitted',
      posting_date: '2026-10-02', posting_time: '12:00', can_cancel: true,
      total_debit: 100, total_credit: 100,
      lines: [{ account_id: 5, account_name: 'Cash', debit: 100 }, { account_id: 6, account_name: 'Equity', credit: 100 }],
    },
  };
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), locals);
  assert.match(html, /<form method="post" action="\/journals\/12\/cancel"/);
  assert.match(html, />Print<\/a>/);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, />Duplicate<\/a>/);
  assert.match(html, />New<\/a>/);
  assert.ok(html.indexOf('>Print</a>') < html.indexOf('>Cancel</button>'));
  assert.ok(html.indexOf('>Cancel</button>') < html.indexOf('>Duplicate</a>'));
  assert.ok(html.indexOf('>Duplicate</a>') < html.indexOf('>New</a>'));

  const generated = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    ...locals, journal: { ...locals.journal, journal_type: 'sales_invoice', can_cancel: false },
  });
  assert.doesNotMatch(generated, /\/journals\/12\/cancel/);
  assert.match(generated, /\/journals\/12\/print/);
  assert.match(generated, /\/journals\/12\/duplicate/);
  assert.match(generated, /Automatically generated journals are cancelled from their source document\./);
});

test('journal drawer exposes print, cancel, duplicate and new actions', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-drawer.ejs'), {
    currentUser: { role: 'admin', scopes: {}, username: 'admin' }, can: () => true,
    journalTypeLabel: () => 'Journal Entry', money: String, costCenterName: String,
    formatDateTime: (date, time) => `${date} ${time}`, formatTimestamp: String, sharing: null,
    journal: {
      id: 12, journal_no: 'JRN-000012', journal_type: 'journal_entry', docstatus: 'submitted',
      posting_date: '2026-10-02', posting_time: '12:00', can_cancel: true,
      total_debit: 100, total_credit: 100,
      lines: [{ account_id: 5, account_name: 'Cash', debit: 100 }, { account_id: 6, account_name: 'Equity', credit: 100 }],
    },
  });
  assert.match(html, /href="\/journals\/12\/print"[^>]*>Print<\/a>/);
  assert.match(html, /action="\/journals\/12\/cancel"[^>]*>[\s\S]*?<button[^>]*>Cancel<\/button>/);
  assert.match(html, /href="\/journals\/12\/duplicate">Duplicate<\/a>/);
  assert.match(html, /href="\/journals\/new"[^>]*>New<\/a>/);
});

test('journal print view renders its lines and totals', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-print.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {}, username: 'admin' }, can: () => true,
    journalTypeLabel: () => 'Journal Entry', money: value => `UGX ${value}`,
    amountInWords, preparedBy: 'journal-maker', company: { name: 'Example Company' },
    journal: {
      id: 12, journal_no: 'JRN-000012', journal_type: 'journal_entry', docstatus: 'submitted',
      posting_date: '2026-10-02', posting_time: '12:00', remarks: 'Printed journal',
      total_debit: 100, total_credit: 100,
      lines: [
        { account_code: '1110', account_name: 'Cash', debit: 100, credit: 0 },
        { account_code: '3000', account_name: 'Equity', debit: 0, credit: 100 },
      ],
    },
  });
  assert.match(html, /Example Company/);
  assert.match(html, /1110 · Cash/);
  assert.match(html, /UGX 100/);
  assert.match(html, /data-print-page/);
  assert.match(html, />journal-maker</);
  assert.match(html, />Prepared by</);
  assert.match(html, /Approved by/);
});

test('journal print uses a party receipt for cash receipts and a payment voucher for payment journals', async () => {
  const common = {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {}, username: 'viewer' }, can: () => true,
    money: value => `UGX ${value}`, amountInWords, preparedBy: 'accounts-user',
    company: { name: 'Example Company' }, formatDateTime: (date, time) => `${date} ${time}`,
    journal: {
      id: 20, journal_no: 'JRN-000020', docstatus: 'submitted',
      posting_date: '2026-10-02', posting_time: '12:00', party_type: 'customer',
      party_id: 'CUST-001', party_name: 'Example Customer', reference_no: 'INV-0007',
      received_from: 'Walk-in payer', paid_to: 'Example Payee',
      remarks: 'Settlement of invoice INV-0007', total_debit: 1250, total_credit: 1250,
      lines: [
        { account_code: '1120', account_name: 'Main Bank Account', account_detail_type: 'Bank',
          debit: 1250, credit: 0, reference_no: 'INV-0007' },
        { account_code: '1200', account_name: 'Accounts Receivable',
          debit: 0, credit: 1250, remarks: 'Part payment for INV-0007', reference_no: 'INV-0007' },
      ],
    },
  };
  const receipt = await renderView(path.join(__dirname, '..', 'views', 'journal-print.ejs'), {
    ...common,
    receiptBalance: 500,
    journalTypeLabel: () => 'Cash Receipt',
    journal: { ...common.journal, journal_type: 'cash_receipt' },
  });
  assert.match(receipt, /<title>Cash Receipt JRN-000020<\/title>/);
  assert.match(receipt, />Received from</);
  assert.match(receipt, />Walk-in payer</);
  assert.match(receipt, />Amount received</);
  assert.match(receipt, /One thousand two hundred and fifty Ugx only/);
  assert.match(receipt, /class="voucher-print-paid-stamp"[^>]*>PAID</);
  assert.match(receipt, />Balance outstanding</);
  assert.match(receipt, /UGX 500/);
  assert.match(receipt, />Receipt account</);
  assert.match(receipt, />Bank</);
  assert.doesNotMatch(receipt, /Main Bank Account|1120|Accounting entry/);
  assert.match(receipt, />Date</);
  assert.doesNotMatch(receipt, /Posting date \/ time/);
  assert.match(receipt, /Part payment for INV-0007/);
  assert.doesNotMatch(receipt, /Payment for INV-0007/);
  assert.match(receipt, />Total</);
  assert.match(receipt, />Payer \/ authorised representative</);
  assert.match(receipt, />Received by \(Cashier\)</);
  assert.match(receipt, />accounts-user</);

  const cashReceipt = await renderView(path.join(__dirname, '..', 'views', 'journal-print.ejs'), {
    ...common,
    receiptBalance: 500,
    journalTypeLabel: () => 'Cash Receipt',
    journal: {
      ...common.journal,
      journal_type: 'cash_receipt',
      lines: [
        { account_code: '1110', account_name: 'Cash', account_detail_type: 'Cash',
          debit: 1250, credit: 0, remarks: 'Part payment' },
        { account_code: '1200', account_name: 'Accounts Receivable',
          debit: 0, credit: 1250, remarks: 'Part payment' },
      ],
    },
  });
  assert.match(cashReceipt, />Cash</);
  assert.equal((cashReceipt.match(/Part payment/g) || []).length, 1);
  assert.doesNotMatch(cashReceipt, /Posting date \/ time|Accounting entry/);

  const settledReceipt = await renderView(path.join(__dirname, '..', 'views', 'journal-print.ejs'), {
    ...common,
    receiptBalance: 0,
    journalTypeLabel: () => 'Cash Receipt',
    journal: { ...common.journal, journal_type: 'cash_receipt' },
  });
  assert.match(settledReceipt, /class="voucher-print-paid-stamp"[^>]*>PAID</);
  assert.doesNotMatch(settledReceipt, /Balance outstanding/);

  const voucher = await renderView(path.join(__dirname, '..', 'views', 'journal-print.ejs'), {
    ...common,
    journalTypeLabel: () => 'Payment Journal',
    journal: {
      ...common.journal, journal_type: 'payment_journal', party_type: 'supplier',
      party_id: 'SUP-001', party_name: 'Example Supplier',
      remarks: 'Supplier account settlement',
      lines: [
        { account_code: '2100', account_name: 'Accounts Payable', debit: 1250, credit: 0,
          remarks: 'Supplier account settlement', reference_no: 'PUR-0007' },
        { account_code: '1120', account_name: 'Main Bank Account', account_detail_type: 'Bank',
          debit: 0, credit: 1250, remarks: 'Supplier account settlement', reference_no: 'PUR-0007' },
      ],
    },
  });
  assert.match(voucher, /<title>Payment Voucher JRN-000020<\/title>/);
  assert.match(voucher, />Pay to</);
  assert.match(voucher, />Example Payee</);
  assert.match(voucher, />Amount paid</);
  assert.match(voucher, /One thousand two hundred and fifty Ugx only/);
  assert.match(voucher, />Payment account</);
  assert.match(voucher, />Bank</);
  assert.doesNotMatch(voucher, /Main Bank Account|1120|Accounting entry|Posting date \/ time/);
  assert.match(voucher, />Date</);
  assert.match(voucher, /Supplier account settlement/);
  assert.equal((voucher.match(/Supplier account settlement/g) || []).length, 1);
  assert.doesNotMatch(voucher, /Payment for PUR-0007/);
  assert.doesNotMatch(voucher, /voucher-print-paid-stamp|Balance outstanding/);
  assert.match(voucher, />Total</);
  assert.match(voucher, />Approved by</);
  assert.match(voucher, />Paid by \(Cashier\)</);
  assert.match(voucher, />Payee \/ authorised representative</);
  assert.match(voucher, />accounts-user</);
});

test('formats payment amounts in words for printed journals', () => {
  assert.equal(amountInWords(0), 'Zero Ugx only');
  assert.equal(amountInWords(1250), 'One thousand two hundred and fifty Ugx only');
  assert.equal(amountInWords(1234.56), 'One thousand two hundred and thirty-four Ugx and fifty-six cents only');
  assert.equal(amountInWords(100), 'One hundred Ugx only');
  assert.equal(amountInWords(-999.99), 'Minus nine hundred and ninety-nine Ugx and ninety-nine cents only');
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
    accounts: [{ id: 5, account_code: '1102', account_name: 'Main Bank Account', normal_balance: 'debit' }],
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
  assert.deepEqual(JSON.parse(accountData[1]), [{
    id: '5', code: '1102', name: 'Main Bank Account', normal_balance: 'debit',
  }]);
  assert.doesNotMatch(html, /data-account-results/);
});

test('cash receipt form captures a manually entered received from value', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], journal: {
      journal_type: 'cash_receipt', received_from: 'Walk-in payer',
      posting_date: '2026-10-02', posting_time: '12:00', lines: [{}, {}],
    },
    accounts: [{ id: 5, account_code: '1110', account_name: 'Cash', normal_balance: 'debit' }],
    error: null, readOnly: false, today: '2026-10-02', money: String,
    currentPostingTime: () => '12:00', formatTimestamp: String, scriptJson,
  });
  assert.match(html, /<label id="received-from-field" >/);
  assert.match(html, /name="received_from" id="received-from" maxlength="150"/);
  assert.match(html, /value="Walk-in payer"/);
  assert.match(html, /placeholder="Enter the payer's name"/);
});

test('payment voucher form captures a manually entered paid to value', async () => {
  const html = await renderView(path.join(__dirname, '..', 'views', 'journal-entry.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} }, can: () => true,
    availableReports: [], journal: {
      journal_type: 'payment_journal', paid_to: 'Example Payee',
      posting_date: '2026-10-02', posting_time: '12:00', lines: [{}, {}],
    },
    accounts: [{ id: 5, account_code: '1110', account_name: 'Cash', normal_balance: 'credit' }],
    error: null, readOnly: false, today: '2026-10-02', money: String,
    currentPostingTime: () => '12:00', formatTimestamp: String, scriptJson,
  });
  assert.match(html, /<label id="paid-to-field" >/);
  assert.match(html, /name="paid_to" id="paid-to" maxlength="150"/);
  assert.match(html, /value="Example Payee"/);
  assert.match(html, /placeholder="Enter the payee's name"/);
});
