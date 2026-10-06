const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { hashPassword } = require('../security/passwords');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
const roles = ['clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator'];
const settingValidators = {
  facility_name: (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200,
  patient_mrn_prefix: (value) => typeof value === 'string' && /^[A-Z0-9]{2,10}$/.test(value)
};

router.use(requireAuth);

router.get('/users', requirePermission('users.manage'), async (req, res) => {
  const users = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, username, role, requested_role, approval_status, is_active, created_at
       FROM users ORDER BY username LIMIT 200`
    );
    await recordAudit(client, { actorId: req.user.id, action: 'admin.users_viewed', resourceType: 'user', module: 'admin', description: 'Administrative user list reviewed.' });
    return result.rows;
  });
  return res.json({ users });
});

router.post('/users', requirePermission('users.manage'), async (req, res) => {
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
        resourceId: result.rows[0].id,
        module: 'admin',
        description: 'User account created.'
      });
      return result.rows[0];
    });
    return res.status(201).json({ user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username is already in use.' });
    throw error;
  }
});

router.patch('/users/:id/approval', requirePermission('users.manage'), async (req, res) => {
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
      resourceId: req.params.id,
      module: 'admin',
      description: 'User registration approved and role assigned.'
    });
    return result.rows[0];
  });

  if (!user) return res.status(404).json({ error: 'Pending registration not found.' });
  return res.json({ user });
});

router.patch('/users/:id/status', requirePermission('users.manage'), async (req, res) => {
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
      resourceId: req.params.id,
      module: 'admin',
      description: isActive ? 'User account restored.' : 'User account suspended.'
    });
    return result.rows[0];
  });

  if (updated === 'last-administrator') return res.status(409).json({ error: 'The last active administrator cannot be deactivated.' });
  if (!updated) return res.status(404).json({ error: 'User not found.' });
  return res.json({ user: updated });
});

router.get('/audit', requirePermission('audit.view'), async (req, res) => {
  const rawLimit = Number(req.query.limit || 50);
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
  const events = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, actor_id, action, resource_type, resource_id, occurred_at
       FROM audit_events ORDER BY occurred_at DESC LIMIT $1`,
      [limit]
    );
    await recordAudit(client, { actorId: req.user.id, action: 'admin.audit_viewed', resourceType: 'audit_event', module: 'admin', description: 'Audit trail reviewed.' });
    return result.rows;
  });
  return res.json({ events });
});

router.get('/permissions', requirePermission('permissions.manage'), async (req, res) => {
  const permissions = await withTransaction(async (client) => {
    const catalog = await client.query('SELECT name, description FROM permissions ORDER BY name');
    const assignments = await client.query(
      'SELECT role, permission_name, granted FROM role_permissions ORDER BY role, permission_name'
    );
    const rolesByPermission = await client.query(
      'SELECT user_id, permission_name, granted FROM user_permissions ORDER BY user_id, permission_name'
    );
    return {
      catalog: catalog.rows,
      roles: assignments.rows,
      users: rolesByPermission.rows
    };
  });
  return res.json(permissions);
});

router.get('/departments', requirePermission('departments.manage'), async (req, res) => {
  const departments = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, name, code, description, is_active, created_at, updated_at
       FROM departments ORDER BY name`
    );
    return result.rows;
  });
  return res.json({ departments });
});

router.post('/departments', requirePermission('departments.manage'), async (req, res) => {
  const name = cleanText(req.body && req.body.name, 120, { required: true });
  const code = cleanText(req.body && req.body.code, 20, { required: true });
  const description = cleanText(req.body && req.body.description || '', 2000);
  if (!name || !code || !/^[A-Z0-9-]{2,20}$/.test(code) || description === null) {
    return res.status(400).json({ error: 'Provide a valid department name, code, and description.' });
  }
  let department;
  try {
    department = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO departments (name, code, description, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, name, code, description, is_active, created_at, updated_at`,
        [name, code, description || null, req.user.id]
      );
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'admin.department_created',
        resourceType: 'department',
        resourceId: result.rows[0].id,
        module: 'admin',
        description: 'Department created.'
      });
      return result.rows[0];
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Department name or code is already in use.' });
    throw error;
  }
  return res.status(201).json({ department });
});

router.patch('/departments/:id', requirePermission('departments.manage'), async (req, res) => {
  const name = cleanText(req.body && req.body.name, 120, { required: true });
  const code = cleanText(req.body && req.body.code, 20, { required: true });
  const description = cleanText(req.body && req.body.description || '', 2000);
  const isActive = req.body && req.body.isActive;
  if (!isUuid(req.params.id) || !name || !code || !/^[A-Z0-9-]{2,20}$/.test(code) ||
      description === null || typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'Provide valid department details and active status.' });
  }
  let department;
  try {
    department = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE departments SET name = $1, code = $2, description = $3, is_active = $4,
           updated_by = $5, updated_at = NOW()
         WHERE id = $6
         RETURNING id, name, code, description, is_active, created_at, updated_at`,
        [name, code, description || null, isActive, req.user.id, req.params.id]
      );
      if (!result.rowCount) return null;
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'admin.department_updated',
        resourceType: 'department',
        resourceId: req.params.id,
        module: 'admin',
        description: 'Department details or active status updated.'
      });
      return result.rows[0];
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Department name or code is already in use.' });
    throw error;
  }
  if (!department) return res.status(404).json({ error: 'Department not found.' });
  return res.json({ department });
});

router.get('/settings', requirePermission('settings.manage'), async (req, res) => {
  const settings = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT setting_key, setting_value, updated_by, updated_at
       FROM system_settings ORDER BY setting_key`
    );
    return result.rows;
  });
  return res.json({ settings });
});

router.put('/settings/:key', requirePermission('settings.manage'), async (req, res) => {
  const validate = Object.hasOwn(settingValidators, req.params.key) ? settingValidators[req.params.key] : null;
  const value = req.body && req.body.value;
  if (!validate || !validate(value)) {
    return res.status(400).json({ error: 'Setting key or value is invalid.' });
  }
  const setting = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING setting_key, setting_value, updated_by, updated_at`,
      [req.params.key, String(value), req.user.id]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'admin.system_setting_updated',
      resourceType: 'system_setting',
      module: 'admin',
      description: `System setting updated: ${req.params.key}.`
    });
    return result.rows[0];
  });
  return res.json({ setting });
});

router.put('/permissions/roles/:role', requirePermission('permissions.manage'), async (req, res) => {
  const validRoles = ['clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator'];
  const grants = req.body && req.body.permissions;
  if (!validRoles.includes(req.params.role) || !Array.isArray(grants) ||
      grants.some((permission) => typeof permission !== 'string') || new Set(grants).size !== grants.length) {
    return res.status(400).json({ error: 'Provide a valid role and unique permission list.' });
  }
  if (req.params.role === 'administrator' &&
      (!grants.includes('permissions.manage') || !grants.includes('users.manage'))) {
    return res.status(400).json({ error: 'Administrator permission and user management must remain available.' });
  }
  const saved = await withTransaction(async (client) => {
    const known = await client.query('SELECT name FROM permissions WHERE name = ANY($1::text[])', [grants]);
    if (known.rowCount !== grants.length) return false;
    const catalog = await client.query('SELECT name FROM permissions');
    await client.query('DELETE FROM role_permissions WHERE role = $1', [req.params.role]);
    for (const permission of catalog.rows) {
      await client.query(
        `INSERT INTO role_permissions (role, permission_name, granted)
         VALUES ($1, $2, $3)`,
        [req.params.role, permission.name, grants.includes(permission.name)]
      );
    }
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'admin.role_permissions_updated',
      resourceType: 'role',
      module: 'admin',
      description: `Permissions updated for role ${req.params.role}.`
    });
    return true;
  });
  if (!saved) return res.status(400).json({ error: 'One or more permissions are not recognized.' });
  return res.status(204).end();
});

router.put('/users/:id/permissions', requirePermission('permissions.manage'), async (req, res) => {
  const grants = req.body && req.body.permissions;
  if (!isUuid(req.params.id) || !Array.isArray(grants) ||
      grants.some((grant) => !grant || typeof grant.name !== 'string' || typeof grant.granted !== 'boolean') ||
      new Set(grants.map((grant) => grant.name)).size !== grants.length) {
    return res.status(400).json({ error: 'Provide a valid account and unique permission overrides.' });
  }
  if (req.params.id === req.user.id && grants.some((grant) =>
    grant.granted === false && ['permissions.manage', 'users.manage'].includes(grant.name))) {
    return res.status(400).json({ error: 'You cannot remove your own administrator access.' });
  }
  const saved = await withTransaction(async (client) => {
    const target = await client.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    const known = await client.query(
      'SELECT name FROM permissions WHERE name = ANY($1::text[])',
      [grants.map((grant) => grant.name)]
    );
    if (!target.rowCount || known.rowCount !== grants.length) return false;
    await client.query('DELETE FROM user_permissions WHERE user_id = $1', [req.params.id]);
    for (const grant of grants) {
      await client.query(
        `INSERT INTO user_permissions (user_id, permission_name, granted, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, permission_name)
         DO UPDATE SET granted = EXCLUDED.granted, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
        [req.params.id, grant.name, grant.granted, req.user.id]
      );
    }
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'admin.user_permissions_updated',
      resourceType: 'user',
      resourceId: req.params.id,
      module: 'admin',
      description: 'Per-user permission overrides updated.'
    });
    return true;
  });
  if (!saved) return res.status(404).json({ error: 'User or permission not found.' });
  return res.status(204).end();
});

module.exports = router;