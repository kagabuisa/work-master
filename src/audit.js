const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const { Pool } = require('pg');

const context = new AsyncLocalStorage();
const AUDIT_FIELDS = ['created_by', 'created_by_user_id', 'created_at', 'updated_by', 'updated_by_user_id', 'updated_at'];

function runWithAuditUser(user, callback) {
  const actor = user ? { id: String(user.id), name: String(user.username) } : { id: null, name: 'System' };
  return context.run(actor, callback);
}

function auditActor() {
  return context.getStore() || { id: null, name: 'System' };
}

// Every checkout sets both values, including background jobs, so pooled
// connections can never carry the preceding request's identity into a write.
class AuditPool extends Pool {
  connect(callback) {
    if (!callback) {
      return new Promise((resolve, reject) => this.connect((error, client) => error ? reject(error) : resolve(client)));
    }
    const actor = auditActor();
    return super.connect((error, client, release) => {
      if (error) return callback(error);
      client.query("SELECT set_config('app.audit_user_id', $1, false), set_config('app.audit_username', $2, false)",
        [actor.id || '', actor.name], (settingError) => {
          if (settingError) {
            release(settingError);
            return callback(settingError);
          }
          callback(null, client, release);
        });
    });
  }
}

const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function initRecordAudit(pool, tableNames) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.record_audit'))");
    const { rows } = await client.query(`
      SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname = current_schema() AND left(tablename, 4) = 'app_'
        AND ($1::text[] IS NULL OR tablename = ANY($1::text[]))
      ORDER BY tablename
    `, [tableNames || null]);
    if (rows.length) {
      const schema = identifier(rows[0].schemaname);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${schema}.app_stamp_record_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
          actor_id text := NULLIF(current_setting('app.audit_user_id', true), '');
          actor_name text := COALESCE(NULLIF(current_setting('app.audit_username', true), ''), 'System');
        BEGIN
          IF TG_OP = 'INSERT' THEN
            NEW.created_by := actor_name;
            NEW.created_by_user_id := actor_id;
            NEW.created_at := statement_timestamp();
          ELSE
            NEW.created_by := OLD.created_by;
            NEW.created_by_user_id := OLD.created_by_user_id;
            NEW.created_at := OLD.created_at;
            IF (to_jsonb(NEW) - ARRAY['created_by','created_by_user_id','created_at','updated_by','updated_by_user_id','updated_at'])
                IS NOT DISTINCT FROM
               (to_jsonb(OLD) - ARRAY['created_by','created_by_user_id','created_at','updated_by','updated_by_user_id','updated_at']) THEN
              NEW.updated_by := OLD.updated_by;
              NEW.updated_by_user_id := OLD.updated_by_user_id;
              NEW.updated_at := OLD.updated_at;
              RETURN NEW;
            END IF;
          END IF;
          NEW.updated_by := actor_name;
          NEW.updated_by_user_id := actor_id;
          NEW.updated_at := statement_timestamp();
          RETURN NEW;
        END;
        $$
      `);
      for (const row of rows) {
        const table = `${schema}.${identifier(row.tablename)}`;
        // Nullable additions preserve the fact that historical actors/times may be unknown.
        await client.query(`ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS created_by TEXT,
          ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS updated_by TEXT,
          ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
        await client.query(`DROP TRIGGER IF EXISTS app_record_audit ON ${table}`);
        await client.query(`CREATE TRIGGER app_record_audit BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${schema}.app_stamp_record_audit()`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function recordAuditFields(record = {}) {
  return Object.fromEntries(AUDIT_FIELDS.map((key) => [key, record[key] ?? null]));
}

function withoutAudit(record) {
  if (Array.isArray(record)) return record.map(withoutAudit);
  if (!record || typeof record !== 'object') return record;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !AUDIT_FIELDS.includes(key))
    .map(([key, value]) => [key, withoutAudit(value)]));
}

function stampRecord(record, previous) {
  const actor = auditActor();
  const now = new Date().toISOString();
  if (previous && isDeepStrictEqual(withoutAudit(record), withoutAudit(previous))) {
    Object.assign(record, recordAuditFields(previous));
    return record;
  }
  Object.assign(record, {
    created_by: previous ? previous.created_by ?? null : actor.name,
    created_by_user_id: previous ? previous.created_by_user_id ?? null : actor.id,
    created_at: previous ? previous.created_at ?? null : now,
    updated_by: actor.name,
    updated_by_user_id: actor.id,
    updated_at: now,
  });
  return record;
}

function stampRecordList(records = [], previous = []) {
  const key = (row, index) => row.token_hash ?? row.id ?? row.slug ?? row.item_code ?? index;
  const old = new Map(previous.map((row, index) => [key(row, index), row]));
  for (const [index, record] of records.entries()) {
    const before = old.get(key(record, index));
    for (const children of ['items', 'payments']) {
      if (Array.isArray(record[children])) stampRecordList(record[children], before?.[children]);
    }
    stampRecord(record, before);
  }
  return records;
}

module.exports = { AuditPool, runWithAuditUser, auditActor, initRecordAudit, recordAuditFields, stampRecord, stampRecordList };
