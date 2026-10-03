// routes/attendance.js — daily attendance + auto-calculated salary.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();
router.use(authRequired);

const VALID = new Set(['present', 'absent', 'half_day']);

function row(payload) {
  const date = String(payload.date || '').slice(0, 10); // YYYY-MM-DD
  const status = VALID.has(payload.status) ? payload.status : 'present';
  return {
    labor_id: Number(payload.labor_id),
    date,
    status,
    overtime_hours: Number(payload.overtime_hours ?? 0),
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&labor_id=
router.get('/', (req, res) => {
  const { from, to, labor_id } = req.query;
  const clauses = [];
  const params = [];
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to)   { clauses.push('date <= ?'); params.push(to); }
  if (labor_id) { clauses.push('labor_id = ?'); params.push(Number(labor_id)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT a.*, l.name AS labor_name, l.daily_wage
              FROM attendance a
              JOIN labor l ON l.id = a.labor_id
              ${where}
              ORDER BY date DESC, a.id DESC`)
    .all(...params);
  res.json({ items: rows });
});

// POST /api/attendance  { labor_id, date, status, overtime_hours, notes }
router.post('/', requireRole('owner'), (req, res) => {
  const r = row(req.body);
  if (!r.labor_id || !r.date) return res.status(400).json({ error: 'labor_id and date are required' });
  const labor = db.prepare('SELECT id FROM labor WHERE id = ?').get(r.labor_id);
  if (!labor) return res.status(400).json({ error: 'Unknown labor_id' });

  // Upsert: one row per (labor_id, date)
  const existing = db
    .prepare('SELECT id FROM attendance WHERE labor_id = ? AND date = ?')
    .get(r.labor_id, r.date);

  if (existing) {
    db.prepare(
      `UPDATE attendance SET status=@status, overtime_hours=@overtime_hours, notes=@notes WHERE id=@id`
    ).run({ ...r, id: existing.id });
  } else {
    db.prepare(
      `INSERT INTO attendance (labor_id, date, status, overtime_hours, notes)
       VALUES (@labor_id, @date, @status, @overtime_hours, @notes)`
    ).run(r);
  }
  const rowOut = db
    .prepare(`SELECT a.*, l.name AS labor_name, l.daily_wage
              FROM attendance a JOIN labor l ON l.id = a.labor_id
              WHERE a.labor_id = ? AND a.date = ?`)
    .get(r.labor_id, r.date);

  // Notify owners when a worker (not an owner) marks attendance.
  // Skip when the actor themselves is an owner (they don't need a self-ping).
  if (req.user.role === 'worker') {
    const statusLabel = r.status === 'present' ? 'Present'
      : r.status === 'half_day' ? '½ day' : 'Absent';
    const ot = r.overtime_hours > 0 ? ` (+${r.overtime_hours}h OT)` : '';
    push.sendToAllOwners({
      title: `${rowOut.labor_name} marked ${statusLabel}`,
      body: `${r.date}${ot}`,
      data: { type: 'attendance_marked', labor_id: String(r.labor_id), date: r.date, status: r.status },
    }).catch(() => {});
  }

  res.status(201).json({ item: rowOut });
});

// GET /api/attendance/salary/:id?from=&to=
// Calculates due salary from attendance log.
router.get('/salary/:id', (req, res) => {
  const laborId = Number(req.params.id);
  const labor = db.prepare('SELECT * FROM labor WHERE id = ?').get(laborId);
  if (!labor) return res.status(404).json({ error: 'Worker not found' });

  const { from, to } = req.query;
  const clauses = ['labor_id = ?'];
  const params = [laborId];
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to)   { clauses.push('date <= ?'); params.push(to); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = db.prepare(`SELECT * FROM attendance ${where} ORDER BY date ASC`).all(...params);

  let fullDays = 0, halfDays = 0, absentDays = 0, overtimeHours = 0;
  for (const r of rows) {
    overtimeHours += r.overtime_hours || 0;
    if (r.status === 'present') fullDays++;
    else if (r.status === 'half_day') halfDays++;
    else if (r.status === 'absent') absentDays++;
  }

  const base     = labor.daily_wage * (fullDays + 0.5 * halfDays);
  const overtime = overtimeHours * Math.max(0, Number(labor.overtime_rate ?? 0) || Math.round(labor.daily_wage / 8));
  const total    = base + overtime;

  res.json({
    labor: { id: labor.id, name: labor.name, role: labor.role, daily_wage: labor.daily_wage },
    period: { from: from || null, to: to || null },
    summary: { fullDays, halfDays, absentDays, overtimeHours },
    earnings: { base, overtime, total },
  });
});

module.exports = router;