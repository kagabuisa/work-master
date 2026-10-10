'use strict';
// Posting engine: GL entries, stock movements, voucher journals and hydration
// helpers. Extracted from store.js; the sales/inventory/ledger domains depend on it.
const { getPostgresPool } = require('../core');
const { PAYMENT_METHODS, DEFAULT_ACCOUNTS } = require('../constants');
const { auditActor, recordAuditFields } = require('../audit');
const { currentPostingTime, storedPostingTime } = require('../posting-time');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');

async function postSalesInvoiceGlEntry(client, invoice) {
  const lines = salesInvoiceAccountingLines(invoice);
  await createOrUpdateSalesInvoiceJournalEntry(client, invoice, lines);
  await postGlEntry(client, {
    posting_date: dateOnly(invoice.invoice_date),
    cost_center: invoice.cost_center,
    voucher_type: 'sales_invoice',
    voucher_id: Number(invoice.id),
    voucher_no: invoice.invoice_no,
    remarks: 'Sales invoice submission',
    lines,
  });
}

function salesInvoiceAccountingLines(invoice) {
  const total = roundMoney(invoice.total);
  const taxAmount = roundMoney(invoice.tax_amount);
  const salesAmount = roundMoney(Math.max(0, Number(invoice.subtotal || 0) - Number(invoice.discount_amount || 0)));
  const totalCost = roundMoney(invoice.total_cost);
  const party = {
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
  };

  return [
    { account_key: 'accounts_receivable', debit: total, credit: 0, remarks: 'Sales invoice submission', ...party },
    { account_key: 'sales_income', debit: 0, credit: salesAmount, remarks: 'Sales invoice submission' },
    { account_key: 'tax_payable', debit: 0, credit: taxAmount, remarks: 'Sales tax' },
    { account_key: 'cost_of_goods_sold', debit: totalCost, credit: 0, remarks: 'Cost of goods sold' },
    { account_key: 'inventory', debit: 0, credit: totalCost, remarks: 'Inventory sold' },
  ];
}

async function createOrUpdateSalesInvoiceJournalEntry(client, invoice, journalLines = salesInvoiceAccountingLines(invoice)) {
  journalLines = nonZeroAccountingLines(journalLines);
  if (!journalLines.length) {
    return null;
  }
  const totalDebit = roundMoney(journalLines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const totalCredit = roundMoney(journalLines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  const remarks = `Sales invoice ${invoice.invoice_no || invoice.id}`;
  const { rows } = await client.query(
    `
    SELECT id, journal_no
    FROM app_journal_entries
    WHERE journal_type = 'sales_invoice'
      AND reference_no = $1
    ORDER BY id
    LIMIT 1
    `,
    [invoice.invoice_no || String(invoice.id)],
  );
  let journalId = rows[0] ? Number(rows[0].id) : null;
  let journalNo = rows[0] && rows[0].journal_no;

  if (journalId) {
    await client.query(
      `
      UPDATE app_journal_entries
      SET docstatus = 'submitted',
        posting_date = $1,
        posting_time = $9,
        party_type = 'customer',
        party_id = $2,
        party_name = $3,
        reference_no = $4,
        remarks = $5,
        total_debit = $6,
        total_credit = $7,
        cost_center = $10
      WHERE id = $8
      `,
      [
        dateOnly(invoice.invoice_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || String(invoice.id),
        remarks,
        totalDebit,
        totalCredit,
        journalId,
        storedPostingTime(invoice.posting_time),
        invoice.cost_center || null,
      ],
    );
  } else {
    const result = await client.query(
      `
      INSERT INTO app_journal_entries (
        docstatus, journal_type, posting_date, party_type, party_id, party_name,
        reference_no, remarks, total_debit, total_credit, posting_time, cost_center
      )
      VALUES ('submitted', 'sales_invoice', $1, 'customer', $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
      `,
      [
        dateOnly(invoice.invoice_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || String(invoice.id),
        remarks,
        totalDebit,
        totalCredit,
        storedPostingTime(invoice.posting_time),
        invoice.cost_center || null,
      ],
    );
    journalId = Number(result.rows[0].id);
  }

  if (!journalNo) {
    journalNo = `JRN-${String(journalId).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
      [journalNo, journalId],
    );
  }

  await setVoucherDocstatus(client, 'app_journal_entries', journalId, 'submitted');
  const accountIds = await resolveAccountingAccounts(client, journalLines);
  await syncGeneratedJournalEntryLines(client, journalId, journalLines, accountIds);

  return { id: journalId, journal_no: journalNo };
}

function nonZeroAccountingLines(lines = []) {
  return lines
    .map((line) => ({
      ...line,
      debit: roundMoney(line.debit),
      credit: roundMoney(line.credit),
    }))
    .filter((line) => line.debit > 0 || line.credit > 0);
}

async function postCustomerPaymentGlEntry(client, invoice, payment) {
  if (!payment) {
    return;
  }
  const amount = roundMoney(payment.amount);
  if (amount <= 0) {
    return;
  }
  const party = {
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
  };

  await postGlEntry(client, {
    posting_date: dateOnly(payment.payment_date),
    cost_center: invoice.cost_center,
    voucher_type: 'customer_payment',
    voucher_id: Number(payment.id),
    voucher_no: `${invoice.invoice_no || invoice.id}-PAY-${String(payment.payment_no || payment.id).padStart(3, '0')}`,
    remarks: payment.reference || payment.notes || 'Customer payment',
    lines: [
      payment.account_id ? { account_id: Number(payment.account_id), debit: amount }
        : { account_key: paymentAccountKey(payment.method), debit: amount },
      { account_key: 'accounts_receivable', credit: amount, ...party },
    ],
  });
}

async function createOrUpdatePaymentJournalEntry(client, invoice, payment) {
  if (!payment) {
    return null;
  }
  const amount = roundMoney(payment.amount);
  if (amount <= 0) {
    return null;
  }

  const originalReference = String(payment.reference || '').trim();
  const externalReference = /^JRN-\d+$/.test(originalReference) ? '' : originalReference;
  const remarks = payment.notes || externalReference || `Payment for ${invoice.invoice_no || invoice.id}`;
  const journalLines = [
    {
      ...(payment.account_id ? { account_id: Number(payment.account_id) }
        : { account_key: paymentAccountKey(payment.method) }),
      debit: amount,
      credit: 0,
      remarks,
    },
    {
      account_key: 'accounts_receivable',
      debit: 0,
      credit: amount,
      party_type: 'customer',
      party_id: invoice.customer_id || null,
      party_name: invoice.customer_name || null,
      remarks,
    },
  ];
  const accountIds = await resolveAccountingAccounts(client, journalLines);
  const journalId = payment.journal_entry_id ? Number(payment.journal_entry_id) : null;
  let savedJournalId = journalId;
  let journalNo;

  if (savedJournalId) {
    const { rows } = await client.query(
      `
      UPDATE app_journal_entries
      SET journal_type = 'payment_journal',
        posting_date = $1,
        party_type = 'customer',
        party_id = $2,
        party_name = $3,
        reference_no = $4,
        remarks = $5,
        total_debit = $6,
        total_credit = $6,
        cost_center = $8
      WHERE id = $7
      RETURNING journal_no
      `,
      [
        dateOnly(payment.payment_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || null,
        remarks,
        amount,
        savedJournalId,
        invoice.cost_center || null,
      ],
    );
    if (rows[0]) {
      journalNo = rows[0].journal_no;
      if (!journalNo) {
        journalNo = `JRN-${String(savedJournalId).padStart(6, '0')}`;
        await client.query(
          'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
          [journalNo, savedJournalId],
        );
      }
    } else {
      savedJournalId = null;
    }
  }

  if (!savedJournalId) {
    const { rows } = await client.query(
      `
      INSERT INTO app_journal_entries (
        journal_type, posting_date, party_type, party_id, party_name, reference_no,
        remarks, total_debit, total_credit, posting_time, cost_center
      )
      VALUES ('payment_journal', $1, 'customer', $2, $3, $4, $5, $6, $6, $7, $8)
      RETURNING id
      `,
      [
        dateOnly(payment.payment_date),
        invoice.customer_id || null,
        invoice.customer_name || null,
        invoice.invoice_no || null,
        remarks,
        amount,
        currentPostingTime(),
        invoice.cost_center || null,
      ],
    );
    savedJournalId = Number(rows[0].id);
    journalNo = `JRN-${String(savedJournalId).padStart(6, '0')}`;
    await client.query(
      'UPDATE app_journal_entries SET journal_no = $1 WHERE id = $2',
      [journalNo, savedJournalId],
    );
  }

  await setVoucherDocstatus(client, 'app_journal_entries', savedJournalId, 'submitted');
  await syncGeneratedJournalEntryLines(client, savedJournalId, journalLines, accountIds);

  await postGlEntry(client, {
    posting_date: dateOnly(payment.payment_date),
    cost_center: invoice.cost_center,
    voucher_type: 'payment_journal',
    voucher_id: savedJournalId,
    voucher_no: journalNo,
    party_type: 'customer',
    party_id: invoice.customer_id || null,
    party_name: invoice.customer_name || null,
    remarks,
    lines: journalLines.map((line, index) => ({
      account_id: accountIds[index],
      debit: line.debit,
      credit: line.credit,
      party_type: line.party_type,
      party_id: line.party_id,
      party_name: line.party_name,
      remarks: line.remarks,
    })),
  });
  await client.query(
    'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
    ['customer_payment', Number(payment.id)],
  );

  await client.query(
    `
    UPDATE app_invoice_payments
    SET reference = $1,
      journal_entry_id = $2
    WHERE id = $3
    `,
    [journalNo, savedJournalId, Number(payment.id)],
  );
  return { id: savedJournalId, journal_no: journalNo };
}

async function postStockEntryGlEntry(client, entry) {
  const costCenter = entry.costCenter !== undefined ? entry.costCenter
    : (await client.query('SELECT cost_center FROM app_stock_entries WHERE id = $1', [Number(entry.id)])).rows[0]?.cost_center;
  const entryType = String(entry.entryType || '').replace(/^stock_/, '');
  if (entryType === 'transfer') {
    await client.query(
      `
      DELETE FROM app_gl_entries
      WHERE voucher_type IN ('stock_transfer', 'stock_transfer_reversal')
        AND voucher_id = $1
      `,
      [Number(entry.id)],
    );
    return;
  }

  const { rows } = await client.query(
    `
    SELECT
      COALESCE(SUM(stock_value_change), 0)::float AS value_change
    FROM app_stock_ledger
    WHERE voucher_id = $1
      AND voucher_type = $2
      AND is_reversal = $3
    `,
    [Number(entry.id), `stock_${entryType}`, Boolean(entry.isReversal)],
  );
  const valueChange = roundMoney(rows[0] ? rows[0].value_change : 0);
  const amount = Math.abs(valueChange);
  if (amount <= 0) {
    await client.query(
      'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
      [stockVoucherType(entryType, entry.isReversal), Number(entry.id)],
    );
    return;
  }

  const lines = stockEntryGlLines(entryType, valueChange, Boolean(entry.isReversal));
  if (!lines.length) {
    return;
  }

  await postGlEntry(client, {
    posting_date: dateOnly(entry.postingDate),
    cost_center: costCenter,
    voucher_type: stockVoucherType(entryType, entry.isReversal),
    voucher_id: Number(entry.id),
    voucher_no: entry.entryNo,
    remarks: entry.remarks || stockEntryGlRemarks(entryType, entry.isReversal),
    is_reversal: Boolean(entry.isReversal),
    reversal_of_voucher_type: entry.isReversal ? `stock_${entryType}` : null,
    reversal_of_voucher_id: entry.isReversal ? Number(entry.id) : null,
    lines: lines.map((line) => ({ ...line, debit: line.debit || 0, credit: line.credit || 0 })),
  });
}

function stockEntryGlLines(entryType, valueChange, isReversal = false) {
  const amount = Math.abs(roundMoney(valueChange));
  if (amount <= 0) {
    return [];
  }
  if (entryType === 'opening') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'opening_equity', credit: amount },
      ]
      : [
        { account_key: 'opening_equity', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (entryType === 'purchase') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'accounts_payable', credit: amount },
      ]
      : [
        { account_key: 'accounts_payable', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (entryType === 'adjustment' || entryType === 'reconciliation' || entryType === 'cancel') {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'stock_adjustment_gain', credit: amount },
      ]
      : [
        { account_key: 'stock_adjustment_loss', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  if (isReversal) {
    return valueChange >= 0
      ? [
        { account_key: 'inventory', debit: amount },
        { account_key: 'stock_adjustment_gain', credit: amount },
      ]
      : [
        { account_key: 'stock_adjustment_loss', debit: amount },
        { account_key: 'inventory', credit: amount },
      ];
  }
  return [];
}

function stockVoucherType(entryType, isReversal = false) {
  return isReversal ? `stock_${entryType}_reversal` : `stock_${entryType}`;
}

function stockEntryGlRemarks(entryType, isReversal = false) {
  const label = entryType
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return isReversal ? `${label} cancellation` : `${label} stock entry`;
}

function paymentAccountKey(method) {
  const value = String(method || '').trim().toLowerCase();
  if (value === 'bank') {
    return 'bank';
  }
  if (value === 'mobile_money') {
    return 'mobile_money';
  }
  if (value === 'card') {
    return 'card_clearing';
  }
  if (value === 'other') {
    return 'cash';
  }
  return 'cash';
}

async function postGlEntry(client, entry) {
  const lines = (entry.lines || [])
    .map((line) => ({
      ...line,
      debit: roundMoney(line.debit),
      credit: roundMoney(line.credit),
    }))
    .filter((line) => line.debit > 0 || line.credit > 0);
  if (!lines.length) {
    return;
  }

  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit !== totalCredit) {
    const err = new Error(`GL entry is not balanced. Debit ${totalDebit}, credit ${totalCredit}.`);
    err.status = 400;
    throw err;
  }
  if (lines.some((line) => line.debit > 0 && line.credit > 0)) {
    const err = new Error('GL entry lines cannot contain both debit and credit.');
    err.status = 400;
    throw err;
  }

  await client.query(
    'DELETE FROM app_gl_entries WHERE voucher_type = $1 AND voucher_id = $2',
    [entry.voucher_type, Number(entry.voucher_id)],
  );

  const accountIds = await resolveAccountingAccounts(client, lines);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(
      `
      INSERT INTO app_gl_entries (
        posting_date, account_id, party_type, party_id, party_name, voucher_type,
        voucher_id, voucher_no, line_no, debit, credit, remarks, is_reversal,
        reversal_of_voucher_type, reversal_of_voucher_id, cost_center
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        entry.posting_date,
        accountIds[index],
        line.party_type || entry.party_type || null,
        line.party_id || entry.party_id || null,
        line.party_name || entry.party_name || null,
        entry.voucher_type,
        Number(entry.voucher_id),
        entry.voucher_no || null,
        index + 1,
        line.debit,
        line.credit,
        line.remarks || entry.remarks || null,
        Boolean(entry.is_reversal),
        entry.reversal_of_voucher_type || null,
        entry.reversal_of_voucher_id || null,
        line.cost_center || entry.cost_center || null,
      ],
    );
  }
}

async function reverseVoucherGlEntries(client, voucherType, voucherId, postingDate) {
  const { rows } = await client.query(
    `SELECT account_id, party_type, party_id, party_name, voucher_no, cost_center,
      debit::float, credit::float
     FROM app_gl_entries
     WHERE voucher_type = $1 AND voucher_id = $2 AND is_reversal = false
     ORDER BY line_no`,
    [voucherType, Number(voucherId)],
  );
  if (!rows.length) return;
  await postGlEntry(client, {
    posting_date: postingDate,
    voucher_type: `${voucherType}_cancellation`,
    voucher_id: Number(voucherId),
    voucher_no: rows[0].voucher_no,
    remarks: `Cancellation of ${rows[0].voucher_no || voucherType}`,
    is_reversal: true,
    reversal_of_voucher_type: voucherType,
    reversal_of_voucher_id: Number(voucherId),
    lines: rows.map((row) => ({
      account_id: row.account_id,
      party_type: row.party_type,
      party_id: row.party_id,
      party_name: row.party_name,
      cost_center: row.cost_center,
      debit: Number(row.credit || 0),
      credit: Number(row.debit || 0),
    })),
  });
}

async function resolveAccountingAccounts(client, lines) {
  const keys = [...new Set(lines.map((line) => line.account_key).filter(Boolean))];
  const accountIdsByKey = new Map();
  if (keys.length) {
    const { rows } = await client.query(
      `
      SELECT setting.setting_key, setting.account_id
      FROM app_accounting_settings setting
      WHERE setting.setting_key = ANY($1::text[])
      `,
      [keys],
    );
    for (const row of rows) {
      accountIdsByKey.set(row.setting_key, Number(row.account_id));
    }
  }

  return lines.map((line) => {
    if (line.account_id) {
      return Number(line.account_id);
    }
    const accountId = accountIdsByKey.get(line.account_key);
    if (!accountId) {
      const err = new Error(`Accounting account mapping is missing for ${line.account_key}.`);
      err.status = 500;
      throw err;
    }
    return accountId;
  });
}

function groupByInvoiceId(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const invoiceId = Number(row.invoice_pk ?? row.invoice_id);
    if (!grouped.has(invoiceId)) {
      grouped.set(invoiceId, []);
    }
    grouped.get(invoiceId).push(row);
  }
  return grouped;
}

function postgresItemToInvoiceItem(row) {
  return {
    ...recordAuditFields(row),
    id: Number(row.id),
    db_id: Number(row.id),
    line_no: Number(row.line_no),
    item_code: row.item_code,
    item_name: row.item_name,
    item_category: row.item_category || '',
    source: row.source || '',
    cost: Number(row.cost || 0),
    warehouse: row.warehouse,
    quantity: Number(row.quantity || 0),
    unit_price: Number(row.unit_price || 0),
    stock_at_sale: row.stock_at_sale == null ? null : Number(row.stock_at_sale),
    line_total: Number(row.line_total || 0),
    cost_rate: Number(row.cost_rate || 0),
    cost_amount: Number(row.cost_amount || 0),
    gross_profit: Number(row.gross_profit || 0),
  };
}

function postgresPaymentToInvoicePayment(row) {
  return {
    ...recordAuditFields(row),
    id: Number(row.payment_no),
    payment_record_id: Number(row.id),
    journal_entry_id: row.journal_entry_id ? Number(row.journal_entry_id) : null,
    docstatus: row.docstatus || 'submitted',
    payment_date: dateOnly(row.payment_date),
    amount: Number(row.amount || 0),
    method: row.method,
    account_id: row.account_id ? Number(row.account_id) : null,
    account_name: row.account_name || null,
    reference: row.reference,
    notes: row.notes,
    created_at: toIsoString(row.created_at),
  };
}

function normalizeStockEntryItems(rows, entryType) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).reduce((items, row) => {
    const itemCode = String(row.item_code || '').trim();
    const itemName = String(row.item_name || itemCode).trim();
    const warehouse = String(row.warehouse || '').trim();
    const targetWarehouse = String(row.target_warehouse || '').trim() || null;
    const quantity = normalizeQuantity(row.quantity);
    const signedQuantity = entryType === 'adjustment'
      ? Number(Number(row.quantity || 0).toFixed(3))
      : quantity;
    const valuationRate = roundMoney(Math.max(0, Number(row.valuation_rate || 0)));
    if (!itemCode || !itemName || !warehouse) {
      return items;
    }
    if (entryType === 'reconciliation') {
      const count = Number(row.quantity);
      if (row.quantity === '' || row.quantity == null || !Number.isFinite(count)
        || count < 0 || Math.abs(count - Number(count.toFixed(3))) > 1e-9) {
        const err = new Error('Enter a valid counted quantity with at most three decimal places.');
        err.status = 400;
        throw err;
      }
      const key = `${itemCode}\0${warehouse}`;
      if (seen.has(key)) {
        const err = new Error(`Count ${itemCode} in ${warehouse} only once.`);
        err.status = 400;
        throw err;
      }
      seen.add(key);
    } else if (signedQuantity === 0) {
      return items;
    }
    if (entryType === 'transfer' && !targetWarehouse) {
      return items;
    }
    items.push({
      id: Number(row.id || 0),
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      target_warehouse: entryType === 'reconciliation' ? null : targetWarehouse,
      quantity: signedQuantity,
      counted_quantity: entryType === 'reconciliation' ? signedQuantity : null,
      valuation_rate: valuationRate,
    });
    return items;
  }, []);
}

function normalizeSupplierInfo(row = {}) {
  return {
    supplier_name: String(row.supplier_name || '').trim(),
    supplier_contact: String(row.supplier_contact || '').trim(),
    supplier_phone: String(row.supplier_phone || '').trim(),
    supplier_reference: String(row.supplier_reference || '').trim(),
  };
}

async function insertStockEntryItems(client, stockEntryId, items) {
  let lineNo = 0;
  for (const item of items) {
    lineNo += 1;
    await client.query(
      `
      INSERT INTO app_stock_entry_items (
        stock_entry_id, line_no, item_code, item_name, warehouse,
        target_warehouse, quantity, counted_quantity, valuation_rate
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        stockEntryId,
        item.line_no || lineNo,
        item.item_code,
        item.item_name,
        item.warehouse,
        item.target_warehouse,
        item.quantity,
        item.counted_quantity,
        item.valuation_rate,
      ],
    );
  }
}

async function syncStockEntryItems(client, stockEntryId, items) {
  const existingResult = await client.query(
    'SELECT id FROM app_stock_entry_items WHERE stock_entry_id = $1',
    [stockEntryId],
  );
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.id)));
  const seenIds = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const dbId = Number(item.id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      await client.query(
        `
        UPDATE app_stock_entry_items
        SET line_no = $1,
          item_code = $2,
          item_name = $3,
          warehouse = $4,
          target_warehouse = $5,
          quantity = $6,
          counted_quantity = $7,
          valuation_rate = $8
        WHERE id = $9
          AND stock_entry_id = $10
        `,
        [
          index + 1,
          item.item_code,
          item.item_name,
          item.warehouse,
          item.target_warehouse,
          item.quantity,
          item.counted_quantity,
          item.valuation_rate,
          dbId,
          stockEntryId,
        ],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingIds) {
    if (!seenIds.has(dbId)) {
      await client.query('DELETE FROM app_stock_entry_items WHERE id = $1 AND stock_entry_id = $2', [dbId, stockEntryId]);
    }
  }

  const newItems = items.flatMap((item, index) =>
    Number(item.id || 0) > 0 && existingIds.has(Number(item.id))
      ? [] : [{ ...item, line_no: index + 1 }]);
  await insertStockEntryItems(client, stockEntryId, newItems);
}

async function postStockEntryMovements(client, { id, entryNo, entryType, postingDate, items }) {
  for (const item of items) {
    if (entryType === 'transfer') {
      const outgoing = await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'stock_transfer',
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: -Math.abs(item.quantity),
      });
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.target_warehouse,
        voucher_type: 'stock_transfer',
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: Math.abs(item.quantity),
        rate: outgoing.outgoing_rate,
      });
    } else if (entryType === 'reconciliation') {
      const movement = await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'stock_reconciliation',
        voucher_id: id,
        voucher_no: entryNo,
        target_quantity: item.counted_quantity,
        rate: item.valuation_rate,
      });
      await client.query(`UPDATE app_stock_entry_items SET quantity = $1
        WHERE stock_entry_id = $2 AND item_code = $3 AND warehouse = $4`,
      [movement.qty_change, id, item.item_code, item.warehouse]);
    } else {
      const qtyChange = entryType === 'adjustment'
        ? item.quantity
        : entryType === 'cancel'
          ? -Math.abs(item.quantity)
          : Math.abs(item.quantity);
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: `stock_${entryType}`,
        voucher_id: id,
        voucher_no: entryNo,
        qty_change: qtyChange,
        rate: item.valuation_rate,
      });
    }
  }
}

async function applyPostgresStockMovement(client, movement) {
  const itemCode = String(movement.item_code || '').trim();
  const itemName = String(movement.item_name || itemCode).trim();
  const warehouse = String(movement.warehouse || '').trim();
  const hasTarget = movement.target_quantity !== undefined;
  let qtyChange = Number(Number(movement.qty_change || 0).toFixed(3));
  if (!itemCode || !warehouse || (!hasTarget && qtyChange === 0)) {
    const err = new Error('Stock movement requires item, warehouse, and quantity.');
    err.status = 400;
    throw err;
  }

  await client.query(
    `
    INSERT INTO app_stock_balances (item_code, warehouse, item_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (item_code, warehouse)
    DO UPDATE SET item_name = EXCLUDED.item_name
    `,
    [itemCode, warehouse, itemName],
  );
  const { rows } = await client.query(
    `
    SELECT *
    FROM app_stock_balances
    WHERE item_code = $1
      AND warehouse = $2
    FOR UPDATE
    `,
    [itemCode, warehouse],
  );
  const balance = rows[0];
  const previousQuantity = Number(balance.quantity || 0);
  const previousValue = Number(balance.stock_value || 0);
  const previousRate = Number(balance.valuation_rate || 0);
  if (hasTarget) qtyChange = Number((Number(movement.target_quantity) - previousQuantity).toFixed(3));
  if (hasTarget && qtyChange > 0 && Number(movement.rate || previousRate || 0) <= 0) {
    const err = new Error(`Enter a valuation rate for ${itemName} in ${warehouse}.`);
    err.status = 400;
    throw err;
  }

  let incomingRate = 0;
  let outgoingRate = 0;
  let valueChange = 0;
  if (qtyChange > 0) {
    incomingRate = roundMoney(Number(movement.rate || previousRate || 0));
    valueChange = roundMoney(qtyChange * incomingRate);
  } else if (qtyChange < 0) {
    if (previousQuantity + qtyChange < -0.0005) {
      const err = new Error(`Insufficient stock for ${itemName} in ${warehouse}.`);
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: itemName,
        item_code: itemCode,
        warehouse,
        requested: Math.abs(qtyChange),
        available: previousQuantity,
      };
      throw err;
    }
    outgoingRate = roundMoney(Number(movement.force_outgoing_rate || previousRate));
    valueChange = -roundMoney(Math.abs(qtyChange) * outgoingRate);
  }

  const newQuantity = Number((previousQuantity + qtyChange).toFixed(3));
  const newValue = roundMoney(previousValue + valueChange);
  const newRate = newQuantity > 0 ? roundMoney(newValue / newQuantity) : 0;

  // Retain the count on the voucher, but do not post a movement for a matching item.
  if (movement.voucher_type === 'stock_reconciliation' && qtyChange === 0 && valueChange === 0) {
    return {
      qty_change: 0, previous_quantity: previousQuantity, quantity: previousQuantity,
      valuation_rate: previousRate, incoming_rate: 0, outgoing_rate: 0, stock_value_change: 0,
    };
  }

  await client.query(
    `
    UPDATE app_stock_balances
    SET item_name = $1,
      quantity = $2,
      stock_value = $3,
      valuation_rate = $4,
      updated_at = now()
    WHERE item_code = $5
      AND warehouse = $6
    `,
    [itemName, newQuantity, newValue, newRate, itemCode, warehouse],
  );
  await client.query(
    `
    INSERT INTO app_stock_ledger (
      posting_date, item_code, item_name, warehouse, voucher_type, voucher_id, voucher_no,
      qty_change, incoming_rate, outgoing_rate, stock_value_change,
      qty_after_transaction, stock_value_after_transaction, is_reversal,
      reversal_of_voucher_id, reversal_of_voucher_no, remarks
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `,
    [
      movement.posting_date,
      itemCode,
      itemName,
      warehouse,
      movement.voucher_type,
      movement.voucher_id || null,
      movement.voucher_no || null,
      qtyChange,
      incomingRate,
      outgoingRate,
      valueChange,
      newQuantity,
      newValue,
      Boolean(movement.is_reversal),
      movement.reversal_of_voucher_id || null,
      movement.reversal_of_voucher_no || null,
      movement.remarks || null,
    ],
  );

  return {
    qty_change: qtyChange,
    previous_quantity: previousQuantity,
    quantity: newQuantity,
    valuation_rate: newRate,
    incoming_rate: incomingRate,
    outgoing_rate: outgoingRate,
    stock_value_change: valueChange,
  };
}

function addReportFilters(where, params, filters = {}) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const entryType = String(filters.entry_type || '').trim();
  const status = String(filters.status || 'posted').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (from) {
    params.push(from);
    where.push(`l.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`l.posting_date <= $${params.length}`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`l.warehouse = $${params.length}`);
  }
  if (entryType) {
    params.push(entryType);
    where.push(`(
      (l.voucher_type LIKE 'stock_%' AND COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', '')) = $${params.length})
      OR (l.voucher_type = 'purchase' AND $${params.length} = 'purchase')
    )`);
  }
  if (status === 'posted') {
    where.push(`CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END IN ('submitted', 'cancelled')`);
  } else if (status) {
    params.push(status);
    where.push(`CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      l.posting_date::text LIKE $${params.length}
      OR LOWER(l.item_code) LIKE $${params.length}
      OR LOWER(l.item_name) LIKE $${params.length}
      OR LOWER(l.warehouse) LIKE $${params.length}
      OR LOWER(l.voucher_type) LIKE $${params.length}
      OR LOWER(COALESCE(l.voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(l.reversal_of_voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(l.remarks, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', ''))) LIKE $${params.length}
      OR LOWER(CASE WHEN l.is_reversal THEN 'cancelled' WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'submitted') WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'submitted') WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'submitted') ELSE 'submitted' END) LIKE $${params.length}
      OR l.qty_change::text LIKE $${params.length}
      OR l.incoming_rate::text LIKE $${params.length}
      OR l.outgoing_rate::text LIKE $${params.length}
      OR l.stock_value_change::text LIKE $${params.length}
      OR l.qty_after_transaction::text LIKE $${params.length}
      OR l.stock_value_after_transaction::text LIKE $${params.length}
    )`);
  }
}

function reportFilterValues(filters = {}) {
  return {
    search: String(filters.search || '').trim(),
    warehouse: String(filters.warehouse || '').trim(),
    entry_type: String(filters.entry_type || '').trim(),
    status: String(filters.status || 'posted').trim(),
    from: String(filters.from || '').trim(),
    to: String(filters.to || '').trim(),
  };
}

function actorAuditValues() {
  const actor = auditActor();
  return {
    by: actor.name || null,
    by_user_id: actor.id || null,
    at: new Date().toISOString(),
  };
}

async function setVoucherDocstatus(client, table, id, status) {
  const actor = actorAuditValues();
  if (status === 'submitted') {
    await client.query(
      `UPDATE ${table}
       SET docstatus = 'submitted',
           submitted_by = $2,
           submitted_by_user_id = $3,
           submitted_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, actor.by, actor.by_user_id, actor.at],
    );
    return;
  }
  if (status === 'cancelled') {
    await client.query(
      `UPDATE ${table}
       SET docstatus = 'cancelled',
           cancelled_by = $2,
           cancelled_by_user_id = $3,
           cancelled_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, actor.by, actor.by_user_id, actor.at],
    );
    return;
  }
  throw new Error('Unsupported voucher docstatus change.');
}

async function syncGeneratedJournalEntryLines(client, journalId, lines, accountIds) {
  const existingResult = await client.query(
    'SELECT id, line_no FROM app_journal_entry_lines WHERE journal_entry_id = $1',
    [journalId],
  );
  const existingByLine = new Map(existingResult.rows.map((row) => [Number(row.line_no), Number(row.id)]));
  const seenIds = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    const dbId = existingByLine.get(lineNo);
    if (dbId) {
      await client.query(
        `
        UPDATE app_journal_entry_lines
        SET line_no = $1,
          account_id = $2,
          debit = $3,
          credit = $4,
          remarks = $5
        WHERE id = $6
          AND journal_entry_id = $7
        `,
        [lineNo, accountIds[index], line.debit, line.credit, line.remarks, dbId, journalId],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingResult.rows.map((row) => Number(row.id))) {
    if (!seenIds.has(dbId)) {
      await client.query('DELETE FROM app_journal_entry_lines WHERE id = $1 AND journal_entry_id = $2', [dbId, journalId]);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (existingByLine.has(index + 1)) {
      continue;
    }
    const line = lines[index];
    await client.query(
      `
      INSERT INTO app_journal_entry_lines
        (journal_entry_id, line_no, account_id, debit, credit, remarks)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [journalId, index + 1, accountIds[index], line.debit, line.credit, line.remarks],
    );
  }
}
module.exports = {
  postSalesInvoiceGlEntry,
  salesInvoiceAccountingLines,
  createOrUpdateSalesInvoiceJournalEntry,
  nonZeroAccountingLines,
  postCustomerPaymentGlEntry,
  createOrUpdatePaymentJournalEntry,
  postStockEntryGlEntry,
  stockEntryGlLines,
  stockVoucherType,
  stockEntryGlRemarks,
  paymentAccountKey,
  postGlEntry,
  reverseVoucherGlEntries,
  resolveAccountingAccounts,
  groupByInvoiceId,
  postgresItemToInvoiceItem,
  postgresPaymentToInvoicePayment,
  normalizeStockEntryItems,
  normalizeSupplierInfo,
  insertStockEntryItems,
  syncStockEntryItems,
  postStockEntryMovements,
  applyPostgresStockMovement,
  addReportFilters,
  reportFilterValues,
  actorAuditValues,
  setVoucherDocstatus,
  syncGeneratedJournalEntryLines,
};
