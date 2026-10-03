// services/push.js — Firebase Cloud Messaging v1 wrapper.
//
// Initialization: lazy. Set these env vars on the backend to enable push:
//   FIREBASE_SERVICE_ACCOUNT_PATH=/abs/path/to/service-account.json
//   OR
//   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":...}
//
// Until those are set, sendToUser() is a silent no-op so dev still works.

const path = require('path');
const fs = require('fs');
const db = require('../db');

let _admin = null;
let _initialized = false;
let _enabled = false;

function enabled() { return _enabled; }

function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credential = require('firebase-admin').credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
      );
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const p = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      if (!fs.existsSync(p)) {
        console.warn('[push] FIREBASE_SERVICE_ACCOUNT_PATH set but file not found:', p);
        return;
      }
      credential = require('firebase-admin').credential.cert(require(p));
    } else {
      console.warn('[push] Firebase not configured — push notifications disabled. ' +
                   'Set FIREBASE_SERVICE_ACCOUNT_JSON (or _PATH) to enable.');
      return;
    }
    _admin = require('firebase-admin');
    _admin.initializeApp({ credential });
    _enabled = true;
    console.log('[push] Firebase Admin initialized');
  } catch (e) {
    console.error('[push] Failed to initialize Firebase Admin:', e.message);
    _enabled = false;
  }
}

// Send a notification to every device registered for the given user.
async function sendToUser(userId, { title, body, data = {} }) {
  init();
  if (!_enabled) return { skipped: true, sent: 0, failed: 0 };

  await db.ready;
  const tokens = await db.all(
    'SELECT id, token FROM device_tokens WHERE user_id = ?',
    [userId],
  );

  if (!tokens.length) return { skipped: false, sent: 0, failed: 0 };

  const message = {
    tokens: tokens.map((t) => t.token),
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ),
    android: {
      priority: 'high',
      notification: { sound: 'default' },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
  };

  try {
    const res = await _admin.messaging().sendEachForMulticast(message);
    // Drop tokens that are no longer registered.
    const stale = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error) {
        const code = r.error.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          stale.push(tokens[i].id);
        }
      }
    });
    if (stale.length) {
      const placeholders = stale.map(() => '?').join(',');
      await db.run(`DELETE FROM device_tokens WHERE id IN (${placeholders})`, stale);
    }
    return { skipped: false, sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.error('[push] sendEachForMulticast failed:', e.message);
    return { skipped: false, sent: 0, failed: tokens.length, error: e.message };
  }
}

// Send to every active owner in the system — used for shop-wide alerts
// (e.g. a worker just marked a trip completed).
async function sendToAllOwners({ title, body, data = {} }) {
  await db.ready;
  const owners = await db.all(
    "SELECT id FROM users WHERE role = 'owner' AND active = 1",
  );
  let totalSent = 0;
  for (const o of owners) {
    const r = await sendToUser(o.id, { title, body, data });
    if (!r.skipped) totalSent += r.sent;
  }
  return { owners: owners.length, sent: totalSent };
}

module.exports = { init, enabled, sendToUser, sendToAllOwners };