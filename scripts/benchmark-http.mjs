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
  const timeoutMs = positiveInteger(args.timeout_ms, 10000, 360000);
  const warmup = args.warmup === undefined || args.warmup === '0' ? 0 : positiveInteger(args.warmup, 1, 1000);
  const cookies = process.env.PERF_COOKIES ? JSON.parse(process.env.PERF_COOKIES) : [process.env.PERF_COOKIE || ''];
  if (!Array.isArray(cookies) || !cookies.length || cookies.some(cookie => typeof cookie !== 'string')) {
    throw new Error('PERF_COOKIES must be a nonempty JSON array of session-cookie strings.');
  }
  const timings = [];
  let responseBytes = 0;
  async function request(cookie) {
    const response = await fetch(target, {
      method: 'GET', redirect: 'manual',
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    let bytes = 0;
    // Drain streamed exports without retaining entire files in the load generator.
    if (response.body) for await (const chunk of response.body) bytes += chunk.byteLength;
    return { status: response.status, bytes };
  }
  for (let i = 0; i < warmup; i++) {
    const response = await request(cookies[i % cookies.length]);
    if (response.status < 200 || response.status >= 300) throw new Error(`Warmup failed with HTTP ${response.status}.`);
  }
  const statuses = new Map();
  const errors = new Map();
  let failed = 0;
  let next = 0;
  const started = performance.now();

  async function worker(workerId) {
    while (next < requests) {
      next += 1;
      const start = performance.now();
      try {
        const response = await request(cookies[workerId % cookies.length]);
        responseBytes += response.bytes;
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (response.status < 200 || response.status >= 300) failed += 1;
      } catch (error) {
        const name = error.name || 'Error';
        errors.set(name, (errors.get(name) || 0) + 1);
        failed += 1;
      }
      timings.push(performance.now() - start);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, (_, workerId) => worker(workerId)));
  const elapsedMs = performance.now() - started;
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({
    path: target.pathname,
    requests, concurrency, warmup, sessions: cookies.length, response_bytes: responseBytes,
    statuses: Object.fromEntries(statuses),
    errors: Object.fromEntries(errors),
    failed,
    elapsed_ms: Math.round(elapsedMs),
    p50_ms: Math.round(percentile(timings, 0.5)),
    p95_ms: Math.round(percentile(timings, 0.95)),
    p99_ms: Math.round(percentile(timings, 0.99)),
    requests_per_second: Math.round(requests * 100000 / elapsedMs) / 100,
  }, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
