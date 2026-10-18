'use strict';
require('../src/environment').loadEnvironment();
const { withPostgresTransaction, closeStore } = require('../src/core');

async function main() {
  // Refresh-token history remains for the full family lifetime, preserving
  // replay detection. Financial audit and payment references are never purged.
  await withPostgresTransaction(async client => {
    await client.query('DELETE FROM wm_api_idempotency WHERE expires_at<=now()');
    await client.query('DELETE FROM wm_api_rate_limits WHERE reset_at<=now()');
    await client.query(`DELETE FROM wm_api_refresh_tokens WHERE session_id IN
      (SELECT id FROM wm_api_sessions WHERE expires_at<=now())`);
    await client.query('DELETE FROM wm_api_sessions WHERE expires_at<=now()');
  });
  console.log('Expired API retries, rate windows and mobile sessions removed.');
}
main().catch(() => { console.error('API cleanup failed.'); process.exitCode = 1; }).finally(closeStore);
