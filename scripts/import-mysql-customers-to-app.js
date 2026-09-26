const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function phoneValue(value) {
  return String(value || '').trim();
}

async function importCustomers() {
  await initStore();
  const [customers] = await pool.query(`
    SELECT
      c.name AS customer_id,
      c.customer_name,
      c.customer_group,
      c.territory,
      COALESCE(contact.mobile_no, contact.phone, '') AS phone,
      COALESCE(c.disabled, 0) AS disabled
    FROM \`tabCustomer\` c
    LEFT JOIN (
      SELECT customer, MAX(mobile_no) AS mobile_no, MAX(phone) AS phone
      FROM \`tabContact\`
      WHERE customer IS NOT NULL
        AND customer <> ''
      GROUP BY customer
    ) contact ON contact.customer = c.name
    ORDER BY c.name
  `);

  let imported = 0;
  for (const customer of customers) {
    await updateMasterRecord('customers', customer.customer_id, {
      customer_name: customer.customer_name || customer.customer_id,
      customer_group: customer.customer_group || '',
      territory: customer.territory || '',
      phone: phoneValue(customer.phone),
      disabled: String(Number(customer.disabled || 0) ? 1 : 0),
    });
    imported += 1;
  }

  console.log(JSON.stringify({
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      table: 'public.app_master_customers',
    },
    mysql_rows: customers.length,
    imported,
  }, null, 2));
}

importCustomers()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
