'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertSecureTransportConfiguration, secureSessionCookie, rejectCrossOrigin } = require('../src/transport-security');
const { databaseTls } = require('../src/database-tls');

function originRequest(headers = {}, protocol = 'https') {
  let allowed = false;
  let status;
  const req = { method: 'POST', protocol, get: (name) => headers[name.toLowerCase()] };
  const res = { status(value) { status = value; return this; }, send() {} };
  rejectCrossOrigin(req, res, () => { allowed = true; });
  return { allowed, status };
}

test('page referrer policy preserves browser Origin on same-origin form submissions', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /res\.setHeader\('Referrer-Policy', 'same-origin'\)/);
});

test('mutations validate scheme, host and port even for same-site requests', () => {
  const headers = { host: 'app.example.com', 'sec-fetch-site': 'same-site' };
  assert.equal(originRequest({ ...headers, origin: 'https://app.example.com' }).allowed, true);
  for (const origin of ['https://sibling.example.com', 'http://app.example.com', 'https://app.example.com:444', 'null', 'invalid']) {
    assert.equal(originRequest({ ...headers, origin }).status, 403);
  }
  assert.equal(originRequest(headers).status, 403);
  assert.equal(originRequest({ ...headers, origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }).status, 403);
  assert.equal(originRequest({ host: 'app.example.com' }).allowed, true);
  assert.equal(originRequest({ ...headers, origin: 'https://app.example.com', 'sec-fetch-site': 'cross-site' }).status, 403);
});

test('production requires proxy trust and always secures cookies unless HTTP is explicitly enabled', () => {
  const env = { NODE_ENV: 'production', TLS_TERMINATED_PROXY: 'true' };
  assert.throws(() => assertSecureTransportConfiguration(env));
  assert.doesNotThrow(() => assertSecureTransportConfiguration({ ...env, TRUST_PROXY: 'true' }));
  assert.equal(secureSessionCookie({ secure: false }, { ...env, TRUST_PROXY: 'true' }), true);
  const httpEnv = { ...env, ALLOW_INSECURE_COOKIES: 'true' };
  assert.doesNotThrow(() => assertSecureTransportConfiguration(httpEnv));
  assert.equal(secureSessionCookie({ secure: false }, httpEnv), false);
  assert.equal(secureSessionCookie({ secure: true }, httpEnv), true);
});

test('database TLS verifies certificates and loads private CA files', () => {
  assert.equal(databaseTls('false'), undefined);
  assert.deepEqual(databaseTls('true'), { rejectUnauthorized: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-tls-'));
  try {
    const file = path.join(dir, 'ca.pem');
    fs.writeFileSync(file, 'private CA certificate');
    assert.deepEqual(databaseTls('required', file), { rejectUnauthorized: true, ca: 'private CA certificate' });
    assert.throws(() => databaseTls('true', path.join(dir, 'missing.pem')), { code: 'ENOENT' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
