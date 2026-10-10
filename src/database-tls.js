'use strict';
const fs = require('node:fs');

function databaseTls(value, caFile) {
  if (!['1', 'true', 'required', 'require', 'verify-ca', 'verify-full', 'yes'].includes(String(value || '').toLowerCase())) return undefined;
  return { rejectUnauthorized: true, ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}) };
}

module.exports = { databaseTls };
