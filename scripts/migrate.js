require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/db');

async function migrate() {
  const schema = await fs.readFile(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema applied.');
}

migrate()
  .catch(() => {
    console.error('Database migration failed. Check the database configuration and schema.');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
