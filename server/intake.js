// ── Smart Intake Engine ──────────────────────────────────────────────────
// Claude-driven feasibility checker for incoming bookings.
//
// Flow:
//   1. New booking arrives via /api/public/book
//   2. evaluate(bookingId) is called in the background
//   3. Pulls same-day bookings + time-off windows + standard fare/drive-time table
//   4. Asks Claude: can the operator make this trip?
//   5. If yes  → marks booking confirmed
//      If no   → flags needs_reassignment so the operator can pick another driver
//
// Graceful no-op if ANTHROPIC_API_KEY is not set: bookings still land,
// they just stay in their default 'pending' state with no Claude annotation.
//
// Env vars:
//   ANTHROPIC_API_KEY  — required to enable evaluation
//   INTAKE_MODEL       — optional, defaults to claude-haiku-4-5-20251001
//                        (cheap + fast; use claude-sonnet-4-6 for higher accuracy)

const { getDb } = require('./db');
const { sendCustomerConfirmed } = require('./email');
const { sendCustomerBookingConfirmedWhatsApp } = require('./whatsapp');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = process.env.INTAKE_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';

function isConfigured() {
  return !!API_KEY;
}

// ── Reference data the model uses ────────────────────────────────────────
// Indicative airport / city fares, used by Claude to sanity-check pricing
// and (more importantly) infer typical drive-time for feasibility.
//
// Each route includes a "drive_min" — a realistic door-to-door minutes value
// the model should use when computing whether two jobs can be back-to-back.
const REFERENCE_ROUTES = [
  // Brighton
  { from: 'Brighton', to: 'Gatwick',   fare_out: 72,  fare_ret: 68,  drive_min: 50 },
  { from: 'Brighton', to: 'Heathrow',  fare_out: 128, fare_ret: 133, drive_min: 110 },
  { from: 'Brighton', to: 'Stansted',  fare_out: 215, fare_ret: 220, drive_min: 150 },
  { from: 'Brighton', to: 'Luton',     fare_out: 205, fare_ret: 210, drive_min: 140 },
  { from: 'Brighton', to: 'Southampton', fare_out: 152, fare_ret: 147, drive_min: 90 },
  { from: 'Brighton', to: 'City',      fare_out: 166, fare_ret: 171, drive_min: 130 },
  // Lewes
  { from: 'Lewes',    to: 'Gatwick',   fare_out: 78,  fare_ret: 74,  drive_min: 55 },
  { from: 'Lewes',    to: 'Heathrow',  fare_out: 140, fare_ret: 145, drive_min: 115 },
  // Horsham
  { from: 'Horsham',  to: 'Gatwick',   fare_out: 55,  fare_ret: 50,  drive_min: 30 },
  { from: 'Horsham',  to: 'Heathrow',  fare_out: 120, fare_ret: 125, drive_min: 75 },
  // Crawley
  { from: 'Crawley',  to: 'Gatwick',   fare_out: 35,  fare_ret: 32,  drive_min: 20 },
  { from: 'Crawley',  to: 'Heathrow',  fare_out: 95,  fare_ret: 100, drive_min: 70 },
  // Worthing
  { from: 'Worthing', to: 'Gatwick',   fare_out: 72,  fare_ret: 68,  drive_min: 60 },
  { from: 'Worthing', to: 'Heathrow',  fare_out: 130, fare_ret: 135, drive_min: 100 },
  // Haywards Heath
  { from: 'Haywards Heath', to: 'Gatwick', fare_out: 52, fare_ret: 48, drive_min: 35 },
];

// Buffer in minutes between back-to-back jobs (turnaround / contingency)
const TURNAROUND_MIN = 90;

// ── Helpers ──────────────────────────────────────────────────────────────
function loadDayContext(dateStr, excludeBookingId) {
  const db = getDb();
  const bookings = db.prepare(`
    SELECT b.id, b.ref, b.pickup, b.destination, b.date, b.time, b.status,
           b.driver_id, c.full_name as customer_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.date = ?
       AND b.id != ?
       AND b.status IN ('pending','confirmed','active')
     ORDER BY b.time ASC
  `).all(dateStr, excludeBookingId || 0);

  const timeOff = db.prepare(`
    SELECT id, driver_id, date, end_date, start_time, end_time, reason
      FROM time_off
     WHERE date <= ?
       AND (end_date IS NULL OR end_date >= ?)
  `).all(dateStr, dateStr);

  return { bookings, timeOff };
}

function buildSystemPrompt() {
  return [
    'You are the intake controller for Westmere Private Hire, a luxury chauffeur service in Sussex, UK.',
    'Your job: decide whether the operator (a single driver fleet) can realistically take a newly requested booking,',
    'given their other confirmed jobs that day and any blocked time-off windows.',
    '',
    'Rules:',
    '- All times are local UK time on the date provided.',
    '- Two jobs are feasible back-to-back only if the previous job\'s estimated drop-off time + a ' + TURNAROUND_MIN + '-minute buffer is at or before the new pickup time.',
    '- You must also leave the same buffer to reach the new pickup location after the previous drop-off.',
    '- Treat any booking whose `time` field is "ASAP" as flexible (assume it can fit).',
    '- A time-off window blocks all jobs within it; if no time is given on the time-off, treat the whole day as blocked.',
    '- If you don\'t know the drive time for a route, estimate conservatively from the reference table.',
    '- Never invent jobs or constraints that were not given.',
    '',
    'Reference routes & approximate drive times (minutes):',
    JSON.stringify(REFERENCE_ROUTES),
    '',
    'Respond with STRICT JSON only — no prose, no markdown fences. Schema:',
    '{ "feasible": boolean,',
    '  "reason": "one short sentence the operator will read",',
    '  "conflicting_booking_id": number | null,',
    '  "suggested_action": "auto_confirm" | "needs_reassignment" }'
  ].join('\n');
}

function buildUserPrompt(newBooking, ctx) {
  return JSON.stringify({
    new_booking: {
      id: newBooking.id,
      ref: newBooking.ref,
      pickup: newBooking.pickup,
      destination: newBooking.destination,
      date: newBooking.date,
      time: newBooking.time,
      passengers: newBooking.passengers,
      flight: newBooking.flight || null
    },
    same_day_bookings: ctx.bookings.map(b => ({
      id: b.id, ref: b.ref,
      pickup: b.pickup, destination: b.destination,
      time: b.time, status: b.status
    })),
    time_off_windows: ctx.timeOff.map(t => ({
      date: t.date, end_date: t.end_date,
      start_time: t.start_time, end_time: t.end_time,
      reason: t.reason
    }))
  });
}

async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    throw new Error('Claude API: ' + msg);
  }
  // Extract first text block
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  return text;
}

function parseDecision(raw) {
  if (!raw) return null;
  // Strip any accidental code fences
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const j = JSON.parse(s);
    return {
      feasible: !!j.feasible,
      reason: String(j.reason || '').slice(0, 280),
      conflictingBookingId: j.conflicting_booking_id || null,
      suggestedAction: j.suggested_action || (j.feasible ? 'auto_confirm' : 'needs_reassignment')
    };
  } catch (e) {
    return null;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────
async function evaluate(bookingId) {
  if (!bookingId) return { ok: false, reason: 'no_booking_id' };
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return { ok: false, reason: 'booking_not_found' };

  if (!isConfigured()) {
    // No API key — graceful no-op. Booking stays in pending.
    return { ok: true, skipped: 'no_api_key' };
  }

  try {
    const ctx = loadDayContext(booking.date, booking.id);
    const sys = buildSystemPrompt();
    const usr = buildUserPrompt(booking, ctx);
    const raw = await callClaude(sys, usr);
    const decision = parseDecision(raw);

    if (!decision) {
      console.error('[INTAKE] Could not parse Claude response:', raw && raw.slice(0, 200));
      db.prepare(`UPDATE bookings
                     SET intake_reason = ?, intake_checked_at = datetime('now'), updated_at = datetime('now')
                   WHERE id = ?`)
        .run('Intake check inconclusive — left for manual review.', bookingId);
      return { ok: false, reason: 'parse_failed' };
    }

    if (decision.feasible) {
      // Auto-confirm
      db.prepare(`UPDATE bookings
                     SET status = 'confirmed',
                         needs_reassignment = 0,
                         intake_reason = ?,
                         intake_checked_at = datetime('now'),
                         updated_at = datetime('now')
                   WHERE id = ?`)
        .run(decision.reason || 'Auto-confirmed by smart intake.', bookingId);
      console.log('[INTAKE] Auto-confirmed booking', booking.ref, '—', decision.reason);
      // Tell the customer their booking is now confirmed (email + WhatsApp).
      notifyCustomerConfirmed(bookingId).catch(e =>
        console.error('[INTAKE] notifyCustomerConfirmed failed:', e.message));
    } else {
      // Flag for the operator to reassign / decline
      db.prepare(`UPDATE bookings
                     SET needs_reassignment = 1,
                         intake_reason = ?,
                         intake_checked_at = datetime('now'),
                         updated_at = datetime('now')
                   WHERE id = ?`)
        .run(decision.reason || 'Cannot fit alongside existing jobs.', bookingId);
      console.log('[INTAKE] Flagged booking', booking.ref, 'for reassignment —', decision.reason);
    }

    return { ok: true, decision };
  } catch (e) {
    console.error('[INTAKE] evaluate failed:', e.message);
    try {
      db.prepare(`UPDATE bookings
                     SET intake_reason = ?, intake_checked_at = datetime('now'), updated_at = datetime('now')
                   WHERE id = ?`)
        .run('Intake check failed: ' + e.message, bookingId);
    } catch (_) {}
    return { ok: false, reason: e.message };
  }
}

// ── Notify the customer that their booking has been confirmed ────────────
// Pulls booking + linked customer (or falls back to notes/phone) and fires
// email + WhatsApp confirmation. Idempotent at the call-site level — callers
// should only invoke this on a transition from unconfirmed to confirmed.
async function notifyCustomerConfirmed(bookingId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT b.*, c.email AS cust_email, c.full_name AS cust_name, c.phone AS cust_phone
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.id = ?
  `).get(bookingId);
  if (!row) return;

  const payload = {
    ref: row.ref,
    name: row.cust_name || row.notes || 'Guest',
    email: row.cust_email || null,
    phone: row.cust_phone || null,
    pickup: row.pickup,
    destination: row.destination,
    date: row.date,
    time: row.time,
    fare: row.fare,
    payment: row.payment,
    flight: row.flight,
    passengers: row.passengers
  };

  await Promise.allSettled([
    payload.email ? sendCustomerConfirmed(payload) : Promise.resolve(),
    payload.phone ? sendCustomerBookingConfirmedWhatsApp(payload) : Promise.resolve()
  ]);
}

// ── Apology drafter (used when no driver can take the job) ───────────────
async function draftApology(bookingId) {
  if (!isConfigured()) {
    return {
      ok: true,
      skipped: 'no_api_key',
      subject: 'Regarding your booking with Westmere Private Hire',
      body: 'Dear guest,\n\nThank you for your booking enquiry. Unfortunately we are unable to fulfil this journey at the requested time. We apologise for the inconvenience.\n\nKind regards,\nWestmere Private Hire'
    };
  }
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return { ok: false, reason: 'booking_not_found' };

  const sys = 'You are the customer service voice of Westmere Private Hire — a polished, discreet luxury chauffeur firm in Sussex. Write a brief, sincere apology email declining a booking we cannot fulfil. Tone: warm but professional. No filler. Sign as "Westmere Private Hire". Respond with STRICT JSON: { "subject": "...", "body": "..." } — body in plain text with line breaks.';
  const usr = JSON.stringify({
    customer_name: booking.notes || 'Guest',
    pickup: booking.pickup, destination: booking.destination,
    date: booking.date, time: booking.time,
    reason_we_cannot_take_it: booking.intake_reason || 'No driver available for the requested time.'
  });

  try {
    const raw = await callClaude(sys, usr);
    const j = JSON.parse(raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    return { ok: true, subject: j.subject || 'Regarding your booking', body: j.body || '' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { isConfigured, evaluate, draftApology, notifyCustomerConfirmed };
