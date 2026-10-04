const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('debtor ageing and statements reconcile to posted Accounts Receivable', {
  skip: process.env.DEBTOR_TEST_POSTGRES !== '1',
}, async () => {
  try {
    const report = await store.debtorReport({ page_size: 200 });
    const { rows } = await store.getPostgresPool().query(`
      SELECT COALESCE(SUM(gl.debit - gl.credit), 0)::float AS balance
      FROM app_gl_entries gl
      JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
        AND setting.account_id = gl.account_id
    `);
    assert.equal(
      Math.round((report.summary.unallocated_balance
        + report.summary.allocated_balance) * 100),
      Math.round(Number(rows[0].balance) * 100),
    );
    for (const debtor of report.debtors) {
      const aged = debtor.current + debtor.days_1_30 + debtor.days_31_60
        + debtor.days_61_90 + debtor.days_over_90 + debtor.unallocated;
      assert.equal(Math.round(aged * 100), Math.round(debtor.balance_due * 100));
      const detail = await store.debtorReport({ customer: debtor.customer_key });
      assert.equal(
        Math.round(Number(detail.statement.at(-1)?.balance || 0) * 100),
        Math.round(debtor.balance_due * 100),
      );
    }

    const { rows: postedInvoices } = await store.getPostgresPool().query(`
      SELECT invoice.id, invoice.invoice_no,
        COALESCE(NULLIF(invoice.customer_id, ''), invoice.customer_name) AS customer_key
      FROM app_invoices invoice
      WHERE invoice.docstatus = 'submitted'
        AND EXISTS (
          SELECT 1 FROM app_gl_entries gl
          JOIN app_accounting_settings setting ON setting.setting_key = 'accounts_receivable'
            AND setting.account_id = gl.account_id
          WHERE gl.voucher_type = 'sales_invoice' AND gl.voucher_id = invoice.id
        )
    `);
    const invoicesByCustomer = new Map();
    for (const invoice of postedInvoices) {
      const invoices = invoicesByCustomer.get(invoice.customer_key) || [];
      invoices.push(invoice);
      invoicesByCustomer.set(invoice.customer_key, invoices);
    }
    for (const [customer, invoices] of invoicesByCustomer) {
      const detail = await store.debtorReport({ customer });
      const statementInvoices = detail.statement.filter((entry) => entry.type === 'Invoice');
      assert.equal(statementInvoices.length, invoices.length, `invoice rows for ${customer}`);
      for (const invoice of invoices) {
        const matches = statementInvoices.filter((entry) => entry.reference === invoice.invoice_no);
        assert.equal(matches.length, 1, `statement row for ${invoice.invoice_no}`);
        assert.equal(matches[0].invoice_id, Number(invoice.id));
      }
    }
  } finally {
    await store.closeStore();
  }
});
