'use strict';

// These exact expressions are shared by the candidate predicates and GIN indexes.
// The final per-field predicates retain wildcard anchoring and prevent matches
// across concatenated field boundaries from changing search results.
function invoiceSearchSql(alias = '') {
  const q = alias ? `${alias}.` : '';
  return `LOWER(COALESCE(${q}invoice_no, '') || ' ' || COALESCE(${q}non_system_invoice, '') || ' ' || ${q}customer_name || ' ' || COALESCE(${q}docstatus, ''))`;
}
function journalSearchSql(alias = '') {
  const q = alias ? `${alias}.` : '';
  return `LOWER(COALESCE(${q}journal_no, '') || ' ' || ${q}journal_type || ' ' || CASE
    WHEN ${q}journal_type = 'cash_receipt' THEN 'Cash Receipt'
    WHEN ${q}journal_type = 'payment_journal' THEN 'Payment Journal'
    WHEN ${q}journal_type = 'sales_invoice' THEN 'Sales Invoice' ELSE 'Journal Entry' END || ' ' ||
    COALESCE(${q}party_type, '') || ' ' || COALESCE(${q}party_id, '') || ' ' || COALESCE(${q}party_name, '') || ' ' ||
    COALESCE(${q}reference_no, '') || ' ' || COALESCE(${q}remarks, '') || ' ' || COALESCE(${q}docstatus, 'submitted'))`;
}
function likeMatches(pattern, text) {
  let expression = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    let character = pattern[i];
    if (character === '\\') {
      character = pattern[++i];
      if (character === undefined) return true; // Leave invalid LIKE patterns to PostgreSQL.
    } else if (character === '%') { expression += '.*'; continue; }
    else if (character === '_') { expression += '.'; continue; }
    expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$', 'su').test(text);
}
function textOnlyPattern(pattern) {
  // ISO dates/numeric amounts cannot contain these literal letters. Keep the
  // fallback for patterns that could match dates, BC/infinity, or amounts.
  return /[adeghjklmopqrsuvwxz]/i.test(pattern);
}
function invoiceTextOnlyPattern(pattern) {
  return textOnlyPattern(pattern) && !['unpaid', 'paid', 'partial'].some(value => likeMatches(pattern, value));
}
async function createSearchIndexes(pool, concurrently = false) {
  const mode = concurrently ? ' CONCURRENTLY' : '';
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const [name, definition] of [
    ['app_invoices_search_trgm_idx', `ON app_invoices USING gin ((${invoiceSearchSql()}) gin_trgm_ops)`],
    ['app_journals_search_trgm_idx', `ON app_journal_entries USING gin ((${journalSearchSql()}) gin_trgm_ops)`],
    ['app_journals_sales_reference_idx', "ON app_journal_entries (reference_no, id) WHERE journal_type = 'sales_invoice'"],
    ['app_journals_customer_payments_idx', `ON app_journal_entries (party_id, party_name, id)
      WHERE party_type = 'customer' AND journal_type IN ('cash_receipt', 'payment_journal', 'journal_entry')
        AND docstatus IN ('submitted', 'cancelled')`],
  ]) {
    // A failed concurrent build leaves an invalid index which IF NOT EXISTS
    // would otherwise silently retain on retry.
    const { rows } = await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`, [name]);
    if (rows[0] && !rows[0].indisvalid) await pool.query(`DROP INDEX${mode} ${name}`);
    await pool.query(`CREATE INDEX${mode} IF NOT EXISTS ${name} ${definition}`);
  }
  // Expression-index statistics are needed before the first historical search.
  await pool.query('ANALYZE app_invoices');
  await pool.query('ANALYZE app_journal_entries');
}
module.exports = { invoiceSearchSql, journalSearchSql, likeMatches, textOnlyPattern, invoiceTextOnlyPattern, createSearchIndexes };

async function createPaymentJournalIndex(pool) {
  const name='app_invoice_payments_journal_idx';
  const { rows }=await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`,[name]);
  if(rows[0]&&!rows[0].indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
    ON app_invoice_payments(journal_entry_id) WHERE journal_entry_id IS NOT NULL`);
  await pool.query('ANALYZE app_invoice_payments');
}
module.exports.createPaymentJournalIndex=createPaymentJournalIndex;

async function createJournalLineReferenceIndex(pool) {
  const name='app_journal_lines_reference_idx';
  const { rows }=await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`,[name]);
  if(rows[0]&&!rows[0].indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
    ON app_journal_entry_lines(reference_no,journal_entry_id)
    WHERE reference_no IS NOT NULL AND reference_no<>''`);
  await pool.query('ANALYZE app_journal_entry_lines');
}
module.exports.createJournalLineReferenceIndex=createJournalLineReferenceIndex;

async function createInvoiceOwnershipIndexes(pool) {
  for (const [name, column] of [
    ['app_invoices_creator_id_idx', 'created_by_user_id'],
    ['app_invoices_invoicer_id_idx', 'invoicer_id'],
  ]) {
    const { rows }=await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`,[name]);
    if(rows[0]&&!rows[0].indisvalid) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
      ON app_invoices(${column},id DESC) WHERE ${column} IS NOT NULL`);
  }
  await pool.query('ANALYZE app_invoices');
}
module.exports.createInvoiceOwnershipIndexes=createInvoiceOwnershipIndexes;

async function createInvoiceDetailReferenceIndex(pool) {
  const name='app_journals_payment_reference_idx';
  const {rows}=await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`,[name]);
  if(rows[0]&&!rows[0].indisvalid)await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON app_journal_entries(reference_no,id)
    WHERE party_type='customer' AND docstatus IN ('submitted','cancelled')
      AND journal_type IN ('cash_receipt','payment_journal','journal_entry')`);
  await pool.query('ANALYZE app_journal_entries');
}
module.exports.createInvoiceDetailReferenceIndex=createInvoiceDetailReferenceIndex;

async function createInvoiceWarehouseIndex(pool) {
  const name='app_invoice_items_warehouse_lookup_idx';
  const {rows}=await pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=current_schema()`,[name]);
  if(rows[0]&&!rows[0].indisvalid)await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
  await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON app_invoice_items(warehouse)
    WHERE warehouse IS NOT NULL AND warehouse<>''`);
  await pool.query('ANALYZE app_invoice_items');
}
module.exports.createInvoiceWarehouseIndex=createInvoiceWarehouseIndex;
