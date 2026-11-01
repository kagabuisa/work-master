'use strict';

const EXCLUDED_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'ERPNEXT_PASSWORD',
  'MONITORING_TOKEN',
  'OPENAI_API_KEY',
  'PGPASSWORD',
  'PGUSER',
  'POSTGRES_PASSWORD',
  'POSTGRES_URL',
  'POSTGRES_USER',
  'WORK_MASTER_TEST_PASSWORD',
  'WORK_MASTER_TEST_USERNAME',
  'github_token',
  'github_username',
]);
const EXCLUDED_PREFIXES = ['AWS_', 'DB_', 'MYSQL_', 'NEW_ERPNEXTV15_'];

function excluded(key) {
  return EXCLUDED_KEYS.has(key) || EXCLUDED_PREFIXES.some(prefix => key.startsWith(prefix));
}

function runtimeEnvironment(source) {
  if (!source.POSTGRES_RUNTIME_URL && !(source.POSTGRES_RUNTIME_USER && source.POSTGRES_RUNTIME_PASSWORD)) {
    throw new Error('Generate and configure POSTGRES_RUNTIME_USER/POSTGRES_RUNTIME_PASSWORD or POSTGRES_RUNTIME_URL first.');
  }
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !excluded(key))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function encodeValue(value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error('Runtime environment values cannot contain newlines.');
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(text) ? text : JSON.stringify(text);
}

function renderEnvironment(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${encodeValue(value)}`).join('\n')}\n`;
}

module.exports = { EXCLUDED_KEYS, excluded, renderEnvironment, runtimeEnvironment };
