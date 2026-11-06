'use strict';

const { dateInRange } = require('./lib/dates');
const { roundMoney } = require('./lib/money');

const SOURCE_DEFINITIONS = [
  { key: 'salary', label: 'Salary' },
  { key: 'deductions', label: 'Deductions' },
  { key: 'advances', label: 'Advances & loans' },
  { key: 'payments', label: 'Salary payments' },
  { key: 'receipts', label: 'Receipts & repayments' },
  { key: 'reimbursements', label: 'Reimbursements' },
  { key: 'recoveries', label: 'Recoveries & charges' },
  { key: 'other', label: 'Other' },
];
const SOURCE_LABELS = Object.fromEntries(SOURCE_DEFINITIONS.map(({ key, label }) => [key, label]));

function statementRange(rows, { from = '', to = '' }) {
  const ordered = [...rows]
    .filter(Boolean)
    .sort((left, right) => String(left.date).localeCompare(String(right.date))
      || Number(left.voucher_id || 0) - Number(right.voucher_id || 0)
      || Number(left.entry_id || 0) - Number(right.entry_id || 0));
  let runningBalance = 0;
  const complete = ordered.map((row) => {
    const debit = roundMoney(row.debit);
    const credit = roundMoney(row.credit);
    runningBalance = roundMoney(runningBalance + debit - credit);
    return {
      date: String(row.date || '').slice(0, 10),
      source: row.source,
      sourceLabel: row.sourceLabel,
      category: row.category,
      period: row.period || '',
      type: row.type,
      reference: row.reference || '',
      description: row.description || '',
      href: row.href || '',
      debit,
      credit,
      balance: runningBalance,
    };
  });
  const openingBalance = from
    ? complete.filter((entry) => entry.date < from).at(-1)?.balance || 0
    : 0;
  const statement = complete.filter((entry) => dateInRange(entry.date, from, to));
  statement.forEach((entry, index) => { entry.number = index + 1; });
  return {
    statement,
    openingBalance: roundMoney(openingBalance),
    closingBalance: roundMoney(statement.length ? statement.at(-1).balance : openingBalance),
    totalDebit: roundMoney(statement.reduce((sum, entry) => sum + entry.debit, 0)),
    totalCredit: roundMoney(statement.reduce((sum, entry) => sum + entry.credit, 0)),
  };
}

function moneyEntry(row) {
  const cancellation = String(row.voucher_type).endsWith('_cancellation');
  let type;
  let description;
  let source;
  let category;
  if (String(row.voucher_type).startsWith('hr_money')) {
    const labels = {
      advance: 'Advance',
      loan: 'Loan',
      recovery: 'Recovery / charge',
      reimbursement: 'Reimbursement',
    };
    type = cancellation ? 'Reversal' : labels[row.money_kind] || 'Employee transaction';
    source = row.money_kind === 'recovery' ? 'recoveries'
      : row.money_kind === 'reimbursement' ? 'reimbursements' : 'advances';
    category = row.money_kind === 'recovery' ? 'charge'
      : row.money_kind === 'reimbursement' ? 'reimbursement' : 'advance';
    description = cancellation
      ? `Cancellation of HRM-${row.money_id} · ${row.money_reason || ''}`
      : row.money_reason || '';
  } else if (String(row.voucher_type).startsWith('hr_payroll')) {
    type = cancellation ? 'Reversal' : 'Payroll recovery';
    source = 'recoveries';
    category = 'loanRecovery';
    description = [
      `HRM-${row.money_id}`,
      row.money_reason,
      `Payroll ${row.payroll_period || row.voucher_no || ''}`,
      cancellation ? `Cancellation of ${row.voucher_no || 'payroll'}` : '',
    ].filter(Boolean).join(' · ');
  } else {
    const payout = row.direction === 'payout';
    if (cancellation) type = 'Reversal';
    else if (row.money_kind === 'reimbursement') type = 'Reimbursement payment';
    else if (payout) type = 'Advance / loan';
    else type = 'Receipt';
    source = row.money_kind === 'reimbursement' ? 'reimbursements'
      : payout ? 'advances' : 'receipts';
    category = row.money_kind === 'reimbursement' ? 'reimbursementPayment'
      : payout ? 'advance' : 'receipt';
    description = [
      `HRM-${row.money_id}`,
      row.money_reason,
      row.payment_reference ? `Ref ${row.payment_reference}` : '',
      cancellation ? `Cancellation of ${row.voucher_no || 'payment'}` : '',
    ].filter(Boolean).join(' · ');
  }
  return {
    ...row,
    source,
    sourceLabel: SOURCE_LABELS[source],
    category,
    type,
    reference: cancellation ? `Reversal ${row.voucher_no || ''}`.trim() : row.voucher_no || '',
    description,
    href: row.money_id ? `/hr/money#money-${row.money_id}` : '',
  };
}

function salaryEntry(row) {
  const cancellation = String(row.voucher_type).endsWith('_cancellation');
  const isPayment = String(row.voucher_type).startsWith('hr_payment');
  let type;
  let description;
  let source;
  let category;
  if (isPayment) {
    type = cancellation ? 'Reversal' : 'Salary payment';
    source = 'payments';
    category = 'salaryPayment';
    description = [
      `Payroll ${row.period || ''}`.trim(),
      row.payment_reference ? `Ref ${row.payment_reference}` : '',
      cancellation ? `Cancellation of ${row.voucher_no || 'payment'}` : '',
    ].filter(Boolean).join(' · ');
  } else {
    const earning = row.component_kind === 'earning';
    type = cancellation ? 'Reversal' : earning ? 'Salary' : 'Deduction';
    source = earning ? 'salary' : 'deductions';
    category = earning ? 'salary' : 'deduction';
    description = [
      row.component_label || (earning ? 'Salary earning' : 'Payroll deduction'),
      `Payroll ${row.period || row.voucher_no || ''}`,
      cancellation ? `Cancellation of ${row.voucher_no || 'payroll'}` : '',
    ].filter(Boolean).join(' · ');
  }
  return {
    ...row,
    source,
    sourceLabel: SOURCE_LABELS[source],
    category,
    type,
    reference: cancellation ? `Reversal ${row.voucher_no || ''}`.trim() : row.voucher_no || '',
    description,
    href: row.slip_id ? `/hr/payslips/${row.slip_id}` : '',
  };
}

function buildEmployeeStatementReport({
  employee,
  moneyRows = [],
  salaryRows = [],
  from = '',
  to = '',
  source = '',
  order = 'date',
}) {
  const rows = [
    ...moneyRows.map((row) => ({ ...row, source: 'money' })),
    ...salaryRows.map((row) => ({ ...row, source: 'salary' })),
  ].map((row) => row.source === 'money' ? moneyEntry(row) : salaryEntry(row));
  const dateRows = rows.filter((row) => dateInRange(row.date, from, to));
  const selectedSource = SOURCE_DEFINITIONS.some((definition) => definition.key === source) ? source : '';
  const sourceOptions = SOURCE_DEFINITIONS.map((definition) => ({
    ...definition,
    count: dateRows.filter((row) => row.source === definition.key).length,
  })).filter((option) => option.count > 0 || option.key === selectedSource);
  const filteredRows = selectedSource ? rows.filter((row) => row.source === selectedSource) : rows;
  const ledger = statementRange(filteredRows, { from, to });
  const sourceGroups = SOURCE_DEFINITIONS
    .map((definition) => {
      const entries = ledger.statement.filter((entry) => entry.source === definition.key);
      return {
        ...definition,
        entries,
        totalDebit: roundMoney(entries.reduce((sum, entry) => sum + entry.debit, 0)),
        totalCredit: roundMoney(entries.reduce((sum, entry) => sum + entry.credit, 0)),
      };
    })
    .filter((group) => group.entries.length);
  const categoryAmount = (category) => roundMoney(ledger.statement.reduce((sum, entry) => {
    if (entry.category !== category) return sum;
    return ['salary', 'loanRecovery', 'receipt', 'reimbursement'].includes(category)
      ? sum + entry.credit - entry.debit
      : sum + entry.debit - entry.credit;
  }, 0));
  const grossSalaryEarned = categoryAmount('salary');
  const totalDeductions = categoryAmount('deduction');
  const loanRecovery = categoryAmount('loanRecovery');
  const netSalaryPaid = categoryAmount('salaryPayment');
  const advancesIssued = categoryAmount('advance');
  const receiptsReceived = categoryAmount('receipt');
  const recoveryCharges = categoryAmount('charge');
  const employeeBalance = roundMoney(categoryAmount('advance') + categoryAmount('charge')
    - categoryAmount('receipt') - loanRecovery);
  const salaryOutstanding = roundMoney(grossSalaryEarned - totalDeductions - netSalaryPaid);
  const reimbursementBalance = roundMoney(categoryAmount('reimbursement')
    - categoryAmount('reimbursementPayment'));
  const payrollByPeriod = [...new Set(ledger.statement
    .filter((entry) => ['salary', 'deduction', 'salaryPayment'].includes(entry.category))
    .map((entry) => entry.period)
    .filter(Boolean))]
    .sort()
    .map((period) => {
      const entries = ledger.statement.filter((entry) => entry.period === period);
      const salary = roundMoney(entries.filter((entry) => entry.category === 'salary')
        .reduce((sum, entry) => sum + entry.credit - entry.debit, 0));
      const deductions = roundMoney(entries.filter((entry) => entry.category === 'deduction')
        .reduce((sum, entry) => sum + entry.debit - entry.credit, 0));
      const paid = roundMoney(entries.filter((entry) => entry.category === 'salaryPayment')
        .reduce((sum, entry) => sum + entry.debit - entry.credit, 0));
      return {
        period,
        salary,
        deductions,
        paid,
        outstanding: roundMoney(salary - deductions - paid),
      };
    });
  return {
    employee,
    filters: { from, to, source: selectedSource, order: order === 'date' ? 'date' : 'source' },
    sourceOptions,
    sourceGroups,
    summary: {
      grossSalaryEarned,
      totalDeductions,
      loanRecovery,
      netSalaryPaid,
      advancesIssued,
      receiptsReceived,
      recoveryCharges,
      employeeBalance,
      salaryOutstanding,
      reimbursementBalance,
    },
    payrollByPeriod,
    ...ledger,
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function employeeStatementCsv(report) {
  const rows = [
    ['Employee statement'],
    ['Employee', report.employee.employee_name],
    ['Employee ID', report.employee.employee_id],
    ['From', report.filters.from],
    ['To', report.filters.to],
    [],
    ['Date', 'Source', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'],
  ];
  for (const entry of report.statement) {
    rows.push([entry.date, entry.sourceLabel, entry.type, entry.reference, entry.description,
      entry.debit, entry.credit, entry.balance]);
  }
  rows.push(['', '', '', '', 'Closing balance', '', '', report.closingBalance]);
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  SOURCE_DEFINITIONS,
  buildEmployeeStatementReport,
  employeeStatementCsv,
};
