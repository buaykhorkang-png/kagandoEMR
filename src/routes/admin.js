const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { hashPassword } = require('../security/passwords');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
const roles = ['clinician', 'pharmacist', 'clerk', 'administrator'];

router.use(requireAuth, requireRole('administrator'));

router.get('/users', async (req, res) => {
  const users = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, username, role, requested_role, approval_status, is_active, created_at
       FROM users ORDER BY username LIMIT 200`
    );
    await recordAudit(client, { actorId: req.user.id, action: 'admin.users_viewed', resourceType: 'user' });
    return result.rows;
  });
  return res.json({ users });
});

router.post('/users', async (req, res) => {
  const username = cleanText(req.body && req.body.username, 80, { required: true });
  const password = req.body && req.body.password;
  const role = req.body && req.body.role;
  if (!username || !/^[a-zA-Z0-9._@-]{3,80}$/.test(username) ||
      typeof password !== 'string' || password.length < 12 || password.length > 128 || !roles.includes(role)) {
    return res.status(400).json({ error: 'Enter a valid username, 12-128 character password, and role.' });
  }

  const passwordHash = await hashPassword(password);
  try {
    const user = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, username, role, is_active, created_at`,
        [username, passwordHash, role]
      );
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'admin.user_created',
        resourceType: 'user',
        resourceId: result.rows[0].id
      });
      return result.rows[0];
    });
    return res.status(201).json({ user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username is already in use.' });
    throw error;
  }
});

router.patch('/users/:id/approval', async (req, res) => {
  const assignedRole = req.body && req.body.role;
  if (!isUuid(req.params.id) || !roles.includes(assignedRole)) {
    return res.status(400).json({ error: 'Choose a valid role for this account.' });
  }

  const user = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE users
       SET role = $1, is_active = TRUE, approval_status = 'approved'
       WHERE id = $2 AND approval_status = 'pending'
       RETURNING id, username, role, requested_role, approval_status, is_active, created_at`,
      [assignedRole, req.params.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'admin.registration_approved',
      resourceType: 'user',
      resourceId: req.params.id
    });
    return result.rows[0];
  });

  if (!user) return res.status(404).json({ error: 'Pending registration not found.' });
  return res.json({ user });
});

router.patch('/users/:id/status', async (req, res) => {
  const isActive = req.body && req.body.isActive;
  if (!isUuid(req.params.id) || typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'Invalid user status request.' });
  }
  if (req.params.id === req.user.id && !isActive) {
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  }

  const updated = await withTransaction(async (client) => {
    if (!isActive) {
      await client.query(
        "SELECT id FROM users WHERE role = 'administrator' AND is_active = TRUE ORDER BY id FOR UPDATE"
      );
    }
    const target = await client.query('SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!target.rowCount) return null;
    if (target.rows[0].role === 'administrator' && target.rows[0].is_active && !isActive) {
      const activeAdmins = await client.query(
        "SELECT id FROM users WHERE role = 'administrator' AND is_active = TRUE"
      );
      if (activeAdmins.rowCount <= 1) return 'last-administrator';
    }

    const result = await client.query(
      `UPDATE users SET is_active = $1 WHERE id = $2
       RETURNING id, username, role, is_active`,
      [isActive, req.params.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: isActive ? 'admin.user_activated' : 'admin.user_deactivated',
      resourceType: 'user',
      resourceId: req.params.id
    });
    return result.rows[0];
  });

  if (updated === 'last-administrator') return res.status(409).json({ error: 'The last active administrator cannot be deactivated.' });
  if (!updated) return res.status(404).json({ error: 'User not found.' });
  return res.json({ user: updated });
});

router.get('/audit', async (req, res) => {
  const rawLimit = Number(req.query.limit || 50);
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
  const events = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, actor_id, action, resource_type, resource_id, occurred_at
       FROM audit_events ORDER BY occurred_at DESC LIMIT $1`,
      [limit]
    );
    await recordAudit(client, { actorId: req.user.id, action: 'admin.audit_viewed', resourceType: 'audit_event' });
    return result.rows;
  });
  return res.json({ events });
});

module.exports = router;