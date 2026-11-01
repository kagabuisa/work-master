'use strict';

const rows = new Map();
const GROUPS = [
  [/^\/api\/v1(?:\/|$)/, 'api.v1'],
  [/^\/reports(?:\/|$)/, 'reports'],
  [/^\/invoices(?:\/|$)/, 'invoices'],
  [/^\/journals(?:\/|$)/, 'journals'],
  [/^\/purchases(?:\/|$)/, 'purchases'],
  [/^\/purchase-orders(?:\/|$)/, 'purchase-orders'],
  [/^\/stock(?:\/|$)/, 'stock'],
  [/^\/hr(?:\/|$)/, 'hr'],
  [/^\/settings(?:\/|$)/, 'settings'],
  [/^\/customers(?:\/|$)/, 'customers'],
  [/^\/suppliers(?:\/|$)/, 'suppliers'],
  [/^\/items(?:\/|$)/, 'items'],
];
const MONITORING_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function routeGroup(path) {
  const normalized = String(path || '/').replace(/\/+$/, '') || '/';
  if (MONITORING_PATHS.has(normalized)) return 'monitoring';
  if (normalized === '/login' || normalized === '/logout') return 'authentication';
  return GROUPS.find(([pattern]) => pattern.test(normalized))?.[1] || 'other';
}

function observeRequest(req, res, next) {
  if (MONITORING_PATHS.has(String(req.path || '').replace(/\/+$/, ''))) {
    next();
    return;
  }
  const started = process.hrtime.bigint();
  let completed = false;
  const finish = (aborted) => {
    if (completed) return;
    completed = true;
    const group = routeGroup(req.path);
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
      ? req.method : 'OTHER';
    const statusClass = aborted ? 'aborted' : `${Math.floor(res.statusCode / 100)}xx`;
    const key = JSON.stringify([group, method, statusClass]);
    const row = rows.get(key) || { group, method, status_class: statusClass, requests: 0, duration_ms_sum: 0 };
    row.requests += 1;
    row.duration_ms_sum += Number(process.hrtime.bigint() - started) / 1e6;
    rows.set(key, row);
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  next();
}

function snapshot() {
  return [...rows.values()].map(row => ({ ...row }));
}

module.exports = { observeRequest, routeGroup, snapshot };
