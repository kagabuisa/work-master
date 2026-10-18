'use strict';

async function initMaintenanceSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS wm_maintenance_backups (
      id uuid PRIMARY KEY, actor_id bigint NOT NULL REFERENCES app_users(id),
      scope text NOT NULL CHECK(scope IN ('financial','all')),
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      counts jsonb NOT NULL, fingerprint text NOT NULL,
      archive_sha256 text NOT NULL, consumed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS wm_transaction_resets (
      id bigserial PRIMARY KEY, actor_id bigint NOT NULL REFERENCES app_users(id),
      actor_name text NOT NULL, scope text NOT NULL CHECK(scope IN ('financial','all')),
      backup_id uuid NOT NULL REFERENCES wm_maintenance_backups(id),
      counts jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { initMaintenanceSchema };
