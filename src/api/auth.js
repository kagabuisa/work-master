'use strict';
const crypto = require('node:crypto');
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { applyPermissionOverrides, authenticate, verifyPassword, passwordHash,
  validatePassword, createUser } = require('../auth');
const { runWithAuditUser } = require('../audit');
const { apiError } = require('./errors');
const { hash, secret, validateScopes } = require('./security');
const { recordApiAudit } = require('./audit');
const ACCESS_SECONDS = 900;

async function currentUser(client, id, lock = false) {
  const { rows } = await client.query(`SELECT u.id,u.username,u.active,u.must_change_password,
    u.api_service_account,u.password_hash,u.role,u.permission_grants,u.permission_denials,u.record_access,
    r.permissions,r.scopes FROM app_users u LEFT JOIN app_roles r ON r.slug=u.role
    WHERE u.id=$1 ${lock ? 'FOR UPDATE OF u' : ''}`, [id]);
  const user = rows[0];
  if (!user?.active || !user.permissions) return null;
  user.permissions = applyPermissionOverrides(user.permissions, user.permission_grants, user.permission_denials);
  return user;
}

function tokenResponse(access, refresh, user) {
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer',
    expires_in: ACCESS_SECONDS, password_change_required: Boolean(user.must_change_password) };
}

async function login(username, password, requestId) {
  const verified = await authenticate(username, password);
  if (!verified) throw apiError(401, 'invalid_credentials', 'Invalid username or password.');
  return runWithAuditUser(verified, () => withPostgresTransaction(async client => {
    const user = await currentUser(client, verified.id, true);
    // Reverify under lock so a concurrent reset cannot issue a fresh session.
    if (!user || user.api_service_account || !await verifyPassword(password, user.password_hash)) {
      throw apiError(401, 'invalid_credentials', 'Invalid username or password.');
    }
    const id = crypto.randomUUID(), access = secret(), refresh = secret();
    await client.query(`INSERT INTO wm_api_sessions
      (id,user_id,password_version,access_hash,access_expires_at,expires_at)
      VALUES ($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '30 days')`,
    [id, user.id, hash(user.password_hash), hash(access)]);
    await client.query('INSERT INTO wm_api_refresh_tokens(token_hash,session_id) VALUES ($1,$2)', [hash(refresh), id]);
    await recordApiAudit(client, { requestId, user, sessionId: id }, 'auth.login', 'committed');
    return tokenResponse(access, refresh, user);
  }));
}

async function refresh(token, requestId) {
  const result = await withPostgresTransaction(async client => {
    const { rows } = await client.query(`SELECT s.* FROM wm_api_sessions s
      JOIN wm_api_refresh_tokens r ON r.session_id=s.id WHERE r.token_hash=$1 FOR UPDATE OF s`, [hash(token)]);
    const session = rows[0];
    if (!session) return null;
    // Re-read after acquiring the family lock: a concurrent refresh may have
    // consumed the token while this transaction was waiting.
    const used = (await client.query('SELECT used_at FROM wm_api_refresh_tokens WHERE token_hash=$1', [hash(token)])).rows[0];
    const user = await currentUser(client, session.user_id, true);
    const actor = { requestId, user, sessionId: session.id };
    if (used.used_at) {
      await client.query('UPDATE wm_api_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [session.id]);
      await recordApiAudit(client, actor, 'auth.refresh', 'replay_revoked');
      return null; // Commit revocation before reporting failure.
    }
    if (session.revoked_at || new Date(session.expires_at) <= new Date()
      || !user || user.api_service_account || hash(user.password_hash) !== session.password_version) return null;
    const access = secret(), nextRefresh = secret();
    await client.query('UPDATE wm_api_refresh_tokens SET used_at=now() WHERE token_hash=$1', [hash(token)]);
    await client.query(`UPDATE wm_api_sessions SET access_hash=$1,access_expires_at=now()+interval '15 minutes' WHERE id=$2`, [hash(access), session.id]);
    await client.query('INSERT INTO wm_api_refresh_tokens(token_hash,session_id) VALUES ($1,$2)', [hash(nextRefresh), session.id]);
    await recordApiAudit(client, actor, 'auth.refresh', 'committed');
    return tokenResponse(access, nextRefresh, user);
  });
  if (!result) throw apiError(401, 'invalid_refresh_token', 'Refresh token is expired, revoked or already used. Sign in again.');
  return result;
}

async function resolveBearer(token, requestId, client = getPostgresPool()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const { rows: sessions } = await client.query(`SELECT * FROM wm_api_sessions WHERE access_hash=$1
    AND revoked_at IS NULL AND access_expires_at>now() AND expires_at>now()`, [hash(token)]);
  if (sessions[0]) {
    const session = sessions[0], user = await currentUser(client, session.user_id);
    if (!user || user.api_service_account || hash(user.password_hash) !== session.password_version) return null;
    return { user, requestId, sessionId: session.id, accessHash: session.access_hash, kind: 'mobile' };
  }
  const { rows: credentials } = await client.query(`SELECT * FROM wm_api_credentials
    WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [hash(token)]);
  if (!credentials[0]) return null;
  const credential = credentials[0], user = await currentUser(client, credential.user_id);
  if (!user || !user.api_service_account || user.role === 'admin' || user.must_change_password) return null;
  await client.query('UPDATE wm_api_credentials SET last_used_at=now() WHERE id=$1', [credential.id]);
  return { user, requestId, credentialId: credential.id, scopes: credential.scopes, kind: 'integration' };
}

async function logout(actor) {
  if (actor.kind !== 'mobile') throw apiError(403, 'forbidden', 'Integration credentials use administrator revocation.');
  await withPostgresTransaction(async client => {
    await client.query('UPDATE wm_api_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [actor.sessionId]);
    await recordApiAudit(client, actor, 'auth.logout', 'committed');
  });
}

async function changeMobilePassword(actor, current, next) {
  if (actor.kind !== 'mobile') throw apiError(403, 'forbidden', 'Only mobile users can change their password.');
  validatePassword(next);
  const newHash = await passwordHash(next);
  await withPostgresTransaction(async client => {
    // Password-change-required sessions are deliberately allowed here, so the
    // financial revalidation helper (which rejects them) is not used.
    const user = await currentUser(client, actor.user.id, true);
    const { rows: sessions } = await client.query(`SELECT password_version FROM wm_api_sessions
      WHERE id=$1 AND user_id=$2 AND access_hash=$3 AND revoked_at IS NULL
        AND access_expires_at>now() AND expires_at>now()`, [actor.sessionId, actor.user.id, actor.accessHash]);
    if (!user || !sessions[0] || sessions[0].password_version !== hash(user.password_hash)) {
      throw apiError(401, 'unauthorized', 'Credentials are no longer valid.');
    }
    if (!user || !await verifyPassword(current, user.password_hash)) {
      throw apiError(400, 'invalid_password', 'Current password is incorrect.');
    }
    await client.query('UPDATE app_users SET password_hash=$1,must_change_password=false WHERE id=$2', [newHash, user.id]);
    // Same browser revocation behavior as the existing password change.
    await client.query('DELETE FROM app_user_sessions WHERE user_id=$1', [user.id]);
    await client.query('UPDATE wm_api_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [user.id]);
    await recordApiAudit(client, actor, 'auth.password', 'committed');
  });
}

function requireMobileAdmin(actor) {
  if (actor.kind !== 'mobile' || actor.user.role !== 'admin') throw apiError(403, 'forbidden', 'Mobile administrator authentication is required.');
}

async function issueCredential(client, userId, scopes) {
  validateScopes(scopes);
  const user = await currentUser(client, userId, true);
  if (!user || !user.api_service_account || user.role === 'admin' || user.must_change_password) {
    throw apiError(400, 'invalid_service_account', 'Choose an active non-admin integration account.');
  }
  const id = crypto.randomUUID(), token = secret();
  const { rows } = await client.query(`INSERT INTO wm_api_credentials(id,user_id,token_hash,scopes,expires_at)
    VALUES ($1,$2,$3,$4::jsonb,now()+interval '90 days') RETURNING expires_at`, [id, userId, hash(token), JSON.stringify(scopes)]);
  return { id, user_id: String(userId), token, scopes, expires_at: rows[0].expires_at };
}

async function createIntegration(actor, username, role, scopes) {
  requireMobileAdmin(actor); validateScopes(scopes);
  if (role === 'admin') throw apiError(400, 'invalid_service_account', 'Integration accounts cannot be administrators.');
  return withPostgresTransaction(async client => {
    const fresh = await require('./transactions').revalidateActor(client, actor);
    requireMobileAdmin(fresh);
    // No interactive password is revealed; the explicit flag also prevents login
    // even if a website administrator later resets this account's password.
    const user = await createUser(username, secret(), { role }, client);
    await client.query('UPDATE app_users SET api_service_account=true WHERE id=$1', [user.id]);
    const credential = await issueCredential(client, user.id, scopes);
    await recordApiAudit(client, fresh, 'integration.create', 'committed', { type: 'credential', id: credential.id });
    return credential;
  });
}

async function rotateCredential(actor, userId, scopes) {
  requireMobileAdmin(actor);
  return withPostgresTransaction(async client => {
    const fresh = await require('./transactions').revalidateActor(client, actor);
    requireMobileAdmin(fresh);
    const credential = await issueCredential(client, userId, scopes);
    await recordApiAudit(client, fresh, 'integration.issue', 'committed', { type: 'credential', id: credential.id });
    return credential;
  });
}

async function revokeCredential(actor, id) {
  requireMobileAdmin(actor);
  await withPostgresTransaction(async client => {
    const fresh = await require('./transactions').revalidateActor(client, actor);
    requireMobileAdmin(fresh);
    const { rowCount } = await client.query('UPDATE wm_api_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [id]);
    if (!rowCount) throw apiError(404, 'not_found', 'Credential not found.');
    await recordApiAudit(client, fresh, 'integration.revoke', 'committed', { type: 'credential', id });
  });
}
module.exports = { login, refresh, resolveBearer, logout, changeMobilePassword, createIntegration,
  rotateCredential, revokeCredential, requireMobileAdmin, currentUser };
