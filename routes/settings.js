// routes/settings.js — per-user notification + alert preferences.
//
// Body for PUT:
//   {
//     attendance_remind: 0|1,
//     remind_time: "HH:MM",            -- 24h
//     low_stock_alerts: 0|1,
//     low_stock_threshold: number,
//     push_token?: string              -- optional, for future FCM
//   }

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function ensureRow(userId) {
  const exists = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);
  if (!exists) {
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
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

router.get('/', (req, res) => {
  ensureRow(req.user.id);
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  res.json({ settings: rowToDto(row) });
});

router.put('/', requireRole('owner'), (req, res) => {
  ensureRow(req.user.id);
  const b = req.body || {};
  const next = {
    attendance_remind: b.attendance_remind === undefined ? 1 : (b.attendance_remind ? 1 : 0),
    remind_time: TIME_RE.test(b.remind_time || '') ? b.remind_time : '09:00',
    low_stock_alerts: b.low_stock_alerts === undefined ? 1 : (b.low_stock_alerts ? 1 : 0),
    low_stock_threshold:
      Number.isFinite(Number(b.low_stock_threshold)) && Number(b.low_stock_threshold) >= 0
        ? Math.floor(Number(b.low_stock_threshold))
        : 5,
    push_token: typeof b.push_token === 'string' ? b.push_token.slice(0, 256) : null,
  };
  db.prepare(
    `UPDATE user_settings SET
       attendance_remind=@attendance_remind,
       remind_time=@remind_time,
       low_stock_alerts=@low_stock_alerts,
       low_stock_threshold=@low_stock_threshold,
       push_token=@push_token
     WHERE user_id=@user_id`
  ).run({ ...next, user_id: req.user.id });
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  res.json({ settings: rowToDto(row) });
});

// GET /api/settings/low-stock  — used by Flutter to surface a local notification
router.get('/low-stock', (req, res) => {
  ensureRow(req.user.id);
  const s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  if (s.low_stock_alerts !== 1) return res.json({ items: [], enabled: false });
  const items = db
    .prepare('SELECT id, name, quantity, unit FROM inventory WHERE quantity <= ? ORDER BY quantity ASC')
    .all(s.low_stock_threshold);
  res.json({ enabled: true, threshold: s.low_stock_threshold, items });
});

module.exports = router;