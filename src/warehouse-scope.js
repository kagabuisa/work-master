'use strict';

// SQL identifiers are fixed by callers, never supplied by request parameters.
function restrictedWarehouseSql(params, expression, access) {
  const checks = [];
  if (Array.isArray(access.allowedWarehouses)) {
    params.push(access.allowedWarehouses);
    checks.push(`${expression} <> ALL($${params.length}::text[])`);
  }
  if (access.deniedWarehouses?.length) {
    params.push(access.deniedWarehouses);
    checks.push(`${expression} = ANY($${params.length}::text[])`);
  }
  return checks.length ? `(${checks.join(' OR ')})` : null;
}

function checkWarehouseFilter(access) {
  const warehouse = String(access.warehouse || '').trim();
  if (warehouse && (Array.isArray(access.allowedWarehouses) && !access.allowedWarehouses.includes(warehouse)
    || access.deniedWarehouses?.includes(warehouse))) {
    const error = new Error('This warehouse is outside your permitted warehouse access.');
    error.status = 403;
    throw error;
  }
}

function addWarehouseRowFilter(where, params, expression, access) {
  checkWarehouseFilter(access);
  const restricted = restrictedWarehouseSql(params, expression, access);
  if (restricted) where.push(`NOT ${restricted}`);
}

function addDocumentWarehouseFilter(where, params, table, parentColumn, parentId, access, { target = false } = {}) {
  const checks = ['warehouse', ...(target ? ['target_warehouse'] : [])].map(column => {
    const expression = `warehouse_scope.${column}`;
    const restricted = restrictedWarehouseSql(params, expression, access);
    return restricted && `(COALESCE(${expression}, '') <> '' AND ${restricted})`;
  }).filter(Boolean);
  if (checks.length) where.push(`NOT EXISTS (SELECT 1 FROM ${table} warehouse_scope
    WHERE warehouse_scope.${parentColumn} = ${parentId} AND (${checks.join(' OR ')}))`);
}

module.exports = { addWarehouseRowFilter, addDocumentWarehouseFilter, checkWarehouseFilter };
