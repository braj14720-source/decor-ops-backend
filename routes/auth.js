// routes/auth.js — signup / login / me. JWT issued on success.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// POST /api/auth/signup  { email, password, name }
// Public signup is restricted to workers. Owners must be created by an
// existing owner via POST /api/users — keeps the business in your control.
router.post('/signup', async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password and name are required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const info = await db.run(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [normalizedEmail, hash, name, 'worker'],
    );
    const user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) { next(e); }
});

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) { next(e); }
});

// GET /api/auth/me — current user from token
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const user = await db.get('SELECT id, email, name, role FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) { next(e); }
});

module.exports = router;