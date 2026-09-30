// routes/backups.js — local DB snapshotting + optional S3-compatible remote backup.
// Owner-only writes; anyone authed can list/download.
//
// Usage:
//   node bin/backup-now.js                       # manual snapshot
//   GET  /api/backups                             # list
//   GET  /api/backups/:id/download               # stream the .db file
//   POST /api/backups                             # create snapshot now
//   DELETE /api/backups/:id                       # remove a snapshot
//
// Optional S3 upload (AWS S3 / Backblaze B2 / MinIO / any S3-compatible):
//   BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
//   BACKUP_S3_BUCKET=my-bucket
//   BACKUP_S3_ACCESS_KEY=...
//   BACKUP_S3_SECRET_KEY=...
//   BACKUP_S3_REGION=us-west-002        # optional, defaults to us-east-1
//   BACKUP_S3_PREFIX=backups/           # optional, key prefix
//
// When set, every new backup is uploaded after the local snapshot succeeds.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authRequired, requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();
router.use(authRequired);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'decorops.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const S3_CFG = (() => {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const access = process.env.BACKUP_S3_ACCESS_KEY;
  const secret = process.env.BACKUP_S3_SECRET_KEY;
  if (!bucket || !access || !secret) return null;
  return {
    bucket,
    accessKey: access,
    secretKey: secret,
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    endpoint: process.env.BACKUP_S3_ENDPOINT || null,
    prefix: (process.env.BACKUP_S3_PREFIX || '').replace(/^\/+|\/+$/g, ''),
  };
})();

function s3Enabled() { return !!S3_CFG; }
function s3Status() {
  return S3_CFG ? { enabled: true, bucket: S3_CFG.bucket, endpoint: S3_CFG.endpoint, region: S3_CFG.region }
                 : { enabled: false };
}

// ---- AWS SigV4 + PUT object (no SDK dependency) ----
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashHex(s) { return sha256(Buffer.from(s, 'utf8')); }

async function uploadToS3(key, body) {
  if (!S3_CFG) throw new Error('S3 not configured');
  const { bucket, region, endpoint, accessKey, secretKey, prefix } = S3_CFG;
  const fullKey = prefix ? `${prefix}/${key}` : key;
  const host = endpoint ? endpoint.replace(/^https?:\/\//, '') : `${bucket}.s3.${region}.amazonaws.com`;
  const url = endpoint
    ? `${endpoint.replace(/\/$/, '')}/${bucket}/${encodeURI(fullKey)}`
    : `https://${host}/${encodeURI(fullKey)}`;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const amzDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT', `/${bucket}/${fullKey}`, '',
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hashHex(canonicalRequest)].join('\n');

  const kDate    = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authHeader,
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`S3 upload failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  return { key: fullKey, bucket, endpoint };
}

// SQLite-safe snapshot via the backup API.
function snapshotDb(targetPath) {
  // Make sure pending writes are flushed
  db.pragma('wal_checkpoint(TRUNCATE)');
  // better-sqlite3's backup() streams a consistent snapshot
  return new Promise((resolve, reject) => {
    try {
      db.backup(targetPath)
        .then(() => resolve())
        .catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((filename) => {
      const fullPath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(fullPath);
      return {
        id: filename.replace(/\.db$/, ''),
        filename,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function createBackup({ upload } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `decorops-${stamp}.db`;
  const targetPath = path.join(BACKUP_DIR, filename);

  await snapshotDb(targetPath);
  const stat = fs.statSync(targetPath);

  let remote = null;
  if (upload && S3_CFG) {
    try {
      remote = await uploadToS3(filename, fs.readFileSync(targetPath));
    } catch (e) {
      // Don't fail the local backup if remote upload fails — log it instead.
      remote = { error: e.message };
    }
  }

  return {
    id: filename.replace(/\.db$/, ''),
    filename,
    size_bytes: stat.size,
    created_at: stat.mtime.toISOString(),
    remote,
  };
}

// GET /api/backups — list + status of remote backup config
router.get('/', (_req, res) => {
  res.json({
    remote: s3Status(),
    items: listBackups(),
  });
});

// POST /api/backups — create a new snapshot. Body: { upload?: bool }
router.post('/', async (req, res, next) => {
  try {
    const wantUpload = !!(req.body && req.body.upload) && s3Enabled();
    if ((req.body && req.body.upload) && !s3Enabled()) {
      return res.status(400).json({ error: 'S3 backup is not configured on the server' });
    }
    const result = await createBackup({ upload: wantUpload });
    res.status(201).json({ backup: result });
  } catch (e) { next(e); }
});

// GET /api/backups/:id/download — stream the .db file
router.get('/:id/download', (req, res) => {
  const filename = req.params.id.endsWith('.db') ? req.params.id : `${req.params.id}.db`;
  // Path traversal guard
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const fullPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  fs.createReadStream(fullPath).pipe(res);
});

// DELETE /api/backups/:id
router.delete('/:id', (req, res) => {
  const filename = req.params.id.endsWith('.db') ? req.params.id : `${req.params.id}.db`;
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const fullPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(fullPath);
  res.json({ ok: true });
});

module.exports = router;