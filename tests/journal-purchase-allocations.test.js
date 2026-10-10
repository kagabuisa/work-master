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
    for (const [no, total] of [['PUR-A', 100], ['PUR-B', 200]]) {
      await pool.query(`INSERT INTO app_purchases (purchase_no, posting_date, supplier_id, supplier_name, subtotal, total, docstatus)
        VALUES ($1, '2026-10-01', 'SUP-1', 'Supplier One', $2, $2, 'submitted')`, [no, total]);
    }
    const payload = { journal_type: 'payment_journal', party_type: 'supplier', party_id: 'SUP-1', party_name: 'Supplier One', posting_date: '2026-10-02', lines: [
      { account_id: accountId('accounts_payable'), debit: 100, reference_no: 'PUR-A' },
      { account_id: accountId('accounts_payable'), debit: 150, reference_no: 'PUR-B' },
      { account_id: accountId('bank'), credit: 250 },
    ] };
    const balances = async () => (await pool.query('SELECT purchase_no, amount_paid::float, status FROM app_purchases ORDER BY purchase_no')).rows;
    const id = await store.createJournalEntry(payload, { submit: false });
    assert.equal((await balances())[0].amount_paid, 0);
    const loaded = await store.findJournalEntry(id);
    assert.deepEqual(loaded.lines.map((line) => line.reference_no), ['PUR-A', 'PUR-B', null]);
    await store.updateJournalEntry(id, { ...payload, lines: payload.lines.map((line, index) => ({ ...line, id: loaded.lines[index].id })) });
    assert.equal((await store.findJournalEntry(id)).lines[1].reference_no, 'PUR-B');
    await store.submitJournalEntry(id);
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
