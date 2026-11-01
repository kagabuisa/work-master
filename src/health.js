'use strict';

const crypto = require('node:crypto');

function monitoringToken(req) {
  const authorization = String(req.get('authorization') || '');
  if (/^Bearer\s+\S+$/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '');
  return String(req.get('x-monitoring-token') || '');
}

function localDirectRequest(req) {
  if (req.get('x-forwarded-for')) return false;
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function authorized(req, configuredToken) {
  if (localDirectRequest(req)) return true;
  const supplied = monitoringToken(req);
  if (!configuredToken || !supplied) return false;
  const expected = Buffer.from(configuredToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function installHealthRoutes(app, { isReady, checkDatabase, monitoringAccessToken = '', metrics }) {
  const operationalHeaders = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  };

  app.get('/healthz', (_req, res) => {
    operationalHeaders(res);
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    operationalHeaders(res);
    try {
      if (!isReady()) {
        res.status(503).json({ status: 'not_ready' });
        return;
      }
      await checkDatabase();
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.get('/metrics', async (req, res) => {
    operationalHeaders(res);
    if (!authorized(req, monitoringAccessToken)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ status: 'unauthorized' });
      return;
    }
    let ready = false;
    try {
      if (isReady()) {
        await checkDatabase();
        ready = true;
      }
    } catch { /* metrics remains available with readiness set to zero */ }
    res.type('text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(metrics ? metrics({ ready }) : '');
  });
}

module.exports = { authorized, installHealthRoutes, localDirectRequest, monitoringToken };
