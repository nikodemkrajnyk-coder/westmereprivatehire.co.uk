/**
 * A deleted booking disappears from My Account — run with:
 *   node server/tests/rider-deleted-trip.test.js   (also gated by `npm test`)
 *
 * THE BUG
 *   The owner deleted a booking. It went from the database, from the owner app
 *   and from the admin app — and stayed in the customer's My Account, frozen
 *   at "pending", indefinitely.
 *
 *   The server was right: /api/bookings selects from the bookings table, and a
 *   deleted row is not in it. The rider app's re-sync was the problem. It
 *   rebuilt the list from the server and then deliberately re-added EVERY
 *   cached row the server had not returned:
 *
 *     var localOnly = getBookings().filter(b => b.ref && !serverRefs[b.ref]);
 *     save(mapped.concat(localOnly));
 *
 *   That rule exists so a trip booked seconds ago in this tab does not vanish
 *   before the server list catches up. But "not synced yet" and "deleted by the
 *   office" are the same shape from the client: present locally, absent from
 *   the server. So the deleted booking was preserved on every single sync.
 *
 *   The two are now told apart by whether the SERVER has ever acknowledged the
 *   row — an id it assigned — and, for rows it has not, by age.
 *
 * A customer reading "pending" on a trip that no longer exists will ring up
 * about it, so this is pinned by RUNNING the shipped reconcile over both cases.
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

const RIDER = read('westmere-rider.html');

// Rebuild the SHIPPED reconcile step and run it, rather than reading it.
function reconcile(serverRows, cachedRows, nowMs) {
  // Search for the closing marker AFTER the block starts: the same
  // localStorage.setItem call appears earlier in the file, where a new booking
  // is cached, and slicing to the first one gave a negative-length string.
  const from = RIDER.indexOf('var GRACE_MS=');
  const to = RIDER.indexOf("try{localStorage.setItem('wph_rider_bookings'", from);
  const src = RIDER.slice(from, to);
  assert.ok(src.length > 100, 'the reconcile block has moved — re-point this harness');
  const fn = new Function('mapped', 'getBookings', 'Date',
    src + '\nreturn mapped.concat(localOnly);');
  const FakeDate = { now: () => nowMs, parse: Date.parse };
  return fn(serverRows, () => cachedRows, FakeDate);
}

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-08-20T12:00:00Z');

console.log('\nA deleted booking disappears from My Account');

test('THE BUG: a booking deleted server-side is dropped from the cache', () => {
  const cached = [
    { id: 41, ref: 'WPH-GONE', status: 'pending', created: iso(NOW - 86400000) },
    { id: 42, ref: 'WPH-KEEP', status: 'confirmed', created: iso(NOW - 86400000) }
  ];
  const server = [{ id: 42, ref: 'WPH-KEEP', status: 'confirmed' }];
  const out = reconcile(server, cached, NOW);
  const refs = out.map(b => b.ref);
  assert.ok(!refs.includes('WPH-GONE'),
    'the deleted booking is still in My Account, frozen at "' +
    (cached[0].status) + '": ' + refs.join(', '));
  assert.deepStrictEqual(refs, ['WPH-KEEP'], 'the surviving trip was lost or duplicated: ' + refs.join(', '));
});

test('the SERVER row wins for a trip that still exists', () => {
  // The customer must see the server's status, not the cached one.
  const cached = [{ id: 42, ref: 'WPH-KEEP', status: 'pending', created: iso(NOW - 86400000) }];
  const server = [{ id: 42, ref: 'WPH-KEEP', status: 'confirmed' }];
  const out = reconcile(server, cached, NOW);
  assert.strictEqual(out.length, 1, 'the trip was duplicated: ' + JSON.stringify(out.map(b => b.ref)));
  assert.strictEqual(out[0].status, 'confirmed', 'My Account is showing the cached status over the server one');
});

test('a trip booked SECONDS ago still survives — the reason the rule exists', () => {
  // No id: the server has never acknowledged it. Dropping this would make a
  // just-made booking vanish in front of the customer who made it.
  const cached = [{ ref: 'WPH-NEW', status: 'pending', created: iso(NOW - 5000) }];
  const out = reconcile([], cached, NOW);
  assert.deepStrictEqual(out.map(b => b.ref), ['WPH-NEW'],
    'a booking made seconds ago disappeared before the server list caught up');
});

test('...but not for ever: an unacknowledged row expires', () => {
  const cached = [{ ref: 'WPH-NEVER', status: 'pending', created: iso(NOW - 60 * 60 * 1000) }];
  const out = reconcile([], cached, NOW);
  assert.deepStrictEqual(out.map(b => b.ref), [],
    'a booking that never reached the server is haunting the list an hour later');
});

test('a row the server once knew is dropped even without a matching ref', () => {
  // Deletion is decided by the id the server assigned, not by string matching
  // on a reference that a later edit could change.
  const cached = [{ id: 7, ref: 'WPH-OLDREF', status: 'pending', created: iso(NOW - 86400000) }];
  const out = reconcile([{ id: 9, ref: 'WPH-OTHER' }], cached, NOW);
  assert.ok(!out.some(b => b.ref === 'WPH-OLDREF'), 'a server-known row survived its own deletion');
});

// ── The invariants this must not break ───────────────────────────────────
test('the sync still re-fetches the WHOLE list, and no-store', () => {
  const fn = RIDER.slice(RIDER.indexOf('async function loadServerTrips'), RIDER.indexOf('function refreshTripsFromServer'));
  assert.ok(/fetch\('\/api\/bookings'/.test(fn), 'the trips sync no longer fetches the list');
  assert.ok(/cache:'no-store'/.test(fn),
    'without no-store a returning tab can be handed a stale 200 — the whole point of this fetch is to be current');
  assert.ok(/credentials:'include'/.test(fn), 'the sync must send the session cookie or it 401s');
});

test('every re-sync trigger is still wired', () => {
  // Load, tab focus, tab visible, and bfcache restore. A deleted booking must
  // clear on the next natural interaction, not only on a hard reload.
  for (const t of ['visibilitychange', "addEventListener('focus'", "addEventListener('pageshow'"]) {
    assert.ok(RIDER.includes(t), 'the ' + t + ' re-sync trigger is gone');
  }
  assert.ok((RIDER.match(/loadServerTrips\(\)/g) || []).length >= 6,
    'the customer actions no longer re-sync after they act');
});

test('the live-status and payment invariants are untouched', () => {
  const fn = RIDER.slice(RIDER.indexOf('async function loadServerTrips'), RIDER.indexOf('function refreshTripsFromServer'));
  // Every field the status chip and the pay panel derive from must survive the
  // mapping, or My Account draws a state the server does not agree with.
  for (const f of ['payment', 'paidAt', 'changeRequestedAt', 'reEstimatedAt', 'status']) {
    assert.ok(new RegExp(f + ':').test(fn), 'the mapping dropped ' + f + ' — the status chip or pay panel would be wrong');
  }
  assert.ok(/_tripsLive=true/.test(fn), 'the sync no longer marks the list live');
});

test('the rider service worker was bumped so devices pick this up', () => {
  const sw = read('rider-sw.js');
  const m = /westmere-rider-v(\d+)/.exec(sw);
  assert.ok(m, 'rider-sw.js has no versioned cache');
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(read('westmere-rider.html')).digest('hex');
  assert.ok(sw.includes(hash),
    'rider-sw.js still pins an older westmere-rider.html — installed devices would keep the buggy copy');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/rider-deleted-trip\.test\.js/.test(read('package.json')), 'rider-deleted-trip.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
