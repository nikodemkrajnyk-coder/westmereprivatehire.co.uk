const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb, DATA_DIR } = require('./db');
const { sendAdminAlert, sendCustomerCancellation, sendCorporateIntro } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const gcal = require('./google-calendar');
const events = require('./events');

const INVOICES_DIR = path.join(DATA_DIR, 'invoices');
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
    rows = db.prepare(`
      SELECT b.*, u.full_name as driver_name, u.vehicle as driver_vehicle, u.reg as driver_reg
      FROM bookings b
      LEFT JOIN users u ON b.driver_id = u.id
      WHERE b.customer_id = ?
      ORDER BY b.date DESC, b.time DESC
      LIMIT 100
    `).all(id);
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
  const customerId = req.auth.type === 'customer' ? req.auth.id : (bodyCustomerId ? parseInt(bodyCustomerId, 10) : null);

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

  // Send admin notifications in background
  const customerName = customerId
    ? (db.prepare('SELECT full_name, email, phone FROM customers WHERE id = ?').get(customerId) || {})
    : {};
  const notifData = {
    ref, name: customerName.full_name || 'Guest', email: customerName.email || '',
    phone: customerName.phone || '', pickup, destination, stop_address, date, time,
    passengers, bags, flight, fare, payment, notes
  };
  Promise.allSettled([
    sendAdminAlert(notifData)
  ]).catch(() => {});

  // Push to Google Calendar in background
  const bookingForCal = {
    id: result.lastInsertRowid, ref, pickup, destination, stop_address, date, time,
    passengers, bags, flight, fare, payment, notes,
    customer_name: customerName.full_name || 'Guest',
    customer_phone: customerName.phone || '',
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
router.patch('/bookings/:id', (req, res) => {
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

  const allowed = ['status', 'driver_id', 'fare', 'notes', 'payment', 'passenger_name', 'passenger_phone', 'passenger_email', 'pickup', 'destination', 'stop_address', 'date', 'time', 'passengers', 'customer_id', 'paid_at', 'trip_miles'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  try {
    db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] booking update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update booking. Please try again.' });
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
           COALESCE(c.phone,     b.passenger_phone) as customer_phone
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(req.params.id);
  if (updated) {
    // Auto-file updated booking (non-blocking)
    autoFile.fileBooking(updated);
    if (updated.status === 'completed') autoFile.updateEarnings(updated.date ? updated.date.slice(0, 7) : null, getDb);

    // Send a one-time review request email on first completed booking per email
    if (updated.status === 'completed') {
      const { sendReviewRequest } = require('./email');
      const reviewEmail = updated.passenger_email ||
        (updated.customer_id ? (db.prepare('SELECT email FROM customers WHERE id = ?').get(updated.customer_id) || {}).email : null);
      if (reviewEmail) {
        const already = db.prepare('SELECT id FROM review_emails_sent WHERE email = ?').get(reviewEmail.toLowerCase());
        if (!already) {
          const firstName = (updated.customer_name || updated.passenger_name || '').split(' ')[0] || 'there';
          sendReviewRequest(reviewEmail, firstName, updated.ref)
            .then(ok => {
              if (ok) {
                try { db.prepare('INSERT OR IGNORE INTO review_emails_sent (email) VALUES (?)').run(reviewEmail.toLowerCase()); } catch (_) {}
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

  res.json({ ok: true });
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

  // Ownership check — the booking must belong to this customer
  if (booking.customer_id !== req.auth.id) {
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
  const row = db.prepare('SELECT id, email, full_name, phone, created_at FROM customers WHERE id = ?').get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true, profile: row });
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

  try {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
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
  const rows = db.prepare(`
    SELECT id, email, full_name, phone, account_type, active, verified, created_at,
           address_line1, address_line2, postcode,
           bank_name, bank_sort_code, bank_account_no, bank_account_name
      FROM customers WHERE active = 1 ORDER BY created_at DESC
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
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(path.join(INVOICES_DIR, invoiceNo + '.pdf'), pdfBuffer);
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
    ok: true, invoiceNo, journeys: bookings.length, total,
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

  const { recipient, items, due_days, send_email, notes } = req.body || {};
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
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(path.join(INVOICES_DIR, invoiceNo + '.pdf'), pdfBuffer);
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
    const ok = await sendBespokeInvoice(cleanRecipient, cleanItems, { dueDate, issuedDate, notes }, invoiceNo, settings, pdfBuffer);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + cleanRecipient.email, req.ip);
  }

  // Persist bespoke invoice so it can be reviewed later.
  try {
    db.prepare(`
      INSERT INTO invoices
        (invoice_no, kind, recipient_name, recipient_email, recipient_phone, recipient_addr,
         issued_date, due_date, notes, line_items_json, total, emailed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNo, 'bespoke', cleanRecipient.name, cleanRecipient.email, cleanRecipient.phone, cleanRecipient.address,
      issuedDate, dueDate, notes || null,
      JSON.stringify(cleanItems), total, shouldEmail ? 1 : 0, req.auth.id
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
    ok: true, invoiceNo, total, bespoke: true,
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
  const pdfPath = path.join(INVOICES_DIR, safeNo + '.pdf');

  // Serve cached file if it exists
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    return res.sendFile(pdfPath);
  }

  // Regenerate from stored invoice data
  try {
    let settings = {};
    try {
      const sr = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
      if (sr) settings = JSON.parse(sr.value);
    } catch (_) {}

    let lineItems = [];
    try { lineItems = JSON.parse(row.line_items_json || '[]'); } catch (_) {}

    const data = {
      invoiceNo: row.invoice_no,
      kind: row.kind,
      total: row.total,
      notes: row.notes || '',
      settings,
      period: { issuedDate: row.issued_date, dueDate: row.due_date || '', label: row.period_label || '' }
    };

    if (row.kind === 'bespoke') {
      data.recipient = {
        name: row.recipient_name, email: row.recipient_email || '',
        phone: row.recipient_phone || '', address: row.recipient_addr || ''
      };
      data.items = lineItems;
    } else {
      data.customer = {
        full_name: row.recipient_name, email: row.recipient_email || '', phone: row.recipient_phone || ''
      };
      data.bookings = lineItems;
    }

    const { buildInvoicePdf } = require('./invoice-pdf');
    const buf = await buildInvoicePdf(data);

    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(pdfPath, buf);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    res.send(buf);
  } catch (e) {
    console.error('[INVOICE PDF]', e.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
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
      const safeNo = (row.invoice_no || '').replace(/[^A-Za-z0-9\-_]/g, '');
      const pdfPath = path.join(INVOICES_DIR, safeNo + '.pdf');
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
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
    const pdfPath = path.join(INVOICES_DIR, invoiceNo + '.pdf');
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  } catch (e) { /* non-fatal */ }
  autoFile.removeInvoice(invoiceNo);

  res.json({ ok: true });
});

// Mark a stored invoice as paid (records the payment date).
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
    const ok = await sendCustomerEstimate({
      ref: b.ref, name: b.contact_name, email: b.contact_email,
      pickup: b.pickup, destination: b.destination, stop_address: b.stop_address,
      date: b.date, time: b.time, flight: b.flight, passengers: b.passengers,
      fare: b.fare, notes: b.notes, pay_token: payToken
    });
    if (!ok) return res.status(500).json({ error: 'Email send failed' });
    let sentAt = null;
    try {
      db.prepare("UPDATE bookings SET estimate_sent_at = datetime('now') WHERE id = ?").run(id);
      const row = db.prepare('SELECT estimate_sent_at FROM bookings WHERE id = ?').get(id);
      sentAt = (row && row.estimate_sent_at) || null;
    } catch (e2) { console.error('[API] estimate_sent_at record failed:', e2.message); }
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run(req.auth.type || 'user', req.auth.id, 'estimate_sent', b.ref + ' to ' + b.contact_email, req.ip);
    } catch (_) {}
    res.json({ ok: true, estimate_sent_at: sentAt });
  } catch (e) {
    console.error('[API] send-estimate failed:', e.message);
    res.status(500).json({ error: 'Failed to send estimate' });
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

  try {
    const { sendCustomerMessage } = require('./email');
    const ok = await sendCustomerMessage({ ref: b.ref, name: b.contact_name, email: b.contact_email }, message);
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
  db.prepare(`UPDATE bookings
                 SET paid_at = COALESCE(paid_at, datetime('now')),
                     status = CASE WHEN status IN ('pending','offered','awaiting_payment') THEN 'confirmed' ELSE status END,
                     updated_at = datetime('now')
               WHERE id = ?`).run(id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'payment_marked_received', b.ref, req.ip);
  } catch (_) {}

  // Fire the customer "Booking confirmed" email + WhatsApp only on the edge
  // into confirmed, so re-marking a settled booking stays quiet.
  if (wasUnsettled) {
    require('./intake').notifyCustomerConfirmed(id)
      .catch(e => console.error('[API] notifyCustomerConfirmed (mark-paid) failed:', e.message));
    events.broadcast('booking:confirmed', { id, ref: b.ref, reason: 'Payment received' });
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
  if (b.paid_at) return res.status(409).json({ error: 'This booking is already paid' });

  try {
    const { sendPaymentReminder } = require('./email');
    const ok = await sendPaymentReminder({
      email: b.contact_email,
      name: b.contact_name || '',
      ref: b.ref,
      fare: b.fare,
      pickup: b.pickup,
      destination: b.destination,
      date: b.date,
      time: b.time,
      pay_token: b.pay_token
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
  const row = db.prepare('SELECT invoice_no, recipient_name, recipient_email, total, paid FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  if (!row.recipient_email) return res.status(400).json({ error: 'No email address on file for this invoice' });

  try {
    const { sendInvoiceReminder } = require('./email');
    const ok = await sendInvoiceReminder(
      { name: row.recipient_name || '', email: row.recipient_email },
      row.invoice_no, row.total, null
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
    const d = new Date(b.date);
    if (isNaN(d.getTime())) return;
    const dow = (d.getDay() + 6) % 7;
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
