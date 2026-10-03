// middleware/auth.js — JWT bearer-token auth + role guards.
//
// Roles (in order of privilege):
//   super_admin     — full control, including DELETE on operational data
//   admin           — can create/manage employee & in_house_labour accounts, edit data, NO delete
//   employee        — can edit data, NO delete
//   in_house_labour — read-only access
//
// Composite role checks (semantic shortcuts):
//   requireSuperAdmin   — super_admin only
//   requireManagement   — super_admin OR admin  (for user management endpoints)
//   requireStaff        — super_admin, admin, OR employee (operational writes)
//   requireWrite        — alias for requireStaff

const jwt = require('jsonwebtoken');

const ROLE_RANK = {
  super_admin: 40,
  admin: 30,
  employee: 20,
  in_house_labour: 10,
};

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function requireAtLeast(minRole) {
  const min = ROLE_RANK[minRole] || 0;
  return (req, res, next) => {
    const r = req.user && ROLE_RANK[req.user.role];
    if (!r || r < min) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// Semantic shortcuts — use these in routes for clarity.
const requireSuperAdmin = requireRole('super_admin');
const requireManagement = requireRole('super_admin', 'admin');
const requireStaff      = requireRole('super_admin', 'admin', 'employee');
const requireWrite      = requireStaff;
const requireDelete     = requireSuperAdmin;

module.exports = {
  authRequired,
  requireRole,
  requireAtLeast,
  requireSuperAdmin,
  requireManagement,
  requireStaff,
  requireWrite,
  requireDelete,
  ROLE_RANK,
};