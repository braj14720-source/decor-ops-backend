// routes/inventory.js — CRUD for materials.
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const push = require('../services/push');

const router = express.Router();
router.use(authRequired);

function row(payload) {
  return {
    name: String(payload.name || '').trim(),
    category: payload.category ? String(payload.category).trim() : null,
    unit: payload.unit ? String(payload.unit).trim() : 'pcs',
    quantity: Number(payload.quantity ?? 0),
    unit_price: Number(payload.unit_price ?? 0),
    supplier: payload.supplier ? String(payload.supplier).trim() : null,
    barcode: payload.barcode ? String(payload.barcode).trim() : null,
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

// GET /api/inventory
router.get('/', (req, res) => {
  const items = db
    .prepare('SELECT * FROM inventory ORDER BY datetime(updated_at) DESC, id DESC')
    .all();
  res.json({ items });
});

// GET /api/inventory/by-barcode/:code  — fast lookup for the scanner
router.get('/by-barcode/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'barcode is required' });
  const item = db
    .prepare('SELECT * FROM inventory WHERE barcode = ? ORDER BY id DESC LIMIT 1')
    .get(code);
  if (!item) return res.status(404).json({ error: 'No item with that barcode' });
  res.json({ item });
});

// POST /api/inventory
router.post('/', (req, res) => {
  const r = row(req.body);
  if (!r.name) return res.status(400).json({ error: 'name is required' });
  if (r.barcode) {
    const dup = db.prepare('SELECT id FROM inventory WHERE barcode = ?').get(r.barcode);
    if (dup) return res.status(409).json({ error: 'Barcode already in use' });
  }
  const info = db
    .prepare(
      `INSERT INTO inventory (name, category, unit, quantity, unit_price, supplier, barcode, notes)
       VALUES (@name, @category, @unit, @quantity, @unit_price, @supplier, @barcode, @notes)`
    )
    .run(r);
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item });
});

// PUT /api/inventory/:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const r = row({ ...existing, ...req.body });
  if (r.barcode && r.barcode !== existing.barcode) {
    const dup = db.prepare('SELECT id FROM inventory WHERE barcode = ? AND id != ?').get(r.barcode, id);
    if (dup) return res.status(409).json({ error: 'Barcode already in use' });
  }
  db.prepare(
    `UPDATE inventory SET
       name=@name, category=@category, unit=@unit,
       quantity=@quantity, unit_price=@unit_price,
       supplier=@supplier, barcode=@barcode, notes=@notes,
       updated_at = datetime('now')
     WHERE id=@id`
  ).run({ ...r, id });
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);

  // Low-stock push: notify owners if quantity just dropped at or below
  // *any* owner's threshold. Only fires on decreases to avoid spamming on
  // restocks.
  if (r.quantity < existing.quantity) {
    try {
      const owners = db
        .prepare("SELECT u.id AS user_id, COALESCE(s.low_stock_threshold, 5) AS threshold " +
                 "FROM users u LEFT JOIN user_settings s ON s.user_id = u.id " +
                 "WHERE u.role = 'owner' AND u.active = 1")
        .all();
      const crossings = owners.filter((o) => existing.quantity > o.threshold && r.quantity <= o.threshold);
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
});

// DELETE /api/inventory/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM inventory WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;