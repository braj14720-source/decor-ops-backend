// server.js — Express entry. Loads .env, mounts routes, serves /health.
//
// CORS hardening — only requests from the official web app origin (and
// localhost during dev) are accepted by browsers. Server-to-server requests
// (curl, mobile apps) still need a valid JWT issued by /api/auth/login.
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const db = require('./db'); // initialize libSQL/Turso connection + schema

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const inventoryRoutes = require('./routes/inventory');
const laborRoutes = require('./routes/labor');
const attendanceRoutes = require('./routes/attendance');
const vehicleRoutes = require('./routes/vehicles');
const eventRoutes = require('./routes/events');
const exportRoutes = require('./routes/exports');
const importRoutes = require('./routes/import');
const backupRoutes = require('./routes/backups');
const settingsRoutes = require('./routes/settings');
const pushRoutes = require('./routes/push');

const app = express();

// CORS allowlist — comma-separated origins. Empty = allow all (dev only).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);   // dev: allow all
    if (!origin) return cb(null, true);                        // server-to-server / curl
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed`));
  },
  credentials: false,
}));

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/labor', laborRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/import', importRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/push', pushRoutes);

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = Number(process.env.PORT || 4000);

// Wait for db init to finish before accepting requests — avoids race between
// schema migrations and the first request hitting an empty DB.
(async () => {
  await db.ready;
  app.listen(PORT, () => {
    const originInfo = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(all — dev)';
    console.log(`Decor Ops API running on http://localhost:${PORT}`);
    console.log(`  CORS origins: ${originInfo}`);
    console.log(`  Allowed login emails: ${process.env.ALLOWED_LOGIN_EMAILS || '(all — dev)'}`);
    console.log(`  Public signup: ${process.env.ALLOW_PUBLIC_SIGNUP === 'true' ? 'ENABLED' : 'DISABLED'}`);
  });
})();