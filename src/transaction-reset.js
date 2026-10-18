'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { getPostgresPool } = require('./core');
const { MAINTENANCE_LOCK, maintenanceBusy } = require('./maintenance-lock');

const DATA_ROOT = path.resolve(__dirname, '..', 'data');
const BACKUP_ROOT = path.join(DATA_ROOT, 'transaction-reset-backups');
const GROUPS = [
  ['Sales', ['app_invoices', 'app_invoice_items', 'app_invoice_payments']],
  ['Purchases', ['app_purchases', 'app_purchase_items', 'app_purchase_payments']],
  ['Purchase orders', ['app_purchase_orders', 'app_purchase_order_items']],
  ['Journals', ['app_journal_entries', 'app_journal_entry_lines']],
  ['Stock', ['wm_inventory_correction_audit','wm_inventory_corrections','wm_inventory_closures','wm_inventory_count_audit','wm_inventory_count_lines','wm_inventory_events','wm_inventory_control','wm_inventory_counts','app_stock_entries', 'app_stock_entry_delivery', 'app_stock_entry_shares', 'app_stock_entry_items', 'app_stock_ledger', 'app_stock_balances', 'app_stock_reconciliation_attachments', 'app_reconciliation_photo_counts']],
  ['Daily activity', ['app_daily_activity_reports']],
];
const HR_TABLES = ['app_hr_attendance', 'app_hr_leave_allocations', 'app_hr_leave_requests',
  'app_hr_money', 'app_hr_runs', 'app_hr_slips', 'app_hr_payments', 'app_hr_recoveries'];
const SESSION_TABLES = ['app_user_sessions', 'wm_api_refresh_tokens', 'wm_api_sessions'];
const RETRY_TABLES = ['wm_api_idempotency', 'wm_api_payment_references'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function validateScope(scope) {
  if (!['financial', 'all'].includes(scope)) fail('Choose a reset scope.');
  return scope;
}

async function requireAdministrator(client, user) {
  if (!user || user.role !== 'admin') fail('Only an administrator can reset transactions.', 403);
  const { rows } = await client.query(`SELECT id,username,password_hash FROM app_users WHERE id=$1 AND role='admin'
    AND active AND NOT must_change_password AND NOT api_service_account FOR SHARE`, [user.id]);
  if (!rows[0]) fail('Only an active administrator can reset transactions.', 403);
  return rows[0];
}

async function inventory(client, scope) {
  validateScope(scope);
  const groups = [...GROUPS, ...(scope === 'all' ? [['HR transactions', HR_TABLES]] : [])];
  const counts = {};
  for (const [label, tables] of groups) {
    counts[label] = {};
    for (const table of tables) counts[label][table] = Number((await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
  }
  counts['General ledger'] = { app_gl_entries: Number((await client.query(`SELECT COUNT(*)::int AS count FROM app_gl_entries
    ${scope === 'financial' ? "WHERE left(voucher_type,3)<>'hr_'" : ''}`)).rows[0].count) };
  return counts;
}

async function businessTables(client) {
  return (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND (left(tablename,4)='app_' OR tablename LIKE 'wm_inventory_%') AND tablename NOT IN ('app_users','app_user_sessions','app_roles') ORDER BY tablename`)).rows.map(row => row.tablename);
}

async function fingerprint(client, tables, files) {
  const digest = crypto.createHash('sha256');
  for (const table of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(record)::text),'' ORDER BY md5(to_jsonb(record)::text)),'')) AS hash FROM "${table}" record`);
    digest.update(`${table}:${rows[0].count}:${rows[0].hash}\n`);
  }
  if (files) digest.update(JSON.stringify(files));
  return digest.digest('hex');
}

async function exclusive(callback) {
  const client = await getPostgresPool().connect();
  let locked = false;
  try {
    await client.query("SET lock_timeout='5s'");
    try { await client.query('SELECT pg_advisory_lock($1)', [MAINTENANCE_LOCK]); locked = true; }
    catch (error) { if (error.code === '55P03') throw maintenanceBusy(); throw error; }
    return await callback(client);
  } finally {
    let releaseError;
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
      await client.query('RESET lock_timeout');
    } catch (error) { releaseError=error; }
    finally { client.release(releaseError); }
  }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  try { for await (const chunk of createReadStream(file)) hash.update(chunk); }
  catch { fail('A backup file is unavailable. Create a new verified backup.',409); }
  return hash.digest('hex');
}

async function fileManifest(directory = DATA_ROOT, relative = '') {
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (!relative && entry.name === 'transaction-reset-backups') continue;
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) fail('A data-directory symlink prevents a complete backup.', 409);
    if (entry.isDirectory()) Object.assign(result, await fileManifest(directory, name));
    else if (entry.isFile()) result[name] = await sha256(path.join(directory, name));
    else fail('An unsupported data-directory entry prevents a complete backup.', 409);
  }
  return result;
}

function toolEnvironment(pool = getPostgresPool()) {
  const options = pool.options;
  const url = options.connectionString ? new URL(options.connectionString) : null;
  const env = { ...process.env,
    PGHOST: url ? url.hostname : options.host,
    PGPORT: String(url?.port || options.port || 5432),
    PGDATABASE: url ? decodeURIComponent(url.pathname.slice(1)) : options.database,
    PGUSER: url ? decodeURIComponent(url.username) : options.user,
    PGPASSWORD: url ? decodeURIComponent(url.password) : options.password || '',
    PGSSLMODE: options.ssl ? options.ssl.rejectUnauthorized === false ? 'require' : 'verify-full' : 'disable',
  };
  if (process.env.POSTGRES_SSL_CA_FILE) env.PGSSLROOTCERT = process.env.POSTGRES_SSL_CA_FILE;
  return env;
}

async function tool(command, args, env = process.env) {
  try { return await execFile(command, args, { env, timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 }); }
  catch { fail('Backup verification failed. No transactions were removed. Check backup tools, storage, and database connectivity.', 409); }
}

async function verifyBundle(archive, expectedHash) {
  if (await sha256(archive) !== expectedHash) fail('The backup has changed. Create a new verified backup.', 409);
  const directory = await fs.mkdtemp(path.join(BACKUP_ROOT, 'verify-'));
  try {
    const { stdout } = await tool('tar', ['--list', '--file', archive]);
    if (stdout.trim().split('\n').sort().join(',') !== 'database.dump,files.tar.gz,manifest.json') fail('The backup contents are invalid.', 409);
    await tool('tar', ['--extract', '--file', archive, '--directory', directory, '--no-same-owner', '--no-same-permissions']);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    for (const name of ['database.dump','files.tar.gz']) {
      if (await sha256(path.join(directory, name)) !== manifest.archives[name]) fail('The backup verification failed.', 409);
    }
    await tool('pg_restore', ['--file', '/dev/null', path.join(directory, 'database.dump')]);
    await tool('tar', ['--list', '--gzip', '--file', path.join(directory, 'files.tar.gz')]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function createBackup(user, scope) {
  validateScope(scope);
  const id = crypto.randomUUID();
  const archive = path.join(BACKUP_ROOT, `${id}.tar`);
  await fs.mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(BACKUP_ROOT, 'prepare-'));
  try {
    return await exclusive(async client => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        await requireAdministrator(client, user);
        const tables = await businessTables(client);
        // The maintenance lock drains application writers. An exported repeatable-read
        // snapshot keeps pg_dump consistent; ACCESS SHARE also works for the
        // restricted runtime's read-only inventory tables and blocks schema changes.
        await client.query(`LOCK TABLE ${tables.map(table => `"${table}"`).join(',')} IN ACCESS SHARE MODE`);
        const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
        const counts = await inventory(client, scope);
        const files = await fileManifest();
        const state = await fingerprint(client, tables, files);
        await tool('pg_dump', ['--format=custom', '--snapshot', snapshot, '--file', path.join(directory, 'database.dump')], toolEnvironment());
        await tool('pg_restore', ['--file', '/dev/null', path.join(directory, 'database.dump')]);
        await tool('tar', ['--create', '--gzip', '--file', path.join(directory, 'files.tar.gz'),
          '--exclude=./transaction-reset-backups', '--directory', DATA_ROOT, '.']);
        const afterFiles = await fileManifest();
        if (JSON.stringify(files) !== JSON.stringify(afterFiles)) fail('Files changed during backup. Create a new backup.', 409);
        const manifest = { createdAt: new Date().toISOString(), scope, counts, files, archives: {} };
        for (const name of ['database.dump','files.tar.gz']) manifest.archives[name] = await sha256(path.join(directory, name));
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
        await tool('tar', ['--create', '--file', archive, '--directory', directory, 'database.dump','files.tar.gz','manifest.json']);
        await fs.chmod(archive, 0o600);
        const archiveHash = await sha256(archive);
        await verifyBundle(archive, archiveHash);
        const { rows } = await client.query(`INSERT INTO wm_maintenance_backups
          (id,actor_id,scope,expires_at,counts,fingerprint,archive_sha256)
          VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes',$4::jsonb,$5,$6) RETURNING id,created_at,expires_at`,
          [id,user.id,scope,JSON.stringify(counts),state,archiveHash]);
        await client.query('COMMIT');
        return rows[0];
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  } catch (error) { await fs.rm(archive, { force: true }); throw error; }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function resetTransactions(user, scope, backupId, confirmation, password) {
  validateScope(scope);
  if (confirmation !== 'RESET TRANSACTIONS') fail('Type RESET TRANSACTIONS exactly to confirm.');
  if (!UUID.test(String(backupId))) fail('Create a verified backup before resetting transactions.', 409);
  return exclusive(async client => {
    await client.query('BEGIN');
    try {
      if ((await client.query('SELECT wm_inventory_enabled() AS enabled')).rows[0]?.enabled) fail('Controlled inventory history cannot be reset.',409);
      const actor = await requireAdministrator(client, user);
      if (!await require('./auth').verifyPassword(String(password || ''),actor.password_hash)) fail('Your current administrator password is incorrect.',401);
      const backup = (await client.query(`SELECT * FROM wm_maintenance_backups
        WHERE id=$1 AND actor_id=$2 AND scope=$3 AND consumed_at IS NULL
          AND expires_at>clock_timestamp() FOR UPDATE`, [backupId,user.id,scope])).rows[0];
      if (!backup) fail('The backup is expired, already used, or belongs to another scope or administrator. Create a new backup.', 409);
      const business = await businessTables(client);
      await client.query(`LOCK TABLE ${business.map(table => `"${table}"`).join(',')} IN SHARE MODE`);
      if (await fingerprint(client, business, await fileManifest()) !== backup.fingerprint) fail('Records or files changed after the backup. Create a new verified backup before resetting.', 409);
      await verifyBundle(path.join(BACKUP_ROOT, `${backup.id}.tar`), backup.archive_sha256);
      const counts = await inventory(client, scope);
      const tables = [...GROUPS.flatMap(([, names]) => names), ...RETRY_TABLES, ...SESSION_TABLES,
        ...(scope === 'all' ? [...HR_TABLES, 'app_gl_entries'] : [])];
      // No CASCADE and no sequence restart: masters and old document identities
      // cannot be accidentally removed or reused.
      await client.query(`TRUNCATE ${tables.map(table => `"${table}"`).join(',')} CONTINUE IDENTITY`);
      if (scope === 'financial') await client.query("DELETE FROM app_gl_entries WHERE left(voucher_type,3)<>'hr_'");
      await client.query('UPDATE wm_api_credentials SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL');
      const after = await inventory(client, scope);
      if (Object.values(after).some(group => Object.values(group).some(count => count !== 0))) fail('Reset verification failed. All changes were rolled back.', 409);
      await client.query(`INSERT INTO wm_transaction_resets(actor_id,actor_name,scope,backup_id,counts)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [actor.id,actor.username,scope,backupId,JSON.stringify(counts)]);
      await client.query('UPDATE wm_maintenance_backups SET consumed_at=clock_timestamp() WHERE id=$1', [backupId]);
      await client.query('COMMIT');
      require('./web/cache').clearInvoiceCaches();
      require('./read-cache').clearReadCaches();
      return { counts };
    } catch (error) {
      await client.query('ROLLBACK');
      if (['0A000','23503'].includes(error.code)) fail('Linked records prevent this reset. No records were removed.',409);
      throw error;
    }
  });
}

async function maintenanceView(user, scope, backupId) {
  validateScope(scope);
  const client = await getPostgresPool().connect();
  try {
    await requireAdministrator(client,user);
    const counts = await inventory(client,scope);
    const backup = (await client.query(`SELECT id,created_at,expires_at,consumed_at,scope FROM wm_maintenance_backups
      WHERE actor_id=$1 AND scope=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 1`,
      [user.id,scope,UUID.test(String(backupId)) ? backupId : null])).rows[0] || null;
    const history = (await client.query(`SELECT actor_name,scope,counts,created_at FROM wm_transaction_resets ORDER BY id DESC LIMIT 10`)).rows;
    const inventoryControlled=Boolean((await client.query('SELECT wm_inventory_enabled() AS enabled')).rows[0]?.enabled);
    return { counts, backup, history, scope, inventoryControlled };
  } finally { client.release(); }
}

async function backupDownload(user, id) {
  if (!UUID.test(String(id))) fail('Backup not found.',404);
  await requireAdministrator(getPostgresPool(),user);
  const backup = (await getPostgresPool().query('SELECT id,archive_sha256 FROM wm_maintenance_backups WHERE id=$1 AND actor_id=$2', [id,user.id])).rows[0];
  if (!backup) fail('Backup not found.',404);
  const file = path.join(BACKUP_ROOT, `${id}.tar`);
  await verifyBundle(file,backup.archive_sha256);
  return { file, name: `work-master-backup-${id}.tar` };
}

module.exports = { createBackup, resetTransactions, maintenanceView, backupDownload, inventory, validateScope };
