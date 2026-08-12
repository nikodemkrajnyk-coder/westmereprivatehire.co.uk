/**
 * 12-hour owner pickup-reminder guardrail — run with:
 *   node server/tests/reminder.test.js   (also gated by `npm test`)
 *
 * The owner was late to a booking. A server-side sweeper now emails the OWNER
 * ~12h before each upcoming pickup, once per booking. Pure Node; the DB is a
 * throwaway temp file and Resend is stubbed. Exit 1 on any failure.
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
    { ref: 'C', date: '2026-08-12', time: '12:00', reminder_sent_at: '2026-08-11 20:00' },// already reminded
    { ref: 'D', date: '2026-08-12', time: 'ASAP',  reminder_sent_at: null },              // ASAP → skip
    { ref: 'E', date: '2026-08-12', time: '07:00', reminder_sent_at: null },              // past → skip
  ];
  const due = reminder.dueReminders(rows, now, 12).map((r) => r.ref).sort();
  assert.deepStrictEqual(due, ['A', 'F'], 'only the two bookings within the next 12h (and not yet reminded) are due');
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

// ── Wiring + schema ───────────────────────────────────────────────────────
console.log('\n12h owner reminder — wiring');
test('sendOwnerBookingReminder renders a branded owner email with details', async () => {
  let cap = null;
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  const ok = await email.sendOwnerBookingReminder({ ref: 'WPH-Z', date: '2026-12-18', time: '09:30', pickup: 'Greenhill Ave, Caterham, CR3 6PQ', destination: 'Bolney', fare: 75, payment: 'cash', passengers: 2, bags: '3', customer_name: 'Mr Ben', customer_phone: '07700900123' }, 'nikodem.krajnyk@gmail.com');
  assert.ok(ok, 'reminder must send');
  assert.ok(/WESTMERE/.test(cap.html) && /wm-pad/.test(cap.html), 'hero template');
  assert.ok(/WPH-Z/.test(cap.html) && /Mr Ben/.test(cap.html) && /12 hours/i.test(cap.html), 'includes ref, passenger, and the ~12h framing');
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
