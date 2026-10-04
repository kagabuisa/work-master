const crypto = require('node:crypto');
const { initStore } = require('../src/store');
const { createUser, resetUserPassword } = require('../src/auth');
require('dotenv').config({ quiet: true });

async function main() {
  const username = process.argv[2];
  if (!username || process.argv.length > 3) {
    console.error('Usage: npm run user:reset -- <username>');
    process.exitCode = 1;
    return;
  }
  await initStore();
  const password = crypto.randomBytes(24).toString('base64url');
  let action = 'Reset password for';
  try {
    await resetUserPassword(username, password);
  } catch (error) {
    if (error.status !== 404) throw error;
    await createUser(username, password, { mustChangePassword: true, role: username.trim().toLowerCase() === 'admin' ? 'admin' : undefined });
    action = 'Created user';
  }
  console.log(`${action}: ${username.trim().toLowerCase()}`);
  console.log(`Temporary password: ${password}`);
  console.log('All previous sessions were revoked. Change this password at next login.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
