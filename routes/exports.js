// routes/exports.js — CSV + Excel (XLSX) exports for every module, plus
// payroll summaries. All endpoints require auth and stream a file download.

const express = require('express');
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ISO_TS = new Date().toISOString().slice(0, 10);

function fileHeaders(res, filename, mime) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  return stringify(rows, { header: true });
}

async function rowsToXlsx(sheetName, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Decor Ops';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  if (rows.length) {
    ws.columns = Object.keys(rows[0]).map((key) => ({
      header: key,
      key,
      width: Math.min(48, Math.max(12, key.length + 4)),
    }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' },
    };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb.xlsx.writeBuffer();
}

// --- Inventory ---
router.get('/inventory.csv', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM inventory ORDER BY name ASC');
    const rows = items.map((i) => ({
      name: i.name,
      category: i.category || '',
      unit: i.unit || '',
      quantity: i.quantity,
      unit_price: i.unit_price,
      supplier: i.supplier || '',
      notes: i.notes || '',
    }));
    fileHeaders(res, `inventory-${ISO_TS}.csv`, 'text/csv');
    res.send(rowsToCsv(rows));
  } catch (e) { next(e); }
});

router.get('/inventory.xlsx', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM inventory ORDER BY name ASC');
    const rows = items.map((i) => ({
      Name: i.name,
      Category: i.category || '',
      Unit: i.unit || '',
      Quantity: i.quantity,
      'Unit Price (INR)': i.unit_price,
      Supplier: i.supplier || '',
      Notes: i.notes || '',
    }));
    const buf = await rowsToXlsx('Inventory', rows);
    fileHeaders(res, `inventory-${ISO_TS}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// --- Labor ---
router.get('/labor.csv', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM labor ORDER BY active DESC, name ASC');
    const rows = items.map((l) => ({
      name: l.name,
      role: l.role || '',
      phone: l.phone || '',
      daily_wage: l.daily_wage,
      active: l.active === 1 ? 'yes' : 'no',
      notes: l.notes || '',
    }));
    fileHeaders(res, `labor-${ISO_TS}.csv`, 'text/csv');
    res.send(rowsToCsv(rows));
  } catch (e) { next(e); }
});

router.get('/labor.xlsx', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM labor ORDER BY active DESC, name ASC');
    const rows = items.map((l) => ({
      Name: l.name,
      Role: l.role || '',
      Phone: l.phone || '',
      'Daily Wage (INR)': l.daily_wage,
      Active: l.active === 1 ? 'yes' : 'no',
      Notes: l.notes || '',
    }));
    const buf = await rowsToXlsx('Labor', rows);
    fileHeaders(res, `labor-${ISO_TS}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// --- Vehicles ---
router.get('/vehicles.csv', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM vehicles ORDER BY updated_at DESC');
    const rows = items.map((v) => ({
      vehicle_no: v.vehicle_no,
      driver_name: v.driver_name || '',
      from_location: v.from_location || '',
      to_location: v.to_location || '',
      purpose: v.purpose || '',
      status: v.status,
      departed_at: v.departed_at || '',
      arrived_at: v.arrived_at || '',
      notes: v.notes || '',
    }));
    fileHeaders(res, `vehicles-${ISO_TS}.csv`, 'text/csv');
    res.send(rowsToCsv(rows));
  } catch (e) { next(e); }
});

router.get('/vehicles.xlsx', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM vehicles ORDER BY updated_at DESC');
    const rows = items.map((v) => ({
      'Vehicle No': v.vehicle_no,
      Driver: v.driver_name || '',
      From: v.from_location || '',
      To: v.to_location || '',
      Purpose: v.purpose || '',
      Status: v.status,
      'Departed At': v.departed_at || '',
      'Arrived At': v.arrived_at || '',
      Notes: v.notes || '',
    }));
    const buf = await rowsToXlsx('Vehicles', rows);
    fileHeaders(res, `vehicles-${ISO_TS}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// --- Attendance (raw log) ---
router.get('/attendance.csv', async (req, res, next) => {
  try {
    const { from, to, labor_id } = req.query;
    const clauses = [];
    const params = [];
    if (from)     { clauses.push('a.date >= ?'); params.push(from); }
    if (to)       { clauses.push('a.date <= ?'); params.push(to); }
    if (labor_id) { clauses.push('a.labor_id = ?'); params.push(Number(labor_id)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = (await db.all(
      `SELECT a.date, l.name AS worker, l.role, a.status,
              a.overtime_hours AS ot_hours, l.daily_wage, a.notes
       FROM attendance a
       JOIN labor l ON l.id = a.labor_id
       ${where}
       ORDER BY a.date DESC, l.name`,
      params,
    )).map((r) => ({
      date: r.date,
      worker: r.worker,
      role: r.role || '',
      status: r.status,
      ot_hours: r.ot_hours,
      daily_wage: r.daily_wage,
      earned_inr:
        r.status === 'present' ? r.daily_wage
          : r.status === 'half_day' ? r.daily_wage / 2
          : 0,
      notes: r.notes || '',
    }));
    fileHeaders(res, `attendance-${ISO_TS}.csv`, 'text/csv');
    res.send(rowsToCsv(rows));
  } catch (e) { next(e); }
});

router.get('/attendance.xlsx', async (req, res, next) => {
  try {
    const { from, to, labor_id } = req.query;
    const clauses = [];
    const params = [];
    if (from)     { clauses.push('a.date >= ?'); params.push(from); }
    if (to)       { clauses.push('a.date <= ?'); params.push(to); }
    if (labor_id) { clauses.push('a.labor_id = ?'); params.push(Number(labor_id)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = (await db.all(
      `SELECT a.date, l.name AS worker, l.role, a.status,
              a.overtime_hours AS ot_hours, l.daily_wage, a.notes
       FROM attendance a
       JOIN labor l ON l.id = a.labor_id
       ${where}
       ORDER BY a.date DESC, l.name`,
      params,
    )).map((r) => ({
      Date: r.date,
      Worker: r.worker,
      Role: r.role || '',
      Status: r.status,
      'OT Hours': r.ot_hours,
      'Daily Wage (INR)': r.daily_wage,
      'Earned (INR)':
        r.status === 'present' ? r.daily_wage
          : r.status === 'half_day' ? r.daily_wage / 2
          : 0,
      Notes: r.notes || '',
    }));
    const buf = await rowsToXlsx('Attendance', rows);
    fileHeaders(res, `attendance-${ISO_TS}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// --- Payroll summary (per worker over a period) ---
function computePayrollRow(l, rows) {
  let full = 0, half = 0, absent = 0, ot = 0;
  for (const r of rows) {
    if (r.status === 'present') full++;
    else if (r.status === 'half_day') half++;
    else if (r.status === 'absent') absent++;
    ot += r.overtime_hours || 0;
  }
  const base = l.daily_wage * (full + 0.5 * half);
  const otRate = Math.round(l.daily_wage / 8);
  const overtime = ot * otRate;
  return { full, half, absent, ot, base, overtime, total: base + overtime };
}

router.get('/payroll.csv', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dateClauses = [];
    const dateParams = [];
    if (from) { dateClauses.push('date >= ?'); dateParams.push(from); }
    if (to)   { dateClauses.push('date <= ?'); dateParams.push(to); }

    const workers = await db.all('SELECT * FROM labor ORDER BY name');
    const attSql = `SELECT * FROM attendance WHERE ${[...dateClauses, 'labor_id = ?'].join(' AND ')}`;
    const summaries = [];
    for (const l of workers) {
      const rows = await db.all(attSql, [...dateParams, l.id]);
      const c = computePayrollRow(l, rows);
      summaries.push({
        worker: l.name,
        role: l.role || '',
        phone: l.phone || '',
        daily_wage: l.daily_wage,
        full_days: c.full,
        half_days: c.half,
        absent_days: c.absent,
        overtime_hours: c.ot,
        base_inr: c.base,
        overtime_inr: c.overtime,
        total_payout_inr: c.total,
      });
    }
    fileHeaders(res, `payroll-${from || 'all'}-to-${to || 'all'}.csv`, 'text/csv');
    res.send(rowsToCsv(summaries));
  } catch (e) { next(e); }
});

router.get('/payroll.xlsx', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dateClauses = [];
    const dateParams = [];
    if (from) { dateClauses.push('date >= ?'); dateParams.push(from); }
    if (to)   { dateClauses.push('date <= ?'); dateParams.push(to); }

    const workers = await db.all('SELECT * FROM labor ORDER BY name');
    const attSql = `SELECT * FROM attendance WHERE ${[...dateClauses, 'labor_id = ?'].join(' AND ')}`;
    const outRows = [];
    for (const l of workers) {
      const att = await db.all(attSql, [...dateParams, l.id]);
      const c = computePayrollRow(l, att);
      outRows.push({
        Worker: l.name,
        Role: l.role || '',
        Phone: l.phone || '',
        'Daily Wage (INR)': l.daily_wage,
        'Full Days': c.full,
        'Half Days': c.half,
        'Absent Days': c.absent,
        'Overtime Hours': c.ot,
        'Base (INR)': c.base,
        'Overtime (INR)': c.overtime,
        'Total Payout (INR)': c.total,
      });
    }
    const buf = await rowsToXlsx('Payroll', outRows);
    fileHeaders(res, `payroll-${from || 'all'}-to-${to || 'all'}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// --- Events ---
router.get('/events.csv', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
    const rows = items.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date || '',
      location: e.location || '',
      client_name: e.client_name || '',
      status: e.status,
      total_workers: e.total_workers,
      num_source_teams: e.num_source_teams,
      num_pm_teams: e.num_pm_teams,
      notes: e.notes || '',
      created_at: e.created_at,
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="events-${ISO_TS}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(stringify(rows, { header: true }));
  } catch (e) { next(e); }
});

router.get('/events.xlsx', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
    const rows = items.map((e) => ({
      Name: e.name,
      Date: e.date || '',
      Location: e.location || '',
      Client: e.client_name || '',
      Status: e.status,
      'Total Workers': e.total_workers,
      'Source Teams': e.num_source_teams,
      'PM Teams': e.num_pm_teams,
      Notes: e.notes || '',
      Created: e.created_at,
    }));
    const buf = await rowsToXlsx('Events', rows);
    fileHeaders(res, `events-${ISO_TS}.xlsx`, XLSX_MIME);
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

router.get('/event-allocations.csv', async (_req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT a.*,
              e.name         AS event_name,
              e.date         AS event_date,
              l.name         AS labor_name,
              l.role         AS labor_role,
              st.name        AS source_team_name
         FROM event_allocations a
         JOIN events e ON e.id = a.event_id
         LEFT JOIN labor l ON l.id = a.labor_id
         LEFT JOIN event_source_teams st ON st.id = a.source_team_id
        ORDER BY e.date DESC, a.pm_team ASC, l.name ASC`,
    );
    const out = rows.map((r) => ({
      event: r.event_name,
      event_date: r.event_date || '',
      labor: r.labor_name || '',
      role: r.labor_role || '',
      source_team: r.source_team_name || '',
      pm_team: r.pm_team == null ? '' : r.pm_team,
      alloc_role: r.role,
      notes: r.notes || '',
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-allocations-${ISO_TS}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(stringify(out, { header: true }));
  } catch (e) { next(e); }
});

module.exports = router;