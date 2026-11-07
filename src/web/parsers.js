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
    ...require("../voucher-controls").requestFields(body),
    entry_type: body.entry_type,
    action: body.action,
    posting_date: body.posting_date,
    posting_time: body.posting_time,
    cost_center: body.cost_center,
    remarks: body.remarks,
    delivery_status: body.delivery_status,
    delivery_details: deliveryDetailsFromBody(body),
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

function deliveryDetailsFromBody(body = {}) {
  const text = (value, maximum) => String(value || '').trim().slice(0, maximum);
  const fields = {
    picked_employee_id: [100, text],
    picked_employee_name: [140, text],
    picked_date: [10, text],
    in_transit_date: [10, text],
    transporter_name: [140, text],
    transporter_phone: [40, text],
    delivered_date: [10, text],
    received_date: [10, text],
    received_by_employee_id: [100, text],
    received_by_employee_name: [140, text],
    received_confirmed: [0, value => ['1', 'on', 'true'].includes(String(value || '').toLowerCase())],
  };
  return Object.fromEntries(Object.entries(fields)
    .filter(([name]) => Object.prototype.hasOwnProperty.call(body, name))
    .map(([name, [maximum, normalize]]) => [name, normalize(body[name], maximum)]));
}

module.exports = { arrayField, deliveryDetailsFromBody, parseStockEntryPayload };
