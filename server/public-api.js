/**
 * Public API — no authentication required
 *
 * POST /api/public/book              — Create a booking + send notifications
 * POST /api/public/create-payment-intent — Create a Stripe PaymentIntent
 */

const express = require('express');
const { getDb } = require('./db');
const { sendAdminAlert, sendCustomerAcknowledgement } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const { createPaymentIntent, isConfigured: stripeConfigured,
        findPaymentIntentByRef, findOpenPaymentIntentByRef, findIntentByAdjustKey } = require('./stripe');
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
<title>Your journey | Westmere Private Hire</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#102a43;--text:#102a43;--muted:#657485;--border:#dfe5ea;--serif:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;--sans:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif}
html{font-size:16px}
body{font-family:var(--sans);font-weight:400;color:var(--text);background:#EEF2F5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:440px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid var(--border)}
.head{background:transparent;color:var(--navy);padding:30px 32px 26px;text-align:center;border-bottom:1px solid var(--border)}
.brand{font-family:var(--sans);font-size:11px;letter-spacing:3.5px;text-transform:uppercase;color:var(--muted);font-weight:600}
.brand-name{font-family:var(--serif);font-size:26px;font-weight:400;letter-spacing:.5px;margin-top:6px}
.body{padding:34px 32px 36px}
.state{text-align:center}
.ico{width:60px;height:60px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
.ico.ok{background:rgba(16,42,67,.08);color:var(--navy)}
.ico.info{background:rgba(28,42,62,.08);color:var(--navy)}
.state h2{font-family:var(--serif);font-size:24px;font-weight:400;color:var(--navy);margin-bottom:10px}
.state p{font-size:14px;color:var(--muted);line-height:1.6}
.muted-ref{font-family:'Menlo','Consolas',monospace;font-size:12px;letter-spacing:.5px;color:var(--navy)}
a.link{color:var(--navy);text-decoration:none;border-bottom:1px solid rgba(16,42,67,.28)}
</style></head>
<body><div class="card">
  <div class="head"><div class="brand">Private Hire</div><div class="brand-name">Westmere</div></div>
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

    // Build notification payload. estimated_fare carries the server-side quick
    // estimate so the customer acknowledgement email can show it (framed as an
    // estimate). It does NOT set the booking fare — the booking stays unpriced
    // until the owner sends a manual estimate.
    const booking = {
      ref, name, email, phone, pickup, destination, date: bookingDate, time,
      passengers, bags, flight, fare: finalFare, payment, notes, stop_address,
      estimated_fare: suggestedFare
    };

    // Fire the owner alert AND the instant customer acknowledgement together, in
    // the background (don't block the response). allSettled → one failing does
    // not stop the other; each rejection is logged. The acknowledgement is just a
    // receipt — the owner's manual Send Estimate (with payment links) still
    // follows separately.
    Promise.allSettled([
      sendAdminAlert(booking),
      sendCustomerAcknowledgement(booking)
    ]).then(results => {
      const labels = ['admin-alert', 'customer-acknowledgement'];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error('[NOTIFY] ' + (labels[i] || i) + ' failed:', r.reason?.message || r.reason);
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

    // The fare_adjust_* columns are NOT optional here. Without them the lock
    // cannot see an open balance on a re-priced trip, reads paid_at, and tells
    // a customer who still owes £15.50 that their trip is already paid — a
    // dead end at the end of the Pay button we just emailed them.
    const b = db.prepare(`
      SELECT ref, pickup, destination, stop_address, date, time, fare, status, payment, pay_token, paid_at, notes,
             fare_adjust_kind, fare_adjust_amount, fare_adjust_paid,
             fare_adjust_at, fare_adjust_method, fare_adjust_settled_at
        FROM bookings WHERE ref = ?
    `).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).json({ error: 'Payment link not found or has expired' });
    }

    // ONE gate for both channels (server/pay-lock.js). The email link and
    // My Account ask the same question of the same live row, so the page can
    // never offer a payment that the other channel has already settled.
    const { paymentLock } = require('./pay-lock');
    const lock = paymentLock(b);
    const paid = lock.reason === 'paid';
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
        // THE AMOUNT THIS PAGE MAY TAKE. Normally the fare; on a re-priced
        // prepaid trip it is the balance only. The page must charge and DISPLAY
        // this figure — showing £57.50 and taking £15.50 looks like a fault even
        // though the smaller number is the right one.
        amountDue: lock.amountDue,
        topUp: lock.reason === 'top_up',
        alreadyPaid: lock.reason === 'top_up' ? lock.alreadyPaid : null,
        notes: b.notes || null,
        status: b.status,
        paid,
        cancelled: lock.reason === 'cancelled',
        // The customer picked "pay your driver" — in this channel or the other
        // one. The page shows that plainly rather than a card form.
        cashChosen: lock.reason === 'cash_chosen',
        lockReason: lock.reason,
        lockMessage: lock.message,
        payable: lock.payable
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
             passenger_name, passenger_phone, passenger_email,
             fare_adjust_kind, fare_adjust_amount, fare_adjust_paid,
             fare_adjust_at, fare_adjust_method, fare_adjust_settled_at
        FROM bookings WHERE ref = ?
    `).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).json({ error: 'Payment link not found or has expired' });
    }
    // DOUBLE-PAYMENT GATE. Checked against the LIVE row at the moment of
    // payment, not at page load — the customer may have opened this form and
    // then paid (or chosen cash) in My Account before pressing Pay here.
    // Includes the cash case: once "pay your driver" is chosen in EITHER
    // channel, a card charge for the same journey is refused.
    const { paymentLock } = require('./pay-lock');
    const lock = paymentLock(b);
    if (lock.locked) return res.status(409).json({ error: lock.message, reason: lock.reason });
    if (!lock.payable) return res.status(409).json({ error: lock.message || 'No fare is set for this booking yet', reason: lock.reason });

    // CHARGE THE AMOUNT THE LOCK SAYS, NEVER THE FARE. On a normal booking they
    // are the same number. On a re-priced prepaid booking `amountDue` is the
    // DIFFERENCE, and reading b.fare here would take the whole new fare from a
    // customer who has already paid most of it.
    const isTopUp = lock.reason === 'top_up';
    const amount = Math.round(Number(lock.amountDue) * 100);
    if (!isFinite(amount) || amount <= 0) {
      return res.status(409).json({ error: 'There is nothing to pay on this booking.', reason: 'no_fare' });
    }
    const adjustKey = isTopUp ? lock.adjustKey : null;

    // STRIPE IS ALSO ASKED. The DB gate above cannot see a payment that has
    // succeeded at Stripe but whose webhook has not landed yet — a delay of
    // seconds, and precisely long enough for the customer to try the other
    // channel. If Stripe already has a successful charge, the journey is paid
    // whatever our row still says.
    //
    // A TOP-UP asks a DIFFERENT question. A re-priced booking always has one
    // succeeded intent already — the original fare — so "has this ref been
    // paid?" would refuse every balance payment. The right question is whether
    // THIS difference has been paid, which is what the adjustment key answers.
    try {
      if (isTopUp) {
        const done = await findIntentByAdjustKey(adjustKey, 'succeeded');
        if (done) {
          console.warn('[PAY] top-up refused — Stripe already has a succeeded balance payment', done.id, 'for', b.ref);
          return res.status(409).json({ error: 'The balance on this trip has already been paid.', reason: 'paid' });
        }
      } else {
        const settledId = await findPaymentIntentByRef(b.ref);
        if (settledId) {
          console.warn('[PAY] intent refused — Stripe already has a succeeded payment', settledId, 'for', b.ref);
          return res.status(409).json({ error: 'This trip has already been paid.', reason: 'paid' });
        }
      }
    } catch (e) { console.error('[PAY] settled-intent lookup failed:', e.message); }

    // REUSE an open PaymentIntent rather than minting a rival. Two channels open
    // side by side would otherwise each get their own intent, and two live
    // intents for one journey is the one window where both can legitimately be
    // completed. One intent per booking (per difference) closes it.
    let intent = null;
    try {
      const open = isTopUp
        ? await findIntentByAdjustKey(adjustKey, 'open')
        : await findOpenPaymentIntentByRef(b.ref);
      if (open && open.amount === amount && open.client_secret) {
        intent = open;
        console.log('[PAY] reusing open intent', open.id, 'for', b.ref);
      }
    } catch (e) { console.error('[PAY] open-intent lookup failed (minting a new one):', e.message); }

    if (!intent) {
      intent = await createPaymentIntent({
        amount,
        currency: 'gbp',
        booking: { ref: b.ref, from: b.pickup, to: b.destination, date: b.date, time: b.time },
        customer: { name: b.passenger_name, email: b.passenger_email, phone: b.passenger_phone },
        extraMetadata: isTopUp ? { topup: '1', adjust_key: adjustKey } : null
      });
    }

    // The customer has CHOSEN card and is now entering their details: move a
    // pending/offered estimate to AWAITING_PAYMENT so the owner sees the ride is
    // going ahead. It only becomes 'confirmed' when Stripe confirms the charge
    // (payment_intent.succeeded webhook). Never touch a cancelled/settled row.
    try {
      db.prepare(`UPDATE bookings
                     SET status = CASE WHEN status IN ('pending','offered') THEN 'awaiting_payment' ELSE status END,
                         updated_at = datetime('now')
                   WHERE ref = ?`).run(ref);
      if (b.status === 'pending' || b.status === 'offered') {
        events.broadcast('booking:updated', { ref, status: 'awaiting_payment', reason: 'Customer chose to pay by card' });
      }
    } catch (e) { console.error('[PAY] intent awaiting_payment transition failed:', e.message); }

    res.json({ ok: true, clientSecret: intent.client_secret, amount });
  } catch (err) {
    console.error('[PAY] intent error:', err.message);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// ── Pay on the day: customer opts to settle with the driver ──────────────
// The "Pay on the day" button in the confirmation email points here. Gated by
// the same per-booking pay_token. Marks the booking payment = 'cash', notifies
// ── Accept estimate — customer clicks "Accept This Quote" in email ──────
router.get('/accept-estimate/:ref', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!ref || !email) {
      return res.status(400).send(cashPage('error', 'This link is incomplete.'));
    }

    const b = db.prepare(`SELECT id, ref, status, passenger_email FROM bookings WHERE ref = ?`).get(ref);
    if (!b || (b.passenger_email || '').toLowerCase() !== email) {
      return res.status(404).send(cashPage('error', "We couldn't find this booking."));
    }

    if (b.status === 'confirmed') {
      return res.send(cashPage('ok', 'This booking is already confirmed. We look forward to welcoming you.', b.ref));
    }

    // Mark as offered (accepted by customer, awaiting owner confirmation)
    db.prepare("UPDATE bookings SET status = 'offered', updated_at = datetime('now') WHERE id = ?").run(b.id);

    // Notify owner via SSE
    const events = require('./events');
    events.broadcast('estimate:accepted', { id: b.id, ref: b.ref, message: 'Customer accepted the estimate' });

    // Send admin alert
    const { sendEmail } = require('./email');
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
    if (adminEmail) {
      sendEmail(adminEmail, 'Estimate accepted — ' + ref, '<p>The customer has accepted the estimate for <strong>' + ref + '</strong>. Please confirm the booking in the owner app.</p>', 'Westmere Bookings').catch(() => {});
    }

    return res.send(cashPage('ok', 'Thank you — your quote has been accepted! We will confirm your booking shortly and send you a payment link.', b.ref));
  } catch (err) {
    console.error('[ACCEPT] error:', err.message);
    res.status(500).send(cashPage('error', 'Something went wrong. Please call us on 07930 342593.'));
  }
});

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
    // Choosing "pay your driver" is the customer's explicit method choice, and
    // it is the SAME act however they reach it — this tokenised link, or the
    // button in My Account. Both go through applyCashChoice (server/pay-lock.js)
    // so they cannot drift apart, and so choosing cash in either one locks
    // card payment in the other.
    //
    // Records 'cash' (validated — never a silent default) and transitions
    // pending/offered → AWAITING_PAYMENT on the edge: the ride is going ahead
    // (so it shows in the schedule/driver view) but it is NOT yet settled. It
    // becomes 'confirmed' only when the cash is received and the owner/driver
    // marks it paid (POST /bookings/:id/mark-paid). We deliberately do NOT
    // auto-confirm cash here — see CLAUDE.md invariant #3.
    const { applyCashChoice } = require('./pay-lock');
    const outcome = applyCashChoice(db, b.id, { source: 'email link', ip: req.ip });
    if (!outcome.ok) {
      return res.send(cashPage(outcome.reason === 'paid' ? 'paid' : 'error', outcome.message, b.ref));
    }
    const wasChosen = outcome.wasChosen;

    // Notify the owner in real time so the job drops into the schedule as
    // "awaiting payment" and connected staff apps refresh.
    try {
      events.broadcast('booking:payment', { id: b.id, ref: b.ref, mode: 'cash', fare: b.fare || null });
    } catch (_) {}
    if (wasChosen) {
      try { events.broadcast('booking:updated', { id: b.id, ref: b.ref, status: 'awaiting_payment', reason: 'Customer chose to pay driver on the day' }); } catch (_) {}
      // The customer has just CHOSEN cash → send the booking-confirmed email now
      // (payment='cash', not paid). notifyCustomerConfirmed renders the CASH
      // variant: "booking confirmed, pay your driver in cash on the day" —
      // deliberately NOT a "paid" receipt (nothing has been collected yet).
      try {
        require('./intake').notifyCustomerConfirmed(b.id)
          .catch(e => console.error('[PAY] notifyCustomerConfirmed (cash choice) failed:', e.message));
      } catch (e) { console.error('[PAY] notifyCustomerConfirmed (cash) threw:', e.message); }
    }

    console.log('[PAY] Cash on the day chosen for', b.ref, wasChosen ? '(pending→awaiting_payment, cash confirmation sent)' : '');
    res.send(cashPage('ok', "You're all set — please settle the fare with your driver on the day, by cash or card. We look forward to welcoming you.", b.ref));
  } catch (err) {
    console.error('[PAY] cash error:', err.message);
    res.status(500).send(cashPage('error', 'Something went wrong. Please call us on 07930 342593 and we will sort it out.'));
  }
});

// ── Generic branded action page (cancel confirm / note form / thank-you) ──
// Same visual shell as cashPage. `bodyHtml` is injected into the card body so
// each route can supply its own confirm button or form.
function actionPage(heading, message, ref, bodyHtml, state) {
  const isErr = state === 'error';
  const okIcon   = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6L9 17l-5-5"/></svg>';
  const infoIcon = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
  const icoCls = (isErr || state === 'form' || state === 'confirm') ? 'info' : 'ok';
  const ico = (isErr || state === 'form' || state === 'confirm') ? infoIcon : okIcon;
  const refLine = ref ? `<p style="margin-top:12px" class="muted-ref">Ref: ${String(ref).replace(/[<>&"]/g, '')}</p>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<meta name="theme-color" content="#111D2C"><meta name="robots" content="noindex,nofollow">
<title>Your journey | Westmere Private Hire</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#102a43;--text:#102a43;--muted:#657485;--border:#dfe5ea;--serif:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;--sans:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif}
html{font-size:16px}
body{font-family:var(--sans);font-weight:400;color:var(--text);background:#EEF2F5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:440px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid var(--border)}
.head{background:transparent;color:var(--navy);padding:30px 32px 26px;text-align:center;border-bottom:1px solid var(--border)}
.brand{font-family:var(--sans);font-size:11px;letter-spacing:3.5px;text-transform:uppercase;color:var(--muted);font-weight:600}
.brand-name{font-family:var(--serif);font-size:26px;font-weight:400;letter-spacing:.5px;margin-top:6px}
.body{padding:34px 32px 36px}
.state{text-align:center}
.ico{width:60px;height:60px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
.ico.ok{background:rgba(16,42,67,.08);color:var(--navy)}
.ico.info{background:rgba(28,42,62,.08);color:var(--navy)}
.state h2{font-family:var(--serif);font-size:24px;font-weight:400;color:var(--navy);margin-bottom:10px}
.state p{font-size:14px;color:var(--muted);line-height:1.6}
.muted-ref{font-family:'Menlo','Consolas',monospace;font-size:12px;letter-spacing:.5px;color:var(--navy)}
a.link{color:var(--navy);text-decoration:none;border-bottom:1px solid rgba(16,42,67,.28)}
textarea{width:100%;margin-top:18px;padding:12px 14px;border:1px solid var(--border);border-radius:8px;font-family:var(--sans);font-size:14px;color:var(--text);resize:vertical;min-height:120px}
button.act{width:100%;margin-top:16px;padding:14px;border:none;border-radius:6px;font-family:var(--sans);font-size:13px;font-weight:500;letter-spacing:2px;text-transform:uppercase;cursor:pointer}
button.navy{background:var(--navy);color:#fff}
button.danger{background:#8B2222;color:#fff}
</style></head>
<body><div class="card">
  <div class="head"><div class="brand">Private Hire</div><div class="brand-name">Westmere</div></div>
  <div class="body"><div class="state">
    <div class="ico ${icoCls}">${ico}</div>
    <h2>${heading}</h2>
    <p>${message}</p>
    ${refLine}
    ${bodyHtml || ''}
    <p style="margin-top:16px;font-size:13px">Questions? Call us on <a class="link" href="tel:+447930342593">07930&nbsp;342593</a>.</p>
  </div></div>
</div></body></html>`;
}

// ── Cancel request — customer clicks "Cancel Request" in their email ──────
// GET shows a confirmation page (never cancels on prefetch); POST performs the
// cancel, alerts the owner, and broadcasts. Secured by the per-booking token.
router.get('/cancel/:ref', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) return res.status(400).send(actionPage('Link not available', 'This link is incomplete. Please use the link from your email.', null, '', 'error'));
    const b = db.prepare(`SELECT id, ref, status, pay_token FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(actionPage('Link not available', "We couldn't find this booking. The link may have expired.", null, '', 'error'));
    }
    if (b.status === 'cancelled') {
      return res.send(actionPage('Already cancelled', 'This request has already been cancelled. If this was a mistake, please call us and we will be glad to help.', b.ref, '', 'ok'));
    }
    /* WHAT THE CUSTOMER IS LOOKING AT DEPENDS ON WHERE THEY ARE.
       Before they have chosen how to pay, this is still a REQUEST and the
       honest question is whether the quote suits. Once the car is booked it is
       a TRIP, and calling it a request reads as though we never took it
       seriously. Same page, same POST, same token — only the words move.

       Anything unrecognised falls back to the request wording, which is the
       one that is true earliest and claims least.
       GUARDRAIL: server/tests/rider-reminder.test.js */
    const booked = ['confirmed', 'active', 'awaiting_payment'].indexOf(String(b.status || '')) !== -1;
    const heading = booked ? 'Cancel this trip?' : 'Cancel your request?';
    const blurb = booked
      ? "If your plans have changed, you can cancel this trip below. We'll be notified straight away — no charge applies."
      : "If the price or timing doesn't suit, you can cancel this request below. We'll be notified straight away — no charge applies.";
    const btn = booked ? 'Confirm — Cancel This Trip' : 'Confirm — Cancel Request';
    const formHtml = `<form method="POST"><button type="submit" class="act danger">${btn}</button></form>`;
    res.send(actionPage(heading, blurb, b.ref, formHtml, 'confirm'));
  } catch (err) {
    console.error('[CANCEL] page error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593 and we will sort it out.', null, '', 'error'));
  }
});

router.post('/cancel/:ref', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) return res.status(400).send(actionPage('Link not available', 'This link is incomplete.', null, '', 'error'));
    const b = db.prepare(`SELECT * FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(actionPage('Link not available', "We couldn't find this booking.", null, '', 'error'));
    }
    if (b.status !== 'cancelled') {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancellation_reason = CASE WHEN cancellation_reason IS NULL OR cancellation_reason = '' THEN 'Cancelled by customer from email' ELSE cancellation_reason END, updated_at = datetime('now') WHERE id = ?`).run(b.id);
      try {
        db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
          .run('public', 0, 'request_cancelled_by_customer', b.ref, req.ip);
      } catch (_) {}
      try { events.broadcast('booking:updated', { id: b.id, ref: b.ref, status: 'cancelled', prev_status: b.status, reason: 'Cancelled by customer' }); } catch (_) {}
      // Remove from the operator's shared calendar if it was synced.
      if (b.calendar_event_id) {
        try {
          require('./google-calendar').deleteEvent(b.calendar_event_id).then(ok => {
            if (ok) { try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(b.id); } catch (_) {} }
          }).catch(() => {});
        } catch (_) {}
      }
      // Alert the owner.
      const { sendOwnerCancelledRequest } = require('./email');
      sendOwnerCancelledRequest({
        ref: b.ref, name: b.passenger_name, email: b.passenger_email,
        pickup: b.pickup, destination: b.destination, date: b.date, time: b.time, fare: b.fare
      }).catch(e => console.error('[CANCEL] owner alert failed:', e.message));
    }
    res.send(actionPage('Request cancelled', "Your request has been cancelled and we've let the team know. If you'd like to rebook or change anything, just reply to your email or call us — we'd be glad to help.", b.ref, '', 'ok'));
  } catch (err) {
    console.error('[CANCEL] error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593 and we will sort it out.', null, '', 'error'));
  }
});

/* ── A DRIVER DECIDING AN OFFER FROM HIS EMAIL ────────────────────────────
   Exactly the shape of the customer cancel above, for exactly the same reason:
   GET only ever renders a page, POST does the thing. A driver's mail client
   prefetching every link in his inbox must not accept a 4am Gatwick run on his
   behalf, and a stray tap in a pocket must not decline one.

   Gated by the per-offer token, which is minted when the job is offered and
   destroyed the moment it is decided or reclaimed — so the link in a
   superseded email is already dead.

   The decision itself goes through offer-routes.acceptOffer/declineOffer, the
   same functions the driver app calls, so both channels write one way.
   GUARDRAIL: server/tests/dispatch-offer.test.js */
function offerFromToken(ref, token) {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(String(ref || '').trim().toUpperCase());
  if (!b || !b.offer_token || !token || b.offer_token !== token) return null;
  return b;
}

router.get('/offer/:ref/:action', (req, res) => {
  try {
    const action = String(req.params.action || '');
    if (['accept', 'decline'].indexOf(action) === -1) {
      return res.status(404).send(actionPage('Link not available', 'This link is not valid.', null, '', 'error'));
    }
    const token = String(req.query.t || req.query.token || '').trim();
    const b = offerFromToken(req.params.ref, token);
    if (!b) {
      return res.status(404).send(actionPage('Link not available',
        'This offer is no longer open. It may already have been decided, or passed to somebody else.', null, '', 'error'));
    }
    if (b.status !== 'offered') {
      return res.send(actionPage('Already decided',
        'This job is no longer waiting on you. Check the driver app for your current jobs.', b.ref, '', 'ok'));
    }
    /* An outside driver was quoted the FARE, not a figure after commission —
       so the confirm page must not now show him a different number. */
    const adhoc = !b.offered_to_driver_id && !!b.offered_to_email;
    const amount = adhoc
      ? ((b.fare === null || b.fare === undefined) ? null : Number(b.fare))
      : ((b.driver_pay === null || b.driver_pay === undefined) ? null : Number(b.driver_pay));
    const payStr = amount === null ? '' : ' — £' + amount.toFixed(2) + (adhoc ? ' for the job' : ' to you');
    const form = `<form method="POST"><button type="submit" class="act ${action === 'accept' ? 'navy' : 'danger'}">${
      action === 'accept' ? 'Confirm — Take This Job' : 'Confirm — Decline'}</button></form>`;
    res.send(action === 'accept'
      ? actionPage('Take this job?', 'Confirm below and the job is yours' + payStr + '. Please make sure the passengers and luggage suit your car.', b.ref, form, 'confirm')
      : actionPage('Decline this job?', 'Confirm below and it goes back to Westmere to offer elsewhere. No hard feelings.', b.ref, form, 'confirm'));
  } catch (err) {
    console.error('[OFFER] page error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593.', null, '', 'error'));
  }
});

router.post('/offer/:ref/:action', (req, res) => {
  try {
    const action = String(req.params.action || '');
    if (['accept', 'decline'].indexOf(action) === -1) {
      return res.status(404).send(actionPage('Link not available', 'This link is not valid.', null, '', 'error'));
    }
    const token = String(req.query.t || req.query.token || '').trim();
    const b = offerFromToken(req.params.ref, token);
    if (!b) {
      return res.status(404).send(actionPage('Link not available',
        'This offer is no longer open.', null, '', 'error'));
    }
    const offers = require('./offer-routes');
    /* An AD-HOC offer has no driver id. Calling acceptOffer with null on both
       sides would pass its `!==` guard by accident and assign the job to
       driver_id NULL — which reads everywhere as unassigned. The two kinds get
       the two functions written for them. */
    const adhoc = !b.offered_to_driver_id && !!b.offered_to_email;
    const out = action === 'accept'
      ? (adhoc ? offers.acceptAdhocOffer(getDb(), b.id)
               : offers.acceptOffer(getDb(), b.id, b.offered_to_driver_id))
      : (adhoc ? offers.declineAdhocOffer(getDb(), b.id, 'Declined from the offer email')
               : offers.declineOffer(getDb(), b.id, b.offered_to_driver_id, 'Declined from the offer email'));
    if (!out.ok) {
      return res.send(actionPage('Already decided',
        'This job is no longer waiting on you.', b.ref, '', 'ok'));
    }
    try {
      getDb().prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run('driver', b.offered_to_driver_id || 0, 'offer_' + action + '_by_email', b.ref, req.ip);
    } catch (_) {}
    res.send(action === 'accept'
      ? actionPage('The job is yours', 'Westmere has been told. It is in your driver app now, with the full details and the navigation.', b.ref, '', 'ok')
      : actionPage('Declined', 'Thank you for letting us know quickly — that is genuinely useful. We will offer it elsewhere.', b.ref, '', 'ok'));
  } catch (err) {
    console.error('[OFFER] decide error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593.', null, '', 'error'));
  }
});

// ── Add a note / special requirement — customer link from their email ─────
// GET shows a note form; POST saves it to customer_note and alerts the owner.
router.get('/note/:ref', (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    if (!ref || !token) return res.status(400).send(actionPage('Link not available', 'This link is incomplete. Please use the link from your email.', null, '', 'error'));
    const b = db.prepare(`SELECT id, ref, status, pay_token, customer_note FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(actionPage('Link not available', "We couldn't find this booking. The link may have expired.", null, '', 'error'));
    }
    const existing = b.customer_note ? String(b.customer_note).replace(/[<>&"]/g, '') : '';
    const formHtml = `<form method="POST">
      <textarea name="note" maxlength="1000" placeholder="e.g. child seat needed, extra luggage, meet &amp; greet at arrivals…">${existing}</textarea>
      <button type="submit" class="act navy">Send Note to Westmere</button>
    </form>`;
    res.send(actionPage('Add a note', 'Let us know about any special requirements for your journey — a child seat, extra luggage, a meet &amp; greet, or anything else. This is not a cancellation.', b.ref, formHtml, 'form'));
  } catch (err) {
    console.error('[NOTE] page error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593 and we will sort it out.', null, '', 'error'));
  }
});

router.post('/note/:ref', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const db = getDb();
    const ref = String(req.params.ref || '').trim().toUpperCase();
    const token = String(req.query.t || req.query.token || '').trim();
    const note = String((req.body && req.body.note) || '').trim().slice(0, 1000);
    if (!ref || !token) return res.status(400).send(actionPage('Link not available', 'This link is incomplete.', null, '', 'error'));
    const b = db.prepare(`SELECT * FROM bookings WHERE ref = ?`).get(ref);
    if (!b || !b.pay_token || b.pay_token !== token) {
      return res.status(404).send(actionPage('Link not available', "We couldn't find this booking.", null, '', 'error'));
    }
    if (!note) {
      return res.send(actionPage('Nothing to send', 'The note was empty, so we haven’t recorded anything. You can go back and add your requirements any time.', b.ref, '', 'ok'));
    }
    db.prepare(`UPDATE bookings SET customer_note = ?, updated_at = datetime('now') WHERE id = ?`).run(note, b.id);
    try {
      db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
        .run('public', 0, 'customer_note_added', b.ref, req.ip);
    } catch (_) {}
    try { events.broadcast('booking:updated', { id: b.id, ref: b.ref, status: b.status, prev_status: b.status, reason: 'Customer note added' }); } catch (_) {}
    const { sendOwnerCustomerNote } = require('./email');
    sendOwnerCustomerNote({
      ref: b.ref, name: b.passenger_name, email: b.passenger_email,
      pickup: b.pickup, destination: b.destination, date: b.date, time: b.time
    }, note).catch(e => console.error('[NOTE] owner alert failed:', e.message));
    res.send(actionPage('Thank you', "Your note has been sent to your driver and saved to your booking. We'll make sure it's taken care of.", b.ref, '', 'ok'));
  } catch (err) {
    console.error('[NOTE] error:', err.message);
    res.status(500).send(actionPage('Something went wrong', 'Please call us on 07930 342593 and we will sort it out.', null, '', 'error'));
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
      const row = db.prepare(`SELECT id, status, fare, paid_amount, fare_adjust_kind, fare_adjust_amount,
                                     fare_adjust_at, fare_adjust_settled_at
                                FROM bookings WHERE ref = ?`).get(ref);
      if (!row) {
        console.error('[STRIPE] payment_intent.succeeded for unknown booking ref', ref);
      }

      // ── A BALANCE PAYMENT, NOT THE WHOLE FARE ──────────────────────────
      // The customer settled the DIFFERENCE after the owner re-priced a trip
      // they had already paid for. Handled separately because almost nothing
      // the normal branch does is right here: they were already paid and
      // already confirmed, so re-stamping paid_at would move the date of the
      // original payment, and re-firing the confirmation email would send them
      // a second copy of a booking they have had for weeks.
      //
      // The write is CONDITIONAL on the difference still being open, so a
      // webhook Stripe replays (it retries for days) adds the money once.
      const isTopUp = intent.metadata && intent.metadata.topup === '1';
      if (isTopUp && row) {
        const paidNow = intent.amount / 100;
        const info = db.prepare(`
          UPDATE bookings
             SET fare_adjust_settled_at = datetime('now'),
                 fare_adjust_method = 'stripe',
                 fare_adjust_ref = ?,
                 paid_amount = COALESCE(paid_amount, 0) + ?,
                 pay_token = NULL,
                 status = CASE WHEN status IN ('awaiting_payment','pending','offered') THEN 'confirmed' ELSE status END,
                 updated_at = datetime('now')
           WHERE ref = ?
             AND fare_adjust_kind = 'topup'
             AND fare_adjust_settled_at IS NULL
        `).run(intent.id, paidNow, ref);
        if (info.changes === 0) {
          console.warn('[STRIPE] top-up webhook replayed for', ref, '— difference was already closed, ignoring');
        } else {
          console.log('[STRIPE] Balance of £' + paidNow.toFixed(2) + ' settled for', ref);
          try {
            db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
              .run('stripe', 0, 'fare_topup_paid', ref + ' £' + paidNow.toFixed(2) + ' [' + intent.id + ']', null);
          } catch (_) {}
        }
        events.broadcast('booking:payment', { id: row.id, ref, mode: 'online', topUp: paidNow, fare: row.fare });
        events.broadcast('booking:updated', { id: row.id, ref, reason: 'Balance paid online' });
        return res.json({ received: true });
      }

      if (row && row.fare && Math.round(row.fare * 100) !== intent.amount) {
        console.error('[STRIPE] Amount mismatch for', ref, '- expected', Math.round(row.fare * 100), 'got', intent.amount);
      }
      // Mark paid online. Stamp paid_at and clear pay_token so the "Pay Now"
      // link can't be reused. Keep status confirmed (cancelled stays cancelled).
      // paid_amount records what was ACTUALLY taken — without it, a later fare
      // edit would have nothing to compute a refund or a balance against.
      db.prepare(`UPDATE bookings
                     SET payment = 'card',
                         paid_at = COALESCE(paid_at, datetime('now')),
                         paid_amount = COALESCE(paid_amount, ?),
                         payment_intent_id = COALESCE(payment_intent_id, ?),
                         pay_token = NULL,
                         status = CASE WHEN status = 'cancelled' THEN status ELSE 'confirmed' END,
                         updated_at = datetime('now')
                   WHERE ref = ?`).run(intent.amount / 100, intent.id, ref);
      console.log('[STRIPE] Payment confirmed for', ref);
      // Tell the owner the customer paid online (amount in pounds for the toast).
      events.broadcast('booking:payment', {
        id: row?.id, ref, mode: 'online',
        fare: row && row.fare != null ? row.fare : (intent.amount ? intent.amount / 100 : null)
      });
      // Fire customer "Booking confirmed" on the (pending | awaiting_payment) →
      // confirmed edge. A card payment may have already moved the booking to
      // awaiting_payment when the customer opened the card form, so we confirm
      // from either unsettled state.
      if (row && (row.status === 'pending' || row.status === 'awaiting_payment')) {
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

// ── GET /reviews — live Google Places rating + reviews ──────────────────────
// Server-side proxy so the API key is NEVER exposed to the browser. Reads the
// key from GOOGLE_PLACES_API_KEY (preferred) or GOOGLE_API_KEY (fallback).
// Resolves the Place ID from the business Google profile CID (Ce764VxFTR4VEAE)
// or, if that fails, via Find Place From Text on the business name. A fixed
// Place ID can be pinned with GOOGLE_PLACE_ID. On any failure it returns an
// empty reviews array (+ the Google status) so the homepage keeps its static
// review — it never fabricates data.
const GPLACE_CID = 'Ce764VxFTR4VEAE';          // g.page/r/Ce764VxFTR4VEAE
const REVIEWS_TTL_OK = 30 * 60 * 1000;         // cache good results 30 min
const REVIEWS_TTL_FAIL = 5 * 60 * 1000;        // cache failures 5 min (avoid hammering billing)
let REVIEWS_CACHE = { at: 0, ttl: 0, data: null };
let RESOLVED_PLACE_ID = process.env.GOOGLE_PLACE_ID || null;

// Env var names checked for the Places key, in priority order. GOOGLE_PLACES_API_KEY
// is the documented/preferred name; the rest are common aliases so an already-set
// key is picked up without renaming. (Deliberately excludes GOOGLE_CLIENT_ID/SECRET,
// which are Calendar OAuth creds, and MAPBOX_TOKEN.)
const REVIEWS_KEY_NAMES = [
  // A single Maps key works for Places too, once the Places API is enabled on it.
  'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_MAPS_API_KEY', 'MAPS_API_KEY', 'GOOGLE_KEY',
  // extra aliases (kept for robustness)
  'GOOGLE_PLACES_KEY', 'PLACES_API_KEY', 'GMAPS_API_KEY'
];
function reviewsKey() {
  for (const n of REVIEWS_KEY_NAMES) {
    if (process.env[n]) return { key: process.env[n], name: n };
  }
  return null;
}

// Resolve a Places place_id. Prefers a pinned GOOGLE_PLACE_ID, then the CID
// (Place Details accepts ?cid=), then Find Place From Text on the name.
async function resolvePlaceId(key) {
  if (RESOLVED_PLACE_ID) return RESOLVED_PLACE_ID;
  // (1) CID lookup — Place Details supports cid= and returns place_id.
  try {
    const u = `https://maps.googleapis.com/maps/api/place/details/json?cid=${encodeURIComponent(GPLACE_CID)}&fields=place_id&key=${key}`;
    const j = await (await fetch(u)).json();
    if (j.status === 'OK' && j.result && j.result.place_id) {
      RESOLVED_PLACE_ID = j.result.place_id;
      return RESOLVED_PLACE_ID;
    }
    // REQUEST_DENIED here means Places isn't enabled on the key — surface it.
    if (j.status === 'REQUEST_DENIED') { const e = new Error(j.error_message || 'REQUEST_DENIED'); e.googleStatus = j.status; e.googleMessage = j.error_message; throw e; }
  } catch (e) { if (e.googleStatus === 'REQUEST_DENIED') throw e; /* else fall through to find-place */ }
  // (2) Find Place From Text on the business name + locality.
  const q = encodeURIComponent('Westmere Private Hire, Lewes, UK');
  const u2 = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${key}`;
  const j2 = await (await fetch(u2)).json();
  if (j2.status === 'OK' && j2.candidates && j2.candidates.length) {
    RESOLVED_PLACE_ID = j2.candidates[0].place_id;
    return RESOLVED_PLACE_ID;
  }
  const err = new Error(j2.error_message || j2.status || 'PLACE_LOOKUP_FAILED');
  err.googleStatus = j2.status; err.googleMessage = j2.error_message;
  throw err;
}

router.get('/reviews', async (req, res) => {
  const found = reviewsKey();
  if (!found) {
    // Report (name only, never a value) which env names were checked so the
    // user can fix the Railway variable name.
    return res.json({ configured: false, live: false, reason: 'no_key', checked: REVIEWS_KEY_NAMES, reviews: [] });
  }
  const apiKey = found.key;

  const refresh = req.query.refresh === '1';
  if (!refresh && REVIEWS_CACHE.data && (Date.now() - REVIEWS_CACHE.at) < REVIEWS_CACHE.ttl) {
    return res.json(REVIEWS_CACHE.data);
  }

  function cacheFail(payload) { REVIEWS_CACHE = { at: Date.now(), ttl: REVIEWS_TTL_FAIL, data: payload }; return res.json(payload); }

  try {
    let placeId;
    try {
      placeId = await resolvePlaceId(apiKey);
    } catch (e) {
      return cacheFail({ configured: true, live: false, key_source: found.name, reason: e.googleStatus || 'PLACE_LOOKUP_FAILED', message: e.googleMessage || e.message, reviews: [] });
    }

    const fields = 'rating,user_ratings_total,reviews,name,url';
    const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&reviews_sort=newest&key=${apiKey}`;
    const j = await (await fetch(u)).json();
    if (j.status !== 'OK') {
      return cacheFail({ configured: true, live: false, key_source: found.name, place_id: placeId, reason: j.status, message: j.error_message || null, reviews: [] });
    }
    const d = j.result || {};
    const reviews = (d.reviews || []).slice(0, 5).map(rv => ({
      author_name: rv.author_name,
      rating: rv.rating,
      text: rv.text,
      relative_time: rv.relative_time_description,
      time: rv.time,
      profile_photo_url: rv.profile_photo_url
    }));
    const payload = {
      configured: true, live: true, key_source: found.name, place_id: placeId,
      name: d.name || null,
      rating: d.rating || null,
      total: d.user_ratings_total || 0,
      url: d.url || null,
      reviews
    };
    REVIEWS_CACHE = { at: Date.now(), ttl: REVIEWS_TTL_OK, data: payload };
    res.json(payload);
  } catch (e) {
    console.error('[REVIEWS] error:', e.message);
    return cacheFail({ configured: true, live: false, reason: 'server_error', message: e.message, reviews: [] });
  }
});

module.exports = router;
