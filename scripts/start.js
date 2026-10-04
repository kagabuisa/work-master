const net = require('node:net');
const { spawnSync } = require('node:child_process');

require('dotenv').config({ quiet: true });

function localPostgresEndpoint(env = process.env) {
  let host = env.PGHOST || env.POSTGRES_HOST || 'localhost';
  let port = Number(env.PGPORT || env.POSTGRES_PORT || 5432);
  const connectionString = env.POSTGRES_URL || env.DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    host = url.hostname;
    port = Number(url.port || 5432);
  }

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return null;
  return { host, port };
}

function acceptsConnections(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function startLocalPostgresIfNeeded() {
  const endpoint = localPostgresEndpoint();
  if (!endpoint || await acceptsConnections(endpoint.host, endpoint.port)) return;

  console.log('Local PostgreSQL is stopped; starting it now.');
  const result = spawnSync('service', ['postgresql', 'start'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error('Could not start local PostgreSQL. Run "sudo service postgresql start" or configure a running database.');
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await acceptsConnections(endpoint.host, endpoint.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Local PostgreSQL did not become available on ${endpoint.host}:${endpoint.port}.`);
}

async function main() {
  await startLocalPostgresIfNeeded();
  require('../server');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { localPostgresEndpoint, startLocalPostgresIfNeeded };
