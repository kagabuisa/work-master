'use strict';
const ROUTES = [
  '/auth/login', '/auth/refresh', '/auth/logout', '/auth/password', '/me',
  '/integration-accounts', '/integration-credentials', '/integration-credentials/:id/revoke',
  '/customers', '/suppliers', '/items', '/warehouses', '/price-lists', '/cost-centers',
  '/stock-balances', '/invoices', '/invoices/:id', '/invoices/:id/submit', '/invoices/:id/payments', '/sales-options',
];
const BOUNDS = [10, 50, 100, 250, 500, 1000, 3000, 15000];
const OUTCOMES = new Set(['committed', 'replayed', 'reference_replayed']);

function routeTemplate(path) {
  const normalized = String(path || '').replace(/\/$/, '') || '/';
  return ROUTES.find(route => new RegExp('^' + route.replace(':id', '[^/]+') + '$').test(normalized)) || 'unmatched';
}

function configuration(env = process.env) {
  const intervalMs = Number(env.API_METRICS_INTERVAL_MS ?? 60000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2147483647) throw new Error('API_METRICS_INTERVAL_MS must be a nonnegative integer up to 2147483647.');
  for (const key of ['API_REQUEST_LOGS', 'API_V1_ENABLED']) {
    if (env[key] !== undefined && !['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false.`);
  }
  return { intervalMs, requestLogs: env.API_REQUEST_LOGS !== 'false', enabled: env.API_V1_ENABLED !== 'false' };
}

function createMonitor({ intervalMs = 0, requestLogs = true, log = record => console.log(JSON.stringify(record)) } = {}) {
  const series = new Map();
  const startedAt = new Date().toISOString();
  const safeLog = record => { try { log(record); } catch { /* Telemetry must not break HTTP or posting. */ } };
  const snapshot = () => ({ event: 'api_metrics', timestamp: new Date().toISOString(),
    process_id: process.pid, started_at: startedAt, cumulative: true,
    latency_bounds_ms: [...BOUNDS, '+Inf'], series: [...series.values()].map(row => ({ ...row, latency_buckets: [...row.latency_buckets] })) });
  const timer = intervalMs ? setInterval(() => safeLog(snapshot()), intervalMs) : null;
  timer?.unref();

  function observe(req, res) {
    const start = process.hrtime.bigint();
    const route = routeTemplate(req.path); // Never retain URL, IDs or query values.
    const method = ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? req.method : 'OTHER';
    let done = false;
    const complete = aborted => {
      if (done) return;
      done = true;
      const duration = Number(process.hrtime.bigint() - start) / 1e6;
      const status = aborted ? 0 : res.statusCode;
      const statusClass = aborted ? 'aborted' : `${Math.floor(status / 100)}xx`;
      const outcome = OUTCOMES.has(req.apiMutationOutcome) ? req.apiMutationOutcome : status >= 400 || aborted ? 'failed' : 'none';
      const key = JSON.stringify([route, method, statusClass, outcome]);
      const row = series.get(key) || { route, method, status_class: statusClass, mutation_outcome: outcome,
        requests: 0, duration_ms_sum: 0, latency_buckets: BOUNDS.map(() => 0).concat(0) };
      row.requests++; row.duration_ms_sum += duration;
      BOUNDS.forEach((bound, index) => { if (duration <= bound) row.latency_buckets[index]++; });
      row.latency_buckets[BOUNDS.length]++;
      series.set(key, row);
      if (requestLogs) {
        const actor = req.apiActor;
        safeLog({ event: 'api_request', timestamp: new Date().toISOString(), process_id: process.pid,
          request_id: req.requestId, route, method, status, aborted, duration_ms: Math.round(duration * 1000) / 1000,
          actor_id: actor?.user?.id == null ? null : String(actor.user.id),
          credential_id: actor?.credentialId || null, session_id: actor?.sessionId || null,
          error_code: req.apiErrorCode || null, mutation_outcome: outcome });
      }
    };
    res.once('finish', () => complete(false));
    res.once('close', () => complete(!res.writableFinished));
  }
  return { observe, snapshot, close: () => { if (timer) clearInterval(timer); } };
}

const config = configuration();
const monitor = createMonitor(config);
module.exports = { routeTemplate, configuration, createMonitor, monitor };
