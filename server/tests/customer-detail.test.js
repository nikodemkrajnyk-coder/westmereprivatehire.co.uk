/**
 * ONE CUSTOMER'S SPEND AND HISTORY —
 *   node server/tests/customer-detail.test.js   (also gated by `npm test`)
 *
 * Tapping a name in the Customers tab opens what that person has spent and
 * every journey they have taken. Three ways that can be wrong, and all three
 * are worse than showing nothing:
 *
 *   THE MATHS. "Spent" is money that CHANGED HANDS — a card payment received,
 *   or a journey completed and paid for on the day. A confirmed cash job next
 *   Tuesday is money expected, not money taken, and a cancelled job is neither.
 *   Counting either would tell the owner a regular has spent hundreds more than
 *   they have, and he prices his goodwill off this number.
 *
 *   WHOSE TRIPS. The history is matched on the NORMALISED phone and email that
 *   the directory itself is keyed on — that is what makes "+44 7700 900123" and
 *   "07700900123" one person. The failure that matters is the other direction:
 *   a loose key that pulls a DIFFERENT customer's journeys, and their addresses,
 *   into this one's page.
 *
 *   WHO CAN SEE IT. A named person's number, home address and spending history
 *   in one response. Staff only, or it is a data breach with a URL.
 *
 * Runs the SHIPPED route and the SHIPPED module against a throwaway database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { routeBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-cust-detail-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const dir = require('../customer-directory');
const { getDb } = require('../db');
const db = getDb();

let n = 0;
function booking(o) {
  const ref = 'WPH-D' + (++n);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,fare,status,payment,paid_at,
              passenger_name,passenger_phone,passenger_email)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ref, o.pickup || 'Caterham', o.destination || 'Gatwick Airport', o.date || '2026-01-01',
    o.time || '09:00', o.fare === undefined ? 100 : o.fare, o.status || 'confirmed',
    o.payment || 'pending', o.paid_at || null,
    o.name || 'Mr Ben Chan', o.phone === undefined ? '07700900123' : o.phone,
    o.email === undefined ? 'ben@example.com' : o.email);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
function saveCustomer(b) {
  const r = dir.addFromBooking(db, b.id);
  assert.ok(r.ok, 'seeding the directory failed: ' + JSON.stringify(r));
  return r.customer;
}
// The table is created lazily on first use; reset() would otherwise wipe a
// table that does not exist yet.
dir.ensureSchema(db);
const reset = () => {
  db.prepare('DELETE FROM bookings').run();
  db.prepare('DELETE FROM customer_directory').run();
  n = 0;
};

// ── 1. THE MATHS ─────────────────────────────────────────────────────────
console.log('\nWhat "spent" means');

test('spend counts CARD-PAID and COMPLETED trips, and nothing else', () => {
  reset();
  const seed = booking({ fare: 100, status: 'completed' });                       // collected on the day
  const me = saveCustomer(seed);
  booking({ fare: 50, status: 'confirmed', payment: 'card', paid_at: '2026-01-02 10:00:00' }); // in the bank
  booking({ fare: 70, status: 'confirmed', payment: 'cash' });                   // expected, not taken
  booking({ fare: 999, status: 'cancelled', payment: 'card', paid_at: '2026-01-03 10:00:00' }); // never revenue
  booking({ fare: 40, status: 'pending' });                                      // a quote

  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalSpent, 150, 'only the completed 100 and the card-paid 50');
  assert.strictEqual(out.stats.settledTrips, 2);
  assert.strictEqual(out.stats.bookedValue, 110, 'the cash job and the quote are money EXPECTED');
  assert.strictEqual(out.stats.bookedTrips, 2);
  assert.strictEqual(out.stats.cancelledTrips, 1);
  assert.strictEqual(out.stats.totalTrips, 5, 'the cancelled one still appears in the history');
});

test('a CANCELLED trip never counts, however it was paid', () => {
  reset();
  const seed = booking({ fare: 200, status: 'cancelled', payment: 'card', paid_at: '2026-01-01 10:00:00' });
  const me = saveCustomer(seed);
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalSpent, 0, 'a refunded/cancelled job is not revenue');
  assert.strictEqual(out.stats.bookedValue, 0, 'nor is it expected money');
  assert.strictEqual(out.stats.totalTrips, 1, 'but it is still on the record');
});

test('the average is per PAID trip, not per trip', () => {
  reset();
  const seed = booking({ fare: 100, status: 'completed' });
  const me = saveCustomer(seed);
  booking({ fare: 200, status: 'completed' });
  booking({ fare: 900, status: 'confirmed', payment: 'cash' });   // must not drag the average
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalSpent, 300);
  assert.strictEqual(out.stats.averageFare, 150, '300 over two paid trips');
});

test('a fareless or zero-fare trip adds nothing but still shows', () => {
  reset();
  const seed = booking({ fare: null, status: 'completed' });
  const me = saveCustomer(seed);
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalSpent, 0);
  assert.strictEqual(out.stats.totalTrips, 1);
});

test('the RULE ITSELF is right, not just its callers', () => {
  /* Both callers happen to filter cancelled out before they ask, so the
     cancelled check inside isSettledForSpend was invisible to every other test
     here — removing it broke nothing. That is exactly how a safety net rots:
     it holds until the day a third caller trusts it. Asserted directly. */
  const S = dir.isSettledForSpend;
  assert.strictEqual(S({ status: 'completed' }), true, 'a completed journey is settled');
  assert.strictEqual(S({ status: 'confirmed', paid_at: '2026-01-01 10:00:00' }), true, 'so is a card payment received');
  assert.strictEqual(S({ status: 'confirmed', payment: 'cash' }), false, 'a cash job not yet run is not');
  assert.strictEqual(S({ status: 'pending' }), false, 'nor is a quote');
  assert.strictEqual(S({ status: 'cancelled', paid_at: '2026-01-01 10:00:00' }), false,
    'a CANCELLED trip is never revenue, however it was paid');
  assert.strictEqual(S({ status: 'CANCELLED', paid_at: '2026-01-01 10:00:00' }), false, 'whatever the casing');
  assert.strictEqual(S(null), false, 'and nothing is not a sale');
});

test('the detail page and the Customer Spend report share ONE rule', () => {
  // Two definitions of revenue is two answers to the same question.
  const api = read('server/api.js');
  const seg = routeBlock(api, "router.get('/customer-spend'");
  assert.ok(seg, 'the customer-spend route is missing');
  assert.ok(/isSettledForSpend\(/.test(seg),
    'the spend report must ask customer-directory, not spell the rule out again');
  assert.ok(!/paid_at \|\| status === 'completed'/.test(seg),
    'no second inline copy of the rule may survive');
});

// ── 2. WHOSE TRIPS ───────────────────────────────────────────────────────
console.log('\nWhose journeys these are');

test('the same person typed differently is ONE history', () => {
  reset();
  const seed = booking({ fare: 100, status: 'completed', phone: '07700900123' });
  const me = saveCustomer(seed);
  booking({ fare: 100, status: 'completed', phone: '+44 7700 900123' });
  booking({ fare: 100, status: 'completed', phone: '00447700900123' });
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalTrips, 3, 'three spellings, one customer');
  assert.strictEqual(out.stats.totalSpent, 300);
});

test('ANOTHER customer\'s trips never leak in', () => {
  reset();
  const seed = booking({ fare: 100, status: 'completed', phone: '07700900123', email: 'ben@example.com' });
  const me = saveCustomer(seed);
  booking({ fare: 500, status: 'completed', phone: '07999888777', email: 'sarah@example.com', name: 'Sarah Whitfield' });
  booking({ fare: 600, status: 'completed', phone: '07111222333', email: 'tom@example.com', name: 'Tom Reed' });
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalTrips, 1, 'only Ben\'s trip');
  assert.strictEqual(out.stats.totalSpent, 100, 'and only Ben\'s money');
  for (const t of out.trips) {
    assert.ok(!/sarah|tom/i.test(String(t.email || '')), 'somebody else appeared in the history');
  }
});

test('a customer with NO phone is not matched by every other numberless booking', () => {
  // An empty key matching anything would collapse every phoneless customer
  // into whichever one was opened first.
  reset();
  const seed = booking({ fare: 100, status: 'completed', phone: null, email: 'ben@example.com' });
  const me = saveCustomer(seed);
  booking({ fare: 700, status: 'completed', phone: null, email: 'stranger@example.com', name: 'A Stranger' });
  const out = dir.tripsFor(db, me.id);
  assert.strictEqual(out.stats.totalTrips, 1, 'an empty phone key must match nobody');
  assert.strictEqual(out.stats.totalSpent, 100);
});

test('the history is newest first', () => {
  reset();
  const seed = booking({ fare: 10, status: 'completed', date: '2026-03-01' });
  const me = saveCustomer(seed);
  booking({ fare: 10, status: 'completed', date: '2026-05-01' });
  booking({ fare: 10, status: 'completed', date: '2026-01-01' });
  const out = dir.tripsFor(db, me.id);
  assert.deepStrictEqual(out.trips.map(t => t.date), ['2026-05-01', '2026-03-01', '2026-01-01']);
  assert.strictEqual(out.stats.firstTrip, '2026-01-01');
  assert.strictEqual(out.stats.lastTrip, '2026-05-01');
});

test('an unknown customer id is a 404, not an empty page', () => {
  reset();
  assert.strictEqual(dir.tripsFor(db, 999999), null);
});

// ── 3. WHO CAN SEE IT ────────────────────────────────────────────────────
console.log('\nWho may open it');

const apiSrc = read('server/api.js');
const detailRoute = routeBlock(apiSrc, "router.get('/customer-directory/:id/trips'");

test('the route exists and is STAFF-ONLY', () => {
  assert.ok(detailRoute, 'GET /customer-directory/:id/trips is missing');
  assert.ok(/\['admin', 'owner'\]\.includes\(req\.auth\.role\)/.test(detailRoute),
    'it must refuse anyone who is not admin or owner');
  assert.ok(/403/.test(detailRoute), 'and say so with a 403');
});

test('a customer role is actually refused when the handler runs', () => {
  const runAs = (role) => {
    const res = { statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
    const sandbox = {
      getDb: () => db, res,
      req: { auth: { role }, params: { id: '1' }, query: {} },
      require: (m) => require(path.join(ROOT, 'server', m.replace(/^\.\//, ''))),
      parseInt, Number, String, JSON, console: { log() {}, error() {} }
    };
    vm.createContext(sandbox);
    const body = detailRoute.slice(detailRoute.indexOf('{') + 1, detailRoute.lastIndexOf('}'));
    vm.runInContext('(function(req,res){' + body + '})(req,res)', sandbox);
    return res;
  };
  assert.strictEqual(runAs('customer').statusCode, 403, 'a signed-in CUSTOMER must be refused');
  assert.strictEqual(runAs('driver').statusCode, 403, 'and so must a driver');
  assert.notStrictEqual(runAs('owner').statusCode, 403, 'the owner must get through');
});

test('it is not reachable from any public router', () => {
  for (const f of ['server/public-api.js', 'server/public-tracking-routes.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    assert.ok(!/customer-directory/.test(read(f)), f + ' must not expose the directory');
  }
});

// ── 4. THE VIEW ──────────────────────────────────────────────────────────
console.log('\nThe page itself');

const OWNER = read('westmere-owner.html');

test('a customer row opens the detail page', () => {
  assert.ok(/onclick="custOpenDetail\('\+c\.id\+'\)"/.test(OWNER), 'the row must be tappable');
  assert.ok(/id="cust-page"/.test(OWNER), 'the detail page must exist');
  assert.ok(/onclick="custCloseDetail\(\)"/.test(OWNER), 'with a way back to the list');
});

test('the header keeps the existing edit action', () => {
  const fn = /function custRenderDetail\(d\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'custRenderDetail is missing');
  assert.ok(/custEdit\(/.test(fn[0]), 'Edit details must open the existing edit sheet');
});

test('the page says plainly what "spent" means', () => {
  const fn = /function custRenderDetail\(d\)\{[\s\S]*?\n\}/.exec(OWNER)[0];
  assert.ok(/money taken/.test(fn) && /Cancelled trips are never counted/.test(fn),
    'the owner must not have to guess which bookings are in the figure');
});

test('a paid-but-upcoming trip is labelled as both', () => {
  /* It is inside Total spent AND it has not happened. If the row said only
     "Upcoming", the paid-trip count above would not reconcile with the list
     below, and the owner would be left hunting for the difference. */
  const fn = /function custTripState\(t\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'custTripState is missing');
  const state = new Function('return ' + fn[0])();
  assert.strictEqual(state({ status: 'confirmed', paid_at: '2026-08-20 09:10:00' }).label, 'Upcoming · Paid');
  assert.strictEqual(state({ status: 'confirmed' }).label, 'Upcoming');
  assert.strictEqual(state({ status: 'completed' }).label, 'Completed');
  assert.strictEqual(state({ status: 'cancelled', paid_at: '2026-01-01' }).label, 'Cancelled',
    'cancelled wins over everything — it is not money and not a journey');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/customer-detail\.test\.js/.test(read('package.json')));
});

try { fs.unlinkSync(TMP); } catch (_) {}
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
