'use strict';

function duplicateInvoiceItemCode(items) {
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const itemCode = String(item?.item_code || '').trim();
    if (!itemCode) continue;
    if (seen.has(itemCode)) return itemCode;
    seen.add(itemCode);
  }
  return null;
}

function duplicateInvoiceItemError(itemCode) {
  const error = new Error(`Item ${itemCode} is already included in this invoice. Combine the quantities into one line.`);
  error.status = 400;
  error.code = 'DUPLICATE_INVOICE_ITEM';
  return error;
}

function assertUniqueInvoiceItems(items) {
  const duplicate = duplicateInvoiceItemCode(items);
  if (duplicate) throw duplicateInvoiceItemError(duplicate);
}

function assertSingleInvoiceWarehouse(items, selectedWarehouse = '') {
  const warehouses = [];
  const selected = String(selectedWarehouse || '').trim();
  for (const item of Array.isArray(items) ? items : []) {
    const warehouse = String(item?.warehouse || '').trim() || selected;
    if (!warehouse) {
      const error = new Error('Each invoice item must use the selected warehouse.');
      error.status = 400;
      error.code = 'INVOICE_WAREHOUSE_REQUIRED';
      throw error;
    }
    if (!warehouses.includes(warehouse)) warehouses.push(warehouse);
  }
  if (!warehouses.length) {
    const error = new Error('Add at least one invoice item.');
    error.status = 400;
    error.code = 'INVOICE_ITEMS_REQUIRED';
    throw error;
  }
  if (warehouses.length > 1) {
    const error = new Error(`An invoice can only use one warehouse. Item lines use ${warehouses.join(', ')}.`);
    error.status = 400;
    error.code = 'MULTIPLE_INVOICE_WAREHOUSES';
    throw error;
  }
  if (selected && selected !== warehouses[0]) {
    const error = new Error(`All invoice items must use the selected warehouse ${selected}.`);
    error.status = 400;
    error.code = 'INVOICE_WAREHOUSE_MISMATCH';
    throw error;
  }
}

module.exports = {
  duplicateInvoiceItemCode,
  duplicateInvoiceItemError,
  assertUniqueInvoiceItems,
  assertSingleInvoiceWarehouse,
};
