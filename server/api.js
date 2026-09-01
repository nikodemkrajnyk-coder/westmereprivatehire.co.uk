const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb, DATA_DIR } = require('./db');
const { sendAdminAlert, sendCustomerCancellation, sendCorporateIntro } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const gcal = require('./google-calendar');
const events = require('./events');

/* Invoices live wherever server/invoice-pdf.js says they do — this file used
   to derive its own answer from the database directory, which agreed with the
   other one only on the deploy box. */
const { invoiceCacheDir } = require('./invoice-pdf');
let autoFile;
try { autoFile = require('./auto-file'); } catch(e) { autoFile = { fileBooking(){}, fileCustomer(){}, fileInvoice(){}, removeBooking(){}, removeInvoice(){}, updateEarnings(){}, fileDriverProfile(){}, fileDriverDoc(){} }; console.error('[AUTOFILE] Module failed:', e.message); }

const router = express.Router();

// ── UK timezone helper ───────────────────────────────────────────────────
// Server runs in UTC on Railway; all business logic must use Europe/London.
function ukNow() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return {
    year: parseInt(p.year), month: parseInt(p.month), day: parseInt(p.day),
    hour: parseInt(p.hour), minute: parseInt(p.minute), second: parseInt(p.second),
    dateStr: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${p.hour}:${p.minute}`,
    dayOfWeek: new Date(new Date().toLocaleString('en-US', {timeZone:'Europe/London'})).getDay()
  };
}

// ── Bookings ────────────────────────────────────────────────────────────

// List bookings (admin sees all, driver sees assigned, customer sees own)
router.get('/bookings', (req, res) => {
  const db = getDb();
  const { role, id, type } = req.auth;

  let rows;
  if (role === 'admin' || role === 'owner') {
    rows = db.prepare(`
      SELECT b.*,
             COALESCE(c.full_name, b.passenger_name) as customer_name,
             COALESCE(c.email,     b.passenger_email) as customer_email,
             COALESCE(c.phone,     b.passenger_phone) as customer_phone,
             u.full_name  as driver_name,
             /* Is the assigned driver the DEFAULT driver — the owner himself?
                Every confirmed job is allocated to him on the way in, so
                "has a driver" is not the same question as "is covered by
                somebody else". The owner app needs to tell them apart to know
                whether to offer the job on. */
             u.is_default_driver as driver_is_default,
             od.full_name as offered_driver_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN users u ON b.driver_id = u.id
      LEFT JOIN users od ON b.offered_to_driver_id = od.id
      ORDER BY b.date DESC, b.time DESC
      LIMIT 200
    `).all();
  } else if (role === 'driver') {
    rows = db.prepare(`
      SELECT b.*,
             COALESCE(c.full_name, b.passenger_name) as customer_name,
             COALESCE(c.phone,     b.passenger_phone) as customer_phone
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      WHERE b.driver_id = ?
      ORDER BY b.date DESC, b.time DESC
      LIMIT 100
    `).all(id);
  } else if (type === 'customer') {
    // A customer's trip history must include EVERY booking that is theirs, not
    // just the ones that happen to carry a customer_id foreign key.
    //
    // WHY (the "my trips have all disappeared" incident): customer_id is only
    // ever set when a booking is created *while an account with that email
    // already exists* (public-api `/book` does a link-if-exists lookup). So it
    // is NULL for:
    //   • bookings the owner enters manually in the owner/admin app (phone,
    //     WhatsApp, repeat customers) — those carry passenger_email only;
    //   • every booking a customer made BEFORE they registered an account.
    // Those rows are the customer's own trips and they were invisible here, so
    // My Account rendered "No trips found" while the data sat safely in the DB.
    // The local copy in the rider app's localStorage masked it until anything
    // cleared it (sign out, new device, cleared site data).
    //
    // Match on the account's verified email as well — the same OR-on-email rule
    // the invoice list already uses below. Read-only: nothing is re-linked here.
    const me = db.prepare('SELECT email FROM customers WHERE id = ?').get(id) || {};
    rows = db.prepare(`
      SELECT b.*, u.full_name as driver_name, u.vehicle as driver_vehicle, u.reg as driver_reg
      FROM bookings b
      LEFT JOIN users u ON b.driver_id = u.id
      WHERE b.customer_id = ?
         OR (b.customer_id IS NULL AND ? <> '' AND LOWER(TRIM(b.passenger_email)) = LOWER(TRIM(?)))
      ORDER BY b.date DESC, b.time DESC
      LIMIT 100
    `).all(id, me.email || '', me.email || '');
  } else {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ ok: true, bookings: rows });
});

// Create booking
router.post('/bookings', (req, res) => {
  const { pickup, destination, stop_address, date, time, passengers, bags, trip_type, flight, fare, payment, notes,
          passenger_name, passenger_phone, passenger_email, customer_id: bodyCustomerId } = req.body;

  if (!pickup || !destination || !date || !time) {
    return res.status(400).json({ error: 'Pickup, destination, date, and time required' });
  }

  // Match the customer web-booking path (/api/public/book): validate the email
  // format when one is supplied, so a manual booking never carries a malformed
  // address that would later break Send Estimate.
  if (passenger_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(passenger_email).trim())) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Reject bookings in the past (Europe/London timezone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const ukNowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const todayStr = `${ukNowParts.year}-${ukNowParts.month}-${ukNowParts.day}`;
  if (date < todayStr) {
    return res.status(400).json({ error: 'Pickup date is in the past' });
  }
  if (date === todayStr && time && time !== 'ASAP') {
    const m = String(time).match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const reqMins = (+m[1]) * 60 + (+m[2]);
      const nowMins = parseInt(ukNowParts.hour, 10) * 60 + parseInt(ukNowParts.minute, 10);
      if (reqMins < nowMins) {
        return res.status(400).json({ error: 'Pickup time is in the past' });
      }
    }
  }

  const db = getDb();
  const ref = 'WPH-' + Date.now().toString(36).toUpperCase();
  // Parity with the web /book path: link to an existing customer account by
  // email so a manually-created booking shows up in that customer's My Account
  // (link-if-exists only — never auto-create). Explicit customer_id / a customer
  // caller still take precedence.
  let customerId = req.auth.type === 'customer' ? req.auth.id : (bodyCustomerId ? parseInt(bodyCustomerId, 10) : null);
  if (!customerId && passenger_email) {
    try {
      const existing = db.prepare('SELECT id FROM customers WHERE email = ? AND active = 1').get(String(passenger_email).trim().toLowerCase());
      if (existing) customerId = existing.id;
    } catch (_) {}
  }

  let result;
  try {
    result = db.prepare(`
      INSERT INTO bookings (ref, customer_id, pickup, destination, stop_address, date, time, passengers, bags, trip_type, flight, fare, payment, notes, passenger_name, passenger_phone, passenger_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ref, customerId, pickup, destination, (stop_address || '').trim() || null, date, time, passengers || 1, bags || 0, trip_type || null, flight || null, fare || null, payment || 'pending', notes || null,
           passenger_name || null, passenger_phone || null, passenger_email || null);
  } catch (e) {
    console.error('[API] booking insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to save booking. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_created', ref, req.ip);
  } catch (e) { /* audit failure must not block the response */ }

  // Calculate trip miles in background (for mileage tracking)
  (async () => {
    try {
      const { _fareGeocode, _fareRoute } = require('./fare-engine');
      const [gc1, gc2] = await Promise.all([_fareGeocode(pickup), _fareGeocode(destination)]);
      if (gc1 && gc2) {
        const rt = await _fareRoute(gc1.lat, gc1.lon, gc2.lat, gc2.lon);
        if (rt) {
          const miles = Math.round(rt.distance / 1609.34 * 10) / 10;
          db.prepare('UPDATE bookings SET trip_miles = ? WHERE id = ?').run(miles, result.lastInsertRowid);
        }
      }
    } catch (e) { console.error('[API] trip_miles calc failed:', e.message); }
  })();

  // Send admin notifications in background.
  // A MANUAL booking has no linked customer (customer_id null), so the name /
  // email / phone live in the passenger_* fields the form supplied. Fall back to
  // those before defaulting to 'Guest' — mirroring COALESCE(c.full_name,
  // b.passenger_name) used by the estimate/confirmation paths. Without this the
  // owner-alert email showed "Guest" for every manually-created booking.
  const customerName = customerId
    ? (db.prepare('SELECT full_name, email, phone FROM customers WHERE id = ?').get(customerId) || {})
    : {};
  const contactName  = customerName.full_name || passenger_name  || 'Guest';
  const contactEmail = customerName.email     || passenger_email || '';
  const contactPhone = customerName.phone     || passenger_phone || '';
  const notifData = {
    ref, name: contactName, email: contactEmail,
    phone: contactPhone, pickup, destination, stop_address, date, time,
    passengers, bags, flight, fare, payment, notes
  };
  Promise.allSettled([
    sendAdminAlert(notifData)
  ]).catch(() => {});

  // Push to Google Calendar in background
  const bookingForCal = {
    id: result.lastInsertRowid, ref, pickup, destination, stop_address, date, time,
    passengers, bags, flight, fare, payment, notes,
    customer_name: contactName,
    customer_phone: contactPhone,
    status: 'pending'
  };
  gcal.createEvent(bookingForCal).then(eventId => {
    if (eventId) {
      try {
        getDb().prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?')
          .run(eventId, result.lastInsertRowid);
      } catch (e) {}
    }
  }).catch(() => {});

  // Auto-file (non-blocking)
  const newBk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
  if (newBk) autoFile.fileBooking(newBk);

  res.status(201).json({ ok: true, booking: { id: result.lastInsertRowid, ref } });
});

// Update booking status
/* ── WHAT THE CUSTOMER IS TOLD ABOUT ─────────────────────────────────────
   The columns a customer actually travels on. When an operator's Edit → Save
   moves one of these, the customer is emailed the new details automatically
   (sendCustomerBookingUpdated). Everything else — the private note, the
   driver, the status, the payment method, the mileage — is the operator's own
   record and is saved in silence.

   Adding a column here puts it in a customer's inbox. Do that deliberately.
   GUARDRAIL: server/tests/booking-updated.test.js */
const CUSTOMER_FIELDS = ['pickup', 'stop_address', 'destination', 'date', 'time',
                         'passengers', 'bags', 'flight', 'fare'];

// True when the two values mean the same thing to a customer, so a re-save
// that retypes the same journey is silent. Money and head-counts compare as
// numbers ('42' and 42 and 42.00 are one fare); a flight number compares
// case-insensitively; everything else compares trimmed, with null/'' equal.
function sameCustomerValue(key, before, after) {
  if (key === 'fare' || key === 'passengers') {
    const a = before == null || before === '' ? null : Number(before);
    const b = after  == null || after  === '' ? null : Number(after);
    if (a === null || b === null) return a === b;
    if (isNaN(a) || isNaN(b)) return String(before).trim() === String(after).trim();
    return Math.abs(a - b) < 0.005;
  }
  const a = before == null ? '' : String(before).trim();
  const b = after  == null ? '' : String(after).trim();
  if (key === 'flight') return a.toUpperCase() === b.toUpperCase();
  return a === b;
}

router.patch('/bookings/:id', async (req, res) => {
  const { role } = req.auth;
  if (!['admin', 'owner', 'driver'].includes(role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (role === 'driver' && booking.driver_id !== req.auth.id) {
    return res.status(403).json({ error: 'You can only update your own bookings' });
  }

  // Guardrail: a payment method written via the API must be a known method.
  // Rejecting an unknown value loudly here prevents a silent wrong-method from
  // ever being persisted (see CLAUDE.md "Payment method" invariant).
  if (req.body.payment !== undefined && req.body.payment !== null) {
    const { isValidPaymentMethod } = require('./payment-methods');
    if (!isValidPaymentMethod(req.body.payment)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    req.body.payment = String(req.body.payment).toLowerCase();
  }

  const allowed = ['status', 'driver_id', 'fare', 'notes', 'payment', 'passenger_name', 'passenger_phone', 'passenger_email', 'pickup', 'destination', 'stop_address', 'date', 'time', 'passengers', 'bags', 'flight', 'customer_id', 'paid_at', 'trip_miles'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Diff BEFORE the write — `booking` is the row as it was when this save
  // arrived, and it is the only chance to see what the customer's journey used
  // to say. A field the body never mentioned cannot have changed.
  const customerChanges = [];
  for (const key of CUSTOMER_FIELDS) {
    if (req.body[key] === undefined) continue;
    if (sameCustomerValue(key, booking[key], req.body[key])) continue;
    customerChanges.push({ key, from: booking[key], to: req.body[key] });
  }

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  try {
    db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] booking update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update booking. Please try again.' });
  }

  /* ── THE PRICE MOVED ON A TRIP THEY HAD ALREADY PAID FOR ───────────────
     Only the DIFFERENCE is ever settled — never the full new fare, which
     would take the money twice for one journey.

       new < paid   we owe them back            → 'refund'
       new > paid   they owe us the balance     → 'topup'
       new = paid   nothing outstanding         → any open difference is cleared

     NOTHING IS CHARGED OR REFUNDED HERE. This only records what is
     outstanding. A refund needs the owner's deliberate click
     (POST /bookings/:id/fare-refund); a balance needs the customer to pay it.

     `paid_amount` is what was actually collected. Bookings settled before that
     column existed fall back to the fare as it stood before this edit — which
     is, by definition, the price they were charged. Re-pricing twice simply
     recomputes against the same collected amount and re-stamps
     fare_adjust_at, minting a fresh idempotency key so a refund issued for the
     old difference can never be counted as settling the new one.

     GUARDRAIL: server/tests/fare-adjust.test.js */
  const { round2 } = require('./pay-lock');
  let fareAdjust = null;
  const fareMoved = customerChanges.some(c => c.key === 'fare');
  const wasPrepaid = !!booking.paid_at;
  if (fareMoved && wasPrepaid && booking.status !== 'cancelled') {
    const collected = round2(booking.paid_amount != null ? booking.paid_amount : booking.fare);
    const newFare = round2(req.body.fare);
    if (isFinite(collected) && collected > 0 && isFinite(newFare) && newFare >= 0) {
      const diff = round2(newFare - collected);
      if (Math.abs(diff) < 0.01) {
        // The new price matches what we hold. Clear any difference that has NOT
        // been settled; one that has is left alone, because paid_amount already
        // reflects it and the audit log holds the record.
        db.prepare(`UPDATE bookings SET fare_adjust_kind = NULL, fare_adjust_amount = NULL,
                           fare_adjust_paid = NULL, fare_adjust_at = NULL, fare_adjust_method = NULL,
                           updated_at = datetime('now')
                     WHERE id = ? AND fare_adjust_settled_at IS NULL`).run(id);
      } else {
        // Recomputed against what we CURRENTLY hold, every time. A settled
        // refund has already reduced paid_amount and a settled balance has
        // already increased it, so re-pricing a second time produces a genuinely
        // new difference rather than double-counting the first one.
        const kind = diff < 0 ? 'refund' : 'topup';
        const amount = round2(Math.abs(diff));
        // A refund can never exceed what was actually taken. Belt and braces:
        // the refund route caps it again against the recorded figure.
        const capped = kind === 'refund' ? Math.min(amount, collected) : amount;
        // The method is decided by how they PAID, not by what we would prefer.
        // Cash cannot be refunded through Stripe, and pretending otherwise is
        // how an owner ends up thinking money went back when it did not.
        const method = kind === 'refund'
          ? (String(booking.payment || '').toLowerCase() === 'card' ? 'stripe' : 'cash')
          : null;
        try {
          db.prepare(`UPDATE bookings
                         SET fare_adjust_kind = ?, fare_adjust_amount = ?, fare_adjust_paid = ?,
                             fare_adjust_at = datetime('now'), fare_adjust_method = ?,
                             fare_adjust_settled_at = NULL, fare_adjust_ref = NULL,
                             status = CASE WHEN ? = 'topup' AND status IN ('confirmed','pending','offered')
                                           THEN 'awaiting_payment' ELSE status END,
                             updated_at = datetime('now')
                       WHERE id = ?`).run(kind, capped, collected, method, kind, id);
          fareAdjust = { kind, amount: capped, paid: collected, newFare, method };
        } catch (e) {
          // The edit itself has already been saved and must not be lost over
          // this. The owner is told the difference was not recorded.
          console.error('[API] fare adjustment write failed:', e.message);
          fareAdjust = { kind, amount: capped, paid: collected, newFare, method, error: true };
        }
      }
    }
  }

  // If THIS update transitioned the booking from pending → confirmed, fire
  // the customer "Booking confirmed" email + WhatsApp. We only fire on the
  // edge so a second confirm doesn't spam the customer.
  const becameConfirmed = req.body.status === 'confirmed' && ['pending', 'awaiting_payment', 'offered'].includes(booking.status);
  if (becameConfirmed) {
    const intake = require('./intake');
    intake.notifyCustomerConfirmed(parseInt(req.params.id, 10))
      .catch(e => console.error('[API] notifyCustomerConfirmed failed:', e.message));
    events.broadcast('booking:confirmed', { id: parseInt(req.params.id, 10), ref: booking.ref, reason: 'Confirmed by operator' });
  }

  // Did THIS update mark the trip completed? Computed on the edge (was not
  // already completed) so re-saving a completed booking never re-triggers the
  // review-request email below.
  const becameCompleted = req.body.status === 'completed' && booking.status !== 'completed';

  // If THIS update cancelled a live booking, email the customer our apology.
  // Only fire on the edge (was not already cancelled) so re-cancelling is quiet.
  const becameCancelled = req.body.status === 'cancelled' && booking.status !== 'cancelled';
  if (becameCancelled && booking.passenger_email) {
    sendCustomerCancellation({
      ref: booking.ref, name: booking.passenger_name, email: booking.passenger_email,
      pickup: booking.pickup, destination: booking.destination,
      date: booking.date, time: booking.time, fare: booking.fare, flight: booking.flight
    }).catch(e => console.error('[API] sendCustomerCancellation failed:', e.message));
  }

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type, req.auth.id, 'booking_updated', booking.ref, req.ip);

  // Broadcast all status changes so connected staff apps refresh immediately.
  if (req.body.status && req.body.status !== booking.status) {
    events.broadcast('booking:updated', {
      id: parseInt(req.params.id, 10), ref: booking.ref,
      status: req.body.status, prev_status: booking.status
    });
  }

  // Sync to Google Calendar in background
  const updated = db.prepare(`
    SELECT b.*,
           COALESCE(c.full_name, b.passenger_name) as customer_name,
           COALESCE(c.phone,     b.passenger_phone) as customer_phone,
           COALESCE(b.passenger_email, c.email)     as customer_email
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(req.params.id);
  if (updated) {
    // Auto-file updated booking (non-blocking)
    autoFile.fileBooking(updated);
    if (updated.status === 'completed') autoFile.updateEarnings(updated.date ? updated.date.slice(0, 7) : null, getDb);

    // Marking a trip COMPLETED invites the customer to leave a Google review.
    // Fires on the completion edge, but ONCE PER CUSTOMER EMAIL for their
    // lifetime: if a review request was ever sent to this email (on any past
    // trip), we skip it — a repeat customer is never asked twice. Dedup key is
    // the lowercased email in review_emails_sent.
    if (becameCompleted) {
      const { sendReviewRequest } = require('./email');
      const reviewEmail = updated.passenger_email ||
        (updated.customer_id ? (db.prepare('SELECT email FROM customers WHERE id = ?').get(updated.customer_id) || {}).email : null);
      if (reviewEmail) {
        const emailKey = reviewEmail.trim().toLowerCase();
        const alreadyAsked = db.prepare('SELECT 1 FROM review_emails_sent WHERE email = ?').get(emailKey);
        if (!alreadyAsked) {
          // The FULL name — email.js decides how to address somebody, and it
          // cannot do that from a name this line has already truncated to
          // "Mr". Splitting here is what produced "Dear Mr,".
          const reviewName = updated.customer_name || updated.passenger_name || '';
          sendReviewRequest(reviewEmail, reviewName, updated.ref)
            .then(ok => {
              if (ok) {
                // Record per-email so this customer is never asked again, and
                // stamp the booking for reference/UI.
                try { db.prepare('INSERT OR IGNORE INTO review_emails_sent (email) VALUES (?)').run(emailKey); } catch (_) {}
                try { db.prepare("UPDATE bookings SET review_request_sent_at = datetime('now') WHERE id = ?").run(updated.id); } catch (_) {}
              }
            })
            .catch(e => console.error('[API] sendReviewRequest failed:', e.message));
        }
      }
    }

    // ── Operator's shared calendar ───────────────────────────────────────
    if (updated.status === 'cancelled' && updated.calendar_event_id) {
      gcal.deleteEvent(updated.calendar_event_id).then(ok => {
        if (ok) {
          try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(updated.id); } catch (e) {}
        }
      }).catch(() => {});
    } else if (updated.calendar_event_id) {
      gcal.updateEvent(updated.calendar_event_id, updated).catch(() => {});
    } else if (updated.status !== 'cancelled') {
      gcal.createEvent(updated).then(eventId => {
        if (eventId) {
          try { db.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').run(eventId, updated.id); } catch (e) {}
        }
      }).catch(() => {});
    }

  }

  /* ── TELL THE CUSTOMER THEIR JOURNEY MOVED ─────────────────────────────
     The operator edited something the customer travels on, so they are
     emailed the was → now diff and the booking as it now reads.

     Four reasons NOT to send, each deliberate:
       no-change   nothing on CUSTOMER_FIELDS actually differs — a no-op save,
                   or an internal-only edit (the note, the driver, a status).
       suppressed  this same save is already sending them a confirmation or a
                   cancellation, which carries the new details itself. One edit
                   must never put two emails in one inbox — and a booking that
                   has just been cancelled or completed has nothing to update.
       no-email    no address on the booking (a phone-only job).
       failed      Resend rejected it. The operator is told, so they can pick
                   up the phone instead of assuming it landed.

     Awaited, not fired and forgotten: the whole point of the feature is that
     the owner knows it went out, and a promise nobody waits on cannot report
     that. GUARDRAIL: server/tests/booking-updated.test.js */
  let customerNotified = false;
  let notifyReason = 'no-change';
  if (customerChanges.length) {
    const settledByThisSave = becameConfirmed || becameCancelled;
    const finished = updated && (updated.status === 'cancelled' || updated.status === 'completed');
    const custEmail = updated ? updated.customer_email : null;
    if (settledByThisSave || finished) {
      notifyReason = 'suppressed';
    } else if (!custEmail) {
      notifyReason = 'no-email';
    } else {
      try {
        // Idempotent — an existing token stays valid, so a link already sitting
        // in the customer's inbox keeps working (CLAUDE.md: never re-mint).
        const payToken = require('./intake').ensurePayToken(updated.id, db) || updated.pay_token || null;
        const sentOk = await require('./email').sendCustomerBookingUpdated(
          Object.assign({}, updated, { email: custEmail, name: updated.customer_name, pay_token: payToken }),
          customerChanges, fareAdjust);
        customerNotified = !!sentOk;
        notifyReason = customerNotified ? 'sent' : 'failed';
      } catch (e) {
        console.error('[API] sendCustomerBookingUpdated failed:', e.message);
        notifyReason = 'failed';
      }
    }
    if (customerNotified) {
      try {
        db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
          .run(req.auth.type, req.auth.id, 'booking_update_emailed',
               booking.ref + ' — ' + customerChanges.map(c => c.key).join(', '), req.ip);
      } catch (_) {}
    }
  }

  res.json({
    ok: true,
    customerChanged: customerChanges.map(c => c.key),
    customerNotified,
    notifyReason,
    // The owner's safety step. A refund NEVER happens on a save — the app shows
    // this as a deliberate control the owner has to press.
    fareAdjust: fareAdjust ? {
      kind: fareAdjust.kind, amount: fareAdjust.amount, paid: fareAdjust.paid,
      newFare: fareAdjust.newFare, method: fareAdjust.method,
      error: !!fareAdjust.error
    } : null
  });
});

/* ── REFUND THE DIFFERENCE ON A RE-PRICED PREPAID TRIP ───────────────────
   The owner's deliberate click, never automatic. Saving a lower fare only
   RECORDS that money is owed back; this is the moment it actually moves.

   Refunds exactly the recorded difference, against the original charge, and
   only ever once:
     · the DB latch — the UPDATE is conditional on fare_adjust_settled_at
       still being NULL, so two clicks cannot both record a refund;
     · the STRIPE latch — the idempotency key is the adjustment key, so even
       if two requests race past the DB check, Stripe replays the first refund
       instead of creating a second. Money leaves the account once.
   And it can never exceed what was collected: the amount is capped against
   the paid figure recorded when the difference was raised.

   Cash bookings never touch Stripe. There is no charge to refund against, so
   the click records that the owner is settling it by hand.
   GUARDRAIL: server/tests/fare-adjust.test.js */
router.post('/bookings/:id/fare-refund', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const { openAdjustment, round2 } = require('./pay-lock');
  const adj = openAdjustment(booking);

  // Already done → say so and stop. Idempotent by design: the owner double-taps
  // a button on a phone, and the second tap must be a no-op, not a second
  // refund.
  if (!adj) {
    if (booking.fare_adjust_kind === 'refund' && booking.fare_adjust_settled_at) {
      return res.json({ ok: true, outcome: 'already_refunded',
                        method: booking.fare_adjust_method || 'manual',
                        amount: booking.fare_adjust_amount || 0 });
    }
    return res.status(409).json({ error: 'There is no refund outstanding on this booking.' });
  }
  if (adj.kind !== 'refund') {
    return res.status(409).json({ error: 'This booking is owed a balance, not a refund.' });
  }

  // Never more than was actually collected.
  const collected = round2(booking.fare_adjust_paid != null ? booking.fare_adjust_paid
                    : (booking.paid_amount != null ? booking.paid_amount : booking.fare));
  const amount = round2(Math.min(adj.amount, collected));
  if (!(amount > 0)) return res.status(409).json({ error: 'There is nothing to refund.' });
  if (amount > collected + 0.005) {
    console.error('[REFUND] refused — £' + amount + ' exceeds the £' + collected + ' collected on ' + booking.ref);
    return res.status(409).json({ error: 'That refund is larger than the amount paid.' });
  }

  const stripe = require('./stripe');
  const paidByCard = String(booking.payment || '').toLowerCase() === 'card';
  let method = 'cash', refundId = null;

  if (paidByCard && stripe.isConfigured()) {
    let intentId = booking.payment_intent_id || null;
    if (!intentId) { try { intentId = await stripe.findPaymentIntentByRef(booking.ref); } catch (_) {} }
    if (intentId) {
      try {
        const refund = await stripe.createRefund({
          paymentIntentId: intentId,
          amount: Math.round(amount * 100),
          idempotencyKey: 'wm-fare-refund-' + adj.key
        });
        method = 'stripe';
        refundId = refund.id;
      } catch (e) {
        // The booking is untouched — nothing is recorded as refunded, so the
        // owner can try again or settle by hand. A Stripe failure must never
        // leave the row claiming money went back when it did not.
        console.error('[REFUND] Stripe partial refund failed for', booking.ref, ':', e.message);
        return res.status(502).json({ error: 'Stripe refund failed: ' + e.message });
      }
    } else {
      method = 'manual';   // card booking, but no charge on file to refund against
    }
  } else if (paidByCard && !stripe.isConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured — cannot refund this card payment.' });
  }

  // Record it. Conditional on the difference still being open: if another
  // request settled it while Stripe was working, we do NOT write a second
  // record — and Stripe's idempotency key means no second refund was created.
  const info = db.prepare(`
    UPDATE bookings
       SET fare_adjust_settled_at = datetime('now'),
           fare_adjust_method = ?,
           fare_adjust_ref = ?,
           paid_amount = MAX(COALESCE(paid_amount, 0) - ?, 0),
           updated_at = datetime('now')
     WHERE id = ?
       AND fare_adjust_kind = 'refund'
       AND fare_adjust_settled_at IS NULL
  `).run(method, refundId, amount, id);

  if (info.changes === 0) {
    return res.json({ ok: true, outcome: 'already_refunded', method, amount, refund_id: refundId });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'fare_refunded',
           booking.ref + ' £' + amount.toFixed(2) + ' [' + method + (refundId ? ' ' + refundId : '') + ']', req.ip);
  } catch (_) {}
  events.broadcast('booking:updated', { id, ref: booking.ref, reason: 'Fare refund issued' });

  return res.json({
    ok: true,
    outcome: method === 'stripe' ? 'refunded_stripe' : 'refunded_manual',
    method, amount, refund_id: refundId,
    message: method === 'stripe'
      ? '£' + amount.toFixed(2) + ' refunded to the customer’s card. It usually shows in 5–10 days.'
      : '£' + amount.toFixed(2) + ' recorded as refunded — return it to the customer by hand.'
  });
});

// NOTE: the old POST /bookings/:id/send-estimate endpoint was removed. Setting
// a price and notifying the customer now goes through PATCH /bookings/:id with
// { status:'confirmed', fare } — the same flow as Confirm — which mints a
// pay_token and emails the confirmation with the payment link.

// Customer self-cancel — only the owning customer may cancel their own booking
// and only if the booking is still in a cancellable state.
router.post('/customer/bookings/:id/cancel', (req, res) => {
  if (req.auth.role !== 'customer') {
    return res.status(403).json({ error: 'Customer access required' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Ownership check — the booking must belong to this customer.
  // customer_id ALONE is not enough: it is only set when a booking is created
  // while an account with that email already exists, so it is NULL for every
  // job the owner enters by hand and for anything booked before the customer
  // registered. Those trips are listed in My Account (GET /bookings matches on
  // the verified email too) — so without the same rule here, the customer sees
  // a Cancel button on their own trip and gets a 403. Same rule, same place.
  const me = db.prepare('SELECT email FROM customers WHERE id = ?').get(req.auth.id) || {};
  const myEmail = String(me.email || '').trim().toLowerCase();
  const ownsById = booking.customer_id === req.auth.id;
  const ownsByEmail = !booking.customer_id && myEmail &&
    String(booking.passenger_email || '').trim().toLowerCase() === myEmail;
  if (!ownsById && !ownsByEmail) {
    return res.status(403).json({ error: 'You can only cancel your own bookings' });
  }

  // State guard — can't cancel a trip that's already underway or done
  const cancellable = ['pending', 'confirmed', 'offered'];
  if (!cancellable.includes(booking.status)) {
    return res.status(409).json({ error: 'This booking cannot be cancelled at this stage' });
  }

  try {
    db.prepare(`UPDATE bookings SET status = 'cancelled', notes = CASE WHEN notes IS NULL OR notes = '' THEN 'Cancelled by customer' ELSE notes || ' | Cancelled by customer' END, updated_at = datetime('now') WHERE id = ?`).run(id);
  } catch (e) {
    console.error('[API] customer cancel failed:', e.message);
    return res.status(500).json({ error: 'Failed to cancel booking. Please try again.' });
  }

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run('customer', req.auth.id, 'booking_cancelled_by_customer', booking.ref, req.ip);

  events.broadcast('booking:updated', {
    id, ref: booking.ref, status: 'cancelled', prev_status: booking.status
  });

  // Remove from Google Calendar in background
  if (booking.calendar_event_id) {
    const gcal = require('./google-calendar');
    gcal.deleteEvent(booking.calendar_event_id).then(ok => {
      if (ok) {
        try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(id); } catch (e) {}
      }
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// CUSTOMER CHANGE REQUEST — "please move my trip", handled by a human
// ══════════════════════════════════════════════════════════════════════════
//
// THE ONE RULE: this endpoint NEVER amends the booking. Not the journey, not
// the date, not the passengers, not the fare, and above all not the status.
// A customer editing their pickup address in My Account must not be able to
// silently re-route a job the driver is already planning around, and must not
// be able to nudge a `pending` booking into `confirmed` — that is the same
// class of fault as the "Mr Ben" incident (see CLAUDE.md: estimate-first).
//
// What it does instead: records exactly what was asked in `change_requests`,
// flags the booking so the owner and admin apps show "Change requested", and
// emails the owner so they can apply it by hand with the existing edit tools.
// The customer is told plainly that the booking stands until we confirm.
//
// GUARDRAIL: server/tests/change-request.test.js asserts (a) no core field or
// status moves, (b) the owner is emailed with the ref + the diff, (c) a
// customer cannot request a change on somebody else's booking, (d) both staff
// apps surface it.

// The fields a customer may propose. Anything not in this list is ignored —
// fare, status, driver and payment are not the customer's to ask for here.
const CHANGE_REQUEST_FIELDS = ['pickup', 'stop_address', 'destination', 'date', 'time', 'passengers', 'bags', 'flight'];

// Normalise a value for COMPARISON only. Used to decide whether the customer
// actually changed a field, so that re-submitting the form untouched doesn't
// report eight "changes" purely from whitespace or casing.
function crNorm(key, v) {
  if (v == null) return '';
  if (key === 'passengers') { const n = parseInt(v, 10); return isNaN(n) ? '' : String(n); }
  const s = String(v).trim();
  if (key === 'flight') return s.toUpperCase();
  return s;
}

router.post('/customer/bookings/:id/change-request', async (req, res) => {
  if (req.auth.role !== 'customer') {
    return res.status(403).json({ error: 'Customer access required' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Ownership — deliberately the SAME rule as the trip list (GET /bookings)
  // and self-cancel above, and for the same reason: customer_id is NULL for
  // every job the owner enters by hand and for anything booked before the
  // customer registered. Those trips ARE listed in My Account, so a stricter
  // rule here would show the customer a "Request a change" button on their own
  // booking and then refuse it. A looser one would let anyone signed in file a
  // request against a stranger's trip.
  const me = db.prepare('SELECT email, full_name, phone FROM customers WHERE id = ?').get(req.auth.id) || {};
  const myEmail = String(me.email || '').trim().toLowerCase();
  const ownsById = booking.customer_id === req.auth.id;
  const ownsByEmail = !booking.customer_id && myEmail &&
    String(booking.passenger_email || '').trim().toLowerCase() === myEmail;
  if (!ownsById && !ownsByEmail) {
    return res.status(403).json({ error: 'You can only request changes to your own bookings' });
  }

  // Only a trip that is still ahead of us can be amended. A completed or
  // cancelled booking is a record, and an in-progress one is a phone call.
  const changeable = ['pending', 'offered', 'awaiting_payment', 'confirmed'];
  if (!changeable.includes(booking.status)) {
    return res.status(409).json({ error: 'This booking can no longer be changed online — please call us on 07930 342593.' });
  }

  // ── Validate what they asked for ──
  const body = req.body || {};
  const current = {};
  const requested = {};
  for (const k of CHANGE_REQUEST_FIELDS) {
    current[k] = booking[k] == null ? '' : booking[k];
    // A field the client omits is not a change — carry the current value.
    requested[k] = Object.prototype.hasOwnProperty.call(body, k) ? body[k] : current[k];
  }

  const trimTo = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  requested.pickup       = trimTo(requested.pickup, 300);
  requested.stop_address = trimTo(requested.stop_address, 300);
  requested.destination  = trimTo(requested.destination, 300);
  requested.flight       = trimTo(requested.flight, 24).toUpperCase();
  requested.bags         = trimTo(requested.bags, 24);
  requested.date         = trimTo(requested.date, 10);
  requested.time         = trimTo(requested.time, 10);

  if (!requested.pickup || !requested.destination) {
    return res.status(400).json({ error: 'Pickup and destination are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested.date)) {
    return res.status(400).json({ error: 'Please choose a valid date' });
  }
  // A wall-clock UK date, compared as a string against a UK wall-clock today —
  // never through a Date instant. See the timezone invariant in CLAUDE.md.
  if (requested.date < ukNow().dateStr) {
    return res.status(400).json({ error: 'Please choose a date in the future' });
  }
  if (!(requested.time === 'ASAP' || /^([01]\d|2[0-3]):[0-5]\d$/.test(requested.time))) {
    return res.status(400).json({ error: 'Please choose a valid time' });
  }
  const pax = parseInt(requested.passengers, 10);
  if (isNaN(pax) || pax < 1 || pax > 8) {
    return res.status(400).json({ error: 'Passengers must be between 1 and 8' });
  }
  requested.passengers = pax;

  const note = trimTo(body.note, 1000);

  // ── What actually differs ──
  const changed = {};
  for (const k of CHANGE_REQUEST_FIELDS) {
    if (crNorm(k, requested[k]) !== crNorm(k, current[k])) changed[k] = requested[k];
  }
  if (!Object.keys(changed).length && !note) {
    return res.status(400).json({ error: 'Nothing has changed — please edit a detail or tell us what you need.' });
  }

  // Human-readable summary, stored on the booking so the owner and admin apps
  // can show WHAT was asked without a second fetch. Full addresses on purpose:
  // the owner has to be able to copy the new one in verbatim.
  // Field ORDER comes from the shared lifecycle module, so the Current →
  // Requested comparison reads in the same order everywhere it is drawn.
  const LC = require('../wm-lifecycle');
  const LABELS = {};
  for (const [k, label] of LC.CHANGE_FIELDS) LABELS[k] = label;
  const changedKeys = LC.CHANGE_FIELDS.map(([k]) => k).filter(k => Object.prototype.hasOwnProperty.call(changed, k));
  const summary = changedKeys
    .map(k => LABELS[k] + ': ' + (String(current[k] || '').trim() || '—') + ' → ' + (String(requested[k] || '').trim() || '—'))
    .concat(note ? ['Note: ' + note] : [])
    .join('\n');

  // The same request in the shape the staff apps RENDER. Stored alongside the
  // summary so the owner/admin decision panel can draw Current → Requested per
  // field with no parsing and no second fetch. `price` is advisory only — it
  // raises a warning for the owner, it never re-prices anything.
  const detail = {
    at: null,                       // stamped from the row below, once written
    note: note || '',
    price: LC.changeAffectsPrice(changedKeys),
    changed: changedKeys.map(k => ({
      key: k,
      label: LABELS[k],
      current: String(current[k] == null ? '' : current[k]).trim(),
      requested: String(requested[k] == null ? '' : requested[k]).trim()
    }))
  };

  const contact = {
    name:  booking.passenger_name  || me.full_name || '',
    email: booking.passenger_email || me.email     || '',
    phone: booking.passenger_phone || me.phone     || ''
  };

  let crId = null;
  try {
    // Two writes, one transaction — a request that is recorded but not flagged
    // is invisible to the owner, and a flag with no record behind it is a badge
    // pointing at nothing.
    const save = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO change_requests
          (booking_id, booking_ref, customer_id, contact_name, contact_email, contact_phone,
           current_json, requested_json, changed_json, summary, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(booking.id, booking.ref, req.auth.id, contact.name, contact.email, contact.phone,
             JSON.stringify(current), JSON.stringify(requested), JSON.stringify(changed),
             summary, note || null);
      // NOTE what is NOT in this UPDATE: pickup, destination, stop_address,
      // date, time, passengers, bags, flight, fare, payment, driver_id and
      // status. The booking is untouched — the customer's request records what
      // they ASKED for and nothing else. The only route in the system that
      // ever writes their requested values onto the booking is the staff-only
      // Accept action below, and only when a human presses it.
      // These three columns are a flag and two renderings of the note.
      db.prepare(`UPDATE bookings SET change_requested_at = datetime('now'), change_request_summary = ?, change_request_detail = ? WHERE id = ?`)
        .run(summary, JSON.stringify(detail), booking.id);
      return info.lastInsertRowid;
    });
    crId = save();
  } catch (e) {
    console.error('[API] change request save failed:', e.message);
    return res.status(500).json({ error: 'We could not record that request. Please call us on 07930 342593.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('customer', req.auth.id, 'booking_change_requested', booking.ref + ' — ' + summary.replace(/\n/g, ' | '), req.ip);
  } catch (e) { console.error('[API] change request audit failed:', e.message); }

  // Tell the staff apps to refresh so the badge appears without a manual reload.
  try {
    events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, change_requested: true });
  } catch (e) { console.error('[API] change request broadcast failed:', e.message); }

  // The email is a NOTIFICATION, not the record — change_requests already has
  // it. A Resend outage must not lose the request or fail the customer's
  // submission, so a send failure is logged and swallowed.
  let emailed = false;
  try {
    emailed = await require('./email').sendOwnerChangeRequest(booking, { current, requested, changed, note, contact });
  } catch (e) {
    console.error('[API] change request owner email failed:', e.message);
  }

  res.json({ ok: true, id: crId, emailed: !!emailed, summary });
});

// ── STAFF-ONLY resolution of a change request ────────────────────────────
//
// Three separate acts, deliberately kept apart, because they mean different
// things to the customer and only one of them touches the booking:
//
//   review  — EARLY stage (the trip is not committed yet). There is nothing to
//             accept: the owner re-prices with the new details and sends the
//             estimate. This just dismisses the note. Booking untouched.
//   accept  — DECISION stage. APPLIES the customer's requested values to the
//             booking. This is the ONLY route in the system that ever does so,
//             it is staff-authenticated, and it happens only when a human
//             presses the button. Money is NOT touched (see below).
//   decline — DECISION stage. Keeps the booking exactly as originally booked
//             and clears the flag, so the owner can message the customer to
//             explain. Booking untouched.

// ── CUSTOMER SPEND (admin reporting) ─────────────────────────────────────
// Who has actually spent money with the company, ranked. Read-only: this route
// computes and returns, it never writes, and it does not touch the fare or
// payment logic.
//
// WHAT COUNTS AS "SPENT" — the headline figure is money that genuinely changed
// hands, not money quoted:
//   paid      fare > 0, NOT cancelled, AND (paid_at is set OR status is
//             'completed'). paid_at covers card payments (written by the
//             Stripe webhook) and anything the owner marked paid; 'completed'
//             covers a cash job where the driver collected on the day.
//   quoted    fare > 0, NOT cancelled, and not in the paid set — a real
//             estimate the customer has not settled. Reported alongside so the
//             owner can see exposure, but it is NOT part of the total spent.
//   ignored   cancelled trips, and anything with no fare.
//
// IDENTITY: customers are deduped by EMAIL, lower-cased and trimmed, taking the
// registered account email first and the one typed on the booking second. A
// booking with no email at all falls back to the name, so a phone/manual
// booking still aggregates rather than vanishing.
//
// STAFF ONLY. This is the owner's business data — names, emails and spend — so
// it sits on the authenticated /api router (never /api/public) behind the same
// role gate every other staff route uses.
// GUARDRAIL: server/tests/customer-spend.test.js
router.get('/customer-spend', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.id, b.fare, b.status, b.payment, b.paid_at, b.date,
           COALESCE(c.email, b.passenger_email)     AS email,
           COALESCE(c.full_name, b.passenger_name)  AS name
    FROM bookings b
    LEFT JOIN customers c ON b.customer_id = c.id
  `).all();

  const byKey = new Map();
  for (const r of rows) {
    const fare = Number(r.fare);
    if (!isFinite(fare) || fare <= 0) continue;                 // no money involved
    const status = String(r.status || '').toLowerCase();
    if (status === 'cancelled') continue;                        // never revenue

    const email = String(r.email || '').trim().toLowerCase();
    const name = String(r.name || '').trim();
    const key = email || ('name:' + name.toLowerCase());
    if (!key || key === 'name:') continue;                       // nothing to group by

    let e = byKey.get(key);
    if (!e) {
      e = { key, name: name || email, email, trips: 0, totalSpent: 0,
            quotedUnpaid: 0, unpaidTrips: 0, lastTrip: null };
      byKey.set(key, e);
    }
    // Prefer a real name over an email as the display label.
    if (!e.name || e.name === e.email) { if (name) e.name = name; }
    if (!e.email && email) e.email = email;

    // ONE definition of revenue, shared with the customer detail page. This
    // used to be spelled out here; a second copy over there would eventually
    // have disagreed with this one about the same customer.
    const settled = require('./customer-directory').isSettledForSpend(r);
    if (settled) {
      e.totalSpent += fare;
      e.trips += 1;
      if (r.date && (!e.lastTrip || r.date > e.lastTrip)) e.lastTrip = r.date;
    } else {
      e.quotedUnpaid += fare;
      e.unpaidTrips += 1;
    }
  }

  const customers = [...byKey.values()]
    .filter(e => e.trips > 0 || e.quotedUnpaid > 0)
    .map(e => ({
      name: e.name, email: e.email,
      trips: e.trips,
      totalSpent: Math.round(e.totalSpent * 100) / 100,
      avgPerTrip: e.trips ? Math.round((e.totalSpent / e.trips) * 100) / 100 : 0,
      quotedUnpaid: Math.round(e.quotedUnpaid * 100) / 100,
      unpaidTrips: e.unpaidTrips,
      lastTrip: e.lastTrip
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent || b.trips - a.trips);

  res.json({
    ok: true,
    definition: 'Spent = fare on trips that are paid (paid_at set) or completed. Cancelled trips and unfared bookings are excluded.',
    totals: {
      customers: customers.length,
      revenue: Math.round(customers.reduce((s, c) => s + c.totalSpent, 0) * 100) / 100,
      outstanding: Math.round(customers.reduce((s, c) => s + c.quotedUnpaid, 0) * 100) / 100
    },
    customers
  });
});

// Shared preamble: staff-only, booking must exist. Returns null (having
// already answered) when the caller may not proceed.
function staffBooking(req, res) {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    res.status(403).json({ error: 'Staff access required' });
    return null;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid booking ID' }); return null; }
  const booking = getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) { res.status(404).json({ error: 'Booking not found' }); return null; }
  return booking;
}

// Clear the flag columns and close off the open request(s) with an outcome.
// The change_requests rows themselves are kept for good — only their status
// moves — so the owner can always see what was once asked, and what was done.
function closeChangeRequests(db, bookingId, outcome, staffId) {
  db.prepare(`UPDATE change_requests SET status = ?, actioned_at = datetime('now'), actioned_by = ? WHERE booking_id = ? AND status = 'open'`)
    .run(outcome, staffId, bookingId);
  db.prepare(`UPDATE bookings SET change_requested_at = NULL, change_request_summary = NULL, change_request_detail = NULL WHERE id = ?`)
    .run(bookingId);
}

// EARLY stage: "seen it, I'll price the new details." Nothing is applied,
// because at this stage the owner is about to re-quote from scratch anyway.
router.post('/bookings/:id/change-request/review', (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  const db = getDb();
  try {
    db.transaction(() => closeChangeRequests(db, booking.id, 'reviewed', req.auth.id))();
  } catch (e) {
    console.error('[API] change request review failed:', e.message);
    return res.status(500).json({ error: 'Could not clear that change request' });
  }
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.role, req.auth.id, 'booking_change_reviewed', booking.ref, req.ip);
  events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, change_requested: false });
  res.json({ ok: true });
});

// DECISION stage: DECLINE. The journey stands exactly as it was booked.
router.post('/bookings/:id/change-request/decline', (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  const db = getDb();
  const before = CHANGE_REQUEST_FIELDS.map(k => booking[k]);
  try {
    db.transaction(() => closeChangeRequests(db, booking.id, 'declined', req.auth.id))();
  } catch (e) {
    console.error('[API] change request decline failed:', e.message);
    return res.status(500).json({ error: 'Could not decline that change request' });
  }
  // Belt-and-braces: declining must leave the journey byte-identical. If this
  // ever fires, something in closeChangeRequests has grown a side effect.
  const after = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const moved = CHANGE_REQUEST_FIELDS.filter((k, i) => after[k] !== before[i]);
  if (moved.length) console.error('[API] DECLINE ALTERED THE BOOKING:', booking.ref, moved.join(','));

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.role, req.auth.id, 'booking_change_declined', booking.ref, req.ip);
  events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, change_requested: false });
  res.json({ ok: true });
});

// DECISION stage: ACCEPT — apply the requested journey details to the booking.
//
// WHAT THIS WRITES: pickup, stop_address, destination, date, time, passengers,
// bags, flight. That is the whole list.
//
// WHAT IT DELIBERATELY DOES NOT WRITE: `fare`, `payment`, `paid_at`, `status`.
// A longer journey or an extra passenger may well be worth more, but this
// endpoint will not re-price, take a payment, or issue a refund — the owner
// settles money with the customer by hand (their explicit decision). Instead a
// change that CAN move the price raises `fare_review_at`, which keeps
// "Fare may change — confirm with the customer" on the job until dismissed.
// Not touching `status` matters just as much: accepting a new pickup time must
// never quietly re-confirm or un-confirm a booking.
router.post('/bookings/:id/change-request/accept', async (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  const db = getDb();

  const cr = db.prepare(`SELECT * FROM change_requests WHERE booking_id = ? AND status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1`).get(booking.id);
  if (!cr) return res.status(409).json({ error: 'There is no open change request on this booking' });

  let requested;
  try { requested = JSON.parse(cr.requested_json); } catch (e) { requested = null; }
  if (!requested || typeof requested !== 'object') {
    console.error('[API] change request', cr.id, 'has an unreadable requested_json');
    return res.status(500).json({ error: 'That change request could not be read. Please amend the booking by hand.' });
  }

  // RE-VALIDATE at apply time. The values were checked when the customer sent
  // them, but that may have been days ago and this is the moment they actually
  // reach the booking — so the same rules run again rather than trusting a
  // stored blob. A date that has since passed is the realistic case.
  const applied = {};
  for (const k of CHANGE_REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(requested, k)) continue;
    applied[k] = requested[k];
  }
  if (!String(applied.pickup || booking.pickup).trim() || !String(applied.destination || booking.destination).trim()) {
    return res.status(400).json({ error: 'The request has no pickup or destination — please amend by hand.' });
  }
  if (applied.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(applied.date))) {
    return res.status(400).json({ error: 'The requested date is not valid — please amend by hand.' });
  }
  if (applied.time !== undefined && !(applied.time === 'ASAP' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(applied.time)))) {
    return res.status(400).json({ error: 'The requested time is not valid — please amend by hand.' });
  }
  if (applied.passengers !== undefined) {
    const pax = parseInt(applied.passengers, 10);
    if (isNaN(pax) || pax < 1 || pax > 8) {
      return res.status(400).json({ error: 'The requested passenger count is not valid — please amend by hand.' });
    }
    applied.passengers = pax;
  }

  // Only what genuinely differs from the booking as it stands right now.
  const cols = CHANGE_REQUEST_FIELDS.filter(k =>
    Object.prototype.hasOwnProperty.call(applied, k) && crNorm(k, applied[k]) !== crNorm(k, booking[k]));
  const LC = require('../wm-lifecycle');
  const priceMayChange = LC.changeAffectsPrice(cols);

  try {
    db.transaction(() => {
      if (cols.length) {
        db.prepare(`UPDATE bookings SET ${cols.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...cols.map(k => applied[k]), booking.id);
      }
      if (priceMayChange) {
        db.prepare(`UPDATE bookings SET fare_review_at = datetime('now') WHERE id = ?`).run(booking.id);
      }
      closeChangeRequests(db, booking.id, 'accepted', req.auth.id);
    })();
  } catch (e) {
    console.error('[API] change request accept failed:', e.message);
    return res.status(500).json({ error: 'Could not apply that change. Please amend the booking by hand.' });
  }

  const detail = booking.ref + ' — applied: ' + (cols.length ? cols.join(', ') : 'nothing differed') +
    (priceMayChange ? ' | fare review raised' : '');
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.role, req.auth.id, 'booking_change_accepted', detail, req.ip);

  events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, change_requested: false, changed: cols });

  // The journey moved, so the operator's shared calendar has to move with it —
  // otherwise the driver's feed keeps the old time and the whole point of
  // accepting the change is lost. Background, same as PATCH /bookings/:id.
  const updated = db.prepare(`
    SELECT b.*,
           COALESCE(c.full_name, b.passenger_name) as customer_name,
           COALESCE(c.phone,     b.passenger_phone) as customer_phone
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(booking.id);
  if (updated) {
    try { autoFile.fileBooking(updated); } catch (e) {}
    if (updated.calendar_event_id) {
      gcal.updateEvent(updated.calendar_event_id, updated).catch(() => {});
    }
  }

  // Price the NEW journey for the owner. This is a SUGGESTION only — nothing is
  // written, nothing is charged. The owner sees it pre-filled in the fare box,
  // overrides it if they disagree, and only then does the estimate go out.
  // Non-blocking: the accept has already succeeded, so a geocoding hiccup must
  // cost the suggestion, not the change.
  let suggestion = null;
  if (priceMayChange && updated) {
    suggestion = await suggestFareFor(updated);
  }

  res.json({
    ok: true,
    applied: cols,
    fare_review: priceMayChange,
    suggested_fare: suggestion,
    current_fare: booking.fare == null ? null : Number(booking.fare),
    prior_payment: settledPaymentOf(booking)
  });
});

// ── The fare step that follows an accepted change ────────────────────────
//
// What a settled payment on this booking amounts to right now, so the owner is
// never re-pricing a journey without seeing what has already been collected.
function settledPaymentOf(b) {
  if (!b) return null;
  const paid = !!b.paid_at || String(b.payment || '').toLowerCase() === 'card';
  if (!paid) return null;
  return {
    amount: b.fare == null ? null : Number(b.fare),
    method: String(b.payment || '').toLowerCase() || 'card',
    at: b.paid_at || null
  };
}

// Quick-estimate the journey as it now stands. Never throws — a null suggestion
// just means the owner types the figure themselves.
async function suggestFareFor(b) {
  try {
    const { computeSuggestedFare } = require('./fare-engine');
    const sf = await computeSuggestedFare(b.pickup, b.destination, b.time);
    return (sf && sf.fare) ? Number(sf.fare) : null;
  } catch (e) {
    console.error('[API] suggested fare failed (non-blocking):', e.message);
    return null;
  }
}

// Owner/admin: what should this journey cost, and what has already been paid?
// Backs the fare box on a job flagged for fare review — including after a page
// reload, when the figure returned by Accept is long gone.
router.get('/bookings/:id/suggested-fare', async (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  res.json({
    ok: true,
    suggested_fare: await suggestFareFor(booking),
    current_fare: booking.fare == null ? null : Number(booking.fare),
    prior_payment: settledPaymentOf(booking),
    prior_payments: (() => { try { return JSON.parse(booking.prior_payments_json || '[]'); } catch (e) { return []; } })()
  });
});

// ── RE-SEND THE ESTIMATE at a new fare ───────────────────────────────────
//
// The second half of accepting a change: the owner has seen the suggested fare,
// set the figure they actually want, and now the customer is asked to confirm
// the updated journey exactly as they would a fresh quote.
//
// WHAT THIS DOES:
//   · writes the OWNER'S fare (never the suggestion, unless they kept it);
//   · files any payment already collected into prior_payments_json, so a fare
//     taken for the old journey can never silently disappear;
//   · resets the payment state — payment='pending', paid_at=NULL — and puts the
//     booking back to `pending` so the estimate-first ladder runs again:
//     pending → (customer chooses) → awaiting_payment → confirmed;
//   · keeps the SAME pay_token where one exists (so a link already in the
//     customer's inbox still works and shows the live fare), and mints one only
//     if it is absent — e.g. cleared by the earlier card payment;
//   · sends the ORDINARY estimate email — same hero template, same tokenised
//     Pay Now / pay-your-driver / cancel actions.
//
// WHAT IT DOES NOT DO: charge, refund, or take any money. The customer pays the
// new fare through the normal channels, and only one of them can succeed
// (server/pay-lock.js).
router.post('/bookings/:id/re-estimate', async (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  const db = getDb();

  const fare = Number(req.body && req.body.fare);
  if (!isFinite(fare) || fare <= 0) {
    return res.status(400).json({ error: 'Please set a fare above zero' });
  }
  if (fare > 100000) return res.status(400).json({ error: 'That fare looks wrong — please check it' });
  if (booking.status === 'cancelled') {
    return res.status(409).json({ error: 'This booking has been cancelled' });
  }

  const settled = settledPaymentOf(booking);
  let priors = [];
  try { priors = JSON.parse(booking.prior_payments_json || '[]'); } catch (e) { priors = []; }
  if (settled) priors.push(Object.assign({ cleared_at: new Date().toISOString() }, settled));

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE bookings
           SET fare = ?,
               payment = 'pending',
               paid_at = NULL,
               status = CASE WHEN status = 'cancelled' THEN status ELSE 'pending' END,
               prior_payments_json = ?,
               fare_review_at = NULL,
               estimate_sent_at = datetime('now'),
               re_estimated_at = datetime('now'),
               updated_at = datetime('now')
         WHERE id = ?
      `).run(fare, JSON.stringify(priors), booking.id);
    })();
  } catch (e) {
    console.error('[API] re-estimate failed:', e.message);
    return res.status(500).json({ error: 'Could not re-price that booking' });
  }

  // Mint only if absent — an existing token stays valid so a link already in
  // the customer's inbox keeps working (CLAUDE.md: never re-mint a live token).
  // Minted through THIS route's handle so it lands in the same database the
  // update above just wrote to.
  const intake = require('./intake');
  const payToken = intake.ensurePayToken(booking.id, db);

  const row = db.prepare(`
    SELECT b.*, COALESCE(c.full_name, b.passenger_name) AS name,
                COALESCE(c.email, b.passenger_email)    AS email
      FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.id = ?
  `).get(booking.id);

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.role, req.auth.id, 'booking_re_estimated',
         booking.ref + ' — fare £' + fare.toFixed(2) +
         (settled ? ' | prior payment £' + Number(settled.amount || 0).toFixed(2) + ' (' + settled.method + ') retained on record' : ''),
         req.ip);

  events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, status: 'pending', reason: 'Re-estimated after a change' });

  let emailed = false;
  try {
    emailed = await require('./email').sendCustomerEstimate({
      ref: row.ref, name: row.name, email: row.email,
      pickup: row.pickup, destination: row.destination, stop_address: row.stop_address,
      date: row.date, time: row.time, flight: row.flight, passengers: row.passengers,
      fare: fare, notes: row.notes, pay_token: payToken
    });
  } catch (e) {
    console.error('[API] re-estimate email failed:', e.message);
  }

  res.json({ ok: true, fare: fare, emailed: !!emailed, prior_payment: settled });
});

// Dismiss the "Fare may change" flag once the owner has settled the money with
// the customer. Deliberately separate from Accept: accepting the journey change
// and sorting out what it costs are two different conversations.
router.post('/bookings/:id/fare-review/clear', (req, res) => {
  const booking = staffBooking(req, res);
  if (!booking) return;
  const db = getDb();
  try {
    db.prepare(`UPDATE bookings SET fare_review_at = NULL WHERE id = ?`).run(booking.id);
  } catch (e) {
    console.error('[API] fare review clear failed:', e.message);
    return res.status(500).json({ error: 'Could not clear that fare review' });
  }
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.role, req.auth.id, 'booking_fare_review_cleared', booking.ref, req.ip);
  events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, fare_review: false });
  res.json({ ok: true });
});

// Owner/admin: the full history of change requests on a booking, newest first.
// The booking row carries only the latest summary; this is where the owner can
// see everything that was ever asked, including requests already actioned.
router.get('/bookings/:id/change-requests', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const rows = db.prepare(`SELECT * FROM change_requests WHERE booking_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`).all(id);
  res.json({ ok: true, requests: rows });
});

// ══════════════════════════════════════════════════════════════════════════
// PAYING FROM MY ACCOUNT — the second channel for the SAME estimate
// ══════════════════════════════════════════════════════════════════════════
//
// The estimate email carries tokenised Pay Now / pay-your-driver links. The
// same estimate is now also payable from My Account, so a customer who has lost
// the email is not stuck. Both channels act on the SAME booking, the SAME
// pay_token and the SAME Stripe payment — and both ask server/pay-lock.js,
// against the live row, whether payment may still proceed. Whichever completes
// first locks the other.
//
// Card deliberately hands off to the EXISTING pay page rather than growing a
// second Stripe integration: one card implementation, one set of guards, one
// place a mistake could ever be made.
//
// GUARDRAIL: server/tests/double-payment.test.js

// Ownership for a customer acting on their own booking — the SAME rule as the
// trip list, self-cancel and change-request (customer_id OR the account email),
// because those are the trips My Account actually shows.
function customerOwnedBooking(req, res) {
  if (req.auth.role !== 'customer') {
    res.status(403).json({ error: 'Customer access required' });
    return null;
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid booking ID' }); return null; }
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) { res.status(404).json({ error: 'Booking not found' }); return null; }

  const me = db.prepare('SELECT email FROM customers WHERE id = ?').get(req.auth.id) || {};
  const myEmail = String(me.email || '').trim().toLowerCase();
  const ownsById = booking.customer_id === req.auth.id;
  const ownsByEmail = !booking.customer_id && myEmail &&
    String(booking.passenger_email || '').trim().toLowerCase() === myEmail;
  if (!ownsById && !ownsByEmail) {
    res.status(403).json({ error: 'You can only pay for your own bookings' });
    return null;
  }
  return booking;
}

// What can this customer do about paying for this trip, right now?
// My Account renders straight from this, so the panel can never offer an option
// the server would refuse a moment later.
router.get('/customer/bookings/:id/pay-options', (req, res) => {
  const booking = customerOwnedBooking(req, res);
  if (!booking) return;
  const { paymentLock } = require('./pay-lock');
  const lock = paymentLock(booking);

  // The token is this customer's own, for their own booking — the same one
  // already in their inbox. Handing it back lets My Account open the ordinary
  // pay page instead of reimplementing card payment.
  let payUrl = null;
  if (lock.payable && booking.pay_token) {
    payUrl = '/westmere-pay.html?ref=' + encodeURIComponent(booking.ref) + '&t=' + encodeURIComponent(booking.pay_token);
  }

  res.json({
    ok: true,
    ref: booking.ref,
    fare: lock.fare,
    // What is actually owed — the fare normally, the balance only on a trip
    // re-priced after it was paid for. My Account must never quote the full
    // new fare to someone who has already paid most of it.
    amountDue: lock.amountDue,
    topUp: lock.reason === 'top_up',
    alreadyPaid: lock.reason === 'top_up' ? lock.alreadyPaid : null,
    status: booking.status,
    payment: booking.payment || 'pending',
    payable: lock.payable,
    locked: lock.locked,
    reason: lock.reason,
    message: lock.message,
    // Card needs a token to hand to the pay page; cash does not (this route is
    // authenticated), so a missing token never blocks the driver option.
    can_card: lock.payable && !!payUrl,
    can_cash: lock.payable,
    pay_url: payUrl
  });
});

// "I'll pay my driver on the day", chosen from My Account.
// Runs the SAME applyCashChoice as the tokenised email link — same write, same
// conditional guard, same audit — so choosing cash here locks card payment
// there, and vice versa.
router.post('/customer/bookings/:id/choose-cash', (req, res) => {
  const booking = customerOwnedBooking(req, res);
  if (!booking) return;
  const db = getDb();
  const { applyCashChoice } = require('./pay-lock');

  const outcome = applyCashChoice(db, booking.id, {
    source: 'My Account', ip: req.ip, userType: 'customer', userId: req.auth.id
  });
  if (!outcome.ok) {
    return res.status(409).json({ error: outcome.message, reason: outcome.reason });
  }

  try {
    events.broadcast('booking:payment', { id: booking.id, ref: booking.ref, mode: 'cash', fare: booking.fare || null });
    if (outcome.wasChosen) {
      events.broadcast('booking:updated', { id: booking.id, ref: booking.ref, status: 'awaiting_payment', reason: 'Customer chose to pay driver on the day' });
    }
  } catch (e) { console.error('[API] cash broadcast failed:', e.message); }

  // Same follow-up as the email channel: the CASH confirmation ("pay your
  // driver on the day"), which is deliberately not a paid receipt.
  if (outcome.wasChosen) {
    try {
      require('./intake').notifyCustomerConfirmed(booking.id)
        .catch(e => console.error('[API] notifyCustomerConfirmed (My Account cash) failed:', e.message));
    } catch (e) { console.error('[API] notifyCustomerConfirmed threw:', e.message); }
  }

  res.json({ ok: true, payment: 'cash', status: 'awaiting_payment' });
});

// ── Customer self-service endpoints ──────────────────────────────────────

// Customer: view their invoices
router.get('/customer/invoices', (req, res) => {
  if (req.auth.type !== 'customer') return res.status(403).json({ error: 'Customer access required' });
  const db = getDb();
  const customer = db.prepare('SELECT email FROM customers WHERE id = ?').get(req.auth.id);
  if (!customer || !customer.email) return res.json({ ok: true, invoices: [] });

  const rows = db.prepare(`
    SELECT id, invoice_no, kind, recipient_name, recipient_email, issued_date, due_date,
           total, paid, paid_at, created_at
    FROM invoices
    WHERE customer_id = ? OR LOWER(recipient_email) = LOWER(?)
    ORDER BY created_at DESC LIMIT 50
  `).all(req.auth.id, customer.email);

  res.json({ ok: true, invoices: rows });
});

// Customer: view their profile
router.get('/customer/profile', (req, res) => {
  if (req.auth.type !== 'customer') return res.status(403).json({ error: 'Customer access required' });
  const db = getDb();
  // Address included so My Details can show the customer the home address we
  // actually hold for them. Scoped to req.auth.id — never an id from the client.
  const row = db.prepare('SELECT id, email, full_name, phone, address_line1, address_line2, postcode, created_at FROM customers WHERE id = ?').get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true, profile: row });
});

// Customer: edit their own name / email / phone (My Account → My Details).
//
// EMAIL IS THE LOGIN. Two consequences this route must respect:
//   1. it can never be blank or malformed, or the account becomes unreachable;
//   2. it can never collide with another customer's email, or two accounts
//      share one login and /customer/login resolves to whichever row comes
//      first. The uniqueness check is case-insensitive and skips the caller's
//      own row, and the DB's UNIQUE index is the backstop if two requests race.
// Scope is deliberately narrow: a customer may edit these three fields on their
// OWN record and nothing else — no id, no account_type, no active flag.
router.patch('/customer/profile', (req, res) => {
  if (req.auth.type !== 'customer') return res.status(403).json({ error: 'Customer access required' });
  const db = getDb();

  const current = db.prepare('SELECT id, email, full_name, phone, address_line1, address_line2, postcode FROM customers WHERE id = ? AND active = 1').get(req.auth.id);
  if (!current) return res.status(404).json({ error: 'Account not found' });

  const name = String(req.body.full_name == null ? current.full_name : req.body.full_name).trim();
  const email = String(req.body.email == null ? current.email : req.body.email).trim();
  const phoneRaw = req.body.phone == null ? current.phone : req.body.phone;
  const phone = String(phoneRaw == null ? '' : phoneRaw).trim();

  // ── THE EDITABLE SET IS THESE SIX FIELDS AND NOTHING ELSE ──
  // Read field by field from req.body rather than looping over its keys: a loop
  // is how a `bank_sort_code` or an `account_type` in the payload ends up in the
  // UPDATE. Anything not named here cannot be written by a customer, whatever
  // they post. In particular the bank_* columns and account_type stay owner-only.
  // GUARDRAIL: server/tests/customer-account.test.js.
  const addrPick = (key) => {
    const raw = req.body[key] == null ? current[key] : req.body[key];
    return String(raw == null ? '' : raw).trim();
  };
  const address_line1 = addrPick('address_line1');
  const address_line2 = addrPick('address_line2');
  const postcode = addrPick('postcode');

  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (name.length > 120) return res.status(400).json({ error: 'That name is too long.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (email.length > 200) return res.status(400).json({ error: 'That email address is too long.' });
  // Phone is optional, but if given it must look like a phone number.
  if (phone && !/^[+0-9][0-9\s()\-]{6,24}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number, or leave it blank.' });
  }
  // The address is optional — plenty of accounts predate it — but a stored value
  // must be a sane length, and a postcode must look like one.
  if (address_line1.length > 160 || address_line2.length > 160) {
    return res.status(400).json({ error: 'That address line is too long.' });
  }
  if (postcode && !/^[A-Za-z0-9][A-Za-z0-9\s-]{1,10}$/.test(postcode)) {
    return res.status(400).json({ error: 'Please enter a valid postcode, or leave it blank.' });
  }

  const clash = db.prepare('SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND id <> ?')
    .get(email, current.id);
  if (clash) {
    return res.status(409).json({ error: 'That email address is already used by another account.' });
  }

  try {
    db.prepare('UPDATE customers SET full_name = ?, email = ?, phone = ?, address_line1 = ?, address_line2 = ?, postcode = ? WHERE id = ?')
      .run(name, email, phone, address_line1, address_line2, postcode.toUpperCase(), current.id);
  } catch (e) {
    // UNIQUE(email) backstop for a race between two concurrent saves.
    if (/UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'That email address is already used by another account.' });
    }
    console.error('[API] customer profile update failed:', e.message);
    return res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }

  const emailChanged = String(current.email || '').trim().toLowerCase() !== email.toLowerCase();
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('customer', current.id, 'profile_updated_by_customer',
        emailChanged ? ('email ' + current.email + ' → ' + email) : 'name/phone', req.ip);
  } catch (e) {}

  const row = db.prepare('SELECT id, email, full_name, phone, address_line1, address_line2, postcode, created_at FROM customers WHERE id = ?').get(current.id);
  res.json({ ok: true, profile: row, emailChanged });
});

// Customer: download one of their own invoices as a PDF.
// Mirrors the owner route below, but scoped to the caller: the invoice must be
// theirs by customer_id OR by the email on their account (invoices raised
// before an account existed carry the email only — the same rule
// GET /customer/invoices already lists by).
router.get('/customer/invoices/:id/pdf', async (req, res) => {
  if (req.auth.type !== 'customer') return res.status(403).json({ error: 'Customer access required' });
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });

  const me = db.prepare('SELECT email FROM customers WHERE id = ?').get(req.auth.id) || {};
  const myEmail = String(me.email || '').trim().toLowerCase();

  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  const mine = row.customer_id === req.auth.id ||
    (myEmail && String(row.recipient_email || '').trim().toLowerCase() === myEmail);
  if (!mine) return res.status(403).json({ error: 'You can only download your own invoices' });

  const safeNo = String(row.invoice_no || '').replace(/[^A-Za-z0-9\-_]/g, '');
  /* Was: 404 "contact the office" whenever the file was not on disk, and the
     old design whenever it was. resolveInvoicePdf rebuilds from the stored
     invoice when the cache is missing or was drawn by an older template. */
  try {
    const { resolveInvoicePdf } = require('./invoice-pdf');
    const buf = await resolveInvoicePdf(db, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    return res.send(buf);
  } catch (e) {
    console.error('[INVOICE PDF] customer copy failed:', safeNo, e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'That invoice could not be produced. Please contact the office.' });
  }
});

// Delete booking (admin/owner only — permanently removes the record)
router.delete('/bookings/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.calendar_event_id) {
    gcal.deleteEvent(booking.calendar_event_id).catch(() => {});
  }

  // THE BUG THE OWNER HIT: "failed to delete the booking".
  //
  // change_requests.booking_id is `NOT NULL REFERENCES bookings(id)` with no
  // ON DELETE CASCADE, and db.js runs `PRAGMA foreign_keys = ON`. So deleting
  // a booking that a customer had asked to change threw FOREIGN KEY constraint
  // failed, this catch turned it into a 500, and the app showed "Failed to
  // delete booking. Please try again." — forever, because nothing about
  // retrying changes the constraint.
  //
  // It bit a TO-CONFIRM booking specifically because that is exactly where a
  // change request puts one: the request reopens the booking for re-pricing,
  // so the bookings most likely to carry one are the ones sitting in that tab.
  //
  // The dependents go first, in ONE transaction with the booking, so a failure
  // half way cannot leave change requests pointing at a booking that is gone.
  // linked_booking_id is cleared the same way — a return leg pointing at this
  // booking would block the delete for the same reason.
  try {
    // Each dependent is best-effort: db.js creates these with IF NOT EXISTS
    // inside a try, so on an old or half-migrated database one of them may not
    // be there — and a missing dependent must never be the reason a booking
    // cannot be deleted. The BOOKING delete is not guarded: if that fails the
    // whole transaction rolls back and the caller gets its 500, which is right.
    db.transaction(() => {
      try { db.prepare('UPDATE bookings SET linked_booking_id = NULL WHERE linked_booking_id = ?').run(id); } catch (_) {}
      try { db.prepare('DELETE FROM change_requests WHERE booking_id = ?').run(id); } catch (_) {}
      db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    })();
    autoFile.removeBooking(booking.ref, booking.date);
  } catch (e) {
    console.error('[API] booking delete failed:', e.message);
    return res.status(500).json({ error: 'Failed to delete booking. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_deleted', booking.ref, req.ip);
  } catch (e) { /* audit failure must not block the response */ }

  events.broadcast('booking:deleted', { id, ref: booking.ref });

  res.json({ ok: true });
});

// ── Cancel a trip (admin/owner) ──────────────────────────────────────────
// UNPAID  -> the booking is deleted entirely (owner doesn't keep unpaid cancels).
// PAID    -> marked cancelled and flagged "refund due £fare" so it stays in the
//            system with a Refund action. "Paid" = money actually received
//            (paid_at is stamped for Stripe card, cash-marked-paid, or a manual
//            mark-paid). The fare/email engines are untouched.
router.post('/bookings/:id/cancel', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Remove it from the calendar either way — the trip is not happening.
  if (booking.calendar_event_id) gcal.deleteEvent(booking.calendar_event_id).catch(() => {});

  const paid = !!booking.paid_at;

  if (!paid) {
    // ── Unpaid → delete entirely ──
    try {
      db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      try { autoFile.removeBooking(booking.ref, booking.date); } catch (_) {}
    } catch (e) {
      console.error('[API] cancel(delete) failed:', e.message);
      return res.status(500).json({ error: 'Failed to cancel booking. Please try again.' });
    }
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type, req.auth.id, 'booking_cancelled_deleted', booking.ref + ' (unpaid)', req.ip);
    } catch (_) {}
    events.broadcast('booking:deleted', { id, ref: booking.ref });
    // Let the customer know if we have their email (only on the live→cancelled edge).
    if (booking.status !== 'cancelled' && booking.passenger_email) {
      sendCustomerCancellation({
        ref: booking.ref, name: booking.passenger_name, email: booking.passenger_email,
        pickup: booking.pickup, destination: booking.destination,
        date: booking.date, time: booking.time, fare: booking.fare, flight: booking.flight
      }).catch(e => console.error('[API] sendCustomerCancellation failed:', e.message));
    }
    return res.json({ ok: true, outcome: 'deleted' });
  }

  // ── Paid → mark cancelled + refund due ──
  const wasCancelled = booking.status === 'cancelled';
  const refundAmount = booking.fare != null ? booking.fare : 0;
  try {
    db.prepare(`UPDATE bookings
                   SET status = 'cancelled',
                       refund_status = CASE WHEN refund_status = 'refunded' THEN refund_status ELSE 'due' END,
                       refund_amount = COALESCE(refund_amount, ?),
                       updated_at = datetime('now')
                 WHERE id = ?`).run(refundAmount, id);
  } catch (e) {
    console.error('[API] cancel(paid) failed:', e.message);
    return res.status(500).json({ error: 'Failed to cancel booking. Please try again.' });
  }
  if (!wasCancelled && booking.passenger_email) {
    sendCustomerCancellation({
      ref: booking.ref, name: booking.passenger_name, email: booking.passenger_email,
      pickup: booking.pickup, destination: booking.destination,
      date: booking.date, time: booking.time, fare: booking.fare, flight: booking.flight
    }).catch(e => console.error('[API] sendCustomerCancellation failed:', e.message));
  }
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_cancelled_refund_due', booking.ref + ' £' + Number(refundAmount).toFixed(2), req.ip);
  } catch (_) {}
  events.broadcast('booking:updated', { id, ref: booking.ref, status: 'cancelled', reason: 'Cancelled — refund due' });
  return res.json({ ok: true, outcome: 'cancelled_refund_due', refund_amount: refundAmount });
});

// ── Refund a cancelled/paid booking (admin/owner) ────────────────────────
// If a Stripe charge is on file (payment_intent_id, or found via booking_ref)
// this issues a REAL Stripe refund. Otherwise (cash / manually marked paid)
// it records the refund as manual — the owner must return £X by hand.
router.post('/bookings/:id/refund', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const stripe = require('./stripe');
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.refund_status === 'refunded') {
    return res.json({ ok: true, outcome: 'already_refunded', method: booking.refund_method || 'manual', amount: booking.refund_amount || booking.fare || 0 });
  }
  if (!booking.paid_at) {
    return res.status(400).json({ error: 'This booking was never paid — nothing to refund. Cancel it instead.' });
  }

  const amount = booking.refund_amount != null ? booking.refund_amount : (booking.fare || 0);
  const amountPence = Math.round(amount * 100);

  // Locate a Stripe charge to refund against.
  let intentId = booking.payment_intent_id || null;
  if (!intentId && booking.payment === 'card' && stripe.isConfigured()) {
    try { intentId = await stripe.findPaymentIntentByRef(booking.ref); } catch (_) {}
  }

  let method = 'manual', refundId = null;
  if (intentId && stripe.isConfigured()) {
    try {
      const refund = await stripe.createRefund({ paymentIntentId: intentId, amount: amountPence });
      method = 'stripe';
      refundId = refund.id;
    } catch (e) {
      console.error('[REFUND] Stripe refund failed for', booking.ref, ':', e.message);
      return res.status(502).json({ error: 'Stripe refund failed: ' + e.message });
    }
  }

  try {
    db.prepare(`UPDATE bookings
                   SET status = 'cancelled',
                       refund_status = 'refunded',
                       refund_method = ?,
                       refunded_at = datetime('now'),
                       refund_amount = COALESCE(refund_amount, ?),
                       updated_at = datetime('now')
                 WHERE id = ?`).run(method, amount, id);
  } catch (e) {
    console.error('[API] refund record failed:', e.message);
    return res.status(500).json({ error: 'Refund issued but recording failed — check the booking.' });
  }
  // A refund cancels the trip → remove it from the operator's Google Calendar
  // too (same as the other cancel paths). No-op if there's no synced event.
  if (booking.calendar_event_id) {
    gcal.deleteEvent(booking.calendar_event_id).then(ok => {
      if (ok) { try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(id); } catch (_) {} }
    }).catch(() => {});
  }
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_refunded',
           booking.ref + ' £' + Number(amount).toFixed(2) + ' [' + method + (refundId ? ' ' + refundId : '') + ']', req.ip);
  } catch (_) {}
  events.broadcast('booking:updated', { id, ref: booking.ref, status: 'cancelled', reason: 'Refunded' });
  return res.json({
    ok: true,
    outcome: method === 'stripe' ? 'refunded_stripe' : 'refunded_manual',
    method, amount, refund_id: refundId,
    message: method === 'stripe'
      ? ('Refunded £' + amount.toFixed(2) + ' to the customer via Stripe.')
      : ('Recorded as refunded — return £' + amount.toFixed(2) + ' to the customer (no card charge on file).')
  });
});

// ── Customers (admin only) ──────────────────────────────────────────────

router.get('/customers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  /* IS THIS "CUSTOMER" ACTUALLY STAFF?
     The owner has a customer account of his own — registered through the rider
     app under his own email — so his name sat in the invoice customer dropdown
     between real clients. A driver who books a ride for himself lands in
     exactly the same place.

     Decided by ROLE AND FLAG, never by name. A rule that reads "and not Nikodem
     Krajnyk" fails the day a customer shares a name with a driver, and fails
     silently the day the owner's name changes. Email is the only key the two
     tables share, matched case- and whitespace-insensitively because one was
     typed into a signup form and the other into a staff record.

     A FLAG, NOT A FILTER. The row is still returned, so the Customers tab, the
     directory and every screen reading this endpoint are unchanged and nothing
     is deleted. It is the invoice picker that acts on it.
     GUARDRAIL: server/tests/invoice-customer-picker.test.js */
  const rows = db.prepare(`
    SELECT c.id, c.email, c.full_name, c.phone, c.account_type, c.active, c.verified, c.created_at,
           c.address_line1, c.address_line2, c.postcode,
           c.bank_name, c.bank_sort_code, c.bank_account_no, c.bank_account_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM users u
              WHERE u.active = 1
                AND u.email IS NOT NULL AND TRIM(u.email) <> ''
                AND LOWER(TRIM(u.email)) = LOWER(TRIM(c.email))
                AND (u.role IN ('owner','admin','driver') OR u.is_default_driver = 1)
           ) THEN 1 ELSE 0 END AS is_staff
      FROM customers c
     WHERE c.active = 1
     ORDER BY c.created_at DESC
  `).all();
  res.json({ ok: true, customers: rows });
});

// Create customer (admin/owner only) — admin opens the account for a customer
// who wants monthly invoicing. The customer does NOT get a login password:
// the account is managed entirely by the admin and the customer just receives
// a welcome email confirming the account was opened on their behalf.
router.post('/customers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const {
    email, full_name, phone,
    address_line1, address_line2, postcode,
    bank_name, bank_sort_code, bank_account_no, bank_account_name
  } = req.body || {};
  if (!email || !full_name) {
    return res.status(400).json({ error: 'Email and full name are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  const cleanEmail = email.trim().toLowerCase();

  const db = getDb();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'Account already exists with this email' });

  const bcrypt = require('bcryptjs');
  const unusableHash = bcrypt.hashSync('!' + Math.random().toString(36) + Date.now(), 12);

  let result;
  try {
    result = db.prepare(`
      INSERT INTO customers (email, password, full_name, phone, account_type,
                             address_line1, address_line2, postcode,
                             bank_name, bank_sort_code, bank_account_no, bank_account_name)
      VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleanEmail, unusableHash, full_name.trim(), phone || null,
      (address_line1 || '').trim() || null,
      (address_line2 || '').trim() || null,
      (postcode || '').trim() || null,
      (bank_name || '').trim() || null,
      (bank_sort_code || '').trim() || null,
      (bank_account_no || '').trim() || null,
      (bank_account_name || '').trim() || null
    );
  } catch (e) {
    console.error('[API] customer insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to create customer account. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_created_by_admin', cleanEmail, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  // Auto-file (non-blocking)
  const newCust = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
  if (newCust) autoFile.fileCustomer(newCust);

  res.status(201).json({
    ok: true,
    customer: { id: result.lastInsertRowid, email: cleanEmail, full_name: full_name.trim() }
  });
});

// Get single customer with recent bookings (admin/owner)
router.get('/customers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });
  const customer = db.prepare(`
    SELECT id, email, full_name, phone, account_type, active, verified, created_at,
           address_line1, address_line2, postcode,
           bank_name, bank_sort_code, bank_account_no, bank_account_name
      FROM customers WHERE id = ?
  `).get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const bookings = db.prepare(`
    SELECT ref, date, time, pickup, destination, fare, status, payment
      FROM bookings WHERE customer_id = ? ORDER BY date DESC, time DESC LIMIT 20
  `).all(id);
  res.json({ ok: true, customer, bookings });
});

// Send welcome email to customer (admin/owner, on demand)
router.post('/customers/:id/welcome', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });
  const customer = db.prepare('SELECT id, email, full_name FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { sendCustomerWelcome } = require('./email');
  try {
    await sendCustomerWelcome({ email: customer.email, full_name: customer.full_name });
  } catch (e) {
    console.error('[API] sendCustomerWelcome failed:', e.message);
    return res.status(500).json({ error: 'Failed to send welcome email' });
  }
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'customer_welcome_sent', customer.email, req.ip);
  } catch (_) {}
  res.json({ ok: true });
});

// Delete customer — soft delete (sets active=0)
router.delete('/customers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });
  const customer = db.prepare('SELECT id, email FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  db.prepare("UPDATE customers SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'customer_deleted', customer.email, req.ip);
  } catch (_) {}
  res.json({ ok: true });
});

// Update customer (admin/owner)
router.patch('/customers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });

  const existing = db.prepare('SELECT id, email FROM customers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  const body = req.body || {};
  const updates = [];
  const values = [];

  const plainFields = [
    'full_name', 'phone',
    'address_line1', 'address_line2', 'postcode',
    'bank_name', 'bank_sort_code', 'bank_account_no', 'bank_account_name'
  ];
  for (const f of plainFields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] === '' ? null : String(body[f]).trim() || null);
    }
  }

  if (body.email !== undefined) {
    const newEmail = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (newEmail !== existing.email) {
      const dup = db.prepare('SELECT id FROM customers WHERE email = ? AND id != ?').get(newEmail, id);
      if (dup) return res.status(409).json({ error: 'Email already in use by another customer' });
    }
    updates.push('email = ?');
    values.push(newEmail);
  }

  if (body.active !== undefined) {
    updates.push('active = ?');
    values.push(body.active ? 1 : 0);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(id);

  try {
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] customer update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update customer. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_updated', existing.email, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  res.json({ ok: true });
});

// ── Set / reset a customer's portal password (admin-only) ───────────────
// Allows admin to grant a customer access to the account portal by setting
// a password. Customer then logs in via POST /api/auth/customer/login.
router.post('/customers/reactivate-by-email', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const db = getDb();
  const customer = db.prepare('SELECT id, email, full_name, active, verified FROM customers WHERE email = ? COLLATE NOCASE').get(email.trim().toLowerCase());
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  db.prepare("UPDATE customers SET active = 1, verified = 1, updated_at = datetime('now') WHERE id = ?").run(customer.id);
  res.json({ ok: true, customer: { id: customer.id, email: customer.email, full_name: customer.full_name, was_active: customer.active, was_verified: customer.verified } });
});

router.post('/customers/:id/set-password', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });

  const customer = db.prepare('SELECT id, email, full_name FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(String(password), 12);
  db.prepare("UPDATE customers SET password = ?, updated_at = datetime('now') WHERE id = ?").run(hash, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'customer_password_set', customer.email, req.ip);
  } catch (_) {}

  res.json({ ok: true, message: 'Password set. Customer can now log in via /api/auth/customer/login.' });
});

// Generate / send invoice for a customer.
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } or { month: 'YYYY-MM' }
// Optional: send_email (default true). When false, returns data only (for preview).
router.post('/customers/:id/invoice', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { month, from, to, send_email } = req.body || {};
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let dateFrom, dateTo, periodLabel, invoicePrefix;

  if (from && to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
    }
    dateFrom = from;
    dateTo = to;
    const fd = new Date(from + 'T00:00:00');
    const td = new Date(to + 'T00:00:00');
    if (fd.getMonth() === td.getMonth() && fd.getFullYear() === td.getFullYear()) {
      periodLabel = MONTH_NAMES[fd.getMonth()] + ' ' + fd.getFullYear();
    } else {
      periodLabel = fd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        + ' - ' + td.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    invoicePrefix = from.slice(0, 4) + from.slice(5, 7);
  } else if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(n => parseInt(n, 10));
    dateFrom = month + '-01';
    const nextMonthFirst = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    dateTo = nextMonthFirst.toISOString().slice(0, 10);
    periodLabel = MONTH_NAMES[m - 1] + ' ' + y;
    invoicePrefix = y + String(m).padStart(2, '0');
  } else {
    return res.status(400).json({ error: 'Provide either month (YYYY-MM) or from/to dates (YYYY-MM-DD)' });
  }

  const db = getDb();
  const customer = db.prepare('SELECT id, email, full_name, phone FROM customers WHERE id = ? AND active = 1').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const bookings = db.prepare(`
    SELECT ref, date, time, pickup, destination, fare, flight, passengers, status
      FROM bookings
     WHERE customer_id = ?
       AND date >= ?
       AND date < ?
       AND status IN ('confirmed','active','completed')
     ORDER BY date ASC, time ASC
  `).all(customer.id, dateFrom, dateTo);

  const invoiceNo = nextInvoiceNo(db, invoicePrefix);

  const issuedDate = ukNow().dateStr;
  const _due = new Date(issuedDate + 'T00:00:00');
  _due.setDate(_due.getDate() + 14);
  const dueDate = _due.toISOString().slice(0, 10);

  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}

  const total = bookings.reduce((s, b) => s + (+b.fare || 0), 0);
  const shouldEmail = send_email !== false;

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let pdfBuffer = null;
  try {
    const { buildInvoicePdf } = require('./invoice-pdf');
    const lineItemsForPdf = bookings.map(b => ({
      date: b.date, time: b.time, ref: b.ref,
      pickup: b.pickup, destination: b.destination,
      flight: b.flight, fare: b.fare
    }));
    pdfBuffer = await buildInvoicePdf({
      invoiceNo, kind: 'account', total, settings,
      customer: { full_name: customer.full_name, email: customer.email, phone: customer.phone },
      bookings: lineItemsForPdf,
      period: { issuedDate, dueDate, label: periodLabel }
    });
    // Written under the TEMPLATE-VERSIONED name the readers look for; an
    // unversioned file here would simply never be found again.
    const { invoiceCacheDir, invoiceCachePath } = require('./invoice-pdf');
    fs.mkdirSync(invoiceCacheDir(), { recursive: true });
    fs.writeFileSync(invoiceCachePath(invoiceNo), pdfBuffer);
    console.log('[INVOICE] PDF saved:', invoiceNo + '.pdf');
  } catch (e) {
    console.error('[INVOICE] PDF generation failed:', e.message);
  }

  if (shouldEmail) {
    if (!customer.email) return res.status(400).json({ error: 'Customer has no email address' });
    const { sendCustomerInvoice } = require('./email');
    const ok = await sendCustomerInvoice(customer, bookings, { label: periodLabel, dueDate }, invoiceNo, settings, pdfBuffer);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + customer.email, req.ip);
  }

  // Persist the invoice record so it can be looked up later.
  try {
    const lineItems = bookings.map(b => ({
      date: b.date, time: b.time, ref: b.ref,
      pickup: b.pickup, destination: b.destination,
      flight: b.flight, passengers: b.passengers, fare: b.fare
    }));
    db.prepare(`
      INSERT INTO invoices
        (invoice_no, kind, customer_id, recipient_name, recipient_email, recipient_phone,
         period_from, period_to, period_label, issued_date, due_date,
         line_items_json, booking_ids_json, total, emailed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNo, 'account', customer.id, customer.full_name, customer.email, customer.phone,
      dateFrom, dateTo, periodLabel, issuedDate, dueDate,
      JSON.stringify(lineItems), JSON.stringify(bookings.map(b => b.ref)),
      total, shouldEmail ? 1 : 0, req.auth.id
    );
  } catch (e) {
    console.error('[INVOICE] persist failed:', e.message);
  }

  // Auto-file (non-blocking)
  const invRow = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(invoiceNo);
  if (invRow) autoFile.fileInvoice(invoiceNo, invRow, pdfBuffer);

  res.json({
    // The row id, so the staff app opens this through the AUTHENTICATED pdf
    // route rather than the public tokenised one.
    ok: true, invoiceNo, invoiceId: invRow ? invRow.id : null, journeys: bookings.length, total,
    customer: { id: customer.id, email: customer.email, full_name: customer.full_name, phone: customer.phone },
    bookings, period: { label: periodLabel, from: dateFrom, to: dateTo, dueDate, issuedDate },
    settings, emailed: shouldEmail
  });
});

// Bespoke / one-off invoice — for recipients not in the customers table.
// Body: { recipient: { name, email, address, phone }, items: [{ description, amount }], due_days, send_email }
router.post('/invoices/bespoke', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { recipient, items, due_days, send_email, notes, journey } = req.body || {};
  if (!recipient || !recipient.name || !String(recipient.name).trim()) {
    return res.status(400).json({ error: 'Recipient name is required' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }

  const cleanItems = items
    .map(it => ({ description: String(it.description || '').trim(), date: it.date ? String(it.date).trim() : '', amount: +it.amount || 0 }))
    .filter(it => it.description && it.amount > 0);
  if (!cleanItems.length) {
    return res.status(400).json({ error: 'Items must have description and positive amount' });
  }

  /* THE JOURNEY BEHIND THE INVOICE, when there is one.
     "Create Invoice" on a job card knows the route, the date and the reference;
     it used to flatten all three into one description string, which is fine on
     a line of a PDF and useless to an email that wants to show the trip the way
     a confirmation does. Optional, and whitelisted field by field — this is a
     body from a page, and it ends up rendered in an email.
     Dates stay WALL-CLOCK strings; nothing here parses one. */
  const cleanJourney = (journey && typeof journey === 'object') ? {
    ref:         String(journey.ref || '').trim().slice(0, 40),
    date:        /^\d{4}-\d{2}-\d{2}$/.test(String(journey.date || '')) ? String(journey.date) : '',
    time:        String(journey.time || '').trim().slice(0, 10),
    pickup:      String(journey.pickup || '').trim().slice(0, 200),
    destination: String(journey.destination || '').trim().slice(0, 200),
    flight:      String(journey.flight || '').trim().slice(0, 20)
  } : null;
  // A journey with no route is not a journey; fall back to the line items.
  const journeyForEmail = (cleanJourney && cleanJourney.pickup && cleanJourney.destination) ? cleanJourney : null;

  const db = getDb();
  const _ukn = ukNow();
  const invoicePrefix = String(_ukn.year) + String(_ukn.month).padStart(2, '0');
  const invoiceNo = nextInvoiceNo(db, invoicePrefix);

  const issuedDate = _ukn.dateStr;
  const _due = new Date(issuedDate + 'T00:00:00');
  _due.setDate(_due.getDate() + (parseInt(due_days, 10) || 14));
  const dueDate = _due.toISOString().slice(0, 10);

  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}

  const total = cleanItems.reduce((s, it) => s + it.amount, 0);
  const shouldEmail = send_email === true;

  const cleanRecipient = {
    name: String(recipient.name).trim(),
    email: recipient.email ? String(recipient.email).trim().toLowerCase() : '',
    phone: recipient.phone ? String(recipient.phone).trim() : '',
    address: recipient.address ? String(recipient.address).trim() : ''
  };

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let pdfBuffer = null;
  try {
    const { buildInvoicePdf } = require('./invoice-pdf');
    pdfBuffer = await buildInvoicePdf({
      invoiceNo, kind: 'bespoke', total, notes: notes || '', settings,
      recipient: cleanRecipient,
      items: cleanItems,
      period: { issuedDate, dueDate, label: '' }
    });
    // Written under the TEMPLATE-VERSIONED name the readers look for; an
    // unversioned file here would simply never be found again.
    const { invoiceCacheDir, invoiceCachePath } = require('./invoice-pdf');
    fs.mkdirSync(invoiceCacheDir(), { recursive: true });
    fs.writeFileSync(invoiceCachePath(invoiceNo), pdfBuffer);
    console.log('[INVOICE] PDF saved:', invoiceNo + '.pdf');
  } catch (e) {
    console.error('[INVOICE] PDF generation failed:', e.message);
  }

  if (shouldEmail) {
    if (!cleanRecipient.email) return res.status(400).json({ error: 'Recipient email required to send' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanRecipient.email)) {
      return res.status(400).json({ error: 'Invalid recipient email' });
    }
    const { sendBespokeInvoice } = require('./email');
    const ok = await sendBespokeInvoice(cleanRecipient, cleanItems, { dueDate, issuedDate, notes, journey: journeyForEmail }, invoiceNo, settings, pdfBuffer);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + cleanRecipient.email, req.ip);
  }

  // Persist bespoke invoice so it can be reviewed later.
  try {
    db.prepare(`
      INSERT INTO invoices
        (invoice_no, kind, recipient_name, recipient_email, recipient_phone, recipient_addr,
         issued_date, due_date, notes, line_items_json, journey_json, total, emailed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNo, 'bespoke', cleanRecipient.name, cleanRecipient.email, cleanRecipient.phone, cleanRecipient.address,
      issuedDate, dueDate, notes || null,
      JSON.stringify(cleanItems),
      // Kept, so a send NEXT WEEK shows the same trip block as a send today.
      journeyForEmail ? JSON.stringify(journeyForEmail) : null,
      total, shouldEmail ? 1 : 0, req.auth.id
    );
  } catch (e) {
    console.error('[INVOICE] persist bespoke failed:', e.message);
  }

  // Upsert recipient into saved recipients for future auto-fill
  try {
    if (cleanRecipient.name) {
      if (cleanRecipient.email) {
        db.prepare(`
          INSERT INTO invoice_recipients (name, email, address, phone, last_used_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(email) DO UPDATE SET
            name         = excluded.name,
            address      = COALESCE(excluded.address, invoice_recipients.address),
            phone        = COALESCE(excluded.phone, invoice_recipients.phone),
            last_used_at = datetime('now')
        `).run(cleanRecipient.name, cleanRecipient.email, cleanRecipient.address || null, cleanRecipient.phone || null);
      } else {
        db.prepare(`INSERT INTO invoice_recipients (name, address, phone, last_used_at) VALUES (?, ?, ?, datetime('now'))`)
          .run(cleanRecipient.name, cleanRecipient.address || null, cleanRecipient.phone || null);
      }
    }
  } catch (e) {
    console.error('[API] invoice_recipients upsert failed:', e.message);
  }

  // Auto-file (non-blocking)
  const bespInvRow = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(invoiceNo);
  if (bespInvRow) autoFile.fileInvoice(invoiceNo, bespInvRow, pdfBuffer);

  res.json({
    ok: true, invoiceNo, invoiceId: bespInvRow ? bespInvRow.id : null, total, bespoke: true,
    recipient: cleanRecipient, items: cleanItems,
    period: { label: '', dueDate, issuedDate, notes: notes || '' },
    settings, emailed: shouldEmail
  });
});

// Saved invoice recipients for auto-fill
router.get('/invoice-recipients', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  // Return all saved recipients — invoice recipients are independent of
  // customer accounts and should always be available for autocomplete.
  const rows = db.prepare(`
    SELECT * FROM invoice_recipients
    ORDER BY last_used_at DESC LIMIT 100
  `).all();
  res.json({ ok: true, recipients: rows });
});

// Delete a saved invoice recipient by id (admin/owner only).
router.delete('/invoice-recipients/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid recipient ID' });
  const row = db.prepare('SELECT id FROM invoice_recipients WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Recipient not found' });
  db.prepare('DELETE FROM invoice_recipients WHERE id = ?').run(id);
  res.json({ ok: true });
});

// List stored invoices (admin/owner). Supports optional ?customer_id, ?kind filters.
router.get('/invoices', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const where = [];
  const params = [];
  if (req.query.customer_id) { where.push('customer_id = ?'); params.push(parseInt(req.query.customer_id, 10)); }
  if (req.query.kind && ['account','bespoke'].includes(req.query.kind)) {
    where.push('kind = ?'); params.push(req.query.kind);
  }
  const sql = `SELECT id, invoice_no, kind, customer_id, recipient_name, recipient_email,
                      issued_date, due_date, period_label, total, emailed, paid, paid_at, created_at
                 FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 500`;
  const rawRows = db.prepare(sql).all(...params);

  // Deduplicate by invoice_no. The stored invoices table is authoritative.
  // The same invoice_no can appear more than once when an older DB was created
  // before the UNIQUE constraint on invoice_no existed, or when a double-submit
  // races two inserts with the same generated number. Keep only the first
  // (most-recent, since rows are ordered created_at DESC) stored row per number.
  const seen = new Set();
  const invoices = [];
  const keyOf = (no) => String(no || '').trim().toUpperCase();
  for (const r of rawRows) {
    const key = keyOf(r.invoice_no);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    invoices.push(r);
  }

  // Merge in legacy invoices that predate the invoices table. Before the table
  // existed, sent invoices were only recorded in audit_log as 'invoice_sent'
  // actions with detail "INV-XXXX to email@example.com". Without this, every
  // invoice issued before the table was added is invisible in the history.
  // A legacy entry is only shown when there is NO stored row for that number,
  // so an invoice present in both the table and the audit_log shows once.
  // Skip when a customer_id/kind filter is set — legacy rows carry neither.
  if (!where.length) {
    try {
      const legacy = db.prepare(
        "SELECT detail, created_at FROM audit_log WHERE action = 'invoice_sent' ORDER BY created_at DESC"
      ).all();
      for (const l of legacy) {
        const m = (l.detail || '').match(/^(INV-[A-Za-z0-9-]+)(?:\s+to\s+(\S+))?/);
        if (!m) continue;
        const key = keyOf(m[1]);
        if (seen.has(key)) continue;
        seen.add(key);
        invoices.push({
          id: null,
          invoice_no: m[1],
          kind: 'account',
          customer_id: null,
          recipient_name: '',
          recipient_email: m[2] || '',
          issued_date: (l.created_at || '').slice(0, 10),
          due_date: null,
          period_label: null,
          total: null,
          emailed: 1,
          paid: 0,
          paid_at: null,
          created_at: l.created_at,
          legacy: true
        });
      }
    } catch (e) {
      console.error('[INVOICES] legacy audit_log merge failed:', e.message);
    }
  }

  invoices.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  res.json({ ok: true, invoices });
});

// Fetch a single stored invoice with full line items.
router.get('/invoices/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  try { row.line_items = JSON.parse(row.line_items_json || '[]'); } catch (e) { row.line_items = []; }
  try { row.booking_refs = JSON.parse(row.booking_ids_json || '[]'); } catch (e) { row.booking_refs = []; }
  delete row.line_items_json;
  delete row.booking_ids_json;
  res.json({ ok: true, invoice: row });
});

// Serve (or regenerate) the PDF for a stored invoice.
router.get('/invoices/:id/pdf', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });

  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  const safeNo = (row.invoice_no || '').replace(/[^A-Za-z0-9\-_]/g, '');
  /* One resolver, shared with the public download and the customer's own copy.
     This route used to rebuild the data shape by hand and cache to an unversioned
     filename, which is how "Download" kept serving the pre-redesign document. */
  try {
    const { resolveInvoicePdf } = require('./invoice-pdf');
    const buf = await resolveInvoicePdf(db, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (req.query.inline === '1' ? 'inline' : 'attachment') + '; filename="' + safeNo + '.pdf"');
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    return res.send(buf);
  } catch (e) {
    console.error('[INVOICE PDF] staff download failed:', safeNo, e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'That invoice could not be produced. Please try again, or contact support.' });
  }
});

/* CORRECT A SAVED INVOICE — same number, same row.
   An invoice was immutable: there was no update route, so a wrong figure meant
   deleting it and issuing a fresh number. An accounts department that has
   already filed INV-202608-0003 should receive a corrected 0003, not a 0004
   that silently replaces it, and the owner should not have to explain a gap in
   his own numbering.

   WHAT MAY BE CORRECTED: who it is addressed to, the line items, the dates,
   the notes, and the total. NOT the invoice number, the kind, or who it
   belongs to — those are the identity of the document. A correction that could
   re-point an invoice at a different customer is a way to bill the wrong
   person from an edit screen.

   THE TOTAL. It is a stored column, and always was. Left alone it is the sum
   of the lines and is recomputed on every save. Set by hand it is kept exactly
   as given and total_manual is raised, so the next edit does not quietly put
   the auto-sum back — which is the whole point of an override.
   GUARDRAIL: server/tests/invoice-edit.test.js */
router.patch('/invoices/:id', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  const b = req.body || {};
  const str = (v, fallback) => (v === undefined || v === null) ? fallback : String(v).trim();

  // ── The line items ──
  let lineItems = null;
  if (Array.isArray(b.line_items)) {
    if (b.line_items.length > 200) return res.status(400).json({ error: 'Too many lines on one invoice' });
    lineItems = b.line_items.map((it) => {
      const amount = Number(it && it.amount);
      if (row.kind === 'bespoke') {
        return { date: str(it && it.date, '') || undefined,
                 description: str(it && it.description, '').slice(0, 500),
                 amount: isNaN(amount) ? 0 : Math.round(amount * 100) / 100 };
      }
      /* An account line is a journey. The shape is preserved exactly, because
         the PDF reads pickup/destination/ref/time out of it — flattening it to
         a description here would empty the journey column. */
      return Object.assign({}, it, {
        fare: isNaN(amount) ? (Number(it && it.fare) || 0) : Math.round(amount * 100) / 100
      });
    });
    if (row.kind === 'bespoke' && lineItems.some((it) => !it.description)) {
      return res.status(400).json({ error: 'Every line needs a description' });
    }
  }

  const items = lineItems || (() => { try { return JSON.parse(row.line_items_json || '[]'); } catch (_) { return []; } })();
  const lineSum = Math.round(items.reduce((s, it) =>
    s + (Number(row.kind === 'bespoke' ? it.amount : it.fare) || 0), 0) * 100) / 100;

  /* THE FEES. Parking, tolls, waiting time — set here or cleared here.
       fees: a number  → that is the figure;
       fees: 0 or null → there are none, and the row does not render;
       fees: absent    → leave whatever is on the invoice alone.
     They are PART of the bill, so the auto-sum includes them. An override
     still wins over the lot — that is what an override is. */
  let fees = +row.fees || 0;
  let feesLabel = row.fees_label || null;
  if (Object.prototype.hasOwnProperty.call(b, 'fees')) {
    if (b.fees === null || b.fees === '') { fees = 0; }
    else {
      const f = Number(b.fees);
      if (isNaN(f) || f < 0) return res.status(400).json({ error: 'Those fees are not a number: ' + b.fees });
      if (f > 1000000) return res.status(400).json({ error: 'Those fees look wrong' });
      fees = Math.round(f * 100) / 100;
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'fees_label')) {
    feesLabel = String(b.fees_label || '').trim().slice(0, 60) || null;
  }
  if (fees <= 0) { fees = 0; feesLabel = null; }   // no fees, no label to explain them

  const autoSum = Math.round((lineSum + fees) * 100) / 100;

  /* THE OVERRIDE. Three states, and they have to stay distinguishable:
       total_override: a number  → set it, and remember that it was set;
       total_override: null      → clear it, go back to the auto-sum;
       total_override: absent    → leave the arrangement as it is. */
  let total = row.total, manual = row.total_manual ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(b, 'total_override')) {
    if (b.total_override === null || b.total_override === '') {
      manual = 0; total = autoSum;
    } else {
      const t = Number(b.total_override);
      if (isNaN(t) || t < 0) return res.status(400).json({ error: 'That total is not a number: ' + b.total_override });
      if (t > 1000000) return res.status(400).json({ error: 'That total looks wrong' });
      manual = 1; total = Math.round(t * 100) / 100;
    }
  } else if (!manual) {
    total = autoSum;              // no override in force — the lines decide
  }

  const email = str(b.recipient_email, row.recipient_email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'That email address does not look right: ' + email });
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const issued = str(b.issued_date, row.issued_date);
  const due = str(b.due_date, row.due_date);
  if (issued && !DATE_RE.test(issued)) return res.status(400).json({ error: 'Issued date must be YYYY-MM-DD' });
  if (due && !DATE_RE.test(due)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' });

  const before = { total: row.total, manual: row.total_manual, lines: (items || []).length };
  db.prepare(`
    UPDATE invoices
       SET recipient_name  = ?, recipient_email = ?, recipient_phone = ?, recipient_addr = ?,
           issued_date = ?, due_date = ?, period_label = ?, notes = ?,
           line_items_json = ?, total = ?, total_manual = ?,
           fees = ?, fees_label = ?,
           revised_at = datetime('now')
     WHERE id = ?
  `).run(
    str(b.recipient_name, row.recipient_name) || row.recipient_name,
    email || null,
    str(b.recipient_phone, row.recipient_phone) || null,
    str(b.recipient_addr, row.recipient_addr) || null,
    issued || row.issued_date, due || null,
    str(b.period_label, row.period_label) || null,
    str(b.notes, row.notes) || null,
    JSON.stringify(items), total, manual, fees, feesLabel, id);

  /* The cached PDF is keyed on a hash of these fields, so the corrected
     document gets a new filename and the old one is simply never asked for
     again. Nothing to invalidate, and nothing to forget to invalidate. */
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_edited',
           row.invoice_no + ' £' + Number(before.total || 0).toFixed(2) + ' → £' + total.toFixed(2) +
           (manual ? ' (total set by hand)' : '') + ', ' + items.length + ' line(s)' +
           (fees > 0 ? ', fees £' + fees.toFixed(2) : ''), req.ip);
  } catch (e) { console.error('[INVOICE] edit audit failed:', e.message); }

  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  try { updated.line_items = JSON.parse(updated.line_items_json || '[]'); } catch (_) { updated.line_items = []; }
  delete updated.line_items_json;
  console.log('[INVOICE] ' + row.invoice_no + ' corrected (total £' + total.toFixed(2) +
              (manual ? ', set by hand' : ', from the lines') + ')');
  res.json({ ok: true, invoice: updated, autoSum, lineSum, fees });
});

// Delete invoice — removes DB row and cached PDF.
// The :id param is either a numeric invoices.id (stored invoices) or an
// invoice number like "INV-202604-0001" (legacy invoices that only exist as
// 'invoice_sent' rows in audit_log). Both kinds can be deleted from the admin
// history.
router.delete('/invoices/:id', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const raw = String(req.params.id || '').trim();

  // ── Numeric id → stored invoice in the invoices table ──
  if (/^\d+$/.test(raw)) {
    const id = parseInt(raw, 10);
    const row = db.prepare('SELECT id, invoice_no FROM invoices WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Invoice not found' });

    // Delete cached PDF if it exists
    try {
      // EVERY rendering of it, not just the current template's.
      for (const f of require('./invoice-pdf').invoiceCachePaths(row.invoice_no)) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch (e) { /* non-fatal */ }

    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    autoFile.removeInvoice(row.invoice_no);
    return res.json({ ok: true });
  }

  // ── Otherwise treat as an invoice number ──
  const invoiceNo = raw.replace(/[^A-Za-z0-9\-_]/g, '');
  if (!invoiceNo) return res.status(400).json({ error: 'Invalid invoice reference' });

  // It may still exist in the invoices table (e.g. deleted by number) — remove it.
  const stored = db.prepare('SELECT id FROM invoices WHERE invoice_no = ?').get(invoiceNo);
  if (stored) db.prepare('DELETE FROM invoices WHERE id = ?').run(stored.id);

  // Remove the legacy audit_log record(s) so the archived row disappears.
  // Match the exact number or "INV-… to email" form — not a bare prefix, so
  // INV-…-0001 can't also delete INV-…-00010.
  const result = db.prepare(
    "DELETE FROM audit_log WHERE action = 'invoice_sent' AND (detail = ? OR detail LIKE ?)"
  ).run(invoiceNo, invoiceNo + ' %');

  if (!stored && result.changes === 0) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // Clean up any cached PDF / filed copy keyed by the number.
  try {
    for (const f of require('./invoice-pdf').invoiceCachePaths(invoiceNo)) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  } catch (e) { /* non-fatal */ }
  autoFile.removeInvoice(invoiceNo);

  res.json({ ok: true });
});

// Mark a stored invoice as paid (records the payment date).
/* SEND AN INVOICE THAT ALREADY EXISTS.
   Until now an invoice could only be emailed at the MOMENT it was created, by
   passing send_email on the create route. There was no way to send one
   afterwards — which meant the owner app, wanting to send an invoice it had
   just made, DELETED the invoice and created it again with the flag set. That
   is in westmere-owner.html today, comment and all. It destroys the row, its id
   and its created_at to change one boolean, and if the second call fails the
   invoice is simply gone.

   This route sends the invoice in front of it: same branded email, same
   attached PDF, same recipient. Nothing is recreated and nothing is deleted.

   The PDF comes from resolveInvoicePdf, so the customer is sent the same
   document the Download and Print buttons produce — not a second rendering that
   could differ from it.

   GUARDRAIL: server/tests/invoice-send.test.js */
router.post('/invoices/:id/send', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });

  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  /* The bill-to address, and nowhere else. An invoice is sent to the party it
     is addressed to; a "send it to this address instead" field on this route
     would be a way to mail somebody else's invoice out of the owner app. */
  const to = String(row.recipient_email || '').trim();
  if (!to) return res.status(400).json({ error: 'No email address on file for this invoice' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'The email address on this invoice is not valid: ' + to });
  }

  let settings = {};
  try {
    const sr = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (sr) settings = JSON.parse(sr.value);
  } catch (_) {}

  let lineItems = [];
  try { lineItems = JSON.parse(row.line_items_json || '[]'); } catch (_) {}

  let pdfBuffer = null;
  try {
    pdfBuffer = await require('./invoice-pdf').resolveInvoicePdf(db, row);
  } catch (e) {
    // The email copes with a missing attachment — it stops claiming there is
    // one — but the owner should be told rather than left to find out.
    console.error('[INVOICE] send: PDF generation failed for', row.invoice_no, e.message);
    return res.status(500).json({ error: 'The invoice PDF could not be generated, so nothing was sent.' });
  }

  /* The stored journey, so a send a week later shows the same structured trip
     block — reference, route, date and time — that a send at creation did. */
  let storedJourney = null;
  try { storedJourney = row.journey_json ? JSON.parse(row.journey_json) : null; } catch (_) {}

  const period = {
    label: row.period_label || '',
    dueDate: row.due_date || '',
    issuedDate: row.issued_date || '',
    notes: row.notes || '',
    journey: storedJourney,
    /* The stored figure, so the email quotes the same number as the PDF it is
       carrying. Recomputing from the lines here would have made a manually
       corrected invoice contradict its own attachment. */
    total: row.total
  };

  let ok = false;
  try {
    const email = require('./email');
    if (row.kind === 'bespoke') {
      ok = await email.sendBespokeInvoice(
        { name: row.recipient_name, email: to, phone: row.recipient_phone || '', address: row.recipient_addr || '' },
        lineItems, period, row.invoice_no, settings, pdfBuffer);
    } else {
      ok = await email.sendCustomerInvoice(
        { full_name: row.recipient_name, email: to, phone: row.recipient_phone || '' },
        lineItems, period, row.invoice_no, settings, pdfBuffer);
    }
  } catch (e) {
    console.error('[INVOICE] send failed:', row.invoice_no, e.message);
    return res.status(500).json({ error: 'Sending failed: ' + e.message });
  }
  if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

  db.prepare('UPDATE invoices SET emailed = 1 WHERE id = ?').run(id);
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', row.invoice_no + ' to ' + to, req.ip);
  } catch (_) { /* the send happened; the log is not worth failing it for */ }

  res.json({ ok: true, invoiceNo: row.invoice_no, to, attached: !!(pdfBuffer && pdfBuffer.length) });
});

router.patch('/invoices/:id/mark-paid', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT id FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  db.prepare("UPDATE invoices SET paid = 1, paid_at = datetime('now') WHERE id = ?").run(id);
  const updated = db.prepare('SELECT paid, paid_at FROM invoices WHERE id = ?').get(id);
  res.json({ ok: true, paid: updated.paid, paid_at: updated.paid_at });
});

// Mark a stored invoice as not paid (clears the payment date).
router.patch('/invoices/:id/mark-unpaid', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT id FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  db.prepare("UPDATE invoices SET paid = 0, paid_at = NULL WHERE id = ?").run(id);
  res.json({ ok: true, paid: 0, paid_at: null });
});

// Send a payment reminder email for an outstanding (unpaid) invoice.
// ── Payment reminder for unpaid bookings ─────────────────────────────────
// ── Resend confirmation email ────────────────────────────────────────────
router.post('/bookings/:id/send-confirmation', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const id = parseInt(req.params.id, 10);
    const intake = require('./intake');
    await intake.notifyCustomerConfirmed(id);
    // Record that a confirmation went out so the operator can always see
    // whether/when one was sent. Best-effort: the email already sent, so a
    // logging failure must never fail the request.
    let sentAt = null;
    try {
      const db = getDb();
      db.prepare("UPDATE bookings SET confirmation_sent_at = datetime('now') WHERE id = ?").run(id);
      const row = db.prepare("SELECT confirmation_sent_at FROM bookings WHERE id = ?").get(id);
      sentAt = (row && row.confirmation_sent_at) || null;
    } catch (e2) {
      console.error('[API] confirmation_sent_at record failed:', e2.message);
    }
    res.json({ ok: true, confirmation_sent_at: sentAt });
  } catch (e) {
    console.error('[API] send-confirmation failed:', e.message);
    res.status(500).json({ error: 'Failed to send confirmation' });
  }
});

// ── Send estimate email ──────────────────────────────────────────────────
// ESTIMATE-FIRST: this sets the fare (if supplied) and emails the customer an
// estimate carrying secure Pay Now / Pay-driver / Cancel actions — but it does
// NOT change status. The booking stays PENDING until the customer pays (card →
// webhook confirms), chooses cash-on-the-day (/cash confirms), or cancels. See
// CLAUDE.md "Estimate-first" invariant: pressing Send Estimate must never
// auto-confirm.
router.post('/bookings/:id/send-estimate', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  // Optionally set the fare in the same action (the owner types it when sending).
  if (req.body && req.body.fare !== undefined && req.body.fare !== null && req.body.fare !== '') {
    const fareNum = Number(req.body.fare);
    if (!isFinite(fareNum) || fareNum <= 0) return res.status(400).json({ error: 'Enter a valid fare amount' });
    db.prepare("UPDATE bookings SET fare = ?, updated_at = datetime('now') WHERE id = ?").run(fareNum, id);
  }

  const b = db.prepare(`
    SELECT b.*, COALESCE(c.email, b.passenger_email) as contact_email,
           COALESCE(c.full_name, b.passenger_name) as contact_name
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.contact_email) return res.status(400).json({ error: 'No email address on this booking' });
  if (!b.fare || Number(b.fare) <= 0) return res.status(400).json({ error: 'Set a fare before sending an estimate' });

  // Mint the per-booking token so the estimate's Pay/Cash/Cancel links work.
  // Does NOT touch status — the booking remains pending.
  const payToken = require('./intake').ensurePayToken(id) || b.pay_token || null;

  try {
    const { sendCustomerEstimate } = require('./email');
    // sendCustomerEstimate returns the Resend message id (truthy) on a genuine
    // ACCEPTED send, or false if Resend rejected it. We only report success when
    // it is truthy — never a false "approved".
    const sendResult = await sendCustomerEstimate({
      ref: b.ref, name: b.contact_name, email: b.contact_email,
      pickup: b.pickup, destination: b.destination, stop_address: b.stop_address,
      date: b.date, time: b.time, flight: b.flight, passengers: b.passengers,
      fare: b.fare, notes: b.notes, pay_token: payToken
    });
    if (!sendResult) {
      // Surface a REAL failure naming the address, so the owner never sees a
      // false "sent" (the Mr Ben incident: reported sent, never delivered).
      console.error('[API] send-estimate: Resend rejected the send to', b.contact_email, 'for', b.ref);
      return res.status(502).json({
        error: 'The estimate could NOT be emailed to ' + b.contact_email + ' — please check the address and try again.',
        sent_to: b.contact_email
      });
    }
    const resendId = (sendResult === true) ? null : sendResult;
    let sentAt = null;
    try {
      db.prepare("UPDATE bookings SET estimate_sent_at = datetime('now') WHERE id = ?").run(id);
      const row = db.prepare('SELECT estimate_sent_at FROM bookings WHERE id = ?').get(id);
      sentAt = (row && row.estimate_sent_at) || null;
    } catch (e2) { console.error('[API] estimate_sent_at record failed:', e2.message); }
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type || 'user', req.auth.id, 'estimate_sent', b.ref + ' to ' + b.contact_email + (resendId ? ' [' + resendId + ']' : ''), req.ip);
    } catch (_) {}
    console.log('[API] Estimate emailed for', b.ref, 'to', b.contact_email, resendId ? '(resend ' + resendId + ')' : '');
    // Return the recipient + id so the owner app can SHOW where it went — a
    // wrong/typo address is then caught immediately instead of failing silently.
    res.json({ ok: true, estimate_sent_at: sentAt, sent_to: b.contact_email, resend_id: resendId });
  } catch (e) {
    console.error('[API] send-estimate failed:', e.message);
    res.status(500).json({ error: 'Failed to send estimate — ' + e.message });
  }
});

// ── Send a free-text message to the customer ─────────────────────────────
// The operator types a message (e.g. a question) and it is emailed to the
// customer from Westmere, styled to match the brand.
router.post('/bookings/:id/send-message', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is empty' });
  if (message.length > 4000) return res.status(400).json({ error: 'Message is too long' });

  const b = db.prepare(`
    SELECT b.*, COALESCE(c.email, b.passenger_email) as contact_email,
           COALESCE(c.full_name, b.passenger_name) as contact_name
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.contact_email) return res.status(400).json({ error: 'No email address on this booking' });

  /* The owner's ask: include the payment links only while the customer still has
     a choice to make. paymentLock is the same question every other channel asks,
     so a cash-locked or settled booking gets the message and nothing to press —
     no card button into a booking that would refuse the card.
     The token is minted only when there is genuinely something to pay;
     ensurePayToken is idempotent, so a token already in a delivered estimate is
     never re-minted. */
  const { paymentLock } = require('./pay-lock');
  const lock = paymentLock(b);
  const msgPayToken = lock.payable
    ? (require('./intake').ensurePayToken(id) || b.pay_token || null)
    : null;

  try {
    const { sendCustomerMessage } = require('./email');
    const ok = await sendCustomerMessage(
      { ref: b.ref, name: b.contact_name, email: b.contact_email, pay_token: msgPayToken },
      message,
      { pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type || 'user', req.auth.id, 'customer_message_sent', b.ref + ' to ' + b.contact_email, req.ip);
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] send-message failed:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Mark a booking's payment as received → CONFIRMED ─────────────────────
// The owner/driver "Mark as paid" action, used mainly for cash-on-the-day jobs
// sitting at AWAITING_PAYMENT. Settling the fare is what turns an awaiting job
// into a CONFIRMED (paid) booking — cash is NEVER auto-confirmed at the moment
// the customer chooses it (see CLAUDE.md invariant #3). Idempotent: stamps
// paid_at once and fires the customer "confirmed" email only on the edge into
// confirmed. Drivers may only mark their own assigned jobs.
router.post('/bookings/:id/mark-paid', (req, res) => {
  if (!['admin', 'owner', 'driver'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (req.auth.role === 'driver' && b.driver_id !== req.auth.id) {
    return res.status(403).json({ error: 'You can only settle your own jobs' });
  }
  if (b.status === 'cancelled') return res.status(409).json({ error: 'This booking has been cancelled' });

  // Settle: stamp paid_at (once) and promote an unsettled booking to confirmed.
  // Completed jobs stay completed but still get paid_at stamped.
  const wasUnsettled = ['pending', 'offered', 'awaiting_payment'].includes(b.status);

  // AN OPEN BALANCE settles here too. The owner re-priced a prepaid trip
  // upwards and the customer is handing the DIFFERENCE to the driver — so this
  // click closes the difference and adds it to what has been collected, rather
  // than re-stamping a paid_at that was set weeks ago. Conditional on the
  // difference still being open, so a second click cannot bank it twice.
  const { openTopUp } = require('./pay-lock');
  const topUp = openTopUp(b);
  if (topUp) {
    const info = db.prepare(`
      UPDATE bookings
         SET fare_adjust_settled_at = datetime('now'),
             fare_adjust_method = COALESCE(NULLIF(fare_adjust_method,''), 'cash'),
             paid_amount = COALESCE(paid_amount, 0) + ?,
             status = CASE WHEN status IN ('pending','offered','awaiting_payment') THEN 'confirmed' ELSE status END,
             updated_at = datetime('now')
       WHERE id = ?
         AND fare_adjust_kind = 'topup'
         AND fare_adjust_settled_at IS NULL
    `).run(topUp.amount, id);
    if (info.changes) {
      try {
        db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
          .run(req.auth.type || 'user', req.auth.id, 'fare_topup_settled',
               b.ref + ' £' + topUp.amount.toFixed(2) + ' [cash]', req.ip);
      } catch (_) {}
    }
  } else {
    db.prepare(`UPDATE bookings
                   SET paid_at = COALESCE(paid_at, datetime('now')),
                       paid_amount = COALESCE(paid_amount, fare),
                       status = CASE WHEN status IN ('pending','offered','awaiting_payment') THEN 'confirmed' ELSE status END,
                       updated_at = datetime('now')
                 WHERE id = ?`).run(id);
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'payment_marked_received', b.ref, req.ip);
  } catch (_) {}

  // "Mark as paid" is an INTERNAL settlement of a cash booking — the customer
  // already got their "booking confirmed, pay your driver on the day" email when
  // they chose cash. Do NOT send another customer email here (no "paid" spam);
  // just refresh the connected staff apps.
  if (wasUnsettled) {
    events.broadcast('booking:confirmed', { id, ref: b.ref, reason: 'Cash received (marked paid by owner)' });
  } else {
    events.broadcast('booking:updated', { id, ref: b.ref, reason: 'Marked paid' });
  }

  res.json({ ok: true, status: wasUnsettled ? 'confirmed' : b.status, paid: true });
});

// Sends a branded email asking the customer to pay, with card-only options
// (no cash). Used when a completed booking hasn't been paid.
// ── Corporate introduction email ─────────────────────────────────────────
router.post('/send-corporate-intro', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { email, company } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const ok = await sendCorporateIntro(email, company || '');
    if (ok) res.json({ ok: true });
    else res.status(500).json({ error: 'Email send failed' });
  } catch (e) {
    console.error('[API] corporate intro failed:', e.message);
    res.status(500).json({ error: 'Failed to send' });
  }
});

/* ── THE CUSTOMER DIRECTORY ───────────────────────────────────────────────
   Everyone who has ridden more than twice, so the owner stops retyping a phone
   number he has already typed three times.

   Mounted at /api/customer-directory, NOT /api/customers — that path is
   already the accounts table's admin CRUD (rider logins, invoicing), and a
   second router.get on it would simply never fire.

   PII, and therefore owner/admin ONLY. These sit on the apiRouter, which
   server/index.js mounts behind requireAuth — there is no public counterpart and
   there must never be one. server/tests/customer-directory.test.js asserts that
   no public router exposes any of it.

   GUARDRAIL: server/tests/customer-directory.test.js */
router.get('/customer-directory', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const dir = require('./customer-directory');
    res.json({ ok: true, customers: dir.list(getDb(), req.query && req.query.q) });
  } catch (e) {
    console.error('[API] customer directory list failed:', e.message);
    res.status(500).json({ error: 'Could not load customers' });
  }
});

/* A message from the owner to ONE driver. Same letterhead as everything else;
   the driver's address comes from his record, never from the request. */
router.post('/drivers/:id/message', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  const message = String((req.body && req.body.message) || '').trim();
  const subject = String((req.body && req.body.subject) || '').trim();
  if (!message) return res.status(400).json({ error: 'Write a message' });
  if (message.length > 8000) return res.status(400).json({ error: 'Message is too long' });
  try {
    const d = getDb().prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role = 'driver'")
      .get(parseInt(req.params.id, 10));
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    if (!d.email) return res.status(400).json({ error: 'No email address on this driver' });
    const ok = await require('./email').sendDriverMessage(d, message, { subject: subject || undefined });
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });
    try {
      getDb().prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run('staff', req.auth.id || 0, 'driver_message', d.email, req.ip);
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] driver message failed:', e.message);
    res.status(500).json({ error: 'Could not send the message' });
  }
});

/* SEND A LETTER TO ANYBODY — a hotel, another operator, a supplier.
   Standalone: no booking, no customer record, nothing looked up. Staff only,
   because this sends mail out under the company's own domain and a loose gate
   here is somebody else's spam problem with Westmere's name on it. */
router.post('/outreach', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  const to = String((req.body && req.body.to) || '').trim();
  const subject = String((req.body && req.body.subject) || '').trim();
  const message = String((req.body && req.body.message) || '').trim();

  /* One recipient per send, checked BEFORE the address shape. A pasted list
     fails the address test too, but "Enter a valid email address" is the wrong
     thing to tell somebody who has just pasted four addresses — they will fix
     the spelling and try again. This is also the only check that catches a
     comma INSIDE one address, which the shape test happily allows. */
  if (/[,;]/.test(to)) return res.status(400).json({ error: 'One recipient at a time' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!subject) return res.status(400).json({ error: 'Enter a subject' });
  if (!message) return res.status(400).json({ error: 'Write a message' });
  if (subject.length > 200) return res.status(400).json({ error: 'Subject is too long' });
  if (message.length > 8000) return res.status(400).json({ error: 'Message is too long' });

  try {
    const ok = await require('./email').sendOutreachMessage(to, subject, message);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });
    try {
      getDb().prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run('staff', req.auth.id || 0, 'outreach_sent', to + ' — ' + subject.slice(0, 120), req.ip);
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] outreach failed:', e.message);
    res.status(500).json({ error: 'Could not send the message' });
  }
});

/* One saved customer's spend and every trip they have taken.
   Staff only, exactly like the rest of the directory — this is a named person's
   address, number and spending history in one response. */
router.get('/customer-directory/:id/trips', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const dir = require('./customer-directory');
    const out = dir.tripsFor(getDb(), parseInt(req.params.id, 10));
    if (!out) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true, customer: out.customer, trips: out.trips, stats: out.stats });
  } catch (e) {
    console.error('[API] customer trips failed:', e.message);
    res.status(500).json({ error: 'Could not load this customer' });
  }
});

// Correcting a record by hand. Nothing recomputes this table any more, so an
// edit simply stands — there is no lock to set and nothing to defend it from.
router.patch('/customer-directory/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });
  const dir = require('./customer-directory');
  dir.ensureSchema(db);
  const row = db.prepare('SELECT * FROM customer_directory WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });

  const b = req.body || {};
  const name  = b.name  === undefined ? row.name  : String(b.name  || '').trim();
  const phone = b.phone === undefined ? row.phone : String(b.phone || '').trim();
  const email = b.email === undefined ? row.email : String(b.email || '').trim();
  const home  = b.home_address === undefined ? row.home_address : String(b.home_address || '').trim();

  if (email && !dir.normEmail(email)) return res.status(400).json({ error: 'That email address is not valid' });
  if (phone && !dir.normPhone(phone)) return res.status(400).json({ error: 'That phone number is not valid' });

  // Editing the phone or email moves the match key, so a second row for the same
  // person could otherwise appear on the next rebuild. Refuse a collision rather
  // than silently merging two people's histories.
  const pk = dir.normPhone(phone) || null;
  const ek = dir.normEmail(email) || null;
  if (pk && pk !== row.phone_key) {
    const clash = db.prepare('SELECT id, name FROM customer_directory WHERE phone_key = ? AND id <> ?').get(pk, id);
    if (clash) return res.status(409).json({ error: 'That phone number already belongs to ' + (clash.name || 'another customer') + '.' });
  }
  if (ek && ek !== row.email_key) {
    const clash = db.prepare("SELECT id, name FROM customer_directory WHERE email_key = ? AND email_key <> '' AND id <> ?").get(ek, id);
    if (clash) return res.status(409).json({ error: 'That email already belongs to ' + (clash.name || 'another customer') + '.' });
  }

  db.prepare(`
    UPDATE customer_directory
       SET name = ?, phone = ?, email = ?, home_address = ?,
           phone_key = ?, email_key = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(name || null, phone || null, email || null, home || null, pk, ek, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_directory_edited', (name || row.name || '#' + id), req.ip);
  } catch (_) {}

  res.json({ ok: true, customer: db.prepare('SELECT id, name, phone, email, home_address, added_by FROM customer_directory WHERE id = ?').get(id) });
});

/* Add the customer on a booking to the owner's list.
   The ONLY way anything gets into customer_directory. Nothing automatic writes
   to it — the more-than-two-bookings rule is gone at the owner's request.

   Reads the booking; writes only to customer_directory. The booking, the
   accounts table, invoices and earnings are untouched by this.
   GUARDRAIL: server/tests/customer-directory.test.js */
router.post('/bookings/:id/add-customer', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const db = getDb();
  const out = require('./customer-directory').addFromBooking(db, id);
  if (!out.ok) {
    if (out.reason === 'not_found') return res.status(404).json({ error: 'Booking not found' });
    return res.status(400).json({
      error: 'This booking has no phone number or email, so there is nothing to save them under.',
      reason: out.reason
    });
  }
  if (!out.already) {
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type || 'user', req.auth.id, 'customer_list_added', (out.customer.name || '#' + out.customer.id), req.ip);
    } catch (_) {}
  }
  res.json({ ok: true, already: out.already, customer: out.customer });
});

/* Take somebody off the list.
   A plain delete: nothing repopulates this table, so there is nothing to
   suppress. To put them back the owner taps Add on any of their bookings.
   Their bookings and money are not touched. */
router.delete('/customer-directory/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });
  const db = getDb();
  const row = require('./customer-directory').remove(db, id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_list_removed', (row.name || '#' + id), req.ip);
  } catch (_) {}
  res.json({ ok: true, removed: true, name: row.name || null });
});

/* ── REOPEN / CHANGE THE PAYMENT OPTION ──────────────────────────────────
   The customer picked the wrong option — "pay your driver" when he meant to pay
   by card. pay-lock treats `payment='cash'` as a LOCK: the pay page stops
   offering the card form and POST /pay/:ref/intent answers 409. That lock is
   correct — it is what stops two channels charging one fare — but until now
   there was no way back from it, so the owner's only recourse was the phone
   number in the lock message.

   This route is the way back. Setting the option to `pending` clears the lock,
   so the emailed pay page offers BOTH doors again, and moves a booking that had
   been confirmed back to awaiting_payment — the pre-confirmed stage the owner
   app labels "To be confirmed" while no method is chosen.

   WHAT IT WILL NOT DO
     A booking whose card payment actually CAPTURED is refused outright, with no
     confirm override. Reopening it would put a Pay button in front of someone
     whose money we already hold, which is the double-charge path this codebase
     exists to avoid. Getting money back out is a refund
     (POST /bookings/:id/fare-refund), and a refund is a deliberate press.

     A booking marked paid in CASH is different — no card charge exists, so the
     owner is really saying "he did not actually hand me the money". That is
     allowed, but only with an explicit confirm, because it un-settles a trip
     somebody has already reconciled.

   GUARDRAIL: server/tests/payment-option.test.js */
router.post('/bookings/:id/payment-option', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  // Only the two the owner may set by hand. 'card' is NOT settable here — a card
  // payment is written by the Stripe webhook and by nothing else (CLAUDE.md
  // payment invariant #1), so offering it as a dropdown value would be a way to
  // mark a booking paid that nobody paid.
  const REOPEN = 'pending', CASH = 'cash';
  const want = String((req.body && req.body.payment) || '').toLowerCase();
  if (want !== REOPEN && want !== CASH) {
    return res.status(400).json({ error: 'Payment option must be "pending" or "cash"' });
  }
  const confirm = !!(req.body && req.body.confirm);

  const b = db.prepare('SELECT id, ref, status, payment, paid_at, fare, payment_intent_id FROM bookings WHERE id = ?').get(id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status === 'cancelled') {
    return res.status(409).json({ error: 'This booking has been cancelled.', reason: 'cancelled' });
  }

  const capturedByCard = String(b.payment || '').toLowerCase() === 'card' || !!b.payment_intent_id;
  const markedPaid = !!b.paid_at;

  // HARD STOP. No confirm flag opens this door.
  if (capturedByCard) {
    return res.status(409).json({
      error: 'This trip was paid by card, so the payment cannot be reopened — that would let the customer be charged twice. '
           + 'Refund it first (the Refund action on the job), then reopen.',
      reason: 'card_paid', blocked: true
    });
  }
  // Soft stop — real, but reversible by an owner who means it.
  if (markedPaid && !confirm) {
    return res.status(409).json({
      error: 'This trip is already marked as paid in cash. Reopening it will mark it UNPAID again and ask the customer to choose a payment method. Continue?',
      reason: 'needs_confirm', needsConfirm: true
    });
  }
  if (String(b.payment || '').toLowerCase() === want && !markedPaid) {
    return res.json({ ok: true, unchanged: true, payment: want, status: b.status });
  }

  // Validated, never a silent default — CLAUDE.md payment invariant #1.
  const { assertPaymentMethod } = require('./payment-methods');
  const method = assertPaymentMethod(want, 'api payment-option');

  // Reopening un-settles: paid_at goes only when the owner has confirmed the
  // cash never arrived. A confirmed/active job drops back to awaiting_payment so
  // the board shows it needs the customer again; a job already earlier in the
  // lifecycle stays where it is.
  const reopening = want === REOPEN;
  const REOPENABLE = ['confirmed', 'active'];
  const nextStatus = reopening && REOPENABLE.includes(b.status) ? 'awaiting_payment' : b.status;

  db.prepare(`
    UPDATE bookings
       SET payment = ?,
           paid_at = CASE WHEN ? = 1 THEN NULL ELSE paid_at END,
           status  = ?,
           updated_at = datetime('now')
     WHERE id = ? AND status <> 'cancelled'
  `).run(method, reopening ? 1 : 0, nextStatus, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'payment_option_changed',
           b.ref + ': ' + (b.payment || 'pending') + ' -> ' + method
           + (b.status !== nextStatus ? ' (' + b.status + ' -> ' + nextStatus + ')' : '')
           + (markedPaid && reopening ? ' [un-settled, owner confirmed]' : ''), req.ip);
  } catch (e) { console.error('[API] payment-option audit failed:', e.message); }

  try { events.broadcast('booking:updated', { id, ref: b.ref, status: nextStatus, reason: 'Payment option changed' }); } catch (_) {}

  res.json({ ok: true, payment: method, status: nextStatus,
             reopened: reopening, wasPaid: markedPaid,
             from: { payment: b.payment || 'pending', status: b.status } });
});

router.post('/bookings/:id/payment-reminder', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  const b = db.prepare(`
    SELECT b.*, COALESCE(c.email, b.passenger_email) as contact_email,
           COALESCE(c.full_name, b.passenger_name) as contact_name
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.contact_email) return res.status(400).json({ error: 'No email address on this booking' });

  /* THE DEAD END THIS CLOSES
     This route used to block on paid_at alone. A booking locked to
     "pay your driver" has no paid_at, so the send succeeded and mailed a
     customer a Pay Now button — onto a page that then told him he could not
     pay. Ask pay-lock the same question every other channel asks, and refuse
     to send a card button that cannot work.

     `no_fare` is not a lock (pay-lock says payable:false, locked:false) but it
     is still nothing to chase, so it is refused here too. */
  const { paymentLock } = require('./pay-lock');
  const lock = paymentLock(b);
  if (lock.reason === 'paid') {
    return res.status(409).json({ error: 'This booking is already paid', reason: 'paid' });
  }
  if (lock.reason === 'cash_chosen') {
    return res.status(409).json({
      error: 'This customer chose to pay the driver on the day, so a card link would not work for them. '
           + 'Change the payment option to "To be confirmed" in Edit first — the reminder will then offer both card and cash.',
      reason: 'cash_chosen'
    });
  }
  if (!lock.payable) {
    return res.status(409).json({ error: lock.message || 'There is nothing to pay on this booking yet', reason: lock.reason || 'not_payable' });
  }

  // Mint the token if this booking never had one — otherwise the reminder is
  // prose asking for payment with no way to make it. send-estimate has always
  // done this; the reminder simply never did. ensurePayToken is idempotent, so
  // a token already in a sent email is never invalidated.
  const payToken = require('./intake').ensurePayToken(id) || b.pay_token || null;

  try {
    const { sendPaymentReminder } = require('./email');
    const ok = await sendPaymentReminder({
      email: b.contact_email,
      name: b.contact_name || '',
      ref: b.ref,
      fare: b.fare,
      // What the pay page will actually take. On a re-priced prepaid trip that
      // is the balance, not the fare — the email must not name a bigger number
      // than the button charges.
      amountDue: lock.amountDue,
      pickup: b.pickup,
      destination: b.destination,
      date: b.date,
      time: b.time,
      pay_token: payToken
    });
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type || 'user', req.auth.id, 'payment_reminder_sent', b.ref + ' to ' + b.contact_email, req.ip);
    } catch (_) {}

    res.json({ ok: true });
  } catch (e) {
    console.error('[API] payment reminder failed:', e.message);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

router.post('/invoices/:id/remind', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  if (!row.recipient_email) return res.status(400).json({ error: 'No email address on file for this invoice' });

  try {
    const { sendInvoiceReminder } = require('./email');
    // Minted here if the row somehow has none, so the View Invoice link works.
    const token = require('./invoice-pdf').ensureInvoiceToken(db, row);
    const ok = await sendInvoiceReminder(
      { name: row.recipient_name || '', email: row.recipient_email },
      row.invoice_no, row.total, null, token
    );
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });
  } catch (e) {
    console.error('[API] invoice reminder failed:', e.message);
    return res.status(500).json({ error: 'Failed to send reminder' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_reminder_sent', row.invoice_no + ' to ' + row.recipient_email, req.ip);
  } catch (e) { /* non-fatal */ }

  res.json({ ok: true });
});

// Invoice settings (business details + bank details for invoices)
router.get('/settings/invoice', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}
  res.json({ ok: true, settings });
});

router.put('/settings/invoice', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const settings = req.body || {};
  const allowed = ['business_name', 'owner_name', 'address_line1', 'address_line2', 'postcode',
    'phone', 'email', 'bank_name', 'sort_code', 'account_no', 'account_name'];
  const clean = {};
  for (const k of allowed) {
    if (settings[k] !== undefined) clean[k] = String(settings[k]).trim();
  }
  try {
    db.prepare("INSERT OR REPLACE INTO integrations (provider, key, value) VALUES ('invoice_settings', 'invoice_settings', ?)").run(JSON.stringify(clean));
  } catch (e) {
    console.error('[API] invoice settings save failed:', e.message);
    return res.status(500).json({ error: 'Failed to save settings. Please try again.' });
  }
  res.json({ ok: true });
});

// ── Owner self-profile ──────────────────────────────────────────────────

router.get('/owner/profile', (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  const db = getDb();
  const row = db.prepare(`
    SELECT id, full_name, email, phone, vehicle, reg,
           license_no, license_expiry, dbs_no, dbs_expiry,
           phv_no, insurance_no
    FROM users WHERE id = ?
  `).get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  res.json({ ok: true, profile: row });
});

router.patch('/owner/profile', (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  const db = getDb();
  const allowed = ['full_name', 'phone', 'vehicle', 'reg', 'license_no', 'license_expiry', 'dbs_no', 'dbs_expiry', 'phv_no', 'insurance_no'];
  const updates = [];
  const values = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f] === '' ? null : String(req.body[f]).trim());
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  values.push(req.auth.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// ── Drivers (admin only) ────────────────────────────────────────────────

function sanitizeDriver(row) {
  if (!row) return row;
  if (!row.has_login || (row.username && row.username.startsWith('__nolgn_'))) {
    row.username = null;
    row.has_login = 0;
  }
  return row;
}

// Pick the next sequential invoice number for a given prefix (YYYYMM).
// Looks at BOTH the stored invoices table and legacy audit_log entries to
// avoid collisions with the pre-invoices-table history.
function nextInvoiceNo(db, invoicePrefix) {
  const like = 'INV-' + invoicePrefix + '%';
  let maxNum = 0;
  try {
    const row = db.prepare("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1").get(like);
    if (row && row.invoice_no) {
      const m = row.invoice_no.match(/-(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch (_) {}
  try {
    const legacy = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'invoice_sent' AND detail LIKE ?").get(like).c;
    if (legacy > maxNum) maxNum = legacy;
  } catch (_) {}
  return 'INV-' + invoicePrefix + '-' + String(maxNum + 1).padStart(4, '0');
}

router.get('/drivers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, username, full_name, email, phone, role, active, has_login,
           license_no, license_expiry, dbs_no, dbs_expiry, vehicle, reg,
           phv_no, insurance_no, driver_notes, photo, is_default_driver,
           max_passengers, max_bags, luggage_notes,
           onboarding_status, created_at
    FROM users WHERE role IN ('driver','owner') AND active = 1 ORDER BY created_at DESC
  `).all().map(sanitizeDriver);
  res.json({ ok: true, drivers: rows });
});

router.get('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const row = db.prepare(`
    SELECT id, username, full_name, email, phone, role, active, has_login,
           license_no, license_expiry, dbs_no, dbs_expiry, vehicle, reg,
           phv_no, insurance_no, driver_notes, photo, is_default_driver,
           max_passengers, max_bags, luggage_notes,
           created_at
    FROM users WHERE id = ? AND role IN ('driver','owner')
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Driver not found' });
  res.json({ ok: true, driver: sanitizeDriver(row) });
});

// Create driver (admin/owner). Login credentials are optional — admin can
// register a driver on the roster first, and issue username/password later.
router.post('/drivers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const {
    username, password, full_name, email, phone, role, active,
    license_no, license_expiry, dbs_no, dbs_expiry,
    vehicle, reg, phv_no, insurance_no, driver_notes, photo,
    max_passengers, max_bags, luggage_notes
  } = req.body;

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full name required' });
  }

  const db = getDb();
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');

  // Always auto-generate credentials for onboarding flow.
  // If admin supplies explicit username+password, use those instead.
  const wantsManualLogin = !!(username && password);
  if (username && !password) return res.status(400).json({ error: 'Password required when setting username' });
  if (password && !username) return res.status(400).json({ error: 'Username required when setting password' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  let finalUsername, finalHash, tempPassword = null;

  if (wantsManualLogin) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    finalUsername = username.trim();
    finalHash = bcrypt.hashSync(password, 12);
  } else {
    // Auto-generate: "firstname" + 3 random digits, e.g. "james472"
    const firstName = full_name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'driver';
    let candidate = firstName + (Math.floor(Math.random() * 900) + 100);
    let attempts = 0;
    while (db.prepare('SELECT id FROM users WHERE username = ?').get(candidate) && attempts++ < 20) {
      candidate = firstName + (Math.floor(Math.random() * 9000) + 1000);
    }
    finalUsername = candidate;
    // Temp password: readable 8 chars — "Wph" + 5 random mixed-case alphanumeric
    const pool = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    tempPassword = 'Wph' + Array.from({length:5}, () => pool[Math.floor(Math.random() * pool.length)]).join('');
    finalHash = bcrypt.hashSync(tempPassword, 12);
  }

  const calendarToken = require('crypto').randomUUID().replace(/-/g, '');

  let result;
  try {
    result = db.prepare(`
      INSERT INTO users
        (username, password, role, full_name, email, phone, active, has_login,
         license_no, license_expiry, dbs_no, dbs_expiry,
         vehicle, reg, phv_no, insurance_no, driver_notes, photo,
         max_passengers, max_bags, luggage_notes, onboarding_status, calendar_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      finalUsername, finalHash, role || 'driver', full_name.trim(),
      email || null, phone || null,
      active === 0 ? 0 : 1, 1,  // has_login always 1 — they get real credentials
      license_no || null, license_expiry || null,
      dbs_no || null, dbs_expiry || null,
      vehicle || null, reg || null,
      phv_no || null, insurance_no || null, driver_notes || null,
      photo || null,
      max_passengers == null || max_passengers === '' ? null : parseInt(max_passengers, 10),
      max_bags == null || max_bags === '' ? null : parseInt(max_bags, 10),
      luggage_notes || null,
      'pending',
      calendarToken
    );
  } catch (e) {
    console.error('[API] driver insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to create driver account. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_created', full_name, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  // Send welcome email if driver has an email address
  if (email) {
    const { sendDriverWelcome } = require('./email');
    sendDriverWelcome({
      email,
      full_name: full_name.trim(),
      username: finalUsername,
      temp_password: tempPassword
    }).catch(e => console.error('[API] driver welcome email failed:', e.message));
  }

  res.status(201).json({
    ok: true,
    driver: {
      id: result.lastInsertRowid,
      username: finalUsername,
      temp_password: tempPassword,   // null if admin supplied their own password
      has_login: true,
      onboarding_status: 'pending',
      app_url: '/westmere-driver.html'
    }
  });
});

// Delete (deactivate) driver — soft delete preserves booking history
router.delete('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_removed', driver.full_name || driver.username, req.ip);
  } catch (e) { /* non-fatal */ }

  res.json({ ok: true });
});

// Update driver (admin/owner)
router.patch('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const existing = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!existing) return res.status(404).json({ error: 'Driver not found' });

  const body = req.body || {};
  const updates = [];
  const values = [];

  const plainFields = [
    'full_name', 'email', 'phone', 'active',
    'license_no', 'license_expiry', 'dbs_no', 'dbs_expiry',
    'vehicle', 'reg', 'phv_no', 'insurance_no', 'driver_notes', 'photo',
    'max_passengers', 'max_bags', 'luggage_notes'
  ];
  for (const f of plainFields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] === '' ? null : body[f]);
    }
  }

  // Grant / change app access
  if (body.username !== undefined || body.password !== undefined) {
    const bcrypt = require('bcryptjs');
    if (body.username) {
      const newUsername = String(body.username).trim();
      if (newUsername !== existing.username) {
        const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, id);
        if (dup) return res.status(409).json({ error: 'Username already exists' });
        updates.push('username = ?'); values.push(newUsername);
      }
    }
    if (body.password) {
      if (String(body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      updates.push('password = ?'); values.push(bcrypt.hashSync(body.password, 12));
    }
    if (body.username && body.password) {
      updates.push('has_login = 1');
    }
  }
  if (body.revoke_login === true) {
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    updates.push('username = ?'); values.push('__nolgn_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'));
    updates.push('password = ?'); values.push(bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10));
    updates.push('has_login = 0');
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(id);

  try {
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] driver update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update driver. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_updated', existing.full_name || existing.username, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  res.json({ ok: true });
});

// ── Grant / update driver login credentials (admin-only) ─────────────────
// Dedicated endpoint for provisioning a driver's portal username + password.
// Equivalent to PATCH /drivers/:id with {username, password} but more
// explicit — useful for admin UI "Set Login" button.
router.post('/drivers/:id/set-credentials', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });

  const driver = db.prepare("SELECT id, full_name, username FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(username).trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const cleanUsername = String(username).trim();
  const bcrypt = require('bcryptjs');

  // Check for duplicate username (skip if it's the same driver's current username)
  const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(cleanUsername, id);
  if (dup) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(String(password), 12);
  db.prepare(`
    UPDATE users
       SET username = ?, password = ?, has_login = 1, updated_at = datetime('now')
     WHERE id = ?
  `).run(cleanUsername, hash, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_credentials_set', driver.full_name || driver.username, req.ip);
  } catch (_) {}

  res.json({ ok: true, message: 'Driver credentials set. They can now log in via /api/auth/login.' });
});

// Earnings summary for a driver over a period. Used by admin driver
// detail / weekly statements. Commission is 10% on the fare by default;
// if driver_pay / admin_fee are set on a booking those override.
const COMMISSION_RATE = 0.10;
router.get('/drivers/:id/earnings', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  // Admins/owners can view any driver; drivers can only view themselves.
  const isStaff = ['admin', 'owner'].includes(req.auth.role);
  if (!isStaff && req.auth.id !== id) return res.status(403).json({ error: 'Forbidden' });

  // Default range: current week (Mon–Sun) if nothing provided.
  let from = req.query.from, to = req.query.to;
  if (!from || !to) {
    const { dateStr: _today, dayOfWeek: _dow } = ukNow();
    const _diffToMon = (_dow + 6) % 7; // Mon=0
    const mon = new Date(_today + 'T00:00:00'); mon.setDate(mon.getDate() - _diffToMon);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0, 10);
    to   = sun.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }

  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status,
           driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ?
       AND date >= ? AND date <= ?
       AND status IN ('completed','done')
     ORDER BY date ASC, time ASC
  `).all(id, from, to);

  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    // If admin set explicit payouts use those; otherwise derive from commission rate.
    const itemCommission = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * COMMISSION_RATE).toFixed(2);
    const itemNet = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - itemCommission).toFixed(2);
    gross += fare; commission += itemCommission; net += itemNet;
    return {
      id: b.id, ref: b.ref, date: b.date, time: b.time,
      pickup: b.pickup, destination: b.destination,
      fare, commission: itemCommission, net: itemNet,
      payment: b.payment, status: b.status
    };
  });

  res.json({
    ok: true,
    driver: { id: driver.id, name: driver.full_name, email: driver.email },
    period: { from, to },
    commission_rate: COMMISSION_RATE,
    totals: {
      jobs: items.length,
      gross: +gross.toFixed(2),
      commission: +commission.toFixed(2),
      net: +net.toFixed(2)
    },
    items
  });
});

// Shortcut: earnings for the currently signed-in driver. Driver app uses this.
router.get('/me/earnings', (req, res) => {
  if (!['driver', 'owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Driver access required' });
  }
  req.params.id = String(req.auth.id);
  // Delegate by re-dispatching — simpler to inline the same logic:
  const db = getDb();
  let from = req.query.from, to = req.query.to;
  if (!from || !to) {
    const { dateStr: _today2, dayOfWeek: _dow2 } = ukNow();
    const _diffToMon2 = (_dow2 + 6) % 7; // Mon=0
    const mon = new Date(_today2 + 'T00:00:00'); mon.setDate(mon.getDate() - _diffToMon2);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0, 10); to = sun.toISOString().slice(0, 10);
  }
  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ?").get(req.auth.id);
  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status,
           driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ? AND date >= ? AND date <= ?
       AND status IN ('completed','done')
     ORDER BY date ASC, time ASC
  `).all(req.auth.id, from, to);
  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    const c = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * COMMISSION_RATE).toFixed(2);
    const n = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - c).toFixed(2);
    gross += fare; commission += c; net += n;
    return {
      id: b.id, ref: b.ref, date: b.date, time: b.time,
      pickup: b.pickup, destination: b.destination,
      fare, commission: c, net: n, payment: b.payment, status: b.status
    };
  });
  res.json({
    ok: true,
    driver: driver ? { id: driver.id, name: driver.full_name } : null,
    period: { from, to }, commission_rate: COMMISSION_RATE,
    totals: { jobs: items.length, gross: +gross.toFixed(2), commission: +commission.toFixed(2), net: +net.toFixed(2) },
    items
  });
});

// Email a weekly earnings statement to a driver. Body: { from, to }.
router.post('/drivers/:id/statement', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const { from, to } = req.body || {};
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  }
  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (!driver.email) return res.status(400).json({ error: 'Driver has no email on file' });

  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status, driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ? AND date >= ? AND date <= ?
       AND status IN ('confirmed','active','completed','done')
     ORDER BY date ASC, time ASC
  `).all(id, from, to);
  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    const c = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * 0.10).toFixed(2);
    const n = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - c).toFixed(2);
    gross += fare; commission += c; net += n;
    return { date: b.date, time: b.time, ref: b.ref, pickup: b.pickup, destination: b.destination, fare, commission: c, net: n };
  });
  const totals = { jobs: items.length, gross: +gross.toFixed(2), commission: +commission.toFixed(2), net: +net.toFixed(2) };

  const { sendDriverStatement } = require('./email');
  const ok = await sendDriverStatement({ name: driver.full_name, email: driver.email }, { from, to }, totals, items);
  if (!ok) return res.status(502).json({ error: 'Email delivery failed (check RESEND_API_KEY)' });
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type || 'user', req.auth.id, 'driver_statement_sent', driver.full_name + ' ' + from + '→' + to, req.ip);
  res.json({ ok: true, sent_to: driver.email, totals });
});

// Mark a driver as the default (auto-allocation target for new bookings).
// Only one driver can be default at a time, so this also clears any prior flag.
router.post('/drivers/:id/default', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const existing = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role IN ('driver','owner') AND active = 1").get(id);
  if (!existing) return res.status(404).json({ error: 'Driver not found or inactive' });
  try {
    db.transaction(() => {
      db.prepare("UPDATE users SET is_default_driver = 0 WHERE is_default_driver = 1").run();
      db.prepare("UPDATE users SET is_default_driver = 1 WHERE id = ?").run(id);
    })();
  } catch (e) {
    console.error('[API] default driver update failed:', e.message);
    return res.status(500).json({ error: 'Failed to set default driver. Please try again.' });
  }
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'default_driver_set', existing.full_name, req.ip);
  } catch (e) { /* audit failure must not block the response */ }
  res.json({ ok: true });
});

// ── Audit log (admin only) ──────────────────────────────────────────────

router.get('/audit', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
  res.json({ ok: true, logs: rows });
});

// ── Stats (admin/owner) ─────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const today = ukNow().dateStr;

  const totalBookings = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
  const todayBookings = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date = ?').get(today).c;
  const pendingBookings = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c;
  const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE active = 1').get().c;
  const totalDrivers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('driver','owner') AND active = 1").get().c;
  // Revenue = money actually received only: cash collected on a completed job,
  // or any booking with paid_at set (Stripe / online / marked paid). Pending or
  // unpaid account/invoice bookings are NOT counted (invoice income is tracked
  // via the paid flag on invoices).
  const RECEIVED = "((LOWER(payment)='cash' AND status='completed') OR paid_at IS NOT NULL)";
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(fare),0) as total FROM bookings WHERE ${RECEIVED}`).get().total;

  res.json({
    ok: true,
    stats: { totalBookings, todayBookings, pendingBookings, totalCustomers, totalDrivers, totalRevenue }
  });
});

// ── Mileage stats (for tax / HMRC purposes) ─────────────────────────────
// Returns trip miles + dead miles for today, this week, this month,
// this tax year (6 Apr → 5 Apr), and all-time. Includes only non-cancelled
// bookings that have trip_miles recorded.
router.get('/mileage', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();

  // UK timezone dates
  const { dateStr: today, dayOfWeek: _milDow, year: yr, month: mo, day: dy } = ukNow();
  const _milDiffToMon = (_milDow + 6) % 7; // Mon=0
  const weekStart = new Date(today + 'T00:00:00');
  weekStart.setDate(weekStart.getDate() - _milDiffToMon);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const taxYearStart = (mo > 4 || (mo === 4 && dy >= 6))
    ? `${yr}-04-06`
    : `${yr - 1}-04-06`;

  const base = "SELECT COALESCE(SUM(trip_miles),0) as trip, COALESCE(SUM(dead_miles_km/1.60934),0) as dead, COUNT(*) as jobs FROM bookings WHERE status != 'cancelled' AND trip_miles IS NOT NULL";

  const mToday   = db.prepare(`${base} AND date = ?`).get(today);
  const mWeek    = db.prepare(`${base} AND date >= ? AND date <= ?`).get(weekStartStr, today);
  const mMonth   = db.prepare(`${base} AND date >= ?`).get(monthStart);
  const mTaxYear = db.prepare(`${base} AND date >= ?`).get(taxYearStart);
  const mAll     = db.prepare(base).get();

  const fmt = r => ({ trip_miles: Math.round(r.trip * 10) / 10, dead_miles: Math.round(r.dead * 10) / 10, total_miles: Math.round((r.trip + r.dead) * 10) / 10, jobs: r.jobs });

  res.json({
    ok: true,
    mileage: {
      today: fmt(mToday),
      week: fmt(mWeek),
      month: fmt(mMonth),
      tax_year: { ...fmt(mTaxYear), start: taxYearStart },
      all_time: fmt(mAll)
    }
  });
});

// ── Backfill trip_miles for bookings that don't have it ──────────────────
// Called once on startup and can be triggered manually. Uses OSRM to
// calculate road distance for each booking with pickup + destination.
router.post('/mileage/backfill', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const { _fareGeocode, _fareRoute } = require('./fare-engine');

  const rows = db.prepare(`
    SELECT id, pickup, destination FROM bookings
    WHERE trip_miles IS NULL AND status != 'cancelled'
    AND pickup IS NOT NULL AND destination IS NOT NULL
  `).all();

  let updated = 0, failed = 0;
  for (const row of rows) {
    try {
      const [gc1, gc2] = await Promise.all([_fareGeocode(row.pickup), _fareGeocode(row.destination)]);
      if (gc1 && gc2) {
        const rt = await _fareRoute(gc1.lat, gc1.lon, gc2.lat, gc2.lon);
        if (rt) {
          const miles = Math.round(rt.distance / 1609.34 * 10) / 10;
          db.prepare('UPDATE bookings SET trip_miles = ? WHERE id = ?').run(miles, row.id);
          updated++;
          continue;
        }
      }
      failed++;
    } catch (e) { failed++; }
  }

  res.json({ ok: true, total: rows.length, updated, failed });
});

// ── Analytics ────────────────────────────────────────────────────────────
router.get('/analytics', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) return res.status(403).json({ error: 'Access denied' });
  const db = getDb();
  const { dateStr: today, dayOfWeek: _anDow } = ukNow();
  const _anDiffToMon = (_anDow + 6) % 7; // Mon=0
  const weekStart = new Date(today + 'T00:00:00');
  weekStart.setDate(weekStart.getDate() - _anDiffToMon);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  // Revenue = money actually received only: cash collected on a completed job,
  // or any booking with paid_at set (Stripe / online / marked paid). Pending or
  // unpaid account/invoice bookings are NOT counted (invoice income is tracked
  // separately via the paid flag on invoices). `p` prefixes the columns when the
  // bookings table is aliased (e.g. 'b.').
  const recv = (p='') => `((LOWER(${p}payment)='cash' AND ${p}status='completed') OR ${p}paid_at IS NOT NULL)`;

  // Revenue overview
  const revToday   = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date=? AND ${recv()}`).get(today).t;
  const revWeek    = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date>=? AND date<=? AND ${recv()}`).get(weekStartStr, today).t;
  const revMonth   = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date>=? AND ${recv()}`).get(monthStart).t;
  const revAllTime = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE ${recv()}`).get().t;

  // Weekly trend — last 12 weeks (oldest first)
  const weeklyTrend = [];
  for (let i = 11; i >= 0; i--) {
    const ws = new Date(weekStart); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws);        we.setDate(we.getDate() + 6);
    const wsStr = ws.toISOString().split('T')[0];
    const weStr = we.toISOString().split('T')[0];
    const row = db.prepare(`SELECT COALESCE(SUM(fare),0) as total, COUNT(*) as jobs FROM bookings WHERE date>=? AND date<=? AND ${recv()}`).get(wsStr, weStr);
    weeklyTrend.push({ weekStart: wsStr, total: row.total, jobs: row.jobs });
  }

  // Driver performance
  const drivers = db.prepare(`
    SELECT u.id, u.full_name,
      COUNT(CASE WHEN b.status='completed' THEN 1 END) as jobs_completed,
      COALESCE(SUM(CASE WHEN ${recv('b.')} THEN b.fare ELSE 0 END), 0) as total_earnings,
      COUNT(CASE WHEN b.status IN ('completed','confirmed','active') THEN 1 END) as jobs_accepted,
      COUNT(b.id) as jobs_offered,
      COALESCE(AVG(CASE WHEN ${recv('b.')} THEN CAST(b.fare AS REAL) END), 0) as avg_fare
    FROM users u
    LEFT JOIN bookings b ON b.driver_id = u.id
    WHERE u.role IN ('driver','owner') AND u.active = 1
    GROUP BY u.id ORDER BY total_earnings DESC
  `).all();

  // Busiest times heatmap — [dayOfWeek 0=Mon][hour 0-23]
  const heatmap = Array.from({length:7}, () => Array(24).fill(0));
  db.prepare(`SELECT date, time FROM bookings WHERE status != 'cancelled' AND date IS NOT NULL AND time IS NOT NULL`).all().forEach(b => {
    // b.date is a UK wall-clock calendar date — derive its weekday from the
    // literal components (via UTC) so the bucket never shifts with the host
    // timezone. `new Date('2026-08-16').getDay()` is UTC-parsed but local-read.
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.date || ''));
    if (!dm) return;
    const d = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
    if (isNaN(d.getTime())) return;
    const dow = (d.getUTCDay() + 6) % 7;
    const hr = parseInt((b.time || '').split(':')[0], 10);
    if (isNaN(hr) || hr < 0 || hr > 23) return;
    heatmap[dow][hr]++;
  });

  // Top customers
  const topCustomers = db.prepare(`
    SELECT c.id, c.full_name, c.email,
      COUNT(b.id) as total_bookings,
      COALESCE(SUM(CASE WHEN ${recv('b.')} THEN b.fare ELSE 0 END), 0) as total_spend
    FROM customers c
    LEFT JOIN bookings b ON b.customer_id = c.id
    WHERE c.active = 1
    GROUP BY c.id HAVING total_bookings > 0
    ORDER BY total_bookings DESC LIMIT 10
  `).all();

  // Booking breakdown
  const byStatus  = db.prepare(`SELECT status, COUNT(*) as count FROM bookings GROUP BY status`).all();
  const byPayment = db.prepare(`SELECT payment, COUNT(*) as count, COALESCE(SUM(CASE WHEN ${recv()} THEN fare ELSE 0 END),0) as total FROM bookings WHERE payment IS NOT NULL GROUP BY payment`).all();

  res.json({ ok: true, revenue: { today: revToday, week: revWeek, month: revMonth, allTime: revAllTime }, weeklyTrend, drivers, heatmap, topCustomers, byStatus, byPayment });
});

// ── Stripe Payouts (owner only) ──────────────────────────────────────────
const stripe = require('./stripe');

function ownerOnly(req, res, next) {
  if (req.auth.role !== 'owner' && req.auth.role !== 'admin') return res.status(403).json({ error: 'Owner only' });
  next();
}

router.get('/stripe/balance', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.json({ ok: true, available: 0, pending: 0, currency: 'gbp', reason: 'not_configured' });
    const bal = await stripe.getBalance();
    res.json({ ok: true, ...bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stripe/payout', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.status(400).json({ error: 'Stripe not configured' });
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum payout is £1.00' });
    const payout = await stripe.createPayout({ amount, description: req.body.description || 'Westmere payout' });
    res.json({ ok: true, payout: { id: payout.id, amount: payout.amount, status: payout.status, arrival_date: payout.arrival_date } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stripe/payouts', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.json({ ok: true, payouts: [] });
    const payouts = await stripe.listRecentPayouts();
    res.json({ ok: true, payouts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-time admin helper: clear the review_emails_sent record so the review
// email can be re-sent on the next status→completed transition.
router.delete('/review-reset/:email', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const email = (req.params.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const result = db.prepare('DELETE FROM review_emails_sent WHERE email = ?').run(email);
  res.json({ ok: true, deleted: result.changes });
});

module.exports = router;
