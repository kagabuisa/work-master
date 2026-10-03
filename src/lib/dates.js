'use strict';
// Date helpers.

function dateOnly(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toIsoString(value) {
  if (!value) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function nullableIsoString(value) {
  return value ? toIsoString(value) : null;
}

function dateInRange(date, from, to) {
  const value = String(date || '').slice(0, 10);
  if (from && value < from) {
    return false;
  }
  if (to && value > to) {
    return false;
  }
  return true;
}

module.exports = { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange };
