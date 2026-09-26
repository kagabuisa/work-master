const { pool } = require('../src/db');
const { initStore, updateMasterRecord } = require('../src/store');
require('dotenv').config({ quiet: true });

function textValue(value) {
  return String(value || '').trim();
}

async function importEmployees() {
  await initStore();
  const [employees] = await pool.query(`
    SELECT
      name AS employee_id,
      employee_name,
      status,
      company,
      department,
      designation,
      COALESCE(cell_number, emergency_phone_number, '') AS phone,
      COALESCE(company_email, personal_email, user_id, '') AS email
    FROM \`tabEmployee\`
    ORDER BY employee_name, name
  `);

  let imported = 0;
  let active = 0;
  for (const employee of employees) {
    const isActive = employee.status === 'Active';
    await updateMasterRecord('employees', employee.employee_id, {
      employee_name: employee.employee_name || employee.employee_id,
      status: employee.status || '',
      company: textValue(employee.company),
      department: textValue(employee.department),
      designation: textValue(employee.designation),
      phone: textValue(employee.phone),
      email: textValue(employee.email),
      disabled: isActive ? '0' : '1',
    });
    imported += 1;
    if (isActive) {
      active += 1;
    }
  }

  console.log(JSON.stringify({
    postgres: {
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      table: 'public.app_master_employees',
    },
    mysql_rows: employees.length,
    active,
    imported,
  }, null, 2));
}

importEmployees()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
