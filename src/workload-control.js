'use strict';
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const timings = new AsyncLocalStorage();
const {markReadQueued,markReadStarted}=require('./read-cache');
const REPORT_LANES = new Set(['ledger', 'inventory']);
const REPORT_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

function integer(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}
function createReportGate({ limit = 3, maxQueue = 100, timeoutMs = 30000, label = 'Reports', code = 'REPORT_BUSY' } = {}) {
  let active = 0, rejected = 0, peakQueue = 0, peakActive = 0, completed = 0;
  let admitted = 0, waitTotal = 0, waitMax = 0;
  const queue = [];
  const busy = () => { rejected++; return Object.assign(Error(`${label} are busy. Please try again shortly.`), { status: 503, code }); };
  function release() {
    const next = queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active--;
  }
  const run = async function(load, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || Error('Report cancelled.');
    let queuedAt = null;
    if (active < limit) active++;
    else {
      queuedAt = performance.now();
      if (queue.length >= maxQueue) throw busy();
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        const remove = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); };
        const abort = () => { remove(); clearTimeout(entry.timer); reject(signal.reason || Error('Report cancelled.')); };
        entry.resolve = () => { signal?.removeEventListener('abort', abort); resolve(); };
        entry.timer = setTimeout(() => { remove(); signal?.removeEventListener('abort', abort); reject(busy()); }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        queue.push(entry); peakQueue = Math.max(peakQueue, queue.length);
      });
    }
    const waited = queuedAt == null ? 0 : performance.now() - queuedAt;
    admitted++; waitTotal += waited; waitMax = Math.max(waitMax, waited);
    peakActive = Math.max(peakActive, active);
    try {
      if (signal?.aborted) throw signal.reason || Error('Report cancelled.');
      return await load({ waitedMs: waited });
    } finally { completed++; release(); }
  };
  run.metrics = () => ({ active, queued: queue.length, limit, max_queue: maxQueue, peak_active: peakActive, peak_queue: peakQueue, completed, rejected, admitted, wait_total_ms: waitTotal, wait_mean_ms: admitted ? waitTotal / admitted : 0, wait_max_ms: waitMax });
  return run;
}
// Reports and lists have separate admission queues. Waiting reports never hold
// a list slot or a database lease. All classified reads share a hard DB budget.
const expensiveReads = new AsyncLocalStorage();
const reportGates = new Map();
const reportTimings = new Map();
let browsingGate, readConnections, reportConnections;
const checkouts = new Map();
function readBudget() {
  const poolMax = integer('POSTGRES_POOL_MAX', 10, 1);
  const reserve = Math.min(integer('POSTGRES_POSTING_RESERVE', 3, 1), Math.max(0, poolMax - 1));
  return Math.min(integer('EXPENSIVE_READ_CONNECTIONS', 4, 1), poolMax - reserve);
}
function connectionWorkload() { return expensiveReads.getStore()?.kind || 'unclassified'; }
function recordConnectionCheckout(kind, ms, failed) {
  const value=checkouts.get(kind)||{count:0,failed:0,total_ms:0,max_ms:0};
  value.count++;value.failed+=Number(failed);value.total_ms+=ms;value.max_ms=Math.max(value.max_ms,ms);checkouts.set(kind,value);
}
function runInteractiveRead(load) {
  return expensiveReads.getStore() ? load() : expensiveReads.run({kind:'interactive'},load);
}
function runSessionRead(load) {
  // Session activity is a small database write that every request needs.
  // Keep it inside the main pool but out of the expensive-page read queue so
  // report and list scans cannot block authentication.
  return expensiveReads.run({kind:'session',admitted:true},load);
}
function requestReadBudget(req, _res, next) {
  const stockPreviewBatch = req.method === 'POST' && /^\/api\/invoice-stock-balances\/?$/.test(req.path);
  return ['GET','HEAD'].includes(req.method) || stockPreviewBatch ? runInteractiveRead(next) : next();
}
function reportLaneGate(lane) {
  if (!reportGates.has(lane)) {
    const prefix = lane.toUpperCase().replace(/-/g, '_');
    reportGates.set(lane, createReportGate({
      limit: integer(`HEAVY_REPORT_${prefix}_CONCURRENCY`, integer('HEAVY_REPORT_CONCURRENCY', 1, 1), 1),
      maxQueue: integer('HEAVY_REPORT_QUEUE_MAX', 100, 0),
      timeoutMs: integer('HEAVY_REPORT_QUEUE_TIMEOUT_MS', 30000, 1),
      label: lane === 'inventory' ? 'Inventory reports' : 'Ledger reports',
    }));
  }
  return reportGates.get(lane);
}
function recordReportTiming(lane, label, queueWaitMs, executionMs, ok) {
  const key = `${lane}:${label}`;
  if (!reportTimings.has(key) && reportTimings.size >= 50) return;
  const value = reportTimings.get(key) || {
    lane, label, count: 0, failed: 0, queue_wait_total_ms: 0, queue_wait_max_ms: 0,
    execution_total_ms: 0, execution_max_ms: 0,
  };
  value.count++;
  value.failed += ok ? 0 : 1;
  value.queue_wait_total_ms += queueWaitMs;
  value.queue_wait_max_ms = Math.max(value.queue_wait_max_ms, queueWaitMs);
  value.execution_total_ms += executionMs;
  value.execution_max_ms = Math.max(value.execution_max_ms, executionMs);
  reportTimings.set(key, value);
}
function runHeavyReport(load, options = {}) {
  if (expensiveReads.getStore()?.kind === 'report') return load();
  const lane = REPORT_LANES.has(options.lane) ? options.lane : 'ledger';
  const label = REPORT_LABEL.test(options.label || '') ? options.label : 'report';
  const gate = reportLaneGate(lane);
  const started = performance.now();
  let queueWaitMs = 0;
  let executionMs = 0;
  let ok = false;
  markReadQueued();
  return gate(async ({ waitedMs }) => {
    queueWaitMs = waitedMs;
    const executionStarted = performance.now();
    try {
      markReadStarted();
      const result = await expensiveReads.run({ kind: 'report', admitted: true }, load);
      ok = true;
      return result;
    } finally {
      executionMs = performance.now() - executionStarted;
    }
  }, options).catch(error => {
    if (!queueWaitMs) queueWaitMs = performance.now() - started;
    throw error;
  }).finally(() => {
    const totalMs = performance.now() - started;
    recordReportTiming(lane, label, queueWaitMs, executionMs, ok);
    if (process.env.REPORT_TIMINGS === '1') {
      console.info(JSON.stringify({
        event: 'report_timing', timestamp: new Date().toISOString(), lane, report: label,
        success: ok, queue_wait_ms: Math.round(queueWaitMs),
        execution_ms: Math.round(executionMs), total_ms: Math.round(totalMs),
      }));
    }
  });
}
function runExpensiveRead(load, options) {
  if (expensiveReads.getStore()?.admitted) return load();
  if (!browsingGate) browsingGate = createReportGate({
    limit: integer('EXPENSIVE_READ_CONCURRENCY', 2, 1),
    maxQueue: integer('EXPENSIVE_READ_QUEUE_MAX', 100, 0),
    timeoutMs: integer('EXPENSIVE_READ_QUEUE_TIMEOUT_MS', 15000, 1),
    label: 'Lists and searches', code: 'READ_BUSY',
  });
  markReadQueued();
  return browsingGate(() => {markReadStarted();return expensiveReads.run({kind:'browse',admitted:true},load);},options);
}
function lease(gate) {
  return new Promise((resolve,reject) => {
    gate(() => new Promise(release => resolve(release))).catch(reject);
  });
}
async function acquireReadLease() {
  if (!expensiveReads.getStore() || connectionWorkload() === 'session') return () => {};
  // Reports may occupy only part of the common read budget. Keep one slot for
  // interactive readers when the configured pool/budget permits it.
  let freeReport;
  if (connectionWorkload()==='report') {
    if (!reportConnections) reportConnections=createReportGate({
      limit:Math.min(integer('HEAVY_REPORT_CONNECTIONS',2,1),Math.max(1,readBudget()-1)),maxQueue:100,
      timeoutMs:integer('HEAVY_REPORT_QUEUE_TIMEOUT_MS',30000,1),label:'Report connections'});
    freeReport=await lease(reportConnections);
  }
  if (!readConnections) readConnections = createReportGate({limit: readBudget(), maxQueue: 1000,
    timeoutMs: integer('EXPENSIVE_READ_QUEUE_TIMEOUT_MS', 15000, 1), label: 'Read connections', code: 'READ_BUSY'});
  try {
    const freeRead=await lease(readConnections);
    let freed=false;
    return ()=>{if(freed)return;freed=true;freeRead();freeReport?.();};
  } catch(error) {freeReport?.();throw error;}
}
function combinedReportMetrics() {
  const reportLanes = Object.fromEntries([...reportGates].map(([name, gate]) => [name, gate.metrics()]));
  const gates = Object.values(reportLanes);
  if (!gates.length) return { reports: null, report_lanes: reportLanes };
  const reports = gates.reduce((total, gate) => {
    for (const key of ['active', 'queued', 'limit', 'max_queue', 'peak_active', 'peak_queue',
      'completed', 'rejected', 'admitted', 'wait_total_ms', 'wait_max_ms']) {
      total[key] = Number(total[key] || 0) + Number(gate[key] || 0);
    }
    return total;
  }, {});
  reports.wait_mean_ms = reports.admitted ? reports.wait_total_ms / reports.admitted : 0;
  reports.lane_count = gates.length;
  return { reports, report_lanes: reportLanes };
}
function workloadMetrics() {
  const reportMetrics = combinedReportMetrics();
  return { browsing: browsingGate?.metrics() || null, reads: readConnections?.metrics() || null,
    reports: reportMetrics.reports, report_lanes: reportMetrics.report_lanes,
    report_timings: Object.fromEntries([...reportTimings].map(([key, value]) => [key, {
      ...value,
      queue_wait_mean_ms: value.count ? value.queue_wait_total_ms / value.count : 0,
      execution_mean_ms: value.count ? value.execution_total_ms / value.count : 0,
    }])),
    report_connections:reportConnections?.metrics()||null,
    connection_checkouts:Object.fromEntries([...checkouts].map(([kind,v])=>[kind,{...v,mean_ms:v.total_ms/v.count}])),
    read_connection_limit: readBudget() };
}
async function postingStage(name, load) {
  const context = timings.getStore();
  if (!context) return load();
  const started = performance.now();
  try { return await load(); }
  finally { context.stages[name] = (context.stages[name] || 0) + performance.now() - started; }
}
async function measurePosting(operation, load) {
  if (process.env.POSTING_TIMINGS !== '1') return load();
  const context = { operation, stages: {} }, started = performance.now();
  let success = false;
  try { const result = await timings.run(context, load); success = true; return result; }
  finally {
    console.info(JSON.stringify({ event: 'posting_timing', timestamp: new Date().toISOString(), operation, success,
      total_ms: Math.round(performance.now() - started),
      stages_ms: Object.fromEntries(Object.entries(context.stages).map(([key, value]) => [key, Math.round(value)])) }));
  }
}
module.exports = { runInteractiveRead, runSessionRead, requestReadBudget, connectionWorkload, recordConnectionCheckout, runExpensiveRead, acquireReadLease, workloadMetrics, createReportGate, runHeavyReport, postingStage, measurePosting };
