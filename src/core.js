'use strict';
// Shared Postgres infrastructure: pool lifecycle, store-mode check, and the
// transaction helper. Domain modules depend on this core instead of importing it
// back out of store.js, which keeps the require graph acyclic.

const { AuditPool } = require('./audit');

let postgresPool;

function postgresSslConfig() {
  const value = String(process.env.PGSSL || process.env.POSTGRES_SSL || '').toLowerCase();
  return ['1', 'true', 'required', 'yes'].includes(value)
    ? { rejectUnauthorized: false }
    : undefined;
}

function postgresHost() {
  const host = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
  return host === 'localhost' ? '127.0.0.1' : host;
}

function getPostgresPool() {
  if (!postgresPool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    postgresPool = new AuditPool(connectionString ? {
      connectionString,
      ssl: postgresSslConfig(),
    } : {
      host: postgresHost(),
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      ssl: postgresSslConfig(),
    });
  }
  return postgresPool;
}

async function closeStore() {
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
  postgresHost,
  postgresSslConfig,
  closeStore,
  withPostgresTransaction,
};
