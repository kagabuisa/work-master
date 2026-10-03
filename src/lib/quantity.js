'use strict';
// Quantity normalisation. Quantities carry three decimal places; stock quantities
// snap to whole units within a 0.0015 tolerance.

function normalizeQuantity(value) {
  return Math.max(0, Number(Number(value || 0).toFixed(3)));
}

function normalizeStockQuantity(value) {
  const quantity = Number(value || 0);
  const rounded = Math.round(quantity);
  return Math.abs(quantity - rounded) <= 0.0015
    ? rounded
    : Number(quantity.toFixed(3));
}

module.exports = { normalizeQuantity, normalizeStockQuantity };
