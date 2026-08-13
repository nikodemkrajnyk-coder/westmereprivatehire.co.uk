/**
 * My Account ↔ owner-app lifecycle parity guardrail — run with:
 *   node server/tests/account-owner-parity.test.js   (also gated by `npm test`)
 *
 * THE OWNER'S RULE: "always check a new update fits the logic before it's
 * applied." My Account can now create and cancel bookings. The danger is not
 * that those features break — it is that they quietly DIVERGE: a second
 * booking path with its own statuses, its own field names, or its own idea of
 * what "cancelled" means. The owner app would then show a booking that behaves
 * unlike every other booking, and the payment invariants in CLAUDE.md would
 * hold for web bookings but not for account ones.
 *
 * So this pins the two customer-initiated writes to the SAME logic everything
 * else uses:
 *   1. Booking from My Account goes through the SAME route as the website
 *      form, carries the same fields, and starts at the same status.
 *   2. Cancelling from My Account goes through the server route (status +
 *      audit + calendar + broadcast), never a client-side status flip.
 *   3. The lifecycle itself is unchanged: pending → awaiting_payment →
 *      confirmed / cancelled, and My Account never invents a status or
 *      confirms a booking by itself.
 *
 * Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nMy Account ↔ owner-app lifecycle parity');

const rider = read('westmere-rider.html');
const web = read('booking-app.js');
const publicApi = read('server/public-api.js');
const api = read('server/api.js');

// The block of rider code that submits a new booking.
const riderSubmit = (() => {
  const i = rider.indexOf("fetch('/api/public/book'");
  assert.ok(i !== -1, 'westmere-rider.html no longer posts to /api/public/book');
  return rider.slice(i, i + 1600);
})();

// ── 1. SAME CREATE PATH ──────────────────────────────────────────────────
test('a My Account booking uses the SAME route as the website booking form', () => {
  assert.ok(/fetch\('\/api\/public\/book'/.test(web),
    'the website form should post to /api/public/book (baseline for this test)');
  assert.ok(/fetch\('\/api\/public\/book'/.test(rider),
    'My Account must create bookings through /api/public/book — the same route as the ' +
    'website form — so intake, fares, emails and the owner app treat it identically. ' +
    'A separate endpoint would be a second lifecycle.');
});

test('a My Account booking carries the same fields the website form sends', () => {
  // Every field the public route reads out of the body, minus the ones that are
  // genuinely website-only (client-side coords and the return-leg toggle).
  const WEBSITE_ONLY = new Set(['pickup_lat', 'pickup_lng', 'returnTrip']);
  // scope the read to the POST /book handler, not the first destructure in the file
  const routeStart = publicApi.indexOf("router.post('/book'");
  assert.ok(routeStart !== -1, 'server/public-api.js no longer defines POST /book');
  const destructured = publicApi.slice(routeStart).match(/const \{([\s\S]*?)\} = req\.body;/);
  assert.ok(destructured, 'could not read the field list out of POST /book');
  const fields = destructured[1]
    .split(',')
    .map(s => s.split(':')[0].trim())
    .filter(Boolean)
    .filter(f => !WEBSITE_ONLY.has(f));

  const missing = fields.filter(f => !new RegExp('\\b' + f + '\\s*:').test(riderSubmit));
  assert.strictEqual(missing.join(', '), '',
    'My Account must send the same booking fields as the website — missing: ' + missing.join(', ') +
    '. A field the owner app expects (name/email/phone/passengers/bags/stop/flight) that ' +
    'My Account omits shows up as a blank on the job card.');
});

test('the customer is linked to the booking the same way (by account email)', () => {
  assert.ok(/SELECT id FROM customers WHERE email = \? AND active = 1/.test(publicApi),
    'POST /book must link the booking to an existing account by email');
  assert.ok(/\bemail\s*:/.test(riderSubmit),
    'My Account must send the account email, or the booking it creates cannot be linked ' +
    'back to the customer and will vanish from their own trip list');
});

test('a My Account booking starts at pending — it never self-confirms', () => {
  assert.ok(/const finalStatus\s*=\s*'pending'/.test(publicApi),
    "POST /book must create bookings as 'pending'");
  assert.ok(/payment:\s*paymentType/.test(riderSubmit) && /var paymentType\s*=\s*'pending'/.test(rider),
    "My Account must submit payment 'pending' — a payment method is only ever written by a " +
    'real card payment or the customer choosing to pay the driver (CLAUDE.md invariant 1)');
  assert.ok(!/status\s*:\s*['"]confirmed['"]/.test(riderSubmit),
    'My Account must NEVER submit or assume a confirmed status — only a card payment, a ' +
    'cash choice, or the owner confirms a booking (CLAUDE.md invariant 3)');
});

// ── 2. SAME CANCEL PATH ──────────────────────────────────────────────────
const cancelFn = (() => {
  const m = rider.match(/async function cancelTrip\([\s\S]*?\n\}/);
  assert.ok(m, 'westmere-rider.html no longer defines cancelTrip()');
  return m[0];
})();

test('cancelling from My Account goes through the server route', () => {
  assert.ok(/\/api\/customer\/bookings\//.test(cancelFn) && /\/cancel/.test(cancelFn),
    'cancelTrip must POST /api/customer/bookings/:id/cancel');
  assert.ok(/method:\s*'POST'/.test(cancelFn), 'the cancel must be a POST, not a GET');
});

test('the cancel route does everything a cancellation does elsewhere', () => {
  const route = api.slice(api.indexOf("router.post('/customer/bookings/:id/cancel'"));
  const body = route.slice(0, route.indexOf('\n});') + 4);
  assert.ok(/status = 'cancelled'/.test(body), 'it must set status to cancelled');
  assert.ok(/audit_log/.test(body), 'it must write an audit_log entry, like every other state change');
  assert.ok(/events\.broadcast\('booking:updated'/.test(body),
    'it must broadcast booking:updated so the owner app updates live');
  assert.ok(/calendar_event_id/.test(body) && /deleteEvent/.test(body),
    'it must remove the Google Calendar event — a cancelled job cannot stay in the diary');
});

test('a client-side cancel can never stand in for the server one', () => {
  const localWrite = cancelFn.indexOf('localStorage.setItem');
  const serverCall = cancelFn.indexOf('/api/customer/bookings/');
  assert.ok(serverCall !== -1, 'no server call in cancelTrip');
  assert.ok(localWrite === -1 || serverCall < localWrite,
    'the local copy may only change AFTER the server confirms — otherwise the customer is ' +
    'told the trip is cancelled while the office and the driver still have it');
  assert.ok(/if\(!r\.ok\)/.test(cancelFn) || /r\.ok/.test(cancelFn),
    'a failed cancel must be surfaced, not swallowed');
});

// ── 3. THE LIFECYCLE ITSELF ──────────────────────────────────────────────
test('the booking lifecycle statuses are unchanged', () => {
  const db = read('server/db.js');
  for (const s of ['pending', 'awaiting_payment', 'confirmed', 'cancelled']) {
    assert.ok(new RegExp("'" + s + "'").test(db),
      'the bookings status CHECK constraint must still include ' + s);
  }
});

test('My Account never writes a payment method itself', () => {
  // Invariant 1: payment is written ONLY by the Stripe webhook (card) or the
  // customer's explicit pay-driver action (cash).
  for (const bad of [/payment\s*:\s*['"]card['"]/, /payment\s*:\s*['"]cash['"]/]) {
    assert.ok(!bad.test(riderSubmit),
      'My Account must not submit a concrete payment method — that is what produced the ' +
      '"Mr Ben" incident, where a card choice was recorded as cash');
  }
});

test('the Call Driver action is gone from My Account', () => {
  // Checked structurally, not by prose: the point is that no call-the-driver
  // CONTROL is rendered on a trip. (Contact Us still carries the office number,
  // which is the intended way to reach us.)
  assert.ok(!/class="aj-call-btn"/.test(rider) && !/aj-call-btn'/.test(rider),
    'the Call Driver button was removed at the owner\'s request — it must not come back');
  const activeTrip = rider.match(/function renderActiveTrip\([\s\S]*?\n\}/);
  assert.ok(activeTrip, 'renderActiveTrip() not found');
  assert.ok(!/tel:/.test(activeTrip[0]),
    'the trip card must not render a telephone link — the driver is identified, not dialled');
  const tripsList = rider.match(/function renderTrips\([\s\S]*?\n\}/);
  assert.ok(tripsList && !/tel:/.test(tripsList[0]),
    'trip rows must not render a telephone link either');
});

// ── 4. The new menu items exist and behave ───────────────────────────────
test('Contact Us is a real section with the real contact details', () => {
  assert.ok(/id="pg-contact"/.test(rider), 'there must be a Contact Us section');
  assert.ok(/tel:\+447930342593/.test(rider), 'it must carry the phone number 07930 342593');
  assert.ok(/mailto:bookings@westmereprivatehire\.co\.uk/.test(rider),
    'it must carry the bookings email address');
  // Reachable on BOTH form factors — but there is one nav now, not two. The
  // mobile strip that used to carry this (sn-contact) is gone; the side menu is
  // a static column on desktop and a drawer on mobile, so a single sidebar
  // entry plus the menu button IS both.
  assert.ok(/id="sd-contact"/.test(rider), 'Contact Us must be in the side menu');
  assert.ok(/id="tb-menu"/.test(rider) && /toggleSideMenu\(\)/.test(rider),
    'the side menu must be openable on mobile, or Contact Us is desktop-only');
});

test('Airport Rewards is present, last, and clearly marked coming soon', () => {
  assert.ok(/id="pg-rewards"/.test(rider), 'there must be an Airport Rewards section');
  assert.ok(/Coming soon/i.test(rider), 'it must be marked as coming soon');
  assert.ok(/id="sd-rewards"/.test(rider), 'Airport Rewards must be in the side menu');
  assert.ok(/id="tb-menu"/.test(rider), 'the side menu must be openable on mobile');
  // last item in the sidebar
  const order = ['sd-trips', 'sd-payments', 'sd-invoices', 'sd-details', 'sd-book', 'sd-contact', 'sd-rewards']
    .map(id => rider.indexOf('id="' + id + '"'));
  assert.ok(order.every(i => i !== -1), 'every sidebar item must exist');
  const sorted = order.slice().sort((a, b) => a - b);
  assert.deepStrictEqual(order, sorted,
    'the sidebar order must be My Trips, Payment History, Invoices, My Details, ' +
    'Book New Journey, Contact Us, Airport Rewards (Rewards last)');
});

test('Airport Rewards promises nothing it cannot yet do', () => {
  const sec = rider.slice(rider.indexOf('id="pg-rewards"'), rider.indexOf('id="pg-rewards"') + 2500);
  assert.ok(!/\bfetch\(/.test(sec), 'the teaser must not call an endpoint that does not exist');
  assert.ok(!/\d+\s*(points|stamps)\b/i.test(sec),
    'it must not show a fake balance or progress — there is no backend yet');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
