// server.js — Express entry. Loads .env, mounts routes, serves /health.
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
app.use(cors());
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
    console.log(`Decor Ops API running on http://localhost:${PORT}`);
  });
})();