/**
 * Owner pickup-reminder guardrail — run with:
 *   node server/tests/reminder.test.js   (also gated by `npm test`)
 *
 * The owner was late to a booking. A server-side sweeper now emails the OWNER
 * once per booking, for any pickup inside the next 12 hours. Pure Node; the DB
 * is a throwaway temp file and Resend is stubbed. Exit 1 on any failure.
 *
 * THE SECOND BUG THIS NOW PINS
 *   The email used to say "A booking is coming up in about 12 hours" whenever it
 *   went out — a hard-coded string, not a measurement. The window has always
 *   been 0 < gap <= 12h, so a booking made forty minutes before pickup was
 *   emailed a claim of twelve hours. The wording is now computed from
 *   (pickup - now) at send time, and the assertions below are written against
 *   the REAL gap so the constant cannot come back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Isolate the DB to a temp file BEFORE requiring ./db.
const TMP = path.join(os.tmpdir(), 'wm-reminder-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
process.env.OWNER_REMINDER_EMAIL = 'nikodem.krajnyk@gmail.com';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'); }

const reminder = require('../reminder');
const { getDb } = require('../db');

// ── Pure window logic ─────────────────────────────────────────────────────
console.log('\n12h owner reminder — window logic');
test('dueReminders fires only inside the next 12h, once, skipping ASAP/past/future', () => {
  const now = Date.parse('2026-08-12T08:00:00Z');
  const rows = [
    { ref: 'A', date: '2026-08-12', time: '18:00', reminder_sent_at: null },              // 10h → due
    { ref: 'F', date: '2026-08-12', time: '19:59', reminder_sent_at: null },              // ~12h → due
    { ref: 'B', date: '2026-08-12', time: '23:00', reminder_sent_at: null },              // 15h → not yet
    // BOTH latches set → nothing left to send. There are two reminders now (owner
    // and customer) and a booking stays due until both have gone.
    { ref: 'C', date: '2026-08-12', time: '12:00', reminder_sent_at: '2026-08-11 20:00',
      customer_reminder_sent_at: '2026-08-11 20:00' },                                   // both done
    // Owner's has gone, the customer's has NOT — still due, or the customer
    // would silently never be told.
    { ref: 'G', date: '2026-08-12', time: '16:00', reminder_sent_at: '2026-08-11 20:00' },
    { ref: 'D', date: '2026-08-12', time: 'ASAP',  reminder_sent_at: null },              // ASAP → skip
    { ref: 'E', date: '2026-08-12', time: '07:00', reminder_sent_at: null },              // past → skip
  ];
  const due = reminder.dueReminders(rows, now, 12).map((r) => r.ref).sort();
  assert.deepStrictEqual(due, ['A', 'F', 'G'],
    'due = inside the next 12h with at least one reminder still outstanding');
});

// ── End-to-end sweep against a real (temp) DB ─────────────────────────────
console.log('\n12h owner reminder — sweep + dedupe');
let capturedSends = [];
global.fetch = async (u, o) => { const b = JSON.parse(o.body); capturedSends.push({ to: b.to, subject: b.subject, text: b.text || '' }); return { ok: true, status: 200, json: async () => ({ id: 'rid' }) }; };

const db = getDb();
const nowMs = reminder.ukNowMs();
function stamp(offsetH) { const p = new Date(nowMs + offsetH * 3600000); return { date: p.toISOString().slice(0, 10), time: String(p.getUTCHours()).padStart(2, '0') + ':' + String(p.getUTCMinutes()).padStart(2, '0') }; }
const soon = stamp(10);        // 10h out → due
const far  = stamp(30);        // 30h out → not due
db.prepare("INSERT INTO bookings(ref,pickup,destination,date,time,fare,status,passenger_name,passenger_phone,passengers,bags) VALUES('WPH-REM',?,?,?,?,75,'confirmed','Mr Ben','07700900123',2,'3')").run('Greenhill Ave, Caterham, CR3 6PQ', 'Gatwick Airport', soon.date, soon.time);
db.prepare("INSERT INTO bookings(ref,pickup,destination,date,time,status) VALUES('WPH-FAR','A','B',?,?,'confirmed')").run(far.date, far.time);
db.prepare("INSERT INTO bookings(ref,pickup,destination,date,time,status) VALUES('WPH-ASAP','A','B',?, 'ASAP','confirmed')").run(soon.date);
db.prepare("INSERT INTO bookings(ref,pickup,destination,date,time,status) VALUES('WPH-CANX','A','B',?,?,'cancelled')").run(soon.date, soon.time);

test('sweep emails the OWNER (not the customer) once for a due booking', async () => {
  capturedSends = [];
  const r = await reminder.sweepDueReminders();
  assert.strictEqual(r.sent, 1, 'exactly one reminder should send (the 10h booking)');
  assert.strictEqual(capturedSends.length, 1, 'exactly one email sent');
  assert.strictEqual(capturedSends[0].to, 'nikodem.krajnyk@gmail.com', 'reminder goes to the OWNER address');
  assert.ok(/WPH-REM/.test(capturedSends[0].subject) || /WPH-REM/.test(capturedSends[0].text), 'reminder names the booking');
  assert.ok(/Mr Ben/.test(capturedSends[0].text) && /Gatwick/.test(capturedSends[0].text), 'reminder includes the booking details');
});
test('a booking is reminded ONCE — the sweep is idempotent (dedupe)', async () => {
  capturedSends = [];
  const r = await reminder.sweepDueReminders();
  assert.strictEqual(r.sent, 0, 're-running the sweep must not re-send (reminder_sent_at guard)');
  const row = db.prepare("SELECT reminder_sent_at FROM bookings WHERE ref='WPH-REM'").get();
  assert.ok(row.reminder_sent_at, 'the due booking must be stamped reminder_sent_at');
  const far = db.prepare("SELECT reminder_sent_at FROM bookings WHERE ref='WPH-FAR'").get();
  assert.ok(!far.reminder_sent_at, 'a far-future booking must NOT be reminded yet');
});

// ── The sentence the owner reads is a measurement, not a constant ─────────
console.log('\nowner reminder — the stated gap is the REAL gap');

const BOOKING = { ref: 'WPH-GAP', date: '2026-12-18', time: '09:30', pickup: 'Greenhill Ave, Caterham, CR3 6PQ',
                  destination: 'Bolney', fare: 75, payment: 'cash', customer_name: 'Mr Ben', customer_phone: '07700900123' };
const PICKUP_AT = Date.parse('2026-12-18T09:30:00Z');

// Render the reminder as if "now" were `minsBefore` minutes ahead of pickup.
async function renderAt(minsBefore) {
  let cap = null;
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email.sendOwnerBookingReminder(BOOKING, 'nikodem.krajnyk@gmail.com', PICKUP_AT - minsBefore * 60000);
  return cap;
}
const headline = (html) => (html.match(/A booking is coming up ([^<.]+)\./) || [])[1];

test('a 5.4h booking says "about 5 hours" — never "12 hours"', async () => {
  const cap = await renderAt(5.4 * 60);
  assert.strictEqual(headline(cap.html), 'in about 5 hours');
  assert.ok(!/12 hours/.test(cap.html), 'the hard-coded twelve must not appear anywhere in the email');
  assert.ok(/Pickup in about 5 hours/.test(cap.text || cap.html), 'the inbox preheader states the real gap too');
});

test('a 1h booking is singular — "1 hour", not "1 hours"', async () => {
  const cap = await renderAt(60);
  assert.strictEqual(headline(cap.html), 'in about 1 hour');
  assert.ok(!/1 hours/.test(cap.html), '"1 hours" is never acceptable');
});

test('a 30-minute booking speaks in minutes', async () => {
  const cap = await renderAt(30);
  assert.strictEqual(headline(cap.html), 'in about 30 minutes');
  assert.ok(!/hours/.test(headline(cap.html)), 'under an hour must not be expressed in hours');
});

test('the 50-something band says "under an hour" rather than rounding up to one', async () => {
  const cap = await renderAt(58);
  assert.strictEqual(headline(cap.html), 'in under an hour');
});

test('a truly imminent booking does not claim a precise figure', async () => {
  const cap = await renderAt(3);
  assert.strictEqual(headline(cap.html), 'in just a few minutes');
});

test('the line under the headline softens as the gap shrinks', async () => {
  const far = await renderAt(11 * 60);
  const mid = await renderAt(90);
  const near = await renderAt(30);
  assert.ok(/Give yourself plenty of time/.test(far.html), '11h out: plenty of time');
  assert.ok(/Time to start getting ready/.test(mid.html), '90m out: getting ready');
  assert.ok(/This one is close/.test(near.html), '30m out: close');
  assert.ok(!/Give yourself plenty of time/.test(near.html),
    '"Give yourself plenty of time" is absurd half an hour before pickup');
});

test('no reminder email hard-codes a gap value anywhere in email.js', async () => {
  // The regression was a literal in the OUTPUT, so scan what the function emits,
  // not what it explains. Comments are stripped first — prose about the 12-hour
  // window is exactly the sort of thing that should stay readable.
  const src = read('server/email.js');
  const fn = src.slice(src.indexOf('async function sendOwnerBookingReminder'));
  const body = fn.slice(0, fn.indexOf('\nasync function '))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/^[ \t]*\/\/.*$/gm, ' ');    // whole-line // comments
  const literals = body.match(/\b\d+\s*(?:hours?|minutes?|hrs?|mins?)\b/gi) || [];
  assert.deepStrictEqual(literals, [],
    'sendOwnerBookingReminder emits a hard-coded gap: ' + literals.join(', ') +
    '. The gap must come from gapPhrase(pickup - now).');
});

test('the sweeper fires for ANY booking inside the window, not only at 12h', async () => {
  // "less than 12 hours out → send anyway" is the owner's requirement. It is the
  // window predicate that guarantees it, so assert the predicate, close in.
  const now = Date.parse('2026-08-12T08:00:00Z');
  const rows = [
    { ref: 'M45', date: '2026-08-12', time: '08:45', reminder_sent_at: null },  // 45 min out
    { ref: 'H5',  date: '2026-08-12', time: '13:24', reminder_sent_at: null },  // 5.4h out
    { ref: 'H11', date: '2026-08-12', time: '19:00', reminder_sent_at: null },  // 11h out
    { ref: 'M02', date: '2026-08-12', time: '08:02', reminder_sent_at: null },  // 2 min out
  ];
  const due = reminder.dueReminders(rows, now, 12).map((r) => r.ref).sort();
  assert.deepStrictEqual(due, ['H11', 'H5', 'M02', 'M45'],
    'every booking inside 0–12h is due, however close it is');
});

test('the once-only latch is still what stops a second send', () => {
  const rem = read('server/reminder.js');
  assert.ok(/reminder_sent_at IS NULL/.test(rem), 'the sweep query must exclude already-reminded bookings');
  assert.ok(/UPDATE bookings SET reminder_sent_at = datetime\('now'\) WHERE id = \?/.test(rem),
    'a successful send must stamp reminder_sent_at');
  // Two latches now: a booking stops being due only when BOTH have been stamped.
  assert.ok(/if \(r\.reminder_sent_at && r\.customer_reminder_sent_at\) return false/.test(rem),
    'dueReminders must honour BOTH latches');
  assert.ok(/UPDATE bookings SET customer_reminder_sent_at = datetime\('now'\) WHERE id = \?/.test(rem),
    'a successful customer send must stamp its own column');
  assert.ok(/ALTER TABLE bookings ADD COLUMN customer_reminder_sent_at/.test(read('server/db.js')),
    'the customer latch column must exist');
});

// ── Wiring + schema ───────────────────────────────────────────────────────
console.log('\n12h owner reminder — wiring');
test('sendOwnerBookingReminder renders a branded owner email with details', async () => {
  let cap = null;
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  // 09:30 pickup, "now" pinned to 21:30 the night before → a true 12h gap.
  const twelveHoursBefore = Date.parse('2026-12-17T21:30:00Z');
  const ok = await email.sendOwnerBookingReminder({ ref: 'WPH-Z', date: '2026-12-18', time: '09:30', pickup: 'Greenhill Ave, Caterham, CR3 6PQ', destination: 'Bolney', fare: 75, payment: 'cash', passengers: 2, bags: '3', customer_name: 'Mr Ben', customer_phone: '07700900123' }, 'nikodem.krajnyk@gmail.com', twelveHoursBefore);
  assert.ok(ok, 'reminder must send');
  assert.ok(/WESTMERE/.test(cap.html) && /wm-pad/.test(cap.html), 'hero template');
  assert.ok(/WPH-Z/.test(cap.html) && /Mr Ben/.test(cap.html), 'includes ref and passenger');
  assert.ok(/coming up in about 12 hours/.test(cap.html), 'a genuine 12h gap still reads "in about 12 hours"');
});
test('the reminder sweeper is started server-side (index.js) and has no Claude dependency', () => {
  const idx = read('server/index.js');
  assert.ok(/require\('\.\/reminder'\)\.startBookingReminders\(\)/.test(idx), 'index.js must start the reminder sweeper');
  // Prose saying "no Claude" is fine; a real runtime dependency is not — so look
  // for actual wiring (a require / an API host), not the mere word.
  const rem = read('server/reminder.js');
  assert.ok(!/require\([^)]*(anthropic|claude|assistant)[^)]*\)|api\.anthropic\.com/i.test(rem),
    'the reminder path must not depend on Claude/any assistant');
  assert.ok(/sendOwnerBookingReminder/.test(rem), 'the sweeper must send via the Resend email path');
  assert.ok(/setInterval\(run, 15 \* 60 \* 1000\)/.test(rem), 'must run on a 15-minute interval');
  assert.ok(/ALTER TABLE bookings ADD COLUMN reminder_sent_at/.test(read('server/db.js')), 'reminder_sent_at column migration must exist');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
