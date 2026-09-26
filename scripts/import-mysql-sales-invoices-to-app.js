const { pool: mysqlPool } = require('../src/db');
const { closeStore } = require('../src/store');
const { DEFAULT_IMPORT_FROM, importSalesInvoicesFromMysql } = require('../src/sales-invoice-importer');
require('dotenv').config({ quiet: true });

function importFromDate() {
  const cliFrom = process.argv.find((arg) => arg.startsWith('--from='));
  return String(
    (cliFrom && cliFrom.slice('--from='.length))
      || process.env.SALES_INVOICE_IMPORT_FROM
      || DEFAULT_IMPORT_FROM,
  ).trim();
}

importSalesInvoicesFromMysql({ from: importFromDate() })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mysqlPool.end().catch(() => {});
    await closeStore().catch(() => {});
  });
