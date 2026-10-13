'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { headers } = require('../scripts/staging/tls-proxy');
const { guard } = require('../scripts/staging/seed');

test('staging proxy removes hop headers and connection-nominated headers without leaking proxy credentials', () => {
  const result = headers({ connection: 'keep-alive, x-private-hop', 'keep-alive': 'timeout=5',
    'x-private-hop': 'secret-hop', 'proxy-authorization': 'secret-proxy', 'transfer-encoding': 'chunked',
    authorization: 'Bearer forwarded-to-fixed-app', 'content-type': 'application/json', 'content-length': '2' });
  assert.deepEqual(result, { authorization: 'Bearer forwarded-to-fixed-app', 'content-type': 'application/json', 'content-length': '2' });
});

test('staging bootstrap/check guard rejects application and routine test databases even with a staging flag', async () => {
  const previous = process.env.API_STAGING;
  const pool = name => ({ query: async () => ({ rows: [{ name }] }) });
  try {
    process.env.API_STAGING = '1';
    await guard(pool('work_master_api_staging'));
    for (const name of ['work_master', 'work_master_hr_test', 'work_master_restore_hr_test']) await assert.rejects(guard(pool(name)));
    process.env.API_STAGING = '0'; await assert.rejects(guard(pool('work_master_api_staging')));
  } finally { if (previous === undefined) delete process.env.API_STAGING; else process.env.API_STAGING = previous; }
});
