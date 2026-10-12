'use strict';

// API-owned tables deliberately avoid generic app_* record stamping: token
// hashes and retry bodies have a separate retention policy from business data.
async function initApiSchema(client) {
  await client.query(`
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS api_service_account boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS wm_api_sessions (
      id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES app_users(id),
      password_version text NOT NULL, access_hash text NOT NULL UNIQUE,
      access_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wm_api_sessions_user_idx ON wm_api_sessions(user_id);
    CREATE TABLE IF NOT EXISTS wm_api_refresh_tokens (
      token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES wm_api_sessions(id),
      used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wm_api_refresh_session_idx ON wm_api_refresh_tokens(session_id);
    CREATE TABLE IF NOT EXISTS wm_api_credentials (
      id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES app_users(id),
      token_hash text NOT NULL UNIQUE, scopes jsonb NOT NULL,
      expires_at timestamptz NOT NULL, revoked_at timestamptz,
      last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wm_api_credentials_user_idx ON wm_api_credentials(user_id);
    CREATE TABLE IF NOT EXISTS wm_api_audit (
      id bigserial PRIMARY KEY, request_id uuid NOT NULL,
      actor_id bigint REFERENCES app_users(id), credential_id uuid, session_id uuid,
      operation text NOT NULL, resource_type text, resource_id text,
      outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wm_api_audit_request_idx ON wm_api_audit(request_id);
    CREATE TABLE IF NOT EXISTS wm_api_idempotency (
      actor_id bigint NOT NULL REFERENCES app_users(id), operation text NOT NULL,
      resource_path text NOT NULL, key text NOT NULL, payload_hash text NOT NULL,
      response jsonb NOT NULL, status integer NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(actor_id, operation, resource_path, key)
    );
    CREATE INDEX IF NOT EXISTS wm_api_idempotency_expiry_idx ON wm_api_idempotency(expires_at);
    CREATE TABLE IF NOT EXISTS wm_api_payment_references (
      actor_id bigint NOT NULL REFERENCES app_users(id), source text NOT NULL,
      reference text NOT NULL, invoice_id bigint NOT NULL REFERENCES app_invoices(id),
      payload_hash text NOT NULL, response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(actor_id, source, reference)
    );
    CREATE TABLE IF NOT EXISTS wm_api_rate_limits (
      key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL
    );
  `);
}

module.exports = { initApiSchema };
