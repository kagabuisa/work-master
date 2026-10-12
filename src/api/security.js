'use strict';
const crypto = require('node:crypto');
const { apiError } = require('./errors');
const { getPostgresPool } = require('../core');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const SCOPES = ['masters:read', 'stock:read', 'invoices:read', 'invoices:create', 'invoices:submit', 'payments:record'];

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > SCOPES.length
      || scopes.some(scope => !SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) {
    throw apiError(400, 'invalid_scopes', 'Choose unique supported integration scopes.');
  }
  return scopes;
}

async function rateLimit(req, res, category, identifier, limit, seconds) {
  const key = hash(`${category}:${identifier}`);
  const { rows } = await getPostgresPool().query(`INSERT INTO wm_api_rate_limits(key,count,reset_at)
    VALUES ($1,1,now()+($2::int*interval '1 second'))
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN wm_api_rate_limits.reset_at<=now() THEN 1 ELSE wm_api_rate_limits.count+1 END,
      reset_at=CASE WHEN wm_api_rate_limits.reset_at<=now() THEN EXCLUDED.reset_at ELSE wm_api_rate_limits.reset_at END
    RETURNING count, GREATEST(1,ceil(extract(epoch FROM reset_at-now())))::int AS wait`, [key, seconds]);
  if (rows[0].count > limit) {
    res.set('Retry-After', String(rows[0].wait));
    throw apiError(429, 'rate_limited', 'Too many requests. Retry after the indicated delay.');
  }
}

function transport(req) {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    throw apiError(403, 'https_required', 'API credentials require HTTPS.');
  }
  // v1 is bearer-only; browser-cookie protection for the website is unchanged.
  if (/(?:^|;\s*)wm_session=/.test(req.headers.cookie || '')) {
    throw apiError(400, 'mixed_credentials', 'Do not send website session cookies to the bearer API.');
  }
  if (req.get('origin') || ['cross-site', 'same-site'].includes(req.get('sec-fetch-site'))) {
    throw apiError(403, 'origin_not_allowed', 'Browser-origin API requests are not enabled.');
  }
}
module.exports = { hash, secret, SCOPES, validateScopes, rateLimit, transport };
