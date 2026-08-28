/**
 * THE CUSTOMER'S 12-HOUR REMINDER, AND THE CONDITIONAL PAY BLOCK ON A MESSAGE —
 *   node server/tests/rider-reminder.test.js   (also gated by `npm test`)
 *
 * TWO CUSTOMER-FACING EMAILS, ONE SHARED RULE: only offer a payment button when
 * the booking can actually take one.
 *
 * 1. THE RIDER REMINDER
 *    The owner has had a 12-hour reminder for a while; the customer never did.
 *    It rides the SAME sweep and the same window, with a SEPARATE latch
 *    (customer_reminder_sent_at). Sharing the owner's reminder_sent_at would
 *    mean one send suppressing the other — the owner gets his and the customer
 *    silently gets nothing. That is the first thing pinned here, because it
 *    would never produce an error, only silence.
 *
 * 2. "SEND MESSAGE" WITH OR WITHOUT PAY LINKS
 *    The owner's ask: include the payment links while the customer still has a
 *    choice to make; once they have chosen, send the message plain.
 *
 * BOTH ask paymentLock — the module every other channel asks. A card button
 * pointing into a cash-locked booking is a dead end this codebase already fixed
 * once, and it must not come back through a different email.
 *
 * Runs the SHIPPED email templates and the SHIPPED sweep against a throwaway
 * database with Resend stubbed. Nothing is sent. Exit 1 on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-rider-reminder-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
process.env.OWNER_REMINDER_EMAIL = 'owner@example.com';
// The owner's cancel alert reads ADMIN_EMAIL, as it does in production.
process.env.ADMIN_EMAIL = 'owner@example.com';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const reminder = require('../reminder');
const email = require('../email');
const { paymentLock } = require('../pay-lock');
const { getDb } = require('../db');
const db = getDb();

let SENT = [];
global.fetch = async (u, o) => {
  const b = JSON.parse(o.body);
  SENT.push({ to: b.to, subject: b.subject, html: b.html, text: b.text || '' });
  return { ok: true, status: 200, json: async () => ({ id: 'rid' }) };
};

let n = 0;
function seed(o) {
  o = o || {};
  const ref = 'WPH-R' + (++n);
  db.prepare(`INSERT INTO bookings (ref, pickup, destination, stop_address, date, time, fare, status,
              payment, paid_at, passenger_name, passenger_phone, passenger_email, flight, pay_token)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ref, o.pickup || '14 Greenhill Avenue, Caterham', o.destination || 'London Gatwick Airport',
    o.stop_address || null, o.date, o.time || '09:00', o.fare === undefined ? 129 : o.fare,
    o.status || 'confirmed', o.payment || 'pending', o.paid_at || null,
    o.name || 'Mr Ben Chan', '07700900123', o.email === undefined ? 'ben@example.com' : o.email,
    o.flight || null, o.pay_token === undefined ? 'tok123' : o.pay_token);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
// A pickup ~10h from now, in the same naive UK wall-clock the sweep uses.
function soonDateTime() {
  const ms = reminder.ukNowMs() + 10 * 3600 * 1000;
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return { date: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()),
           time: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) };
}
/* Sorted by WHO it went to first, then by subject. Sorting on the subject
   alone put the new driver reminder ("Reminder — upcoming job — REF") in the
   owner's pile, because his starts "Reminder —" too. */
const riderMails  = () => SENT.filter((m) => m.to === 'ben@example.com');
const ownerMails  = () => SENT.filter((m) => m.to === 'owner@example.com' && /pickup/.test(m.subject));
const driverMails = () => SENT.filter((m) => /^Reminder — upcoming job/.test(m.subject));

console.log('\nThe customer\'s 12-hour reminder');

// ── 1. THE INDEPENDENT LATCH ─────────────────────────────────────────────
test('the customer gets their own reminder, alongside the owner\'s', async () => {
  const t = soonDateTime();
  const b = seed({ date: t.date, time: t.time });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(ownerMails().length, 1, 'the owner still gets his');
  assert.strictEqual(riderMails().length, 1, 'and the customer now gets one too');
  assert.strictEqual(riderMails()[0].to, 'ben@example.com', 'addressed to the RIDER');
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  assert.ok(row.reminder_sent_at, 'the owner latch is stamped');
  assert.ok(row.customer_reminder_sent_at, 'and the customer latch is stamped separately');
});

test('it sends ONCE — a second sweep sends nothing', async () => {
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(riderMails().length, 0, 'no duplicate customer reminder');
  assert.strictEqual(ownerMails().length, 0, 'and no duplicate owner reminder');
});

test('the two latches are genuinely independent', async () => {
  // The owner's has gone; the customer's has not. The customer must still get
  // theirs — under one shared latch they never would, and nothing would error.
  const t = soonDateTime();
  const b = seed({ date: t.date, time: t.time });
  db.prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(riderMails().length, 1, 'the customer reminder must still fire');
  assert.strictEqual(ownerMails().length, 0, 'and the owner must not be told twice');
});

test('a CANCELLED booking gets no reminder at all', async () => {
  const t = soonDateTime();
  seed({ date: t.date, time: t.time, status: 'cancelled' });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(riderMails().length, 0, 'a cancelled journey must not be reminded');
  assert.strictEqual(ownerMails().length, 0);
});

test('a booking with no customer email is skipped without breaking the sweep', async () => {
  const t = soonDateTime();
  const b = seed({ date: t.date, time: t.time, email: null });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(riderMails().length, 0, 'nothing to send to');
  assert.strictEqual(ownerMails().length, 1, 'but the OWNER still gets his');
  assert.strictEqual(db.prepare('SELECT customer_reminder_sent_at c FROM bookings WHERE id = ?').get(b.id).c, null,
    'and the latch stays open in case an address is added later');
});

// ── 2. WHAT IT SAYS ──────────────────────────────────────────────────────
console.log('\nWhat the rider reminder says');

let LAST_REF = null;
async function render(o) {
  SENT = [];
  const b = seed(Object.assign({ date: '2026-12-18', time: '09:30' }, o));
  LAST_REF = b.ref;
  const lock = paymentLock(b);
  await email.sendCustomerJourneyReminder(
    // driver_* ride alongside the row the way the sweep's JOIN supplies them.
    Object.assign({}, b, { email: b.passenger_email,
      driver_name: o && o.driver_name, driver_vehicle: o && o.driver_vehicle,
      driver_reg: o && o.driver_reg,
      // The ad-hoc driver's details come off the BOOKING row, not a users join
      // — which is the whole point of them living there.
      assigned_to_name: o && o.assigned_to_name,
      assigned_to_car: o && o.assigned_to_car,
      assigned_to_reg: o && o.assigned_to_reg }),
    { gapMs: (o && o.gapMs !== undefined) ? o.gapMs : 12 * 3600 * 1000,
      pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
  return SENT[0];
}

test('it greets properly — never "Dear Mr,"', async () => {
  for (const name of ['Mr Ben Chan', 'Ben Chan', 'Dr Sarah Whitfield', 'Ben']) {
    const m = await render({ name });
    assert.ok(!/Dear\s+(Mr|Mrs|Ms|Miss|Dr|Sir),/.test(m.html),
      'title-only greeting for ' + JSON.stringify(name) + ' — greetingName() is there to stop this');
    assert.ok(/Dear \w/.test(m.html), 'and it must still greet somebody');
  }
});

test('it states NO countdown — the owner had it taken out', async () => {
  /* This used to assert the opposite: that the email said "booked for in about
     12 hours" and put the same phrase in the subject. The owner asked for it
     gone. A customer who opens the email four hours later is being told
     something that is no longer true, and the number adds nothing they cannot
     read from the pickup time two lines below.

     The TRIGGER is unchanged — reminder.js still sweeps the same 12-hour
     window, and the tests for that window are untouched. This is about wording
     only. */
  for (const gapMs of [12 * 3600 * 1000, 5.4 * 3600 * 1000, 45 * 60 * 1000]) {
    const m = await render({ gapMs });
    const said = (m.html.match(/in about [^<.,]{1,24}|booked for [^<.]{1,24}/gi) || []);
    assert.deepStrictEqual(said, [], 'no countdown may appear: ' + said.join(' | '));
    assert.ok(!/hours?\b|minutes?\b/i.test(m.subject), 'nor in the subject: ' + m.subject);
  }
  const m = await render({ gapMs: 5 * 3600 * 1000 });
  assert.ok(/your journey with us is coming up/i.test(m.html),
    'it opens with the general line instead');
  assert.strictEqual(m.subject, 'A reminder about your upcoming journey — ' + LAST_REF,
    'and the subject is a plain reminder, not a number: ' + m.subject);
  /* The pickup time is NOT a countdown and must stay. */
  assert.ok(/Date &amp; Time|Date & Time/.test(m.html), 'the pickup time still shows');
});

test('WHO IS COMING — registered, then ad-hoc, then the owner', async () => {
  /* The customer's question is "which car do I look for". Three sources, in
     order, and each answers with all three of its own values — a set, not three
     independent fields. Falling back per-field would put a registered driver's
     name against the owner's Tesla and send the passenger to the wrong car. */
  const block = (h) => {
    const m = /Your driver and car<\/p>\s*<p[^>]*>([^<]*)<\/p>\s*<p[^>]*>([^<]*)</.exec(h);
    return m ? { line: m[1].replace(/&mdash;/g, '—').trim(), reg: m[2].trim() } : null;
  };

  const reg = block((await render({
    driver_name: 'Dave Driver', driver_vehicle: 'Mercedes E-Class', driver_reg: 'AB12 CDE' })).html);
  assert.deepStrictEqual(reg, { line: 'Dave Driver — Mercedes E-Class', reg: 'AB12 CDE' },
    'a registered driver wins');

  const adhoc = block((await render({
    assigned_to_name: 'Sam Cole', assigned_to_car: 'Skoda Superb, dark grey', assigned_to_reg: 'LT21 XYZ' })).html);
  assert.deepStrictEqual(adhoc, { line: 'Sam Cole — Skoda Superb, dark grey', reg: 'LT21 XYZ' },
    'an ad-hoc driver who accepted comes next — off the BOOKING row, no users join');

  const none = block((await render({})).html);
  assert.deepStrictEqual(none, { line: 'Nikodem — Tesla Model S', reg: 'ML68 YHC' },
    'and with nobody assigned it is the owner in his own car');

  const both = block((await render({
    driver_name: 'Dave Driver', driver_vehicle: 'Mercedes E-Class', driver_reg: 'AB12 CDE',
    assigned_to_name: 'Sam Cole', assigned_to_car: 'Skoda', assigned_to_reg: 'LT21 XYZ' })).html);
  assert.strictEqual(both.line, 'Dave Driver — Mercedes E-Class', 'registered beats ad-hoc');
  assert.strictEqual(both.reg, 'AB12 CDE', 'and takes ITS registration, not a mix');
});

test('a source with a missing car falls back only INSIDE itself', async () => {
  const h = (await render({ assigned_to_name: 'Sam Cole' })).html;
  assert.ok(/Sam Cole/.test(h), 'the person who is actually coming keeps their name');
  assert.ok(/Tesla Model S/.test(h) && /ML68 YHC/.test(h),
    'and only the values they did not supply fall through');
  assert.ok(!/Nikodem/.test(h), 'the name must NOT revert to the owner');
});

test('the resolution order is stated once, not copied per email', () => {
  const src = read('server/email.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual((src.match(/function driverDetails\(/g) || []).length, 1,
    'one place decides who is coming');
  assert.ok(/assigned_to_name/.test(src) && /driver_name/.test(src),
    'and it knows about both kinds of driver');
});

test('it carries the reference, the route and a contact number', async () => {
  const m = await render({ pickup: '14 Greenhill Avenue, Caterham', destination: 'London Gatwick Airport' });
  assert.ok(/WPH-R\d+/.test(m.html), 'the booking reference');
  assert.ok(/Caterham/.test(m.html) && /Gatwick/.test(m.html), 'both ends of the journey');
  assert.ok(/07930/.test(m.html), 'and a number to call');
});

test('a stop in the middle is shown', async () => {
  const m = await render({ stop_address: '9 Hill Road, Burgess Hill' });
  assert.ok(/Burgess Hill/.test(m.html), 'the stop must not be dropped');
});

test('an AIRPORT journey carries meet & greet and flight tracking', async () => {
  const m = await render({ destination: 'London Gatwick Airport', flight: 'BA2751' });
  assert.ok(/Meet &amp; greet included<\/strong> &mdash; your driver will meet you at arrivals and help with your luggage\./.test(m.html), 'meet & greet');
  assert.ok(!/name board/i.test(m.html), 'and no name board — the owner pulled it');
  assert.ok(/Airport parking is included in your fare/.test(m.html), 'parking');
  assert.ok(/We track your flight, so delays are no problem/.test(m.html), 'flight tracking');
  assert.ok(!/at no extra charge|added separately|charged by the airport/.test(m.html),
    'and none of the wording the owner pulled');
  assert.ok(/flightaware\.com\/live\/flight\/BA2751/.test(m.html), 'with a working tracker link');
});

test('a TOWN-TO-TOWN journey carries none of it', async () => {
  const m = await render({ pickup: 'Lewes, BN7 2AN', destination: 'Brighton, BN1 1AA', flight: 'BA2751' });
  assert.ok(!/Meet &amp; greet included/.test(m.html), 'no meet & greet');
  assert.ok(!/We track your flight/.test(m.html), 'no flight tracking, even with a flight typed in');
  assert.ok(!/Your airport transfer/.test(m.html), 'nor the block heading');
});

test('it uses the SAME airport block as the confirmation', () => {
  // Two copies of a promise is how one of them stops matching the other.
  const src = read('server/email.js');
  assert.ok(/function airportBlockHtml\(d\)/.test(src), 'the shared builder must exist');
  assert.strictEqual((src.match(/Meet &amp; greet included/g) || []).length, 1,
    'the meet & greet sentence must exist in exactly ONE place');
  assert.strictEqual((src.match(/We track your flight, so delays are no problem/g) || []).length, 1,
    'and so must the flight-tracking sentence');
  // The car is one renderer too, for the same reason.
  assert.ok(/function driverBlockHtml\(d\)/.test(src), 'the shared driver/car builder must exist');
  assert.strictEqual((src.match(/Your driver and car/g) || []).length, 1,
    'the driver/car strip must exist in exactly ONE place');
});

// ── 3. PAYMENT ───────────────────────────────────────────────────────────
test('an unpaid, undecided booking gets BOTH payment doors', async () => {
  const m = await render({ payment: 'pending', fare: 129 });
  assert.ok(/Pay £129\.00 Now/.test(m.html), 'the card door');
  assert.ok(/Pay Your Driver On The Day/.test(m.html), 'and the cash door');
});

test('a cash-locked or settled booking gets NO buttons', async () => {
  for (const o of [{ payment: 'cash' }, { payment: 'card', paid_at: '2026-08-20' }, { fare: null }]) {
    const m = await render(o);
    assert.ok(!/Pay .*Now &mdash; Card/.test(m.html),
      'no card button for ' + JSON.stringify(o) + ' — that is the dead end');
    assert.ok(!/Pay Your Driver On The Day/.test(m.html), 'and no cash button either');
  }
});

test('a test send can be addressed to the owner instead', async () => {
  // The standing rule: a new customer email must be testable to the owner's own
  // inbox before it ever reaches a customer.
  SENT = [];
  const b = seed({ date: '2026-12-18', time: '09:30' });
  await email.sendCustomerJourneyReminder(Object.assign({}, b, { email: b.passenger_email }),
    { gapMs: 12 * 3600 * 1000, testTo: 'owner@example.com', pay: { payable: false, amountDue: null } });
  assert.strictEqual(SENT[0].to, 'owner@example.com', 'testTo must override the recipient');
});

// ── 4. SEND MESSAGE ──────────────────────────────────────────────────────
console.log('\n"Send Message" — pay links only while there is a choice to make');

async function message(state) {
  SENT = [];
  const lock = paymentLock(state);
  await email.sendCustomerMessage(
    { ref: 'WPH-M1', name: 'Mr Ben Chan', email: 'ben@example.com',
      pay_token: lock.payable ? 'tok123' : null },
    'Your driver will be Nikodem in a black Mercedes.',
    { pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
  return SENT[0];
}
const hasCard = (h) => /Pay .*Now &mdash; Card/.test(h);
const hasCash = (h) => /Pay Your Driver On The Day/.test(h);

test('a pending, payable booking gets both doors under the message', async () => {
  const m = await message({ ref: 'R', fare: 88, status: 'pending', payment: 'pending', paid_at: null });
  assert.ok(/black Mercedes/.test(m.html), "the owner's own words are always the body");
  assert.ok(hasCard(m.html) && hasCash(m.html), 'and both payment doors follow');
  assert.ok(/westmere-pay\.html\?ref=WPH-M1&t=tok123/.test(m.html), 'with a tokenised link');
});

test('a CASH-LOCKED booking gets the message and nothing to press', async () => {
  const m = await message({ ref: 'R', fare: 88, status: 'awaiting_payment', payment: 'cash', paid_at: null });
  assert.ok(/black Mercedes/.test(m.html), 'the message still goes');
  assert.ok(!hasCard(m.html), 'NO card button — it would be refused by the pay page');
  assert.ok(!hasCash(m.html), 'and no cash button, they have already chosen');
});

test('a PAID booking gets no payment block', async () => {
  const m = await message({ ref: 'R', fare: 88, status: 'confirmed', payment: 'card', paid_at: '2026-08-20' });
  assert.ok(!hasCard(m.html) && !hasCash(m.html), 'nothing is owed');
});

test('a booking with NO FARE gets no payment block', async () => {
  const m = await message({ ref: 'R', fare: null, status: 'pending', payment: 'pending', paid_at: null });
  assert.ok(!hasCard(m.html) && !hasCash(m.html), 'there is no amount to offer');
});

test('the route asks paymentLock and mints a token only when payable', () => {
  const api = read('server/api.js');
  // Brace-matched, not character-counted: a fixed slice silently stops covering
  // the route as soon as it grows. server/tests/_source.js exists for this.
  const { routeBlock } = require('./_source');
  const seg = routeBlock(api, "router.post('/bookings/:id/send-message'");
  assert.ok(seg, 'the send-message route is missing');
  assert.ok(/paymentLock\(b\)/.test(seg), 'it must ask the lock');
  assert.ok(/lock\.payable[\s\S]{0,120}ensurePayToken/.test(seg),
    'and mint a token only when there is something to pay');
  assert.ok(/pay: \{ payable: !!lock\.payable, amountDue: lock\.amountDue \}/.test(seg),
    'and hand the decision to the email rather than deciding twice');
});

/* ── 4. THE CAR, AND THE CLOSING LINE ───────────────────────────────────
   Twelve hours out is exactly when a customer wants the plate. */
console.log('\nDriver, vehicle, registration and the sign-off');

test('the reminder names the driver, the car and the plate', async () => {
  const m = await render({ pickup: 'Lewes, BN7 2AN', destination: 'Brighton, BN1 1AA' });
  assert.ok(/Your driver and car/.test(m.html), 'the row must be labelled');
  assert.ok(/Nikodem/.test(m.html) && /Tesla Model S/.test(m.html) && /ML68 YHC/.test(m.html),
    'driver, car and registration');
});

test('an ASSIGNED driver overrides the default here too', async () => {
  const m = await render({ pickup: 'Lewes', destination: 'Brighton',
    driver_name: 'Sam Whitfield', driver_vehicle: 'Mercedes E-Class', driver_reg: 'LT19 KPX' });
  assert.ok(/Sam Whitfield/.test(m.html) && /LT19 KPX/.test(m.html), 'the assigned car');
  assert.ok(!/ML68 YHC/.test(m.html), 'and not the fallback as well');
});

test('the sweeper actually fetches the assigned driver', () => {
  // The override above is worth nothing if nothing ever passes the columns in.
  const src = read('server/reminder.js');
  assert.ok(/LEFT JOIN users\s+d ON b\.driver_id/.test(src),
    'the reminder sweep must join the assigned driver');
  assert.ok(/d\.full_name AS driver_name[\s\S]{0,120}d\.reg AS driver_reg/.test(src),
    'and select his name, car and plate');
});

test('the sign-off does not over-promise', async () => {
  const m = await render({ pickup: 'Lewes', destination: 'Brighton' });
  assert.ok(/If anything has changed, reply to this email or call us on/.test(m.html),
    'the invitation to get in touch stays');
  assert.ok(/07930/.test(m.html), 'with the number');
  assert.ok(!/sort it out/.test(m.html), 'but not the promise the owner pulled');
});

/* ── 5. THE WAY OUT, UNDER THE PAY DOORS ────────────────────────────────
   The owner's ask: a customer who still owes money should be offered the
   cancel as well as the pay. Two things have to hold, and the second is the
   dangerous one:

     • it is offered ONLY where paymentLock says the booking is payable —
       a PAID trip must never carry an auto-cancel link, because cancelling
       one is a refund, not a status flip;
     • the link in the email must NOT cancel anything on its own. Mail
       scanners fetch every URL in an inbox. A GET that mutates would cancel
       cars nobody meant to cancel, silently, at scale.

   The route already worked this way for the confirmation email's Cancel
   Request; this reuses it rather than minting a second cancel path. The
   end-to-end test below drives the REAL express routes to prove it. */
console.log('\nThe cancel link under the pay doors');

const CANCEL_RE = /\/api\/public\/cancel\/([A-Z0-9-]+)\?t=([^"&]+)/;
const hasCancelOffer = (h) => /Need to cancel\?/.test(h) && /Cancel this trip/.test(h);

test('an UNPAID, payable reminder offers the cancel beneath the pay buttons', async () => {
  const m = await render({ payment: 'pending', fare: 129, paid_at: null });
  assert.ok(/Pay £129\.00 Now/.test(m.html), 'the pay door is there');
  assert.ok(hasCancelOffer(m.html), 'and so is the way out');
  const link = CANCEL_RE.exec(m.html);
  assert.ok(link, 'the cancel link must be tokenised');
  assert.strictEqual(link[2], 'tok123', 'with the booking\'s own pay_token');
  // Order matters: the exit sits UNDER the offer, not above it.
  assert.ok(m.html.indexOf('Pay Your Driver On The Day') < m.html.indexOf('Need to cancel?'),
    'the cancel must sit beneath the pay buttons');
});

test('a CASH-chosen, a PAID and an UNPRICED booking get NO cancel link', async () => {
  for (const [label, o] of [
    ['cash-locked', { payment: 'cash', fare: 129 }],
    ['paid',        { payment: 'card', fare: 129, paid_at: '2026-01-01 10:00:00' }],
    ['no fare',     { payment: 'pending', fare: null }],
  ]) {
    const m = await render(o);
    assert.ok(!hasCancelOffer(m.html), label + ' must not carry an auto-cancel link');
  }
});

test('the owner\'s Send Message follows the same rule', async () => {
  const payable = seed({ payment: 'pending', fare: 129, date: '2026-12-18', time: '09:30' });
  let lock = paymentLock(payable);
  SENT = [];
  await email.sendCustomerMessage(Object.assign({}, payable, { email: payable.passenger_email }),
    'Your driver will be five minutes early.',
    { pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
  assert.ok(hasCancelOffer(SENT[0].html), 'an unpaid booking gets the cancel offer');
  assert.ok(CANCEL_RE.test(SENT[0].html), 'tokenised');

  const paid = seed({ payment: 'card', fare: 129, paid_at: '2026-01-01 10:00:00', date: '2026-12-18', time: '09:30' });
  lock = paymentLock(paid);
  SENT = [];
  await email.sendCustomerMessage(Object.assign({}, paid, { email: paid.passenger_email }),
    'Your driver will be five minutes early.',
    { pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
  assert.ok(!hasCancelOffer(SENT[0].html), 'a PAID booking must not — that is refund territory');
});

test('one renderer, so the two emails cannot drift apart', () => {
  const src = read('server/email.js');
  assert.ok(/function cancelLinkHtml\(ref, token\)/.test(src), 'the shared builder must exist');
  assert.strictEqual((src.match(/Need to cancel\?/g) || []).length, 1,
    'the cancel offer must exist in exactly ONE place');
});

/* The dangerous half: prove it against the REAL routes, not a regex. */
const express = require('express');
const http = require('http');
const publicApi = require('../public-api');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/api/public', publicApi);
let server, port;
const req = (method, path) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, path, method }, (s) => {
    let d = ''; s.on('data', (c) => d += c); s.on('end', () => res({ status: s.statusCode, body: d }));
  });
  r.on('error', rej); r.end();
});
const statusOf = (ref) => db.prepare('SELECT status FROM bookings WHERE ref = ?').get(ref).status;

test('the raw email link does NOT cancel on GET — it asks first', async () => {
  const b = seed({ payment: 'pending', fare: 129, date: '2026-12-18', time: '09:30' });
  const url = '/api/public/cancel/' + b.ref + '?t=tok123';
  const r = await req('GET', url);
  assert.strictEqual(r.status, 200, 'the page renders');
  assert.strictEqual(statusOf(b.ref), 'confirmed', 'and the booking is UNTOUCHED by the fetch');
  assert.ok(/<form method="POST"/.test(r.body), 'it must offer a form, not have already acted');
  assert.ok(/Confirm/.test(r.body), 'with an explicit confirmation button');
  // A scanner fetching it ten times still must not cancel anybody's car.
  for (let i = 0; i < 3; i++) await req('GET', url);
  assert.strictEqual(statusOf(b.ref), 'confirmed', 'repeated prefetch is still harmless');
});

test('the confirm page calls it a TRIP once booked, a REQUEST before', async () => {
  const booked = seed({ payment: 'pending', fare: 129, status: 'confirmed', date: '2026-12-18', time: '09:30' });
  const r1 = await req('GET', '/api/public/cancel/' + booked.ref + '?t=tok123');
  assert.ok(/Cancel this trip\?/.test(r1.body), 'a confirmed booking is a trip');
  assert.ok(!/Cancel your request\?/.test(r1.body), 'and must not also call itself a request');
  assert.ok(/plans have changed/.test(r1.body), 'with the wording that fits a booked car');

  const quoted = seed({ payment: 'pending', fare: 129, status: 'pending', date: '2026-12-18', time: '09:30' });
  const r2 = await req('GET', '/api/public/cancel/' + quoted.ref + '?t=tok123');
  assert.ok(/Cancel your request\?/.test(r2.body), 'an unconfirmed one is still a request');
  assert.ok(/price or timing/.test(r2.body), 'with the estimate-stage wording');

  // Whatever the words, the safety is the same page: a form, never a done deed.
  for (const r of [r1, r2]) assert.ok(/<form method="POST"/.test(r.body), 'both must still ask first');
  assert.strictEqual(statusOf(booked.ref), 'confirmed', 'and neither may cancel on the GET');
  assert.strictEqual(statusOf(quoted.ref), 'pending');
});

test('confirming on that page cancels the trip and tells the owner', async () => {
  const b = seed({ payment: 'pending', fare: 129, date: '2026-12-18', time: '09:30' });
  const url = '/api/public/cancel/' + b.ref + '?t=tok123';
  SENT = [];
  const r = await req('POST', url);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(statusOf(b.ref), 'cancelled', 'the booking must actually be cancelled');
  // The route fires the owner alert without awaiting it (a slow mailer must not
  // hold up the customer's page), so give the promise a few ticks to land.
  let owner = null;
  for (let i = 0; i < 40 && !owner; i++) {
    owner = SENT.find((m) => /cancel/i.test(m.subject));
    if (!owner) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(owner, 'the owner must be told — reusing the existing rider-cancel alert');
  assert.ok(owner.html.indexOf(b.ref) !== -1, 'and told WHICH booking');
});

test('a wrong or missing token cancels nothing', async () => {
  const b = seed({ payment: 'pending', fare: 129, date: '2026-12-18', time: '09:30' });
  for (const q of ['?t=wrong', '']) {
    const r = await req('POST', '/api/public/cancel/' + b.ref + q);
    assert.ok(r.status >= 400, 'a bad token must be refused (' + q + ')');
  }
  assert.strictEqual(statusOf(b.ref), 'confirmed', 'and the booking must survive it');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/rider-reminder\.test\.js/.test(read('package.json')));
});

(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }); });
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { server.close(); } catch (_) {}
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
