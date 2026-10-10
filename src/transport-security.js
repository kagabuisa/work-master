'use strict';

function assertSecureTransportConfiguration(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.ALLOW_INSECURE_COOKIES === 'true') return;
  if (env.TRUST_PROXY !== 'true') {
    throw new Error('Production requires TRUST_PROXY=true behind a TLS reverse proxy, or ALLOW_INSECURE_COOKIES=true for a trusted private HTTP deployment.');
  }
}

function secureSessionCookie(req, env = process.env) {
  return (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_COOKIES !== 'true') || req.secure;
}

function rejectCrossOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const deny = () => res.status(403).send('Request origin is not allowed.');
  if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') return deny();
  const origin = req.get('origin');
  if (!origin) {
    const site = String(req.get('sec-fetch-site') || '').toLowerCase();
    return site === 'same-site' ? deny() : next();
  }
  try {
    const expected = new URL(`${req.protocol}://${req.get('host')}`).origin;
    if (new URL(origin).origin !== expected) return deny();
  } catch { return deny(); }
  return next();
}

module.exports = { assertSecureTransportConfiguration, secureSessionCookie, rejectCrossOrigin };
