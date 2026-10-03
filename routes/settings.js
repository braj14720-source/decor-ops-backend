// routes/settings.js — per-user notification + alert preferences.
const express = require('express');
const db = require('../db');
const { authRequired, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function ensureRow(userId) {
  const exists = await db.get('SELECT user_id FROM user_settings WHERE user_id = ?', [userId]);
  if (!exists) {
    await db.run('INSERT INTO user_settings (user_id) VALUES (?)', [userId]);
  }
}

function rowToDto(r) {
  return {
    user_id: r.user_id,
    attendance_remind: r.attendance_remind === 1,
    remind_time: r.remind_time,
    low_stock_alerts: r.low_stock_alerts === 1,
    low_stock_threshold: r.low_stock_threshold,
    push_token: r.push_token || null,
  };
}

router.get('/', async (req, res, next) => {
  try {
    await ensureRow(req.user.id);
    const row = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    res.json({ settings: rowToDto(row) });
  } catch (e) { next(e); }
});

router.put('/', requireSuperAdmin, async (req, res, next) => {
  try {
    await ensureRow(req.user.id);
    const b = req.body || {};
    const attendance_remind = b.attendance_remind === undefined ? 1 : (b.attendance_remind ? 1 : 0);
    const remind_time = TIME_RE.test(b.remind_time || '') ? b.remind_time : '09:00';
    const low_stock_alerts = b.low_stock_alerts === undefined ? 1 : (b.low_stock_alerts ? 1 : 0);
    const low_stock_threshold =
      Number.isFinite(Number(b.low_stock_threshold)) && Number(b.low_stock_threshold) >= 0
        ? Math.floor(Number(b.low_stock_threshold))
        : 5;
    const push_token = typeof b.push_token === 'string' ? b.push_token.slice(0, 256) : null;

    await db.run(
      `UPDATE user_settings SET
         attendance_remind=?, remind_time=?,
         low_stock_alerts=?, low_stock_threshold=?, push_token=?
       WHERE user_id=?`,
      [attendance_remind, remind_time, low_stock_alerts, low_stock_threshold, push_token, req.user.id],
    );
    const row = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    res.json({ settings: rowToDto(row) });
  } catch (e) { next(e); }
});

// GET /api/settings/low-stock  — used by Flutter to surface a local notification
router.get('/low-stock', async (req, res, next) => {
  try {
    await ensureRow(req.user.id);
    const s = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    if (s.low_stock_alerts !== 1) return res.json({ items: [], enabled: false });
    const items = await db.all(
      'SELECT id, name, quantity, unit FROM inventory WHERE quantity <= ? ORDER BY quantity ASC',
      [s.low_stock_threshold],
    );
    res.json({ enabled: true, threshold: s.low_stock_threshold, items });
  } catch (e) { next(e); }
});

module.exports = router;