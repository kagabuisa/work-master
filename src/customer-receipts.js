'use strict';

async function reclassifyInvoicePaymentReceipts(client) {
  const linked = `
    SELECT DISTINCT payment.journal_entry_id
    FROM app_invoice_payments payment
    WHERE payment.journal_entry_id IS NOT NULL
  `;

  const journals = await client.query(`
    UPDATE app_journal_entries journal
    SET journal_type = 'cash_receipt',
      received_from = COALESCE(NULLIF(journal.received_from, ''), NULLIF(journal.party_name, '')),
      paid_to = NULL
    WHERE journal.id IN (${linked})
      AND journal.journal_type = 'payment_journal'
    RETURNING journal.id
  `);

  const ledger = await client.query(`
    UPDATE app_gl_entries gl
    SET voucher_type = CASE gl.voucher_type
        WHEN 'payment_journal' THEN 'cash_receipt'
        WHEN 'payment_journal_cancellation' THEN 'cash_receipt_cancellation'
        ELSE gl.voucher_type
      END,
      reversal_of_voucher_type = CASE gl.reversal_of_voucher_type
        WHEN 'payment_journal' THEN 'cash_receipt'
        ELSE gl.reversal_of_voucher_type
      END
    WHERE (
        gl.voucher_type IN ('payment_journal', 'payment_journal_cancellation')
        AND gl.voucher_id IN (${linked})
      )
      OR (
        gl.reversal_of_voucher_type = 'payment_journal'
        AND gl.reversal_of_voucher_id IN (${linked})
      )
  `);

  return {
    journals: journals.rowCount,
    ledger_entries: ledger.rowCount,
  };
}

module.exports = { reclassifyInvoicePaymentReceipts };
