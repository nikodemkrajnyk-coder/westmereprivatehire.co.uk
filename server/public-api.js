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
const { computeSuggestedFare } = require('./fare-engine');
const gcal = require('./google-calendar');
const intake = require('./intake');
const events = require('./events');
let autoFile;
try { autoFile = require('./auto-file'); } catch(e) { autoFile = { fileBooking(){} }; console.error('[AUTOFILE] Module failed:', e.message); }

// ── UK timezone helper ───────────────────────────────────────────────────
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

const router = express.Router();

// ── Branded standalone page for the "Pay on the day" link ────────────────
// Self-contained HTML (no build step) matching the westmere-pay.html styling.
// state: 'ok' | 'paid' | 'error'
function cashPage(state, message, ref) {
  const okIcon   = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6L9 17l-5-5"/></svg>';
  const infoIcon = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
  const isConfirm = state === 'confirm';
  const isErr = state === 'error';
  const heading = state === 'ok' ? 'Thank you' : (state === 'paid' ? 'Already paid' : (isConfirm ? 'Pay on the day' : 'Link not available'));
  const icoCls = (isErr || isConfirm) ? 'info' : 'ok';
  const ico = (isErr || isConfirm) ? infoIcon : okIcon;
  const refLine = ref ? `<p style="margin-top:12px" class="muted-ref">Ref: ${String(ref).replace(/[<>&"]/g, '')}</p>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<meta name="theme-color" content="#111D2C"><meta name="robots" content="noindex,nofollow">
<title>Your journey | Westmere Executive Private Hire</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Jost:wght@200;300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#111D2C;--gold:#B8985A;--text:#1C2A3E;--muted:#6B7280;--border:#E5E0D8;--serif:'Cormorant Garamond',Georgia,serif;--sans:'Jost','Helvetica Neue',Arial,sans-serif}
html{font-size:16px}
body{font-family:var(--sans);font-weight:300;color:var(--text);background:var(--navy);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:440px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.35)}
.head{background:var(--navy);color:#fff;padding:30px 32px 26px;text-align:center;border-bottom:3px solid var(--gold)}
.brand{font-family:var(--sans);font-size:10px;letter-spacing:3.5px;text-transform:uppercase;color:var(--gold);font-weight:500}
.brand-name{font-family:var(--serif);font-size:26px;font-weight:400;letter-spacing:.5px;margin-top:6px}
.body{padding:34px 32px 36px}
.state{text-align:center}
.ico{width:60px;height:60px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
.ico.ok{background:rgba(184,152,90,.14);color:var(--gold)}
.ico.info{background:rgba(28,42,62,.08);color:var(--navy)}
.state h2{font-family:var(--serif);font-size:24px;font-weight:400;color:var(--navy);margin-bottom:10px}
.state p{font-size:14px;color:var(--muted);line-height:1.6}
.muted-ref{font-family:'Menlo','Consolas',monospace;font-size:12px;letter-spacing:.5px;color:var(--navy)}
a.link{color:var(--gold);text-decoration:none}
</style></head>
<body><div class="card">
  <div class="head"><div class="brand">Executive Private Hire</div><div class="brand-name">Westmere</div></div>
  <div class="body"><div class="state">
    <div class="ico ${icoCls}">${ico}</div>
    <h2>${heading}</h2>
    <p>${message}</p>
    ${refLine}
    ${isConfirm ? `<form method="POST" style="margin-top:20px"><button type="submit" style="width:100%;padding:14px;background:var(--navy);color:#fff;border:none;border-radius:6px;font-family:var(--sans);font-size:13px;font-weight:500;letter-spacing:2px;text-transform:uppercase;cursor:pointer">Confirm — Pay on the Day</button></form>` : ''}
    <p style="margin-top:16px;font-size:13px">Questions? Call us on <a class="link" href="tel:+447930342593">07930&nbsp;342593</a>.</p>
  </div></div>
</div></body></html>`;
}

// ── Create booking (public form) ─────────────────────────────────────────
router.post('/book', async (req, res) => {
  try {
    const { name, email, phone, pickup, destination, date, time,
            passengers, bags, flight, fare, payment, notes, source,
            stop_address,
            pickup_lat: clientPickupLat, pickup_lng: clientPickupLng,
            returnTrip } = req.body;

    // Validate required fields
    if (!name || !pickup || !destination) {
      return res.status(400).json({ error: 'Name, pickup, and destination are required' });
    }

    // Default date to today if not provided
    const bookingDate = date || ukNow().dateStr;

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

    // Auto-allocate to the default driver if one is flagged. Owner runs most
    // jobs himself, so this saves a manual assignment step. Admin can still
    // reassign via the intake route if needed.
    let defaultDriverId = null;
    try {
      const row = db.prepare("SELECT id FROM users WHERE is_default_driver = 1 AND active = 1 LIMIT 1").get();
      if (row) defaultDriverId = row.id;
    } catch (_) {}

    // Google Calendar conflict check — if the calendar slot is free, auto-confirm.
    // If there's a conflicting event (personal appointment, another job, etc.),
    // leave as pending so the owner can decide manually.
    // Falls back gracefully if Google Calendar is not connected.
    let autoConfirm = !!defaultDriverId;
    if (autoConfirm) {
      try {
        if (gcal.isConfigured() && gcal.loadTokens()) {
          const calEvents = await gcal.listExternalEvents({ from: bookingDate, to: bookingDate });
          if (calEvents.length > 0 && time && time !== 'ASAP') {
            const m = String(time).match(/^(\d{1,2}):(\d{2})/);
            if (m) {
              // Treat booking as UTC (±1h for UK — acceptable for conflict detection)
              const bookingStart = new Date(bookingDate + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00Z');
              const bookingEnd = new Date(bookingStart.getTime() + 2 * 60 * 60 * 1000); // 2h window
              for (const ev of calEvents) {
                if (ev.allDay) continue;
                if (!ev.start) continue;
                const evStart = new Date(ev.start);
                const evEnd = new Date(ev.end || new Date(evStart.getTime() + 3600000));
                if (bookingStart < evEnd && evStart < bookingEnd) {
                  autoConfirm = false;
                  console.log(`[BOOK] ${ref} left pending — calendar conflict: "${ev.title}" at ${ev.start}`);
                  break;
                }
              }
            }
          }
        }
      } catch (calErr) {
        console.error('[BOOK] Calendar conflict check failed (non-blocking):', calErr.message);
        // On any error, leave as pending — safer to require manual confirmation
        autoConfirm = false;
      }
    }

    // Quote-request flow: public bookings are now estimate requests, not
    // instant confirmations. They always start pending with no driver and no
    // fare — the owner reviews the request, sends a manual estimate, and the
    // booking is confirmed only once the customer replies to accept it.
    const finalDriverId = null;
    const finalStatus   = 'pending';

    // Suggested fare — run the fare engine server-side so the owner/admin sees a
    // recommended all-in price on the Job Request and can confirm or adjust it.
    // Best-effort: a routing/geocode failure just leaves it null (price TBC).
    let suggestedFare = null;
    try {
      const sf = await computeSuggestedFare(pickup, destination, time);
      if (sf && sf.fare) suggestedFare = sf.fare;
    } catch (sfErr) {
      console.error('[BOOK] suggested fare failed (non-blocking):', sfErr.message);
    }

    // Insert booking
    // IMPORTANT: The customer sends their LOCAL time (Europe/London).
    // Store it exactly as received — no timezone conversion.
    const storedTime = String(time || 'ASAP').trim();
    console.log(`[BOOK] ${ref} time="${storedTime}" raw="${time}" type=${typeof time} body.time="${req.body.time}"`);
    const result = db.prepare(`
      INSERT INTO bookings (ref, customer_id, driver_id, pickup, destination, date, time,
                            passengers, bags, trip_type, flight, fare, payment, notes, status,
                            passenger_name, passenger_phone, passenger_email, suggested_fare, stop_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, customerId, finalDriverId,
      pickup, destination, bookingDate, storedTime,
      passengers || 1, bags || '0', null,
      flight || null, fare || null, payment || 'pending',
      notes || null,
      finalStatus,
      (name || '').trim() || null,
      (phone || '').trim() || null,
      (email || '').trim().toLowerCase() || null,
      suggestedFare,
      (stop_address || '').trim() || null
    );

    // Verify stored time matches input
    try {
      const check = db.prepare('SELECT time FROM bookings WHERE id = ?').get(result.lastInsertRowid);
      if (check && check.time !== storedTime) {
        console.error(`[BOOK] TIME MISMATCH! ${ref}: input="${storedTime}" stored="${check.time}"`);
      } else {
        console.log(`[BOOK] ${ref} verified: time="${check ? check.time : '?'}" ✓`);
      }
    } catch (_) {}

    // Return (round) trip — create a linked return booking if requested
    let returnRef = null;
    let returnBookingId = null;
    if (returnTrip && returnTrip.date && returnTrip.date >= todayStr) {
      try {
        returnRef = 'WM-' + (Date.now() + 1).toString(36).toUpperCase().slice(-6);
        // Return leg runs the opposite way (destination → pickup), so quote it
        // separately rather than reusing the outbound suggestion.
        let retSuggestedFare = null;
        try {
          const rsf = await computeSuggestedFare(destination, pickup, returnTrip.time);
          if (rsf && rsf.fare) retSuggestedFare = rsf.fare;
        } catch (_) {}
        const retResult = db.prepare(`
          INSERT INTO bookings (ref, customer_id, driver_id, pickup, destination, date, time,
                                passengers, bags, trip_type, flight, fare, payment, notes, status,
                                passenger_name, passenger_phone, passenger_email,
                                linked_booking_id, trip_group, suggested_fare)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          returnRef, customerId, finalDriverId,
          destination, pickup,          // swapped: airport → home
          returnTrip.date, returnTrip.time || 'ASAP',
          passengers || 1, bags || '0', null,
          returnTrip.flight || null, returnTrip.fare || null, payment || 'pending',
          `Return journey (linked to ${ref})`,
          finalStatus,
          (name || '').trim() || null,
          (phone || '').trim() || null,
          (email || '').trim().toLowerCase() || null,
          result.lastInsertRowid, ref, retSuggestedFare
        );
        returnBookingId = retResult.lastInsertRowid;
        // Link the outbound to its return leg
        try {
          db.prepare('UPDATE bookings SET linked_booking_id = ?, trip_group = ? WHERE id = ?')
            .run(returnBookingId, ref, result.lastInsertRowid);
        } catch (_) {}
        // Admin alert for return leg
        Promise.allSettled([
          sendAdminAlert({ ref: returnRef, name, email, phone,
            pickup: destination, destination: pickup,
            date: returnTrip.date, time: returnTrip.time,
            passengers, bags, flight: returnTrip.flight,
            fare: returnTrip.fare, payment, notes: `Return leg (outbound: ${ref})` })
        ]).catch(() => {});
        // Calendar + intake for return leg
        gcal.createEvent({ id: returnBookingId, ref: returnRef, pickup: destination, destination: pickup,
          date: returnTrip.date, time: returnTrip.time || 'ASAP',
          passengers, bags, flight: returnTrip.flight, fare: returnTrip.fare, payment,
          notes: `Return leg (outbound: ${ref})`, customer_name: name, customer_phone: phone, status: finalStatus
        }).then(eid => { if (eid) { try { db.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').run(eid, returnBookingId); } catch (_) {} } }).catch(() => {});
        // (intake auto-confirm intentionally skipped — see note on the outbound leg)
        events.broadcast('booking:created', { id: returnBookingId, ref: returnRef, name,
          pickup: destination, destination: pickup,
          date: returnTrip.date, time: returnTrip.time || 'ASAP',
          payment: payment || 'pending', fare: returnTrip.fare || null });
      } catch (retErr) {
        console.error('[BOOK] Return trip insert failed (non-blocking):', retErr.message);
        returnRef = null; returnBookingId = null;
      }
    }

    // Audit log
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('public', customerId || 0, 'booking_created', ref, req.ip);

    // Dead miles (collection fee) are NOT recomputed here. Two reasons:
    //   1. Fixed airport fares already bake the collection cost into the client
    //      fare tables — recomputing would double-charge.
    //   2. Custom journeys come in as estimate requests (fare = null); the owner
    //      quotes them manually via the AI assistant, whose calculate_fare tool
    //      applies the tiered dead-miles rate (see server/dead-miles.js:
    //      5 mi free, next 20 mi @ £1.50, remainder @ £1.00).
    const finalFare = fare || null;

    // Build notification payload
    const booking = {
      ref, name, email, phone, pickup, destination, date: bookingDate, time,
      passengers, bags, flight, fare: finalFare, payment, notes, stop_address
    };

    // Send admin notifications in background (don't block the response).
    // Customer-facing email + WhatsApp fire later, once intake confirms.
    Promise.allSettled([
      sendAdminAlert(booking)
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
      passengers, bags, flight, fare, payment, notes, stop_address,
      customer_name: name, customer_phone: phone,
      status: 'pending'
    }).then(eventId => {
      if (eventId) {
        try { db.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').run(eventId, result.lastInsertRowid); } catch (e) {}
      }
    }).catch(() => {});

    // Smart intake (auto-confirm) is intentionally NOT run for public quote
    // requests. Auto-confirming would email the customer a "Booking confirmed"
    // notice and skip the estimate step. Instead the booking stays pending so
    // the owner can review it, set a price, and send a manual estimate. The
    // admin still gets the alert above.

    // Push a real-time notification to every open staff app.
    events.broadcast('booking:created', {
      id: result.lastInsertRowid, ref, name, pickup, destination,
      date: bookingDate, time: time || 'ASAP',
      payment: payment || 'pending', fare: finalFare || null,
      suggested_fare: suggestedFare
    });

    // Auto-file to organized folder structure (non-blocking)
    const fullBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    if (fullBooking) autoFile.fileBooking(fullBooking);

    res.status(201).json({ ok: true, ref, bookingId: result.lastInsertRowid, suggested_fare: suggestedFare });

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

// ── Pre-payment: booking pay-info ────────────────────────────────────────
// The "Pay Now" link in the confirmation email points here. Access is gated by
// the per-booking pay_token (a random secret in the link) so booking refs can't
// be enumerated to leak fares or addresses. Returns just enough to render the
// payment page.
router.get('/pay/:ref', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) return res.status(400).json({ error: 'Booking reference and token required' });

    const b = db.prepare(`
      SELECT ref, pickup, destination, stop_address, date, time, fare, status, payment, pay_token, paid_at, notes
        FROM bookings WHERE ref = ?
    `).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).json({ error: 'Payment link not found or has expired' });
    }

    const paid = !!b.paid_at || b.payment === 'card';
    res.json({
      ok: true,
      stripeReady: stripeConfigured(),
      booking: {
        ref: b.ref,
        pickup: b.pickup,
        destination: b.destination,
        stop_address: b.stop_address || null,
        date: b.date,
        time: b.time,
        fare: b.fare,
        notes: b.notes || null,
        status: b.status,
        paid,
        cancelled: b.status === 'cancelled',
        payable: !paid && b.status !== 'cancelled' && !!b.fare && Number(b.fare) > 0
      }
    });
  } catch (err) {
    console.error('[PAY] pay-info error:', err.message);
    res.status(500).json({ error: 'Could not load payment details' });
  }
});

// ── Pre-payment: create PaymentIntent for a confirmed booking ────────────
// Unlike the generic create-payment-intent above, the amount is taken from the
// booking's stored fare (server-side) — never trusted from the client — and the
// caller must present the matching pay_token.
router.post('/pay/:ref/intent', async (req, res) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Payment system not configured' });
    }
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String((req.body && (req.body.token || req.body.t)) || '').trim();
    if (!ref || !token) return res.status(400).json({ error: 'Booking reference and token required' });

    const b = db.prepare(`
      SELECT ref, pickup, destination, date, time, fare, status, payment, pay_token, paid_at,
             passenger_name, passenger_phone, passenger_email
        FROM bookings WHERE ref = ?
    `).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).json({ error: 'Payment link not found or has expired' });
    }
    if (b.status === 'cancelled') return res.status(409).json({ error: 'This booking has been cancelled' });
    if (b.paid_at || b.payment === 'card') return res.status(409).json({ error: 'This booking is already paid' });
    if (!b.fare || Number(b.fare) <= 0) return res.status(409).json({ error: 'No fare is set for this booking yet' });

    const amount = Math.round(Number(b.fare) * 100);
    const intent = await createPaymentIntent({
      amount,
      currency: 'gbp',
      booking: { ref: b.ref, from: b.pickup, to: b.destination, date: b.date, time: b.time },
      customer: { name: b.passenger_name, email: b.passenger_email, phone: b.passenger_phone }
    });

    res.json({ ok: true, clientSecret: intent.client_secret, amount });
  } catch (err) {
    console.error('[PAY] intent error:', err.message);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// ── Pay on the day: customer opts to settle with the driver ──────────────
// The "Pay on the day" button in the confirmation email points here. Gated by
// the same per-booking pay_token. Marks the booking payment = 'cash', notifies
// the owner over SSE, and returns a friendly thank-you page. Idempotent — a
// repeat click just re-marks it. The pay_token is intentionally left intact so
// the customer can still change their mind and pay online later.
// GET shows a confirmation page — does NOT mark as cash. This prevents email
// clients from auto-triggering cash payment when they pre-fetch links.
router.get('/pay/:ref/cash', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) {
      return res.status(400).send(cashPage('error', 'This link is incomplete. Please use the link from your confirmation email.'));
    }

    const b = db.prepare(`SELECT id, ref, fare, status, payment, pay_token, paid_at FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(cashPage('error', "We couldn't find this booking. The link may have expired or already been settled."));
    }
    if (b.status === 'cancelled') {
      return res.status(409).send(cashPage('error', 'This booking has been cancelled. Please call us if you need to rebook.'));
    }
    if (b.paid_at || b.payment === 'card') {
      return res.send(cashPage('paid', 'This journey has already been paid online — there is nothing further to do.', b.ref));
    }
    if (b.payment === 'cash') {
      return res.send(cashPage('ok', "You're all set — please settle the fare with your driver on the day, by cash or card. We look forward to welcoming you.", b.ref));
    }

    // Show confirmation page — the customer must click the button to confirm
    const fareStr = b.fare ? '£' + Number(b.fare).toFixed(2) : '';
    res.send(cashPage('confirm', 'You have chosen to settle the fare' + (fareStr ? ' of ' + fareStr : '') + ' with your driver on the day, by cash or card. Please confirm below.', b.ref));
  } catch (err) {
    console.error('[PAY] cash page error:', err.message);
    res.status(500).send(cashPage('error', 'Something went wrong. Please call us on 07930 342593 and we will sort it out.'));
  }
});

// POST actually marks the booking as cash — only triggered by the confirm button
router.post('/pay/:ref/cash', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) {
      return res.status(400).send(cashPage('error', 'This link is incomplete.'));
    }

    const b = db.prepare(`SELECT id, ref, fare, status, payment, pay_token, paid_at FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(cashPage('error', "We couldn't find this booking."));
    }
    if (b.paid_at || b.payment === 'card') {
      return res.send(cashPage('paid', 'This journey has already been paid online.', b.ref));
    }

    db.prepare(`UPDATE bookings SET payment = 'cash', updated_at = datetime('now') WHERE id = ?`).run(b.id);

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('public', 0, 'payment_cash_chosen', b.ref, req.ip);

    // Notify the owner in real time.
    try {
      events.broadcast('booking:payment', { id: b.id, ref: b.ref, mode: 'cash', fare: b.fare || null });
    } catch (_) {}

    console.log('[PAY] Cash on the day chosen for', b.ref);
    res.send(cashPage('ok', "You're all set — please settle the fare with your driver on the day, by cash or card. We look forward to welcoming you.", b.ref));
  } catch (err) {
    console.error('[PAY] cash error:', err.message);
    res.status(500).send(cashPage('error', 'Something went wrong. Please call us on 07930 342593 and we will sort it out.'));
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

  console.log('[STRIPE] Webhook received:', event.type);

  // Handle payment success
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const ref = intent.metadata?.booking_ref;
    if (!ref) {
      console.error('[STRIPE] payment_intent.succeeded with no booking_ref in metadata — intent', intent.id);
    }
    if (ref) {
      const db = getDb();
      const row = db.prepare("SELECT id, status, fare FROM bookings WHERE ref = ?").get(ref);
      if (!row) {
        console.error('[STRIPE] payment_intent.succeeded for unknown booking ref', ref);
      }
      if (row && row.fare && Math.round(row.fare * 100) !== intent.amount) {
        console.error('[STRIPE] Amount mismatch for', ref, '- expected', Math.round(row.fare * 100), 'got', intent.amount);
      }
      // Mark paid online. Stamp paid_at and clear pay_token so the "Pay Now"
      // link can't be reused. Keep status confirmed (cancelled stays cancelled).
      db.prepare(`UPDATE bookings
                     SET payment = 'card',
                         paid_at = COALESCE(paid_at, datetime('now')),
                         pay_token = NULL,
                         status = CASE WHEN status = 'cancelled' THEN status ELSE 'confirmed' END,
                         updated_at = datetime('now')
                   WHERE ref = ?`).run(ref);
      console.log('[STRIPE] Payment confirmed for', ref);
      // Tell the owner the customer paid online (amount in pounds for the toast).
      events.broadcast('booking:payment', {
        id: row?.id, ref, mode: 'online',
        fare: row && row.fare != null ? row.fare : (intent.amount ? intent.amount / 100 : null)
      });
      // Fire customer "Booking confirmed" on the pending → confirmed edge
      if (row && row.status === 'pending') {
        intake.notifyCustomerConfirmed(row.id)
          .catch(e => console.error('[STRIPE] notifyCustomerConfirmed failed:', e.message));
        events.broadcast('booking:confirmed', { id: row.id, ref, reason: 'Paid online' });
      } else {
        events.broadcast('booking:updated', { id: row?.id, ref, reason: 'Paid online' });
      }
    }
  }

  res.json({ received: true });
});

// ── Recommend to a friend ────────────────────────────────────────────────
// Sends a simple invitation email with a link to the booking page.
router.post('/recommend', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  try {
    const { sendRecommendation } = require('./email');
    const ok = await sendRecommendation(email);
    if (!ok) return res.status(502).json({ error: 'Could not send email' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[PUBLIC] recommend failed:', e.message);
    res.status(500).json({ error: 'Failed to send recommendation' });
  }
});

module.exports = router;
