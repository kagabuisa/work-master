import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));

const results = [];
let period;

try {
  const base = new URL(args.url || process.env.PERF_URL || '');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS staging URL.');
  if (!process.env.PERF_COOKIE && !process.env.PERF_COOKIES) throw new Error('Set PERF_COOKIE or PERF_COOKIES to authenticated staging sessions.');
  const searches = JSON.parse(process.env.PERF_SEARCH_TERMS || '["paid","partial"]');
  if (!Array.isArray(searches) || searches.length < 1 || searches.length > 20
      || searches.some(term => typeof term !== 'string' || !term.trim())) {
    throw new Error('PERF_SEARCH_TERMS must be a JSON array of 1–20 nonempty search strings.');
  }
  if (!args.from || !args.to) throw new Error('Specify --from=YYYY-MM-DD and --to=YYYY-MM-DD for the historical period.');
  const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!dateValid(args.from) || !dateValid(args.to) || args.from > args.to) throw new Error('Use a valid ordered date range.');
  period = { from: args.from, to: args.to };
  const scenarios = [
    ['invoice-list', '/invoices', {}],
    ...searches.map((q, i) => [`invoice-search-${i + 1}`, '/invoices', { q }]),
    ...['csv', 'xlsx', 'pdf'].map(format => [`ledger-${format}`, '/reports/general-ledger', { format }]),
  ];
  for (const [name, path, filters] of scenarios) {
    const target = new URL(path, base);
    target.search = new URLSearchParams({ from: args.from, to: args.to, ...filters }).toString();
    console.error(`Benchmarking ${name}…`);
    const child = spawnSync(process.execPath, [new URL('./benchmark-http.mjs', import.meta.url).pathname,
      `--url=${target}`, `--requests=${args.requests ?? 100}`, `--concurrency=${args.concurrency ?? 10}`,
      `--timeout_ms=${args.timeout_ms ?? 60000}`, `--warmup=${args.warmup ?? 5}`],
    { env: process.env, encoding: 'utf8' });
    if (child.error) throw child.error;
    if (child.stderr) process.stderr.write(child.stderr);
    if (!child.stdout.trim()) throw new Error(`Benchmark ${name} produced no result.`);
    results.push({ scenario: name, ...JSON.parse(child.stdout) });
    if (child.status !== 0) process.exitCode = 1;
  }
  console.log(JSON.stringify({ measured_at: new Date().toISOString(),
    period, results }, null, 2));
} catch (error) {
  console.error(error.message);
  console.log(JSON.stringify({ measured_at: new Date().toISOString(), period,
    incomplete: true, error: error.message, results }, null, 2));
  process.exitCode = 1;
}
