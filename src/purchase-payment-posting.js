'use strict';

const { postGlEntry, reverseVoucherGlEntries, resolveAccountingAccounts,
  syncGeneratedJournalEntryLines, setVoucherDocstatus, paymentAccountKey } = require('./domain/posting');
const { currentPostingTime } = require('./posting-time');

async function postPurchasePaymentJournal(client, purchase, payment) {
  const remarks = [payment.reference, payment.notes].filter(Boolean).join(' — ') || `Payment for ${purchase.purchase_no}`;
  const amount = Number(payment.amount);
  const lines = [
    { account_key: 'accounts_payable', debit: amount, credit: 0, remarks },
    { ...(payment.account_id ? { account_id: Number(payment.account_id) }
      : { account_key: paymentAccountKey(payment.method) }), debit: 0, credit: amount, remarks },
  ];
  const accountIds = await resolveAccountingAccounts(client, lines);
  const { rows } = await client.query(`INSERT INTO app_journal_entries
    (journal_type, posting_date, posting_time, party_type, party_id, party_name,
     reference_no, remarks, total_debit, total_credit, cost_center)
    VALUES ('payment_journal', $1, $2, 'supplier', $3, $4, $5, $6, $7, $7, $8) RETURNING id`,
  [payment.payment_date, currentPostingTime(), purchase.supplier_id, purchase.supplier_name,
    purchase.purchase_no, remarks, amount, purchase.cost_center]);
  const id = Number(rows[0].id);
  const reference = `JRN-${String(id).padStart(6, '0')}`;
  await client.query('UPDATE app_journal_entries SET journal_no=$1 WHERE id=$2', [reference, id]);
  await setVoucherDocstatus(client, 'app_journal_entries', id, 'submitted');
  await syncGeneratedJournalEntryLines(client, id, lines, accountIds);
  await client.query(`UPDATE app_journal_entry_lines SET reference_no=$1
    WHERE journal_entry_id=$2 AND line_no=1`, [purchase.purchase_no, id]);
  await postGlEntry(client, { posting_date: payment.payment_date, cost_center: purchase.cost_center,
    voucher_type: 'payment_journal', voucher_id: id, voucher_no: reference,
    party_type: 'supplier', party_id: purchase.supplier_id, party_name: purchase.supplier_name,
    remarks, lines: lines.map((line, index) => ({ ...line, account_id: accountIds[index] })) });
  await client.query("DELETE FROM app_gl_entries WHERE voucher_type='purchase_payment' AND voucher_id=$1", [payment.id]);
  await client.query('UPDATE app_purchase_payments SET journal_entry_id=$1, reference=$2 WHERE id=$3',
    [id, reference, payment.id]);
}

async function reversePurchasePayment(client, payment, date) {
  if (payment.journal_entry_id) {
    await reverseVoucherGlEntries(client, 'payment_journal', payment.journal_entry_id, date);
    await setVoucherDocstatus(client, 'app_journal_entries', payment.journal_entry_id, 'cancelled');
  } else {
    await reverseVoucherGlEntries(client, 'purchase_payment', payment.id, date);
  }
}

async function backfillPurchasePaymentJournals(client) {
  const { rows } = await client.query(`SELECT payment.*, payment.payment_date::text,
    purchase.purchase_no, purchase.supplier_id, purchase.supplier_name, purchase.cost_center
    FROM app_purchase_payments payment JOIN app_purchases purchase ON purchase.id=payment.purchase_id
    WHERE payment.docstatus='submitted' AND payment.journal_entry_id IS NULL ORDER BY payment.id`);
  for (const payment of rows) await postPurchasePaymentJournal(client, payment, payment);
}

module.exports = { postPurchasePaymentJournal, reversePurchasePayment, backfillPurchasePaymentJournals };
