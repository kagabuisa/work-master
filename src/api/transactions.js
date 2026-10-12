'use strict';
const { withPostgresTransaction } = require('../core');
const { currentUser } = require('./auth');
const { hash } = require('./security');
const { apiError } = require('./errors');
const { recordApiAudit } = require('./audit');
const { runWithAuditUser } = require('../audit');

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw apiError(400, 'invalid_request', 'Payload must contain valid JSON values.');
}

async function revalidateActor(client, actor) {
  const user = await currentUser(client, actor.user.id, true);
  if (!user || user.must_change_password) throw apiError(401, 'unauthorized', 'Credentials are no longer valid.');
  if (actor.kind === 'mobile') {
    const { rows } = await client.query(`SELECT password_version FROM wm_api_sessions WHERE id=$1 AND user_id=$2
      AND access_hash=$3 AND revoked_at IS NULL AND access_expires_at>clock_timestamp() AND expires_at>clock_timestamp()
      FOR SHARE`, [actor.sessionId, user.id, actor.accessHash]);
    if (user.api_service_account || !rows[0] || rows[0].password_version !== hash(user.password_hash)) {
      throw apiError(401, 'unauthorized', 'Credentials are no longer valid.');
    }
    return { ...actor, user };
  }
  const { rows } = await client.query(`SELECT scopes FROM wm_api_credentials WHERE id=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, [actor.credentialId, user.id]);
  if (!user.api_service_account || user.role === 'admin' || !rows[0]) {
    throw apiError(401, 'unauthorized', 'Credentials are no longer valid.');
  }
  return { ...actor, user, scopes: rows[0].scopes };
}

// Financial routes will supply an operation-specific policy and a client-taking
// domain mutation. No existing website caller uses this API retry mechanism.
async function atomicMutation(actor, operation, resourcePath, key, payload, authorize, mutate) {
  if (typeof key !== 'string' || !key.length || key.length > 128) {
    throw apiError(400, 'idempotency_key_required', 'Provide an Idempotency-Key of 1–128 characters.');
  }
  const payloadHash = hash(canonical(payload));
  try {
    return await runWithAuditUser(actor.user, () => withPostgresTransaction(async client => {
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query(`SELECT set_config('statement_timeout',
        LEAST(CASE WHEN setting::int>0 THEN setting::int ELSE 15000 END,15000)::text,true)
        FROM pg_settings WHERE name='statement_timeout'`);
      // Serialize duplicate operations across processes, before the business write.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [canonical([String(actor.user.id), operation, resourcePath, key])]);
      const fresh = await revalidateActor(client, actor);
      await client.query("SELECT set_config('app.audit_user_id',$1,true),set_config('app.audit_username',$2,true)",
        [String(fresh.user.id), fresh.user.username]);
      return runWithAuditUser(fresh.user, async () => {
        await authorize(client, fresh); // Also required before stored-response replay.
        const params = [actor.user.id, operation, resourcePath, key];
        await client.query(`DELETE FROM wm_api_idempotency WHERE actor_id=$1 AND operation=$2
          AND resource_path=$3 AND key=$4 AND expires_at<=now()`, params);
        const { rows } = await client.query(`SELECT * FROM wm_api_idempotency WHERE actor_id=$1
          AND operation=$2 AND resource_path=$3 AND key=$4`, params);
        if (rows[0]) {
          if (rows[0].payload_hash !== payloadHash) throw apiError(409, 'idempotency_conflict', 'This key was used with a different payload.');
          await recordApiAudit(client, fresh, operation, 'replayed', {
            type: rows[0].resource_type, id: rows[0].resource_id });
          return { status: rows[0].status, body: rows[0].response, replayed: true };
        }
        const result = await mutate(client, fresh);
        if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
          throw new Error('Mutation must return a successful response.');
        }
        const body = { data: result.data };
        await client.query(`INSERT INTO wm_api_idempotency
          (actor_id,operation,resource_path,key,payload_hash,response,status,expires_at,resource_type,resource_id)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,clock_timestamp()+interval '7 days',$8,$9)`,
        [...params, payloadHash, JSON.stringify(body), result.status, result.resource?.type || null,
          result.resource?.id == null ? null : String(result.resource.id)]);
        await recordApiAudit(client, fresh, operation, 'committed', result.resource);
        return { status: result.status, body, replayed: false };
      });
    }));
  } catch (error) {
    if (['55P03', '40P01'].includes(error.code)) {
      throw apiError(409, 'operation_in_progress', 'A concurrent operation is in progress. Retry with the same key.');
    }
    if (error.code === '57014') throw apiError(503, 'operation_timed_out', 'The operation timed out. Retry with the same key.');
    throw error;
  }
}

// Permanent API-only protection is independent of expiring retry keys. It
// neither changes app_invoice_payments nor enforces new rules on website inputs.
async function permanentPayment(client, actor, invoiceId, source, reference, payload, mutate) {
  if (!/^[1-9][0-9]*$/.test(String(invoiceId)) || !Number.isSafeInteger(Number(invoiceId))) {
    throw apiError(400, 'invalid_request', 'Choose a valid invoice ID.');
  }
  if (![source, reference].every(value => typeof value === 'string' && value.trim() === value && value.length)
    || source.length > 100 || reference.length > 200) {
    throw apiError(400, 'payment_reference_required', 'Provide a bounded payment source and external reference.');
  }
  const payloadHash = hash(canonical({ invoice_id: String(invoiceId), payload }));
  const params = [actor.user.id, source, reference];
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [canonical(['payment-reference', ...params])]);
  const { rows } = await client.query(`SELECT * FROM wm_api_payment_references
    WHERE actor_id=$1 AND source=$2 AND reference=$3`, params);
  if (rows[0]) {
    if (rows[0].payload_hash !== payloadHash) throw apiError(409, 'payment_reference_conflict', 'This external payment reference was used for a different payment.');
    return rows[0].response;
  }
  const result = await mutate(client);
  await client.query(`INSERT INTO wm_api_payment_references(actor_id,source,reference,invoice_id,payload_hash,response)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [...params, invoiceId, payloadHash, JSON.stringify(result)]);
  return result;
}
module.exports = { canonical, atomicMutation, permanentPayment, revalidateActor };
