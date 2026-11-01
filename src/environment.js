'use strict';
const path = require('node:path');

let runtimeMode = false;

function selectedDatabase(env) {
  let database = env.PGDATABASE || env.POSTGRES_DB || '';
  const url = env.POSTGRES_RUNTIME_URL || env.POSTGRES_URL || env.DATABASE_URL;
  if (url) {
    try { database = decodeURIComponent(new URL(url).pathname.slice(1)); } catch { /* retain lexical value */ }
  }
  return database;
}

function loadRuntimeEnvironment(env = process.env) {
  runtimeMode = true;
  if (/_hr_test$/.test(selectedDatabase(env))) return;
  require('dotenv').config({
    path: env.RUNTIME_ENV_FILE || path.join(__dirname, '..', 'runtime.env'),
    quiet: true,
  });
}

function loadEnvironment() {
  if (runtimeMode) return;
  const database = selectedDatabase(process.env);
  // Isolated integration runners explicitly supply their database. Never mix
  // application runtime credentials or its .env into that test environment.
  if(/_hr_test$/.test(database))return;
  require('dotenv').config({quiet:true});
}

module.exports={loadEnvironment,loadRuntimeEnvironment,selectedDatabase};
