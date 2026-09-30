// db.js — SQLite schema + connection (better-sqlite3, synchronous).
// Tables:
//   users           — app users (owners + workers) for login + roles
//   inventory       — materials catalog
//   labor           — worker profile + standard daily wage
//   attendance      — daily presence (one row per worker per date)
//   vehicles        — logistics / trip logs

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'decorops.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('owner','worker')) DEFAULT 'owner',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now'))
  );
`);

// Defensive migration: add `active` column on already-existing DBs.
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('active')) {
  db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}

// Defensive migration: add `barcode` column to inventory (only needed for pre-existing DBs
// that were created without it — fresh DBs already include the column in CREATE TABLE below).
// Run AFTER CREATE TABLE inventory to avoid "no such table" errors on fresh DBs.

// Auto-bootstrap: if no users exist AND BOOTSTRAP_OWNER_EMAIL + BOOTSTRAP_OWNER_PASSWORD
// are set, create that owner automatically. Convenient for one-shot Render deploys.
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0 &&
    process.env.BOOTSTRAP_OWNER_EMAIL &&
    process.env.BOOTSTRAP_OWNER_PASSWORD) {
  (async () => {
    try {
      const hash = await bcrypt.hash(process.env.BOOTSTRAP_OWNER_PASSWORD, 10);
      db.prepare(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
      ).run(
        process.env.BOOTSTRAP_OWNER_EMAIL.trim().toLowerCase(),
        hash,
        (process.env.BOOTSTRAP_OWNER_NAME || 'Owner').trim(),
        'owner',
      );
      console.log(`[bootstrap] Auto-created owner: ${process.env.BOOTSTRAP_OWNER_EMAIL}`);
    } catch (e) {
      console.error('[bootstrap] Failed:', e.message);
    }
  })();
}

db.exec(`

  CREATE TABLE IF NOT EXISTS inventory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    category     TEXT,
    unit         TEXT,
    quantity     REAL DEFAULT 0,
    unit_price   REAL DEFAULT 0,
    supplier     TEXT,
    barcode      TEXT,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id           INTEGER PRIMARY KEY,
    attendance_remind INTEGER NOT NULL DEFAULT 1,    -- 0/1
    remind_time       TEXT    NOT NULL DEFAULT '09:00',
    low_stock_alerts  INTEGER NOT NULL DEFAULT 1,    -- 0/1
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
    push_token        TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS device_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    token         TEXT    UNIQUE NOT NULL,
    platform      TEXT,
    last_seen_at  TEXT DEFAULT (datetime('now')),
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS labor (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    role         TEXT,
    phone        TEXT,
    daily_wage   REAL DEFAULT 0,
    active       INTEGER DEFAULT 1,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    labor_id     INTEGER NOT NULL,
    date         TEXT NOT NULL,                     -- YYYY-MM-DD
    status       TEXT NOT NULL CHECK (status IN ('present','absent','half_day')) DEFAULT 'present',
    overtime_hours REAL DEFAULT 0,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(labor_id, date),
    FOREIGN KEY (labor_id) REFERENCES labor(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_no   TEXT NOT NULL,
    driver_name  TEXT,
    from_location TEXT,
    to_location  TEXT,
    purpose      TEXT,
    status       TEXT DEFAULT 'pending',            -- pending|in_transit|completed
    departed_at  TEXT,
    arrived_at  TEXT,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );
`);

// Defensive migration: add `barcode` column to inventory (for pre-existing DBs that
// were created before that column existed). The CREATE TABLE above already includes
// the column, so this is a no-op on fresh DBs.
const invCols = db.prepare("PRAGMA table_info(inventory)").all().map(c => c.name);
if (!invCols.includes('barcode')) {
  db.exec("ALTER TABLE inventory ADD COLUMN barcode TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode)");
}

module.exports = db;