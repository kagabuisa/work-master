'use strict';
// Concurrency-only diagnostic driver.
//
// Runs the HTTP workload ladder against an already-seeded fixture. It deliberately
// skips the seed and integrity phases of job.js: those validate a dataset, which is
// not what a cross-host concurrency comparison needs. The database is still checked
// by bootstrap() (fixture marker, fingerprint, run id) so this cannot run against an
// arbitrary application database.
//
// Results are written to workload.json and summary.md, marked as a diagnostic run so
// they are never mistaken for a certified full-run result.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { profile, guard, fingerprint } = require('./profile');
const state = require('./state');
const { bootstrap, masters } = require('./seed');
const { run } = require('./workload');

const abort = new AbortController();
let child, ctx, phase = 'starting';

function raw(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } }

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function server() {
  const logfile = fs.openSync(state.OUT + '/app.log', 'a', 0o600);
  // The app's read budget is derived from these, so they must match the intended capacity.
  child = spawn(process.execPath, ['--max-old-space-size=256', 'server.js'], {
    stdio: ['ignore', logfile, logfile],
    env: { ...process.env, POSTGRES_POOL_MAX: process.env.APP_POOL_MAX || '10' },
  });
  fs.closeSync(logfile);
  child.once('exit', (code) => {
    if (!['complete', 'failed', 'stopping'].includes(phase)) abort.abort(new Error('Benchmark app exited unexpectedly (code ' + code + ').'));
  });
  for (let n = 0; n < 60; n++) {
    abort.signal.throwIfAborted();
    try {
      const r = await fetch('http://127.0.0.1:3020/login', { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      if (r.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Isolated benchmark app did not become ready.');
}

(async () => {
  guard();
  const p = profile(process.env.BENCHMARK_MODE || 'full', process.env.BENCHMARK_LANE || 'stress');
  state.diskGuard(p.mode);
  const scope = 'Concurrency-only diagnostic: seed and integrity phases skipped against a pre-built fixture.';
  state.progress('starting', { mode: p.mode, fingerprint: fingerprint(p) });
  state.event({ event: 'job_start', mode: p.mode, scope });
  ctx = await bootstrap(p);
  // seed() normally builds the account/settings/money context and then creates documents.
  // masters() is the idempotent first half of that, so a pre-built fixture only needs it.
  Object.assign(ctx, await masters(p, ctx.pool));
  ctx.signal = abort.signal;
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const database = (await ctx.pool.query(`SELECT pg_database_size(current_database())::text bytes,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='active') active`)).rows[0];
      const sample = { at: new Date().toISOString(), phase, disk_available_bytes: state.diskGuard(p.mode), database,
        job_memory_current: raw('/sys/fs/cgroup/memory.current'), job_cpu_stat: raw('/sys/fs/cgroup/cpu.stat') };
      fs.appendFileSync(state.OUT + '/resources.jsonl', JSON.stringify(sample) + '\n', { mode: 0o600 });
    } catch {} finally { sampling = false; }
  }, 15000);
  timer.unref();
  try {
    phase = 'http-starting';
    state.progress(phase);
    await server();
    phase = 'concurrency';
    const workload = await run(p, ctx, abort.signal);
    state.write('workload.json', { ...workload, scope });
    const lines = [
      '# Concurrency-only diagnostic', '',
      `Mode: ${p.mode}   Lane: ${p.lane}`,
      `Users: ${process.env.BENCHMARK_USERS || '1,10,25,50'}`,
      `Sustained seconds: ${process.env.BENCHMARK_SUSTAINED_SECONDS || 'default'}`,
      `Pool: ${process.env.APP_POOL_MAX || '10'}   Read budget: ${process.env.EXPENSIVE_READ_CONNECTIONS || '4'}`,
      '',
    ];
    lines.push('| Users | Phase | Transactions | Failed | Attempted/s | Succeeded/s |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const r of workload.phases) {
      const ok = Math.max(0, r.transactions - r.failed_transactions);
      const succeeded = r.elapsed_seconds ? Math.round((ok / r.elapsed_seconds) * 100) / 100 : 0;
      lines.push(`| ${r.users} | ${r.name} | ${r.transactions} | ${r.failed_transactions} | ${r.transactions_per_second} | ${succeeded} |`);
    }
    const caps = require('./caps');
    lines.push('', '`Attempted/s` counts every request; `Succeeded/s` excludes failures.', '');
    lines.push(...caps.lines());
    const caveats = caps.caveats();
    if (caveats.length) lines.push('', ...caveats);
    lines.push('', 'Seed and integrity verification were skipped by design; this measures HTTP concurrency only.',
      'Not comparable to a certified full run, which also verifies data integrity before and after.');
    // state.write() JSON-encodes its value, which mangles a markdown file; write it raw.
    fs.writeFileSync(state.OUT + '/summary.md', lines.join('\n') + '\n', { mode: 0o600 });
    phase = 'complete';
    state.progress('complete', { passed: workload.passed });
    state.event({ event: 'job_complete', passed: workload.passed });
    process.exitCode = workload.passed ? 0 : 2;
  } catch (error) {
    phase = 'failed';
    state.progress('failed', { error: error.message, code: error.code || null });
    state.event({ event: 'job_failed', error: error.message, code: error.code || null,
      details: error.details || null });
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    phase = ['complete', 'failed'].includes(phase) ? phase : 'stopping';
    await stopServer();
  }
})();
