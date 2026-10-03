'use strict';
// Thin party lookups used by the journal and invoice route modules.
const { findMasterCustomer, findMasterSupplier, findMasterEmployee } = require('../store');

async function findDbCustomer(customerId) {
  const id = String(customerId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterCustomer(id);
}

async function findDbSupplier(supplierId) {
  const id = String(supplierId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterSupplier(id);
}

async function findDbEmployee(employeeId) {
  const id = String(employeeId || '').trim();
  if (!id) {
    return null;
  }
  return findMasterEmployee(id);
}

module.exports = { findDbCustomer, findDbSupplier, findDbEmployee };
