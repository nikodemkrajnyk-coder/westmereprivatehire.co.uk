/**
 * Public API — no authentication required
 *
 * POST /api/public/book              — Create a booking + send notifications
 * POST /api/public/create-payment-intent — Create a Stripe PaymentIntent
 */

const express = require('express');
const { getDb } = require('./db');
const { sendAdminAlert } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const { createPaymentIntent, isConfigured: stripeConfigured } = require('./stripe');
const gcal = require('./google-calendar');
const intake = require('./intake');
const events = require('./events');

const router = express.Router();

// ── Create booking (public form) ─────────────────────────────────────────
router.post('/book', async (req, res) => {
  try {
    const { name, email, phone, pickup, destination, date, time,
            passengers, bags, flight, fare, payment, notes, source } = req.body;

    // Validate required fields
    if (!name || !phone || !pickup || !destination) {
      return res.status(400).json({ error: 'Name, phone, pickup, and destination are required' });
    }

    // Default date to today if not provided
    const bookingDate = date || new Date().toISOString().split('T')[0];

    // Reject bookings in the past — if a customer picks a date that has
    // already passed, or today with a time that has already gone by, bail
    // out before we write anything to the database.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
      return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    }
    // Get "now" in Europe/London. Use sv-SE which formats as "YYYY-MM-DD HH:MM:SS"
    // — a format the Date constructor actually understands (en-GB gives
    // DD/MM/YYYY which produces Invalid Date and crashes toISOString).
    const ukNowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const todayStr = `${ukNowParts.year}-${ukNowParts.month}-${ukNowParts.day}`;
    const ukHour = parseInt(ukNowParts.hour, 10);
    const ukMinute = parseInt(ukNowParts.minute, 10);
    if (bookingDate < todayStr) {
      return res.status(400).json({ error: 'Pickup date is in the past' });
    }
    if (bookingDate === todayStr && time && time !== 'ASAP') {
      // Compare HH:MM against the current local UK clock
      const m = String(time).match(/^(\d{1,2}):(\d{2})/);
      if (m) {
        const reqMins = (+m[1]) * 60 + (+m[2]);
        const nowMins = ukHour * 60 + ukMinute;
        if (reqMins < nowMins) {
          return res.status(400).json({ error: 'Pickup time is in the past — please choose ASAP or a future time' });
        }
      }
    }

    // Basic email format check
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const db = getDb();
    const ref = 'WM-' + Date.now().toString(36).toUpperCase().slice(-6);

    // Check if customer exists by email, link if so
    let customerId = null;
    if (email) {
      const existing = db.prepare('SELECT id FROM customers WHERE email = ? AND active = 1').get(email.trim().toLowerCase());
      if (existing) customerId = existing.id;
    }

    // Insert booking
    const result = db.prepare(`
      INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, passengers, bags, trip_type, flight, fare, payment, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, customerId, pickup, destination, bookingDate, time || 'ASAP',
      passengers || 1, bags || '0', null,
      flight || null, fare || null, payment || 'cash',
      notes || null
    );

    // Audit log
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('public', customerId || 0, 'booking_created', ref, req.ip);

    // Build notification payload
    const booking = {
      ref, name, email, phone, pickup, destination, date: bookingDate, time,
      passengers, bags, flight, fare, payment, notes
    };

    // Send admin notifications in background (don't block the response).
    // Customer-facing email + WhatsApp fire later, once intake confirms.
    Promise.allSettled([
      sendAdminAlert(booking),
      sendAdminBookingWhatsApp(booking)
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error('[NOTIFY] Channel', i, 'failed:', r.reason?.message || r.reason);
        }
      });
    });

    // Push to Google Calendar in background
    gcal.createEvent({
      id: result.lastInsertRowid, ref, pickup, destination,
      date: bookingDate, time: time || 'ASAP',
      passengers, bags, flight, fare, payment, notes,
      customer_name: name, customer_phone: phone,
      status: 'pending'
    }).then(eventId => {
      if (eventId) {
        try { db.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').run(eventId, result.lastInsertRowid); } catch (e) {}
      }
    }).catch(() => {});

    // Smart intake: ask Claude if we can fit it. Runs in background, never
    // blocks the booking response. If ANTHROPIC_API_KEY is missing this is
    // a graceful no-op.
    intake.evaluate(result.lastInsertRowid).catch(e => {
      console.error('[INTAKE] evaluate threw:', e.message);
    });

    // Push a real-time notification to every open staff app.
    events.broadcast('booking:created', {
      id: result.lastInsertRowid, ref, name, pickup, destination,
      date: bookingDate, time: time || 'ASAP',
      payment: payment || 'cash', fare: fare || null
    });

    res.status(201).json({ ok: true, ref, bookingId: result.lastInsertRowid });

  } catch (err) {
    console.error('[BOOK] Error creating booking:', err && err.stack || err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});


// ── Create Stripe PaymentIntent ──────────────────────────────────────────
router.post('/create-payment-intent', async (req, res) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Payment system not configured' });
    }

    const { amount, currency, booking, customer } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Amount must be at least 100 (pence)' });
    }

    const intent = await createPaymentIntent({
      amount: Math.round(amount),
      currency: currency || 'gbp',
      booking,
      customer
    });

    res.json({ ok: true, clientSecret: intent.client_secret });

  } catch (err) {
    console.error('[STRIPE] PaymentIntent error:', err.message);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// ── Stripe webhook (payment confirmation) ────────────────────────────────
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const { verifyWebhook } = require('./stripe');

  let event;
  try {
    event = verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[STRIPE] Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (!event) return res.status(400).json({ error: 'Webhook not configured' });

  // Handle payment success
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const ref = intent.metadata?.booking_ref;
    if (ref) {
      const db = getDb();
      const row = db.prepare("SELECT id, status, fare FROM bookings WHERE ref = ?").get(ref);
      if (row && row.fare && Math.round(row.fare * 100) !== intent.amount) {
        console.error('[STRIPE] Amount mismatch for', ref, '- expected', Math.round(row.fare * 100), 'got', intent.amount);
      }
      db.prepare("UPDATE bookings SET payment = 'card', status = 'confirmed', updated_at = datetime('now') WHERE ref = ?").run(ref);
      console.log('[STRIPE] Payment confirmed for', ref);
      // Fire customer "Booking confirmed" on the pending → confirmed edge
      if (row && row.status === 'pending') {
        intake.notifyCustomerConfirmed(row.id)
          .catch(e => console.error('[STRIPE] notifyCustomerConfirmed failed:', e.message));
        events.broadcast('booking:confirmed', { id: row.id, ref, reason: 'Paid online' });
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
