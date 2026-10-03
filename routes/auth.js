// routes/auth.js — signup / login / me. JWT issued on success.
//
// Hardening (Phase 1.5):
//   - Public signup is DISABLED by default. Owners create accounts via /api/users.
//   - Login is restricted to emails in ALLOWED_LOGIN_EMAILS (comma-separated
//     env var, case-insensitive). If unset, login is unrestricted (dev only).
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Read the allowed-emails list once at boot. Empty = allow all (dev only).
const ALLOWED_LOGIN_EMAILS = (process.env.ALLOWED_LOGIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_LOGIN_ALL = ALLOWED_LOGIN_EMAILS.length === 0;
const ALLOW_PUBLIC_SIGNUP = String(process.env.DISABLE_PUBLIC_SIGNUP || '').toLowerCase() !== 'true'
  && String(process.env.ALLOW_PUBLIC_SIGNUP || '').toLowerCase() === 'true';

function emailAllowed(email) {
  if (ALLOW_LOGIN_ALL) return true;
  return ALLOWED_LOGIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' },
  );
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// POST /api/auth/signup
//   DISABLED by default. Owners create accounts via /api/users.
//   To re-enable (not recommended): set ALLOW_PUBLIC_SIGNUP=true AND remove the
//   email whitelist, or set ALLOWED_LOGIN_EMAILS to permit the new account.
router.post('/signup', async (req, res, next) => {
  try {
    if (!ALLOW_PUBLIC_SIGNUP) {
      return res.status(403).json({
        error: 'Public signup is disabled. Ask the owner to create an account for you via the Team screen.',
      });
    }
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password and name are required' });
    }
    if (!emailAllowed(email)) {
      return res.status(403).json({ error: 'Signup is restricted to authorised emails.' });
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

    const normalized = String(email).trim().toLowerCase();

    // Reject up-front if the email is not in the allowlist. Use a generic
    // 401 (not 403) so we don't leak whether the email exists.
    if (!emailAllowed(normalized)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [normalized]);
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