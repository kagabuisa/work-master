'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionOptionMatches } = require('../public/permission-autocomplete');

test('permission autocomplete matches labels and account codes without regard to case', () => {
  assert(permissionOptionMatches('Chart of Accounts', 'ACCOUNTS'));
  assert(permissionOptionMatches('1319 · Cash Kyenjojo Trdz - SACL', '1319'));
  assert(permissionOptionMatches('1319 · Cash Kyenjojo Trdz - SACL', 'kyenjojo'));
  assert(!permissionOptionMatches('Salary - SACL', 'cash'));
});

test('percent matches ordered fragments, including code and account name', () => {
  assert(permissionOptionMatches('Chart of Accounts', 'chart%accounts'));
  assert(permissionOptionMatches('1319 · Cash Kyenjojo Trdz - SACL', '13%cash%kyenjojo'));
  assert(permissionOptionMatches('5236 · Salary - SACL', '52%'));
  assert(!permissionOptionMatches('1319 · Cash Kyenjojo Trdz - SACL', 'kyenjojo%cash'));
  assert(permissionOptionMatches('Any option', '%%'));
});

test('regular expression characters in record names are literal', () => {
  assert(permissionOptionMatches('Bank (USD) - SACL', '(USD)'));
  assert(!permissionOptionMatches('Bank USD - SACL', '(USD)'));
  assert(!permissionOptionMatches('Anything', '.*'));
  assert(permissionOptionMatches('C$K Factory W/Hse - SACL', 'C$K%W/Hse'));
});
