'use strict';
const crypto = require('node:crypto');
const { monitor, configuration } = require('./monitoring');

function apiError(status, code, message) {
  const error = new Error(message); error.status = status; error.code = code; return error;
}

function apiContext(req, res, next) {
  req.apiV1 = true;
  req.requestId = crypto.randomUUID();
  res.set('X-Request-ID', req.requestId);
  res.set('Cache-Control', 'no-store');
  monitor.observe(req, res);
  if (!configuration().enabled) return next(apiError(503, 'api_disabled', 'The API is temporarily unavailable.'));
  next();
}

async function apiErrors(error, req, res, next) {
  if (!req.apiV1) return next(error);
  if (error.code === '23505') error = apiError(409, 'conflict', 'A record with this identifier already exists.');
  const candidate = Number(error.status || 500);
  const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
  const codes = { 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden',
    404: 'not_found', 409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type',
    422: 'validation_failed', 429: 'rate_limited', 503: 'unavailable' };
  // Database errors have codes too; only expose our allowlisted symbolic codes.
  const code = /^[a-z][a-z_]+$/.test(error.code || '') ? error.code : codes[status] || 'internal_error';
  req.apiErrorCode = code;
  if (status >= 500) console.error('api_request_error', { request_id: req.requestId, status });
  if (status < 500 && req.requestId) {
    try {
      const { recordApiAudit } = require('./audit');
      const { getPostgresPool } = require('../core');
      await recordApiAudit(getPostgresPool(), req.apiActor || { requestId: req.requestId },
        `${req.method} ${req.route?.path || 'unclassified'}`, `denied_${status}`);
    } catch {
      // Reporting an authentication failure must not expose database errors.
      console.error('api_audit_failure', { request_id: req.requestId });
    }
  }
  res.status(status).json({ error: { code, message: status >= 500
    ? 'The service could not complete the request.'
    : error.type === 'entity.parse.failed' ? 'Malformed JSON body.' : error.message,
  request_id: req.requestId } });
}

function bodyFields(body, required, optional = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => ![...required, ...optional].includes(key))
      || required.some(key => !(key in body))) {
    throw apiError(400, 'invalid_request', 'Provide the documented request fields only.');
  }
}

function boundedString(value, label, max = 128) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    throw apiError(400, 'invalid_request', `${label} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}
module.exports = { apiError, apiContext, apiErrors, bodyFields, boundedString };
