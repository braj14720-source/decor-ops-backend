// db.js — libSQL/Turso connection (async).
//
// Connection priority:
//   DB_URL / TURSO_DATABASE_URL  →  libsql://...      (production on Turso)
//   (unset)                       →  file:./data/decorops.db   (local dev fallback)
//
// Auth (Turso only):
//   DB_AUTH_TOKEN / TURSO_AUTH_TOKEN  must be set when DB_URL is remote.
//
// Tables:
//   users, inventory, user_settings, device_tokens,
//   labor, attendance, vehicles,
//   events, event_source_teams, event_allocations

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const DB_URL =
  process.env.DB_URL ||
  process.env.TURSO_DATABASE_URL ||
  `file:${path.join(__dirname, 'data', 'decorops.db')}`;
const DB_AUTH_TOKEN =
  process.env.DB_AUTH_TOKEN ||
  process.env.TURSO_AUTH_TOKEN ||
  undefined;

// For local file DBs, ensure the parent directory exists.
if (DB_URL.startsWith('file:')) {
  const fp = DB_URL.slice('file:'.length);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
  } catch (_) {}
}

const client = createClient({ url: DB_URL, authToken: DB_AUTH_TOKEN });

// ---- query helpers ----------------------------------------------------------
// These mimic better-sqlite3's sync surface area but are async, since libSQL
// is async over the wire (Turso) and also async for file:./... in modern versions.

function toArgs(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  // Object-style ({key: value}) — convert in insertion order from the SQL's
  // parameter order is hard, so callers must pass arrays. This branch is unused
  // but kept for safety.
  return Object.values(params);
}

async function run(sql, params = []) {
  const args = toArgs(params);
  const r = await client.execute({ sql, args });
  return {
    lastInsertRowid: Number(r.lastInsertRowid),
    changes: Number(r.rowsAffected ?? 0),
  };
}

async function get(sql, params = []) {
  const args = toArgs(params);
  const r = await client.execute({ sql, args });
  return r.rows[0] || null;
}

async function all(sql, params = []) {
  const args = toArgs(params);
  const r = await client.execute({ sql, args });
  return r.rows;
}

async function exec(sql) {
  // Multi-statement SQL string. libSQL supports this.
  return client.execute(sql);
}

async function transaction(fn) {
  // BEGIN / COMMIT / ROLLBACK for an async function. libSQL is sqlite-compatible.
  await client.execute('BEGIN');
  try {
    await fn();
    await client.execute('COMMIT');
  } catch (e) {
    try { await client.execute('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// ---- schema -----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('super_admin','admin','employee','in_house_labour')) DEFAULT 'employee',
  designation   TEXT,                                   -- job role label, e.g. "Operations Manager", "Stage Crew Lead"
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    DEFAULT (datetime('now'))
);

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
  attendance_remind INTEGER NOT NULL DEFAULT 1,
  remind_time       TEXT    NOT NULL DEFAULT '09:00',
  low_stock_alerts  INTEGER NOT NULL DEFAULT 1,
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
  date         TEXT NOT NULL,
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
  status       TEXT DEFAULT 'pending',
  departed_at  TEXT,
  arrived_at   TEXT,
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  date              TEXT,
  location          TEXT,
  client_name       TEXT,
  status            TEXT DEFAULT 'planning',
  total_workers     INTEGER DEFAULT 0,
  num_source_teams  INTEGER DEFAULT 0,
  num_pm_teams      INTEGER DEFAULT 0,
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_source_teams (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL,
  name             TEXT NOT NULL,
  worker_count     INTEGER NOT NULL DEFAULT 0,
  supervisor_count INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL,
  labor_id       INTEGER NOT NULL,
  source_team_id INTEGER,
  pm_team        INTEGER,
  role           TEXT DEFAULT 'worker',
  notes          TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(event_id, labor_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (labor_id) REFERENCES labor(id) ON DELETE CASCADE,
  FOREIGN KEY (source_team_id) REFERENCES event_source_teams(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_event_alloc_event ON event_allocations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_alloc_pm    ON event_allocations(event_id, pm_team);
CREATE INDEX IF NOT EXISTS idx_event_src_team    ON event_source_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode);
`;

// ---- defensive user-table migrations ----------------------------------------
// Runs after CREATE TABLE statements. For existing DBs, this:
//   - adds the `designation` column (new in the super_admin era)
//   - rewrites 'owner' → 'super_admin' and 'worker' → 'employee'
//   - rebuilds the users table if the old CHECK constraint is still active,
//     so new roles like 'in_house_labour' can be inserted
async function runUserMigrations() {
  const cols = await all("SELECT name FROM pragma_table_info('users')");
  const colNames = cols.map((c) => c.name);
  if (!colNames.includes('designation')) {
    await client.execute('ALTER TABLE users ADD COLUMN designation TEXT');
  }

  // Safe to run repeatedly — only touches old values.
  await client.execute("UPDATE users SET role = 'super_admin' WHERE role = 'owner'");
  await client.execute("UPDATE users SET role = 'employee'    WHERE role = 'worker'");

  const defnRow = await get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
  );
  const defn = defnRow ? defnRow.sql : '';
  const allowsNewRoles =
    defn.includes("'super_admin'") && defn.includes("'in_house_labour'");
  if (!allowsNewRoles) {
    // Rebuild the table: rename → create new → copy with role remap → drop old.
    await client.execute('BEGIN');
    try {
      await client.execute('ALTER TABLE users RENAME TO users__legacy');
      await client.execute(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT    UNIQUE NOT NULL,
          password_hash TEXT    NOT NULL,
          name          TEXT    NOT NULL,
          role          TEXT    NOT NULL CHECK (role IN ('super_admin','admin','employee','in_house_labour')) DEFAULT 'employee',
          designation   TEXT,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT    DEFAULT (datetime('now'))
        )
      `);
      await client.execute(
        "INSERT INTO users (id, email, password_hash, name, role, designation, active, created_at) " +
        "SELECT id, email, password_hash, name, " +
        "  CASE role WHEN 'owner' THEN 'super_admin' WHEN 'worker' THEN 'employee' ELSE role END, " +
        "  designation, active, created_at FROM users__legacy"
      );
      await client.execute('DROP TABLE users__legacy');
      await client.execute('COMMIT');
      console.log('[db] Migrated users table to super_admin role schema');
    } catch (e) {
      try { await client.execute('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
}

// ---- bootstrap --------------------------------------------------------------

async function maybeBootstrap() {
  const row = await get('SELECT COUNT(*) AS n FROM users');
  const userCount = row ? Number(row.n) : 0;
  if (userCount > 0) return;
  if (!process.env.BOOTSTRAP_OWNER_EMAIL || !process.env.BOOTSTRAP_OWNER_PASSWORD) {
    console.log('[bootstrap] No users and no BOOTSTRAP_OWNER_* env vars — owner must sign up manually.');
    return;
  }
  try {
    const hash = await bcrypt.hash(process.env.BOOTSTRAP_OWNER_PASSWORD, 10);
    await run(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [
        process.env.BOOTSTRAP_OWNER_EMAIL.trim().toLowerCase(),
        hash,
        (process.env.BOOTSTRAP_OWNER_NAME || 'Owner').trim(),
        'super_admin',
      ],
    );
    console.log(`[bootstrap] Auto-created super admin: ${process.env.BOOTSTRAP_OWNER_EMAIL}`);
  } catch (e) {
    console.error('[bootstrap] Failed:', e.message);
  }
}

// ---- init (async, non-blocking; routes await dbReady if they need to) ------

const dbReady = (async () => {
  try {
    await client.execute('PRAGMA foreign_keys = ON');
    // Split multi-statement schema string and run individually — libSQL's
    // remote (Turso) execute() does not accept multi-statement strings
    // the same way better-sqlite3 did.
    const statements = SCHEMA
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));
    for (const stmt of statements) {
      await client.execute(stmt);
    }
    await runUserMigrations();
    await maybeBootstrap();
    const where = DB_URL.startsWith('libsql://') ? 'Turso (remote)' : `local file ${DB_URL}`;
    console.log(`[db] Connected to ${where} (${statements.length} schema stmts)`);
  } catch (e) {
    console.error('[db] Init failed:', e.message);
  }
})();

module.exports = {
  client,
  ready: dbReady,
  run,
  get,
  all,
  exec,
  transaction,
  // legacy aliases (kept so smoke tests / older imports don't crash)
  query: all,
};