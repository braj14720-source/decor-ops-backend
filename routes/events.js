// routes/events.js — Events with labour allocation (team reallocation planner).
//
// A user creates an event (e.g. "Wedding — Kumar Family"), adds the source
// teams feeding it (e.g. Rahul's Team 17 workers / 2 supervisors), then
// pulls supervisors out as PM leads and redistributes the balance labour
// across N PM teams. Each worker from the labour pool is assigned to one
// PM team per event.
//
// Endpoints:
//   GET    /api/events                            list events
//   POST   /api/events                            create event (+ optional source_teams in body)
//   GET    /api/events/:id                        get one with source_teams + counts
//   PUT    /api/events/:id                        update event
//   DELETE /api/events/:id                        delete (cascades to source teams + allocations)
//   GET    /api/events/:id/source-teams           list source teams
//   POST   /api/events/:id/source-teams           add source team
//   PUT    /api/events/:id/source-teams/:stid     update source team
//   DELETE /api/events/:id/source-teams/:stid     remove source team
//   GET    /api/events/:id/allocations            list allocations (joined with labor + source_team)
//   POST   /api/events/:id/allocations            bulk upsert allocations (one per labor_id)
//   DELETE /api/events/:id/allocations            clear all allocations for event
//   DELETE /api/events/:id/allocations/:aid      remove one allocation
//   POST   /api/events/:id/calculate             pure-math calculator
//                                                 input: { total_workers, supervisor_count, num_pm_teams }
//                                                 output: { balance, distribution:[n,n,n,...], summary }

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const EVENT_STATUSES = new Set(['planning', 'active', 'completed', 'cancelled']);
const ALLOC_ROLES = new Set(['worker', 'supervisor']);

// ----- helpers --------------------------------------------------------------

function row(payload) {
  return {
    name: String(payload.name || '').trim(),
    date: payload.date ? String(payload.date).slice(0, 10) : null,
    location: payload.location ? String(payload.location).trim() : null,
    client_name: payload.client_name ? String(payload.client_name).trim() : null,
    status: EVENT_STATUSES.has(payload.status) ? payload.status : 'planning',
    total_workers: Number(payload.total_workers ?? 0),
    num_source_teams: Number(payload.num_source_teams ?? 0),
    num_pm_teams: Number(payload.num_pm_teams ?? 0),
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

function publicEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    date: r.date,
    location: r.location,
    client_name: r.client_name,
    status: r.status,
    total_workers: r.total_workers,
    num_source_teams: r.num_source_teams,
    num_pm_teams: r.num_pm_teams,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function publicSourceTeam(r) {
  return {
    id: r.id,
    event_id: r.event_id,
    name: r.name,
    worker_count: r.worker_count,
    supervisor_count: r.supervisor_count,
    created_at: r.created_at,
  };
}

function publicAllocation(r) {
  return {
    id: r.id,
    event_id: r.event_id,
    labor_id: r.labor_id,
    labor_name: r.labor_name || null,
    source_team_id: r.source_team_id,
    source_team_name: r.source_team_name || null,
    pm_team: r.pm_team,
    role: r.role,
    notes: r.notes,
    created_at: r.created_at,
  };
}

// Pure-math calculator. No DB, no side effects. Reused by POST /calculate
// and called internally when allocations change.
function calculate({ total_workers, supervisor_count, num_pm_teams }) {
  total_workers = Math.max(0, Number(total_workers) || 0);
  supervisor_count = Math.max(0, Number(supervisor_count) || 0);
  num_pm_teams = Math.max(0, Number(num_pm_teams) || 0);

  const balance = Math.max(0, total_workers - supervisor_count);

  let distribution = [];
  let summary = '';
  if (num_pm_teams === 0) {
    summary = `${supervisor_count} supervisors, ${balance} balance labour (no PM teams defined yet)`;
  } else {
    const base = Math.floor(balance / num_pm_teams);
    const remainder = balance - base * num_pm_teams;
    distribution = Array.from({ length: num_pm_teams }, (_, i) =>
      i < remainder ? base + 1 : base,
    );
    const big = distribution.filter((n) => n === base + 1).length;
    const small = distribution.filter((n) => n === base).length;
    summary = `${big} × ${base + 1} + ${small} × ${base}`;
  }

  return {
    total_workers,
    supervisor_count,
    num_pm_teams,
    balance,
    distribution,
    summary,
    // convenience: "PM teams" total count for the event = supervisor_count (each
    // supervisor becomes a PM lead for one PM team)
    pm_team_count: supervisor_count,
  };
}

// Recompute event totals from source teams + allocations and write back to the
// event row. Called after any source team or allocation change so the event
// metadata stays in sync with the underlying data.
//
// total_workers   = sum of worker_count across all source teams
// num_source_teams = count of source team rows
// num_pm_teams    = total supervisor count across source teams
//                   (each supervisor becomes a PM lead → one PM team per supervisor).
//                   Independent of how many supervisor allocations exist; the source-team
//                   declaration is the source of truth for the reallocation plan.
function recomputeEventTotals(eventId) {
  const srcTeams = db
    .prepare('SELECT worker_count, supervisor_count FROM event_source_teams WHERE event_id = ?')
    .all(eventId);
  const totalWorkers = srcTeams.reduce((acc, t) => acc + (t.worker_count || 0), 0);
  const totalSupervisors = srcTeams.reduce((acc, t) => acc + (t.supervisor_count || 0), 0);

  db.prepare(
    `UPDATE events
        SET total_workers = ?,
            num_source_teams = ?,
            num_pm_teams = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(totalWorkers, srcTeams.length, totalSupervisors, eventId);
}

// ----- events CRUD ----------------------------------------------------------

// GET /api/events
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM events ORDER BY date DESC, created_at DESC')
    .all();
  res.json({ items: rows.map(publicEvent) });
});

// POST /api/events — body may include `source_teams: [...]` for one-shot creation
router.post('/', requireRole('owner'), (req, res) => {
  const r = row(req.body);
  if (!r.name) return res.status(400).json({ error: 'name is required' });

  const insertEvent = db.prepare(
    `INSERT INTO events (name, date, location, client_name, status, total_workers, num_source_teams, num_pm_teams, notes)
     VALUES (@name, @date, @location, @client_name, @status, @total_workers, @num_source_teams, @num_pm_teams, @notes)`,
  );
  const result = insertEvent.run(r);
  const eventId = result.lastInsertRowid;

  if (Array.isArray(req.body.source_teams)) {
    const insST = db.prepare(
      `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
       VALUES (?, ?, ?, ?)`,
    );
    for (const st of req.body.source_teams) {
      insST.run(
        eventId,
        String(st.name || '').trim() || 'Unnamed team',
        Math.max(0, Number(st.worker_count) || 0),
        Math.max(0, Number(st.supervisor_count) || 0),
      );
    }
    recomputeEventTotals(eventId);
  }

  const created = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  res.status(201).json({ event: publicEvent(created) });
});

// GET /api/events/:id — full event with source teams and aggregate counts
router.get('/:id', (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const source_teams = db
    .prepare('SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC')
    .all(eventId);
  const allocCount = db
    .prepare('SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ?')
    .get(eventId).n;
  const supervisorCount = db
    .prepare("SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ? AND role = 'supervisor'")
    .get(eventId).n;

  const totalSupervisors = source_teams.reduce((a, t) => a + (t.supervisor_count || 0), 0);

  res.json({
    event: publicEvent(ev),
    source_teams: source_teams.map(publicSourceTeam),
    counts: {
      source_team_count: source_teams.length,
      allocation_count: allocCount,
      supervisor_allocations: supervisorCount,
      source_team_supervisor_total: totalSupervisors,
    },
  });
});

// PUT /api/events/:id
router.put('/:id', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const r = row(req.body);
  if (!r.name) return res.status(400).json({ error: 'name is required' });

  db.prepare(
    `UPDATE events
        SET name = @name,
            date = @date,
            location = @location,
            client_name = @client_name,
            status = @status,
            notes = @notes,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({ ...r, id: eventId });

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  res.json({ event: publicEvent(updated) });
});

// DELETE /api/events/:id
router.delete('/:id', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
  res.json({ ok: true });
});

// ----- source teams ---------------------------------------------------------

// GET /api/events/:id/source-teams
router.get('/:id/source-teams', (req, res) => {
  const eventId = Number(req.params.id);
  const rows = db
    .prepare('SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC')
    .all(eventId);
  res.json({ items: rows.map(publicSourceTeam) });
});

// POST /api/events/:id/source-teams
router.post('/:id/source-teams', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const worker_count = Math.max(0, Number(req.body.worker_count) || 0);
  const supervisor_count = Math.max(0, Number(req.body.supervisor_count) || 0);

  const result = db
    .prepare(
      `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
       VALUES (?, ?, ?, ?)`,
    )
    .run(eventId, name, worker_count, supervisor_count);
  recomputeEventTotals(eventId);

  const created = db
    .prepare('SELECT * FROM event_source_teams WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json({ source_team: publicSourceTeam(created) });
});

// PUT /api/events/:id/source-teams/:stid
router.put('/:id/source-teams/:stid', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const stid = Number(req.params.stid);
  const st = db
    .prepare('SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?')
    .get(stid, eventId);
  if (!st) return res.status(404).json({ error: 'Source team not found' });

  const name = req.body.name != null ? String(req.body.name).trim() : st.name;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const worker_count = req.body.worker_count != null
    ? Math.max(0, Number(req.body.worker_count) || 0)
    : st.worker_count;
  const supervisor_count = req.body.supervisor_count != null
    ? Math.max(0, Number(req.body.supervisor_count) || 0)
    : st.supervisor_count;

  db.prepare(
    `UPDATE event_source_teams
        SET name = ?, worker_count = ?, supervisor_count = ?
      WHERE id = ?`,
  ).run(name, worker_count, supervisor_count, stid);
  recomputeEventTotals(eventId);

  const updated = db
    .prepare('SELECT * FROM event_source_teams WHERE id = ?')
    .get(stid);
  res.json({ source_team: publicSourceTeam(updated) });
});

// DELETE /api/events/:id/source-teams/:stid
router.delete('/:id/source-teams/:stid', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const stid = Number(req.params.stid);
  const st = db
    .prepare('SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?')
    .get(stid, eventId);
  if (!st) return res.status(404).json({ error: 'Source team not found' });
  db.prepare('DELETE FROM event_source_teams WHERE id = ?').run(stid);
  recomputeEventTotals(eventId);
  res.json({ ok: true });
});

// ----- allocations ----------------------------------------------------------

// GET /api/events/:id/allocations
router.get('/:id/allocations', (req, res) => {
  const eventId = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT a.*,
              l.name   AS labor_name,
              st.name  AS source_team_name
         FROM event_allocations a
         LEFT JOIN labor l ON l.id = a.labor_id
         LEFT JOIN event_source_teams st ON st.id = a.source_team_id
        WHERE a.event_id = ?
        ORDER BY a.pm_team ASC, l.name ASC`,
    )
    .all(eventId);
  res.json({ items: rows.map(publicAllocation) });
});

// POST /api/events/:id/allocations — bulk upsert
// body: { items: [{ labor_id, source_team_id?, pm_team, role?, notes? }, ...] }
router.post('/:id/allocations', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items[] is required' });

  // Validate all labor_ids exist before writing
  const laborIds = [...new Set(items.map((it) => Number(it.labor_id)).filter(Boolean))];
  if (laborIds.length) {
    const placeholders = laborIds.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT id FROM labor WHERE id IN (${placeholders})`)
      .all(...laborIds)
      .map((r) => r.id);
    const missing = laborIds.filter((id) => !found.includes(id));
    if (missing.length) {
      return res.status(400).json({ error: `Unknown labor_id(s): ${missing.join(', ')}` });
    }
  }

  const upsert = db.prepare(
    `INSERT INTO event_allocations (event_id, labor_id, source_team_id, pm_team, role, notes)
     VALUES (@event_id, @labor_id, @source_team_id, @pm_team, @role, @notes)
     ON CONFLICT(event_id, labor_id) DO UPDATE SET
       source_team_id = excluded.source_team_id,
       pm_team        = excluded.pm_team,
       role           = excluded.role,
       notes          = excluded.notes`,
  );

  const txn = db.transaction((rows) => {
    for (const it of rows) {
      if (!it.labor_id) continue;
      upsert.run({
        event_id: eventId,
        labor_id: Number(it.labor_id),
        source_team_id: it.source_team_id ? Number(it.source_team_id) : null,
        pm_team: it.pm_team != null ? Number(it.pm_team) : null,
        role: ALLOC_ROLES.has(it.role) ? it.role : 'worker',
        notes: it.notes ? String(it.notes).trim() : null,
      });
    }
  });
  txn(items);

  recomputeEventTotals(eventId);

  const rows = db
    .prepare(
      `SELECT a.*,
              l.name   AS labor_name,
              st.name  AS source_team_name
         FROM event_allocations a
         LEFT JOIN labor l ON l.id = a.labor_id
         LEFT JOIN event_source_teams st ON st.id = a.source_team_id
        WHERE a.event_id = ?
        ORDER BY a.pm_team ASC, l.name ASC`,
    )
    .all(eventId);
  res.status(201).json({ items: rows.map(publicAllocation) });
});

// DELETE /api/events/:id/allocations — clear all
router.delete('/:id/allocations', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  db.prepare('DELETE FROM event_allocations WHERE event_id = ?').run(eventId);
  recomputeEventTotals(eventId);
  res.json({ ok: true });
});

// DELETE /api/events/:id/allocations/:aid
router.delete('/:id/allocations/:aid', requireRole('owner'), (req, res) => {
  const eventId = Number(req.params.id);
  const aid = Number(req.params.aid);
  const alloc = db
    .prepare('SELECT * FROM event_allocations WHERE id = ? AND event_id = ?')
    .get(aid, eventId);
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });
  db.prepare('DELETE FROM event_allocations WHERE id = ?').run(aid);
  recomputeEventTotals(eventId);
  res.json({ ok: true });
});

// ----- calculator -----------------------------------------------------------

// POST /api/events/:id/calculate
// body: { total_workers, supervisor_count, num_pm_teams }
// returns the reallocation plan
router.post('/:id/calculate', (req, res) => {
  const result = calculate({
    total_workers: req.body.total_workers,
    supervisor_count: req.body.supervisor_count,
    num_pm_teams: req.body.num_pm_teams,
  });
  res.json(result);
});

module.exports = router;
