const {
  initStore,
  createStockEntry,
  cancelStockEntry,
  createInvoice,
  submitInvoice,
  addInvoicePayment,
  accountingAccounts,
  createJournalEntry,
} = require('../src/store');

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function sampleStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function findAccount(accounts, code) {
  const account = accounts.find((row) => row.account_code === code);
  if (!account) {
    throw new Error(`Missing account ${code}.`);
  }
  return account.id;
}

async function main() {
  await initStore();

  const date = todayString();
  const stamp = sampleStamp();
  const itemCode = `SAMPLE-ACCT-${stamp}`;
  const itemName = `Accounting Sample Item ${stamp}`;
  const warehouse = 'Sample Warehouse';
  const customerName = `Accounting Sample Customer ${stamp}`;

  const openingStockId = await createStockEntry({
    entry_type: 'opening',
    posting_date: date,
    remarks: `Sample opening stock ${stamp}`,
    items: [{
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      quantity: 10,
      valuation_rate: 50,
    }],
  });

  const purchaseStockId = await createStockEntry({
    entry_type: 'purchase',
    posting_date: date,
    remarks: `Sample purchase stock ${stamp}`,
    supplier_name: 'Accounting Sample Supplier',
    supplier_reference: `SUP-${stamp}`,
    items: [{
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      quantity: 5,
      valuation_rate: 60,
    }],
  });

  const adjustmentStockId = await createStockEntry({
    entry_type: 'adjustment',
    posting_date: date,
    remarks: `Sample adjustment to cancel ${stamp}`,
    items: [{
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      quantity: 2,
      valuation_rate: 55,
    }],
  });
  await cancelStockEntry(adjustmentStockId, {
    posting_date: date,
    reason: `Sample cancellation ${stamp}`,
  });

  const invoiceId = await createInvoice({
    invoice_date: date,
    due_date: date,
    customer_id: `SAMPLE-CUST-${stamp}`,
    customer_name: customerName,
    customer_phone: '000-000',
    notes: `Sample accounting invoice ${stamp}`,
    discount_amount: 0,
    tax_amount: 54,
    payments: [],
    items: [{
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      quantity: 3,
      unit_price: 180,
    }],
  });
  await submitInvoice(invoiceId);

  await addInvoicePayment(invoiceId, {
    payment_date: date,
    amount: 200,
    method: 'cash',
    reference: `PAY-${stamp}`,
    notes: `Sample partial payment ${stamp}`,
  });

  const accounts = await accountingAccounts();
  const bankId = findAccount(accounts, '1120');
  const openingEquityId = findAccount(accounts, '3000');
  const journalId = await createJournalEntry({
    journal_type: 'journal_entry',
    posting_date: date,
    reference_no: `JRN-SAMPLE-${stamp}`,
    remarks: `Sample owner contribution ${stamp}`,
    lines: [
      { account_id: bankId, debit: 75, credit: 0, remarks: 'Sample bank deposit' },
      { account_id: openingEquityId, debit: 0, credit: 75, remarks: 'Sample owner contribution' },
    ],
  });

  console.log(JSON.stringify({
    stamp,
    item_code: itemCode,
    warehouse,
    customer_name: customerName,
    opening_stock_id: openingStockId,
    purchase_stock_id: purchaseStockId,
    cancelled_adjustment_stock_id: adjustmentStockId,
    invoice_id: invoiceId,
    journal_id: journalId,
    review_urls: {
      invoice: `/invoices/${invoiceId}`,
      stock_opening: `/stock/entries/${openingStockId}`,
      stock_purchase: `/stock/entries/${purchaseStockId}`,
      stock_cancelled_adjustment: `/stock/entries/${adjustmentStockId}`,
      journal: `/journals/${journalId}`,
      general_ledger: `/reports/general-ledger?q=${stamp}`,
      trial_balance: '/reports/trial-balance',
      profit_and_loss: '/reports/profit-and-loss',
      balance_sheet: '/reports/balance-sheet',
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
}).then(() => process.exit(0));
