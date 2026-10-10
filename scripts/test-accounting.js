'use strict';

const { spawnSync } = require('node:child_process');
require('dotenv').config({ quiet: true });
const { getPostgresPool, closeStore } = require('../src/core');

async function main() {
  const { rows } = await getPostgresPool().query('SELECT current_database() AS name');
  const database = String(rows[0].name);
  if (!/(_golden|_test)$/.test(database)) {
    throw new Error(`Accounting tests refuse to reset database "${database}". Use a dedicated *_golden or *_test database.`);
  }
  const { rows: schemaRows } = await getPostgresPool().query(`
    SELECT pg_has_role(nspowner, 'MEMBER') AS owns_public_schema,
      has_database_privilege(current_database(), 'CREATE') AS can_create_schema
    FROM pg_namespace WHERE nspname = 'public'
  `);
  if (!schemaRows[0]?.owns_public_schema || !schemaRows[0]?.can_create_schema) {
    throw new Error(`The test user must own the public schema and have CREATE on database "${database}". `
      + 'As a database administrator, grant ownership of the dedicated test database and run '
      + 'ALTER SCHEMA public OWNER TO <test_user> in that database.');
  }
  await closeStore();

  const env = {
    ...process.env,
    GOLDEN_TEST_POSTGRES: '1',
    ACCOUNTING_TEST_POSTGRES: '1',
    SCHEMA_TEST_POSTGRES: '1',
    RECONCILIATION_TEST_POSTGRES: '1',
    ITEM_DETAILS_TEST_POSTGRES: '1',
    JOURNAL_TEST_POSTGRES: '1',
  };
  for (const file of ['tests/schema-migration.test.js', 'tests/golden-accounting.test.js', 'tests/accounting-release.test.js', 'tests/stock-reconciliation-postgres.test.js', 'tests/invoice-item-details-postgres.test.js', 'tests/journal-purchase-allocations.test.js']) {
    const result = spawnSync(process.execPath, ['--test', file], { env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      return;
    }
  }
}

main().catch(async (error) => {
  await closeStore();
  console.error(error.message);
  process.exitCode = 1;
});
