'use strict';

const { isValidIsoDate } = require('./lib/dates');
const { allowedMasterRecordIds, deniedMasterRecordIds, accountAllowed, assignedMasterRecordAllowed } = require('./access');

const HR_AREAS = [
  { key: 'employees', label: 'HR Employees', actions: ['view', 'edit'] },
  { key: 'attendance', label: 'Attendance', actions: ['view', 'create', 'submit', 'cancel'] },
  { key: 'leave', label: 'Leave', actions: ['view', 'create', 'edit', 'submit', 'cancel'] },
  { key: 'money', label: 'Employee Money', actions: ['view', 'create', 'submit', 'pay', 'cancel'] },
  { key: 'payroll', label: 'Payroll', actions: ['view', 'create', 'edit', 'submit', 'pay', 'cancel'] },
  { key: 'settings', label: 'HR Settings', actions: ['view', 'edit'] },
];
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function date(value, label = 'Date') {
  if (typeof value !== 'string' || !isValidIsoDate(value)) fail(`${label} must be a valid date.`);
  return value;
}
function amount(value, label = 'Amount', allowZero = true) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || !Number.isFinite(Number(s)) || Number(s) > 999999999999.99
      || (!allowZero && Number(s) === 0)) fail(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} amount with at most two decimal places.`);
  return Number(s);
}
function cents(value) { return Math.round(Number(value) * 100); }
function monthPeriod(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value)) || Number(value.slice(0,4)) < 1900 || Number(value.slice(0,4)) > 2200) fail('Choose a valid payroll month.');
  const start = `${value}-01`;
  const end = new Date(Date.UTC(Number(value.slice(0,4)), Number(value.slice(5)), 0)).toISOString().slice(0,10);
  return { start, end, days: Number(end.slice(-2)) };
}
function employeeAllowed(user, employeeId, costCenter) {
  if (user?.role === 'admin') return true;
  const allowed = allowedMasterRecordIds(user, 'employees');
  return !deniedMasterRecordIds(user, 'employees').includes(employeeId)
    && (allowed === null || allowed.includes(employeeId))
    && (!costCenter || assignedMasterRecordAllowed(user, 'cost-centers', costCenter));
}
function assertEmployee(user, employeeId, costCenter) {
  if (!employeeAllowed(user, employeeId, costCenter)) fail('This employee or cost center is outside your permitted records.', 403);
}
function assertAccount(user, id) {
  if (!accountAllowed(user, String(id))) fail('This account is outside your permitted accounts.', 403);
}
function calculatePay(components, paidDays, calendarDays) {
  if (!Array.isArray(components) || !components.length || components.length > 50) fail('Add between one and fifty pay components.');
  const paid = amount(paidDays, 'Paid days'); const days = amount(calendarDays, 'Calendar days', false);
  if (paid > days || days > 31) fail('Paid days must be between zero and the number of calendar days.');
  let gross = 0; let deduction = 0; let employer = 0;
  const lines = components.map((line) => {
    if (!['earning','deduction','employer'].includes(line.kind) || !String(line.label || '').trim()) fail('Each component needs a name and valid type.');
    const base = amount(line.amount, `${line.label} amount`);
    const value = Math.round(cents(base) * (line.prorate ? paid / days : 1));
    if (line.kind === 'earning') gross += value;
    else if (line.kind === 'deduction') deduction += value;
    else employer += value;
    return { ...line, amount: base, calculated_amount: value / 100 };
  });
  if (!components.some((line) => line.kind === 'earning')) fail('Include an earnings component.');
  if (Math.max(gross,deduction,employer)>99999999999999) fail('Payroll totals exceed the supported amount.');
  if (deduction > gross) fail('Deductions cannot exceed gross pay.');
  return { components: lines, gross_pay: gross/100, deductions: deduction/100, net_pay: (gross-deduction)/100, employer_cost: employer/100 };
}
function permissionForHr(path, method) {
  const p = path.split('/').filter(Boolean);
  if (p[0] !== 'hr') return null;
  if (p.length === 1 && method === 'GET') return 'any';
  if (p[1] === 'payslips' && method === 'GET' && (p.length === 2 || p.length === 3 && /^\d+$/.test(p[2]))) return 'hr.payroll.view';
  const [ , area, id, action] = p;
  if (!HR_AREAS.some((a) => a.key === area)) return null;
  if (method === 'GET') {
    if ((area === 'settings' || area === 'attendance' || area === 'leave' || area === 'money') && p.length === 2) return `hr.${area}.view`;
    if (area === 'employees' && (p.length === 2 || p.length === 3)) return 'hr.employees.view';
    if (area === 'payroll' && p.length === 4 && action === 'export' && /^\d+$/.test(id)) return 'hr.payroll.view';
    if (area === 'payroll' && (p.length === 2 || p.length === 3 || p.length === 5 && action === 'payslips' && /^\d+$/.test(p[4]))) return 'hr.payroll.view';
    return null;
  }
  if (method !== 'POST') return null;
  if (p.length === 2 && ['attendance','money','payroll','leave'].includes(area)) return `hr.${area}.create`;
  if (area === 'settings' && p.length === 2) return 'hr.settings.edit';
  if (area === 'employees' && p.length === 4 && action === 'profile') return 'hr.employees.edit';
  if (area === 'employees' && p.length === 4 && action === 'pay-plan') return 'hr.payroll.edit';
  if (area === 'leave' && p.length === 3 && id === 'allocations') return 'hr.leave.edit';
  if (area === 'payroll' && p.length === 5 && action === 'slips') return 'hr.payroll.edit';
  if (p.length === 4 && /^\d+$/.test(id)) {
    if ((action === 'submit' || action === 'cancel') && HR_AREAS.find((a) => a.key === area).actions.includes(action)) return `hr.${area}.${action}`;
    if (['pay','return'].includes(action) && ['money','payroll'].includes(area)) return `hr.${area}.pay`;
    if (action === 'cancel-payment' && ['money','payroll'].includes(area)) return `hr.${area}.cancel`;
  }
  return null;
}

module.exports = { HR_AREAS, fail, date, amount, cents, monthPeriod, assertEmployee, employeeAllowed, assertAccount, calculatePay, permissionForHr };
