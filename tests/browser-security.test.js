'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, browserSecuritySettings } = require('../src/browser-security');

test('browser security defaults support shared office IPs and practical sessions', () => {
  assert.deepEqual(browserSecuritySettings({}), { ...DEFAULTS });
  assert.equal(DEFAULTS.loginIpLimit, 100);
  assert.equal(DEFAULTS.loginUsernameLimit, 5);
  assert.equal(DEFAULTS.sessionIdleMinutes, 30);
});

test('browser login and session settings are deployment-configurable', () => {
  assert.deepEqual(browserSecuritySettings({
    BROWSER_LOGIN_WINDOW_SECONDS: '600',
    BROWSER_LOGIN_IP_LIMIT: '250',
    BROWSER_LOGIN_USERNAME_LIMIT: '4',
    BROWSER_SESSION_IDLE_MINUTES: '45',
    BROWSER_SESSION_DAYS: '10',
  }), {
    loginWindowSeconds: 600,
    loginIpLimit: 250,
    loginUsernameLimit: 4,
    sessionIdleMinutes: 45,
    sessionDays: 10,
  });
});

test('browser security rejects invalid and inconsistent settings', () => {
  for (const [name, value] of [
    ['BROWSER_LOGIN_WINDOW_SECONDS', '0'],
    ['BROWSER_LOGIN_IP_LIMIT', 'many'],
    ['BROWSER_LOGIN_USERNAME_LIMIT', '1.5'],
    ['BROWSER_SESSION_IDLE_MINUTES', '0'],
    ['BROWSER_SESSION_DAYS', '31'],
  ]) {
    assert.throws(() => browserSecuritySettings({ [name]: value }), new RegExp(name));
  }
  assert.throws(() => browserSecuritySettings({
    BROWSER_SESSION_DAYS: '1',
    BROWSER_SESSION_IDLE_MINUTES: '1441',
  }), /BROWSER_SESSION_IDLE_MINUTES/);
});
