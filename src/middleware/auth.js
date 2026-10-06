const pool = require('../db');

async function getPermissions(userId, role) {
  const result = await pool.query(
    `SELECT p.name AS permission
     FROM permissions p
     WHERE COALESCE(
       (SELECT up.granted FROM user_permissions up
        WHERE up.user_id = $1 AND up.permission_name = p.name),
       (SELECT rp.granted FROM role_permissions rp
        WHERE rp.role = $2 AND rp.permission_name = p.name),
       FALSE
     ) = TRUE
     ORDER BY p.name`,
    [userId, role]
  );
  return result.rows.map((row) => row.permission);
}

async function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const result = await pool.query(
    'SELECT id, username, role, must_change_password FROM users WHERE id = $1 AND is_active = TRUE',
    [req.session.user.id]
  );
  if (!result.rowCount) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Authentication required.' });
  }

  if (result.rows[0].must_change_password) {
    return res.status(403).json({ error: 'Change your temporary password before continuing.' });
  }

  req.user = result.rows[0];
  req.user.permissions = await getPermissions(req.user.id, req.user.role);
  return next();
}

function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.user || !requiredPermissions.every((permission) => req.user.permissions.includes(permission))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    return next();
  };
}

function requireAnyPermission(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.user || !requiredPermissions.some((permission) => req.user.permissions.includes(permission))) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    return next();
  };
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, getPermissions };
