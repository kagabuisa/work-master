'use strict';
const { fork } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { exportFilename } = require('./general-ledger-export');

function setting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
function exportSettings() {
  const workers = setting('LEDGER_EXPORT_WORKERS', 2, 1, 32);
  return { workers, pdfWorkers: setting('LEDGER_EXPORT_PDF_WORKERS', 1, 1, workers),
    queue: setting('LEDGER_EXPORT_QUEUE_MAX', 20, 0, 1000),
    waitMs: setting('LEDGER_EXPORT_QUEUE_TIMEOUT_MS', 60000, 1, 3600000),
    jobMs: setting('LEDGER_EXPORT_JOB_TIMEOUT_MS', 300000, 1, 3600000),
    heapMb: setting('LEDGER_EXPORT_HEAP_MB', 256, 64, 4096) };
}
const busy = () => Object.assign(new Error('Ledger exports are busy. Please retry shortly.'), { status: 429 });

class ExportQueue {
  constructor(settings = exportSettings()) { this.settings = settings; this.active = 0; this.pdfActive = 0; this.waiting = []; }
  acquire(format, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry = { format, signal, resolve, reject };
      const cancel = error => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        entry.cleanup(); reject(error);
      };
      entry.abort = () => cancel(signal.reason);
      entry.cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.abort); };
      if (this.canRun(entry) && this.waiting.length === 0) return this.start(entry);
      if (this.waiting.length >= this.settings.queue) return reject(busy());
      entry.timer = setTimeout(() => cancel(busy()), this.settings.waitMs);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }
  canRun(entry) {
    return this.active < this.settings.workers
      && (entry.format !== 'pdf' || this.pdfActive < this.settings.pdfWorkers);
  }
  start(entry) {
    entry.cleanup(); this.active++;
    if (entry.format === 'pdf') this.pdfActive++;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true; this.active--;
      if (entry.format === 'pdf') this.pdfActive--;
      this.drain();
    });
  }
  drain() {
    let index;
    while ((index = this.waiting.findIndex(entry => this.canRun(entry))) >= 0) {
      this.start(this.waiting.splice(index, 1)[0]);
    }
  }
}
let queue;

function generateFile(filters, access, format, filename, signal, settings) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const worker = fork(path.join(__dirname, 'ledger-export-worker.js'), [], {
      execArgv: [`--max-old-space-size=${settings.heapMb}`],
      // Each worker uses one DB connection and no periodic metrics logger.
      env: { ...process.env, POSTGRES_POOL_MAX: '1', POSTGRES_POOL_METRICS_MS: '0' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let result;
    let stopped;
    const stop = error => { stopped ||= error; worker.kill('SIGKILL'); };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(Object.assign(new Error('Ledger export timed out. Try a narrower date range.'), { status: 503 })), settings.jobMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', error => { stopped ||= error; });
    worker.on('message', message => { result = message; });
    worker.once('close', (code, exitSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (stopped) return reject(stopped);
      if (result?.done && code === 0) return resolve();
      console.error(`ledger_export_failed format=${format} code=${code} signal=${exitSignal || ''}`);
      reject(Object.assign(new Error(result?.error || 'The export could not be generated. Try a narrower date range or retry.'), { status: 503 }));
    });
    worker.send({ filters, access, format, filename }, error => { if (error) stop(error); });
  });
}

async function sendGeneralLedgerDownload(req, res, filters, access, format) {
  queue ||= new ExportQueue();
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(new Error('Download cancelled.')); };
  req.on('aborted', abort); res.on('close', abort);
  if (req.aborted || res.destroyed) abort();
  let release;
  let directory;
  let deadline;
  try {
    release = await queue.acquire(format, controller.signal);
    deadline = setTimeout(() => controller.abort(Object.assign(new Error('Ledger export timed out. Try a narrower date range.'), { status: 503 })), queue.settings.jobMs);
    directory = await mkdtemp(path.join(tmpdir(), 'wm-ledger-export-'));
    const filename = path.join(directory, `ledger.${format}`);
    await generateFile(filters, access, format, filename, controller.signal, queue.settings);
    res.set('Cache-Control', 'private, no-store');
    res.attachment(exportFilename(filters, format));
    res.type({ csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }[format]);
    await pipeline(createReadStream(filename), res, { signal: controller.signal });
  } catch (error) {
    if (error.status === 429) res.set('Retry-After', '30');
    if (!controller.signal.aborted || (controller.signal.reason?.status && !res.headersSent && !res.destroyed)) throw error;
  } finally {
    clearTimeout(deadline);
    req.removeListener('aborted', abort); res.removeListener('close', abort);
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { release?.(); }
  }
}

module.exports = { sendGeneralLedgerDownload, ExportQueue, exportSettings };
