const pool = require('../db');

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
  return next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    return next();
  };
}

module.exports = { requireAuth, requireRole };
