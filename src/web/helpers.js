'use strict';
// Shared HTTP-layer helpers used by the route modules.
const { allowedNamedListValues, deniedNamedListValues, allowedMasterRecordIds, deniedMasterRecordIds } = require('../access');

function warehouseAccessOptions(user) {
  return {
    allowedWarehouses: allowedNamedListValues(user, 'warehouses'),
    deniedWarehouses: deniedNamedListValues(user, 'warehouses'),
  };
}

function accountAccessOptions(user) {
  return {
    allowedAccounts: allowedNamedListValues(user, 'accounts'),
    deniedAccounts: deniedNamedListValues(user, 'accounts'),
  };
}

function hrLedgerAccessOptions(user) {
  const has=(permission)=>user?.role==='admin'||user?.permissions?.includes(permission);
  return { hrAccess: {
    payroll: Boolean(has('hr.payroll.view')), money: Boolean(has('hr.money.view')),
    employees: allowedMasterRecordIds(user,'employees'), deniedEmployees: deniedMasterRecordIds(user,'employees'),
    costCenters: allowedMasterRecordIds(user,'cost-centers'), deniedCostCenters: deniedMasterRecordIds(user,'cost-centers'),
  } };
}

module.exports = { warehouseAccessOptions, accountAccessOptions, hrLedgerAccessOptions };
