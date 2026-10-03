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
  return {
    vehicle_no: String(payload.vehicle_no || '').trim(),
    driver_name: payload.driver_name ? String(payload.driver_name).trim() : null,
    from_location: payload.from_location ? String(payload.from_location).trim() : null,
    to_location: payload.to_location ? String(payload.to_location).trim() : null,
    purpose: payload.purpose ? String(payload.purpose).trim() : null,
    status,
    departed_at: payload.departed_at || null,
    arrived_at: payload.arrived_at || null,
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

router.get('/', (req, res) => {
  const items = db
    .prepare('SELECT * FROM vehicles ORDER BY datetime(updated_at) DESC, id DESC')
    .all();
  res.json({ items });
});

router.post('/', requireRole('owner'), (req, res) => {
  const r = row(req.body);
  if (!r.vehicle_no) return res.status(400).json({ error: 'vehicle_no is required' });
  const info = db
    .prepare(
      `INSERT INTO vehicles (vehicle_no, driver_name, from_location, to_location,
                             purpose, status, departed_at, arrived_at, notes)
       VALUES (@vehicle_no, @driver_name, @from_location, @to_location,
               @purpose, @status, @departed_at, @arrived_at, @notes)`
    )
    .run(r);
  const item = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item });
});

router.put('/:id', requireRole('owner'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const r = row({ ...existing, ...req.body });
  db.prepare(
    `UPDATE vehicles SET
       vehicle_no=@vehicle_no, driver_name=@driver_name,
       from_location=@from_location, to_location=@to_location,
       purpose=@purpose, status=@status,
       departed_at=@departed_at, arrived_at=@arrived_at,
       notes=@notes, updated_at=datetime('now')
     WHERE id=@id`
  ).run({ ...r, id });
  const item = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);

  // Notify all owners when a trip transitions to "completed".
  if (existing.status !== 'completed' && r.status === 'completed') {
    const route = `${r.from_location || '—'} → ${r.to_location || '—'}`;
    push.sendToAllOwners({
      title: `Trip completed: ${r.vehicle_no}`,
      body: `${route}${r.driver_name ? ` · ${r.driver_name}` : ''}`,
      data: { type: 'trip_completed', vehicle_id: String(id), vehicle_no: r.vehicle_no },
    }).catch(() => {});
  }

  res.json({ item });
});

router.delete('/:id', requireRole('owner'), (req, res) => {
  const info = db.prepare('DELETE FROM vehicles WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;