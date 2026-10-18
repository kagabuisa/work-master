const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const { acquireReadLease, connectionWorkload, recordConnectionCheckout } = require('./workload-control');
const { MAINTENANCE_LOCK, maintenanceBusy, resetEpoch, staleResetRequest } = require('./maintenance-lock');

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
const connectionFailures = new WeakMap();
const watchedConnections = new WeakSet();
function logConnectionError(event, error) {
  const code = /^[A-Z0-9_]{1,32}$/.test(error?.code || '') ? error.code : 'CONNECTION_LOST';
  console.error(JSON.stringify({ event, code }));
}
class AuditPool extends Pool {
  constructor(options) {
    super(options);
    // pg emits idle-client failures on the pool and removes unusable clients.
    this.on('error', error => logConnectionError('postgres_pool_error', error));
  }
  connect(callback) {
    if (!callback) {
      return new Promise((resolve, reject) => this.connect((error, client) => error ? reject(error) : resolve(client)));
    }
    const started=performance.now(),kind=connectionWorkload(),deliver=callback;
    callback=(...args)=>{recordConnectionCheckout(kind,performance.now()-started,Boolean(args[0]));return deliver(...args);};
    const actor = auditActor();
    const expected=resetEpoch();
    acquireReadLease().then(freeReadSlot => super.connect((error, client, rawRelease) => {
      if (error) { freeReadSlot(); return callback(error); }
      const release = error => { try { rawRelease(error); } finally { freeReadSlot(); } };
      // During checkout pg removes its idle listener. Keep one lifetime listener
      // so a socket failure cannot become an uncaught EventEmitter error.
      if (!watchedConnections.has(client)) {
        watchedConnections.add(client);
        client.on('error', failure => {
          connectionFailures.set(client, failure);
          logConnectionError('postgres_connection_error', failure);
        });
      }
      client.query("SELECT set_config('app.audit_user_id', $1, false), set_config('app.audit_username', $2, false), pg_try_advisory_lock_shared($3) AS available",
        [actor.id || '', actor.name, MAINTENANCE_LOCK], (settingError, result) => {
          if (settingError) {
            release(settingError);
            return callback(settingError);
          }
          if (!result.rows[0].available) {
            release();
            return callback(maintenanceBusy());
          }
          const ready = () => {
            let released = false;
            const guardedRelease = (error) => {
              if (released) throw new Error('Client already released.');
              released = true;
              if (error || connectionFailures.has(client)) return release(error || connectionFailures.get(client));
              client.query('SELECT pg_advisory_unlock_shared($1)', [MAINTENANCE_LOCK], (unlockError) => release(unlockError));
            };
            client.release = guardedRelease;
            callback(null, client, guardedRelease);
          };
          if (expected===undefined) return ready();
          client.query('SELECT COALESCE(MAX(id),0)::text AS epoch FROM wm_transaction_resets', (epochError, epochResult) => {
            if (epochError || epochResult.rows[0].epoch!==expected) {
              const error=epochError || staleResetRequest();
              release(error);
              return callback(error);
            }
            ready();
          });
        });
    }), callback);
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

module.exports = { AuditPool, runWithAuditUser, auditActor, initRecordAudit, recordAuditFields };
