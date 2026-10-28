'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function startup(env) {
  const calls = { probes: [], services: [] };
  const module = { exports: {} };
  const requireStub = name => {
    if (name === '../src/environment') return { loadEnvironment() {} };
    if (name === 'node:child_process') return { spawnSync(...args) { calls.services.push(args); return { status: 0 }; } };
    if (name === 'node:net') return { createConnection(options) {
      calls.probes.push(options);
      const socket = { setTimeout() {}, destroy() {}, once(event, callback) {
        if (event === 'connect') queueMicrotask(callback);
        return socket;
      } };
      return socket;
    } };
    throw new Error(`Unexpected module: ${name}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/start.js'), 'utf8'),
    { module, require: requireStub, process: { env }, console, URL });
  return { ...module.exports, calls };
}

test('startup probes the selected runtime endpoint, ignoring a conflicting owner URL', async () => {
  for (const [env, expected] of [
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@runtime-db:5544/app', POSTGRES_URL: 'postgresql://owner:example@localhost:5432/app' }, null],
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@127.0.0.1:5544/app', POSTGRES_URL: 'postgresql://owner:example@owner-db:5432/app' }, { host: '127.0.0.1', port: 5544 }],
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@[::1]:5545/app', DATABASE_URL: 'postgresql://owner:example@owner-db/app' }, { host: '::1', port: 5545 }],
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@runtime-db/app', PGHOST: 'localhost', PGPORT: '9999' }, null],
    [{ POSTGRES_URL: 'postgresql://owner:example@localhost:5546/app', DATABASE_URL: 'postgresql://other:example@other-db/app' }, { host: 'localhost', port: 5546 }],
    [{ DATABASE_URL: 'postgresql://owner:example@localhost/app' }, { host: 'localhost', port: 5432 }],
    [{ PGHOST: '127.0.0.1', PGPORT: '5547', POSTGRES_HOST: 'owner-db', POSTGRES_PORT: '9999' }, { host: '127.0.0.1', port: 5547 }],
    [{ POSTGRES_HOST: 'remote-db', POSTGRES_PORT: '5432' }, null],
  ]) {
    const instance = startup(env);
    const endpoint = instance.localPostgresEndpoint(env);
    assert.deepEqual(endpoint && { ...endpoint }, expected);
    await instance.startLocalPostgresIfNeeded();
    assert.deepEqual(instance.calls.probes.map(value => ({ ...value })), expected ? [expected] : []);
    assert.deepEqual(instance.calls.services, [], 'reachable local and remote runtimes never start an unrelated local service');
  }
});

test('environment isolation follows the runtime database rather than the owner database', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/environment.js'), 'utf8');
  for (const [env, expectedLoads] of [
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@runtime-db/work_master_hr_test', POSTGRES_URL: 'postgresql://owner:example@owner-db/application' }, 0],
    [{ POSTGRES_RUNTIME_URL: 'postgresql://runtime:example@runtime-db/application', POSTGRES_URL: 'postgresql://owner:example@owner-db/work_master_hr_test' }, 1],
    [{ POSTGRES_DB: 'work_master_hr_test' }, 0],
  ]) {
    let loads = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, process: { env }, URL,
      require: name => { assert.equal(name, 'dotenv'); return { config() { loads++; } }; } });
    module.exports.loadEnvironment();
    assert.equal(loads, expectedLoads);
  }
});
