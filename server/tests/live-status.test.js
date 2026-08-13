/**
 * MY ACCOUNT SHOWS THE LIVE BOOKING — run with:
 *   node server/tests/live-status.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   My Account keeps a localStorage copy of the trip list so the page paints
 *   instantly and still works offline. That cache has bitten this app before,
 *   and now it can bite in a way that costs real money: the same estimate is
 *   payable from the email link AND from My Account. A customer who pays via
 *   the email link changes the booking on the SERVER. If My Account went on
 *   drawing its cached copy, it would still be offering "Pay by card" on a trip
 *   that is already paid.
 *
 *   So: the booking record is the single source of truth, the cache is only ever
 *   a fallback, and the status chip and the action buttons are BOTH derived from
 *   the same server-sourced row — they cannot disagree with each other or with
 *   what the email channel would show.
 *
 * WHAT THIS PINS
 *   (a) after an email-link payment, a My Account fetch shows PAID and offers
 *       no second payment — in either direction;
 *   (b) the actions offered always match the server's current status;
 *   (c) every field the status is derived from survives the server → client
 *       mapping (a dropped column is a silently wrong status);
 *   (d) the list re-syncs on load, after every action, and when the tab is
 *       brought back to the front;
 *   (e) none of it can blank the page.
 *
 * Runs the SHIPPED derivation functions out of westmere-rider.html against rows
 * shaped exactly as GET /api/bookings returns them. Exit 1 on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Database = require('better-sqlite3');

const TMP_DB = path.join(os.tmpdir(), 'wm-live-status-' + process.pid + '.db');
try { fs.unlinkSync(TMP_DB); } catch (_) {}
process.env.SQLITE_DB = TMP_DB;
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch (_) {} } });

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const RIDER = read('westmere-rider.html');
const apiSrc = read('server/api.js');
const publicSrc = read('server/public-api.js');

// ── Load the SHIPPED derivation functions ────────────────────────────────
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'westmere-rider.html no longer defines ' + name + '()');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}
const sandbox = { console, parseFloat, parseInt, isFinite, String, Number, Date, JSON, Array, Object };
vm.createContext(sandbox);
vm.runInContext(
  extractFn(RIDER, '_payState') + '\n' +
  extractFn(RIDER, '_tripStatus') + '\n' +
  extractFn(RIDER, '_tripActions') + '\n', sandbox);
const { _tripStatus, _tripActions, _payState } = sandbox;

// ── The client mapping, applied to a real /api/bookings row ──────────────
// Pulled out of loadServerTrips() so a column dropped from the mapping fails
// here rather than silently showing the customer the wrong status.
const MAPPING = (() => {
  const i = RIDER.indexOf('return{id:b.id,ref:b.ref,from:b.pickup');
  assert.ok(i !== -1, 'loadServerTrips no longer maps server rows the expected way');
  const end = RIDER.indexOf('};', i);
  return RIDER.slice(i, end + 1);
})();
const mapRow = new Function('b', MAPPING);

const TODAY = '2026-08-13';
const FUTURE = '2026-09-06';
const PAST = '2026-07-01';

// A booking exactly as GET /api/bookings hands it back.
function serverRow(over) {
  return Object.assign({
    id: 10, ref: 'WPH-LIVE1', pickup: 'Lewes High Street', destination: 'Gatwick Airport',
    stop_address: null, date: FUTURE, time: '09:00', passengers: 2, bags: '2s+0l', flight: null,
    fare: 137, payment: 'pending', status: 'pending', paid_at: null,
    created_at: '2026-08-01', driver_vehicle: null, driver_name: null, driver_reg: null,
    re_estimated_at: null, change_requested_at: null
  }, over || {});
}
const asClient = (over) => mapRow(serverRow(over));

// ══════════════════════════════════════════════════════════════════════════
console.log('\nEvery field the status depends on survives the server → client mapping');

test('the mapping carries status, payment, paid_at, change + re-estimate stamps', () => {
  const c = asClient({ payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed',
                       change_requested_at: '2026-08-13 09:00', re_estimated_at: '2026-08-12 08:00' });
  for (const [field, value] of [['status', 'confirmed'], ['payment', 'card'], ['paidAt', '2026-08-13 10:00'],
                                ['changeRequestedAt', '2026-08-13 09:00'], ['reEstimatedAt', '2026-08-12 08:00']]) {
    assert.strictEqual(c[field], value,
      'the client row lost ' + field + ' — My Account would then show a status the server does not agree with');
  }
  assert.strictEqual(c.id, 10, 'without the id no action can be taken on the trip at all');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(a) A payment made in the OTHER channel shows up here');

test('paid by card via the email link → PAID, and no way to pay again', () => {
  // Exactly what the Stripe webhook leaves behind.
  const b = asClient({ payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  assert.strictEqual(_tripStatus(b).key, 'paid');
  assert.strictEqual(_tripStatus(b).label, 'Paid');
  const a = _tripActions(b, TODAY);
  assert.strictEqual(a.pay, false, 'a paid trip must not offer payment — this is the double-charge guard');
  assert.strictEqual(_payState(b), 'paid', 'and the pay panel must render the settled state, not a button');
});

test('marked paid by staff (paid_at only) counts just the same', () => {
  const b = asClient({ payment: 'cash', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  assert.strictEqual(_tripStatus(b).key, 'paid');
  assert.strictEqual(_tripActions(b, TODAY).pay, false);
});

test('cash chosen in the email channel → "Paying the driver", card no longer offered', () => {
  const b = asClient({ payment: 'cash', status: 'awaiting_payment' });
  assert.strictEqual(_tripStatus(b).key, 'cash');
  assert.strictEqual(_tripStatus(b).label, 'Paying the driver');
  assert.strictEqual(_tripActions(b, TODAY).pay, false,
    'once the driver is being paid, My Account must not also offer a card payment');
});

test('…and the reverse: an unpaid estimate is payable from here', () => {
  const b = asClient({ status: 'pending', payment: 'pending', fare: 137 });
  assert.strictEqual(_tripActions(b, TODAY).pay, true);
  assert.strictEqual(_payState(b), 'payable');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(b) The actions offered always match the server status');

test('a cancelled trip offers nothing but a re-book', () => {
  const b = asClient({ status: 'cancelled', fare: 137 });
  const a = _tripActions(b, TODAY);
  assert.strictEqual(_tripStatus(b).key, 'cancelled');
  assert.deepStrictEqual({ pay: a.pay, change: a.change, cancel: a.cancel },
    { pay: false, change: false, cancel: false },
    'a cancelled booking is a record — nothing may be done to it');
  assert.ok(a.rebook, 'but the customer can book the same journey again');
});

test('a completed trip cannot be paid, changed or cancelled — only its invoice viewed', () => {
  const b = asClient({ status: 'completed', date: PAST, payment: 'card', paid_at: '2026-07-01 12:00' });
  const a = _tripActions(b, TODAY);
  assert.deepStrictEqual({ pay: a.pay, change: a.change, cancel: a.cancel },
    { pay: false, change: false, cancel: false });
  assert.ok(a.invoice, 'a settled, finished journey should offer its invoice');
});

test('a past-dated trip offers no change or cancel, whatever its status', () => {
  const a = _tripActions(asClient({ status: 'confirmed', date: PAST }), TODAY);
  assert.strictEqual(a.change, false, 'there is nothing to change about a journey that has been and gone');
  assert.strictEqual(a.cancel, false);
});

test('a trip already under way cannot be edited from the app', () => {
  const a = _tripActions(asClient({ status: 'active' }), TODAY);
  assert.strictEqual(a.change, false, 'the driver is en route — that is a phone call, not a form');
  assert.strictEqual(_tripStatus(asClient({ status: 'active' })).label, 'Driver on the way');
});

test('a row with no database id offers no server action at all', () => {
  // A booking made in this tab that the server list has not caught up with.
  const b = asClient({}); b.id = null;
  const a = _tripActions(b, TODAY);
  assert.deepStrictEqual({ pay: a.pay, change: a.change, cancel: a.cancel },
    { pay: false, change: false, cancel: false },
    'there is nothing to act on until the row comes back from the server');
});

test('an unpriced booking says so instead of pretending there is something to pay', () => {
  const b = asClient({ fare: null, status: 'pending' });
  assert.strictEqual(_tripStatus(b).label, 'Awaiting your estimate');
  assert.strictEqual(_tripActions(b, TODAY).pay, false);
});

test('a priced, unpaid trip reads "Awaiting payment" and can be paid, changed and cancelled', () => {
  const b = asClient({ status: 'awaiting_payment', payment: 'pending', fare: 137 });
  assert.strictEqual(_tripStatus(b).label, 'Awaiting payment');
  const a = _tripActions(b, TODAY);
  assert.ok(a.pay && a.change && a.cancel);
});

test('every status the customer can see has a label and a tone', () => {
  const cases = [
    { status: 'cancelled' }, { status: 'completed' }, { status: 'active' },
    { status: 'confirmed' }, { status: 'awaiting_payment' }, { status: 'pending' },
    { status: 'confirmed', payment: 'card', paid_at: 'x' }, { status: 'offered' },
    { status: '' }, { status: null }
  ];
  for (const c of cases) {
    const s = _tripStatus(asClient(c));
    assert.ok(s && s.label && s.tone && s.key, 'no status for ' + JSON.stringify(c));
  }
});

test('a change request is shown ALONGSIDE the status, never instead of it', () => {
  // A confirmed, paid trip can still have an outstanding request — the customer
  // needs to read both facts.
  const b = asClient({ status: 'confirmed', payment: 'card', paid_at: 'x', change_requested_at: '2026-08-13' });
  assert.strictEqual(_tripStatus(b).key, 'paid', 'the money state must still be the headline');
  assert.ok(/changeRequestedAt/.test(RIDER) && /Change requested/.test(RIDER),
    'and the outstanding request must get its own chip');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(c) The list is re-synced from the server, not trusted from cache');

test('the trip list is re-fetched on load, after actions, and when the tab returns', () => {
  assert.ok(/visibilitychange/.test(RIDER),
    'coming back to the tab after paying in the email channel must re-sync — otherwise My Account ' +
    'sits there offering to take the money again');
  assert.ok(/window\.addEventListener\('focus'/.test(RIDER), 'refocusing the window must re-sync');
  assert.ok(/e&&e\.persisted/.test(RIDER),
    'a bfcache restore (Back from the pay page) hands back a rendered DOM with no fresh data — re-sync it');
  for (const fn of ['payTripCash', 'cancelTrip', 'submitChangeRequest', 'payTripByCard']) {
    const i = RIDER.indexOf(fn === 'submitChangeRequest' ? 'async function submitChangeRequest(' : 'async function ' + fn + '(');
    assert.ok(i !== -1, fn + ' not found');
    const body = RIDER.slice(i, RIDER.indexOf('\n}\n', i));
    assert.ok(/loadServerTrips\(\)/.test(body), fn + ' must re-sync from the server after acting');
  }
});

test('the fetch cannot be answered from the browser HTTP cache', () => {
  const i = RIDER.indexOf('async function loadServerTrips(');
  const body = RIDER.slice(i, RIDER.indexOf('\n}\n', i));
  assert.ok(/cache:'no-store'/.test(body),
    "the whole point of this fetch is to be current — a cached 200 defeats it");
});

test('the cache is never presented as current until the server has answered', () => {
  assert.ok(/_tripsLive/.test(RIDER), 'there must be a freshness flag');
  const i = RIDER.indexOf('function _paintFreshness(');
  const body = RIDER.slice(i, RIDER.indexOf('\n}\n', i));
  assert.ok(/last known/i.test(body),
    'while showing cached data the customer must be told, not shown stale details as fact');
  assert.ok(/Up to date/i.test(body), 'and told when it is live');
  const load = RIDER.slice(RIDER.indexOf('async function loadServerTrips('));
  assert.ok(/_tripsLive=true/.test(load.slice(0, load.indexOf('\n}\n'))),
    'the flag must flip only once the server has actually answered');
});

test('a failed re-sync leaves the page working and says it is not live', () => {
  const i = RIDER.indexOf('async function loadServerTrips(');
  const body = RIDER.slice(i, RIDER.indexOf('\n}\n', i));
  assert.ok(/catch/.test(body), 'a network failure must not throw out of the refresh');
  // The OUTER handler — the one a failed fetch lands in. (Inner try/catches
  // guard localStorage writes and must not be mistaken for it.)
  const outer = body.slice(body.lastIndexOf('}catch(e){'));
  assert.ok(!/_tripsLive\s*=\s*true/.test(outer),
    'a failed fetch must never mark the cache as live');
  assert.ok(/_tripsSyncing\s*=\s*false/.test(outer),
    'a failed fetch must stop claiming to be syncing');
  const rf = RIDER.slice(RIDER.indexOf('function refreshTripsFromServer('));
  assert.ok(/_safe\(/.test(rf.slice(0, rf.indexOf('\n}\n'))),
    'the re-sync is triggered by browser events — it must be wrapped so it can never blank the page');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\nThe server really does return what the client needs');

test('GET /bookings hands the customer every column the status is built from', () => {
  const branch = apiSrc.split("} else if (type === 'customer') {")[1];
  const sql = branch.match(/db\.prepare\(`([\s\S]*?)`\)/)[1];
  assert.ok(/SELECT b\.\*/.test(sql),
    'the customer branch must select the whole booking row — status, payment, paid_at, ' +
    'change_requested_at and re_estimated_at are all read by My Account');
});

test('the columns exist end to end, and the webhook really sets them', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bookings (
     id INTEGER PRIMARY KEY, ref TEXT UNIQUE, fare REAL, payment TEXT DEFAULT 'pending',
     status TEXT DEFAULT 'pending', paid_at TEXT, pay_token TEXT, payment_intent_id TEXT,
     change_requested_at TEXT, re_estimated_at TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO bookings (id,ref,fare,pay_token,status) VALUES (1,'WPH-LIVE1',137,'tok','pending')").run();

  // The SHIPPED webhook UPDATE — the email channel's write.
  const i = publicSrc.indexOf("SET payment = 'card'");
  const sql = publicSrc.slice(publicSrc.lastIndexOf('UPDATE bookings', i), publicSrc.indexOf('`', i));
  db.prepare(sql).run('pi_test', 'WPH-LIVE1');

  const row = db.prepare('SELECT * FROM bookings WHERE id = 1').get();
  assert.strictEqual(row.payment, 'card');
  assert.ok(row.paid_at, 'the webhook must stamp paid_at');
  assert.strictEqual(row.pay_token, null, 'and kill the emailed link');

  // …and that is what My Account then draws.
  const client = mapRow(Object.assign({ pickup: 'a', destination: 'b', date: FUTURE, time: '09:00', passengers: 1 }, row));
  assert.strictEqual(_tripStatus(client).key, 'paid',
    'the exact row the email channel writes must read as PAID in My Account');
  assert.strictEqual(_tripActions(client, TODAY).pay, false,
    'and must offer no second payment — this is the guardrail the whole feature turns on');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/live-status\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
