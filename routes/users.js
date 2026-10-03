// routes/users.js — admin user management.
//
//   super_admin : full CRUD, can create any role (including other super_admins/admins)
//   admin       : can create employees + in_house_labours (NOT super_admin or admin)
//                 can edit employees + in_house_labours (NOT super_admin or other admins)
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireManagement, requireSuperAdmin, ROLE_RANK } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const ALLOWED_ROLES = new Set(['super_admin', 'admin', 'employee', 'in_house_labour']);

// Roles the *caller* is allowed to assign. super_admin can assign any role.
// admin can only assign employee / in_house_labour.
function rolesAllowedFor(actorRole) {
  if (actorRole === 'super_admin') {
    return ALLOWED_ROLES;
  }
  if (actorRole === 'admin') {
    return new Set(['employee', 'in_house_labour']);
  }
  return new Set();
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    designation: row.designation || null,
    active: row.active ?? 1,
    created_at: row.created_at,
  };
}

// GET /api/users  — super_admin and admin only
router.get('/', requireManagement, async (_req, res, next) => {
  try {
    const rows = await db.all(
      'SELECT id, email, name, role, designation, active, created_at FROM users ORDER BY created_at DESC',
    );
    res.json({ items: rows.map(publicUser) });
  } catch (e) { next(e); }
});

// POST /api/users  { email, password, name, role, designation? }
router.post('/', requireManagement, async (req, res, next) => {
  try {
    const { email, password, name, role, designation } = req.body || {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password and name are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    const actorRole = req.user.role;
    const assignable = rolesAllowedFor(actorRole);
    if (!ALLOWED_ROLES.has(role || '')) {
      return res.status(400).json({
        error: `role must be one of: ${[...ALLOWED_ROLES].join(', ')}`,
      });
    }
    if (!assignable.has(role)) {
      return res.status(403).json({
        error: `Your role (${actorRole}) cannot create accounts with role ${role}.`,
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const info = await db.run(
      'INSERT INTO users (email, password_hash, name, role, designation) VALUES (?, ?, ?, ?, ?)',
      [normalizedEmail, hash, name, role, designation ? String(designation).trim() : null],
    );
    const row = await db.get(
      'SELECT id, email, name, role, designation, active, created_at FROM users WHERE id = ?',
      [info.lastInsertRowid],
    );
    res.status(201).json({ user: publicUser(row) });
  } catch (e) { next(e); }
});

// PUT /api/users/:id  { name?, role?, designation?, active?, password? }
router.put('/:id', requireManagement, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const actorRole = req.user.role;
    const actorRank = ROLE_RANK[actorRole] || 0;
    const targetRank = ROLE_RANK[existing.role] || 0;

    // super_admin can edit anyone. admin can only edit users ranked below admin
    // (i.e. employees + in_house_labours), and not other admins/super_admins.
    if (actorRole !== 'super_admin' && targetRank >= ROLE_RANK.admin) {
      return res.status(403).json({
        error: 'You do not have permission to edit an account at that role level.',
      });
    }

    const updates = { ...existing, ...req.body };

    if (updates.role && !ALLOWED_ROLES.has(updates.role)) {
      return res.status(400).json({ error: 'role must be one of the allowed values' });
    }

    // Prevent demoting/deactivating the last active super_admin.
    if (existing.role === 'super_admin' && (updates.role !== 'super_admin' || updates.active === 0)) {
      const cnt = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1");
      const saCount = cnt ? Number(cnt.n) : 0;
      if (saCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote or deactivate the last active super admin' });
      }
      if (id === req.user.id) {
        return res.status(400).json({ error: 'You cannot demote or deactivate yourself' });
      }
    }

    // Enforce role-change permission for the actor.
    if (updates.role && updates.role !== existing.role) {
      const assignable = rolesAllowedFor(actorRole);
      if (!assignable.has(updates.role)) {
        return res.status(403).json({
          error: `Your role (${actorRole}) cannot assign role ${updates.role}.`,
        });
      }
    }

    const hash = updates.password
      ? await bcrypt.hash(String(updates.password), 10)
      : existing.password_hash;

    await db.run(
      `UPDATE users SET name=?, role=?, designation=?, active=?, password_hash=? WHERE id=?`,
      [
        String(updates.name).trim(),
        updates.role,
        updates.designation != null ? String(updates.designation).trim() : existing.designation,
        updates.active === undefined ? existing.active : (updates.active ? 1 : 0),
        hash,
        id,
      ],
    );

    const row = await db.get(
      'SELECT id, email, name, role, designation, active, created_at FROM users WHERE id = ?',
      [id],
    );
    res.json({ user: publicUser(row) });
  } catch (e) { next(e); }
});

// DELETE /api/users/:id  — super_admin only
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete yourself' });
    }
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (existing.role === 'super_admin') {
      const cnt = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1");
      const saCount = cnt ? Number(cnt.n) : 0;
      if (saCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active super admin' });
      }
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;