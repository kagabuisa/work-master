'use strict';
// Read-only checks for historical inconsistencies. A balanced journal cannot
// establish that its prices or costs were correct; lost rate precision cannot
// be reconstructed reliably from today's price lists.
require('../src/environment').loadEnvironment();
const { getPostgresPool, closeStore } = require('../src/core');

async function main() {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const { rows } = await client.query(`SELECT
      (SELECT count(*)::int FROM app_stock_balances WHERE quantity=0 AND stock_value<>0) zero_quantity_with_value,
      (SELECT count(*)::int FROM app_stock_balances WHERE stock_value<0) negative_stock_values,
      (SELECT count(*)::int FROM app_invoices WHERE docstatus='submitted'
        AND total<>GREATEST(subtotal-discount_amount,0)+tax_amount) inconsistent_invoice_headers,
      (SELECT count(*)::int FROM app_invoice_items item JOIN app_invoices invoice ON invoice.id=item.invoice_pk
        WHERE invoice.docstatus='submitted' AND item.line_total<>round(item.quantity*item.unit_price)) inconsistent_invoice_lines,
      (SELECT count(*)::int FROM (SELECT voucher_type,voucher_id FROM app_gl_entries
        GROUP BY voucher_type,voucher_id HAVING sum(debit)<>sum(credit)) unbalanced) unbalanced_gl_vouchers`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ checks: rows[0], limitation: 'Historical price precision loss requires source-document review; no records changed.' }, null, 2));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await closeStore(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
