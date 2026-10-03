#!/usr/bin/env node
// bin/seed-owner.js — bootstrap the very first owner account.
// After this, owners create more accounts via the admin UI (POST /api/users).
//
// Usage:
//   node bin/seed-owner.js --email you@example.com --password 'Strong#123' --name "Your Name"
//
// Reads flags from argv. Refuses to run if any owner already exists.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

(async () => {
  const args = parseArgs();
  const email = (args.email || '').toString().trim().toLowerCase();
  const password = (args.password || '').toString();
  const name = (args.name || '').toString().trim();

  if (!email || !password || !name) {
    console.error('Usage: node bin/seed-owner.js --email <e> --password <p> --name "<n>"');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }

  await db.ready;

  const ownerRow = await db.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1",
  );
  const ownerCount = ownerRow ? Number(ownerRow.n) : 0;
  if (ownerCount > 0) {
    console.error(`Refusing to seed: ${ownerCount} active owner(s) already exist.`);
    console.error('Have an existing owner create new accounts via the admin UI (POST /api/users).');
    process.exit(1);
  }

  const exists = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (exists) {
    console.error(`A user with email ${email} already exists.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
    [email, hash, name, 'super_admin'],
  );
  console.log(`✔ Created owner #${info.lastInsertRowid}: ${email} (${name})`);
  console.log('Log in with those credentials, then create more users from the Team screen.');
  process.exit(0);
})();