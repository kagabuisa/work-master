'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGracefulShutdown, shutdownTimeoutMs } = require('../src/server-lifecycle');

function logger() {
  return { info() {}, error() {} };
}

test('shutdown stops admission, waits for requests, closes the store and exits once', async () => {
  const calls = [];
  let closeRequests;
  const server = {
    close(callback) { calls.push('server.close'); closeRequests = callback; },
    closeIdleConnections() { calls.push('server.idle'); },
    closeAllConnections() { calls.push('server.all'); },
  };
  const shutdown = createGracefulShutdown({
    server,
    closeStore: async () => { calls.push('store.close'); },
    logger: logger(),
    exit: (code) => calls.push(`exit:${code}`),
    onShutdownStart: () => calls.push('start'),
  });

  const first = shutdown('SIGTERM');
  const second = shutdown('SIGTERM');
  assert.equal(first, second);
  assert.deepEqual(calls, ['start', 'server.close', 'server.idle']);
  closeRequests(null);
  assert.equal(await first, 0);
  assert.deepEqual(calls, ['start', 'server.close', 'server.idle', 'store.close', 'exit:0']);
});

test('shutdown forces open connections closed after the deadline', async () => {
  const calls = [];
  const server = {
    close() { calls.push('server.close'); },
    closeAllConnections() { calls.push('server.all'); },
  };
  const shutdown = createGracefulShutdown({
    server,
    closeStore: async () => { calls.push('store.close'); },
    timeoutMs: 5,
    logger: logger(),
    exit: (code) => calls.push(`exit:${code}`),
  });
  assert.equal(await shutdown('SIGTERM'), 1);
  assert.deepEqual(calls, ['server.close', 'server.all', 'exit:1']);
});

test('shutdown timeout configuration is bounded', () => {
  assert.equal(shutdownTimeoutMs({}), 25000);
  assert.equal(shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '40000' }), 40000);
  for (const value of ['0', '-1', 'abc', '300001']) {
    assert.throws(() => shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: value }), /SHUTDOWN_TIMEOUT_MS/);
  }
});
