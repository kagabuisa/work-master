const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const outPath = path.join(__dirname, '..', 'audits', 'old-master-data-phase1.json');

function sslConfig() {
  return ['1', 'true', 'required', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;
}

async function rows(conn, table, orderBy = 'name') {
  const [exists] = await conn.query(
    'select count(*) n from information_schema.tables where table_schema = database() and table_name = ?',
    [`tab${table}`],
  );
  if (!exists[0].n) return [];
  const [data] = await conn.query(`select * from \`tab${table}\` order by ${orderBy}`);
  return data;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });

  const data = {
    generated_at: new Date().toISOString(),
    phase: 'master-data-phase1',
    doctypes: {
      Company: await rows(conn, 'Company'),
      Currency: await rows(conn, 'Currency'),
      'Fiscal Year': await rows(conn, 'Fiscal Year', 'year_start_date, name'),
      UOM: await rows(conn, 'UOM'),
      Brand: await rows(conn, 'Brand'),
      Branch: await rows(conn, 'Branch'),
      'Warehouse Type': await rows(conn, 'Warehouse Type'),
      'Item Group': await rows(conn, 'Item Group', 'lft, name'),
      'Price List': await rows(conn, 'Price List'),
      'Cost Center': await rows(conn, 'Cost Center', 'lft, name'),
      Warehouse: await rows(conn, 'Warehouse', 'name'),
      Account: await rows(conn, 'Account', 'lft, name'),
    },
  };

  data.counts = Object.fromEntries(
    Object.entries(data.doctypes).map(([doctype, values]) => [doctype, values.length]),
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);
  await conn.end();

  console.log(JSON.stringify(data.counts, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
