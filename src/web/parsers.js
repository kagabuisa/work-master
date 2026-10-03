'use strict';
// Shared request-body parsing helpers for the route modules.

function arrayField(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

function parseStockEntryPayload(body) {
  const ids = arrayField(body.id);
  const itemCodes = arrayField(body.item_code);
  const itemNames = arrayField(body.item_name);
  const warehouses = arrayField(body.warehouse);
  const targetWarehouses = arrayField(body.target_warehouse);
  const quantities = arrayField(body.quantity);
  const valuationRates = arrayField(body.valuation_rate);
  return {
    entry_type: body.entry_type,
    action: body.action,
    posting_date: body.posting_date,
    posting_time: body.posting_time,
    remarks: body.remarks,
    supplier_name: body.supplier_name,
    supplier_contact: body.supplier_contact,
    supplier_phone: body.supplier_phone,
    supplier_reference: body.supplier_reference,
    items: itemCodes.map((itemCode, index) => ({
      id: ids[index],
      item_code: itemCode,
      item_name: itemNames[index],
      warehouse: warehouses[index],
      target_warehouse: targetWarehouses[index],
      quantity: quantities[index],
      valuation_rate: valuationRates[index],
    })),
  };
}

module.exports = { arrayField, parseStockEntryPayload };
