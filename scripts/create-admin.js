require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const pool = require('../src/db');
const { hashPassword } = require('../src/security/passwords');
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
      if (key === '\u007f' || key === '\b') {
        value = value.slice(0, -1);
      } else if (key >= ' ' && key <= '~') {
        value += key;
      }
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    const username = (await terminal.question('Administrator username: ')).trim();
    terminal.close();
    const password = await readHidden('Administrator password (input hidden): ');
    if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(username) || password.length < 12 || password.length > 128) {
      throw new Error('Username or password does not meet the required format.');
    }

    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(771234)');
      const existing = await client.query("SELECT 1 FROM users WHERE role = 'administrator' AND is_active = TRUE LIMIT 1");
      if (existing.rowCount) throw new Error('An active administrator already exists; use the admin interface instead.');
      const result = await client.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, 'administrator')
         RETURNING id`,
        [username, passwordHash]
      );
      await recordAudit(client, {
        action: 'admin.bootstrap_created',
        resourceType: 'user',
        resourceId: result.rows[0].id
      });
      await client.query('COMMIT');
      console.log('Administrator account created.');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    terminal.close();
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
