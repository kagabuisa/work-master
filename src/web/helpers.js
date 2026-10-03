'use strict';
// Shared HTTP-layer helpers used by the route modules.
const { allowedNamedListValues, deniedNamedListValues } = require('../access');

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

module.exports = { warehouseAccessOptions, accountAccessOptions };
