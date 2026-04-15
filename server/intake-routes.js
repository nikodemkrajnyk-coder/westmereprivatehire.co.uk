// ── Smart Intake routes ────────────────────────────────────────────────
// Mounted at /api/intake (protected, admin/owner/driver only).
//
// GET    /time-off                     — list all time-off windows
// POST   /time-off                     — create a window { date, end_date?, start_time?, end_time?, reason?, driver_id? }
// DELETE /time-off/:id                 — remove a window
// POST   /bookings/:id/reevaluate      — re-run Claude feasibility
// POST   /bookings/:id/assign-driver   — { driver_id } — assigns + clears needs_reassignment
// POST   /bookings/:id/draft-apology   — returns drafted apology { subject, body }
// POST   /bookings/:id/decline         — marks cancelled (operator can paste apology elsewhere)
// GET    /status                       — { configured }

const express = require('express');
const { getDb } = require('./db');
const intake = require('./intake');

const router = express.Router();

function staffOnly(req, res, next) {
  const role = req.auth && req.auth.role;
  if (!['admin', 'owner', 'driver'].includes(role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

router.get('/status', (req, res) => {
  res.json({ ok: true, configured: intake.isConfigured() });
});

// ── Time off ──────────────────────────────────────────────────────────────
router.get('/time-off', staffOnly, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.*, u.full_name as driver_name
      FROM time_off t
      LEFT JOIN users u ON t.driver_id = u.id
     ORDER BY t.date DESC
  `).all();
  res.json({ ok: true, timeOff: rows });
});

router.post('/time-off', staffOnly, (req, res) => {
  const { date, end_date, start_time, end_time, reason, driver_id } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  }
  if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({ error: 'end_date must be YYYY-MM-DD' });
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO time_off (driver_id, date, end_date, start_time, end_time, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    driver_id || null,
    date,
    end_date || null,
    start_time || null,
    end_time || null,
    reason || null,
    req.auth.id || null
  );
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

router.delete('/time-off/:id', staffOnly, (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM time_off WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Booking ops triggered from the reassignment flag ─────────────────────
router.post('/bookings/:id/reevaluate', staffOnly, async (req, res) => {
  const r = await intake.evaluate(parseInt(req.params.id, 10));
  res.json({ ok: true, result: r });
});

router.post('/bookings/:id/assign-driver', staffOnly, (req, res) => {
  const { driver_id } = req.body || {};
  if (!driver_id) return res.status(400).json({ error: 'driver_id required' });
  const db = getDb();
  const driver = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('driver','owner') AND active = 1").get(driver_id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  // Check whether this is the transition that confirms the booking — if the
  // status was pending we'll flip it to confirmed and notify the customer.
  const before = db.prepare("SELECT status FROM bookings WHERE id = ?").get(req.params.id);
  const r = db.prepare(`
    UPDATE bookings
       SET driver_id = ?,
           needs_reassignment = 0,
           status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
           intake_reason = COALESCE(intake_reason, '') || ' [Manually assigned to driver #' || ? || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(driver_id, driver_id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Booking not found' });
  // Fire the customer-confirmed notification if this assign just confirmed it.
  if (before && before.status === 'pending') {
    intake.notifyCustomerConfirmed(parseInt(req.params.id, 10))
      .catch(e => console.error('[INTAKE] notifyCustomerConfirmed failed:', e.message));
  }
  res.json({ ok: true });
});

router.post('/bookings/:id/draft-apology', staffOnly, async (req, res) => {
  const r = await intake.draftApology(parseInt(req.params.id, 10));
  res.json(r);
});

router.post('/bookings/:id/decline', staffOnly, (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    UPDATE bookings
       SET status = 'cancelled',
           needs_reassignment = 0,
           intake_reason = COALESCE(intake_reason, '') || ' [Declined by operator]',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json({ ok: true });
});

module.exports = router;
