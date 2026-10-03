'use strict';
// Versioned schema migration runner.
//
// The current idempotent bootstrap DDL (initPostgresStore in store.js, plus the
// pricing, auth and audit DDL) is SCHEMA_VERSION 1. Future schema changes are
// appended to MIGRATIONS as { version, name, up(client) } and SCHEMA_VERSION is
// bumped. ensureSchema records the version under a session advisory lock so two
// concurrent startups cannot race the migration step.

const SCHEMA_VERSION = 1;

// Arbitrary but stable per-app advisory-lock key.
const ADVISORY_LOCK_KEY = 1776342159;

// Ordered migrations with version > 1. Append here for future schema changes; the
// runner applies each in its own transaction and records it in wm_schema_version.
const MIGRATIONS = [];

async function ensureSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wm_schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query(
      'SELECT COALESCE(MAX(version), 0)::int AS version FROM wm_schema_version',
    );
    const current = Number(rows[0].version);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than this app supports (${SCHEMA_VERSION}). Upgrade the application.`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query(
          'INSERT INTO wm_schema_version (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // Record the baseline version once. The idempotent bootstrap DDL has already
    // run by the time this is called, so this only marks it as applied.
    await client.query(
      'INSERT INTO wm_schema_version (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
      [SCHEMA_VERSION, 'baseline'],
    );
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch {
      // The connection may already be broken; releasing the client is enough.
    }
    client.release();
  }
}

module.exports = { SCHEMA_VERSION, ensureSchema };
