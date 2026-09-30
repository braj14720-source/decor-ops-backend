// routes/labor.js — worker profiles + standard daily wages.
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function row(payload) {
  return {
    name: String(payload.name || '').trim(),
    role: payload.role ? String(payload.role).trim() : null,
    phone: payload.phone ? String(payload.phone).trim() : null,
    daily_wage: Number(payload.daily_wage ?? 0),
    active: payload.active === undefined ? 1 : payload.active ? 1 : 0,
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

router.get('/', (req, res) => {
  const items = db
    .prepare('SELECT * FROM labor ORDER BY active DESC, name ASC')
    .all();
  res.json({ items });
});

router.post('/', (req, res) => {
  const r = row(req.body);
  if (!r.name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare(
      `INSERT INTO labor (name, role, phone, daily_wage, active, notes)
       VALUES (@name, @role, @phone, @daily_wage, @active, @notes)`
    )
    .run(r);
  const item = db.prepare('SELECT * FROM labor WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM labor WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const r = row({ ...existing, ...req.body });
  db.prepare(
    `UPDATE labor SET
       name=@name, role=@role, phone=@phone, daily_wage=@daily_wage,
       active=@active, notes=@notes, updated_at=datetime('now')
     WHERE id=@id`
  ).run({ ...r, id });
  const item = db.prepare('SELECT * FROM labor WHERE id = ?').get(id);
  res.json({ item });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM labor WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;