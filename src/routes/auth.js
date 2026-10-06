const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { hashPassword, verifyPassword } = require('../security/passwords');
const { cleanText } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');
const { getPermissions } = require('../middleware/auth');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' }
});
const registrationRoles = ['clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory'];

router.get('/registration-options', async (req, res) => {
  const result = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'administrator') AS has_administrator"
  );
  return res.json({ administratorRegistrationAvailable: !result.rows[0].has_administrator });
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
}

router.post('/register', registrationLimiter, async (req, res) => {
  const username = cleanText(req.body && req.body.username, 80, { required: true });
  const password = req.body && req.body.password;
  const requestedRole = req.body && req.body.requestedRole;
  const initialAdministrator = requestedRole === 'administrator';
  const minimumLength = initialAdministrator ? 10 : 12;
  if (!username || !/^[a-zA-Z0-9._@-]{3,80}$/.test(username) ||
      typeof password !== 'string' || password.length < minimumLength || password.length > 128 ||
      !(registrationRoles.includes(requestedRole) || initialAdministrator)) {
    return res.status(400).json({ error: `Enter a valid username, ${minimumLength}-128 character password, and requested role.` });
  }

  const passwordHash = password.length < 12
    ? await bcrypt.hash(password, 12)
    : await hashPassword(password);
  try {
    const user = await withTransaction(async (client) => {
      if (initialAdministrator) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [771234]);
        const existingAdministrator = await client.query(
          "SELECT id FROM users WHERE role = 'administrator' LIMIT 1"
        );
        if (existingAdministrator.rowCount) {
          const error = new Error('The one-time administrator registration has already been used.');
          error.code = 'ADMIN_REGISTRATION_CLOSED';
          throw error;
        }

        const result = await client.query(
          `INSERT INTO users (username, password_hash, role, approval_status, must_change_password, is_active)
           VALUES ($1, $2, 'administrator', 'approved', TRUE, TRUE)
           RETURNING id`,
          [username, passwordHash]
        );
        await recordAudit(client, {
          action: 'admin.initial_registration',
          resourceType: 'user',
          resourceId: result.rows[0].id
        });
        return result.rows[0];
      }

      const result = await client.query(
        `INSERT INTO users (username, password_hash, role, requested_role, approval_status, is_active)
         VALUES ($1, $2, 'clerk', $3, 'pending', FALSE)
         RETURNING id`,
        [username, passwordHash, requestedRole]
      );
      await recordAudit(client, {
        action: 'auth.registration_requested',
        resourceType: 'user',
        resourceId: result.rows[0].id
      });
      return result.rows[0];
    });
    if (initialAdministrator) {
      return res.status(201).json({
        status: 'approved',
        message: 'Initial administrator created. Sign in and change the temporary password before continuing.'
      });
    }
    return res.status(202).json({ status: 'pending', message: 'Registration received. An administrator must approve your account and assign your role before sign-in.' });
  } catch (error) {
    if (error.code === 'ADMIN_REGISTRATION_CLOSED') {
      return res.status(409).json({ error: 'The one-time administrator registration has already been used.' });
    }
    if (error.code === '23505') return res.status(409).json({ error: 'Username is already in use.' });
    throw error;
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || username.length > 80 ||
      typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Invalid username or password.' });
  }

  const normalizedUsername = username.trim();
  if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(normalizedUsername)) {
    return res.status(400).json({ error: 'Invalid username or password.' });
  }

  const result = await pool.query(
    `SELECT id, username, password_hash, role, must_change_password
     FROM users
     WHERE username = $1 AND is_active = TRUE`,
    [normalizedUsername]
  );
  const user = result.rows[0];
  const valid = user && await verifyPassword(password, user.password_hash);

  if (!valid) {
    await withTransaction((client) => recordAudit(client, {
      action: 'auth.login_failed',
      resourceType: 'user'
    }));
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  await withTransaction((client) => recordAudit(client, {
    actorId: user.id,
    action: 'auth.login_succeeded',
    resourceType: 'user',
    resourceId: user.id
  }));

  await regenerateSession(req);
  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.must_change_password
  };

  return res.json({ user: { ...req.session.user, permissions: await getPermissions(user.id, user.role) } });
});

router.get('/me', async (req, res) => {
  if (!req.session.user) {
    return res.json({ user: null });
  }

  const result = await pool.query(
    `SELECT id, username, role, must_change_password
     FROM users WHERE id = $1 AND is_active = TRUE`,
    [req.session.user.id]
  );
  if (!result.rowCount) {
    await destroySession(req);
    return res.json({ user: null });
  }
  const account = result.rows[0];
  req.session.user = {
    id: account.id,
    username: account.username,
    role: account.role,
    mustChangePassword: account.must_change_password
  };
  return res.json({
    user: { ...req.session.user, permissions: await getPermissions(account.id, account.role) }
  });
});

router.post('/change-password', async (req, res) => {
  const currentUser = req.session.user;
  const password = req.body && req.body.password;
  if (!currentUser) return res.status(401).json({ error: 'Authentication required.' });
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'New password must be between 12 and 128 characters.' });
  }

  const passwordHash = await hashPassword(password);
  const updated = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE
       WHERE id = $2 AND is_active = TRUE AND must_change_password = TRUE
       RETURNING id`,
      [passwordHash, currentUser.id]
    );
    if (!result.rowCount) return false;
    await recordAudit(client, {
      actorId: currentUser.id,
      action: 'auth.initial_password_changed',
      resourceType: 'user',
      resourceId: currentUser.id
    });
    return true;
  });

  if (!updated) return res.status(409).json({ error: 'Password change is not required for this account.' });
  req.session.user.mustChangePassword = false;
  return res.json({
    user: {
      ...req.session.user,
      permissions: await getPermissions(req.session.user.id, req.session.user.role)
    }
  });
});

router.post('/logout', async (req, res) => {
  if (req.session.user) {
    await withTransaction((client) => recordAudit(client, {
      actorId: req.session.user.id,
      action: 'auth.logout',
      resourceType: 'user',
      resourceId: req.session.user.id
    }));
  }

  await destroySession(req);
  res.clearCookie('kagando.sid', { path: '/', sameSite: 'strict', httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  return res.status(204).end();
});

module.exports = router;
