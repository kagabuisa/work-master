'use strict';

// Four-digit local codes; ERPNext document identifiers are stored separately.
const GROUP_BASES = {
  'Application of Funds (Assets)': 1000, 'Current Assets': 1090,
  'Accounts Receivable': 1101, 'Stock Assets': 1201,
  'Cash In Hand': 1300, 'Bank Accounts': 1400,
  'Loans and Advances (Assets)': 1500, Prepayments: 1600,
  'Securities and Deposits': 1700, 'Tax Assets': 1800, 'Fixed Assets': 1900,
  'Source of Funds (Liabilities)': 2000, 'Current Liabilities': 2090,
  'Accounts Payable': 2101, 'Duties and Taxes': 2201,
  'Loans (Liabilities)': 2300, 'Stock Liabilities': 2400,
  Equity: 3100, Income: 4900, 'Direct Income': 4200, 'Indirect Income': 4300,
  Expenses: 5900, 'Direct Expenses': 5050, 'Stock Expenses': 5001,
  'Indirect Expenses': 5200, 'Fuel Expense': 5300, Insurance: 5400,
  'Maintenance & Repairs': 5500,
};
const FALLBACK = { asset: 1950, liability: 2500, equity: 3200, income: 4400, expense: 5600 };

function accountCodePlan(rows, existingRows) {
  const existing = new Map(existingRows.map((row) => [row.erpnext_account_name || row.account_code, row]));
  const used = new Set(existingRows.map((row) => row.account_code));
  const source = new Map(rows.map((row) => [row.name, row]));
  const codes = new Map();
  const visiting = new Set();
  function allocate(row) {
    if (codes.has(row.name)) return codes.get(row.name);
    if (visiting.has(row.name)) throw new Error(`Account hierarchy contains a cycle: ${row.name}`);
    visiting.add(row.name);
    const old = existing.get(row.name);
    if (old && (old.erpnext_account_name || /^\d{4}$/.test(old.account_code || ''))) {
      codes.set(row.name, old.account_code);
      visiting.delete(row.name);
      return old.account_code;
    }
    const type = String(row.root_type || '').toLowerCase();
    if (!FALLBACK[type]) throw new Error(`Unsupported root type for ${row.name}`);
    const label = String(row.account_name || row.name).replace(/\s+-\s+[^-]+$/, '').trim();
    const group = Boolean(Number(row.is_group));
    let base = group ? GROUP_BASES[label] : undefined;
    if (!base && row.parent_account) {
      const parent = source.get(row.parent_account);
      if (!parent) throw new Error(`Missing parent for ${row.name}`);
      base = Number(allocate(parent)) + 1;
    }
    base ||= FALLBACK[type];
    if (Math.floor(base / 1000) !== Math.floor(FALLBACK[type] / 1000)) {
      throw new Error(`Account code range does not match root type for ${row.name}`);
    }
    let code = base;
    // Keep category boundaries available for group accounts.
    const reserved = new Set(Object.values(GROUP_BASES));
    while (used.has(String(code)) || (!group && reserved.has(code))) code++;
    if (code >= Math.floor(base / 100) * 100 + 100) throw new Error(`Account code category is full for ${row.name}`);
    used.add(String(code));
    codes.set(row.name, String(code));
    visiting.delete(row.name);
    return String(code);
  }
  // Reserve groups before allocating their posting accounts.
  rows.filter((row) => Number(row.is_group)).sort((a, b) => a.name.localeCompare(b.name)).forEach(allocate);
  [...rows].sort((a, b) => a.name.localeCompare(b.name)).forEach(allocate);
  return codes;
}

module.exports = { accountCodePlan };
