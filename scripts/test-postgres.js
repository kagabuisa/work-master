'use strict';

require('dotenv').config({ quiet: true });
const { spawnSync } = require('node:child_process');
const { getPostgresPool, closeStore } = require('../src/core');

async function main() {
  const pool = getPostgresPool();
  try {
    const { rows } = await pool.query(`SELECT current_database() AS name,
      pg_has_role(nspowner, 'MEMBER') AS owns_public_schema,
      has_database_privilege(current_database(), 'CREATE') AS can_create_schema
      FROM pg_namespace WHERE nspname = 'public'`);
    const database = rows[0];
    if (!database || !/_hr_test$/.test(database.name)) {
      throw new Error('Full PostgreSQL tests require a dedicated *_hr_test database; its public schema will be reset.');
    }
    if (!database.owns_public_schema || !database.can_create_schema) {
      throw new Error('The test user must own the public schema and have CREATE on the dedicated test database.');
    }
  } finally {
    await closeStore();
  }

  const env = { ...process.env };
  for (const area of ['ACCOUNTING', 'AUDIT', 'DEBTOR', 'GL_EXPORT', 'GOLDEN', 'HR',
    'ITEM_DETAILS', 'JOURNAL', 'PRICING', 'RECONCILIATION', 'SCHEMA']) {
    env[`${area}_TEST_POSTGRES`] = '1';
  }
  const files = require('../package.json').scripts.test.split(/\s+/).slice(2);
  // Several integration tests reset public. Run files sequentially so their
  // schema resets and fixtures cannot interfere with another test file.
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files],
    { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
