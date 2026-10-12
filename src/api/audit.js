'use strict';
async function recordApiAudit(client, actor, operation, outcome, resource = {}) {
  await client.query(`INSERT INTO wm_api_audit
    (request_id,actor_id,credential_id,session_id,operation,outcome,resource_type,resource_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.requestId, actor.user?.id || null,
    actor.credentialId || null, actor.sessionId || null, operation, outcome,
    resource.type || null, resource.id == null ? null : String(resource.id)]);
}
module.exports = { recordApiAudit };
