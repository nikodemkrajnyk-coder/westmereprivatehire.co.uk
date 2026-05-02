const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getDb } = require('./db');

const router = express.Router();

// Primary: iCloud (syncs to all Apple devices automatically — Mac only)
const ICLOUD_DIR = path.join(
  os.homedir(),
  'Library', 'Mobile Documents', 'com~apple~CloudDocs',
  'WestmereBackups'
);

// Secondary / Railway: if SQLITE_DB is set (Railway Volume mounted at /data),
// save backups to /data/backups/ so they persist across redeploys.
// Otherwise fall back to ./data/backups/ alongside the repo (local dev).
const LOCAL_DIR = process.env.SQLITE_DB
  ? path.join(path.dirname(process.env.SQLITE_DB.trim()), 'backups')
  : path.join(__dirname, '..', 'data', 'backups');

// Runtime state
let lastBackupAt = null;
let lastBackupFile = null;
let lastBackupSizeBytes = null;
let lastBackupError = null;
let backupCount = 0;
let errorCount = 0;
let backupTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isICloudAvailable() {
  try {
    const parent = path.join(
      os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'
    );
    return fs.existsSync(parent);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rolling retention — keep last 30 daily + last 4 weekly beyond that.
// Backup filenames must match: westmere-YYYY-MM-DDTHH-MM-SS.db
// ---------------------------------------------------------------------------
function pruneBackups(dir) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter(f => /^westmere-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse(); // newest first
  } catch {
    return { kept: 0, deleted: 0 };
  }

  const toKeep = new Set();

  // Group by calendar day — keep newest per day, take last 30 days
  const byDay = {};
  for (const f of files) {
    const day = f.slice(9, 19); // 'YYYY-MM-DD'
    if (!byDay[day]) byDay[day] = f;
  }
  Object.keys(byDay).sort().reverse().slice(0, 30).forEach(d => toKeep.add(byDay[d]));

  // For files not already kept, group by ISO week — keep newest per week, take last 4
  const byWeek = {};
  for (const f of files) {
    if (toKeep.has(f)) continue;
    const dateStr = f.slice(9, 19);
    const d = new Date(dateStr + 'T12:00:00Z');
    // ISO week: Thursday of the week sets the year
    const thu = new Date(d);
    thu.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
    const week = Math.ceil((((thu - yearStart) / 86400000) + 1) / 7);
    const weekKey = `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    if (!byWeek[weekKey]) byWeek[weekKey] = f;
  }
  Object.keys(byWeek).sort().reverse().slice(0, 4).forEach(w => toKeep.add(byWeek[w]));

  // Delete everything not in toKeep
  let deleted = 0;
  for (const f of files) {
    if (!toKeep.has(f)) {
      try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (e) {
        console.error('[BACKUP] Could not delete old backup:', f, e.message);
      }
    }
  }
  return { kept: toKeep.size, deleted };
}

// ---------------------------------------------------------------------------
// Core backup — uses better-sqlite3 .backup() (SQLite Online Backup API).
// Safe during live writes, consistent with WAL mode, atomic copy.
// ---------------------------------------------------------------------------
async function runBackup() {
  const db = getDb();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `westmere-${ts}.db`;

  ensureDir(LOCAL_DIR);

  const icloud = isICloudAvailable();
  let icloudPath = null;

  if (icloud) {
    ensureDir(ICLOUD_DIR);
    icloudPath = path.join(ICLOUD_DIR, filename);
  }

  const localPath = path.join(LOCAL_DIR, filename);

  try {
    // Backup to iCloud first (if available) — this is the source of truth
    if (icloud) {
      await db.backup(icloudPath);
      // Also write to local (copy from freshly-created iCloud backup)
      fs.copyFileSync(icloudPath, localPath);
    } else {
      // iCloud not available — write local only
      await db.backup(localPath);
    }

    // Verify the backup file was actually written and is non-empty
    const stat = fs.statSync(localPath);
    if (stat.size === 0) {
      throw new Error('Backup file is 0 bytes — database may be empty or backup failed');
    }
    lastBackupSizeBytes = stat.size;
  } catch (e) {
    lastBackupError = e.message;
    errorCount++;
    throw e; // re-throw so callers know it failed
  }

  // Prune old backups in both locations
  const localPrune = pruneBackups(LOCAL_DIR);
  const icloudPrune = icloud ? pruneBackups(ICLOUD_DIR) : null;

  lastBackupAt = new Date().toISOString();
  lastBackupFile = filename;
  lastBackupError = null; // clear any previous error on success
  backupCount++;

  const icloudMsg = icloud
    ? ` | iCloud: ${icloudPrune.kept} kept, ${icloudPrune.deleted} pruned`
    : ' | iCloud: unavailable (local only)';

  console.log(
    `[BACKUP] ✓ #${backupCount} ${filename}` +
    ` | ${(lastBackupSizeBytes / 1024).toFixed(1)} KB` +
    ` | Local: ${localPrune.kept} kept, ${localPrune.deleted} pruned` +
    icloudMsg
  );

  return { filename, localPath, icloudPath, icloudAvailable: icloud, sizeBytes: lastBackupSizeBytes };
}

// ---------------------------------------------------------------------------
// JSON data export — all table rows, human-readable. Separate from the
// SQLite binary backup above. Used by the /export download route.
// ---------------------------------------------------------------------------
function exportAllJson() {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const dump = {};
  for (const t of tables) {
    dump[t.name] = db.prepare('SELECT * FROM ' + t.name).all();
  }
  dump._exported_at = new Date().toISOString();
  dump._version = 'westmere-backup-v2';
  return dump;
}

// ---------------------------------------------------------------------------
// Auto-backup scheduler — called once from server/index.js on startup
// ---------------------------------------------------------------------------
function startAutoBackup() {
  const icloud = isICloudAvailable();
  const primary = icloud ? ICLOUD_DIR : LOCAL_DIR + ' (iCloud unavailable)';

  console.log('[BACKUP] Auto-backup enabled — on start + every 6 hours');
  console.log(`[BACKUP] Primary destination: ${primary}`);
  console.log('[BACKUP] Retention: 30 daily + 4 weekly rolling');

  // Run immediately on server start
  runBackup()
    .then(r => console.log(`[BACKUP] Startup backup complete → ${r.filename}`))
    .catch(e => console.error('[BACKUP] Startup backup failed:', e.message));

  // Then every 6 hours
  backupTimer = setInterval(() => {
    runBackup().catch(e => console.error('[BACKUP] Scheduled backup failed:', e.message));
  }, 6 * 60 * 60 * 1000);

  // Final backup on graceful shutdown (SIGTERM from Mac restart / process manager)
  process.once('SIGTERM', () => {
    console.log('[BACKUP] SIGTERM received — running final backup before shutdown...');
    if (backupTimer) clearInterval(backupTimer);
    runBackup()
      .then(r => { console.log(`[BACKUP] Shutdown backup complete → ${r.filename}`); process.exit(0); })
      .catch(e => { console.error('[BACKUP] Shutdown backup failed:', e.message); process.exit(1); });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/backup/status — health summary for admin dashboard
router.get('/status', (req, res) => {
  if (!['owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const icloud = isICloudAvailable();
  let localCount = 0;
  let icloudCount = null;

  try { localCount = fs.readdirSync(LOCAL_DIR).filter(f => f.endsWith('.db')).length; } catch {}
  try {
    if (icloud) icloudCount = fs.readdirSync(ICLOUD_DIR).filter(f => f.endsWith('.db')).length;
  } catch {}

  res.json({
    ok: true,
    lastBackupAt,
    lastBackupFile,
    lastBackupSizeBytes,
    lastBackupError,
    backupCount,
    errorCount,
    icloudAvailable: icloud,
    icloudDir: icloud ? ICLOUD_DIR : null,
    localDir: LOCAL_DIR,
    localFileCount: localCount,
    icloudFileCount: icloudCount,
    intervalHours: 6,
    retentionPolicy: '30 daily + 4 weekly'
  });
});

// GET /api/backup/list — list backup .db files from both locations
router.get('/list', (req, res) => {
  if (!['owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  ensureDir(LOCAL_DIR);
  const icloud = isICloudAvailable();

  const readDir = (dir) => {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.db'))
        .sort()
        .reverse()
        .slice(0, 50)
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { filename: f, sizeBytes: stat.size, created: stat.mtime.toISOString() };
        });
    } catch {
      return [];
    }
  };

  res.json({
    ok: true,
    localBackups: readDir(LOCAL_DIR),
    icloudBackups: icloud ? readDir(ICLOUD_DIR) : null,
    icloudAvailable: icloud
  });
});

// POST /api/backup/save — trigger a manual backup immediately
router.post('/save', async (req, res) => {
  if (!['owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    console.log(`[BACKUP] Manual backup triggered by ${req.auth.id} (${req.auth.role})`);
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[BACKUP] Manual backup failed:', e.message);
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});


// GET /api/backup/export — download a full JSON data dump (all tables)
router.get('/export', (req, res) => {
  if (!['owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const data = exportAllJson();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Disposition', `attachment; filename="westmere-data-${ts}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
  } catch (e) {
    console.error('[BACKUP] JSON export failed:', e.message);
    res.status(500).json({ error: 'Export failed: ' + e.message });
  }
});

module.exports = router;
module.exports.startAutoBackup = startAutoBackup;
module.exports.runBackup = runBackup;
