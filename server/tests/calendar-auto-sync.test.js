/**
 * EVERY JOB REACHES THE CALENDAR WITHOUT ANYONE PRESSING ANYTHING — run with:
 *   node server/tests/calendar-auto-sync.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   Every calendar write in this system is fire-and-forget: createEvent returns
 *   null on any failure and the .catch() swallows it. A booking whose event
 *   never landed keeps a null calendar_event_id and looks exactly like one
 *   whose event did. A customer's job sat in the system for days with no event
 *   on the calendar, and reconnecting Google changed nothing — that
 *   re-authorises the account, it pushes nothing.
 *
 *   The first repair was a button on the job card. A button is a person
 *   remembering to press it, and the jobs that go missing are precisely the
 *   ones nobody is looking at. So the button is gone and a sweep replaces it.
 *
 * WHAT IS GUARDED
 *   1. The manual UI is GONE — no per-job button, no backfill link, no routes.
 *      A guard that only tested the sweep would pass with both still shipped.
 *   2. A booking with no event id gets one from the automatic sweep, and the
 *      failure stamp is cleared by that success.
 *   3. The sweep skips what it must (already synced, cancelled, past) so it
 *      never makes a second event or back-fills history.
 *   4. A refusal is stamped and RETRIED by the next pass, unattended.
 *   5. Signed out is not failed: with Google disconnected the sweep touches
 *      nothing and flags nothing, rather than marking every booking broken.
 *   All of it against a fake Google that can be told to fail or sign out.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-cal-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });

/* ── A GOOGLE THAT CAN BE TOLD TO FAIL ────────────────────────────────────
   createEvent is stubbed at the module, exactly as api.js reaches it, so the
   routes below run their real code against a calendar that succeeds, fails, or
   is not connected — the three states that matter and that nothing could
   reproduce before. */
const gcal = require('../google-calendar');
const GOOGLE = { connected: true, configured: true, needsReconnect: false, fail: false, created: [], deleted: [], updated: [] };
gcal.createEvent = async (b) => {
  if (GOOGLE.fail) return null;
  const id = 'evt_' + b.ref;
  GOOGLE.created.push({ id, ref: b.ref, summary: b.pickup + ' → ' + b.destination });
  return id;
};
gcal.deleteEvent = async (id) => { if (GOOGLE.fail) return false; GOOGLE.deleted.push(id); return true; };
gcal.updateEvent = async (id, b) => { GOOGLE.updated.push({ id, ref: b.ref }); return true; };
gcal.getStatus = () => ({ configured: GOOGLE.configured, connected: GOOGLE.connected,
                          needsReconnect: GOOGLE.needsReconnect, email: 'o@e.com', calendarId: 'primary' });

const api = require('../api');
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(method, routePath, opts) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  const req = Object.assign({ params: {}, query: {}, body: {}, ip: '::1',
                              auth: { role: 'owner', id: 1, type: 'user' } }, opts || {});
  const r = res();
  const hs = l.route.stack.map((x) => x.handle);
  let i = 0;
  const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
  await next();
  return r;
}
const ukToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
};
let seq = 0;
function seed(over) {
  const o = Object.assign({ pickup: 'Dorking', destination: 'Maidstone', date: plusDays(7),
                            time: '12:00', passengers: 1, fare: 95, payment: 'pending',
                            status: 'confirmed', event: null, failedAt: null }, over || {});
  const ref = 'WM-CAL' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
              calendar_event_id,calendar_sync_failed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, o.pickup, o.destination, o.date, o.time, o.passengers, o.fare, o.payment, o.status,
         o.event, o.failedAt);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

const sweeper = require('../calendar-sync');
const OWNER = fs.readFileSync(path.join(__dirname, '..', '..', 'westmere-owner.html'), 'utf8');

// ── 1. NO BUTTONS. ───────────────────────────────────────────────────────
console.log('\nNothing to press — the manual calendar UI is gone');

test('the per-job "Add to calendar" button is gone from the owner app', () => {
  /* The owner asked for the button to disappear, not to be hidden behind a
     condition — so this looks for the handler AND the label AND the wiring.
     Any one of them alone would let a half-removal through. */
  assert.ok(!/ownerAddToCalendar/.test(OWNER), 'ownerAddToCalendar is still in the owner app');
  assert.ok(!/Calendar failed/i.test(OWNER), 'the "Calendar failed — retry" state is still rendered');
  /* Bounded to the job card, because "add to calendar" also names two unrelated
     assistant actions — turning a flagged message into a booking, and creating a
     calendar-only entry. Those are not what the owner asked to remove, and a
     blanket search for the phrase would delete them by guard. */
  const cardStart = OWNER.indexOf('function jobCardHtml(j){');
  assert.ok(cardStart > -1, 'jobCardHtml is gone — this guard is anchored on nothing');
  const card = OWNER.slice(cardStart, OWNER.indexOf('\n}', cardStart));
  /* An ACTION, specifically. The card legitimately labels a personal-calendar
     entry, so the forbidden thing is something to click, not the word. */
  assert.ok(!/onclick\s*=\s*["'][^"']*calendar/i.test(card),
    'the job card still wires a calendar action — the owner asked for no button at all');
  assert.ok(!/<button[^>]*>[^<]*calendar/i.test(card),
    'the job card still renders a calendar button');
  assert.ok(!/calendar_sync_failed_at/.test(OWNER),
    'the owner app still reads the failure stamp — it is internal retry state now, not an action');
});

test('the "Put missing jobs on the calendar" link is gone too', () => {
  assert.ok(!/ownerCalendarBackfill/.test(OWNER), 'the backfill handler is still there');
  assert.ok(!/gcal-push-link/.test(OWNER), 'the backfill link element is still there');
  assert.ok(!/Put missing jobs/i.test(OWNER), 'the backfill label is still there');
});

test('but the sign-out warning stays — the one thing worth telling him', () => {
  /* The sweep cannot run while Google has signed him out, and that is the only
     calendar state a person can actually do anything about. */
  assert.ok(/signed you out/i.test(OWNER), 'the reconnect prompt has been removed with the buttons');
  assert.ok(/gcal-status/.test(OWNER), 'the Google status line has been removed');
});

test('and the manual endpoints no longer exist', () => {
  const has = (p) => api.stack.some((x) => x.route && x.route.path === p && x.route.methods.post);
  assert.ok(!has('/bookings/:id/calendar'), 'POST /bookings/:id/calendar is still mounted');
  assert.ok(!has('/calendar/backfill'), 'POST /calendar/backfill is still mounted');
});

// ── 2. THE SWEEP DOES THE WORK. ──────────────────────────────────────────
console.log('\nThe sweep puts missing jobs on the calendar by itself');

test('a booking with no event id gets one, unattended', () => {
  const b = seed({});
  assert.strictEqual(rowOf(b.id).calendar_event_id, null, 'seeded wrong');
  return sweeper.sweepMissingEvents().then((r) => {
    assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_' + b.ref,
      'the sweep left a job off the calendar');
    assert.ok(r.added >= 1, 'the sweep reported nothing added');
  });
});

test('a success clears an earlier failure stamp', async () => {
  const b = seed({ failedAt: '2026-01-01 00:00:00' });
  await sweeper.sweepMissingEvents();
  const row = rowOf(b.id);
  assert.ok(row.calendar_event_id, 'no event was created');
  assert.strictEqual(row.calendar_sync_failed_at, null,
    'the stamp survived a successful write, so the row still reads as broken');
});

test('a job already on the calendar is not given a second event', async () => {
  const b = seed({ event: 'evt_ALREADY' });
  const before = GOOGLE.created.length;
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_ALREADY', 'the event id was overwritten');
  assert.strictEqual(GOOGLE.created.length, before,
    'the sweep created a duplicate event for a job that already had one');
});

test('cancelled jobs and past jobs are left alone', async () => {
  const cancelled = seed({ status: 'cancelled' });
  const past = seed({ date: plusDays(-9) });
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(cancelled.id).calendar_event_id, null,
    'a cancelled job was put on the calendar');
  assert.strictEqual(rowOf(past.id).calendar_event_id, null,
    'the sweep back-filled history — the calendar is for the journeys still to drive');
});

test('a second pass finds nothing — it is idempotent', async () => {
  seed({});
  await sweeper.sweepMissingEvents();
  const r = await sweeper.sweepMissingEvents();
  assert.strictEqual(r.considered, 0,
    'the sweep re-considered jobs it had already synced (' + r.considered + ')');
});

// ── 3. FAILURE IS RETRIED, NOT ANNOUNCED. ────────────────────────────────
console.log('\nA refusal is stamped and picked up again by the next pass');

test('Google refusing stamps the booking and leaves it without an event', async () => {
  const b = seed({});
  GOOGLE.fail = true;
  const r = await sweeper.sweepMissingEvents();
  GOOGLE.fail = false;
  const row = rowOf(b.id);
  assert.strictEqual(row.calendar_event_id, null, 'an event id appeared from a failed write');
  assert.ok(row.calendar_sync_failed_at, 'the miss was swallowed — exactly the original bug');
  assert.ok(r.failed >= 1, 'the pass reported no failures');
});

test('and the NEXT pass fixes it with nobody pressing anything', async () => {
  const b = seed({});
  GOOGLE.fail = true;
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(b.id).calendar_event_id, null, 'seeded wrong');
  GOOGLE.fail = false;                       // Google comes back
  await sweeper.sweepMissingEvents();        // the timer's next tick
  const row = rowOf(b.id);
  assert.strictEqual(row.calendar_event_id, 'evt_' + b.ref,
    'a job that failed once was never retried — this is what the button used to be for');
  assert.strictEqual(row.calendar_sync_failed_at, null, 'the stamp was not cleared by the retry');
});

// ── 4. SIGNED OUT IS NOT FAILED. ─────────────────────────────────────────
console.log('\nA disconnected Google is a connection problem, not a hundred broken bookings');

test('with Google signed out the sweep flags nothing', async () => {
  const b = seed({});
  GOOGLE.connected = false; GOOGLE.needsReconnect = true;
  const r = await sweeper.sweepMissingEvents();
  GOOGLE.connected = true; GOOGLE.needsReconnect = false;
  const row = rowOf(b.id);
  assert.strictEqual(r.skipped, 'signed-out', 'the sweep ran anyway: ' + JSON.stringify(r));
  assert.strictEqual(row.calendar_sync_failed_at, null,
    'the booking was stamped as failed because GOOGLE was signed out — that turns one '
    + 'problem the owner can fix into a hundred he cannot');
  assert.strictEqual(row.calendar_event_id, null, 'an event was somehow created while signed out');
});

test('and it recovers on its own once he reconnects', async () => {
  const b = seed({});
  GOOGLE.connected = false;
  await sweeper.sweepMissingEvents();
  GOOGLE.connected = true;
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_' + b.ref,
    'reconnecting did not bring the missing jobs across — the original complaint');
});

// ── 5. IT IS ACTUALLY STARTED. ───────────────────────────────────────────
console.log('\nThe sweep is wired to boot, not just written');

test('the server starts the sweeper at boot', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/require\(['"]\.\/calendar-sync['"]\)\.startCalendarSweeper\(\)/.test(idx),
    'index.js never starts the calendar sweeper — the whole thing is dead code');
});

test('it runs at boot AND on an interval', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'calendar-sync.js'), 'utf8');
  const start = src.slice(src.indexOf('function startCalendarSweeper'));
  assert.ok(/setTimeout\(/.test(start), 'no boot pass — a restart would not repair anything');
  assert.ok(/setInterval\(/.test(start), 'no repeating pass — it would only ever run once');
  assert.ok(sweeper.SWEEP_INTERVAL_MS > 0 && sweeper.SWEEP_INTERVAL_MS <= 30 * 60 * 1000,
    'the sweep interval is ' + (sweeper.SWEEP_INTERVAL_MS / 60000) + ' min — a job missing '
    + 'from the calendar should not be invisible for longer than half an hour');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('calendar-auto-sync.test.js'),
    'add it to npm test or it will not run again');
});


// ── 6. ONLY REAL TRIPS. ──────────────────────────────────────────────────
console.log('\nAn enquiry is not a journey — only confirmed work reaches the calendar');

test('a pending enquiry is NOT put on the calendar', async () => {
  const b = seed({ status: 'pending' });
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(b.id).calendar_event_id, null,
    'an unconfirmed enquiry was put on the calendar');
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(r.action, 'none', 'a direct sync created an event for an enquiry: ' + r.action);
});

test('neither is an offered job, nor an estimate nobody answered', async () => {
  const offered = seed({ status: 'offered' });
  const estimate = seed({ status: 'awaiting_payment', payment: 'pending' });
  await sweeper.sweepMissingEvents();
  assert.strictEqual(rowOf(offered.id).calendar_event_id, null, 'an offered job reached the calendar');
  assert.strictEqual(rowOf(estimate.id).calendar_event_id, null,
    'an unanswered estimate reached the calendar');
});

test('it goes on the moment it BECOMES confirmed', async () => {
  const b = seed({ status: 'pending' });
  await sweeper.syncBooking(b.id);
  assert.strictEqual(rowOf(b.id).calendar_event_id, null, 'seeded wrong');
  db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(b.id);
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(r.action, 'created', 'confirming a booking did not put it on the calendar');
  assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_' + b.ref);
});

test('PAY-ON-THE-DAY counts as confirmed, whatever the status column says', async () => {
  /* applyCashChoice moves the booking to AWAITING_PAYMENT, not confirmed — and
     sends the customer the "Booking confirmed" email in the same breath. A rule
     that read the status string alone would leave every pay-the-driver job off
     the calendar while its customer holds an email saying it is confirmed. That
     is the Mr Ben booking exactly. */
  const b = seed({ status: 'awaiting_payment', payment: 'cash' });
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(r.action, 'created',
    'a pay-on-the-day booking was left off the calendar (' + r.action + '/' + r.reason + ')');
  assert.ok(sweeper.belongsOnCalendar({ status: 'awaiting_payment', payment: 'cash' }),
    'belongsOnCalendar disagrees with the sync');
  assert.ok(!sweeper.belongsOnCalendar({ status: 'awaiting_payment', payment: 'pending' }),
    'an unanswered estimate is being treated as a committed trip');
});

test('the sweep SQL and the rule agree — neither is narrower than the other', async () => {
  /* Two expressions of one rule, in JavaScript and in SQL. If the query is
     narrower the sweep silently walks past jobs it exists to catch, which is
     how the original bug stayed invisible. */
  const kinds = [
    { status: 'confirmed', payment: 'pending' },
    { status: 'completed', payment: 'card' },
    { status: 'active', payment: 'cash' },
    { status: 'awaiting_payment', payment: 'cash' },
    { status: 'pending', payment: 'pending' },
    { status: 'offered', payment: 'cash' },
    { status: 'awaiting_payment', payment: 'pending' }
  ];
  const rows = kinds.map((k) => seed(k));
  await sweeper.sweepMissingEvents();
  rows.forEach((row, i) => {
    const want = sweeper.belongsOnCalendar(kinds[i]);
    const got = !!rowOf(row.id).calendar_event_id;
    assert.strictEqual(got, want,
      'status=' + kinds[i].status + ' payment=' + kinds[i].payment
      + ': the sweep ' + (got ? 'ADDED' : 'skipped') + ' it but the rule says '
      + (want ? 'it belongs' : 'it does not'));
  });
});

test('a cancelled booking has its event taken off', async () => {
  const b = seed({ status: 'confirmed' });
  await sweeper.syncBooking(b.id);
  const eventId = rowOf(b.id).calendar_event_id;
  assert.ok(eventId, 'seeded wrong');
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(r.action, 'deleted', 'cancelling left the event on the calendar');
  assert.ok(GOOGLE.deleted.includes(eventId), 'Google was never asked to delete it');
  assert.strictEqual(rowOf(b.id).calendar_event_id, null, 'the stale event id was kept');
});

test('but an unconfirmed booking KEEPS an event it already has', async () => {
  /* Deleting is for cancellation only. Bookings put on the calendar under the
     old everything-goes rule must not be silently swept off it — a sync that
     removes entries from a working calendar on its own is worse than one that
     leaves a stale entry a person can delete. */
  const b = seed({ status: 'pending', event: 'evt_LEGACY' });
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_LEGACY',
    'an existing event was deleted just because the booking is not confirmed');
  assert.notStrictEqual(r.action, 'deleted', 'it deleted a non-cancelled booking\'s event');
});

test('an edit to a confirmed booking updates the event rather than duplicating it', async () => {
  const b = seed({ status: 'confirmed', event: 'evt_LIVE' });
  const before = GOOGLE.created.length;
  const r = await sweeper.syncBooking(b.id);
  assert.strictEqual(r.action, 'updated', 'an edit did not update the event (' + r.action + ')');
  assert.strictEqual(GOOGLE.created.length, before, 'it made a second event for the same job');
});

test('every path that confirms a booking calls the one authority', () => {
  /* The reason this file exists is that each path decided for itself whether to
     push, and two of them silently did not. Anything that moves a booking to
     confirmed has to go through calendar-sync, or it is a new silent gap. */
  /* COUNT THE CALLS, NOT THE MENTIONS. An earlier draft asked only whether the
     file named calendar-sync anywhere — which the COMMENT above each call
     satisfied, so deleting the call itself passed the guard. Each count is the
     number of moments in that file where a booking is created or becomes
     confirmed; removing any one of them is the silent gap this is here for. */
  const sites = [
    ['api.js', 4, 'create, edit, change-request edit, mark-paid'],
    ['public-api.js', 4, 'public booking, return leg, cash choice, card payment'],
    ['intake.js', 1, 'auto-confirm'],
    ['offer-routes.js', 2, 'driver accepts an offer, and an ad-hoc offer'],
    ['assistant-routes.js', 1, 'assistant creates a booking']
  ];
  for (const [file, least, what] of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const calls = (src.match(/syncBooking(?:Soon)?\s*\(/g) || []).length;
    assert.ok(calls >= least,
      file + ' calls the calendar authority ' + calls + ' time(s), expected at least '
      + least + ' — one per moment a booking is created or confirmed (' + what + '). '
      + 'A path that stops calling it is a silent gap again.');
  }
  /* And none of them may push on their own any more. */
  const api = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  assert.ok(!/gcal\.createEvent/.test(api),
    'api.js still calls gcal.createEvent directly — the rule lives in one place or it lives in none');
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
