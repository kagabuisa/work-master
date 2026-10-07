const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-idle.js'), 'utf8');

function browser() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const listeners = new Map();
  const storage = new Map();
  const requests = [];
  const redirects = [];
  const addListener = (name, callback) => listeners.set(name, callback);
  const context = {
    Date: { now: () => now },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { addEventListener: addListener, hidden: false },
    window: { addEventListener: addListener, location: { replace: (url) => redirects.push(url) } },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url) => { requests.push(url); return { status: 204 }; },
  };
  vm.runInNewContext(script, context);
  return {
    requests, redirects,
    event: (name) => listeners.get(name)(),
    advance: async (milliseconds) => {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await Promise.resolve();
      }
      now = target;
      await new Promise(setImmediate);
    },
  };
}

test('idle browser logs out at five minutes', async () => {
  const page = browser();
  await page.advance(5 * 60 * 1000 - 1);
  assert.deepEqual(page.requests, []);
  await page.advance(1);
  assert.deepEqual(page.requests, ['/logout']);
  assert.deepEqual(page.redirects, ['/login?expired=1']);
});

test('user activity keeps the session alive and sends a heartbeat', async () => {
  const page = browser();
  await page.advance(60 * 1000);
  page.event('keydown');
  await Promise.resolve();
  assert.deepEqual(page.requests, ['/session/activity']);
  await page.advance(5 * 60 * 1000 - 1);
  assert.deepEqual(page.redirects, []);
  await page.advance(1);
  assert.deepEqual(page.requests, ['/session/activity', '/logout']);
});
