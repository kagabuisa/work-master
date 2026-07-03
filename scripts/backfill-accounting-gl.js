const { initStore, backfillAccountingGl } = require('../src/store');

async function main() {
  await initStore();
  const result = await backfillAccountingGl();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
