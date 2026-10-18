'use strict';
// Shared Postgres infrastructure: pool lifecycle, store-mode check, and the
// transaction helper. Domain modules depend on this core instead of importing it
// back out of store.js, which keeps the require graph acyclic.

const { invalidateFinancialReads, clearReadCaches } = require('./read-cache');
const { postingStage } = require('./workload-control');
const { AuditPool } = require('./audit');
const { databaseTls } = require('./database-tls');
const { types } = require('pg');

// A PostgreSQL DATE is a calendar day, not a timestamp at local midnight.
// Keep it as text so converting it to UTC cannot move postings to the day before.
const calendarDateTypes = {
  getTypeParser(oid, format) {
    if (oid === types.builtins.DATE && format !== 'binary') return (value) => value;
    return types.getTypeParser(oid, format);
  },
};

let postgresPool;
let poolMetricsTimer;

function poolInteger(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) {
    throw new Error(`${name} must be an integer between ${minimum} and 2147483647.`);
  }
  return value;
}

function postgresPoolOptions() {
  return {
    max: poolInteger('POSTGRES_POOL_MAX', 10, 1),
    connectionTimeoutMillis: poolInteger('POSTGRES_CONNECTION_TIMEOUT_MS', 10000),
    // Opt in: long imports, exports and migrations share this pool.
    statement_timeout: poolInteger('POSTGRES_STATEMENT_TIMEOUT_MS', 0),
    idleTimeoutMillis: poolInteger('POSTGRES_IDLE_TIMEOUT_MS', 30000),
  };
}

function postgresPoolMetrics() {
  return { total: postgresPool?.totalCount || 0, idle: postgresPool?.idleCount || 0,
    waiting: postgresPool?.waitingCount || 0 };
}

function postgresSslConfig() {
  return databaseTls(process.env.PGSSL || process.env.POSTGRES_SSL, process.env.POSTGRES_SSL_CA_FILE);
}

function postgresHost() {
  const host = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
  return host === 'localhost' ? '127.0.0.1' : host;
}

function getPostgresPool() {
  if (!postgresPool) {
    let connectionString = process.env.POSTGRES_RUNTIME_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if(connectionString && process.env.POSTGRES_RUNTIME_USER && !process.env.POSTGRES_RUNTIME_URL){
      const runtimeUrl=new URL(connectionString);runtimeUrl.username=process.env.POSTGRES_RUNTIME_USER;runtimeUrl.password=process.env.POSTGRES_RUNTIME_PASSWORD||'';connectionString=runtimeUrl.toString();
    }
    const metricsInterval = poolInteger('POSTGRES_POOL_METRICS_MS', 0);
    const options = postgresPoolOptions();
    postgresPool = new AuditPool(connectionString ? {
      ...options,
      connectionString,
      types: calendarDateTypes,
      ssl: postgresSslConfig(),
    } : {
      ...options,
      host: postgresHost(),
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_RUNTIME_USER || process.env.PGUSER || process.env.POSTGRES_USER,
      password: process.env.POSTGRES_RUNTIME_PASSWORD || process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      types: calendarDateTypes,
      ssl: postgresSslConfig(),
    });
    if (metricsInterval > 0) {
      poolMetricsTimer = setInterval(() => {
        const { total, idle, waiting } = postgresPoolMetrics();
        console.info(`postgres_pool total=${total} idle=${idle} waiting=${waiting}`);
        console.info(JSON.stringify({ event: 'workload_capacity', at: new Date().toISOString(), pool: {total,idle,waiting}, ...require('./workload-control').workloadMetrics(), sharing:require('./read-cache').readSharingMetrics(postgresPool) }));
      }, metricsInterval);
      poolMetricsTimer.unref();
    }
  }
  return postgresPool;
}

async function closeStore() {
  clearReadCaches();
  clearInterval(poolMetricsTimer);
  poolMetricsTimer = null;
  if (postgresPool) {
    await postgresPool.end();
    postgresPool = null;
  }
}

async function withPostgresTransaction(callback, { invalidate, inventoryExclusive = false } = {}) {
  const pool = getPostgresPool();
  const client = await postingStage('connection_wait', () => pool.connect());
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query(inventoryExclusive ? 'SELECT pg_advisory_xact_lock(1776342162)' : 'SELECT pg_advisory_xact_lock_shared(1776342162)');
    await require('./services/inventory-posting').loadTransactionMode(client);
    const result = await callback(client);
    await postingStage('commit', () => client.query('COMMIT'));
    invalidateFinancialReads(pool, invalidate);
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
    if (err.code === 'P0001' && /^future_posting_date:/.test(err.message)) {
      err.code = 'future_posting_date'; err.status = 400;
    }
    if (err.code === 'P0001') {
      const match = /^((?:inventory_|warehouse_count_|count_|correction_|closed_|invalid_count|invalid_correction)[a-z_]*):/.exec(err.message);
      if (match) {
        err.code=match[1];err.status=err.code==='inventory_permission_denied'?403:err.code==='insufficient_stock'?422:409;
      } else if (/^insufficient_stock:/.test(err.message)) { err.code='insufficient_stock';err.status=422; }
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

module.exports = {
  getPostgresPool,
  postgresPoolOptions,
  postgresPoolMetrics,
  postgresHost,
  postgresSslConfig,
  closeStore,
  withPostgresTransaction,
};
