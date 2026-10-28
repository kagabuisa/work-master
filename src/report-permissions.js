const ADMIN_REPORT_SLUGS = new Set(['gross-profit', 'trial-balance', 'profit-and-loss', 'balance-sheet']);
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
].map((report) => ({ ...report, adminOnly: ADMIN_REPORT_SLUGS.has(report.slug),
  permission: `reports.${report.slug}.view`, href: `/reports/${report.slug}` }));

const ADMIN_REPORT_PERMISSIONS = new Set(REPORTS.filter(report => report.adminOnly).map(report => report.permission));
module.exports = { REPORTS, ADMIN_REPORT_SLUGS, ADMIN_REPORT_PERMISSIONS };
