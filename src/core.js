'use strict';
// Shared Postgres infrastructure: pool lifecycle, store-mode check, and the
// transaction helper. Domain modules depend on this core instead of importing it
// back out of store.js, which keeps the require graph acyclic.

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
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
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
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      types: calendarDateTypes,
      ssl: postgresSslConfig(),
    });
    if (metricsInterval > 0) {
      poolMetricsTimer = setInterval(() => {
        const { total, idle, waiting } = postgresPoolMetrics();
        console.info(`postgres_pool total=${total} idle=${idle} waiting=${waiting}`);
      }, metricsInterval);
      poolMetricsTimer.unref();
    }
  }
  return postgresPool;
}

async function closeStore() {
  clearInterval(poolMetricsTimer);
  poolMetricsTimer = null;
  if (postgresPool) {
    await postgresPool.end();
    postgresPool = null;
  }
}

async function withPostgresTransaction(callback) {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
