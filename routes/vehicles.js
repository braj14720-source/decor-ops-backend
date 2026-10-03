// routes/vehicles.js — logistics / trip logs.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();
router.use(authRequired);

const STATUSES = new Set(['pending', 'in_transit', 'completed']);

function row(payload) {
  let status = payload.status ? String(payload.status).toLowerCase() : 'pending';
  if (!STATUSES.has(status)) status = 'pending';
  return [
    String(payload.vehicle_no || '').trim(),
    payload.driver_name ? String(payload.driver_name).trim() : null,
    payload.from_location ? String(payload.from_location).trim() : null,
    payload.to_location ? String(payload.to_location).trim() : null,
    payload.purpose ? String(payload.purpose).trim() : null,
    status,
    payload.departed_at || null,
    payload.arrived_at || null,
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

router.get('/', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM vehicles ORDER BY datetime(updated_at) DESC, id DESC');
    res.json({ items });
  } catch (e) { next(e); }
});

router.post('/', requireRole('owner'), async (req, res, next) => {
  try {
    const r = row(req.body);
    if (!r[0]) return res.status(400).json({ error: 'vehicle_no is required' });
    const info = await db.run(
      `INSERT INTO vehicles (vehicle_no, driver_name, from_location, to_location,
                             purpose, status, departed_at, arrived_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r,
    );
    const item = await db.get('SELECT * FROM vehicles WHERE id = ?', [info.lastInsertRowid]);
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const r = row({ ...existing, ...req.body });
    await db.run(
      `UPDATE vehicles SET
         vehicle_no=?, driver_name=?,
         from_location=?, to_location=?,
         purpose=?, status=?,
         departed_at=?, arrived_at=?,
         notes=?, updated_at=datetime('now')
       WHERE id=?`,
      [...r, id],
    );
    const item = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);

    // Notify all owners when a trip transitions to "completed".
    if (existing.status !== 'completed' && r[5] === 'completed') {
      const route = `${r[2] || '—'} → ${r[3] || '—'}`;
      push.sendToAllOwners({
        title: `Trip completed: ${r[0]}`,
        body: `${route}${r[1] ? ` · ${r[1]}` : ''}`,
        data: { type: 'trip_completed', vehicle_id: String(id), vehicle_no: r[0] },
      }).catch(() => {});
    }

    res.json({ item });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const info = await db.run('DELETE FROM vehicles WHERE id = ?', [Number(req.params.id)]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;