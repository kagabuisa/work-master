'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');
const { employeeDetailsPdf, sendEmployeeDetailsPdf } = require('../src/web/employee-details-pdf');
const { employeeDetailFields } = require('../src/hr-employee-fields');

test('Employee PDFs include all details and paginate long text without clipping', async () => {
  const original = PDFDocument.prototype.text;
  const printed = [];
  PDFDocument.prototype.text = function(value, x, y, options) {
    printed.push(String(value));
    if (typeof y === 'number') assert.ok(y < this.page.height - 24, `Text outside printable page: ${y}`);
    return original.call(this, value, x, y, options);
  };
  try {
    const employee = { employee_id: 'EMP/0001', employee_name: 'Émployee • Test', company: 'Sample Company', status: 'Active', joining_date: '2026-01-01', leaving_date: '2026-12-31', manager_id: 'MANAGER-1', cost_center: 'Shop One', branch: 'Central', employment_type: 'Permanent', disabled: false, details: { references_phone: '+256-OLD' } };
    for (const field of employeeDetailFields) employee[field.name] = field.type === 'date' ? '1990-04-12' : `Saved ${field.label}`;
    employee.education = `Education beginning\n${'Education history '.repeat(550)}\nEducation ending`;
    employee.work_experience = `Work beginning\n${'Z'.repeat(10000)}\nWork ending`;
    const plans = [{ effective_from: '2026-01-01', notes: 'Plan note', components: [{ label: 'Basic salary', kind: 'earning', amount: 100000, prorate: true, account_id: 1 }, { label: 'Employer contribution', kind: 'employer', amount: 5000, payable_account_id: 2, account_id: 1 }] }];
    const buffer = await employeeDetailsPdf({ employee, plans, includePayPlans: true, managerName: 'Manager Name', accounts: [{ id: 1, account_name: 'Salary expense' }, { id: 2, account_name: 'Salary payable' }] }, { company: { name: 'Sample Company' }, formatDate: value => `Date ${value}` });
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    const text = printed.join('\n');
    for (const field of employeeDetailFields) assert.ok(text.includes(field.label.toUpperCase()), `${field.label} is printed`);
    for (const value of ['Émployee • Test', 'Education ending', 'Work ending', 'Manager Name', '+256-OLD', 'Salary expense', 'Salary payable', '100,000.00', 'Plan note', 'Date 1990-04-12']) assert.ok(text.includes(value), `${value} is printed`);
    assert.equal(printed.filter(line => /^Z+$/.test(line)).reduce((total, line) => total + line.length, 0), 10000);
    const pages = (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.ok(pages > 3);
    assert.ok(text.includes(`Page ${pages} of ${pages}`));
    printed.length = 0;
    await employeeDetailsPdf({ employee: { employee_id: 'EMPTY', employee_name: 'Empty employee' }, plans, includePayPlans: false });
    assert.ok(!printed.includes('Pay-plan history'), 'pay data is excluded without permission');
    assert.ok(printed.includes('—'));
  } finally { PDFDocument.prototype.text = original; }
});

test('Employee PDF downloads have safe filenames and private response headers', async () => {
  const res = { headers: {}, set(name, value) { this.headers[name] = value; }, attachment(value) { this.filename = value; }, type(value) { this.contentType = value; }, send(value) { this.body = value; } };
  await sendEmployeeDetailsPdf(res, { employee: { employee_id: 'EMP/0001', employee_name: 'Employee' } });
  assert.equal(res.filename, 'EMP-0001-employee-details.pdf');
  assert.equal(res.contentType, 'application/pdf');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.ok(res.body.length > 1000);
});
