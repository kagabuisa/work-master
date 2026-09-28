const { pool: mysqlPool } = require('../src/db');
const { initStore, closeStore } = require('../src/store');
const { importItemPricesFromMysql } = require('../src/item-price-importer');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await initStore();
  const summary = await importItemPricesFromMysql({
    dryRun,
    onProgress: ({ processed, total }) => {
      if (processed === total || processed % 5000 === 0) console.log(`Imported ${processed}/${total} item prices`);
    },
  });
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    await mysqlPool.end().catch(() => {});
    await closeStore().catch(() => {});
  });
