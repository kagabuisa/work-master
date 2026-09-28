const { pool: mysqlPool } = require('../src/db');
const { initStore, closeStore } = require('../src/store');
const { importPriceListsFromMysql } = require('../src/price-list-importer');

async function main() {
  await initStore();
  console.log(JSON.stringify(await importPriceListsFromMysql(), null, 2));
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    await mysqlPool.end().catch(() => {});
    await closeStore().catch(() => {});
  });
