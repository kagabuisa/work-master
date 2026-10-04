const REPORTS = [
  { slug: 'daily-activity', label: 'Daily Activity' },
  { slug: 'debtors', label: 'Debtors' },
  { slug: 'stock-ledger', label: 'Stock Ledger' },
  { slug: 'stock-movement', label: 'Stock Movement' },
  { slug: 'gross-profit', label: 'Gross Profit' },
  { slug: 'general-ledger', label: 'General Ledger' },
  { slug: 'trial-balance', label: 'Trial Balance' },
  { slug: 'profit-and-loss', label: 'Profit & Loss' },
  { slug: 'balance-sheet', label: 'Balance Sheet' },
].map((report) => ({ ...report, permission: `reports.${report.slug}.view`, href: `/reports/${report.slug}` }));

module.exports = { REPORTS };
