// routes/users.js — admin user management (owner-only writes).
// Public signup is restricted to workers elsewhere; this is the proper
// way for an existing owner to add team members (workers or other owners).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('owner'));

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active ?? 1,
    created_at: row.created_at,
  };
}

// GET /api/users
router.get('/', (_req, res) => {
  const rows = db
    .prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json({ items: rows.map(publicUser) });
});

// POST /api/users  { email, password, name, role: 'owner' | 'worker' }
router.post('/', async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = role === 'owner' ? 'owner' : 'worker';

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(normalizedEmail, hash, name, normalizedRole);
  const row = db
    .prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(row) });
});

// PUT /api/users/:id  { name?, role?, active?, password? }
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Don't let an owner demote themselves to a worker if they're the last owner.
  const updates = { ...existing, ...req.body };

  if (updates.role && updates.role !== 'owner' && updates.role !== 'worker') {
    return res.status(400).json({ error: 'role must be owner or worker' });
  }

  if (existing.role === 'owner' && (updates.role === 'worker' || updates.active === 0)) {
    const ownerCount = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1")
      .get().n;
    if (ownerCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote or deactivate the last active owner' });
    }
    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot demote or deactivate yourself' });
    }
  }

  const hash = updates.password
    ? await bcrypt.hash(String(updates.password), 10)
    : existing.password_hash;

  db.prepare(
    `UPDATE users SET name=?, role=?, active=?, password_hash=? WHERE id=?`
  ).run(
    String(updates.name).trim(),
    updates.role,
    updates.active === undefined ? existing.active : (updates.active ? 1 : 0),
    hash,
    id,
  );

  const row = db
    .prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?')
    .get(id);
  res.json({ user: publicUser(row) });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete yourself' });
  }
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (existing.role === 'owner') {
    const ownerCount = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1")
      .get().n;
    if (ownerCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last active owner' });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;