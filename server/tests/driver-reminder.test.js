/**
 * THE DRIVER'S OWN REMINDER, before pickup — run with:
 *   node server/tests/driver-reminder.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   Three emails now go out on one sweep: the owner's pickup reminder, the
 *   customer's journey reminder, and this one — the job, sent back to whoever
 *   is actually driving it. Each has its own latch, and the failure this file
 *   exists to prevent is any of them quietly suppressing another.
 *
 *   Two more things are pinned because getting them wrong is expensive rather
 *   than untidy:
 *     · NO ACCEPT OR DECLINE. The job is already theirs. A stray tap the night
 *       before pickup would unassign a confirmed booking.
 *     · THE RIGHT PERSON. The recipient resolves in the same order the
 *       customer's "Your driver and car" block does. If the two disagree, one
 *       driver is reminded about a job the customer is expecting somebody else
 *       to run.
 *
 *   The whole file runs against a throwaway database with Resend stubbed.
 *   Nothing is sent. Exit 1 on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-driver-reminder-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
process.env.OWNER_REMINDER_EMAIL = 'owner@example.com';
process.env.ADMIN_EMAIL = 'owner@example.com';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const reminder = require('../reminder');
const email = require('../email');
const { getDb } = require('../db');
const db = getDb();

let SENT = [];
global.fetch = async (u, o) => {
  const b = JSON.parse(o.body);
  SENT.push({ to: b.to, subject: b.subject, html: b.html, attachments: b.attachments || [] });
  return { ok: true, status: 200, json: async () => ({ id: 'rid' }) };
};
const driverMails = () => SENT.filter((m) => /^Reminder — upcoming job/.test(m.subject));
const ownerMails  = () => SENT.filter((m) => m.to === 'owner@example.com' && /pickup/.test(m.subject));
const riderMails  = () => SENT.filter((m) => m.to === 'rider@example.com');

let n = 0;
function seed(o) {
  o = o || {};
  const ref = 'WPH-D' + (++n);
  const t = soonDateTime();
  db.prepare(`INSERT INTO bookings (ref, pickup, destination, stop_address, date, time, fare, status,
              payment, passenger_name, passenger_phone, passenger_email, flight, bags, passengers,
              pay_token, driver_id, assigned_to_name, assigned_to_email, assigned_to_reg, assigned_to_car)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ref, 'The Grand Hotel, Brighton', 'London Gatwick Airport, South Terminal',
    o.stop_address === undefined ? 'Lewes Station' : o.stop_address,
    o.date || t.date, o.time || t.time, 129, o.status || 'confirmed', 'card',
    'Mr Ben Chan', '07700 900123', 'rider@example.com', 'BA2751', '2 large', 3, 'tok123',
    o.driver_id || null, o.assigned_to_name || null, o.assigned_to_email || null,
    o.assigned_to_reg || null, o.assigned_to_car || null);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
// A pickup ~10h out, in the same naive UK wall-clock the sweep reads.
function soonDateTime() {
  const d = new Date(reminder.ukNowMs() + 10 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return { date: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()),
           time: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) };
}
function mkDriver(id, email_) {
  db.prepare(`INSERT OR REPLACE INTO users (id, username, password, full_name, email, role, active, vehicle, reg)
              VALUES (?,?,'x',?,?,'driver',1,'Mercedes E-Class','AB12 CDE')`)
    .run(id, 'driver' + id, 'Dave Driver', email_);
}

// ── 1. WHO IT GOES TO ────────────────────────────────────────────────────
console.log('\nWho gets reminded');

test('a REGISTERED driver is reminded at their account email', async () => {
  mkDriver(21, 'dave@example.com');
  seed({ driver_id: 21 });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 1, 'exactly one driver reminder');
  assert.strictEqual(driverMails()[0].to, 'dave@example.com', 'to the account on file');
});

test('an AD-HOC driver is reminded at the address the owner typed', async () => {
  seed({ assigned_to_name: 'Sam Cole', assigned_to_email: 'sam@example.com',
         assigned_to_reg: 'LT21 XYZ', assigned_to_car: 'Skoda Superb, dark grey' });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 1);
  assert.strictEqual(driverMails()[0].to, 'sam@example.com',
    'they have no account — the only address is the one copied on accept');
});

test('the address survives ACCEPT, which clears the offer', () => {
  /* offered_to_email is wiped when an offer is taken, and rightly — the offer
     is spent. If the address were not copied first there would be nowhere to
     send this email, and the guard above would pass against a stale column. */
  const src = read('server/offer-routes.js');
  const fn = src.slice(src.indexOf('function acceptAdhocOffer'), src.indexOf('function declineAdhocOffer'));
  assert.ok(/assigned_to_email\s*=\s*offered_to_email/.test(fn), 'the address is copied across');
  assert.ok(fn.indexOf('assigned_to_email') < fn.indexOf('offered_to_email = NULL'),
    'and copied BEFORE the offer is cleared');
});

test('with NOBODY assigned it is the owner, and he is not told twice', async () => {
  const b = seed({});
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(ownerMails().length, 1, 'he gets the owner pickup reminder');
  assert.strictEqual(driverMails().length, 0,
    'and NOT a second email about the same job — he is the default driver');
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  assert.ok(row.driver_reminder_sent_at,
    'the latch is still stamped, so the decision is not reconsidered every sweep');
});

test('but if the OWNER reminder did not go, he is reminded as the driver', async () => {
  /* The dedupe is only ever allowed to remove a DUPLICATE. With no owner
     reminder sent there is nothing to duplicate, and the job must still reach
     the man driving it. */
  const b = seed({});
  db.prepare("UPDATE bookings SET reminder_sent_at = NULL WHERE id = ?").run(b.id);
  const rows = [db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id)];
  const who = reminder.assignedDriverEmail(rows[0], 'owner@example.com');
  assert.deepStrictEqual(who, { email: 'owner@example.com', source: 'default' });
});

test('a driver with no address on file is skipped, NOT redirected to the owner', () => {
  /* Sending it to the owner would tell him to drive a job somebody else is
     running. Nothing goes, and the latch stays open for an address added later. */
  const who = reminder.assignedDriverEmail(
    { driver_name: 'Dave Driver', driver_account_email: null }, 'owner@example.com');
  assert.strictEqual(who.email, null);
  assert.strictEqual(who.source, 'unreachable');
  const adhoc = reminder.assignedDriverEmail(
    { assigned_to_name: 'Sam Cole', assigned_to_email: '' }, 'owner@example.com');
  assert.strictEqual(adhoc.email, null, 'the same for an ad-hoc driver with no address');
});

test('it resolves in the SAME order the customer is told', () => {
  /* If these two disagree, one driver is reminded about a job the customer is
     expecting somebody else to run. Both are asked the same question here. */
  const row = { driver_name: 'Dave Driver', driver_account_email: 'dave@example.com',
                driver_vehicle: 'Mercedes E-Class', driver_reg: 'AB12 CDE',
                assigned_to_name: 'Sam Cole', assigned_to_email: 'sam@example.com',
                assigned_to_car: 'Skoda', assigned_to_reg: 'LT21 XYZ' };
  assert.strictEqual(reminder.assignedDriverEmail(row, 'owner@example.com').source, 'registered');
  assert.strictEqual(email.driverDetails(row).source, 'registered',
    'the customer is told about the registered driver, so the registered driver is the one reminded');

  delete row.driver_name; delete row.driver_account_email;
  assert.strictEqual(reminder.assignedDriverEmail(row, 'owner@example.com').source, 'adhoc');
  assert.strictEqual(email.driverDetails(row).source, 'adhoc');

  delete row.assigned_to_name; delete row.assigned_to_email;
  assert.strictEqual(reminder.assignedDriverEmail(row, 'owner@example.com').source, 'default');
  assert.strictEqual(email.driverDetails(row).source, 'default');
});

// ── 2. THE LATCH ─────────────────────────────────────────────────────────
console.log('\nOnce, and independently of the other two');

test('it sends ONCE — a second sweep sends nothing', async () => {
  mkDriver(22, 'dave2@example.com');
  seed({ driver_id: 22 });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 1);
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 0, 'no duplicate');
});

test('its latch is its own — the other two cannot suppress it', async () => {
  mkDriver(23, 'dave3@example.com');
  const b = seed({ driver_id: 23 });
  db.prepare(`UPDATE bookings SET reminder_sent_at = datetime('now'),
              customer_reminder_sent_at = datetime('now') WHERE id = ?`).run(b.id);
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 1,
    'both other latches shut, and the driver must STILL be reminded');
  assert.strictEqual(ownerMails().length, 0);
  assert.strictEqual(riderMails().length, 0);
});

test('and it cannot suppress the other two', async () => {
  mkDriver(24, 'dave4@example.com');
  const b = seed({ driver_id: 24 });
  db.prepare("UPDATE bookings SET driver_reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 0);
  assert.strictEqual(ownerMails().length, 1, 'the owner still gets his');
  assert.strictEqual(riderMails().length, 1, 'and the customer still gets theirs');
});

test('three latches, three columns', () => {
  const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  for (const c of ['reminder_sent_at', 'customer_reminder_sent_at', 'driver_reminder_sent_at']) {
    assert.ok(cols.includes(c), c + ' is missing');
  }
  assert.ok(/ALTER TABLE bookings ADD COLUMN driver_reminder_sent_at/.test(read('server/db.js')),
    'added, never a rebuild');
});

test('a CANCELLED booking reminds nobody', async () => {
  mkDriver(25, 'dave5@example.com');
  seed({ driver_id: 25, status: 'cancelled' });
  SENT = [];
  await reminder.sweepDueReminders();
  assert.strictEqual(driverMails().length, 0, 'a cancelled job must not be reminded');
  assert.strictEqual(ownerMails().length, 0);
  assert.strictEqual(riderMails().length, 0);
});

// ── 3. WHAT IT SAYS ──────────────────────────────────────────────────────
console.log('\nWhat the driver reminder says');

const JOB = { ref: 'WPH-7001', driver_email: 'dave@example.com',
  pickup: 'The Grand Hotel, Kings Road, Brighton',
  destination: 'London Gatwick Airport, South Terminal', stop_address: 'Lewes Station',
  date: '2026-12-18', time: '09:30', passengers: 3, bags: '2 large', flight: 'BA2751',
  customer_name: 'Mr Ben Chan', customer_phone: '07700 900123',
  notes: 'Front door pickup', fare: 129, driver_pay: 116.1,
  offer_token: 'SHOULD-NEVER-BE-USED' };

async function renderJob(extra) {
  SENT = [];
  await email.sendDriverJobReminder(Object.assign({}, JOB, extra || {}));
  return SENT[0];
}

test('it carries the whole job — trip, passenger, and the reference', async () => {
  const m = await renderJob();
  for (const s of ['WPH-7001', 'Lewes Station', 'Gatwick Airport', 'BA2751',
                   'Mr Ben Chan', '07700 900123', 'Front door pickup']) {
    assert.ok(m.html.includes(s), 'missing from the reminder: ' + s);
  }
  assert.ok(/Friday, 18 December 2026/.test(m.html), 'the pickup date, rendered from its parts');
  assert.ok(/09:30/.test(m.html), 'and the time');
  assert.ok(/tel:07700900123/.test(m.html), 'the number is tappable — they are ringing from a car');
});

test('the addresses go through to Waze, and the job into a diary', async () => {
  const m = await renderJob();
  const waze = m.html.match(/waze\.com[^"']+/g) || [];
  assert.ok(waze.length >= 3, 'pickup, stop and drop-off are all navigable: ' + waze.length);
  assert.ok(waze.some((u) => /Kings(%20|\+)Road/i.test(u)),
    'and on the FULL address, not the shortened one displayed');
  assert.ok(/calendar\.google\.com/.test(m.html), 'Google Calendar for Android');
  assert.strictEqual(m.attachments.length, 1, 'and the .ics for everyone else');
  assert.strictEqual(m.attachments[0].filename, 'WPH-7001.ics');
});

test('NO accept or decline — the job is already theirs', async () => {
  const m = await renderJob();
  assert.ok(!/Accept This Job/i.test(m.html), 'no accept button');
  assert.ok(!/>Decline</i.test(m.html), 'no decline button');
  /* The token is passed in above on purpose. The email must not build an
     action link even when handed one — a stray tap the night before pickup
     would unassign a confirmed booking. */
  assert.ok(!/api\/public\/offer/.test(m.html), 'and no offer endpoint anywhere in it');
  assert.ok(!/SHOULD-NEVER-BE-USED/.test(m.html), 'the token is not in the email at all');
});

test('no money is restated', async () => {
  /* A registered driver was quoted his pay net of commission; an outside driver
     was quoted the full fare. Repeating either here risks contradicting what
     was agreed, and the figure is already in the email they accepted. */
  const m = await renderJob();
  assert.ok(!/£/.test(m.html.replace(/07930[^<]*/g, '')), 'no figure on the reminder');
});

test('it says what it is — a reminder, not a new offer', async () => {
  const m = await renderJob();
  assert.ok(/You have a job coming up/.test(m.html));
  assert.ok(/this is a reminder, not a new offer/i.test(m.html),
    'said in the email, so nobody waits for a button that is not there');
});

test('NO countdown — not in the body, not in the subject', async () => {
  /* Twelve hours is WHEN it is sent, never what it says. Same rule as the
     customer's. */
  const m = await renderJob();
  const said = (m.html.match(/in about [^<.,]{1,24}|in \d+ (hours?|minutes?)/gi) || []);
  assert.deepStrictEqual(said, [], 'no countdown in the body: ' + said.join(' | '));
  assert.ok(!/hours?\b|minutes?\b/i.test(m.subject), 'nor in the subject: ' + m.subject);
  assert.strictEqual(m.subject, 'Reminder — upcoming job — WPH-7001');
});

test('an ASAP job does not put "Invalid Date" in a driver email', async () => {
  const m = await renderJob({ time: 'ASAP' });
  assert.ok(!/Invalid Date/.test(m.html), 'this shipped once — see CLAUDE.md');
  assert.ok(!/Invalid Date/.test(m.subject));
});

test('no address, no send', async () => {
  SENT = [];
  assert.strictEqual(await email.sendDriverJobReminder(Object.assign({}, JOB, { driver_email: '' })), false);
  assert.strictEqual(SENT.length, 0);
});

test('the trip table is built ONCE for all three driver emails', () => {
  /* It was copied twice; a third copy would have guaranteed the Waze links or
     the flight row drifting apart between the offer and the reminder. */
  const src = read('server/email.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual((src.match(/function jobDetailRows\(/g) || []).length, 1);
  assert.ok((src.match(/jobDetailRows\(d\)/g) || []).length >= 3,
    'the offer, the ad-hoc offer and the reminder all read from it');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/driver-reminder\.test\.js/.test(read('package.json')),
    'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e.message || e).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
