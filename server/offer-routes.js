// ── Driver-offer workflow ────────────────────────────────────────────────
// Admin offers a booking to a specific driver. Driver has 10 minutes to
// accept or decline. A background sweeper reclaims stale offers.
//
// Fee split: driver receives 90% of the customer fare; 10% admin fee.
// The split is captured the moment the offer is created, so the driver
// sees exactly what they will be paid before they accept.
//
// Endpoints (mounted at /api, so all are protected by requireAuth):
//   POST /bookings/:id/offer         (admin/owner) { driver_id }
//   POST /bookings/:id/reclaim       (admin/owner)  — retract pending offer
//   GET  /driver/offers              (driver)       — offers pending my decision
//   GET  /driver/jobs                (driver)       — my accepted/active jobs
//   POST /driver/offers/:id/accept   (driver)
//   POST /driver/offers/:id/decline  (driver)       { reason? }
//   POST /driver/jobs/:id/start      (driver)       — mark pickup (status=active)
//   POST /driver/jobs/:id/done       (driver)
//   POST /driver/jobs/:id/cancel     (driver)       { reason? }

const express = require('express');
const { getDb } = require('./db');
const events = require('./events');
const email = require('./email');
const intake = require('./intake');

const router = express.Router();

const ADMIN_FEE_PCT = 0.10;            // fixed 10% admin fee
const OFFER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000;    // every minute

function staffOnly(req, res, next) {
  const role = req.auth && req.auth.role;
  if (!['admin', 'owner'].includes(role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function driverOnly(req, res, next) {
  const role = req.auth && req.auth.role;
  if (!['driver', 'owner'].includes(role)) return res.status(403).json({ error: 'Driver access required' });
  next();
}

function computeSplit(fare) {
  if (fare == null || isNaN(fare)) return { driver_pay: null, admin_fee: null };
  const f = Number(fare);
  const fee = Math.round(f * ADMIN_FEE_PCT * 100) / 100;
  const pay = Math.round((f - fee) * 100) / 100;
  return { driver_pay: pay, admin_fee: fee };
}

function bookingRow(id) {
  return getDb().prepare(`
    SELECT b.*,
           c.email AS customer_email, c.full_name AS customer_name, c.phone AS customer_phone,
           d.full_name AS driver_name, d.id AS driver_user_id,
           od.full_name AS offered_driver_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN users d ON b.driver_id = d.id
      LEFT JOIN users od ON b.offered_to_driver_id = od.id
     WHERE b.id = ?
  `).get(id);
}

function publicSummary(b) {
  if (!b) return null;
  return {
    id: b.id, ref: b.ref,
    pickup: b.pickup, destination: b.destination,
    date: b.date, time: b.time,
    passengers: b.passengers, bags: b.bags, trip_type: b.trip_type, flight: b.flight,
    fare: b.fare, driver_pay: b.driver_pay, admin_fee: b.admin_fee, payment: b.payment,
    status: b.status,
    offered_to_driver_id: b.offered_to_driver_id,
    offered_driver_name: b.offered_driver_name,
    offered_at: b.offered_at,
    driver_id: b.driver_id,
    driver_name: b.driver_name,
    customer_name: b.customer_name, customer_phone: b.customer_phone,
    notes: b.notes,
    done_at: b.done_at, cancelled_at: b.cancelled_at, cancellation_reason: b.cancellation_reason
  };
}

// ── Admin: offer a booking to a specific driver ──────────────────────────
router.post('/bookings/:id/offer', staffOnly, (req, res) => {
  const { driver_id } = req.body || {};
  if (!driver_id) return res.status(400).json({ error: 'driver_id required' });

  try {
    const db = getDb();
    const driver = db.prepare(`
      SELECT id, full_name, email, phone FROM users
       WHERE id = ? AND role IN ('driver','owner') AND active = 1
    `).get(driver_id);
    if (!driver) return res.status(404).json({ error: 'Driver not found or inactive' });

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (['completed', 'cancelled'].includes(booking.status)) {
      return res.status(409).json({ error: 'Booking is already ' + booking.status });
    }

    const { driver_pay, admin_fee } = computeSplit(booking.fare);
    const driverLabel = (driver.full_name || ('#' + driver_id)).slice(0, 120);

    // Update booking status — use a simpler UPDATE that avoids string-concat
    // in SQL (which can fail if intake_reason column is missing on old DBs)
    db.prepare(`
      UPDATE bookings
         SET status = 'offered',
             offered_to_driver_id = ?,
             offered_at = datetime('now'),
             decided_at = NULL,
             driver_pay = ?,
             admin_fee  = ?,
             needs_reassignment = 0,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(driver_id, driver_pay, admin_fee, req.params.id);

    // Append to intake_reason separately — non-fatal if it fails
    try {
      db.prepare(`
        UPDATE bookings
           SET intake_reason = COALESCE(intake_reason, '') || ?
         WHERE id = ?
      `).run(' [Offered to ' + driverLabel + ' at ' + new Date().toISOString() + ']', req.params.id);
    } catch (_) { /* intake_reason column may not exist on legacy DBs */ }

    const row = bookingRow(req.params.id);

    // Broadcast SSE (non-fatal)
    try { events.broadcast('job:offered', publicSummary(row), { driverId: driver_id }); } catch (_) {}

    // Driver notification — skip gracefully if driver has no contact details
    // (push tokens, email, WhatsApp are all optional at offer time)
    if (driver.email) {
      try {
        email.sendDriverJobOffer && email.sendDriverJobOffer({
          driver_name: driver.full_name, driver_email: driver.email,
          ref: booking.ref, pickup: booking.pickup, destination: booking.destination,
          date: booking.date, time: booking.time, fare: booking.fare,
          driver_pay, passengers: booking.passengers
        });
      } catch (notifyErr) {
        console.warn('[OFFER] driver email notification skipped:', notifyErr.message);
      }
    }

    res.json({ ok: true, booking: publicSummary(row) });
  } catch (e) {
    console.error('[OFFER] /bookings/:id/offer error:', e.message, e.stack);
    res.status(500).json({ error: 'Failed to create offer: ' + e.message });
  }
});

// ── Admin: retract a pending offer ───────────────────────────────────────
router.post('/bookings/:id/reclaim', staffOnly, (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'offered') {
    return res.status(409).json({ error: 'Booking is not currently offered (status: ' + booking.status + ')' });
  }

  const prevDriverId = booking.offered_to_driver_id;
  db.prepare(`
    UPDATE bookings
       SET status = 'pending',
           offered_to_driver_id = NULL,
           offered_at = NULL,
           decided_at = datetime('now'),
           driver_pay = NULL,
           admin_fee  = NULL,
           needs_reassignment = 1,
           intake_reason = COALESCE(intake_reason, '') || ' [Offer reclaimed by admin at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(req.params.id);

  const row = bookingRow(req.params.id);
  events.broadcast('job:offer_expired', publicSummary(row), { driverId: prevDriverId });
  res.json({ ok: true, booking: publicSummary(row) });
});

// ── Driver: list my pending offers ───────────────────────────────────────
router.get('/driver/offers', driverOnly, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.*, c.full_name AS customer_name, c.phone AS customer_phone
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.status = 'offered' AND b.offered_to_driver_id = ?
     ORDER BY b.offered_at ASC
  `).all(req.auth.id);
  res.json({ ok: true, offers: rows.map(publicSummary) });
});

// ── Driver: list my active / upcoming jobs (accepted) ────────────────────
router.get('/driver/jobs', driverOnly, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.*, c.full_name AS customer_name, c.phone AS customer_phone
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.driver_id = ? AND b.status IN ('confirmed','active','completed','cancelled')
     ORDER BY b.date DESC, b.time DESC
     LIMIT 200
  `).all(req.auth.id);
  res.json({ ok: true, jobs: rows.map(publicSummary) });
});

// ── Driver: accept an offer ──────────────────────────────────────────────
router.post('/driver/offers/:id/accept', driverOnly, (req, res) => {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status !== 'offered' || b.offered_to_driver_id !== req.auth.id) {
    return res.status(409).json({ error: 'This offer is no longer pending your decision.' });
  }

  const wasPending = !b.driver_id; // first-time confirmation for customer
  db.prepare(`
    UPDATE bookings
       SET status = 'confirmed',
           driver_id = ?,
           offered_to_driver_id = NULL,
           decided_at = datetime('now'),
           needs_reassignment = 0,
           intake_reason = COALESCE(intake_reason, '') || ' [Accepted by driver ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(req.auth.id, req.auth.id, req.params.id);

  const row = bookingRow(req.params.id);
  events.broadcast('job:accepted', publicSummary(row), { driverId: req.auth.id });

  // First-time acceptance → send customer confirmation email
  if (wasPending) {
    intake.notifyCustomerConfirmed(parseInt(req.params.id, 10))
      .catch(e => console.error('[OFFER] notifyCustomerConfirmed failed:', e.message));
  }

  res.json({ ok: true, booking: publicSummary(row) });
});

// ── Driver: decline an offer ─────────────────────────────────────────────
router.post('/driver/offers/:id/decline', driverOnly, (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 500) : '';
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status !== 'offered' || b.offered_to_driver_id !== req.auth.id) {
    return res.status(409).json({ error: 'This offer is no longer pending your decision.' });
  }

  db.prepare(`
    UPDATE bookings
       SET status = 'pending',
           offered_to_driver_id = NULL,
           offered_at = NULL,
           decided_at = datetime('now'),
           driver_pay = NULL,
           admin_fee  = NULL,
           needs_reassignment = 1,
           intake_reason = COALESCE(intake_reason, '') || ' [Declined by driver ' || ? || ': ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(req.auth.id, reason || 'no reason given', req.params.id);

  const row = bookingRow(req.params.id);
  events.broadcast('job:declined', publicSummary(row), { driverId: req.auth.id });
  res.json({ ok: true });
});

// ── Driver: mark pickup (status=active) ──────────────────────────────────
router.post('/driver/jobs/:id/start', driverOnly, (req, res) => {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.driver_id !== req.auth.id) return res.status(403).json({ error: 'Not your job' });
  if (!['confirmed', 'active'].includes(b.status)) return res.status(409).json({ error: 'Wrong status: ' + b.status });

  db.prepare(`UPDATE bookings SET status='active', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  const row = bookingRow(req.params.id);
  events.broadcast('job:started', publicSummary(row), { driverId: req.auth.id });
  res.json({ ok: true });
});

// ── Driver: mark done ────────────────────────────────────────────────────
router.post('/driver/jobs/:id/done', driverOnly, (req, res) => {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.driver_id !== req.auth.id) return res.status(403).json({ error: 'Not your job' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'Already ' + b.status });

  db.prepare(`
    UPDATE bookings
       SET status = 'completed',
           done_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?
  `).run(req.params.id);

  const row = bookingRow(req.params.id);
  events.broadcast('job:done', publicSummary(row), { driverId: req.auth.id });
  res.json({ ok: true });
});

// ── Driver: cancel a job (mid-flow) ──────────────────────────────────────
router.post('/driver/jobs/:id/cancel', driverOnly, async (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 500) : 'Cancelled by driver';
  const db = getDb();
  const b = bookingRow(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.driver_id !== req.auth.id) return res.status(403).json({ error: 'Not your job' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'Already ' + b.status });

  db.prepare(`
    UPDATE bookings
       SET status = 'cancelled',
           cancelled_at = datetime('now'),
           cancellation_reason = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(reason, req.params.id);

  const row = bookingRow(req.params.id);
  events.broadcast('job:cancelled', publicSummary(row), { driverId: req.auth.id });

  // Apology email to the customer
  if (row.customer_email) {
    email.sendCustomerCancellation({
      ref: row.ref, name: row.customer_name, email: row.customer_email,
      pickup: row.pickup, destination: row.destination,
      date: row.date, time: row.time, fare: row.fare, flight: row.flight,
      cancellation_reason: reason
    }).catch(e => console.error('[OFFER] cancellation email failed:', e.message));
  }

  res.json({ ok: true });
});

// ── Background sweeper: reclaim stale offers ─────────────────────────────
function sweepStaleOffers() {
  try {
    const db = getDb();
    const stale = db.prepare(`
      SELECT id, offered_to_driver_id, ref
        FROM bookings
       WHERE status = 'offered'
         AND offered_at IS NOT NULL
         AND (julianday('now') - julianday(offered_at)) * 86400000 > ?
    `).all(OFFER_WINDOW_MS);

    if (!stale.length) return;

    const upd = db.prepare(`
      UPDATE bookings
         SET status = 'pending',
             offered_to_driver_id = NULL,
             offered_at = NULL,
             decided_at = datetime('now'),
             driver_pay = NULL,
             admin_fee  = NULL,
             needs_reassignment = 1,
             intake_reason = COALESCE(intake_reason, '') || ' [Offer auto-expired at ' || datetime('now') || ']',
             updated_at = datetime('now')
       WHERE id = ? AND status = 'offered'
    `);

    for (const r of stale) {
      upd.run(r.id);
      const row = bookingRow(r.id);
      events.broadcast('job:offer_expired', publicSummary(row), { driverId: r.offered_to_driver_id });
      console.log('[OFFER] Auto-expired offer on booking ' + r.ref + ' after ' + (OFFER_WINDOW_MS / 60000) + ' min');
    }
  } catch (e) {
    console.error('[OFFER] Sweeper error:', e.message);
  }
}

let _sweepTimer = null;
function startOfferSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweepStaleOffers, SWEEP_INTERVAL_MS);
  console.log('[OFFER] Auto-reclaim sweeper started (every ' + (SWEEP_INTERVAL_MS / 1000) + 's, window ' + (OFFER_WINDOW_MS / 60000) + ' min)');
}

module.exports = router;
module.exports.startOfferSweeper = startOfferSweeper;
module.exports.ADMIN_FEE_PCT = ADMIN_FEE_PCT;
module.exports.OFFER_WINDOW_MS = OFFER_WINDOW_MS;
