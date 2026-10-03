// routes/push.js — register / unregister FCM device tokens.
const express = require('express');
const db = require('../db');
const { authRequired, requireSuperAdmin } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();
router.use(authRequired);

const TOKEN_RE = /^[A-Za-z0-9_\-:]{20,}$/;

// POST /api/push/register { token, platform }
router.post('/register', requireSuperAdmin, async (req, res, next) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || !TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'invalid token' });
    }
    const p = (platform || '').toString().slice(0, 16) || null;

    // Upsert — if the token existed for a different user, move it; else update.
    await db.run(
      `INSERT INTO device_tokens (user_id, token, platform, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         platform = excluded.platform,
         last_seen_at = datetime('now')`,
      [req.user.id, token, p],
    );
    res.json({ ok: true, enabled: push.enabled() });
  } catch (e) { next(e); }
});

// DELETE /api/push/register  { token }
router.delete('/register', requireSuperAdmin, async (req, res, next) => {
  try {
    const token = (req.body && req.body.token) || req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    await db.run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', [token, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/push/status — surfaces whether the backend has FCM configured.
router.get('/status', (_req, res) => {
  push.init(); // surface config errors lazily
  res.json({ enabled: push.enabled() });
});

module.exports = router;