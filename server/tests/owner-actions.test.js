/**
 * The owner app's core actions actually take effect — run with:
 *   node server/tests/owner-actions.test.js   (also gated by `npm test`)
 *
 * THE BUG THIS PINS
 *   The owner tapped Delete on a booking and nothing happened. The server was
 *   fine — it deleted the row and returned {ok:true}. What failed was the
 *   SCREEN: every action refreshes the list underneath, and nothing refreshed
 *   the full-screen trip page sitting on top of it. So the booking vanished
 *   from the database and stayed on his display.
 *
 *   refreshTripPage() was written for exactly this on the day the trip page
 *   shipped, and was never called from anywhere. A helper nobody calls is the
 *   easiest defect in a codebase to miss: it reads as handled.
 *
 *   Because the same refresh serves Mark as Paid, Send Estimate, Mark
 *   Completed and Save, all of them had the same silence on that screen. This
 *   file therefore pins the WIRING for every one of them, not just Delete.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const apiSrc = read('server/api.js');

function extractHandler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  const arrow = apiSrc.indexOf('=>', start);
  let i = apiSrc.indexOf('{', arrow), depth = 0;
  for (let j = i; j < apiSrc.length; j++) {
    if (apiSrc[j] === '{') depth++;
    else if (apiSrc[j] === '}') { depth--; if (depth === 0) return apiSrc.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces extracting ' + route);
}
const delHandler = extractHandler('delete', '/bookings/:id');

function seedDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, ref TEXT, date TEXT,
                           calendar_event_id TEXT, passenger_name TEXT);
    CREATE TABLE change_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,
                            booking_id INTEGER NOT NULL REFERENCES bookings(id),
                            booking_ref TEXT NOT NULL, status TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_type TEXT, user_id INTEGER,
                            action TEXT, detail TEXT, ip TEXT);`);
  db.prepare("INSERT INTO bookings (id,ref,date,calendar_event_id,passenger_name) VALUES (7,'WPH-TEST','2026-08-25',NULL,'Nikodem Krajnyk')").run();
  db.prepare("INSERT INTO bookings (id,ref,date,calendar_event_id,passenger_name) VALUES (8,'WPH-KEEP','2026-08-26',NULL,'Someone Else')").run();
  return db;
}

// Runs the SHIPPED handler — not a copy of it — against a throwaway database.
function runDelete(db, id, role) {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
  const sandbox = {
    getDb: () => db, res,
    req: { auth: { role, id: 1, type: 'staff' }, params: { id: String(id) }, body: {}, ip: '::1' },
    gcal: { deleteEvent: () => Promise.resolve() },
    autoFile: { removeBooking() {} },
    events: { broadcast() {} },
    parseInt, isNaN, Number, String, console: { log() {}, error() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext('(function(req,res){' + delHandler + '})(req,res)', sandbox);
  return res;
}

console.log('\nThe owner app\'s actions take effect');

// ── The server half ──────────────────────────────────────────────────────
test('DELETE /bookings/:id actually removes the booking and reports success', () => {
  const db = seedDb();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 2);
  const r = runDelete(db, 7, 'owner');
  assert.strictEqual(r.statusCode, 200, 'delete returned ' + r.statusCode + ': ' + JSON.stringify(r.body));
  // Compared property-wise, not deepStrictEqual: the object is built inside the
  // vm sandbox, so it is a different realm's Object and would never match.
  assert.strictEqual(r.body && r.body.ok, true,
    'the client gates on d.ok — anything else reads as a failure: ' + JSON.stringify(r.body));
  const left = db.prepare('SELECT id FROM bookings').all().map(b => b.id);
  assert.deepStrictEqual(left, [8], 'the booking is still there, or the wrong one went: ' + left);
});

test('deleting one booking does not touch another', () => {
  const db = seedDb();
  runDelete(db, 7, 'owner');
  assert.ok(db.prepare('SELECT id FROM bookings WHERE id=8').get(), 'the untargeted booking was deleted too');
});

test('the delete is audited, and refuses what it should', () => {
  const db = seedDb();
  runDelete(db, 7, 'owner');
  const log = db.prepare('SELECT action,detail FROM audit_log').all();
  assert.strictEqual(log.length, 1, 'a hard delete must leave exactly one audit row');
  assert.strictEqual(log[0].action, 'booking_deleted');
  assert.strictEqual(log[0].detail, 'WPH-TEST');
  assert.strictEqual(runDelete(seedDb(), 999, 'owner').statusCode, 404, 'a missing booking must 404, not 500');
  assert.strictEqual(runDelete(seedDb(), 7, 'customer').statusCode, 403, 'a customer must never delete a booking');
  const db2 = seedDb();
  runDelete(db2, 7, 'customer');
  assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM bookings').get().n, 2, 'a 403 must not still delete');
});

// ── The client half: the button, and the screen it leaves behind ─────────
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i !== -1, 'westmere-owner.html no longer defines ' + name + '()');
  return src.slice(i, src.indexOf('\n}', i) + 2);
};

test('the Delete button is wired to the handler, and the handler to the route', () => {
  assert.ok(/onclick="upcomingDelete\('\+j\.id\+'\)"/.test(OWNER), 'the Delete button no longer calls upcomingDelete');
  const f = fnBody(OWNER, 'upcomingDelete');
  assert.ok(/confirm\(/.test(f), 'a hard delete must ask first');
  assert.ok(/fetch\('\/api\/bookings\/'\+bookingId,\{method:'DELETE'/.test(f),
    'upcomingDelete no longer calls DELETE /api/bookings/:id');
  assert.ok(/credentials:'include'/.test(f), 'without credentials the route 401s and the delete silently fails');
  assert.ok(/d\.ok/.test(f), 'the handler must check the {ok:true} the route returns');
});

test('THE BUG: a screen showing the deleted booking must not survive the delete', () => {
  const f = fnBody(OWNER, 'upcomingDelete');
  assert.ok(/closeTripPage\(\)/.test(f),
    'upcomingDelete leaves the full-screen trip page open on a booking that no longer exists — ' +
    'which is exactly what the owner saw when he said Delete did nothing');
  assert.ok(/_tripPageId/.test(f), 'it must close the page only when it is showing THIS booking');
});

test('refreshTripPage() is actually called — a helper nobody calls is not a fix', () => {
  const calls = (OWNER.match(/refreshTripPage\(\)/g) || []).length;
  assert.ok(calls >= 2,
    'refreshTripPage() appears ' + calls + ' time(s) — it must be DEFINED and CALLED. ' +
    'It sat unreferenced from the day the trip page shipped, which is why every action on ' +
    'that page looked like it did nothing.');
  const loader = fnBody(OWNER, 'loadOwnerBookings');
  assert.ok(/refreshTripPage\(\)/.test(loader),
    'loadOwnerBookings() must refresh the trip page too — it is the single path every action ' +
    'goes through after it succeeds');
});

test('every core owner action refreshes after it succeeds', () => {
  // Delete is the one that was reported, but they all share the same refresh,
  // so they all shared the same silence on the trip page.
  for (const name of ['upcomingDelete', 'ownerMarkPaid', 'ownerMarkCompleted', 'upcomingSave']) {
    const f = fnBody(OWNER, name);
    assert.ok(/loadOwnerBookings\(\)/.test(f), name + '() no longer refreshes after succeeding');
  }
  const est = OWNER.slice(OWNER.indexOf('async function ownerSendEstimate'));
  assert.ok(/loadOwnerBookings\(\)/.test(est.slice(0, est.indexOf('\n}\n'))),
    'ownerSendEstimate() no longer refreshes after succeeding');
});

test('the admin delete is wired the same way', () => {
  const i = ADMIN.indexOf('async function admDeleteBooking');
  const f = ADMIN.slice(i, ADMIN.indexOf('\n}\n', i) + 2);
  assert.ok(/fetch\('\/api\/bookings\/'\+bookingId,\{method:'DELETE'/.test(f), 'admDeleteBooking no longer calls the route');
  assert.ok(/credentials:'include'/.test(f), 'admin delete must send credentials');
  assert.ok(/loadLiveBookings\(\)/.test(f), 'admin delete must refresh its list');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/owner-actions\.test\.js/.test(read('package.json')), 'owner-actions.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
