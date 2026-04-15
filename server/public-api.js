/**
 * Public API — no authentication required
 *
 * POST /api/public/book              — Create a booking + send notifications
 * POST /api/public/create-payment-intent — Create a Stripe PaymentIntent
 */

const express = require('express');
const { getDb } = require('./db');
const { sendCustomerConfirmation, sendAdminAlert } = require('./email');
const { sendCustomerBookingWhatsApp, sendAdminBookingWhatsApp } = require('./whatsapp');
const { createPaymentIntent, isConfigured: stripeConfigured } = require('./stripe');
const gcal = require('./google-calendar');
const intake = require('./intake');

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

    // Send notifications in background (don't block the response)
    Promise.allSettled([
      email ? sendCustomerConfirmation(booking) : Promise.resolve(),
      sendAdminAlert(booking),
      phone ? sendCustomerBookingWhatsApp(booking) : Promise.resolve(),
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

    res.status(201).json({ ok: true, ref, bookingId: result.lastInsertRowid });

  } catch (err) {
    console.error('[BOOK] Error creating booking:', err);
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
      db.prepare("UPDATE bookings SET payment = 'card', status = 'confirmed', updated_at = datetime('now') WHERE ref = ?").run(ref);
      console.log('[STRIPE] Payment confirmed for', ref);
    }
  }

  res.json({ received: true });
});

module.exports = router;
