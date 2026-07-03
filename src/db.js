const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

function sslConfig() {
  const value = String(process.env.DB_SSL || '').toLowerCase();
  return ['1', 'true', 'required', 'yes'].includes(value)
    ? { rejectUnauthorized: false }
    : undefined;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: sslConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});

module.exports = {
  pool,
};
