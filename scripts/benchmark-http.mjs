import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));

function positiveInteger(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}.`);
  }
  return number;
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

async function main() {
  const target = new URL(args.url || process.env.PERF_URL || '');
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
  const requests = positiveInteger(args.requests, 100, 10000);
  const concurrency = positiveInteger(args.concurrency, 10, 100);
  const timeoutMs = positiveInteger(args.timeout_ms, 10000, 60000);
  const cookie = process.env.PERF_COOKIE || '';
  const timings = [];
  const statuses = new Map();
  let failed = 0;
  let next = 0;
  const started = performance.now();

  async function worker() {
    while (next < requests) {
      next += 1;
      const start = performance.now();
      try {
        const response = await fetch(target, {
          method: 'GET', redirect: 'manual',
          headers: cookie ? { cookie } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (response.status < 200 || response.status >= 300) failed += 1;
      } catch {
        failed += 1;
      }
      timings.push(performance.now() - start);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
  const elapsedMs = performance.now() - started;
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({
    path: target.pathname,
    requests, concurrency,
    statuses: Object.fromEntries(statuses),
    failed,
    p50_ms: Math.round(percentile(timings, 0.5)),
    p95_ms: Math.round(percentile(timings, 0.95)),
    p99_ms: Math.round(percentile(timings, 0.99)),
    requests_per_second: Math.round(requests * 1000 / elapsedMs),
  }, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
