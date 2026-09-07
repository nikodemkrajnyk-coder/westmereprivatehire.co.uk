/**
 * WHAT BELONGS ON THE OWNER'S CALENDAR, AND HOW IT GETS THERE.
 *
 * ONE AUTHORITY. Four different paths create a booking and each hand-built its
 * own calendar payload, so an event's contents depended on which door the
 * booking came in through, and each path decided for itself whether to push at
 * all. That is why this file exists: every calendar decision in the system is
 * made here, once.
 *
 * ONLY REAL TRIPS. A booking reaches the calendar when it is CONFIRMED — when
 * the customer has paid, chosen to pay the driver, or the job has otherwise
 * been accepted — and not before. An enquiry is not a journey; a calendar full
 * of things that might happen cannot be read at a glance to see what is
 * happening. Confirmed, active and completed are on it; pending, offered,
 * awaiting_payment and rejected are not.
 *
 * NOBODY PRESSES ANYTHING. Every push to Google is fire-and-forget —
 * createEvent returns null on any failure and the .catch() swallows it — so a
 * booking whose event never landed looks exactly like one whose event did. A
 * customer's job sat in the system for days with nothing on the calendar, and
 * reconnecting Google never brought it across: that re-authorises the account,
 * it pushes nothing. The first repair for that was a button on the job card,
 * which is a person remembering to press it — and the jobs that go missing are
 * precisely the ones nobody is looking at. So: syncBooking() at every moment a
 * booking changes, and a sweep behind it that catches whatever those missed.
 *
 * THE SWEEP SELECTS ON THE ABSENCE, NOT ON THE STAMP.
 * calendar_sync_failed_at records a miss; it does not define one. Two creation
 * paths never stamped it, so a sweep keyed on the flag would walk straight past
 * them. `calendar_event_id IS NULL` is the honest question: is this job on the
 * calendar or not.
 *
 * GUARDRAIL: server/tests/calendar-auto-sync.test.js
 */
'use strict';

const { getDb } = require('./db');
const gcal = require('./google-calendar');

/* A REAL TRIP, not an enquiry. `active` is a job under way and `completed` is
   one that happened — both are things that occupied his day, so both stay on
   the calendar. */
const CALENDAR_STATUSES = ['confirmed', 'active', 'completed'];

/* ── THE ONE THAT IS NOT SPELLED 'confirmed' ──────────────────────────────
   Choosing "pay your driver on the day" does NOT write status='confirmed'.
   applyCashChoice (server/pay-lock.js) moves the booking to AWAITING_PAYMENT —
   and the customer is sent the "Booking confirmed" email in the same breath.

   So a rule that reads the status string alone would leave every pay-on-the-day
   job off the calendar while its customer holds an email saying it is confirmed.
   That is the Mr Ben booking exactly, and it is the failure this whole piece of
   work exists to stop.

   The signal that separates the two kinds of awaiting_payment is the customer's
   own act: payment='cash' is written ONLY by their explicit choice (CLAUDE.md
   payment invariant #1), and pay-lock owns that question. An estimate that was
   sent and never answered keeps payment='pending' and stays off. */
const { isCashChosen } = require('./pay-lock');

function customerHasCommitted(b) {
  return String((b && b.status) || '') === 'awaiting_payment' && isCashChosen(b);
}

/* Frequent enough that a miss is measured in minutes, not days; the query is a
   single indexed read that matches nothing at all on a healthy system, and only
   rows with no event ever reach Google. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/* Let boot settle — migrations, and any token refresh — before the first pass. */
const BOOT_DELAY_MS = 20 * 1000;

let _timer = null;
let _running = false;      // a slow pass must not be re-entered by the next tick
let _quietSince = null;    // so a long disconnection logs once, not every 15 min

function isCancelled(b) {
  return String((b && b.status) || '') === 'cancelled';
}

/** Does this booking belong on the calendar at all? */
function belongsOnCalendar(b) {
  if (!b) return false;
  return CALENDAR_STATUSES.includes(String(b.status || '')) || customerHasCommitted(b);
}

/** The booking as the calendar wants it — one shape, whichever door it came in. */
function calendarPayload(b) {
  return {
    id: b.id, ref: b.ref,
    pickup: b.pickup, destination: b.destination, stop_address: b.stop_address,
    date: b.date, time: b.time || 'ASAP',
    passengers: b.passengers, bags: b.bags, flight: b.flight,
    fare: b.fare, payment: b.payment, notes: b.notes,
    customer_name: b.customer_name || b.passenger_name || '',
    customer_phone: b.customer_phone || b.passenger_phone || '',
    status: b.status
  };
}

/** Today in UK wall-clock — never toISOString(), which is still yesterday
    between midnight and 1am BST. */
function ukToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
}

/**
 * Bring one booking's calendar event into line with the booking.
 *
 *   confirmed and no event   → create it
 *   confirmed and has event  → update it
 *   cancelled and has event  → delete it
 *   not confirmed yet        → nothing; it is not a journey yet
 *
 * Idempotent, and safe to call from anywhere at any time. Never throws: it is
 * called from request paths that must not fail because Google is having a bad
 * afternoon. Returns what it did, for the guard and the logs.
 */
async function syncBooking(bookingId) {
  let b;
  try {
    b = getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  } catch (e) { return { action: 'error', reason: e.message }; }
  if (!b) return { action: 'none', reason: 'no-such-booking' };

  /* CANCELLED COMES OFF, whatever else is true. Deletion is deliberately the
     ONLY removal: a booking that merely is not confirmed keeps any event it
     already has, because silently deleting entries from a working calendar is
     not something a sync should decide to do on its own. */
  if (isCancelled(b)) {
    if (!b.calendar_event_id) return { action: 'none', reason: 'cancelled-no-event' };
    let ok = false;
    try { ok = await gcal.deleteEvent(b.calendar_event_id); } catch (_) {}
    if (ok) {
      try {
        getDb().prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(b.id);
      } catch (_) {}
      return { action: 'deleted', ref: b.ref };
    }
    return { action: 'delete-failed', ref: b.ref };
  }

  if (!belongsOnCalendar(b)) return { action: 'none', reason: 'not-confirmed', ref: b.ref };

  if (b.calendar_event_id) {
    try { await gcal.updateEvent(b.calendar_event_id, calendarPayload(b)); } catch (_) {}
    return { action: 'updated', ref: b.ref, eventId: b.calendar_event_id };
  }

  const status = gcal.getStatus();
  if (!status.configured || !status.connected) {
    /* Signed out is a connection problem, not a broken booking — see the sweep. */
    return { action: 'none', reason: 'not-connected', ref: b.ref };
  }

  let eventId = null;
  try {
    eventId = await gcal.createEvent(calendarPayload(b));
  } catch (e) {
    console.error('[GCAL] sync threw for', b.ref, '-', e.message);
  }
  if (eventId) {
    try {
      getDb().prepare("UPDATE bookings SET calendar_event_id = ?, calendar_sync_failed_at = NULL WHERE id = ?")
        .run(eventId, b.id);
    } catch (_) {}
    return { action: 'created', ref: b.ref, eventId };
  }
  /* Stamped so a miss is a fact on the row rather than a silence. Not shown to
     the owner as an action: the retry is the sweep, and it is already coming. */
  try {
    getDb().prepare("UPDATE bookings SET calendar_sync_failed_at = datetime('now') WHERE id = ?").run(b.id);
  } catch (_) {}
  return { action: 'failed', ref: b.ref };
}

/** Fire-and-forget wrapper for request paths that must not wait on Google. */
function syncBookingSoon(bookingId) {
  Promise.resolve().then(() => syncBooking(bookingId)).catch(() => {});
}

/**
 * One sweep. The net under every path above: any confirmed, upcoming job with
 * no event gets one, whether it was never pushed, pushed and refused, or
 * created before Google was connected. Never throws — this runs unattended.
 */
async function sweepMissingEvents() {
  if (_running) return { skipped: 'already-running', considered: 0, added: 0, failed: 0 };
  const status = gcal.getStatus();
  if (!status.configured || !status.connected) {
    /* SIGNED OUT IS NOT FAILED. There is nothing wrong with the bookings, and
       stamping a hundred of them would turn one problem the owner can fix into
       a hundred he cannot. He is told about the disconnection where he already
       looks for it — the Google line in the owner app. */
    const why = status.needsReconnect ? 'signed-out' : (status.configured ? 'not-connected' : 'not-configured');
    if (_quietSince !== why) {
      console.log('[GCAL] auto-sync paused — ' + why + '. Nothing is flagged; the owner app shows the reconnect prompt.');
      _quietSince = why;
    }
    return { skipped: why, considered: 0, added: 0, failed: 0 };
  }
  _quietSince = null;

  _running = true;
  let considered = 0, added = 0;
  const failed = [];
  try {
    const db = getDb();
    /* Upcoming only. A calendar back-filled with years of history is noise; the
       journeys that matter are the ones still to drive. */
    const placeholders = CALENDAR_STATUSES.map(() => '?').join(',');
    /* The same rule as belongsOnCalendar, asked of SQL: confirmed and beyond,
       plus the pay-on-the-day bookings that sit at awaiting_payment. Every row
       is re-checked by syncBooking, so this only has to be no WIDER than the
       rule — never narrower, or the sweep would walk past the very jobs it
       exists to catch. */
    const rows = db.prepare(`
      SELECT * FROM bookings
       WHERE calendar_event_id IS NULL
         AND ( status IN (${placeholders})
               OR (status = 'awaiting_payment' AND LOWER(COALESCE(payment,'')) = 'cash') )
         AND date >= ?
       ORDER BY date, time
    `).all(...CALENDAR_STATUSES, ukToday());
    considered = rows.length;

    for (const b of rows) {
      const r = await syncBooking(b.id);
      if (r.action === 'created') added++;
      else failed.push(b.ref);
    }
  } catch (e) {
    console.error('[GCAL] auto-sync pass failed:', e.message);
  } finally {
    _running = false;
  }

  if (considered) {
    console.log('[GCAL] auto-sync: ' + added + ' added, ' + failed.length + ' still missing of ' + considered);
  }
  return { considered, added, failed: failed.length, failedRefs: failed };
}

function startCalendarSweeper() {
  if (_timer) return;
  setTimeout(() => { sweepMissingEvents().catch(() => {}); }, BOOT_DELAY_MS);
  _timer = setInterval(() => { sweepMissingEvents().catch(() => {}); }, SWEEP_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log('[GCAL] Calendar auto-sync started (boot + every ' + (SWEEP_INTERVAL_MS / 60000) + ' min)');
}

function stopCalendarSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  syncBooking,
  syncBookingSoon,
  sweepMissingEvents,
  startCalendarSweeper,
  stopCalendarSweeper,
  belongsOnCalendar,
  customerHasCommitted,
  calendarPayload,
  CALENDAR_STATUSES,
  SWEEP_INTERVAL_MS
};
