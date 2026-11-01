'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { renderEnvironment, runtimeEnvironment } = require('../src/runtime-environment');

const root = path.resolve(__dirname, '..');

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function existingSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function main() {
  const sourceFile = path.resolve(process.env.RUNTIME_ENV_SOURCE || path.join(root, '.env'));
  const outputFile = path.resolve(process.env.RUNTIME_ENV_FILE || path.join(root, 'runtime.env'));
  const secretDir = path.resolve(process.env.RUNTIME_SECRET_DIR || path.join(root, '.runtime'));
  const source = dotenv.parse(fs.readFileSync(sourceFile, 'utf8'));
  const runtime = runtimeEnvironment(source);
  const monitoringFile = path.join(secretDir, 'monitoring_token');
  const openAiFile = path.join(secretDir, 'openai_api_key');
  const erpnextFile = path.join(secretDir, 'erpnext_password');
  const secrets = {
    monitoring_token: source.MONITORING_TOKEN?.trim()
      || existingSecret(monitoringFile)
      || crypto.randomBytes(32).toString('base64url'),
    openai_api_key: source.OPENAI_API_KEY?.trim() || existingSecret(openAiFile),
    erpnext_password: source.ERPNEXT_PASSWORD?.trim() || existingSecret(erpnextFile),
  };
  writePrivate(outputFile, renderEnvironment(runtime));
  for (const [name, value] of Object.entries(secrets)) writePrivate(path.join(secretDir, name), `${value}\n`);
  console.log(JSON.stringify({
    event: 'runtime_environment_prepared',
    runtime_keys: Object.keys(runtime).length,
    secret_files: Object.keys(secrets),
  }));
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { existingSecret, main, writePrivate };
