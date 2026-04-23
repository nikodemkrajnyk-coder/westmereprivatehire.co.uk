const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db');

const router = express.Router();

// ── Document types drivers must submit ──────────────────────────────────────
const DOC_TYPES = ['dbs', 'insurance', 'mot', 'dvla_front', 'dvla_back', 'phv_driver', 'phv_vehicle'];

// ── Multer storage — /data/driver-docs/{driver_id}/{type}-{timestamp}.ext ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const driverId = req.auth.id;
    const baseDir = process.env.DOCS_DIR ||
      (process.env.SQLITE_DB ? path.join(path.dirname(process.env.SQLITE_DB), 'driver-docs')
                              : path.join(__dirname, '..', 'data', 'driver-docs'));
    const dir = path.join(baseDir, String(driverId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const type = (req.body.type || 'doc').replace(/[^a-z0-9_]/gi, '');
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${type}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPEG, PNG, WebP, or PDF files are accepted'), ok);
  }
});

// ── Helper: only driver can call driver-only routes ──────────────────────────
function requireDriver(req, res, next) {
  if (req.auth.role !== 'driver') return res.status(403).json({ error: 'Driver access only' });
  next();
}
function requireAdminOrOwner(req, res, next) {
  if (!['admin', 'owner'].includes(req.auth.role)) return res.status(403).json({ error: 'Admin/owner access required' });
  next();
}

// ── GET /api/driver/profile ─────────────────────────────────────────────────
router.get('/driver/profile', requireDriver, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, full_name, email, phone, address_line1, address_line2, city, postcode,
           vehicle, reg, phv_no, license_no, onboarding_status, calendar_token
    FROM users WHERE id = ?
  `).get(req.auth.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, profile: user });
});

// ── PATCH /api/driver/profile ───────────────────────────────────────────────
router.patch('/driver/profile', requireDriver, (req, res) => {
  const db = getDb();
  const { full_name, phone, address_line1, address_line2, city, postcode } = req.body;

  const updates = [];
  const values = [];
  const allowed = { full_name, phone, address_line1, address_line2, city, postcode };
  for (const [k, v] of Object.entries(allowed)) {
    if (v !== undefined) {
      updates.push(`${k} = ?`);
      values.push(v === '' ? null : String(v).trim());
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = datetime(\'now\')');
  values.push(req.auth.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// ── GET /api/driver/documents ───────────────────────────────────────────────
router.get('/driver/documents', requireDriver, (req, res) => {
  const db = getDb();
  const docs = db.prepare(`
    SELECT id, driver_id, type, original_name, mime_type, uploaded_at, status, notes
    FROM driver_documents WHERE driver_id = ? ORDER BY uploaded_at DESC
  `).all(req.auth.id);
  res.json({ ok: true, documents: docs });
});

// ── POST /api/driver/documents ──────────────────────────────────────────────
router.post('/driver/documents', requireDriver, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, (req, res) => {
  const { type } = req.body;
  if (!DOC_TYPES.includes(type)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Invalid document type. Must be one of: ${DOC_TYPES.join(', ')}` });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const db = getDb();
  const driverId = req.auth.id;

  // Delete old file + record for this type (replace-in-place)
  const existing = db.prepare('SELECT * FROM driver_documents WHERE driver_id = ? AND type = ?').get(driverId, type);
  if (existing) {
    db.prepare('DELETE FROM driver_documents WHERE id = ?').run(existing.id);
    try { fs.unlinkSync(existing.file_path); } catch (_) {}
  }

  const result = db.prepare(`
    INSERT INTO driver_documents (driver_id, type, file_path, original_name, mime_type, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(driverId, type, req.file.path, req.file.originalname, req.file.mimetype);

  // Mark onboarding as submitted once at least one doc is uploaded
  const user = db.prepare('SELECT onboarding_status FROM users WHERE id = ?').get(driverId);
  if (user && user.onboarding_status === 'pending') {
    db.prepare("UPDATE users SET onboarding_status = 'submitted' WHERE id = ?").run(driverId);
  }

  res.status(201).json({ ok: true, doc: { id: result.lastInsertRowid, type, status: 'pending' } });
});

// ── GET /api/drivers/:id/documents — admin/owner view ───────────────────────
router.get('/drivers/:id/documents', requireAdminOrOwner, (req, res) => {
  const db = getDb();
  const driverId = parseInt(req.params.id, 10);
  if (isNaN(driverId)) return res.status(400).json({ error: 'Invalid driver ID' });

  const driver = db.prepare("SELECT id, full_name, onboarding_status FROM users WHERE id = ? AND role IN ('driver','owner')").get(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const docs = db.prepare(`
    SELECT d.*, u.full_name as reviewed_by_name
    FROM driver_documents d
    LEFT JOIN users u ON d.reviewed_by = u.id
    WHERE d.driver_id = ? ORDER BY d.uploaded_at DESC
  `).all(driverId);

  res.json({ ok: true, driver, documents: docs });
});

// ── GET /api/driver-docs/:driverId/:docId — serve file (auth required) ──────
router.get('/driver-docs/:driverId/:docId', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });

  const driverId = parseInt(req.params.driverId, 10);
  const docId = parseInt(req.params.docId, 10);
  if (isNaN(driverId) || isNaN(docId)) return res.status(400).json({ error: 'Invalid IDs' });

  // Drivers may only view their own docs; admin/owner may view any
  if (req.auth.role === 'driver' && req.auth.id !== driverId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const doc = db.prepare('SELECT * FROM driver_documents WHERE id = ? AND driver_id = ?').get(docId, driverId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${doc.original_name || 'document'}"`);
  res.sendFile(path.resolve(doc.file_path));
});

// ── POST /api/drivers/:id/documents/:docId/approve ──────────────────────────
router.post('/drivers/:id/documents/:docId/approve', requireAdminOrOwner, (req, res) => {
  const db = getDb();
  const driverId = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);

  const doc = db.prepare('SELECT * FROM driver_documents WHERE id = ? AND driver_id = ?').get(docId, driverId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  db.prepare(`
    UPDATE driver_documents SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?, notes = ?
    WHERE id = ?
  `).run(req.auth.id, req.body.notes || null, docId);

  res.json({ ok: true });
});

// ── POST /api/drivers/:id/documents/:docId/reject ───────────────────────────
router.post('/drivers/:id/documents/:docId/reject', requireAdminOrOwner, (req, res) => {
  const db = getDb();
  const driverId = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);

  const doc = db.prepare('SELECT * FROM driver_documents WHERE id = ? AND driver_id = ?').get(docId, driverId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  db.prepare(`
    UPDATE driver_documents SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?, notes = ?
    WHERE id = ?
  `).run(req.auth.id, req.body.notes || null, docId);

  res.json({ ok: true });
});

// ── POST /api/drivers/:id/approve — fully approve driver ────────────────────
router.post('/drivers/:id/approve', requireAdminOrOwner, (req, res) => {
  const db = getDb();
  const driverId = parseInt(req.params.id, 10);

  const driver = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('driver','owner')").get(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  db.prepare("UPDATE users SET onboarding_status = 'approved', updated_at = datetime('now') WHERE id = ?").run(driverId);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_approved', `driver_id:${driverId}`, req.ip);
  } catch (_) {}

  res.json({ ok: true });
});

module.exports = router;
