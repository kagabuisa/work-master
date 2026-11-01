'use strict';

const DEFAULTS = Object.freeze({
  loginWindowSeconds: 15 * 60,
  loginIpLimit: 100,
  loginUsernameLimit: 5,
  sessionIdleMinutes: 30,
  sessionDays: 7,
});

function setting(env, name, fallback, minimum, maximum) {
  const raw = env[name] === undefined ? String(fallback) : String(env[name]).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function browserSecuritySettings(env = process.env) {
  const loginWindowSeconds = setting(env, 'BROWSER_LOGIN_WINDOW_SECONDS',
    DEFAULTS.loginWindowSeconds, 1, 86400);
  const loginIpLimit = setting(env, 'BROWSER_LOGIN_IP_LIMIT',
    DEFAULTS.loginIpLimit, 1, 100000);
  const loginUsernameLimit = setting(env, 'BROWSER_LOGIN_USERNAME_LIMIT',
    DEFAULTS.loginUsernameLimit, 1, 1000);
  const sessionDays = setting(env, 'BROWSER_SESSION_DAYS',
    DEFAULTS.sessionDays, 1, 30);
  const sessionIdleMinutes = setting(env, 'BROWSER_SESSION_IDLE_MINUTES',
    DEFAULTS.sessionIdleMinutes, 1, sessionDays * 24 * 60);
  return Object.freeze({
    loginWindowSeconds,
    loginIpLimit,
    loginUsernameLimit,
    sessionIdleMinutes,
    sessionDays,
  });
}

module.exports = { DEFAULTS, browserSecuritySettings };
