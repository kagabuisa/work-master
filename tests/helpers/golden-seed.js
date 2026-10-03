'use strict';
// Deterministic seed for the golden-master accounting safety net.
// Every value is fixed (dates, codes, names, quantities, rates) so a fresh schema
// produces byte-identical reports. Shared by scripts/capture-golden.js and
// tests/golden-accounting.test.js.

const store = require('../../src/store');

const FIXED = {
  date: '2026-01-15',
  itemCode: 'GOLDEN-ITEM-001',
  itemName: 'Golden Sample Item',
  warehouse: 'Golden Warehouse',
  supplierName: 'Golden Sample Supplier',
  supplierRef: 'SUP-GOLDEN-001',
  customerId: 'GOLDEN-CUST-001',
  customerName: 'Golden Sample Customer',
  customerPhone: '000-000-000',
};

// Drop the whole public schema and re-initialise from scratch, so serial IDs are
// deterministic (1, 2, 3, ...) exactly as on a fresh deployment.
async function resetGoldenSchema() {
  const db = String(process.env.POSTGRES_DB || '');
  if (!/(_golden|_test)$/.test(db)) {
    throw new Error(
      `Refusing to DROP SCHEMA public in database "${db}". `
      + 'Point POSTGRES_DB at a dedicated *_golden or *_test database.',
    );
  }
  const pool = store.getPostgresPool();
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await store.closeStore();
  await store.initStore();
}

async function seedGoldenData() {
  await resetGoldenSchema();
  const date = FIXED.date;

  const openingId = await store.createStockEntry({
    entry_type: 'opening',
    posting_date: date,
    remarks: 'Golden opening stock',
    items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 10, valuation_rate: 50 }],
  });

  const purchaseId = await store.createStockEntry({
    entry_type: 'purchase',
    posting_date: date,
    remarks: 'Golden purchase stock',
    supplier_name: FIXED.supplierName,
    supplier_reference: FIXED.supplierRef,
    items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 5, valuation_rate: 60 }],
  });

  const adjustmentId = await store.createStockEntry({
    entry_type: 'adjustment',
    posting_date: date,
    remarks: 'Golden adjustment to cancel',
    items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 2, valuation_rate: 55 }],
  });
  await store.cancelStockEntry(adjustmentId, { posting_date: date, reason: 'Golden cancellation' });

  const invoiceId = await store.createInvoice({
    invoice_date: date,
    due_date: date,
    customer_id: FIXED.customerId,
    customer_name: FIXED.customerName,
    customer_phone: FIXED.customerPhone,
    notes: 'Golden accounting invoice',
    discount_amount: 0,
    tax_amount: 54,
    payments: [],
    items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName, warehouse: FIXED.warehouse, quantity: 3, unit_price: 180 }],
  });
  await store.submitInvoice(invoiceId);
  await store.addInvoicePayment(invoiceId, {
    payment_date: date,
    amount: 200,
    method: 'cash',
    reference: 'PAY-GOLDEN-001',
    notes: 'Golden partial payment',
  });

  const accounts = await store.accountingAccounts();
  const find = (code) => {
    const account = accounts.find((row) => row.account_code === code);
    if (!account) throw new Error(`Missing account ${code}.`);
    return account.id;
  };
  const journalId = await store.createJournalEntry({
    journal_type: 'journal_entry',
    posting_date: date,
    reference_no: 'JRN-GOLDEN-001',
    remarks: 'Golden owner contribution',
    lines: [
      { account_id: find('1120'), debit: 75, credit: 0, remarks: 'Golden bank deposit' },
      { account_id: find('3000'), debit: 0, credit: 75, remarks: 'Golden owner contribution' },
    ],
  });

  return { openingId, purchaseId, adjustmentId, invoiceId, journalId };
}

// Normalise fields that are legitimately non-deterministic (DB now() defaults,
// request-scoped audit identities) so the snapshot only pins accounting content.
function normalizeGolden(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeGolden);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(created_at|updated_at|created_by|updated_by|posting_time|created_by_user_id|updated_by_user_id)$/.test(k)) {
        out[k] = '<volatile>';
        continue;
      }
      out[k] = normalizeGolden(v);
    }
    return out;
  }
  return value;
}

module.exports = { FIXED, resetGoldenSchema, seedGoldenData, normalizeGolden };
