'use strict';
process.env.INVOICE_STORE = process.env.INVOICE_STORE || 'postgres';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '55432';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'work_master_golden';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || '';

import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const { seedGoldenData } = require2('../tests/helpers/golden-seed');
const store = require2('../src/store');

seedGoldenData()
  .then(async (summary) => {
    console.log('seeded:', JSON.stringify(summary));
    await store.closeStore();
    process.exit(0);
  })
  .catch((err) => { console.error(err.stack || err); process.exit(1); });
