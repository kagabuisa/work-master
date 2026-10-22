'use strict';
// Only the authenticated web process supplies filters/access; this is not an HTTP API.
const fs = require('node:fs');
const { withGeneralLedgerExport } = require('../domain/ledger');
const { closeStore } = require('../core');
const { writeGeneralLedgerExport } = require('./general-ledger-export');

process.once('disconnect', () => process.exit(1));
process.once('message', async ({ filters, access, format, filename }) => {
  try {
    await withGeneralLedgerExport(filters, access,
      report => writeGeneralLedgerExport(fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }), report, format),
      { resolveVoucherLinks: false });
    await closeStore();
    process.send({ done: true }, () => process.exit(0));
  } catch (error) {
    console.error('ledger_export_worker_error', error.message);
    await closeStore().catch(() => {});
    process.send({ error: 'The export could not be generated. Try a narrower date range or retry.' }, () => process.exit(1));
  }
});
