'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accountCodePlan } = require('../src/account-codes');

const rows = [
  { name: 'Expenses - SACL', root_type: 'Expense', is_group: 1 },
  { name: 'Indirect Expenses - SACL', root_type: 'Expense', is_group: 1, parent_account: 'Expenses - SACL' },
  { name: 'Salary - SACL', root_type: 'Expense', is_group: 0, parent_account: 'Indirect Expenses - SACL' },
  { name: 'Rent - SACL', root_type: 'Expense', is_group: 0, parent_account: 'Indirect Expenses - SACL' },
];

test('codes follow categories, avoid existing codes, and are independent of source ordering', () => {
  const existing = [{ account_code: '5201' }];
  const codes = accountCodePlan(rows, existing);
  assert.equal(codes.get('Expenses - SACL'), '5900');
  assert.equal(codes.get('Indirect Expenses - SACL'), '5200');
  assert.equal(codes.get('Rent - SACL'), '5202');
  assert.equal(codes.get('Salary - SACL'), '5203');
  assert.deepEqual([...codes].sort(), [...accountCodePlan([...rows].reverse(), existing)].sort());
});

test('subsequent imports preserve assigned codes and local edits', () => {
  const initial = accountCodePlan(rows, []);
  const existing = rows.map(row => ({ erpnext_account_name: row.name, account_code: initial.get(row.name) }));
  existing.find(row => row.erpnext_account_name === 'Salary - SACL').account_code = '5999';
  const added = { name: 'Airtime - SACL', root_type: 'Expense', is_group: 0, parent_account: 'Indirect Expenses - SACL' };
  const codes = accountCodePlan([...rows, added], existing);
  for (const row of existing) assert.equal(codes.get(row.erpnext_account_name), row.account_code);
  assert.equal(codes.get(added.name), '5202');
});
