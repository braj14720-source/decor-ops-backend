// routes/import.js — bring inventory in from a Google Sheets URL.
// Two endpoints:
//   POST /api/import/inventory/preview  { url }  — parses, returns preview rows
//   POST /api/import/inventory/confirm  { url, replace? } — actually inserts
//
// URL handling:
//   - Pasted "Publish to web" CSV URL (ends in output=csv)  → fetched directly
//   - Standard /spreadsheets/d/{ID}/edit URL                → converted to
//     /spreadsheets/d/{ID}/export?format=csv&gid={gid}
//   - Plain /d/{ID}/ URL                                    → first sheet via /export?format=csv
//
// If your sheet isn't published to the web, the fetch will fail. The user must
// do File → Share → Publish to web → CSV once, then paste the URL.

const express = require('express');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on remote sheets

function normalizeSheetUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const url = input.trim();
  if (!/^https?:\/\//i.test(url)) return null;

  // Already a CSV export URL — use as-is.
  if (/[?&](?:output|format)=csv\b/i.test(url)) return url;

  // /spreadsheets/d/{ID}/edit[?usp=...]#gid={GID}
  const editMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)\/edit/i);
  if (editMatch) {
    const id = editMatch[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }

  // /spreadsheets/d/{ID}/ (no edit) — default to first sheet
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (idMatch) {
    return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=0`;
  }

  // Already looks like a CSV download
  if (/\.csv(\?|$)/i.test(url)) return url;

  return null;
}

// Map a row's header → canonical field. Case-insensitive, with synonyms.
// Matching is done on a "normalized" form (lowercase, currency/unit suffixes
// stripped) so headers like "Unit Price (₹)", "Unit Price (INR)", "Price (Rs.)"
// all collapse to the same canonical column.
const FIELD_ALIASES = {
  name:       ['name', 'item', 'item name', 'material', 'material name', 'product', 'description'],
  category:   ['category', 'cat', 'type', 'group'],
  unit:       ['unit', 'units', 'uom', 'measure'],
  quantity:   ['quantity', 'qty', 'stock', 'count', 'balance'],
  unit_price: ['unit_price', 'unit price', 'price', 'rate', 'cost', 'mrp'],
  supplier:   ['supplier', 'vendor', 'source'],
  notes:      ['notes', 'note', 'remarks', 'comment'],
};

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    // strip common unit/currency suffixes: (₹), (inr), (rs.), (rs), (usd), (per kg), etc.
    .replace(/\((?:₹|inr|rs\.?|rs|usd|\$|eur|per\s+\w+)\)/gi, '')
    // collapse commas/underscores/dots into spaces
    .replace(/[,_.\-:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHeaderMap(headers) {
  const map = {};
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  const norm = lower.map(normalizeHeader);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const normalizedAliases = aliases.map(normalizeHeader);
    const idx = norm.findIndex((h) => normalizedAliases.includes(h));
    if (idx >= 0) map[canonical] = headers[idx];
  }
  return map;
}

function coerceNumber(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[₹$,\s]/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseRows(csvText) {
  const records = parse(csvText, {
    columns: (h) => h.map((c) => String(c || '').trim()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (!records.length) return { headers: [], map: {}, items: [] };
  const headers = Object.keys(records[0]);
  const map = buildHeaderMap(headers);
  const items = records.map((row) => ({
    name:       row[map.name] || '',
    category:   map.category ? (row[map.category] || null) : null,
    unit:       map.unit ? (row[map.unit] || 'pcs') : 'pcs',
    quantity:   map.quantity ? coerceNumber(row[map.quantity]) : 0,
    unit_price: map.unit_price ? coerceNumber(row[map.unit_price]) : 0,
    supplier:   map.supplier ? (row[map.supplier] || null) : null,
    notes:      map.notes ? (row[map.notes] || null) : null,
  })).filter((it) => it.name && it.name.trim());

  return { headers, map, items };
}

async function fetchSheetCsv(rawUrl) {
  const url = normalizeSheetUrl(rawUrl);
  if (!url) throw new Error('That doesn\'t look like a Google Sheets URL.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'DecorOps/1.0' },
    });
  } catch (e) {
    throw new Error(
      `Could not fetch the sheet. Make sure it's published to the web ` +
      `(File → Share → Publish to web → Comma-separated values). (${e.message})`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Sheet fetch failed (${res.status}). Is it published to the web as CSV?`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`Sheet is too large (${(buf.length / 1024 / 1024).toFixed(1)} MB > 5 MB).`);
  }
  return { url, text: buf.toString('utf8') };
}

// POST /api/import/inventory/preview  { url }
router.post('/inventory/preview', requireRole('owner'), async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const { url: finalUrl, text } = await fetchSheetCsv(url);
    const { headers, map, items } = parseRows(text);
    res.json({
      source_url: finalUrl,
      detected_headers: headers,
      column_map: map,
      preview: items.slice(0, 20),
      total: items.length,
    });
  } catch (e) { next(e); }
});

// POST /api/import/inventory/confirm  { url }
router.post('/inventory/confirm', requireRole('owner'), async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const { text } = await fetchSheetCsv(url);
    const { items } = parseRows(text);
    if (!items.length) return res.json({ inserted: 0, total: 0 });

    const stmt = db.prepare(
      `INSERT INTO inventory (name, category, unit, quantity, unit_price, supplier, notes)
       VALUES (@name, @category, @unit, @quantity, @unit_price, @supplier, @notes)`
    );
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const r of rows) {
        stmt.run(r);
        n++;
      }
      return n;
    });
    const inserted = tx(items);
    res.json({ inserted, total: items.length });
  } catch (e) { next(e); }
});

module.exports = router;