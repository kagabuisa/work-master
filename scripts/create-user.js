const crypto = require('node:crypto');
const { initStore } = require('../src/store');
const { initAuth, createUser } = require('../src/auth');
require('dotenv').config({ quiet: true });

async function main() {
  const username = process.argv[2];
  const role = process.argv[3];
  if (!username || process.argv.length > 4) {
    console.error('Usage: npm run user:create -- <username> [standard|privileged|admin]');
    process.exitCode = 1;
    return;
  }
  await initStore();
  await initAuth();
  const password = crypto.randomBytes(24).toString('base64url');
  const user = await createUser(username, password, { mustChangePassword: true, role });
  console.log(`Created user: ${user.username} (${user.role})`);
  console.log(`Temporary password: ${password}`);
  console.log('The user must change this password at first login. Store it securely; it will not be shown again.');
}

main().catch((error) => {
  console.error(error.code === '23505' ? 'Username already exists.' : error.message);
  process.exitCode = 1;
});
