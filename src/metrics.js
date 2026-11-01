'use strict';

const { monitor } = require('./api/monitoring');
const { postgresPoolMetrics } = require('./core');
const requestMetrics = require('./request-metrics');
const { workloadMetrics } = require('./workload-control');
const PROCESS_START_SECONDS = Date.now() / 1000 - process.uptime();

function label(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(values) {
  const entries = Object.entries(values);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${label(value)}"`).join(',')}}` : '';
}

function metric(lines, name, help, type, samples) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const sample of samples) {
    lines.push(`${name}${labels(sample.labels || {})} ${Number(sample.value) || 0}`);
  }
}

function renderMetrics({ ready }) {
  const lines = [];
  const memory = process.memoryUsage();
  metric(lines, 'work_master_up', 'Application process is reachable.', 'gauge',
    [{ value: 1 }]);
  metric(lines, 'work_master_ready', 'Application initialization and database readiness.', 'gauge',
    [{ value: ready ? 1 : 0 }]);
  metric(lines, 'work_master_process_start_time_seconds', 'Process start time as a Unix timestamp.', 'gauge',
    [{ value: PROCESS_START_SECONDS }]);
  metric(lines, 'work_master_process_uptime_seconds', 'Process uptime in seconds.', 'gauge',
    [{ value: process.uptime() }]);
  metric(lines, 'work_master_process_resident_memory_bytes', 'Resident process memory.', 'gauge',
    [{ value: memory.rss }]);
  metric(lines, 'work_master_node_heap_used_bytes', 'Node.js heap currently in use.', 'gauge',
    [{ value: memory.heapUsed }]);
  metric(lines, 'work_master_node_heap_total_bytes', 'Node.js heap allocated size.', 'gauge',
    [{ value: memory.heapTotal }]);

  const requests = requestMetrics.snapshot();
  metric(lines, 'work_master_http_requests_total', 'Bounded application requests by route group.', 'counter',
    requests.map(row => ({
      labels: { route_group: row.group, method: row.method, status_class: row.status_class },
      value: row.requests,
    })));
  metric(lines, 'work_master_http_request_duration_ms_sum', 'Total application request duration by route group.', 'counter',
    requests.map(row => ({
      labels: { route_group: row.group, method: row.method, status_class: row.status_class },
      value: row.duration_ms_sum,
    })));

  const pool = postgresPoolMetrics();
  metric(lines, 'work_master_postgres_pool_connections', 'PostgreSQL pool connection counts.', 'gauge',
    Object.entries(pool).map(([state, value]) => ({ labels: { state }, value })));

  const workload = workloadMetrics();
  const gates = { browsing: workload.browsing, reports: workload.reports,
    reads: workload.reads, report_connections: workload.report_connections };
  const admission = [];
  for (const [gate, values] of Object.entries(gates)) {
    if (!values) continue;
    for (const state of ['active', 'queued', 'rejected', 'completed', 'admitted']) {
      admission.push({ labels: { gate, state }, value: values[state] || 0 });
    }
  }
  metric(lines, 'work_master_workload_admission', 'Interactive read and report admission state.', 'gauge', admission);

  const api = monitor.snapshot();
  metric(lines, 'work_master_api_requests_total', 'Versioned API requests by bounded route label.', 'counter',
    api.series.map(row => ({
      labels: { route: row.route, method: row.method, status_class: row.status_class, outcome: row.mutation_outcome },
      value: row.requests,
    })));
  metric(lines, 'work_master_api_request_duration_ms_sum', 'Versioned API response duration sum.', 'counter',
    api.series.map(row => ({
      labels: { route: row.route, method: row.method, status_class: row.status_class, outcome: row.mutation_outcome },
      value: row.duration_ms_sum,
    })));
  const buckets = [];
  for (const row of api.series) {
    api.latency_bounds_ms.forEach((bound, index) => {
      buckets.push({
        labels: { route: row.route, method: row.method, status_class: row.status_class,
          outcome: row.mutation_outcome, le: bound },
        value: row.latency_buckets[index],
      });
    });
  }
  metric(lines, 'work_master_api_request_duration_ms_bucket', 'Cumulative versioned API latency buckets.', 'untyped',
    buckets);
  return `${lines.join('\n')}\n`;
}

module.exports = { label, renderMetrics };
