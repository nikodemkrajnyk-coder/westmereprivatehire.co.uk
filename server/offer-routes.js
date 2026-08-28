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
    /* For an ad-hoc offer there is no users row to read a name from, so the
       card falls back to the name that was typed in. One field for the card to
       show, whichever kind of offer it is. */
    offered_driver_name: b.offered_driver_name || b.offered_to_name || null,
    offered_to_email: b.offered_to_email || null,
    offered_is_adhoc: !b.offered_to_driver_id && !!b.offered_to_email,
    offered_at: b.offered_at,
    driver_id: b.driver_id,
    driver_name: b.driver_name || b.assigned_to_name || null,
    assigned_to_name: b.assigned_to_name || null,
    customer_name: b.customer_name, customer_phone: b.customer_phone,
    notes: b.notes,
    done_at: b.done_at, cancelled_at: b.cancelled_at, cancellation_reason: b.cancellation_reason
  };
}

// ── Admin: offer a booking to a specific driver ──────────────────────────
/* TWO KINDS OF OFFER, ONE ROUTE.
   A REGISTERED offer names a driver_id and goes to somebody with an account, a
   driver app and a commission arrangement. An AD-HOC offer is a name and an
   email address typed in on the spot — another operator, a friend with a car,
   somebody covering a Sunday. There is no users row to point at.

   Which kind it is, is decided ONCE here and recorded in the columns: a
   registered offer sets offered_to_driver_id and leaves offered_to_email NULL;
   an ad-hoc offer does the reverse. Nothing downstream infers it from anything
   else, and nothing can be half of each. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* THE DEFAULT DRIVER is the owner, flagged on his users row. Asked by id rather
   than by name — the name is a string somebody can edit, the flag is the fact.
   A missing column on a legacy database answers "no", which fails safe: the
   route refuses rather than passing on a job that is genuinely taken. */
function isDefaultDriver(db, driverId) {
  if (!driverId) return false;
  try {
    const u = db.prepare('SELECT is_default_driver FROM users WHERE id = ?').get(driverId);
    return !!(u && u.is_default_driver);
  } catch (_) { return false; }
}

router.post('/bookings/:id/offer', staffOnly, (req, res) => {
  const { driver_id } = req.body || {};
  const adhocName  = String((req.body && req.body.name)  || '').trim();
  const adhocEmail = String((req.body && req.body.email) || '').trim().toLowerCase();
  /* THE CAR, so the CUSTOMER's reminder can name it. An outside driver has no
     users row to read a vehicle from, so the owner types it. The registration
     is normalised to upper case because it is read off a plate and typed in a
     hurry; the make and model is left exactly as written — "Skoda Superb
     estate, dark grey" is more use to a customer at a kerbside than anything a
     parser would make of it. */
  const adhocReg = String((req.body && req.body.reg) || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const adhocCar = String((req.body && req.body.car) || '').trim();
  const isAdhoc = !driver_id && (adhocName || adhocEmail);

  if (!driver_id && !isAdhoc) return res.status(400).json({ error: 'driver_id, or a name and email, required' });
  try {
    const db = getDb();
    let driver = null;
    if (!isAdhoc) {
      driver = db.prepare(`
        SELECT id, full_name, email, phone FROM users
         WHERE id = ? AND role IN ('driver','owner') AND active = 1
      `).get(driver_id);
      if (!driver) return res.status(404).json({ error: 'Driver not found or inactive' });
    }

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (['completed', 'cancelled'].includes(booking.status)) {
      return res.status(409).json({ error: 'Booking is already ' + booking.status });
    }
    /* A JOB IS ONLY PASSED ON ONCE THE CUSTOMER HAS CONFIRMED IT.
       The owner's rule. Offering a pending quote sends a driver out on a trip
       that may never happen — and on the ad-hoc path it hands somebody outside
       the business a customer's name and phone number for a booking that was
       never made. The button is hidden on unconfirmed cards; this is the half
       that holds when the button is not the only way in. */
    if (!['confirmed', 'active'].includes(booking.status)) {
      return res.status(409).json({
        error: 'This booking is ' + booking.status + '. A job can only be offered once it is confirmed.'
      });
    }

    /* ALREADY ON THE DEFAULT DRIVER IS NOT "ALREADY TAKEN".
       Every confirmed booking is allocated to the owner as it comes in, so
       driver_id is set on essentially all of them. Reading that as "assigned"
       would mean no job could ever be passed on — which is the whole point of
       the button. The default allocation is a placeholder for "I will do this
       one myself", and offering it is him saying he cannot.

       A job a REAL driver has taken is a different thing, and is refused: he
       has it in his diary and may be halfway to the pickup. Reclaim it first,
       then offer it. */
    if (booking.driver_id && !isDefaultDriver(db, booking.driver_id)) {
      const holder = db.prepare('SELECT full_name FROM users WHERE id = ?').get(booking.driver_id);
      return res.status(409).json({
        error: 'This job is already with ' + ((holder && holder.full_name) || 'another driver') +
               '. Reclaim it first if you want to pass it to somebody else.'
      });
    }
    if (booking.assigned_to_name) {
      return res.status(409).json({
        error: 'This job is already with ' + booking.assigned_to_name +
               '. Reclaim it first if you want to pass it to somebody else.'
      });
    }

    /* The shape of the ad-hoc details is checked HERE, after the status, so the
       owner is told the real reason first. Answering "a registration is
       required" on a booking that can never be offered sends him off to find a
       number plate for nothing. */
  if (isAdhoc) {
    if (!adhocName) return res.status(400).json({ error: 'A name is required for the driver you are sending this to' });
    if (adhocName.length > 120) return res.status(400).json({ error: 'That name is too long' });
    if (!adhocEmail) return res.status(400).json({ error: 'An email address is required' });
    if (!EMAIL_RE.test(adhocEmail)) return res.status(400).json({ error: 'That email address does not look right: ' + adhocEmail });
    /* Light, on purpose. A UK plate has a shape but this also has to accept a
       trade plate, an Irish one, or a hire car — so the rule is only that it
       looks like a registration rather than a sentence. */
    if (!adhocReg) return res.status(400).json({ error: 'A registration number is required — the customer is told which car to look for' });
    if (!/^[A-Z0-9][A-Z0-9 -]{3,11}$/.test(adhocReg)) {
      return res.status(400).json({ error: 'That does not look like a registration: ' + adhocReg });
    }
  }

    const { driver_pay, admin_fee } = computeSplit(booking.fare);
    /* Fresh per offer. A job that was offered, reclaimed and offered again must
       not be decidable with the link from the first email. */
    const offerToken = require('crypto').randomBytes(24).toString('base64url');
    const driverLabel = (isAdhoc ? adhocName : (driver.full_name || ('#' + driver_id))).slice(0, 120);

    // Update booking status — use a simpler UPDATE that avoids string-concat
    // in SQL (which can fail if intake_reason column is missing on old DBs)
    db.prepare(`
      UPDATE bookings
         SET status = 'offered',
             offered_to_driver_id = ?,
             offered_to_name  = ?,
             offered_to_email = ?,
             offered_to_reg   = ?,
             offered_to_car   = ?,
             offered_at = datetime('now'),
             decided_at = NULL,
             offer_token = ?,
             driver_pay = ?,
             admin_fee  = ?,
             needs_reassignment = 0,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      isAdhoc ? null : driver_id,
      isAdhoc ? adhocName : null,
      isAdhoc ? adhocEmail : null,
      isAdhoc ? (adhocReg || null) : null,
      isAdhoc ? (adhocCar || null) : null,
      offerToken, driver_pay, admin_fee, req.params.id);

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
    try { events.broadcast('job:offered', publicSummary(row), { driverId: isAdhoc ? null : driver_id }); } catch (_) {}

    // Driver notification — skip gracefully if driver has no contact details
    // (push tokens, email, WhatsApp are all optional at offer time)
    if (isAdhoc) {
      /* A DIFFERENT EMAIL, because the reader is different. A registered driver
         gets his pay after commission; somebody outside the system is being
         quoted a job, and needs the customer's name and number to run it. */
      try {
        email.sendAdhocJobOffer({
          driver_name: adhocName, driver_email: adhocEmail,
          ref: booking.ref, pickup: booking.pickup, destination: booking.destination,
          stop_address: booking.stop_address, date: booking.date, time: booking.time,
          fare: booking.fare, driver_pay, admin_fee,
          passengers: booking.passengers, bags: booking.bags, flight: booking.flight,
          notes: booking.notes, customer_note: booking.customer_note,
          customer_name: row.customer_name || booking.passenger_name || '',
          customer_phone: row.customer_phone || booking.passenger_phone || '',
          driver_reg: adhocReg, driver_car: adhocCar,
          offer_token: offerToken
        });
      } catch (notifyErr) {
        console.warn('[OFFER] ad-hoc email skipped:', notifyErr.message);
      }
    } else if (driver.email) {
      try {
        email.sendDriverJobOffer({
          driver_name: driver.full_name, driver_email: driver.email,
          ref: booking.ref, pickup: booking.pickup, destination: booking.destination,
          stop_address: booking.stop_address, date: booking.date, time: booking.time,
          fare: booking.fare, driver_pay, admin_fee,
          passengers: booking.passengers, bags: booking.bags, flight: booking.flight,
          notes: booking.notes, customer_note: booking.customer_note,
          offer_token: offerToken
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
           offer_token = NULL,
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
/* ── DECIDING AN OFFER, ONCE ──────────────────────────────────────────────
   A driver can now say yes from two places: the Offered screen in his app, and
   the buttons in the offer email. Both land here rather than each writing its
   own UPDATE — two implementations of "accept" is two ways for a job to end up
   half-assigned, and the one that is used less is the one that rots.

   Both refuse unless the booking is STILL offered to THIS driver, so a stale
   email opened after the sweeper reclaimed the job cannot assign it. */
function acceptOffer(db, bookingId, driverId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) return { ok: false, reason: 'not_found' };
  /* driverId must BE something. On an ad-hoc offer both sides are null, and
     `null !== null` is false — so without this line the guard below passes by
     accident and the job is assigned to driver_id NULL, which reads everywhere
     as unassigned. Found by the guard, not by reading it. */
  if (driverId === null || driverId === undefined) return { ok: false, reason: 'no_driver' };
  if (b.status !== 'offered' || b.offered_to_driver_id !== driverId) {
    return { ok: false, reason: 'not_pending' };
  }
  const wasPending = !b.driver_id;
  db.prepare(`
    UPDATE bookings
       SET status = 'confirmed',
           driver_id = ?,
           offered_to_driver_id = NULL,
           offer_token = NULL,
           decided_at = datetime('now'),
           needs_reassignment = 0,
           intake_reason = COALESCE(intake_reason, '') || ' [Accepted by driver ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(driverId, driverId, bookingId);
  const row = bookingRow(bookingId);
  events.broadcast('job:accepted', publicSummary(row), { driverId });
  if (wasPending) {
    intake.notifyCustomerConfirmed(parseInt(bookingId, 10))
      .catch(e => console.error('[OFFER] notifyCustomerConfirmed failed:', e.message));
  }
  return { ok: true, row };
}

/* ACCEPT AND DECLINE FOR SOMEBODY WITH NO ACCOUNT.
   Deliberately separate from acceptOffer/declineOffer rather than a flag on
   them. Those two guard on `b.offered_to_driver_id !== driverId`, and for an
   ad-hoc offer both sides are null — the check would PASS by accident and the
   job would be assigned to driver_id NULL, which reads as unassigned. Two
   functions, each with a guard that means something.

   The job becomes confirmed and carries the NAME of whoever took it; driver_id
   stays null because there is no account to point at. Everything downstream
   that shows a driver already falls back to assigned_to_name. */
function acceptAdhocOffer(db, bookingId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) return { ok: false, reason: 'not_found' };
  if (b.status !== 'offered' || b.offered_to_driver_id || !b.offered_to_email) {
    return { ok: false, reason: 'not_pending' };
  }
  const wasPending = !b.driver_id;
  const who = b.offered_to_name || b.offered_to_email;
  /* The car travels with the person, and so does the address. Once this is on
     the booking the customer's reminder can say which car to look for, and the
     driver's own reminder has somewhere to go — offered_to_email is cleared
     below because the offer is spent, so it must be copied first. */
  db.prepare(`
    UPDATE bookings
       SET status = 'confirmed',
           /* OFF THE DEFAULT DRIVER. The job was allocated to the owner when it
              came in — that is what every confirmed booking looks like until
              somebody else takes it. Leaving driver_id set would make
              driverDetails resolve the REGISTERED branch first and tell the
              customer to look for the owner's Tesla, while the person actually
              driving is the one named two lines below. */
           driver_id = NULL,
           assigned_to_name  = ?,
           assigned_to_email = offered_to_email,
           assigned_to_reg   = offered_to_reg,
           assigned_to_car   = offered_to_car,
           offered_to_driver_id = NULL,
           offered_to_name = NULL,
           offered_to_email = NULL,
           offered_to_reg = NULL,
           offered_to_car = NULL,
           offer_token = NULL,
           decided_at = datetime('now'),
           needs_reassignment = 0,
           intake_reason = COALESCE(intake_reason, '') || ' [Accepted by ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(who, who, bookingId);
  const row = bookingRow(bookingId);
  try { events.broadcast('job:accepted', publicSummary(row), {}); } catch (_) {}
  if (wasPending) {
    intake.notifyCustomerConfirmed(parseInt(bookingId, 10))
      .catch(e => console.error('[OFFER] notifyCustomerConfirmed failed:', e.message));
  }
  return { ok: true, row };
}

function declineAdhocOffer(db, bookingId, reason) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) return { ok: false, reason: 'not_found' };
  if (b.status !== 'offered' || b.offered_to_driver_id || !b.offered_to_email) {
    return { ok: false, reason: 'not_pending' };
  }
  const who = b.offered_to_name || b.offered_to_email;
  db.prepare(`
    UPDATE bookings
       SET status = 'pending',
           offered_to_driver_id = NULL,
           offered_to_name = NULL,
           offered_to_email = NULL,
           offered_to_reg = NULL,
           offered_to_car = NULL,
           offered_at = NULL,
           offer_token = NULL,
           decided_at = datetime('now'),
           driver_pay = NULL,
           admin_fee  = NULL,
           needs_reassignment = 1,
           intake_reason = COALESCE(intake_reason, '') || ' [Declined by ' || ? || ': ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(who, (reason || 'no reason given'), bookingId);
  const row = bookingRow(bookingId);
  try { events.broadcast('job:declined', publicSummary(row), {}); } catch (_) {}
  return { ok: true, row };
}

function declineOffer(db, bookingId, driverId, reason) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) return { ok: false, reason: 'not_found' };
  if (driverId === null || driverId === undefined) return { ok: false, reason: 'no_driver' };
  if (b.status !== 'offered' || b.offered_to_driver_id !== driverId) {
    return { ok: false, reason: 'not_pending' };
  }
  db.prepare(`
    UPDATE bookings
       SET status = 'pending',
           offered_to_driver_id = NULL,
           offered_at = NULL,
           offer_token = NULL,
           offer_token = NULL,
           decided_at = datetime('now'),
           driver_pay = NULL,
           admin_fee  = NULL,
           needs_reassignment = 1,
           intake_reason = COALESCE(intake_reason, '') || ' [Declined by driver ' || ? || ': ' || ? || ' at ' || datetime('now') || ']',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(driverId, (reason || 'no reason given'), bookingId);
  const row = bookingRow(bookingId);
  events.broadcast('job:declined', publicSummary(row), { driverId });
  return { ok: true, row };
}

router.post('/driver/offers/:id/accept', driverOnly, (req, res) => {
  const out = acceptOffer(getDb(), req.params.id, req.auth.id);
  if (!out.ok) {
    return out.reason === 'not_found'
      ? res.status(404).json({ error: 'Booking not found' })
      : res.status(409).json({ error: 'This offer is no longer pending your decision.' });
  }
  res.json({ ok: true, booking: publicSummary(out.row) });
});

// ── Driver: decline an offer ─────────────────────────────────────────────
router.post('/driver/offers/:id/decline', driverOnly, (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 500) : '';
  const out = declineOffer(getDb(), req.params.id, req.auth.id, reason);
  if (!out.ok) {
    return out.reason === 'not_found'
      ? res.status(404).json({ error: 'Booking not found' })
      : res.status(409).json({ error: 'This offer is no longer pending your decision.' });
  }
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
module.exports.computeSplit = computeSplit;
module.exports.acceptOffer = acceptOffer;
module.exports.declineOffer = declineOffer;
module.exports.acceptAdhocOffer = acceptAdhocOffer;
module.exports.declineAdhocOffer = declineAdhocOffer;
module.exports.OFFER_WINDOW_MS = OFFER_WINDOW_MS;
