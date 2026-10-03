// routes/events.js — Events with labour allocation (team reallocation planner).
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
//   POST   /api/events/:id/allocations            bulk upsert allocations
//   DELETE /api/events/:id/allocations            clear all allocations for event
//   DELETE /api/events/:id/allocations/:aid      remove one allocation
//   POST   /api/events/:id/calculate             pure-math calculator

const express = require('express');
const db = require('../db');
const { authRequired, requireWrite, requireDelete } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const EVENT_STATUSES = new Set(['planning', 'active', 'completed', 'cancelled']);
const ALLOC_ROLES = new Set(['worker', 'supervisor']);

// ----- pure helpers ----------------------------------------------------------

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
    pm_team_count: supervisor_count,
  };
}

async function recomputeEventTotals(eventId) {
  const srcTeams = await db.all(
    'SELECT worker_count, supervisor_count FROM event_source_teams WHERE event_id = ?',
    [eventId],
  );
  const totalWorkers = srcTeams.reduce((acc, t) => acc + (t.worker_count || 0), 0);
  const totalSupervisors = srcTeams.reduce((acc, t) => acc + (t.supervisor_count || 0), 0);
  await db.run(
    `UPDATE events
        SET total_workers = ?,
            num_source_teams = ?,
            num_pm_teams = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    [totalWorkers, srcTeams.length, totalSupervisors, eventId],
  );
}

// ----- events CRUD -----------------------------------------------------------

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
    res.json({ items: rows.map(publicEvent) });
  } catch (e) { next(e); }
});

router.post('/', requireWrite, async (req, res, next) => {
  try {
    const r = row(req.body);
    if (!r.name) return res.status(400).json({ error: 'name is required' });

    const result = await db.run(
      `INSERT INTO events (name, date, location, client_name, status, total_workers, num_source_teams, num_pm_teams, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.name, r.date, r.location, r.client_name, r.status, r.total_workers, r.num_source_teams, r.num_pm_teams, r.notes],
    );
    const eventId = Number(result.lastInsertRowid);

    if (Array.isArray(req.body.source_teams)) {
      for (const st of req.body.source_teams) {
        await db.run(
          `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
           VALUES (?, ?, ?, ?)`,
          [
            eventId,
            String(st.name || '').trim() || 'Unnamed team',
            Math.max(0, Number(st.worker_count) || 0),
            Math.max(0, Number(st.supervisor_count) || 0),
          ],
        );
      }
      await recomputeEventTotals(eventId);
    }

    const created = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    res.status(201).json({ event: publicEvent(created) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const ev = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const source_teams = await db.all(
      'SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC',
      [eventId],
    );
    const allocCountRow = await db.get(
      'SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ?',
      [eventId],
    );
    const supCountRow = await db.get(
      "SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ? AND role = 'supervisor'",
      [eventId],
    );
    const totalSupervisors = source_teams.reduce((a, t) => a + (t.supervisor_count || 0), 0);

    res.json({
      event: publicEvent(ev),
      source_teams: source_teams.map(publicSourceTeam),
      counts: {
        source_team_count: source_teams.length,
        allocation_count: Number(allocCountRow ? allocCountRow.n : 0),
        supervisor_allocations: Number(supCountRow ? supCountRow.n : 0),
        source_team_supervisor_total: totalSupervisors,
      },
    });
  } catch (e) { next(e); }
});

router.put('/:id', requireWrite, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const ev = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const r = row(req.body);
    if (!r.name) return res.status(400).json({ error: 'name is required' });

    await db.run(
      `UPDATE events
          SET name=?, date=?, location=?, client_name=?,
              status=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
      [r.name, r.date, r.location, r.client_name, r.status, r.notes, eventId],
    );
    const updated = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    res.json({ event: publicEvent(updated) });
  } catch (e) { next(e); }
});

router.delete('/:id', requireDelete, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const ev = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    await db.run('DELETE FROM events WHERE id = ?', [eventId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- source teams ---------------------------------------------------------

router.get('/:id/source-teams', async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const rows = await db.all(
      'SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC',
      [eventId],
    );
    res.json({ items: rows.map(publicSourceTeam) });
  } catch (e) { next(e); }
});

router.post('/:id/source-teams', requireWrite, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const ev = await db.get('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const worker_count = Math.max(0, Number(req.body.worker_count) || 0);
    const supervisor_count = Math.max(0, Number(req.body.supervisor_count) || 0);

    const result = await db.run(
      `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
       VALUES (?, ?, ?, ?)`,
      [eventId, name, worker_count, supervisor_count],
    );
    await recomputeEventTotals(eventId);

    const created = await db.get('SELECT * FROM event_source_teams WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json({ source_team: publicSourceTeam(created) });
  } catch (e) { next(e); }
});

router.put('/:id/source-teams/:stid', requireWrite, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const stid = Number(req.params.stid);
    const st = await db.get(
      'SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?',
      [stid, eventId],
    );
    if (!st) return res.status(404).json({ error: 'Source team not found' });

    const name = req.body.name != null ? String(req.body.name).trim() : st.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const worker_count = req.body.worker_count != null
      ? Math.max(0, Number(req.body.worker_count) || 0)
      : st.worker_count;
    const supervisor_count = req.body.supervisor_count != null
      ? Math.max(0, Number(req.body.supervisor_count) || 0)
      : st.supervisor_count;

    await db.run(
      `UPDATE event_source_teams SET name=?, worker_count=?, supervisor_count=? WHERE id=?`,
      [name, worker_count, supervisor_count, stid],
    );
    await recomputeEventTotals(eventId);
    const updated = await db.get('SELECT * FROM event_source_teams WHERE id = ?', [stid]);
    res.json({ source_team: publicSourceTeam(updated) });
  } catch (e) { next(e); }
});

router.delete('/:id/source-teams/:stid', requireDelete, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const stid = Number(req.params.stid);
    const st = await db.get(
      'SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?',
      [stid, eventId],
    );
    if (!st) return res.status(404).json({ error: 'Source team not found' });
    await db.run('DELETE FROM event_source_teams WHERE id = ?', [stid]);
    await recomputeEventTotals(eventId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- allocations ----------------------------------------------------------

router.get('/:id/allocations', async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const rows = await db.all(
      `SELECT a.*,
              l.name   AS labor_name,
              st.name  AS source_team_name
         FROM event_allocations a
         LEFT JOIN labor l ON l.id = a.labor_id
         LEFT JOIN event_source_teams st ON st.id = a.source_team_id
        WHERE a.event_id = ?
        ORDER BY a.pm_team ASC, l.name ASC`,
      [eventId],
    );
    res.json({ items: rows.map(publicAllocation) });
  } catch (e) { next(e); }
});

router.post('/:id/allocations', requireWrite, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const ev = await db.get('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items[] is required' });

    // Validate all labor_ids exist before writing
    const laborIds = [...new Set(items.map((it) => Number(it.labor_id)).filter(Boolean))];
    if (laborIds.length) {
      const placeholders = laborIds.map(() => '?').join(',');
      const found = (await db.all(`SELECT id FROM labor WHERE id IN (${placeholders})`, laborIds))
        .map((r) => r.id);
      const missing = laborIds.filter((id) => !found.includes(id));
      if (missing.length) {
        return res.status(400).json({ error: `Unknown labor_id(s): ${missing.join(', ')}` });
      }
    }

    await db.transaction(async () => {
      for (const it of items) {
        if (!it.labor_id) continue;
        await db.run(
          `INSERT INTO event_allocations (event_id, labor_id, source_team_id, pm_team, role, notes)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id, labor_id) DO UPDATE SET
             source_team_id = excluded.source_team_id,
             pm_team        = excluded.pm_team,
             role           = excluded.role,
             notes          = excluded.notes`,
          [
            eventId,
            Number(it.labor_id),
            it.source_team_id ? Number(it.source_team_id) : null,
            it.pm_team != null ? Number(it.pm_team) : null,
            ALLOC_ROLES.has(it.role) ? it.role : 'worker',
            it.notes ? String(it.notes).trim() : null,
          ],
        );
      }
    });

    await recomputeEventTotals(eventId);

    const rows = await db.all(
      `SELECT a.*,
              l.name   AS labor_name,
              st.name  AS source_team_name
         FROM event_allocations a
         LEFT JOIN labor l ON l.id = a.labor_id
         LEFT JOIN event_source_teams st ON st.id = a.source_team_id
        WHERE a.event_id = ?
        ORDER BY a.pm_team ASC, l.name ASC`,
      [eventId],
    );
    res.status(201).json({ items: rows.map(publicAllocation) });
  } catch (e) { next(e); }
});

router.delete('/:id/allocations', requireDelete, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    await db.run('DELETE FROM event_allocations WHERE event_id = ?', [eventId]);
    await recomputeEventTotals(eventId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/allocations/:aid', requireDelete, async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    const aid = Number(req.params.aid);
    const alloc = await db.get(
      'SELECT * FROM event_allocations WHERE id = ? AND event_id = ?',
      [aid, eventId],
    );
    if (!alloc) return res.status(404).json({ error: 'Allocation not found' });
    await db.run('DELETE FROM event_allocations WHERE id = ?', [aid]);
    await recomputeEventTotals(eventId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- calculator -----------------------------------------------------------

router.post('/:id/calculate', async (req, res) => {
  const result = calculate({
    total_workers: req.body.total_workers,
    supervisor_count: req.body.supervisor_count,
    num_pm_teams: req.body.num_pm_teams,
  });
  res.json(result);
});

module.exports = router;