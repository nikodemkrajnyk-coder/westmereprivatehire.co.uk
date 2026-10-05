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

/* THE EMAILS THEMSELVES, CAPTURED. Everything below this had been assertions
   about the sweeper's SHAPE — its window, its latches, the SQL it runs. None of
   it ever sent one, so a reminder that threw at send time looked identical to a
   reminder that went: the sweeper catches, logs and moves on, and the latch
   stays open for a retry that fails the same way for ever.
   That is not hypothetical. Adding the payout to the driver reminder borrowed a
   `money` helper that is a LOCAL in the other builders, and the driver reminder
   stopped sending entirely — caught here, by a test that actually runs it. */
const SENT = [];
const realFetch = global.fetch;
/* INSTALLED PER TEST, not once at the top: this file already replaces
   global.fetch three times further down for its own captures, and whichever
   ran last wins. Calling capture() at the start of a test takes the stub back
   and empties the record. */
function capture() {
  SENT.length = 0;
  global.fetch = async (u, o) => {
    if (!/resend\.com/.test(String(u))) return realFetch(u, o);
    try { SENT.push(JSON.parse(o.body)); } catch (e) {}
    return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
  };
}

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
    // ALL THREE latches set → nothing left to send. There are three reminders
    // now — owner, customer, driver — and a booking stays due until every one
    // has gone.
    { ref: 'C', date: '2026-08-12', time: '12:00', reminder_sent_at: '2026-08-11 20:00',
      customer_reminder_sent_at: '2026-08-11 20:00',
      driver_reminder_sent_at: '2026-08-11 20:00' },                                     // all done
    // Owner's has gone, the customer's has NOT — still due, or the customer
    // would silently never be told.
    { ref: 'G', date: '2026-08-12', time: '16:00', reminder_sent_at: '2026-08-11 20:00' },
    // Owner's and customer's have gone; the DRIVER's has not. Still due, or the
    // person actually driving is the one nobody reminds.
    { ref: 'H', date: '2026-08-12', time: '17:00', reminder_sent_at: '2026-08-11 20:00',
      customer_reminder_sent_at: '2026-08-11 20:00' },
    { ref: 'D', date: '2026-08-12', time: 'ASAP',  reminder_sent_at: null },              // ASAP → skip
    { ref: 'E', date: '2026-08-12', time: '07:00', reminder_sent_at: null },              // past → skip
  ];
  const due = reminder.dueReminders(rows, now, 12).map((r) => r.ref).sort();
  assert.deepStrictEqual(due, ['A', 'F', 'G', 'H'],
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
const headline = (html) => ((html.match(/A booking is coming up([^<]*)\./) || [])[1] || '').trim();

/* These six tests used to pin the opposite: that the headline said "in about 5
   hours", that the preheader repeated it, that the line underneath softened as
   the gap closed. The owner asked for the countdown out of all three reminders,
   his own included — the sentence is true when sent and wrong when read.

   They are inverted rather than deleted. The regression they were written for
   was an email that ALWAYS said "12 hours" whatever the real gap; the fix for
   that is now "say no gap at all", and these hold it there. The 12-hour WINDOW
   is unchanged and still has its own tests below. */
test('the owner reminder states no gap, whatever the real one is', async () => {
  for (const mins of [11 * 60, 5.4 * 60, 90, 60, 30, 3]) {
    const cap = await renderAt(mins);
    const said = (cap.html.match(/in about [^<.,]{1,24}|in under an hour|in just a few minutes|any moment now/gi) || []);
    assert.deepStrictEqual(said, [], mins + ' minutes out still says: ' + said.join(' | '));
    const figures = (cap.html.match(/\b\d+\s*(?:hours?|minutes?|hrs?|mins?)\b/gi) || []);
    assert.deepStrictEqual(figures, [], 'and no figure anywhere: ' + figures.join(', '));
  }
});

test('it opens as a plain reminder instead', async () => {
  const cap = await renderAt(5.4 * 60);
  assert.strictEqual(headline(cap.html), '', 'nothing follows "A booking is coming up"');
  assert.ok(/A booking is coming up\./.test(cap.html), 'it just says that');
  assert.ok(/Full details below\./.test(cap.html),
    'and the line underneath is fixed, not scaled to the gap');
});

test('the urgency line no longer changes with the gap', async () => {
  /* It named no hours, but it still went stale in an inbox: "Give yourself
     plenty of time" read eleven hours out is wrong when opened at six. */
  const far = await renderAt(11 * 60);
  const near = await renderAt(30);
  for (const cap of [far, near]) {
    for (const gone of ['Give yourself plenty of time', 'Time to start getting ready', 'This one is close']) {
      assert.ok(!cap.html.includes(gone), 'gap-scaled wording remains: ' + gone);
    }
  }
});

test('no countdown in the SUBJECT or the PREHEADER either', async () => {
  const cap = await renderAt(5.4 * 60);
  assert.ok(!/hours?\b|minutes?\b|in about/i.test(cap.subject), 'subject: ' + cap.subject);
  const pre = (cap.text || '') + ' ' + cap.html.slice(0, 1200);
  assert.ok(!/Pickup in about/.test(pre), 'the preheader used to repeat the gap');
  /* The pickup TIME is not a countdown and must stay — it is the one thing the
     owner needs at a glance. */
  assert.ok(/pickup at 09:30/.test(cap.subject), 'the subject still names the pickup time: ' + cap.subject);
  assert.ok(/Friday, 18 December 2026/.test(cap.html), 'and the date is still in the details');
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
    'sendOwnerBookingReminder emits a gap: ' + literals.join(', ') +
    '. It must state none at all — the countdown was taken out of all three reminders.');
  assert.ok(!/gapPhrase|urgencyLine/.test(body),
    'and it must not compute one either — nothing in this email derives from the clock');
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
  /* Three latches now, and this is asked of the FUNCTION rather than of the
     source text — a regex over reminder.js went stale the moment a third latch
     was added, and said nothing about whether the behaviour was right. */
  const inWindow = { ref: 'X', date: '2026-08-12', time: '18:00' };
  const now = Date.parse('2026-08-12T08:00:00Z');
  const stamped = '2026-08-11 20:00';
  const dueWith = (o) => reminder.dueReminders([Object.assign({}, inWindow, o)], now, 12).length;
  assert.strictEqual(dueWith({}), 1, 'nothing sent yet — due');
  for (const only of ['reminder_sent_at', 'customer_reminder_sent_at', 'driver_reminder_sent_at']) {
    assert.strictEqual(dueWith({ [only]: stamped }), 1, only + ' alone must not close the window');
  }
  assert.strictEqual(dueWith({ reminder_sent_at: stamped, customer_reminder_sent_at: stamped,
                              driver_reminder_sent_at: stamped }), 0, 'all three done — not due');
  assert.ok(/UPDATE bookings SET customer_reminder_sent_at = datetime\('now'\) WHERE id = \?/.test(rem),
    'a successful customer send must stamp its own column');
  assert.ok(/UPDATE bookings SET driver_reminder_sent_at = datetime\('now'\) WHERE id = \?/.test(rem),
    'and a successful driver send must stamp its own column');
  for (const c of ['customer_reminder_sent_at', 'driver_reminder_sent_at']) {
    assert.ok(new RegExp('ALTER TABLE bookings ADD COLUMN ' + c).test(read('server/db.js')),
      'the ' + c + ' latch column must exist');
  }
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
  assert.ok(/A booking is coming up\./.test(cap.html),
    'a genuine 12h gap reads the same as every other — the window fired, the email says nothing about it');
  assert.ok(!/12 hours/.test(cap.html), 'and never names the window');
});
// ── BOTH REMINDERS, ACTUALLY SENT ────────────────────────────────────────
console.log('\nBoth reminders, driven through the real sweeper');

/* A booking due in ~11.5h, built from UK wall-clock components so the sweeper's
   own clock reading agrees with it (CLAUDE.md timezone invariant). */
function dueBooking(ref, over) {
  const o = over || {};
  const db = getDb();
  const sv = new Date(Date.now() + 11.5 * 3600 * 1000)
    .toLocaleString('sv-SE', { timeZone: 'Europe/London' });
  const date = sv.slice(0, 10), time = sv.slice(11, 16);
  db.prepare(`INSERT INTO bookings
      (ref,passenger_name,passenger_email,passenger_phone,pickup,destination,date,time,
       passengers,bags,fare,payment,status,driver_id,driver_pay,admin_fee,passed_at,
       assigned_to_name,assigned_to_email,paid_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Mrs Hall', o.custEmail === null ? null : (o.custEmail || 'hall@example.com'),
         '07700 900101', 'Weppons Farm, Wiston BN44 3DN', 'Gatwick Airport, South Terminal',
         date, time, 2, 2, o.fare == null ? 95 : o.fare, o.payment || 'card', 'confirmed',
         o.driver_id || null, o.driver_pay == null ? null : o.driver_pay,
         o.admin_fee == null ? null : o.admin_fee, o.passed_at || null,
         o.an || null, o.ae || null, '2026-01-01 00:00');
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
function seedDriver() {
  return getDb().prepare(`INSERT INTO users (username,password,role,full_name,email,phone,vehicle,reg,active,has_login)
      VALUES (?, '', 'driver', 'Gary Mitchell', ?, '07700 900411', 'Mercedes E-Class', 'WM70 XYZ', 1, 0)`)
    .run('g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
         'gary' + Math.random().toString(36).slice(2, 6) + '@example.com').lastInsertRowid;
}
const to = (m) => [].concat(m.to || []).join(',');
const textOf = (m) => String(m.html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&pound;/g, '£').replace(/&middot;/g, '·').replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ');

test('THE CUSTOMER REMINDER IS ACTUALLY SENT, and names the driver and car', async () => {
  capture();
  const d = seedDriver();
  const drv = getDb().prepare('SELECT email FROM users WHERE id = ?').get(d).email;
  dueBooking('WPH-RT1', { driver_id: d, driver_pay: 85.5, admin_fee: 9.5, passed_at: 'x' });
  const r = await reminder.sweepDueReminders();
  assert.ok(r.sentCustomer >= 1, 'no customer reminder was sent: ' + JSON.stringify(r));
  const mail = SENT.filter((m) => /hall@example\.com/.test(to(m)))[0];
  assert.ok(mail, 'nothing reached the customer; went to: ' + SENT.map(to).join(' | '));
  const t = textOf(mail);
  assert.ok(/Gary Mitchell/.test(t), 'the customer is not told who is picking them up');
  assert.ok(/Mercedes E-Class/.test(t) && /WM70 XYZ/.test(t), 'the car and plate are missing');
  assert.ok(/Gatwick/.test(t) && /05|0\d:|\d\d:\d\d/.test(t), 'the journey itself is missing');
  assert.ok(!/undefined|NaN|\[object/.test(t), 'the customer email has a hole in it: ' + t.slice(0, 200));
});

test('THE DRIVER REMINDER IS ACTUALLY SENT, with the job and the payout', async () => {
  capture();
  const d = seedDriver();
  const drvEmail = getDb().prepare('SELECT email FROM users WHERE id = ?').get(d).email;
  dueBooking('WPH-RT2', { driver_id: d, driver_pay: 85.5, admin_fee: 9.5, passed_at: 'x' });
  const r = await reminder.sweepDueReminders();
  assert.strictEqual(r.sentDriver, 1, 'the driver reminder did not send: ' + JSON.stringify(r));
  const mail = SENT.filter((m) => to(m) === drvEmail)[0];
  assert.ok(mail, 'nothing reached the driver');
  const t = textOf(mail);
  assert.ok(/Payout/.test(t), 'THE DRIVER IS REMINDED OF A JOB WITHOUT BEING TOLD WHAT IT PAYS');
  assert.ok(/£85\.50/.test(t), 'the payout figure is wrong or missing: ' + (t.match(/Payout[^·]*/) || []));
  assert.ok(/Fare £95\.00/.test(t) && /Commission/.test(t), 'the working is gone');
  assert.ok(/Gatwick/.test(t), 'the job itself is missing');
  assert.ok(!/undefined|NaN|\[object/.test(t), 'the driver email has a hole in it: ' + t.slice(0, 200));
});

test('the payout on the reminder is the LEDGER\'s, including an agreed amount', async () => {
  capture();
  const d = seedDriver();
  const drvEmail = getDb().prepare('SELECT email FROM users WHERE id = ?').get(d).email;
  dueBooking('WPH-RT3', { driver_id: d, driver_pay: 70, admin_fee: 25, passed_at: 'x', fare: 95 });
  getDb().prepare("UPDATE bookings SET driver_payout_set = 70 WHERE ref = 'WPH-RT3'").run();
  await reminder.sweepDueReminders();
  const mail = SENT.filter((m) => to(m) === drvEmail)[0];
  const t = textOf(mail);
  const row = getDb().prepare("SELECT * FROM bookings WHERE ref = 'WPH-RT3'").get();
  const split = require('../driver-ledger').jobSplit(row);
  assert.strictEqual(split.payout, 70);
  assert.ok(/£70\.00/.test(t), 'the reminder disagrees with the ledger about the payout');
  assert.ok(/agreed/.test(t), 'an agreed amount is not named as one');
  assert.ok(!/Card fee/.test(t), 'an agreed payout must not show a card-fee deduction');
});

test('a job NOBODY was passed shows no payout — it is the owner\'s own fare', async () => {
  capture();
  dueBooking('WPH-RT4', {});                       // nobody assigned, never passed
  await reminder.sweepDueReminders();
  const owner = SENT.filter((m) => /nikodem/.test(to(m)))[0];
  assert.ok(owner, 'the owner was not reminded at all');
  assert.ok(!/Payout/.test(textOf(owner)), 'the owner is being shown a payout on his own job');
});

test('the three latches are independent — one sent does not block the others', async () => {
  capture();
  const d = seedDriver();
  const drvEmail = getDb().prepare('SELECT email FROM users WHERE id = ?').get(d).email;
  dueBooking('WPH-RT5', { driver_id: d, driver_pay: 85.5, admin_fee: 9.5, passed_at: 'x' });
  // The owner's has already gone; the other two must still fire.
  getDb().prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE ref = 'WPH-RT5'").run();
  const r = await reminder.sweepDueReminders();
  assert.strictEqual(r.sent, 0, 'the owner was reminded twice');
  assert.ok(r.sentCustomer >= 1, 'the customer was blocked by the owner latch');
  assert.strictEqual(r.sentDriver, 1, 'the driver was blocked by the owner latch');
  assert.ok(SENT.some((m) => to(m) === drvEmail), 'nothing reached the driver');
});

test('a second sweep sends nothing — every latch holds', async () => {
  capture();
  const r = await reminder.sweepDueReminders();
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(r.sentCustomer, 0);
  assert.strictEqual(r.sentDriver, 0);
  assert.strictEqual(SENT.length, 0, 'a reminder went out twice');
});

test('a booking made LESS than 12h out is still reminded, on the next sweep', async () => {
  capture();
  const db = getDb();
  const sv = new Date(Date.now() + 2 * 3600 * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/London' });
  db.prepare(`INSERT INTO bookings (ref,passenger_name,passenger_email,pickup,destination,date,time,
                                    passengers,fare,payment,status,paid_at)
              VALUES ('WPH-RT6','Late Booker','late@example.com','Hove','Gatwick',?,?,1,60,'card','confirmed','2026-01-01')`)
    .run(sv.slice(0, 10), sv.slice(11, 16));
  const r = await reminder.sweepDueReminders();
  assert.ok(r.sentCustomer >= 1, 'a job two hours away was never reminded');
  assert.ok(SENT.some((m) => /late@example\.com/.test(to(m))), 'the late booker heard nothing');
});

test('nothing fails silently — a send that throws leaves the latch OPEN', () => {
  /* The sweeper catches per-reminder so one bad address cannot stop the sweep.
     The latch is only stamped on a truthy send, so the next pass retries —
     which is what made the `money is not defined` bug recoverable rather than
     permanent, and why these tests have to run the sender rather than read it. */
  const rem = read('server/reminder.js');
  for (const col of ['reminder_sent_at', 'customer_reminder_sent_at', 'driver_reminder_sent_at']) {
    const sites = [...rem.matchAll(new RegExp('SET ' + col + " = datetime\\('now'\\)", 'g'))]
      .map((m) => m.index);
    assert.ok(sites.length, col + ' is never stamped');
    /* AT LEAST ONE stamp must sit behind `if (ok)` — that is the send path.
       The driver column has a SECOND site with no send behind it, and that one
       is deliberate: when nobody is assigned the owner is the driver and has
       just had the owner reminder for the same job, so the latch is closed
       without a second email. A decision, not a failure. */
    assert.ok(sites.some((i) => /if \(ok\)/.test(rem.slice(Math.max(0, i - 260), i))),
      col + ' is never stamped behind a successful send');
    for (const i of sites) {
      const before = rem.slice(Math.max(0, i - 420), i);
      if (!/await send[A-Za-z]+\(/.test(before)) continue;      // not a send site
      assert.ok(/if \(ok\)/.test(before),
        col + ' is stamped after a send without checking the send succeeded');
    }
  }
  assert.ok(/catch \(e\) \{[\s\S]{0,120}console\.error\('\[REMINDER\]/.test(rem),
    'a failed send is swallowed without a word');
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
