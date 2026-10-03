// routes/inventory.js — CRUD for materials.
const express = require('express');
const db = require('../db');
const { authRequired, requireWrite, requireDelete } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();
router.use(authRequired);

function row(payload) {
  return [
    String(payload.name || '').trim(),
    payload.category ? String(payload.category).trim() : null,
    payload.unit ? String(payload.unit).trim() : 'pcs',
    Number(payload.quantity ?? 0),
    Number(payload.unit_price ?? 0),
    payload.supplier ? String(payload.supplier).trim() : null,
    payload.barcode ? String(payload.barcode).trim() : null,
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

const COLS = '(name, category, unit, quantity, unit_price, supplier, barcode, notes)';
const PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?)';

// GET /api/inventory
router.get('/', async (_req, res, next) => {
  try {
    const items = await db.all('SELECT * FROM inventory ORDER BY datetime(updated_at) DESC, id DESC');
    res.json({ items });
  } catch (e) { next(e); }
});

// GET /api/inventory/by-barcode/:code  — fast lookup for the scanner
router.get('/by-barcode/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ error: 'barcode is required' });
    const item = await db.get(
      'SELECT * FROM inventory WHERE barcode = ? ORDER BY id DESC LIMIT 1',
      [code],
    );
    if (!item) return res.status(404).json({ error: 'No item with that barcode' });
    res.json({ item });
  } catch (e) { next(e); }
});

// POST /api/inventory
router.post('/', requireWrite, async (req, res, next) => {
  try {
    const r = row(req.body);
    if (!r[0]) return res.status(400).json({ error: 'name is required' });
    if (r[6]) {
      const dup = await db.get('SELECT id FROM inventory WHERE barcode = ?', [r[6]]);
      if (dup) return res.status(409).json({ error: 'Barcode already in use' });
    }
    const info = await db.run(
      `INSERT INTO inventory ${COLS} VALUES ${PLACEHOLDERS}`,
      r,
    );
    const item = await db.get('SELECT * FROM inventory WHERE id = ?', [info.lastInsertRowid]);
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

// PUT /api/inventory/:id
router.put('/:id', requireWrite, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM inventory WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const r = row({ ...existing, ...req.body });
    if (r[6] && r[6] !== existing.barcode) {
      const dup = await db.get('SELECT id FROM inventory WHERE barcode = ? AND id != ?', [r[6], id]);
      if (dup) return res.status(409).json({ error: 'Barcode already in use' });
    }
    await db.run(
      `UPDATE inventory SET
         name=?, category=?, unit=?,
         quantity=?, unit_price=?,
         supplier=?, barcode=?, notes=?,
         updated_at = datetime('now')
       WHERE id=?`,
      [...r, id],
    );
    const item = await db.get('SELECT * FROM inventory WHERE id = ?', [id]);

    // Low-stock push: notify owners if quantity just dropped at or below
    // *any* owner's threshold. Only fires on decreases to avoid spamming on
    // restocks.
    if (r[3] < existing.quantity) {
      try {
        const owners = await db.all(
          "SELECT u.id AS user_id, COALESCE(s.low_stock_threshold, 5) AS threshold " +
          "FROM users u LEFT JOIN user_settings s ON s.user_id = u.id " +
          "WHERE u.role = 'super_admin' AND u.active = 1",
        );
        const crossings = owners.filter((o) => existing.quantity > o.threshold && r[3] <= o.threshold);
        if (crossings.length) {
          push.sendToAllOwners({
            title: `Low stock: ${item.name}`,
            body: `${item.quantity} ${item.unit || 'pcs'} remaining (≤ ${crossings[0].threshold}).`,
            data: { type: 'low_stock', item_id: String(item.id), item_name: item.name },
          }).catch(() => {});
        }
      } catch (_) { /* best effort */ }
    }

    res.json({ item });
  } catch (e) { next(e); }
});

// DELETE /api/inventory/:id
router.delete('/:id', requireDelete, async (req, res, next) => {
  try {
    const info = await db.run('DELETE FROM inventory WHERE id = ?', [Number(req.params.id)]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;