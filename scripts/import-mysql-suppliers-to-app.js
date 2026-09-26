const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function phoneValue(value) {
  return String(value || '').trim();
}

async function importSuppliers() {
  await initStore();
  const [suppliers] = await pool.query(`
    SELECT
      s.name AS supplier_id,
      s.supplier_name,
      s.supplier_type,
      COALESCE(contact.mobile_no, contact.phone, '') AS phone,
      COALESCE(s.disabled, 0) AS disabled
    FROM \`tabSupplier\` s
    LEFT JOIN (
      SELECT supplier, MAX(mobile_no) AS mobile_no, MAX(phone) AS phone
      FROM \`tabContact\`
      WHERE supplier IS NOT NULL
        AND supplier <> ''
      GROUP BY supplier
    ) contact ON contact.supplier = s.name
    ORDER BY s.name
  `);

  let imported = 0;
  for (const supplier of suppliers) {
    await updateMasterRecord('suppliers', supplier.supplier_id, {
      supplier_name: supplier.supplier_name || supplier.supplier_id,
      supplier_type: supplier.supplier_type || '',
      phone: phoneValue(supplier.phone),
      disabled: String(Number(supplier.disabled || 0) ? 1 : 0),
    });
    imported += 1;
  }

  console.log(JSON.stringify({
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      table: 'public.app_master_suppliers',
    },
    mysql_rows: suppliers.length,
    imported,
  }, null, 2));
}

importSuppliers()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
