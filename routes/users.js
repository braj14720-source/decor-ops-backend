// routes/users.js — admin user management (owner-only writes).
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
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.all(
      'SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at DESC',
    );
    res.json({ items: rows.map(publicUser) });
  } catch (e) { next(e); }
});

// POST /api/users  { email, password, name, role: 'owner' | 'worker' }
router.post('/', async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password and name are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedRole = role === 'owner' ? 'owner' : 'worker';

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const info = await db.run(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [normalizedEmail, hash, name, normalizedRole],
    );
    const row = await db.get(
      'SELECT id, email, name, role, active, created_at FROM users WHERE id = ?',
      [info.lastInsertRowid],
    );
    res.status(201).json({ user: publicUser(row) });
  } catch (e) { next(e); }
});

// PUT /api/users/:id  { name?, role?, active?, password? }
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const updates = { ...existing, ...req.body };

    if (updates.role && updates.role !== 'owner' && updates.role !== 'worker') {
      return res.status(400).json({ error: 'role must be owner or worker' });
    }

    if (existing.role === 'owner' && (updates.role === 'worker' || updates.active === 0)) {
      const cnt = await db.get(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1",
      );
      const ownerCount = cnt ? Number(cnt.n) : 0;
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

    await db.run(
      `UPDATE users SET name=?, role=?, active=?, password_hash=? WHERE id=?`,
      [
        String(updates.name).trim(),
        updates.role,
        updates.active === undefined ? existing.active : (updates.active ? 1 : 0),
        hash,
        id,
      ],
    );

    const row = await db.get(
      'SELECT id, email, name, role, active, created_at FROM users WHERE id = ?',
      [id],
    );
    res.json({ user: publicUser(row) });
  } catch (e) { next(e); }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete yourself' });
    }
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (existing.role === 'owner') {
      const cnt = await db.get(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1",
      );
      const ownerCount = cnt ? Number(cnt.n) : 0;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active owner' });
      }
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;