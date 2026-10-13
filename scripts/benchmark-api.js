'use strict';
const { performance } = require('node:perf_hooks');
const RESOURCES = ['customers', 'suppliers', 'items', 'warehouses', 'price-lists', 'cost-centers', 'invoices', 'stock-balances', 'me'];

function options(argv, env = process.env) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([a-z_]+)=(.*)$/.exec(arg);
    if (!match || Object.hasOwn(args, match[1]) || !['url', 'resource', 'warehouse', 'requests', 'concurrency', 'timeout_ms', 'interval_ms', 'allow_local_http'].includes(match[1])) throw new Error('Use documented, unique --name=value options.');
    args[match[1]] = match[2];
  }
  let base;
  try { base = new URL(args.url); } catch { throw new Error('Provide a valid API base URL.'); }
  if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== '/api/v1') throw new Error('Use an API base URL ending in /api/v1, without credentials, query or fragment.');
  if (args.allow_local_http !== undefined && !['true', 'false'].includes(args.allow_local_http)) throw new Error('allow_local_http must be true or false.');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && args.allow_local_http === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('HTTPS is required; explicit local HTTP is limited to loopback.');
  const resource = args.resource || 'invoices';
  if (!RESOURCES.includes(resource)) throw new Error('Use a documented read resource.');
  if (resource === 'stock-balances' && (!args.warehouse || args.warehouse.length > 200)) throw new Error('Stock reads require a warehouse of 1–200 characters.');
  if (resource !== 'stock-balances' && args.warehouse !== undefined) throw new Error('warehouse is supported only for stock-balances.');
  const integer = (key, fallback, minimum, maximum) => {
    const value = args[key] === undefined ? fallback : Number(args[key]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
    return value;
  };
  let tokens;
  try { tokens = env.API_BENCHMARK_TOKENS ? JSON.parse(env.API_BENCHMARK_TOKENS) : [env.API_BENCHMARK_TOKEN]; } catch { throw new Error('API_BENCHMARK_TOKENS must be a JSON array.'); }
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 100 || tokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))) throw new Error('Supply valid opaque bearer tokens through the benchmark environment.');
  const target = new URL(base.pathname.replace(/\/$/, '') + '/' + resource, base.origin);
  if (resource === 'stock-balances') target.searchParams.set('warehouse', args.warehouse);
  return { target, resource, tokens, requests: integer('requests', 30, 1, 10000), concurrency: integer('concurrency', 1, 1, 100),
    timeoutMs: integer('timeout_ms', 15000, 1, 360000), intervalMs: integer('interval_ms', 1000, 0, 60000) };
}

async function benchmark(config) {
  const durations = [], statuses = {}, errors = {};
  let next = 0, failed = 0, bytes = 0;
  const start = performance.now();
  const workers = Array.from({ length: Math.min(config.requests, config.concurrency) }, async (_, worker) => {
    while (next < config.requests) {
      next++;
      const began = performance.now();
      try {
        const response = await fetch(config.target, { method: 'GET', redirect: 'manual',
          headers: { Authorization: `Bearer ${config.tokens[worker % config.tokens.length]}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(config.timeoutMs) });
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        // Drain without printing or retaining scoped business records.
        if (response.body) for await (const chunk of response.body) bytes += chunk.byteLength;
        if (response.status < 200 || response.status >= 300 || !response.headers.get('content-type')?.includes('application/json')) failed++;
      } catch (error) {
        const category = error.name === 'TimeoutError' ? 'timeout' : 'transport';
        errors[category] = (errors[category] || 0) + 1; failed++;
      }
      durations.push(performance.now() - began);
      if (config.intervalMs && next < config.requests) await new Promise(resolve => setTimeout(resolve, config.intervalMs));
    }
  });
  await Promise.all(workers);
  durations.sort((a, b) => a - b);
  const elapsedMs = performance.now() - start;
  const percentile = fraction => Math.round(durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)]);
  return { event: 'api_benchmark', route: '/api/v1/' + config.resource, requests: config.requests, concurrency: config.concurrency,
    credentials: config.tokens.length, interval_ms: config.intervalMs, statuses, errors, failed, response_bytes: bytes,
    elapsed_ms: Math.round(elapsedMs), p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99),
    requests_per_second: Math.round(config.requests * 100000 / elapsedMs) / 100 };
}

if (require.main === module) {
  (async () => { const result = await benchmark(options(process.argv.slice(2))); console.log(JSON.stringify(result)); if (result.failed) process.exitCode = 1; })()
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { options, benchmark };
