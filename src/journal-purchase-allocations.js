'use strict';

const { roundMoney } = require('./lib/money');
const { dateOnly } = require('./lib/dates');

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function validatePurchaseAllocations(client, journal) {
  const referenced = (journal.lines || []).filter((line) => line.reference_no);
  if (!referenced.length) return [];
  if (journal.party_type !== 'supplier' || !journal.party_id) {
    throw invalid('Select a supplier before allocating purchase invoices on journal rows.');
  }
  if (!['payment_journal', 'journal_entry'].includes(journal.journal_type)) {
    throw invalid('Use a Payment Journal or Journal Entry to allocate supplier payments.');
  }
  const { rows: settings } = await client.query(
    "SELECT account_id FROM app_accounting_settings WHERE setting_key = 'accounts_payable'",
  );
  const payableId = Number(settings[0]?.account_id);
  const amounts = new Map();
  for (const line of referenced) {
    if (Number(line.account_id) !== payableId || Number(line.debit) <= 0 || Number(line.credit) > 0) {
      throw invalid('Purchase invoice references belong on debit rows of the Accounts Payable account. Leave the bank or cash reference blank.');
    }
    amounts.set(line.reference_no, roundMoney((amounts.get(line.reference_no) || 0) + Number(line.debit)));
  }
  const allocations = [];
  // Lock invoices in a stable order so simultaneous split payments cannot overpay.
  for (const [reference, amount] of [...amounts].sort(([a], [b]) => a.localeCompare(b))) {
    const { rows } = await client.query(`SELECT id, purchase_no, supplier_id, docstatus,
      posting_date::text, total::float, amount_paid::float FROM app_purchases
      WHERE purchase_no=$1 FOR UPDATE`, [reference]);
    const invoice = rows[0];
    if (!invoice || invoice.supplier_id !== journal.party_id) {
      throw invalid(`Purchase invoice ${reference} does not belong to the selected supplier.`);
    }
    if (invoice.docstatus !== 'submitted') throw invalid(`Submit purchase invoice ${reference} before allocating payment.`);
    if (dateOnly(journal.posting_date) < invoice.posting_date) {
      throw invalid(`Payment date cannot be before purchase invoice ${reference}'s date.`);
    }
    const balance = roundMoney(Number(invoice.total) - Number(invoice.amount_paid));
    if (amount > balance) throw invalid(`Payment allocation ${amount} exceeds the outstanding balance ${balance} for purchase invoice ${reference}.`);
    allocations.push({ invoice, amount });
  }
  return allocations;
}

async function postPurchaseAllocations(client, journal, allocations) {
  for (const { invoice, amount } of allocations) {
    await client.query(`INSERT INTO app_purchase_payments
      (purchase_id, payment_no, payment_date, amount, method, reference, notes, journal_entry_id)
      SELECT $1, COALESCE(MAX(payment_no), 0) + 1, $2, $3, 'journal', $4, $5, $6
      FROM app_purchase_payments WHERE purchase_id=$1`,
    [invoice.id, journal.posting_date, amount, journal.journal_no, journal.remarks || 'Journal payment allocation', journal.id]);
    const paid = roundMoney(Number(invoice.amount_paid) + amount);
    await client.query('UPDATE app_purchases SET amount_paid=$1, status=$2, updated_at=now() WHERE id=$3',
      [paid, paid >= Number(invoice.total) ? 'paid' : 'partial', invoice.id]);
  }
}

async function cancelPurchaseAllocations(client, journalId) {
  const { rows } = await client.query(`SELECT DISTINCT purchase_id FROM app_purchase_payments
    WHERE journal_entry_id=$1 AND docstatus='submitted' ORDER BY purchase_id`, [journalId]);
  for (const { purchase_id: purchaseId } of rows) {
    const { rows: invoices } = await client.query('SELECT total::float FROM app_purchases WHERE id=$1 FOR UPDATE', [purchaseId]);
    await client.query("UPDATE app_purchase_payments SET docstatus='cancelled' WHERE purchase_id=$1 AND journal_entry_id=$2 AND docstatus='submitted'", [purchaseId, journalId]);
    const { rows: totals } = await client.query(`SELECT COALESCE(SUM(amount), 0)::float AS paid
      FROM app_purchase_payments WHERE purchase_id=$1 AND docstatus='submitted'`, [purchaseId]);
    const paid = roundMoney(totals[0].paid);
    await client.query('UPDATE app_purchases SET amount_paid=$1, status=$2, updated_at=now() WHERE id=$3',
      [paid, paid >= Number(invoices[0].total) ? 'paid' : paid > 0 ? 'partial' : 'unpaid', purchaseId]);
  }
}

module.exports = { validatePurchaseAllocations, postPurchaseAllocations, cancelPurchaseAllocations };
