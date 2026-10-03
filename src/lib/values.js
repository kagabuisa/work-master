'use strict';
// Small value coercion helpers.

function optionalValue(value) {
  return String(value || '').trim() || null;
}

function requiredValue(value, message) {
  const normalized = optionalValue(value);
  if (!normalized) {
    const err = new Error(message);
    err.status = 400;
    throw err;
  }
  return normalized;
}

module.exports = { optionalValue, requiredValue };
