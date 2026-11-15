'use strict';
// Effective resource limits for a benchmark run.
//
// A throughput figure is meaningless without the limits it was produced under: the first full
// run reported "3 TPS" while PostgreSQL was capped at 1.0 CPU on a 2-core host shared with four
// other services. On properly sized hardware the same code did 43 TPS. Every result now carries
// the limits it was measured under, and says so when the database is capped below the host.
const fs = require('node:fs');

function read(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } }

function hostCores() {
  const cpuinfo = read('/proc/cpuinfo');
  if (!cpuinfo) return null;
  const count = (cpuinfo.match(/^processor\s*:/gm) || []).length;
  return count || null;
}

// cgroup v2: "max 100000" means unlimited, "800000 100000" means 8 CPUs.
function cgroupCores() {
  const value = read('/sys/fs/cgroup/cpu.max');
  if (!value) return null;
  const [quota, period] = value.split(' ');
  if (quota === 'max' || !period) return null;
  const cores = Number(quota) / Number(period);
  return Number.isFinite(cores) ? Math.round(cores * 100) / 100 : null;
}

function cgroupMemoryGb() {
  const value = read('/sys/fs/cgroup/memory.max');
  if (!value || value === 'max') return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) ? Math.round((bytes / 1024 ** 3) * 100) / 100 : null;
}

function effective() {
  return {
    host_cores: hostCores(),
    db_cpus: process.env.BENCHMARK_DB_CPUS || null,
    db_memory: process.env.BENCHMARK_DB_MEMORY || null,
    db_shared_buffers: process.env.BENCHMARK_DB_SHARED_BUFFERS || null,
    app_cpus: cgroupCores(),
    app_memory_gb: cgroupMemoryGb(),
    postgres_pool_max: process.env.POSTGRES_POOL_MAX || null,
    read_connections: process.env.EXPENSIVE_READ_CONNECTIONS || null,
    posting_reserve: process.env.POSTGRES_POSTING_RESERVE || null,
    heavy_report_concurrency: process.env.HEAVY_REPORT_CONCURRENCY || null,
  };
}

function lines() {
  const c = effective();
  const rows = [
    ['Host cores (container view)', c.host_cores],
    ['PostgreSQL CPUs', c.db_cpus],
    ['PostgreSQL memory', c.db_memory],
    ['PostgreSQL shared_buffers', c.db_shared_buffers],
    ['Application CPUs', c.app_cpus],
    ['Application memory (GB)', c.app_memory_gb],
    ['POSTGRES_POOL_MAX', c.postgres_pool_max],
    ['EXPENSIVE_READ_CONNECTIONS', c.read_connections],
    ['POSTGRES_POSTING_RESERVE', c.posting_reserve],
    ['HEAVY_REPORT_CONCURRENCY', c.heavy_report_concurrency],
  ].filter(([, value]) => value !== null && value !== undefined);

  const out = ['## Measured under', '', '| Limit | Value |', '| --- | --- |'];
  for (const [label, value] of rows) out.push(`| ${label} | ${value} |`);
  out.push('', 'Throughput figures depend on these limits; compare only against runs with the same set.');
  return out;
}

function caveats() {
  const c = effective();
  const out = [];
  const dbCpus = Number(c.db_cpus);
  const hostCpus = Number(c.host_cores);
  if (Number.isFinite(dbCpus) && Number.isFinite(hostCpus) && dbCpus < hostCpus) {
    out.push(`> **Capacity caveat:** PostgreSQL was limited to ${dbCpus} CPU on a ${hostCpus}-core host.`
      + ' This result is not the host\'s capacity and must not be quoted as an application ceiling.');
  }
  if (!c.db_cpus) {
    out.push('> **Capacity caveat:** the PostgreSQL CPU limit was not recorded for this run, so it cannot be compared with runs that state one.');
  }
  return out;
}

module.exports = { effective, lines, caveats };
