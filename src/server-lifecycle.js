'use strict';

function shutdownTimeoutMs(env = process.env) {
  const raw = String(env.SHUTDOWN_TIMEOUT_MS ?? '25000').trim();
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 300000) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 300000.');
  }
  return Number(raw);
}

function createGracefulShutdown({
  server,
  closeStore,
  timeoutMs = shutdownTimeoutMs(),
  logger = console,
  exit = (code) => process.exit(code),
  onShutdownStart = () => {},
}) {
  let pending;
  return function shutdown(signal = 'manual') {
    if (pending) return pending;
    const startedAt = Date.now();
    let timer;
    onShutdownStart(signal);
    logger.info(JSON.stringify({
      event: 'graceful_shutdown',
      state: 'started',
      signal,
      timeout_ms: timeoutMs,
    }));

    pending = new Promise((resolve) => {
      let complete = false;
      const exitOnce = (reason, exitCode) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        logger.info(JSON.stringify({
          event: 'graceful_shutdown',
          state: 'complete',
          reason,
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
        }));
        resolve(exitCode);
        exit(exitCode);
      };
      const finish = async (reason, exitCode = 0) => {
        if (complete) return;
        let finalCode = exitCode;
        try {
          await closeStore();
        } catch (error) {
          finalCode = 1;
          logger.error(JSON.stringify({
            event: 'graceful_shutdown',
            state: 'store_close_failed',
            error_code: error.code || 'unknown',
          }));
        }
        exitOnce(reason, finalCode);
      };

      timer = setTimeout(() => {
        logger.error(JSON.stringify({
          event: 'graceful_shutdown',
          state: 'timeout',
          timeout_ms: timeoutMs,
        }));
        try { server.closeAllConnections?.(); } catch { /* close below is authoritative */ }
        exitOnce('timeout', 1);
      }, timeoutMs);

      try {
        server.close((error) => finish(
          error ? 'server_close_failed' : 'complete',
          error ? 1 : 0,
        ));
        server.closeIdleConnections?.();
      } catch (error) {
        logger.error(JSON.stringify({
          event: 'graceful_shutdown',
          state: 'server_close_failed',
          error_code: error.code || 'unknown',
        }));
        finish('server_close_failed', 1);
      }
    });
    return pending;
  };
}

module.exports = { createGracefulShutdown, shutdownTimeoutMs };
