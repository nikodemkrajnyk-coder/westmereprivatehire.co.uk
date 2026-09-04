/**
 * A JOB MISSING FROM THE CALENDAR CAN BE PUT ON IT — run with:
 *   node server/tests/calendar-resync.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   Every calendar write in this system is fire-and-forget: createEvent returns
 *   null on any failure and the .catch() swallows it. A booking whose event
 *   never landed keeps a null calendar_event_id and looks exactly like one
 *   whose event did — nothing logged on the booking, nothing shown to the
 *   owner, no retry.
 *
 *   A customer's job sat in the system for days with no event on the calendar.
 *   The owner disconnected and reconnected Google, which changed nothing:
 *   reconnecting re-authorises the account, it does not push a single booking.
 *   There was no way to push one, ever.
 *
 * WHAT IS GUARDED
 *   1. The per-booking repair works, is honest about failure, and refuses to
 *      make a second event for a job that already has one.
 *   2. The backfill covers upcoming jobs, is idempotent, and reports.
 *   3. A failed write is STAMPED, and the stamp is cleared by a success.
 *   All of it against a fake Google that can be told to fail.
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
const GOOGLE = { connected: true, configured: true, needsReconnect: false, fail: false, created: [] };
gcal.createEvent = async (b) => {
  if (GOOGLE.fail) return null;
  const id = 'evt_' + b.ref;
  GOOGLE.created.push({ id, ref: b.ref, summary: b.pickup + ' → ' + b.destination });
  return id;
};
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

// ── 1. THE ONE JOB ───────────────────────────────────────────────────────
console.log('\nA job with no event can be put on the calendar');

test('the repair creates the event and stores its id', async () => {
  GOOGLE.fail = false;
  const b = seed();
  assert.strictEqual(b.calendar_event_id, null, 'the fixture must start with no event');
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.eventId, 'no event id came back');
  assert.strictEqual(rowOf(b.id).calendar_event_id, r.body.eventId, 'the id was not stored');
  assert.ok(GOOGLE.created.some((e) => e.ref === b.ref), 'nothing was actually sent to Google');
});

test('a job already on the calendar is not duplicated', async () => {
  const b = seed({ event: 'evt_existing' });
  const before = GOOGLE.created.length;
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.already, true, 'it must say so rather than making a second event');
  assert.strictEqual(GOOGLE.created.length, before, 'a duplicate event was created');
  assert.strictEqual(rowOf(b.id).calendar_event_id, 'evt_existing');
});

test('a job in the PAST can still be put on — that is the case that started this', async () => {
  /* The job that sent us here was three days old by the time anybody noticed.
     A calendar is a record as much as a plan, so the per-booking repair has no
     date restriction. */
  GOOGLE.fail = false;
  const b = seed({ date: plusDays(-3) });
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(rowOf(b.id).calendar_event_id, 'a past job must still be addable');
});

test('a cancelled job is refused', async () => {
  const b = seed({ status: 'cancelled' });
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(rowOf(b.id).calendar_event_id, null);
});

// ── 2. IT IS HONEST ABOUT FAILING ────────────────────────────────────────
console.log('\nWhen it does not work, it says so');

test('a refused write returns a real failure and stamps the booking', async () => {
  GOOGLE.fail = true;
  const b = seed();
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 502, 'a failure must not come back as success: ' + JSON.stringify(r.body));
  assert.ok(r.body.error, 'and it must say something');
  const row = rowOf(b.id);
  assert.strictEqual(row.calendar_event_id, null);
  assert.ok(row.calendar_sync_failed_at, 'the miss was not stamped — nobody will ever know');
  GOOGLE.fail = false;
});

test('a later success clears the stamp', async () => {
  const b = seed({ failedAt: '2026-09-01 10:00:00' });
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 200);
  const row = rowOf(b.id);
  assert.ok(row.calendar_event_id);
  assert.strictEqual(row.calendar_sync_failed_at, null,
    'a fixed booking must stop reporting itself as broken');
});

test('a disconnected calendar is a clear answer, not a silent no-op', async () => {
  GOOGLE.connected = false; GOOGLE.needsReconnect = true;
  const b = seed();
  const r = await call('post', '/bookings/:id/calendar', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 409);
  assert.ok(/reconnect/i.test(r.body.error), 'it must tell the owner what to do: ' + r.body.error);
  GOOGLE.connected = true; GOOGLE.needsReconnect = false;
});

// ── 3. THE BACKFILL ──────────────────────────────────────────────────────
console.log('\nEvery upcoming job that never made it');

test('it adds the missing ones and reports the count', async () => {
  db.prepare('DELETE FROM bookings').run();
  GOOGLE.created.length = 0;
  seed({ date: plusDays(2) });                       // missing
  seed({ date: plusDays(5) });                       // missing
  seed({ date: plusDays(9), event: 'evt_has' });     // already on
  seed({ date: plusDays(3), status: 'cancelled' });  // cancelled
  seed({ date: plusDays(-4) });                      // past

  const r = await call('post', '/calendar/backfill', {});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.considered, 2,
    'it must consider only the upcoming, non-cancelled jobs with no event');
  assert.strictEqual(r.body.added, 2);
  assert.strictEqual(r.body.failed, 0);
  const still = db.prepare(`SELECT COUNT(*) c FROM bookings
    WHERE calendar_event_id IS NULL AND status <> 'cancelled' AND date >= ?`).get(ukToday()).c;
  assert.strictEqual(still, 0, 'an upcoming job is still missing its event');
});

test('a second run does nothing — it is idempotent', async () => {
  const before = GOOGLE.created.length;
  const r = await call('post', '/calendar/backfill', {});
  assert.strictEqual(r.body.considered, 0, 'the second run must find nothing');
  assert.strictEqual(r.body.added, 0);
  assert.strictEqual(GOOGLE.created.length, before, 'it sent something to Google on a no-op run');
});

test('the cancelled and the past are deliberately left alone', () => {
  const rows = db.prepare('SELECT date, status, calendar_event_id FROM bookings').all();
  const cancelled = rows.find((x) => x.status === 'cancelled');
  const past = rows.find((x) => x.date < ukToday() && x.status !== 'cancelled');
  assert.strictEqual(cancelled.calendar_event_id, null, 'a cancelled job must not be put on');
  assert.strictEqual(past.calendar_event_id, null,
    'the bulk repair stays out of history — a single old job is added by its own button');
});

test('failures are counted, named, and stamped', async () => {
  db.prepare('DELETE FROM bookings').run();
  const a = seed({ date: plusDays(2) });
  const b = seed({ date: plusDays(4) });
  GOOGLE.fail = true;
  const r = await call('post', '/calendar/backfill', {});
  GOOGLE.fail = false;
  assert.strictEqual(r.body.added, 0);
  assert.strictEqual(r.body.failed, 2, 'the count must be honest');
  assert.deepStrictEqual(r.body.failedRefs.sort(), [a.ref, b.ref].sort(),
    'and it must name them, or they cannot be chased');
  for (const x of [a, b]) {
    assert.ok(rowOf(x.id).calendar_sync_failed_at, x.ref + ' was not stamped');
  }
});

test('a disconnected calendar refuses the whole run rather than failing every job', async () => {
  GOOGLE.connected = false;
  const r = await call('post', '/calendar/backfill', {});
  assert.strictEqual(r.statusCode, 409);
  GOOGLE.connected = true;
});

// ── 4. THE MISS IS VISIBLE ───────────────────────────────────────────────
console.log('\nA miss reaches the owner the same day');

test('the create paths stamp a failure instead of swallowing it', () => {
  /* BOUNDED TO THE CREATE CALL ITSELF. Reading the whole file for the stamp
     passed even after the stamp was deleted from the create path, because the
     /calendar repair route below also contains those words — a guard looking at
     a file for a phrase says nothing about where the phrase is. */
  for (const [file, marker, what] of [
        ['api.js', 'gcal.createEvent(bookingForCal)', 'the staff booking form'],
        ['public-api.js', '// Push to Google Calendar in background', 'the public /book path']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const i = src.indexOf(marker);
    assert.ok(i !== -1, what + ': its calendar push is gone');
    const block = src.slice(i, src.indexOf('}).catch(() => {});', i));
    assert.ok(/calendar_sync_failed_at = datetime\('now'\)/.test(block),
      what + ' still swallows a failed calendar write — a booking with no event '
      + 'is indistinguishable from one with an event');
    assert.ok(/calendar_event_id = \?, calendar_sync_failed_at = NULL/.test(block),
      what + ' must clear the stamp when the write succeeds');
  }
});

test('the owner app offers the repair where the event is missing', () => {
  const owner = fs.readFileSync(path.join(__dirname, '..', '..', 'westmere-owner.html'), 'utf8');
  /* THE BUTTON MUST BE WIRED, not merely defined. Checking that the function
     NAME appears anywhere passed on a card whose onclick had been cut — the
     definition still matched. */
  assert.ok(/onclick="ownerAddToCalendar\('\+j\.id\+'\)"/.test(owner),
    'the job card no longer calls the repair — the action exists but nothing invokes it');
  assert.ok(/async function ownerAddToCalendar\(/.test(owner), 'no per-job repair action');
  assert.ok(/!j\.calendar_event_id/.test(owner),
    'the button must be shown by the absence of an event, not by a guess');
  assert.ok(/Calendar failed — retry/.test(owner),
    'a job that has already failed should say so on the button');
  assert.ok(/onclick="event\.preventDefault\(\);ownerCalendarBackfill\(\)"/.test(owner),
    'the backfill link is not wired to anything');
  assert.ok(/async function ownerCalendarBackfill\(/.test(owner), 'no backfill action');
  /* The repair must report. A silent one is how the misses went unnoticed. */
  const fn = owner.slice(owner.indexOf('async function ownerAddToCalendar'),
                         owner.indexOf('async function ownerCalendarBackfill'));
  assert.ok(/showToast\(d\.error/.test(fn), 'a failed repair must tell the owner');
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
