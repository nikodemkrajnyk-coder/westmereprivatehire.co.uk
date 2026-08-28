/**
 * DISPATCH — OFFERING A JOB TO A DRIVER —
 *   node server/tests/dispatch-offer.test.js   (also gated by `npm test`)
 *
 * The owner offers a job by email; the driver accepts or declines from it. Two
 * things in that sentence are dangerous:
 *
 *   THE NUMBER. A driver reads one figure and it must be what reaches his
 *   bank — the fare with the 10% already off. The split is computed ONCE, in
 *   offer-routes.computeSplit(); if the email ever did its own arithmetic there
 *   would be two commission rates in the business and the one in his inbox is
 *   the one he would hold us to. So: the email's pay must equal computeSplit's,
 *   and must never be the gross fare.
 *
 *   THE LINKS. Accept and Decline are in an email. A mail client that prefetches
 *   every URL must not take a 4am Gatwick run on a driver's behalf, and a stray
 *   tap must not decline one. GET only ever renders a confirm page; POST acts.
 *   The same rule, and the same shape, as the customer's cancel.
 *
 * Also pinned: one implementation of accept/decline shared by the app and the
 * email, and a token that dies the moment the offer is decided or reclaimed —
 * so the link in a superseded email is already dead.
 *
 * Runs the SHIPPED modules and routes against a throwaway database. Nothing is
 * sent; the mailer is stubbed at the HTTP layer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { routeBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-dispatch-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

let SENT = [];
global.fetch = async (u, o) => {
  SENT.push(JSON.parse(o.body));
  return { ok: true, status: 200, json: async () => ({ id: 'rid' }) };
};

const offers = require('../offer-routes');
const email = require('../email');
const { getDb } = require('../db');
const db = getDb();

let dn = 0, bn = 0;
function driver(name) {
  const u = 'drv' + (++dn);
  db.prepare("INSERT INTO users (username,password,role,full_name,email,active) VALUES (?,?,'driver',?,?,1)")
    .run(u, 'x', name || 'Sam Whitfield', u + '@example.com');
  return db.prepare('SELECT * FROM users WHERE username = ?').get(u);
}
function job(o) {
  const ref = 'WPH-X' + (++bn);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,stop_address,date,time,fare,status,passengers,bags,flight)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    ref, o.pickup || '14 Greenhill Avenue, Caterham', o.destination || 'London Gatwick Airport',
    o.stop_address || null, o.date || '2026-09-14', o.time || '05:30',
    o.fare === undefined ? 150 : o.fare, o.status || 'pending',
    o.passengers || 3, o.bags || '2', o.flight || null);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
/** Put a job in the offered state the way the /offer route does. */
function offerTo(b, drv, token) {
  const sp = offers.computeSplit(b.fare);
  db.prepare(`UPDATE bookings SET status='offered', offered_to_driver_id=?, offered_at=datetime('now'),
              offer_token=?, driver_pay=?, admin_fee=? WHERE id=?`)
    .run(drv.id, token || 'tok-' + b.id, sp.driver_pay, sp.admin_fee, b.id);
  return Object.assign({}, sp, { token: token || 'tok-' + b.id });
}
const reset = () => { db.prepare('DELETE FROM bookings').run(); };

// ── 1. THE NUMBER ────────────────────────────────────────────────────────
console.log('\nThe money a driver is shown');

test('the split is the existing 10%, computed in ONE place', () => {
  assert.strictEqual(offers.ADMIN_FEE_PCT, 0.10, 'the commission is 10%');
  assert.deepStrictEqual(offers.computeSplit(150), { driver_pay: 135, admin_fee: 15 });
  assert.deepStrictEqual(offers.computeSplit(95), { driver_pay: 85.5, admin_fee: 9.5 });
  assert.deepStrictEqual(offers.computeSplit(null), { driver_pay: null, admin_fee: null });
  const mod = read('server/email.js');
  assert.ok(!/ADMIN_FEE_PCT|\* 0\.9\b|0\.10\b/.test(mod),
    'email.js must not compute a commission — it is handed the split');
});

test('the email shows the NET pay, never the gross fare', async () => {
  reset();
  const drv = driver(), b = job({ fare: 150 });
  const sp = offerTo(b, drv);
  SENT = [];
  await email.sendDriverJobOffer({
    driver_name: drv.full_name, driver_email: drv.email, ref: b.ref,
    pickup: b.pickup, destination: b.destination, date: b.date, time: b.time,
    fare: b.fare, driver_pay: sp.driver_pay, admin_fee: sp.admin_fee,
    passengers: b.passengers, bags: b.bags, offer_token: sp.token });
  const m = SENT[0];
  assert.ok(m, 'nothing was sent');
  assert.ok(/£135\.00 to you/.test(m.html), 'the headline figure must be the NET pay');
  assert.ok(/£135\.00/.test(m.subject), 'and the subject must carry it too');
  const text = m.html.replace(/<[^>]+>/g, ' ');
  assert.ok(/Fare £150\.00/.test(text) && /10% commission already deducted/.test(text),
    'the gross and the deduction must be stated, so the number is not a mystery');
  assert.ok(!/£150\.00 to you/.test(m.html), 'the GROSS must never be presented as his pay');
});

test('the pay in the email always equals computeSplit', async () => {
  for (const fare of [95, 137.5, 195, 40.25]) {
    reset();
    const drv = driver(), b = job({ fare });
    const sp = offerTo(b, drv);
    SENT = [];
    await email.sendDriverJobOffer({ driver_name: drv.full_name, driver_email: drv.email, ref: b.ref,
      pickup: b.pickup, destination: b.destination, date: b.date, time: b.time,
      fare, driver_pay: sp.driver_pay, offer_token: sp.token });
    assert.ok(SENT[0].html.indexOf('£' + sp.driver_pay.toFixed(2) + ' to you') !== -1,
      'fare ' + fare + ' → expected £' + sp.driver_pay.toFixed(2));
  }
});

test('an unpriced job says so instead of inventing a figure', async () => {
  reset();
  const drv = driver(), b = job({ fare: null });
  SENT = [];
  await email.sendDriverJobOffer({ driver_name: drv.full_name, driver_email: drv.email, ref: b.ref,
    pickup: b.pickup, destination: b.destination, date: b.date, time: b.time,
    fare: null, driver_pay: null, offer_token: 'tok' });
  assert.ok(/not set yet/.test(SENT[0].html), 'it must say the fare is not set');
  /* What this means is "no FIGURE is quoted", and it used to test for the
     phrase "to you" as a proxy. That broke the day the email gained the line
     "goes straight into your diary" — which contains "to you" inside "into
     your" and quotes nothing at all. Assert the money, not the wording. */
  assert.deepStrictEqual(SENT[0].html.match(/£\s?\d|&pound;\s?\d/g) || [], [],
    'no pay figure may appear on a job whose fare is not set');
  assert.ok(!/\bto you\b/.test(SENT[0].html.replace(/Your pay for this job/, '').replace(/into your/g, '')),
    'and nothing may read as a promise of pay');
});

test('the email is the letterhead, and carries the job', async () => {
  reset();
  const drv = driver(), b = job({ fare: 150, stop_address: 'Burgess Hill', flight: 'BA2751' });
  const sp = offerTo(b, drv);
  SENT = [];
  await email.sendDriverJobOffer({ driver_name: drv.full_name, driver_email: drv.email, ref: b.ref,
    pickup: b.pickup, destination: b.destination, stop_address: b.stop_address,
    date: b.date, time: b.time, fare: b.fare, driver_pay: sp.driver_pay,
    passengers: 3, bags: '2', flight: 'BA2751', offer_token: sp.token });
  const h = SENT[0].html;
  assert.ok(!/westmere-email-hero\.jpg/.test(h), 'a colleague gets the letterhead, not the customer hero');
  assert.ok(/WESTMERE/.test(h), 'with the wordmark');
  for (const bit of ['Caterham', 'Gatwick', 'Burgess Hill', 'BA2751']) {
    assert.ok(h.indexOf(bit) !== -1, 'the job must include ' + bit);
  }
  assert.ok(/Passengers/.test(h) && /Luggage/.test(h), 'passengers and luggage must be there to check');
  assert.ok(/check the passengers, the luggage and any special requests/.test(h),
    'and he must be told to check them before accepting');
});

// ── 2. THE LINKS ─────────────────────────────────────────────────────────
console.log('\nDeciding from the email');

const pubSrc = read('server/public-api.js');

test('the accept/decline links are tokenised', async () => {
  reset();
  const drv = driver(), b = job({ fare: 150 });
  const sp = offerTo(b, drv, 'secret-token');
  SENT = [];
  await email.sendDriverJobOffer({ driver_name: drv.full_name, driver_email: drv.email, ref: b.ref,
    pickup: b.pickup, destination: b.destination, date: b.date, time: b.time,
    fare: b.fare, driver_pay: sp.driver_pay, offer_token: 'secret-token' });
  const h = SENT[0].html;
  assert.ok(h.indexOf('/api/public/offer/' + b.ref + '/accept?t=secret-token') !== -1, 'accept link');
  assert.ok(h.indexOf('/api/public/offer/' + b.ref + '/decline?t=secret-token') !== -1, 'decline link');
});

test('GET renders a confirm page and mutates NOTHING', () => {
  const get = routeBlock(pubSrc, "router.get('/offer/:ref/:action'");
  assert.ok(get, 'the GET route is missing');
  assert.ok(/<form method="POST">/.test(get), 'it must offer a form, not act');
  assert.ok(!/acceptOffer|declineOffer|UPDATE bookings/.test(get),
    'a GET must never decide an offer — mail clients fetch every link in an inbox');
});

test('POST is the only thing that decides, and it uses the SHARED functions', () => {
  const post = routeBlock(pubSrc, "router.post('/offer/:ref/:action'");
  assert.ok(post, 'the POST route is missing');
  assert.ok(/offers\.acceptOffer\(/.test(post) && /offers\.declineOffer\(/.test(post),
    'it must go through offer-routes, not write its own UPDATE');
  assert.ok(/audit_log/.test(post), 'a decision that assigns work must leave a trail');
});

test('a wrong or missing token decides nothing', () => {
  const both = routeBlock(pubSrc, "router.get('/offer/:ref/:action'") +
               routeBlock(pubSrc, "router.post('/offer/:ref/:action'");
  assert.ok(/offerFromToken\(/.test(both), 'both must resolve the offer through the token');
  const fn = /function offerFromToken[\s\S]*?\n\}/.exec(pubSrc)[0];
  assert.ok(/b\.offer_token !== token/.test(fn), 'the token must be compared, not merely present');
  assert.ok(/!b\.offer_token/.test(fn), 'and a booking with no token must never match');
});

// ── 3. WHAT ACCEPT AND DECLINE DO ────────────────────────────────────────
console.log('\nAccepting and declining');

test('accept assigns the driver, confirms the job and kills the token', () => {
  reset();
  const drv = driver(), b = job({ fare: 150 });
  offerTo(b, drv);
  const out = offers.acceptOffer(db, b.id, drv.id);
  assert.strictEqual(out.ok, true);
  const row = db.prepare('SELECT status, driver_id, offered_to_driver_id, offer_token FROM bookings WHERE id = ?').get(b.id);
  assert.strictEqual(row.status, 'confirmed');
  assert.strictEqual(row.driver_id, drv.id, 'the job is his');
  assert.strictEqual(row.offered_to_driver_id, null, 'and no longer merely offered');
  assert.strictEqual(row.offer_token, null, 'the link in the email is now dead');
});

test('decline releases the job and clears the pay', () => {
  reset();
  const drv = driver(), b = job({ fare: 150 });
  offerTo(b, drv);
  assert.strictEqual(offers.declineOffer(db, b.id, drv.id, 'too far').ok, true);
  const row = db.prepare('SELECT status, driver_id, offered_to_driver_id, driver_pay, offer_token, needs_reassignment FROM bookings WHERE id = ?').get(b.id);
  assert.strictEqual(row.status, 'pending', 'it goes back into the pot');
  assert.strictEqual(row.driver_id, null, 'nobody has it');
  assert.strictEqual(row.driver_pay, null, 'and no pay is owed on it');
  assert.strictEqual(row.offer_token, null);
  assert.strictEqual(row.needs_reassignment, 1, 'flagged for the owner to place again');
});

test('a decided offer cannot be decided twice', () => {
  reset();
  const drv = driver(), b = job({ fare: 150 });
  offerTo(b, drv);
  assert.strictEqual(offers.acceptOffer(db, b.id, drv.id).ok, true);
  assert.strictEqual(offers.acceptOffer(db, b.id, drv.id).reason, 'not_pending');
  assert.strictEqual(offers.declineOffer(db, b.id, drv.id).reason, 'not_pending');
});

test('another driver cannot accept somebody else\'s offer', () => {
  reset();
  const mine = driver('Sam'), other = driver('Tom'), b = job({ fare: 150 });
  offerTo(b, mine);
  assert.strictEqual(offers.acceptOffer(db, b.id, other.id).reason, 'not_pending',
    'an offer is to ONE driver');
  assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id).status, 'offered');
});

test('the app and the email share ONE accept — not two', () => {
  const src = read('server/offer-routes.js');
  const accept = routeBlock(src, "router.post('/driver/offers/:id/accept'");
  assert.ok(/acceptOffer\(getDb\(\), req\.params\.id, req\.auth\.id\)/.test(accept),
    'the driver app route must call the shared function');
  assert.ok(!/UPDATE\s+bookings/i.test(accept), 'and must not carry its own UPDATE');
  const decline = routeBlock(src, "router.post('/driver/offers/:id/decline'");
  assert.ok(/declineOffer\(/.test(decline) && !/UPDATE\s+bookings/i.test(decline));
});

test('offering mints a fresh token, and reclaiming destroys it', () => {
  const src = read('server/offer-routes.js');
  const offer = routeBlock(src, "router.post('/bookings/:id/offer'");
  assert.ok(/randomBytes\(\d+\)/.test(offer), 'the token must be random, not derived');
  assert.ok(/offer_token = \?/.test(offer), 'and stored on the booking');
  assert.ok((src.match(/offer_token = NULL/g) || []).length >= 4,
    'accept, decline, reclaim and the stale sweeper must all invalidate it');
});

// ── 4. THE OWNER'S END ───────────────────────────────────────────────────
console.log("\nThe owner's end");

const OWNER = read('westmere-owner.html');
const apiSrc = read('server/api.js');

test('a job card can offer, and shows who has it', () => {
  assert.ok(/onclick="dispOffer\(/.test(OWNER), 'the Offer button was the missing piece');
  assert.ok(/onclick="dispReclaim\(/.test(OWNER), 'and a way to take it back');
  const row = /function dispStateRow\(j\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(row, 'dispStateRow is missing');
  assert.ok(/Offered to/.test(row[0]) && /awaiting reply/.test(row[0]), 'an offered job says who has it');
  assert.ok(/accepted/.test(row[0]), 'and an accepted one says so');
});

test('the owner app actually carries the dispatch fields', () => {
  // The API has returned these all along; the app never mapped them through,
  // which is why a card could not say who had a job.
  for (const f of ['driverName:b.driver_name', 'offeredToName:b.offered_driver_name', 'driverPay:']) {
    assert.ok(OWNER.indexOf(f) !== -1, 'the job map is missing ' + f);
  }
});

test('message-to-driver is staff-gated and reads the address from the RECORD', () => {
  const route = routeBlock(apiSrc, "router.post('/drivers/:id/message'");
  assert.ok(route, 'the route is missing');
  assert.ok(/\['admin', 'owner'\]\.includes\(req\.auth\.role\)/.test(route), 'staff only');
  assert.ok(/FROM users WHERE id = \? AND role = 'driver'/.test(route),
    'the recipient must come from the driver record, never from the request body');
  assert.ok(!/req\.body[\s\S]{0,40}\bto\b/.test(route), 'no arbitrary recipient may be passed in');
});

test('a customer or driver cannot message drivers as Westmere', () => {
  const route = routeBlock(apiSrc, "router.post('/drivers/:id/message'");
  const runAs = (role) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    const sandbox = { getDb: () => db, res, console: { log() {}, error() {} },
      req: { auth: { role, id: 1 }, params: { id: '1' }, body: { message: 'hi' }, ip: '::1' },
      require: (m) => require(path.join(ROOT, 'server', m.replace(/^\.\//, ''))),
      parseInt, String, JSON, Promise };
    vm.createContext(sandbox);
    const inner = route.slice(route.indexOf('{') + 1, route.lastIndexOf('}'));
    vm.runInContext('(async function(req,res){' + inner + '})(req,res)', sandbox);
    return res.statusCode;
  };
  assert.strictEqual(runAs('customer'), 403);
  assert.strictEqual(runAs('driver'), 403);
});

test('the driver app keeps its own Offered screen', () => {
  const DRV = read('westmere-driver.html');
  assert.ok(/driver\/offers\/'\+id\+'\/accept/.test(DRV), 'in-app accept must still exist');
  assert.ok(/driver\/offers\/'\+id\+'\/decline/.test(DRV), 'and in-app decline');
  assert.ok(/scoreJob\(/.test(DRV), 'with the score strip it already had');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/dispatch-offer\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
