const bcrypt = require('bcrypt');

const WORK_FACTOR = 12;

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }

  return bcrypt.hash(password, WORK_FACTOR);
}

async function verifyPassword(password, passwordHash) {
  if (typeof password !== 'string' || typeof passwordHash !== 'string') {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}

module.exports = { hashPassword, verifyPassword };
