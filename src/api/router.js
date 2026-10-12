'use strict';
const express = require('express');
const { runWithAuditUser } = require('../audit');
const { getPostgresPool } = require('../core');
const auth = require('./auth');
const { apiError, bodyFields, boundedString } = require('./errors');
const { rateLimit, transport } = require('./security');
const { recordApiAudit } = require('./audit');
const router = express.Router();
const wrap = action => (req, res, next) => Promise.resolve().then(() => action(req, res)).catch(next);

router.use((req, res, next) => {
  try {
    transport(req);
    if (!['GET', 'POST'].includes(req.method)) throw apiError(404, 'not_found', 'API endpoint or method not found.');
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      throw apiError(415, 'unsupported_media_type', 'Send application/json.');
    }
    next();
  } catch (error) { next(error); }
});

router.post('/auth/login', wrap(async (req, res) => {
  if (req.get('authorization')) throw apiError(400, 'mixed_credentials', 'Login does not accept bearer credentials.');
  await rateLimit(req, res, 'login-ip', req.ip, 20, 900);
  bodyFields(req.body, ['username', 'password']);
  const username = boundedString(req.body.username, 'Username', 64);
  const password = boundedString(req.body.password, 'Password', 1024);
  await rateLimit(req, res, 'login-account', username.trim().toLowerCase(), 10, 900);
  res.json({ data: await auth.login(username, password, req.requestId) });
}));

router.post('/auth/refresh', wrap(async (req, res) => {
  if (req.get('authorization')) throw apiError(400, 'mixed_credentials', 'Refresh uses its refresh token only.');
  await rateLimit(req, res, 'refresh-ip', req.ip, 60, 60);
  bodyFields(req.body, ['refresh_token']);
  res.json({ data: await auth.refresh(boundedString(req.body.refresh_token, 'Refresh token'), req.requestId) });
}));

router.use(async (req, res, next) => {
  try {
    await rateLimit(req, res, 'api-ip', req.ip, 300, 60);
    const header = req.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw apiError(401, 'unauthorized', 'A valid bearer credential is required.');
    const actor = await auth.resolveBearer(header.slice(7), req.requestId);
    if (!actor) throw apiError(401, 'unauthorized', 'Credential is expired, revoked or invalid.');
    req.apiActor = actor; req.currentUser = actor.user;
    await rateLimit(req, res, 'api-account', actor.user.id, 120, 60);
    if (actor.user.must_change_password && !['/auth/password', '/auth/logout'].includes(req.path)) {
      throw apiError(403, 'password_change_required', 'Change your password before accessing protected resources.');
    }
    runWithAuditUser(actor.user, next);
  } catch (error) { next(error); }
});

router.get('/me', wrap(async (req, res) => {
  const actor = req.apiActor;
  await recordApiAudit(getPostgresPool(), actor, 'me.read', 'allowed');
  res.json({ data: { id: String(actor.user.id), username: actor.user.username,
    capabilities: actor.user.permissions, credential_scopes: actor.kind === 'integration' ? actor.scopes : null } });
}));
router.post('/auth/logout', wrap(async (req, res) => {
  bodyFields(req.body, []);
  await auth.logout(req.apiActor); res.json({ data: { success: true } });
}));
router.post('/auth/password', wrap(async (req, res) => {
  bodyFields(req.body, ['current_password', 'new_password']);
  await auth.changeMobilePassword(req.apiActor,
    boundedString(req.body.current_password, 'Current password', 1024),
    boundedString(req.body.new_password, 'New password', 1024));
  res.json({ data: { success: true } });
}));
router.post('/integration-accounts', wrap(async (req, res) => {
  bodyFields(req.body, ['username', 'role', 'scopes']);
  const result = await auth.createIntegration(req.apiActor,
    boundedString(req.body.username, 'Username', 64), boundedString(req.body.role, 'Role', 64), req.body.scopes);
  res.status(201).json({ data: result });
}));
router.post('/integration-credentials', wrap(async (req, res) => {
  bodyFields(req.body, ['user_id', 'scopes']);
  if (typeof req.body.user_id !== 'string' || !/^[1-9][0-9]*$/.test(req.body.user_id) || !Number.isSafeInteger(Number(req.body.user_id))) {
    throw apiError(400, 'invalid_request', 'Provide a valid string user_id.');
  }
  res.status(201).json({ data: await auth.rotateCredential(req.apiActor, req.body.user_id, req.body.scopes) });
}));
router.get('/integration-credentials', wrap(async (req, res) => {
  auth.requireMobileAdmin(req.apiActor);
  const { rows } = await getPostgresPool().query(`SELECT id,user_id::text,scopes,expires_at,
    revoked_at,last_used_at,created_at FROM wm_api_credentials ORDER BY created_at DESC,id LIMIT 200`);
  await recordApiAudit(getPostgresPool(), req.apiActor, 'integration.list', 'allowed');
  res.json({ data: rows });
}));
router.post('/integration-credentials/:id/revoke', wrap(async (req, res) => {
  bodyFields(req.body, []);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id)) throw apiError(404, 'not_found', 'Credential not found.');
  await auth.revokeCredential(req.apiActor, req.params.id); res.json({ data: { success: true } });
}));
router.use((req, res, next) => next(apiError(404, 'not_found', 'API endpoint or method not found.')));
module.exports = router;
