const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db');

const router = express.Router();
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function exportAll() {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const dump = {};
  for (const t of tables) {
    dump[t.name] = db.prepare('SELECT * FROM ' + t.name).all();
  }
  dump._exported_at = new Date().toISOString();
  dump._version = 'westmere-backup-v1';
  return dump;
}

function saveBackup() {
  ensureBackupDir();
  const data = exportAll();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'backup-' + ts + '.json';
  const filepath = path.join(BACKUP_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length > 50) {
    for (const old of files.slice(50)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
  }

  return { filename, path: filepath, tables: Object.keys(data).filter(k => !k.startsWith('_')), records: Object.keys(data).filter(k => !k.startsWith('_')).reduce((s, k) => s + data[k].length, 0) };
}

router.get('/export', (req, res) => {
  if (req.auth.role !== 'owner' && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Owner only' });
  }
  const data = exportAll();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', 'attachment; filename="westmere-backup-' + ts + '.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
});

router.post('/save', (req, res) => {
  if (req.auth.role !== 'owner' && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Owner only' });
  }
  try {
    const result = saveBackup();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/list', (req, res) => {
  if (req.auth.role !== 'owner' && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Owner only' });
  }
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 20)
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    });
  res.json({ ok: true, backups: files });
});

function startAutoBackup() {
  saveBackup();
  setInterval(() => {
    try { saveBackup(); } catch (e) { console.error('[BACKUP] auto-backup failed:', e.message); }
  }, 60 * 60 * 1000);
  console.log('[BACKUP] Auto-backup enabled (hourly to data/backups/)');
}

module.exports = router;
module.exports.saveBackup = saveBackup;
module.exports.startAutoBackup = startAutoBackup;
