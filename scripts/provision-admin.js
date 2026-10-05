require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const bcrypt = require('bcrypt');
const pool = require('../src/db');
const { recordAudit } = require('../src/services/audit');

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('Run this command in an interactive terminal.'));
      return;
    }

    stdout.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function finish(error) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function onData(key) {
      if (key === '\u0003') return finish(new Error('Cancelled.'));
      if (key === '\r' || key === '\n') return finish();
      if (key === '\u007f' || key === '\b') value = value.slice(0, -1);
      else if (key >= ' ' && key <= '~') value += key;
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let username;
  try {
    username = (await terminal.question('Administrator username: ')).trim();
  } finally {
    terminal.close();
  }

  const password = await readHidden('Temporary password (input hidden; it must be changed at first sign-in): ');
  if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(username) || password.length < 10 || password.length > 128) {
    throw new Error('Username is invalid or the temporary password is outside the allowed length.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(771234)');
    const activeAdmin = await client.query(
      "SELECT id FROM users WHERE role = 'administrator' AND is_active = TRUE LIMIT 1 FOR UPDATE"
    );
    if (activeAdmin.rowCount) throw new Error('An active administrator already exists.');

    const created = await client.query(
      `INSERT INTO users (username, password_hash, role, approval_status, must_change_password, is_active)
       VALUES ($1, $2, 'administrator', 'approved', TRUE, TRUE)
       RETURNING id`,
      [username, passwordHash]
    );
    await recordAudit(client, {
      action: 'admin.bootstrap_created',
      resourceType: 'user',
      resourceId: created.rows[0].id
    });
    await client.query('COMMIT');
    console.log('Temporary administrator account created. Change the password at first sign-in.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error.code === '23505' ? 'That username is already in use.' : error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
