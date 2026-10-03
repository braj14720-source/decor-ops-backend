// routes/labor.js — worker profiles + standard daily wages.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function row(payload) {
  return [
    String(payload.name || '').trim(),
    payload.role ? String(payload.role).trim() : null,
    payload.phone ? String(payload.phone).trim() : null,
    Number(payload.daily_wage ?? 0),
    payload.active === undefined ? 1 : (payload.active ? 1 : 0),
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

router.get('/', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM labor ORDER BY active DESC, name ASC');
    res.json({ items });
  } catch (e) { next(e); }
});

router.post('/', requireRole('owner'), async (req, res, next) => {
  try {
    const r = row(req.body);
    if (!r[0]) return res.status(400).json({ error: 'name is required' });
    const info = await db.run(
      `INSERT INTO labor (name, role, phone, daily_wage, active, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      r,
    );
    const item = await db.get('SELECT * FROM labor WHERE id = ?', [info.lastInsertRowid]);
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM labor WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const r = row({ ...existing, ...req.body });
    await db.run(
      `UPDATE labor SET
         name=?, role=?, phone=?, daily_wage=?,
         active=?, notes=?, updated_at=datetime('now')
       WHERE id=?`,
      [...r, id],
    );
    const item = await db.get('SELECT * FROM labor WHERE id = ?', [id]);
    res.json({ item });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const info = await db.run('DELETE FROM labor WHERE id = ?', [Number(req.params.id)]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;