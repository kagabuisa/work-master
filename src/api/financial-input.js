'use strict';
const { apiError, bodyFields } = require('./errors');
const { isValidIsoDate } = require('../lib/dates');

function text(value, field, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')
    || (!empty && !value.trim()) || value !== value.trim()) {
    throw apiError(400, 'invalid_request', `${field} must be a trimmed string of ${empty ? '0' : '1'}–${max} characters without NUL.`);
  }
  return value;
}

function date(value, field) {
  if (typeof value !== 'string' || value < '0001-01-01' || !isValidIsoDate(value)) {
    throw apiError(400, 'invalid_request', `${field} must be a valid YYYY-MM-DD date (year 0001–9999).`);
  }
  return value;
}

function decimal(value, field, scale, maximum, { positive = false } = {}) {
  const pattern = new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${scale}})?$`);
  if (typeof value !== 'string' || value.length > 20 || !pattern.test(value)
    || Number(value) > maximum || (positive && Number(value) <= 0)) {
    throw apiError(400, 'invalid_request', `${field} must be a ${positive ? 'positive' : 'nonnegative'} decimal string with at most ${scale} decimal places and maximum ${maximum}.`);
  }
  return value;
}

function accountId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw apiError(400, 'invalid_request', 'account_id must be a positive safe-integer string.');
  }
  return value;
}

function invoiceCreate(body) {
  bodyFields(body, ['customer_id', 'warehouse', 'price_list', 'invoicer_id', 'invoice_date', 'items'],
    ['due_date', 'posting_time', 'cost_center', 'notes', 'non_system_invoice', 'tax_amount', 'discount_amount']);
  const payload = {};
  for (const field of ['customer_id', 'warehouse', 'price_list', 'invoicer_id']) payload[field] = text(body[field], field, 200);
  payload.invoice_date = date(body.invoice_date, 'invoice_date');
  if (body.due_date !== undefined) payload.due_date = date(body.due_date, 'due_date');
  if (body.posting_time !== undefined) {
    if (typeof body.posting_time !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/.test(body.posting_time)) {
      throw apiError(400, 'invalid_request', 'posting_time must be HH:mm or HH:mm:ss.');
    }
    payload.posting_time = body.posting_time;
  }
  for (const [field, max] of [['cost_center', 200], ['notes', 4000], ['non_system_invoice', 100]]) {
    if (body[field] !== undefined) payload[field] = text(body[field], field, max, { empty: true });
  }
  for (const field of ['tax_amount', 'discount_amount']) {
    if (body[field] !== undefined) payload[field] = decimal(body[field], field, 2, 999999999999);
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
    throw apiError(400, 'invalid_request', 'Provide between 1 and 200 invoice lines.');
  }
  payload.items = body.items.map(item => {
    bodyFields(item, ['item_code', 'quantity', 'unit_price']);
    return { item_code: text(item.item_code, 'item_code', 200),
      quantity: decimal(item.quantity, 'quantity', 3, 99999999999.999, { positive: true }),
      unit_price: decimal(item.unit_price, 'unit_price', 2, 999999999999) };
  });
  return payload;
}

function paymentCreate(body) {
  bodyFields(body, ['payment_date', 'amount', 'account_id', 'external_source', 'external_reference'], ['notes']);
  return { payment_date: date(body.payment_date, 'payment_date'),
    // Existing UGX rounding must leave a positive receipt.
    amount: decimal(body.amount, 'amount', 2, 999999999999, { positive: true }),
    account_id: accountId(body.account_id),
    external_source: text(body.external_source, 'external_source', 100),
    external_reference: text(body.external_reference, 'external_reference', 200),
    ...(body.notes === undefined ? {} : { notes: text(body.notes, 'notes', 4000, { empty: true }) }) };
}

function idempotencyKey(req) {
  // Duplicate headers are ambiguous even if Node joins them into one string.
  const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  const key = req.get('Idempotency-Key');
  if (count !== 1 || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw apiError(400, 'idempotency_key_required', 'Send exactly one Idempotency-Key of 1–128 visible ASCII characters without spaces.');
  }
  return key;
}
module.exports = { invoiceCreate, paymentCreate, idempotencyKey };
