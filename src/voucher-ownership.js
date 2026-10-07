'use strict';

const { getPostgresPool } = require('./core');

const TABLES = {
  sales: 'app_invoices',
  purchases: 'app_purchases',
  'purchase-orders': 'app_purchase_orders',
  stock: 'app_stock_entries',
  journals: 'app_journal_entries',
};

function voucherOwnerId(user) {
  return user?.role === 'standard' ? String(user.id || '') : null;
}

function voucherEmployeeId(user) {
  return user?.role === 'standard' ? String(user.record_access?.employee_id || '') || null : null;
}

function addVoucherOwnerFilter(where, params, alias, ownerId, employeeId = null) {
  if (ownerId === null || ownerId === undefined) return;
  params.push(String(ownerId));
  const creator = `${alias}.created_by_user_id = $${params.length}`;
  if (!employeeId) { where.push(creator); return; }
  params.push(String(employeeId));
  where.push(`(${creator} OR ${alias}.invoicer_id = $${params.length})`);
}

function addStockLedgerOwnerFilter(where, params, alias, ownerId, employeeId = null) {
  if (ownerId === null || ownerId === undefined) return;
  params.push(String(ownerId));
  const value = `$${params.length}`;
  let invoiceOwner = `owned_invoice.created_by_user_id = ${value}`;
  if (employeeId) {
    params.push(String(employeeId));
    invoiceOwner = `(${invoiceOwner} OR owned_invoice.invoicer_id = $${params.length})`;
  }
  where.push(`(
    (${alias}.voucher_type LIKE 'stock_%' AND EXISTS (
      SELECT 1 FROM app_stock_entries owned_stock
      WHERE owned_stock.id = COALESCE(${alias}.voucher_id, ${alias}.reversal_of_voucher_id)
        AND owned_stock.created_by_user_id = ${value}))
    OR (${alias}.voucher_type = 'purchase' AND EXISTS (
      SELECT 1 FROM app_purchases owned_purchase
      WHERE owned_purchase.id = ${alias}.voucher_id AND owned_purchase.created_by_user_id = ${value}))
    OR (${alias}.voucher_type = 'invoice' AND EXISTS (
      SELECT 1 FROM app_invoices owned_invoice
      WHERE owned_invoice.id = ${alias}.voucher_id AND ${invoiceOwner}))
  )`);
}

async function voucherOwnedByUser(user, kind, id, pool) {
  const ownerId = voucherOwnerId(user);
  if (ownerId === null) return true;
  const table = TABLES[kind];
  const voucherId = Number(id);
  if (!table || !Number.isSafeInteger(voucherId) || voucherId < 1 || !ownerId) return false;
  const employeeId = kind === 'sales' ? voucherEmployeeId(user) : null;
  const params = [voucherId, ownerId];
  let ownerSql = 'created_by_user_id = $2';
  if (employeeId) {
    params.push(employeeId);
    ownerSql = `(${ownerSql} OR invoicer_id = $3)`;
  }
  const { rows } = await (pool || getPostgresPool()).query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND ${ownerSql} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

module.exports = { voucherOwnerId, voucherEmployeeId, addVoucherOwnerFilter,
  addStockLedgerOwnerFilter, voucherOwnedByUser };
