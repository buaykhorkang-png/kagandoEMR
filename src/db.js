const { Pool } = require('pg');

const requiredVariables = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  throw new Error(`Missing required database configuration: ${missingVariables.join(', ')}`);
}

if (process.env.NODE_ENV === 'production' && process.env.DB_SSL !== 'true') {
  throw new Error('DB_SSL must be enabled in production.');
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', () => {
  console.error('Unexpected PostgreSQL pool error.');
});

module.exports = pool;
