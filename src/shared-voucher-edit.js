'use strict';

const {
  accountAllowed,
  assignedMasterRecordAllowed,
  invoicePriceListAllowed,
  masterRecordAllowed,
  purchasePriceListAllowed,
  warehouseAllowed,
} = require('./access');

function denied(message) {
  return Object.assign(new Error(message), { status: 403 });
}

function text(value) {
  return String(value || '').trim();
}

async function sharedSalesEdit(user, record, payload) {
  if (text(payload.customer_id) !== text(record.customer_id)
      && !await masterRecordAllowed(user, 'customers', payload.customer_id)) {
    throw denied('The new customer is outside your permitted customer list.');
  }
  if (text(payload.price_list) !== text(record.price_list)
      && !invoicePriceListAllowed(user, payload.price_list)) {
    throw denied('The new price list is outside your permitted list.');
  }
  if (text(payload.invoicer_id) !== text(record.invoicer_id)
      && !await masterRecordAllowed(user, 'employees', payload.invoicer_id)) {
    throw denied('The new invoicer is outside your permitted employee list.');
  }
  if (text(payload.cost_center) !== text(record.cost_center)
      && !assignedMasterRecordAllowed(user, 'cost-centers', payload.cost_center)) {
    throw denied('The new cost center is outside your permitted list.');
  }
  const originalWarehouse = text(record.warehouse || record.items?.[0]?.warehouse);
  if (text(payload.warehouse) !== originalWarehouse && !warehouseAllowed(user, payload.warehouse)) {
    throw denied('The new warehouse is outside your permitted warehouse list.');
  }
}

async function sharedPurchaseEdit(user, record, payload) {
  if (text(payload.supplier_id) !== text(record.supplier_id)
      && !await masterRecordAllowed(user, 'suppliers', payload.supplier_id)) {
    throw denied('The new supplier is outside your permitted supplier list.');
  }
  if (text(payload.price_list) !== text(record.price_list)
      && !purchasePriceListAllowed(user, payload.price_list)) {
    throw denied('The new price list is outside your permitted list.');
  }
  if (text(payload.cost_center) !== text(record.cost_center)
      && !assignedMasterRecordAllowed(user, 'cost-centers', payload.cost_center)) {
    throw denied('The new cost center is outside your permitted list.');
  }
  const originalWarehouses = new Set((record.items || []).map((item) => text(item.warehouse)).filter(Boolean));
  for (const item of payload.items || []) {
    if (!originalWarehouses.has(text(item.warehouse)) && !warehouseAllowed(user, item.warehouse)) {
      throw denied('New warehouses must be within your permitted warehouse list.');
    }
  }
}

async function sharedPurchaseOrderEdit(user, record, payload) {
  await sharedPurchaseEdit(user, record, payload);
  if (payload.items?.some((item) => text(item.warehouse) !== text(payload.warehouse))) {
    throw denied('Purchase order items must use the selected warehouse.');
  }
}

async function sharedJournalEdit(user, record, payload) {
  const originalAccounts = new Set((record.lines || []).map((line) => text(line.account_id)));
  for (const line of payload.lines || []) {
    if (!originalAccounts.has(text(line.account_id)) && !accountAllowed(user, line.account_id)) {
      throw denied('New journal accounts must be within your permitted account list.');
    }
  }
  if (text(payload.cost_center) !== text(record.cost_center)
      && !assignedMasterRecordAllowed(user, 'cost-centers', payload.cost_center)) {
    throw denied('The new cost center is outside your permitted list.');
  }
  if ((text(payload.party_id) !== text(record.party_id) || text(payload.party_type) !== text(record.party_type))
      && text(payload.party_id)) {
    const kind = payload.party_type === 'customer' ? 'customers'
      : payload.party_type === 'supplier' ? 'suppliers'
        : payload.party_type === 'employee' ? 'employees' : null;
    if (!kind || !await masterRecordAllowed(user, kind, payload.party_id)) {
      throw denied('The new journal party is outside your permitted list.');
    }
  }
}

async function sharedReconciliationEdit(user, record, payload) {
  if (text(payload.entry_type) !== 'reconciliation' || text(payload.action) !== 'save_draft') {
    throw denied('Shared access only allows saving a reconciliation draft.');
  }
  const originalWarehouse = text(record.warehouse || record.items?.[0]?.warehouse);
  const warehouses = new Set((payload.items || []).map((item) => text(item.warehouse)).filter(Boolean));
  if ((text(payload.warehouse) !== originalWarehouse
      || [...warehouses].some((warehouse) => warehouse !== originalWarehouse))
      && (!warehouseAllowed(user, payload.warehouse)
        || [...warehouses].some((warehouse) => !warehouseAllowed(user, warehouse)))) {
    throw denied('New warehouses must be within your permitted warehouse list.');
  }
  if (text(payload.cost_center) !== text(record.cost_center)
      && !assignedMasterRecordAllowed(user, 'cost-centers', payload.cost_center)) {
    throw denied('The new cost center is outside your permitted list.');
  }
}

async function validateSharedVoucherEdit(user, type, record, payload) {
  const validators = {
    sales: sharedSalesEdit,
    purchases: sharedPurchaseEdit,
    'purchase-orders': sharedPurchaseOrderEdit,
    journals: sharedJournalEdit,
    'stock-reconciliations': sharedReconciliationEdit,
  };
  const validator = validators[type];
  if (!validator) throw denied('This voucher cannot be edited through sharing.');
  await validator(user, record, payload);
}

module.exports = { validateSharedVoucherEdit };
