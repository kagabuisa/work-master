'use strict';

const fs = require('node:fs');

function readSecret(name, env = process.env) {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return String(env[name] || '').trim();
}

module.exports = { readSecret };
