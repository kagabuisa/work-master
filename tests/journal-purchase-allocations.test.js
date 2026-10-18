'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePurchaseAllocations } = require('../src/journal-purchase-allocations');
const { normalizeJournalEntryPayload } = require('../src/domain/normalization');

function setup() {
  const invoices = {
    'PUR-000001': { id: 1, purchase_no: 'PUR-000001', supplier_id: 'SUP-1', docstatus: 'submitted', posting_date: '2026-10-01', total: 100, amount_paid: 20 },
    'PUR-000002': { id: 2, purchase_no: 'PUR-000002', supplier_id: 'SUP-1', docstatus: 'submitted', posting_date: '2026-10-01', total: 50, amount_paid: 0 },
  };
  const client = { async query(sql, params) {
    if (sql.includes('app_accounting_settings')) return { rows: [{ account_id: '5' }] };
    assert.match(sql, /FOR UPDATE/);
    return { rows: invoices[params[0]] ? [invoices[params[0]]] : [] };
  } };
  const journal = { journal_type: 'payment_journal', party_type: 'supplier', party_id: 'SUP-1', posting_date: '2026-10-02', lines: [
    { account_id: 5, debit: 40, reference_no: 'PUR-000001' },
    { account_id: 5, debit: 40, reference_no: 'PUR-000001' },
    { account_id: 5, debit: 50, reference_no: 'PUR-000002' },
    { account_id: 6, credit: 130 },
  ] };
  return { client, journal, invoices };
}

test('split supplier payments preserve references and aggregate allocations per invoice', async () => {
  const { client, journal } = setup();
  const normalized = normalizeJournalEntryPayload(journal);
  assert.equal(normalized.lines[0].reference_no, 'PUR-000001');
  assert.deepEqual((await validatePurchaseAllocations(client, normalized)).map(({ amount }) => amount), [80, 50]);
});

test('supplier allocations reject wrong parties, unsubmitted invoices, dates, accounts and aggregate overpayment', async () => {
  const { client, journal, invoices } = setup();
  await assert.rejects(validatePurchaseAllocations(client, { ...journal, party_type: 'customer' }), /Select a supplier/);
  await assert.rejects(validatePurchaseAllocations(client, { ...journal, party_id: 'SUP-2' }), /does not belong/);
  await assert.rejects(validatePurchaseAllocations(client, { ...journal, posting_date: '2026-09-30' }), /Payment date/);
  journal.lines[1].debit = 41;
  await assert.rejects(validatePurchaseAllocations(client, journal), /allocation 81 exceeds.*80/);
  journal.lines[1].debit = 40;
  invoices['PUR-000001'].docstatus = 'draft';
  await assert.rejects(validatePurchaseAllocations(client, journal), /Submit purchase invoice/);
  invoices['PUR-000001'].docstatus = 'submitted';
  journal.lines[0].account_id = 6;
  await assert.rejects(validatePurchaseAllocations(client, journal), /Accounts Payable/);
  assert.deepEqual(await validatePurchaseAllocations(client, { lines: [] }), []);
});

test('Postgres journal allocations persist, update invoice balances, reverse together and prevent concurrent overpayment', {
  skip: process.env.JOURNAL_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { resetGoldenSchema } = require('./helpers/golden-seed');
  const purchases = require('../src/purchases');
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    const accounts = (await pool.query("SELECT setting_key, account_id FROM app_accounting_settings WHERE setting_key IN ('accounts_payable', 'bank')")).rows;
    const accountId = (key) => Number(accounts.find((row) => row.setting_key === key).account_id);
    await pool.query(`INSERT INTO app_master_cost_centers (cost_center, cost_center_name, disabled, docstatus)
      VALUES ('JOURNAL-CC', 'Journal Cost Center', false, 'submitted')`);
    for (const [no, total] of [['PUR-A', 100], ['PUR-B', 200]]) {
      await pool.query(`INSERT INTO app_purchases (purchase_no, posting_date, supplier_id, supplier_name, subtotal, total, docstatus)
        VALUES ($1, '2026-10-01', 'SUP-1', 'Supplier One', $2, $2, 'submitted')`, [no, total]);
    }
    const payload = { journal_type: 'payment_journal', cost_center: 'JOURNAL-CC', party_type: 'supplier', party_id: 'SUP-1', party_name: 'Supplier One', posting_date: '2026-10-02', lines: [
      { account_id: accountId('accounts_payable'), debit: 100, reference_no: 'PUR-A' },
      { account_id: accountId('accounts_payable'), debit: 150, reference_no: 'PUR-B' },
      { account_id: accountId('bank'), credit: 250 },
    ] };
    const balances = async () => (await pool.query('SELECT purchase_no, amount_paid::float, status FROM app_purchases ORDER BY purchase_no')).rows;
    const id = await store.createJournalEntry(payload, { submit: false });
    assert.equal((await balances())[0].amount_paid, 0);
    const loaded = await store.findJournalEntry(id);
    assert.equal(loaded.cost_center, 'JOURNAL-CC');
    assert.deepEqual(loaded.lines.map((line) => line.reference_no), ['PUR-A', 'PUR-B', null]);
    const reorderedLines = payload.lines.map((line, index) => ({ ...line, id: loaded.lines[index].id })).reverse();
    await store.updateJournalEntry(id, { ...payload, lines: reorderedLines });
    const reordered = await store.findJournalEntry(id);
    assert.equal(reordered.cost_center, 'JOURNAL-CC');
    assert.deepEqual(reordered.lines.map((line) => Number(line.id)), reorderedLines.map((line) => Number(line.id)));
    assert.deepEqual(reordered.lines.map((line) => line.reference_no || ''), reorderedLines.map((line) => line.reference_no || ''));
    assert.equal((await store.findJournalEntry(id)).lines[1].reference_no, 'PUR-B');
    await store.submitJournalEntry(id);
    const listed = (await store.journalEntries({ search: 'PUR-A' })).find((journal) => journal.id === id);
    assert.ok(listed, 'search finds journals through invoice references on rows');
    assert.equal(listed.source_references, 'PUR-A, PUR-B');
    assert.equal((await store.journalEntries({ search: 'PUR-B' })).some((journal) => journal.id === id), true);

    assert.deepEqual(await balances(), [
      { purchase_no: 'PUR-A', amount_paid: 100, status: 'paid' },
      { purchase_no: 'PUR-B', amount_paid: 150, status: 'partial' },
    ]);
    assert.equal((await pool.query('SELECT id FROM app_purchase_payments WHERE journal_entry_id=$1', [id])).rowCount, 2);
    assert.equal((await pool.query('SELECT id FROM app_gl_entries WHERE voucher_id=$1 AND voucher_type=$2', [id, 'payment_journal'])).rowCount, 3);
    const invoice = await purchases.loadPurchase(1);
    assert.equal(Number(invoice.payments[0].journal_entry_id), id);
    await assert.rejects(purchases.cancelPurchasePayment(1, invoice.payments[0].payment_no), /Cancel the linked journal/);
    await assert.rejects(store.submitJournalEntry(id), /Only draft/);
    await store.cancelJournalEntry(id);
    assert.deepEqual((await balances()).map((row) => row.amount_paid), [0, 0]);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_purchase_payments WHERE docstatus='submitted'")).rows[0].count, 0);
    assert.equal((await pool.query('SELECT account_id FROM app_gl_entries GROUP BY account_id HAVING SUM(debit-credit) <> 0')).rowCount, 0);
    const concurrent = await Promise.allSettled([store.createJournalEntry(payload), store.createJournalEntry(payload)]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match(concurrent.find((result) => result.status === 'rejected').reason.message, /exceeds the outstanding/);
    assert.equal((await balances())[0].amount_paid, 100);
    const references = await store.journalReferenceOptions({ party_type: 'supplier', party_id: 'SUP-1', purchaseInvoicesOnly: true, outstandingOnly: true });
    assert.deepEqual(references.map((row) => row.reference), ['PUR-B']);
    assert.deepEqual(await store.journalReferenceOptions({ party_type: 'supplier', party_id: 'SUP-2', purchaseInvoicesOnly: true }), []);
    await require('../src/audit').runWithAuditUser({ id: 'owner-one', username: 'Owner One' }, () =>
      pool.query("INSERT INTO app_purchases (purchase_no, posting_date, supplier_id, supplier_name, total, docstatus) VALUES ('PUR-OWNED', '2026-10-01', 'SUP-1', 'Supplier One', 10, 'submitted')"));
    const owned = await store.journalReferenceOptions({ party_type: 'supplier', party_id: 'SUP-1', purchaseInvoicesOnly: true, ownerId: 'owner-one', search: 'PUR-OWNED' });
    assert.deepEqual(owned.map((row) => row.reference), ['PUR-OWNED']);
    assert.deepEqual(await store.journalReferenceOptions({ party_type: 'supplier', party_id: 'SUP-1', purchaseInvoicesOnly: true, ownerId: 'other-owner', search: 'PUR-OWNED' }), []);
  } finally { await store.closeStore(); }
});

test('invoice supplier payments generate journals, repair legacy postings once, and reverse balances', {
  skip: process.env.JOURNAL_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const purchases = require('../src/purchases');
  const { backfillPurchasePaymentJournals } = require('../src/purchase-payment-posting');
  try {
    await require('./helpers/golden-seed').resetGoldenSchema();
    const pool = store.getPostgresPool();
    const { rows } = await require('../src/audit').runWithAuditUser({ id: '1234', username: 'invoice-owner' }, () => pool.query(`INSERT INTO app_purchases
      (purchase_no, posting_date, supplier_id, supplier_name, subtotal, total, docstatus)
      VALUES ('PUR-PAY', '2026-10-01', 'SUP-1', 'Supplier One', 100, 100, 'submitted') RETURNING id`));
    const id = Number(rows[0].id);
    const account = (await pool.query(`INSERT INTO app_accounts
      (account_code, account_name, account_type, account_detail_type, normal_balance, is_group, is_active)
      VALUES ('1999', 'Supplier Payments Bank', 'asset', 'Bank', 'debit', false, true) RETURNING id, account_name`)).rows[0];
    const payload = { payment_date: '2026-10-02', amount: 40, account_id: String(account.id), reference: 'BANK-REF' };
    const user = { role: 'standard', scopes: { accounts: { mode: 'selected', values: [String(account.id)] } } };
    const { requireReceiptAccount } = require('../src/services/sales-validation');
    requireReceiptAccount(user, payload.account_id);
    assert.throws(() => requireReceiptAccount(user, '99999999'), { status: 403 });
    assert.throws(() => requireReceiptAccount(user, ''), { status: 400 });
    await pool.query('UPDATE app_accounts SET is_active=false WHERE id=$1', [account.id]);
    await assert.rejects(purchases.addPurchasePayment(id, payload), /active cash or bank/);
    await pool.query('UPDATE app_accounts SET is_active=true WHERE id=$1', [account.id]);
    const allowed = await store.receivingAccounts(require('../src/web/helpers').accountAccessOptions(user));
    assert.deepEqual(allowed.map(row => Number(row.id)), [Number(account.id)]);
    await purchases.addPurchasePayment(id, payload);
    let invoice = await purchases.loadPurchase(id);
    const payment = invoice.payments[0];
    assert.equal(Number(payment.account_id), Number(account.id));
    assert.equal(payment.account_name, 'Supplier Payments Bank');
    const html = await require('./helpers/render-view').renderView(require('node:path').join(__dirname, '../views/purchase.ejs'), {
      purchase: invoice, receiptAccounts: allowed, today: '2026-10-02', assetVersion: 'test',
      currentUser: { role: 'admin' }, can: () => true, availableReports: [], money: String, error: null,
    });
    assert.match(html, /name="account_id" required/);
    assert.match(html, /Supplier Payments Bank/);
    assert.doesNotMatch(html, /name="method"/);

    assert.match(payment.reference, /^JRN-\d+$/);
    const journal = await store.findJournalEntry(payment.journal_entry_id);
    assert.equal(journal.docstatus, 'submitted');
    assert.equal(journal.party_type, 'supplier');
    assert.equal(journal.remarks, 'BANK-REF');
    assert.equal(journal.lines[0].reference_no, 'PUR-PAY');
    assert.equal(Number(journal.lines[0].debit), 40);
    assert.equal(Number(journal.lines[1].credit), 40);
    assert.equal(Number(journal.lines[1].account_id), Number(account.id));
    assert.equal((await pool.query("SELECT * FROM app_gl_entries WHERE voucher_type='payment_journal' AND voucher_id=$1", [journal.id])).rowCount, 2);
    const filters = { voucher_type: 'payment_journal', voucher_id: String(journal.id) };
    assert.equal((await store.generalLedgerReport(filters)).rows.length, 2);
    assert.equal((await store.generalLedgerReport(filters, { ownerId: '1234' })).rows.length, 2);
    assert.equal((await store.generalLedgerReport(filters, { ownerId: '9999' })).rows.length, 0);
    await assert.rejects(store.cancelJournalEntry(journal.id), /purchase invoice/);
    await purchases.cancelPurchasePayment(id, payment.payment_no);
    assert.equal((await purchases.loadPurchase(id)).amount_paid, 0);
    assert.equal((await store.findJournalEntry(journal.id)).docstatus, 'cancelled');
    const legacy = await pool.query(`INSERT INTO app_purchase_payments
      (purchase_id, payment_no, payment_date, amount, method) VALUES ($1, 2, '2026-10-03', 30, 'cash') RETURNING id`, [id]);
    await pool.query("UPDATE app_purchases SET amount_paid=30, status='partial' WHERE id=$1", [id]);
    await store.withPostgresTransaction(async (client) => {
      await store.postGlEntry(client, { posting_date: '2026-10-03', voucher_type: 'purchase_payment',
        voucher_id: legacy.rows[0].id, lines: [{ account_key: 'accounts_payable', debit: 30 }, { account_key: 'cash', credit: 30 }] });
      await backfillPurchasePaymentJournals(client);
      await backfillPurchasePaymentJournals(client);
    });
    invoice = await purchases.loadPurchase(id);
    assert.equal(invoice.amount_paid, 30);
    assert.match(invoice.payments[1].reference, /^JRN-\d+$/);
    assert.equal((await pool.query("SELECT * FROM app_gl_entries WHERE voucher_type='purchase_payment'")).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM app_journal_entries')).rowCount, 2);
    await purchases.cancelPurchase(id);
    assert.equal((await pool.query('SELECT account_id FROM app_gl_entries GROUP BY account_id HAVING SUM(debit-credit) <> 0')).rowCount, 0);
  } finally { await store.closeStore(); }
});
