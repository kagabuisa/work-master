'use strict';

function applyReconciliationRatePolicy(items, user, balances = [], existingItems = []) {
  if (user?.role === 'admin') return items;
  const rates = new Map(balances.map((balance) =>
    [balance.item_code, Number(balance.valuation_rate || 0)]));
  for (const item of existingItems) rates.set(item.item_code, Number(item.valuation_rate || 0));
  return items.map((item) => ({ ...item, valuation_rate: rates.get(item.item_code) ?? 0 }));
}

module.exports = { applyReconciliationRatePolicy };
