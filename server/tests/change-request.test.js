/**
 * Customer CHANGE REQUEST guardrail — run with:
 *   node server/tests/change-request.test.js   (also gated by `npm test`)
 *
 * WHAT THIS FEATURE IS, AND THE ONE THING IT MUST NOT DO
 *   A customer can ask, from My Account, for an already-booked trip to be
 *   changed — a later pickup, a different address, an extra passenger. The
 *   request goes to the OWNER, who decides and applies it by hand.
 *
 *   It must NEVER apply itself. The form is pre-filled with the trip's real
 *   values and looks exactly like an edit form, which is precisely why this
 *   guardrail exists: one careless UPDATE in that route and a customer would
 *   be silently re-routing a job the driver is already planning around, or
 *   nudging a `pending` booking into `confirmed` — the same class of fault as
 *   the "Mr Ben" incident that the estimate-first rule came out of
 *   (see CLAUDE.md).
 *
 * The four things pinned here, per the owner's rule that every change is
 * guarded:
 *   (a) a change request does NOT modify the booking's core fields or status;
 *   (b) it emails the OWNER with the ref and the requested changes;
 *   (c) it is ownership-checked — a customer cannot request a change on
 *       somebody else's booking;
 *   (d) it surfaces as "Change requested" in BOTH the owner and admin apps,
 *       and is stored so it survives a missed email.
 *
 * These run the SHIPPED handler (extracted from server/api.js) and the SHIPPED
 * email template against a throwaway database and a stubbed Resend, so the
 * test cannot pass on code we no longer ship. Pure Node, no framework.
 * Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

process.env.RESEND_API_KEY = 'test_fake';
process.env.ADMIN_EMAIL = 'owner@westmereprivatehire.co.uk';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const apiSrc = read('server/api.js');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const RIDER = read('westmere-rider.html');
// The REAL shared lifecycle module — the stage rule, the field order and the
// price rule are asserted against what actually ships, never re-implemented.
const LC = require('../../wm-lifecycle');

// ── Pull the real route handler + its helpers out of server/api.js ───────
function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces at ' + from);
}
function extractHandler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  return braceBody(apiSrc, apiSrc.indexOf('=>', start));
}
function extractFn(name) {
  const start = apiSrc.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'server/api.js no longer defines ' + name + '()');
  // Keep `async` — rebuilding an async helper as a plain function turns its
  // `await` into a syntax error, and quietly changes what is under test.
  const isAsync = apiSrc.slice(Math.max(0, start - 6), start) === 'async ';
  const head = apiSrc.slice(apiSrc.indexOf('(', start) + 1, apiSrc.indexOf('{', start)).trim().replace(/\)$/, '');
  return (isAsync ? 'async ' : '') + 'function ' + name + '(' + head + ') {' + braceBody(apiSrc, start) + '}';
}

const fieldsDecl = apiSrc.match(/const CHANGE_REQUEST_FIELDS = \[[^\]]*\];/);
assert.ok(fieldsDecl, 'server/api.js no longer declares CHANGE_REQUEST_FIELDS');
const helpers = new Function(
  fieldsDecl[0] + '\n' + extractFn('crNorm') + '\n' + extractFn('ukNow') + '\n' +
  'return { CHANGE_REQUEST_FIELDS: CHANGE_REQUEST_FIELDS, crNorm: crNorm, ukNow: ukNow };'
)();

const CHANGE_BODY  = extractHandler('post', '/customer/bookings/:id/change-request');
const REVIEW_BODY  = extractHandler('post', '/bookings/:id/change-request/review');
const ACCEPT_BODY  = extractHandler('post', '/bookings/:id/change-request/accept');
const DECLINE_BODY = extractHandler('post', '/bookings/:id/change-request/decline');

// The staff routes share small helpers defined alongside them in api.js; pull
// those out too so the handlers run exactly as shipped.
const staffHelpers = extractFn('staffBooking') + '\n' + extractFn('closeChangeRequests') + '\n' +
                     extractFn('settledPaymentOf') + '\n' + extractFn('suggestFareFor') + '\n';

// The handlers are (async) arrows; re-hosted here with their collaborators
// injected so they run exactly as shipped, against a throwaway DB.
function makeRunner(body, withStaffHelpers) {
  return new Function(
    'req', 'res', 'getDb', 'events', 'require', 'ukNow', 'crNorm', 'CHANGE_REQUEST_FIELDS', 'console',
    'autoFile', 'gcal',
    (withStaffHelpers ? staffHelpers : '') + 'return (async () => {' + body + '})();'
  );
}
const runChange  = makeRunner(CHANGE_BODY);
const runReview  = makeRunner(REVIEW_BODY,  true);
const runAccept  = makeRunner(ACCEPT_BODY,  true);
const runDecline = makeRunner(DECLINE_BODY, true);

// ── Throwaway database with the shipped shape ────────────────────────────
// Mirrors server/db.js: the core booking columns the guard is about, plus the
// two denormalised change-request columns and the change_requests table.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE, full_name TEXT, phone TEXT, active INTEGER DEFAULT 1
    );
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      customer_id INTEGER, driver_id INTEGER,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, stop_address TEXT,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT 'ASAP',
      passengers INTEGER NOT NULL DEFAULT 1, bags TEXT NOT NULL DEFAULT '0',
      trip_type TEXT, flight TEXT, fare REAL, payment TEXT DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT, customer_note TEXT,
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT,
      paid_at TEXT, pay_token TEXT, calendar_event_id TEXT,
      change_requested_at TEXT, change_request_summary TEXT, change_request_detail TEXT,
      fare_review_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL, booking_ref TEXT NOT NULL, customer_id INTEGER,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      current_json TEXT NOT NULL, requested_json TEXT NOT NULL,
      changed_json TEXT NOT NULL DEFAULT '{}', summary TEXT, note TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actioned_at TEXT, actioned_by INTEGER
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// A date safely in the future, as a UK wall-clock string — never built through
// a Date instant (see the timezone invariant in CLAUDE.md).
function futureDate(daysAhead) {
  const uk = helpers.ukNow();
  const d = new Date(Date.UTC(uk.year, uk.month - 1, uk.day + daysAhead));
  return d.toISOString().slice(0, 10);
}
const TRIP_DATE = futureDate(20);
const NEW_DATE  = futureDate(23);

// Every column that describes the JOURNEY or its state. If a change request
// can move any of these, the feature is broken.
const CORE_COLUMNS = ['pickup', 'destination', 'stop_address', 'date', 'time', 'passengers',
                      'bags', 'flight', 'trip_type', 'fare', 'payment', 'status', 'driver_id',
                      'paid_at', 'notes', 'customer_id'];

function seed(db, over) {
  over = over || {};
  db.prepare('INSERT INTO customers (id,email,full_name,phone) VALUES (?,?,?,?)')
    .run(1, 'ben@example.com', 'Mr Ben', '07700900123');
  db.prepare('INSERT INTO customers (id,email,full_name,phone) VALUES (?,?,?,?)')
    .run(2, 'someone.else@example.com', 'Other Person', '07700900999');
  db.prepare(`INSERT INTO bookings
      (id,ref,customer_id,pickup,destination,stop_address,date,time,passengers,bags,flight,fare,payment,status,passenger_name,passenger_email,passenger_phone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(10, 'WPH-CR1',
      over.customer_id === undefined ? 1 : over.customer_id,
      'Greenhill Avenue, Caterham', 'Gatwick Airport', 'Redhill Station',
      TRIP_DATE, '09:00', 2, '2s+1l', 'BA2431', 96, 'card',
      over.status || 'confirmed',
      'Mr Ben', over.passenger_email === undefined ? 'ben@example.com' : over.passenger_email, '07700900123');
  return db.prepare('SELECT * FROM bookings WHERE id = 10').get();
}

// Stubbed Resend — captures the payload the shipped email code would send.
let sent = [];
global.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ id: 'test-id' }) };
};

// Collaborators the shipped handlers reach for. The handler bodies were lifted
// out of server/api.js, so their require() paths are relative to THAT file —
// resolve them from there, or the route silently loses the real email template
// and the real shared lifecycle module (the price rule and the field order are
// deliberately not re-implemented in this test).
const AS_API = { './email': '../email', '../wm-lifecycle': '../../wm-lifecycle' };
// The quick-estimate geocodes over the network. Stubbed so the accept tests are
// deterministic and offline — what they are about is that Accept SUGGESTS a
// price without applying it, not what the price engine returns.
const FARE_STUB = { computeSuggestedFare: async () => ({ fare: 152.5 }) };
const inject = (m) => {
  if (m === './fare-engine') return FARE_STUB;
  return require(Object.prototype.hasOwnProperty.call(AS_API, m) ? AS_API[m] : m);
};
const noopAutoFile = { fileBooking() {} };
const noopGcal = { updateEvent: () => Promise.resolve(true) };

function callChange(db, body, auth) {
  sent = [];
  const out = { code: 200, payload: null };
  const res = {
    status(c) { out.code = c; return this; },
    json(p) { out.payload = p; return this; }
  };
  const req = { auth: auth || { role: 'customer', type: 'customer', id: 1 }, params: { id: '10' }, body: body, ip: '127.0.0.1' };
  return runChange(req, res, () => db, { broadcast() {} }, inject,
    helpers.ukNow, helpers.crNorm, helpers.CHANGE_REQUEST_FIELDS, console,
    noopAutoFile, noopGcal)
    .then(() => out);
}

// Run one of the STAFF actions (review / accept / decline) as shipped.
function callStaff(runner, db, auth, id) {
  const out = { code: 200, payload: null };
  const res = {
    status(c) { out.code = c; return this; },
    json(p) { out.payload = p; return this; }
  };
  const req = { auth: auth || { role: 'owner', type: 'user', id: 7 }, params: { id: String(id || 10) }, body: {}, ip: '127.0.0.1' };
  return Promise.resolve(
    runner(req, res, () => db, { broadcast() {} }, inject,
      helpers.ukNow, helpers.crNorm, helpers.CHANGE_REQUEST_FIELDS, console,
      noopAutoFile, noopGcal)
  ).then(() => out);
}

const GOOD_BODY = {
  pickup: 'Greenhill Avenue, Caterham',
  stop_address: 'Redhill Station',
  destination: 'Gatwick Airport',
  date: NEW_DATE,
  time: '11:30',
  passengers: 3,
  bags: '2s+1l',
  flight: 'BA2431',
  note: 'Flight has moved — could we go three hours later please?'
};

// ══════════════════════════════════════════════════════════════════════════
// (a) THE BOOKING IS NOT TOUCHED
// ══════════════════════════════════════════════════════════════════════════
console.log('\n(a) A change request must NOT modify the booking');

test('a successful change request leaves every core field and the status alone', async () => {
  const db = makeDb();
  const before = seed(db);
  const out = await callChange(db, GOOD_BODY);
  assert.strictEqual(out.code, 200, 'the request should be accepted (got ' + out.code + ': ' + JSON.stringify(out.payload) + ')');
  const after = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  for (const col of CORE_COLUMNS) {
    assert.strictEqual(after[col], before[col],
      'bookings.' + col + ' changed (' + JSON.stringify(before[col]) + ' → ' + JSON.stringify(after[col]) +
      ') — a change request must ASK, never apply');
  }
});

test('a change request can never confirm a pending booking (estimate-first)', async () => {
  const db = makeDb();
  seed(db, { status: 'pending' });
  const out = await callChange(db, GOOD_BODY);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id = 10').get().status, 'pending',
    'requesting a change must never move a booking out of pending — that is the "Mr Ben" fault');
});

test('the route contains no UPDATE that writes a core booking column', () => {
  // Belt-and-braces over the behavioural test above: read the shipped SQL.
  const updates = CHANGE_BODY.match(/UPDATE\s+bookings\s+SET[\s\S]*?WHERE/gi) || [];
  assert.ok(updates.length >= 1, 'the route should still flag the booking');
  for (const u of updates) {
    for (const col of CORE_COLUMNS) {
      assert.ok(!new RegExp('\\b' + col + '\\s*=').test(u),
        'the change-request route writes bookings.' + col + ' — it must only set the flag columns');
    }
  }
});

test('only the flag columns may be written, and none of them is a booking detail', () => {
  const u = (CHANGE_BODY.match(/UPDATE\s+bookings\s+SET([\s\S]*?)WHERE/i) || [])[1] || '';
  const cols = (u.match(/(\w+)\s*=/g) || []).map(s => s.replace(/\s*=$/, ''));
  assert.deepStrictEqual(cols.sort(), ['change_request_detail', 'change_request_summary', 'change_requested_at'],
    'the only columns the CUSTOMER route may set are the flag and the two renderings of the ask ' +
    '(got: ' + cols.join(', ') + ')');
});

// ══════════════════════════════════════════════════════════════════════════
// (b) THE OWNER IS EMAILED, WITH THE REF AND THE DIFF
// ══════════════════════════════════════════════════════════════════════════
console.log('\n(b) The owner is emailed the ref and the requested changes');

test('the owner receives an email carrying the booking ref', async () => {
  const db = makeDb();
  seed(db);
  const out = await callChange(db, GOOD_BODY);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(sent.length, 1, 'exactly one owner alert must be sent (got ' + sent.length + ')');
  const mail = sent[0];
  assert.strictEqual(mail.to, 'owner@westmereprivatehire.co.uk', 'the alert goes to the OWNER, not the customer');
  assert.ok(/WPH-CR1/.test(mail.subject), 'the subject must carry the ref, or the owner cannot tell which booking');
  assert.ok(/WPH-CR1/.test(mail.html), 'the body must carry the ref too');
});

test('the email shows every requested change as was → now', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const html = sent[0].html;
  // date, time and passengers were edited; pickup/destination/bags/flight were not.
  assert.ok(html.includes(TRIP_DATE) && html.includes(NEW_DATE),
    'both the current date and the requested date must appear, so the owner sees what moved');
  assert.ok(/09:00/.test(html) && /11:30/.test(html), 'the old and new times must both appear');
  assert.ok(/&rarr;|→/.test(html), 'changed values must be rendered as an old → new pair');
  assert.ok(/Requested changes/i.test(html), 'the changed fields must be under their own heading');
});

test("the email carries the customer's note and their contact details", async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const html = sent[0].html;
  assert.ok(html.includes('Flight has moved'), "the customer's own words must reach the owner");
  assert.ok(html.includes('ben@example.com'), 'the owner must be able to reply to the customer');
  assert.ok(html.includes('Mr Ben'), 'the customer name must be shown');
});

test('the email states plainly that nothing has been changed', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  assert.ok(/Nothing has been altered/i.test(sent[0].html),
    'the owner must not be able to read this as "already applied" — the whole feature turns on that');
});

test('a Resend outage loses neither the request nor the customer', async () => {
  const db = makeDb();
  seed(db);
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('resend is down'); };
  try {
    const out = await callChange(db, GOOD_BODY);
    assert.strictEqual(out.code, 200, 'the customer must still get a success — the record is the source of truth');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM change_requests').get().c, 1,
      'the request must be stored even when the email cannot go out');
  } finally { global.fetch = realFetch; }
});

// ══════════════════════════════════════════════════════════════════════════
// (c) OWNERSHIP
// ══════════════════════════════════════════════════════════════════════════
console.log('\n(c) A customer can only request changes on their OWN booking');

test("another customer's request is refused with 403 and writes nothing", async () => {
  const db = makeDb();
  seed(db);
  const out = await callChange(db, GOOD_BODY, { role: 'customer', type: 'customer', id: 2 });
  assert.strictEqual(out.code, 403, 'a stranger must be refused (got ' + out.code + ')');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM change_requests').get().c, 0,
    'a refused request must leave no record behind');
  assert.strictEqual(db.prepare('SELECT change_requested_at FROM bookings WHERE id = 10').get().change_requested_at, null,
    'a refused request must not flag the booking');
  assert.strictEqual(sent.length, 0, 'a refused request must not email the owner');
});

test('a booking with no customer_id is owned by the matching account EMAIL', async () => {
  // The same rule the trip list and self-cancel use: customer_id is NULL for
  // every job the owner enters by hand and for anything booked before the
  // customer registered. Those trips ARE listed in My Account, so a stricter
  // rule here would show a Request-a-change button and then refuse it.
  const db = makeDb();
  seed(db, { customer_id: null });
  const out = await callChange(db, GOOD_BODY, { role: 'customer', type: 'customer', id: 1 });
  assert.strictEqual(out.code, 200,
    'the owner of the email on the booking must be able to request a change (got ' + out.code + ')');
});

test('an email-matched booking is still refused for a DIFFERENT account', async () => {
  const db = makeDb();
  seed(db, { customer_id: null });
  const out = await callChange(db, GOOD_BODY, { role: 'customer', type: 'customer', id: 2 });
  assert.strictEqual(out.code, 403, 'matching on email must not become a way in for everyone');
});

test('staff and driver sessions cannot use the customer endpoint', async () => {
  for (const role of ['admin', 'owner', 'driver']) {
    const db = makeDb();
    seed(db);
    const out = await callChange(db, GOOD_BODY, { role: role, type: role, id: 1 });
    assert.strictEqual(out.code, 403, role + ' must not reach the customer change-request route');
  }
});

test('a completed or cancelled booking can no longer be changed online', async () => {
  for (const status of ['completed', 'cancelled', 'active']) {
    const db = makeDb();
    seed(db, { status: status });
    const out = await callChange(db, GOOD_BODY);
    assert.strictEqual(out.code, 409, 'a ' + status + ' booking must be refused (got ' + out.code + ')');
  }
});

test('a date in the past is refused', async () => {
  const db = makeDb();
  seed(db);
  const out = await callChange(db, Object.assign({}, GOOD_BODY, { date: '2020-01-01' }));
  assert.strictEqual(out.code, 400, 'a past date must be refused');
});

test('a request that changes nothing and says nothing is refused', async () => {
  const db = makeDb();
  const before = seed(db);
  const out = await callChange(db, {
    pickup: before.pickup, stop_address: before.stop_address, destination: before.destination,
    date: before.date, time: before.time, passengers: before.passengers,
    bags: before.bags, flight: before.flight, note: ''
  });
  assert.strictEqual(out.code, 400, 'an untouched form with no note is not a request');
});

test('passengers outside 1–8 is refused', async () => {
  for (const pax of [0, -1, 99]) {
    const db = makeDb();
    seed(db);
    const out = await callChange(db, Object.assign({}, GOOD_BODY, { passengers: pax }));
    assert.strictEqual(out.code, 400, pax + ' passengers must be refused (got ' + out.code + ')');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// (d) IT IS STORED, AND IT SURFACES TO STAFF
// ══════════════════════════════════════════════════════════════════════════
console.log('\n(d) Stored durably, and visible in the owner + admin apps');

test('the full request is stored — snapshot, ask, diff, note and contact', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const row = db.prepare('SELECT * FROM change_requests WHERE booking_id = 10').get();
  assert.ok(row, 'a change_requests row must exist — the email can be missed, this cannot');
  assert.strictEqual(row.booking_ref, 'WPH-CR1');
  assert.strictEqual(row.status, 'open');
  assert.strictEqual(row.note, GOOD_BODY.note);
  assert.strictEqual(row.contact_email, 'ben@example.com');
  const current = JSON.parse(row.current_json), requested = JSON.parse(row.requested_json), changed = JSON.parse(row.changed_json);
  assert.strictEqual(current.date, TRIP_DATE, 'the snapshot must record the trip AS IT WAS');
  assert.strictEqual(requested.date, NEW_DATE, 'the ask must record what they wanted');
  assert.deepStrictEqual(Object.keys(changed).sort(), ['date', 'passengers', 'time'],
    'the diff must be exactly the fields the customer altered (got: ' + Object.keys(changed).join(', ') + ')');
});

test('a second request never overwrites the first', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  await callChange(db, Object.assign({}, GOOD_BODY, { note: 'Actually, two extra bags as well.' }));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM change_requests').get().c, 2,
    'every request must be kept — the owner has to see everything that was asked');
});

test('an audit_log entry records the request', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'booking_change_requested'").get();
  assert.ok(a, 'the request must be audited');
  assert.ok(/WPH-CR1/.test(a.detail), 'the audit entry must name the booking');
});

test('the booking is flagged with a readable summary of what was asked', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const b = db.prepare('SELECT change_requested_at, change_request_summary FROM bookings WHERE id = 10').get();
  assert.ok(b.change_requested_at, 'the booking must carry the "change requested" flag for the staff lists');
  assert.ok(/Date:/.test(b.change_request_summary) && b.change_request_summary.includes(NEW_DATE),
    'the summary must say what was asked, so the owner needs no second fetch');
});

test('the booking also carries the request in the shape the panels RENDER', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const b = db.prepare('SELECT change_request_detail FROM bookings WHERE id = 10').get();
  const d = LC.changeRequestDetail(b);
  assert.deepStrictEqual(d.changed.map(c => c.key), ['date', 'time', 'passengers'],
    'the detail must list the changed fields in the shared CHANGE_FIELDS order');
  const date = d.changed.find(c => c.key === 'date');
  assert.strictEqual(date.current, TRIP_DATE, 'each row must carry the CURRENT value');
  assert.strictEqual(date.requested, NEW_DATE, 'each row must carry the REQUESTED value');
  assert.strictEqual(date.label, 'Date', 'each row must carry a human label');
  assert.strictEqual(d.note, GOOD_BODY.note);
  assert.strictEqual(d.price, true, 'a date/time/passenger change can move the fare');
});

test('a flight-number-only change does NOT raise the fare warning', async () => {
  const db = makeDb();
  const before = seed(db);
  await callChange(db, {
    pickup: before.pickup, stop_address: before.stop_address, destination: before.destination,
    date: before.date, time: before.time, passengers: before.passengers, bags: before.bags,
    flight: 'BA9999', note: ''
  });
  const b = db.prepare('SELECT change_request_detail FROM bookings WHERE id = 10').get();
  assert.strictEqual(LC.changeRequestDetail(b).price, false,
    'a new flight number costs nothing — it must not cry wolf about the fare');
});

// ══════════════════════════════════════════════════════════════════════════
// STAGE AWARENESS — a not-yet-committed trip is a note; a committed one is
// a decision. The stage rule lives in the shared module so the owner and
// admin apps cannot drift (see admin-parity.test.js).
// ══════════════════════════════════════════════════════════════════════════
console.log('\nStage: quiet note before commitment, decision panel after');

test('an uncommitted booking is EARLY — a note, with nothing to accept', () => {
  for (const status of ['pending', 'offered', 'awaiting_payment']) {
    const j = { status, change_requested_at: '2026-08-13 08:00' };
    assert.strictEqual(LC.changeRequestStage(j), 'early', status + ' must be the quiet early stage');
    const A = LC.actionsFor(j);
    assert.ok(A.reviewChange, status + ' must offer the low-key Reviewed dismiss');
    assert.ok(!A.acceptChange && !A.declineChange,
      'there is nothing to accept before the trip is committed — the owner just re-prices');
  }
});

test('a committed booking is a DECISION — accept or decline, no quiet note', () => {
  for (const status of ['confirmed', 'active']) {
    const j = { status, change_requested_at: '2026-08-13 08:00', paid_at: '2026-08-13' };
    assert.strictEqual(LC.changeRequestStage(j), 'decision', status + ' must raise the decision panel');
    const A = LC.actionsFor(j);
    assert.ok(A.acceptChange && A.declineChange, status + ' must offer Accept and Decline');
    assert.ok(!A.reviewChange, 'a committed trip must not be dismissable with a quiet "Reviewed"');
  }
});

test('a CONFIRMED but unpaid (cash on the day) trip still gets the decision panel', () => {
  // The journey is just as committed — a driver is allocated and the customer
  // expects that car. Payment state changes the fare WARNING, not the stage.
  const j = { status: 'confirmed', payment: 'cash', paid_at: null, change_requested_at: '2026-08-13 08:00' };
  assert.strictEqual(LC.changeRequestStage(j), 'decision');
});

test('a booking with no request is stage "none" and offers no change actions', () => {
  const A = LC.actionsFor({ status: 'confirmed' });
  assert.strictEqual(LC.changeRequestStage({ status: 'confirmed' }), 'none');
  assert.ok(!A.acceptChange && !A.declineChange && !A.reviewChange);
});

test('a corrupt detail blob costs the panel its contents, never the page', () => {
  for (const bad of ['{not json', '', null, '[]', '{"changed":"nope"}']) {
    const d = LC.changeRequestDetail({ change_request_detail: bad });
    assert.deepStrictEqual(d.changed, [], 'must degrade to an empty list, not throw');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// EARLY STAGE — Review
// ══════════════════════════════════════════════════════════════════════════
console.log('\nEarly stage: Reviewed clears the note and touches nothing');

test('Reviewed clears the flag, keeps the record, and never amends the booking', async () => {
  const db = makeDb();
  const before = seed(db, { status: 'pending' });
  await callChange(db, GOOD_BODY);
  const out = await callStaff(runReview, db);
  assert.strictEqual(out.code, 200);
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.change_requested_at, null, 'the note must clear');
  assert.strictEqual(b.change_request_detail, null, 'the rendered detail must clear with it');
  assert.strictEqual(db.prepare('SELECT status FROM change_requests WHERE booking_id = 10').get().status, 'reviewed',
    'the request itself is kept for good — only its status moves');
  for (const col of CORE_COLUMNS) {
    assert.strictEqual(b[col], before[col], 'Reviewed must not amend bookings.' + col);
  }
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'booking_change_reviewed'").get(), 'must be audited');
});

// ══════════════════════════════════════════════════════════════════════════
// DECISION STAGE — Accept applies; Decline does not
// ══════════════════════════════════════════════════════════════════════════
console.log('\nDecision stage: Accept applies the change, Decline keeps the booking');

test('Accept APPLIES the requested values to the booking', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const out = await callStaff(runAccept, db);
  assert.strictEqual(out.code, 200, 'the owner must be able to accept (got ' + JSON.stringify(out.payload) + ')');
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.date, NEW_DATE, 'the requested date must now be the booking date');
  assert.strictEqual(b.time, '11:30', 'the requested time must now be the booking time');
  assert.strictEqual(b.passengers, 3, 'the requested passenger count must be applied');
  assert.deepStrictEqual((out.payload || {}).applied.sort(), ['date', 'passengers', 'time']);
});

test('Accept SUGGESTS a new fare without applying it', async () => {
  // The second half of accepting is the owner's: they see this figure, override
  // it if they disagree, and only then does the estimate go out.
  const db = makeDb();
  const before = seed(db);
  await callChange(db, GOOD_BODY);
  const out = await callStaff(runAccept, db);
  assert.strictEqual(out.payload.suggested_fare, 152.5, 'the owner must be offered a price for the NEW journey');
  assert.strictEqual(out.payload.current_fare, before.fare, 'and shown what it was');
  assert.strictEqual(db.prepare('SELECT fare FROM bookings WHERE id = 10').get().fare, before.fare,
    'the suggestion must NOT be written — accepting a journey change never re-prices by itself');
});

test('Accept still refuses to touch the money or the status', async () => {
  const db = makeDb();
  const before = seed(db);
  await callChange(db, GOOD_BODY);
  await callStaff(runAccept, db);
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  for (const col of ['fare', 'payment', 'paid_at', 'status', 'driver_id']) {
    assert.strictEqual(b[col], before[col],
      'Accept changed bookings.' + col + ' — applying a journey change must never re-price, ' +
      'charge, refund, or move the booking along its lifecycle');
  }
});

test('Accept raises the fare-review flag when the change can move the price', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  const out = await callStaff(runAccept, db);
  assert.strictEqual((out.payload || {}).fare_review, true, 'the caller must be told the price may have moved');
  assert.ok(db.prepare('SELECT fare_review_at FROM bookings WHERE id = 10').get().fare_review_at,
    'the job must keep "Fare may change — confirm with the customer" until the owner clears it');
});

test('Accept does NOT raise the fare flag for a flight-number-only change', async () => {
  const db = makeDb();
  const before = seed(db);
  await callChange(db, {
    pickup: before.pickup, stop_address: before.stop_address, destination: before.destination,
    date: before.date, time: before.time, passengers: before.passengers, bags: before.bags,
    flight: 'BA9999', note: ''
  });
  const out = await callStaff(runAccept, db);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(db.prepare('SELECT flight FROM bookings WHERE id = 10').get().flight, 'BA9999',
    'the new flight number must still be applied');
  assert.strictEqual(db.prepare('SELECT fare_review_at FROM bookings WHERE id = 10').get().fare_review_at, null,
    'a flight number costs nothing — no fare warning');
});

test('Accept audits exactly what it applied', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  await callStaff(runAccept, db);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'booking_change_accepted'").get();
  assert.ok(a, 'accepting a change must be audited — it is the one path that edits the trip');
  assert.ok(/WPH-CR1/.test(a.detail), 'the audit entry must name the booking');
  assert.ok(/date/.test(a.detail) && /fare review/.test(a.detail),
    'the audit entry must say what was applied and that a fare review was raised (got: ' + a.detail + ')');
});

test('Accept closes the request as accepted and clears the flags', async () => {
  const db = makeDb();
  seed(db);
  await callChange(db, GOOD_BODY);
  await callStaff(runAccept, db);
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.change_requested_at, null);
  assert.strictEqual(b.change_request_detail, null);
  assert.strictEqual(db.prepare('SELECT status FROM change_requests WHERE booking_id = 10').get().status, 'accepted');
});

test('Accept RE-VALIDATES the stored request instead of trusting it', async () => {
  // The values were checked when the customer sent them, but this is the
  // moment they actually reach the booking — possibly days later. A stored
  // blob that no longer passes must be refused, not written.
  for (const [field, bad] of [['time', '99:99'], ['date', 'not-a-date'], ['passengers', 42]]) {
    const db = makeDb();
    seed(db);
    await callChange(db, GOOD_BODY);
    const row = db.prepare('SELECT requested_json FROM change_requests WHERE booking_id = 10').get();
    const tampered = JSON.stringify(Object.assign(JSON.parse(row.requested_json), { [field]: bad }));
    db.prepare('UPDATE change_requests SET requested_json = ? WHERE booking_id = 10').run(tampered);
    const out = await callStaff(runAccept, db);
    assert.strictEqual(out.code, 400, 'an invalid stored ' + field + ' must be refused (got ' + out.code + ')');
    const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
    assert.strictEqual(b.time, '09:00', 'nothing may be written when the request cannot be applied');
    assert.strictEqual(b.date, TRIP_DATE, 'the apply must be all-or-nothing, not partial');
  }
});

test('Accept on an unreadable stored request fails safely', async () => {
  const db = makeDb();
  const before = seed(db);
  await callChange(db, GOOD_BODY);
  db.prepare('UPDATE change_requests SET requested_json = ? WHERE booking_id = 10').run('{ not json');
  const out = await callStaff(runAccept, db);
  assert.strictEqual(out.code, 500, 'an unreadable request must be reported, not guessed at');
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  for (const col of CORE_COLUMNS) {
    assert.strictEqual(b[col], before[col], 'nothing may be written from an unreadable request');
  }
});

test('Accept with no open request is a 409, not a silent no-op', async () => {
  const db = makeDb();
  seed(db);
  const out = await callStaff(runAccept, db);
  assert.strictEqual(out.code, 409);
});

test('Decline clears the flag and leaves every trip detail exactly as booked', async () => {
  const db = makeDb();
  const before = seed(db);
  await callChange(db, GOOD_BODY);
  const out = await callStaff(runDecline, db);
  assert.strictEqual(out.code, 200);
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  for (const col of CORE_COLUMNS) {
    assert.strictEqual(b[col], before[col],
      'Decline changed bookings.' + col + ' — declining must keep the journey exactly as originally booked');
  }
  assert.strictEqual(b.change_requested_at, null, 'the decision is made, so the flag clears');
  assert.strictEqual(b.fare_review_at, null, 'declining cannot move the price, so no fare warning');
  assert.strictEqual(db.prepare('SELECT status FROM change_requests WHERE booking_id = 10').get().status, 'declined',
    'the record must show it was declined, not merely dismissed');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'booking_change_declined'").get(), 'must be audited');
});

test('only staff may review, accept or decline', async () => {
  for (const [name, runner] of [['review', runReview], ['accept', runAccept], ['decline', runDecline]]) {
    for (const auth of [{ role: 'customer', type: 'customer', id: 1 }, { role: 'driver', type: 'user', id: 3 }]) {
      const db = makeDb();
      seed(db);
      await callChange(db, GOOD_BODY);
      const out = await callStaff(runner, db, auth);
      assert.strictEqual(out.code, 403, auth.role + ' must not be able to ' + name + ' a change request');
      assert.ok(db.prepare('SELECT change_requested_at FROM bookings WHERE id = 10').get().change_requested_at,
        'a refused ' + name + ' must leave the request standing');
    }
  }
});

test('a customer can never reach the apply path, however they ask', async () => {
  // The whole design rests on this: the customer's own route records the ask,
  // and ONLY the staff Accept action ever writes it onto the booking.
  const db = makeDb();
  const before = seed(db);
  await callChange(db, GOOD_BODY);
  await callStaff(runAccept, db, { role: 'customer', type: 'customer', id: 1 });
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  for (const col of CORE_COLUMNS) {
    assert.strictEqual(b[col], before[col], 'a customer-driven accept must not amend bookings.' + col);
  }
});

// ── The staff apps render the right thing at the right stage ─────────────
console.log('\nBoth staff apps: early note vs decision panel');

test('both apps take the STAGE from the shared module, not their own rule', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/WMLifecycle\.changeRequestStage\(/.test(src),
      name + ' must decide the stage via WMLifecycle.changeRequestStage — a local rule would let the two apps drift');
    assert.ok(/WMLifecycle\.changeRequestDetail\(/.test(src),
      name + ' must read the Current → Requested rows via the shared parser');
  }
});

test('both apps render the EARLY note with its exact wording', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/Edited by the customer/.test(src), name + ' must show "Edited by the customer" at the early stage');
    assert.ok(/Review before you send the estimate/.test(src),
      name + ' must tell the owner what to do with it: review before sending the estimate');
    assert.ok(/changedFieldsLabel\(/.test(src), name + ' must say WHAT changed in the note');
  }
});

test('both apps render the DECISION panel with Current → Requested', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/Journey change requested/.test(src), name + ' must title the decision panel "Journey change requested"');
    assert.ok(/>Current</.test(src) && /Requested</.test(src),
      name + ' must head the comparison with Current and Requested columns');
    assert.ok(/Accept change/.test(src), name + ' must offer "Accept change"');
    assert.ok(/>Decline</.test(src), name + ' must offer "Decline"');
    assert.ok(/Message customer/.test(src), name + ' must offer "Message customer"');
  }
});

test('both apps gate the change actions on the shared actionsFor()', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/ACT\.acceptChange|A\.acceptChange/.test(src) || /actionsFor/.test(src),
      name + ' must gate Accept/Decline on the shared actionsFor');
  }
  // …and the module really is the gate.
  const early = LC.actionsFor({ status: 'pending', change_requested_at: 'x' });
  const late = LC.actionsFor({ status: 'confirmed', change_requested_at: 'x' });
  assert.ok(early.reviewChange && !early.acceptChange);
  assert.ok(late.acceptChange && !late.reviewChange);
});

test('both apps warn that Accept does not move the money', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/Nothing is charged or refunded/.test(src),
      name + ' must make clear that accepting does not charge or refund — the owner settles the price by hand');
    assert.ok(/Fare may change|confirm the fare|Fare Confirmed|Fare confirmed/.test(src),
      name + ' must carry the "fare may change" reminder and a way to clear it');
  }
});

test('neither staff app applies a change by PATCHing the booking itself', () => {
  // Applying goes through the audited Accept endpoint, which re-validates and
  // refuses to touch fare/payment/status. A PATCH from the client would bypass
  // all of that.
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const marker = name === 'owner' ? 'function ownerAcceptChange' : 'function admAcceptChange';
    const fn = src.slice(src.indexOf(marker));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(/change-request\/accept/.test(body), name + ' Accept must call the audited accept endpoint');
    assert.ok(!/PATCH/.test(body), name + ' Accept must not PATCH the booking directly');
  }
});

test('the owner app carries the new columns through its job mapping', () => {
  for (const col of ['change_requested_at', 'change_request_detail', 'fare_review_at']) {
    assert.ok(new RegExp(col + ':b\\.' + col).test(OWNER),
      'the owner app must map ' + col + ' off the booking row, or its panel has nothing to draw');
  }
});

// ── The rider page: the entry point, and it stays blank-page-resilient ───
console.log('\nMy Account — the request form, and nothing may blank the page');

test('an upcoming trip offers "Request a change"', () => {
  assert.ok(/Request a change/.test(RIDER), 'the trip card must offer the action');
  assert.ok(/openChangeRequest\(/.test(RIDER), 'the action must open the change form');
  // The rule moved into _tripActions(), where the status chip and every other
  // action are decided from the same server-sourced row (live-status.test.js).
  // It is unchanged: no database id, no server action.
  const act = RIDER.slice(RIDER.indexOf('function _tripActions('));
  const body = act.slice(0, act.indexOf('\n}\n') + 2);
  assert.ok(/hasId=!!\(b&&b\.id\)/.test(body) && /change:\s*hasId&&/.test(body),
    'the action must require a server-backed id — a local-only row has nothing to attach a request to');
  assert.ok(/var canChange=_act\.change/.test(RIDER),
    'and the trip row must take that decision from _tripActions, not re-derive its own');
});

test('the form is pre-filled from the trip, INCLUDING the stop', () => {
  const fn = RIDER.slice(RIDER.indexOf('function openChangeRequest('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  for (const id of ['cr-from', 'cr-dest', 'cr-stop', 'cr-flight']) {
    assert.ok(body.includes(id), 'the form must pre-fill ' + id);
  }
  assert.ok(/_rCalSet_cr/.test(body) && /_rTSet_cr/.test(body),
    'the date and time pickers must be pre-set to the booking’s own date and time');
  assert.ok(/stop:b\.stop_address/.test(RIDER),
    'the stop must reach the client from the server, or every request on a booking with a stop ' +
    'reads to the owner as a request to DELETE the stop');
});

test('address fields keep the autocomplete and the pickers are the real ones', () => {
  assert.ok(/addrSearch\('cr-from','cr-sug-from'\)/.test(RIDER), 'pickup must keep the address autocomplete');
  assert.ok(/addrSearch\('cr-dest','cr-sug-dest'\)/.test(RIDER), 'destination must keep the address autocomplete');
  assert.ok(/addrSearch\('cr-stop','cr-sug-stop'\)/.test(RIDER), 'the stop must keep the address autocomplete');
  // One picker implementation, parametrised — not a second copy that can rot.
  for (const fn of ['initCalendar', 'initTimePicker', 'initPaxPicker', 'initBagsPicker']) {
    assert.ok(new RegExp('function ' + fn + '\\(pfx\\)').test(RIDER),
      fn + ' must take an id prefix so the booking form and the change form share ONE implementation');
    assert.ok(new RegExp(fn + "\\('cr'\\)").test(RIDER), fn + " must be built for the 'cr' form too");
  }
});

test('opening the form can never blank the account', () => {
  const fn = RIDER.slice(RIDER.indexOf('function openChangeRequest('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body),
    'openChangeRequest must be wrapped — it is reached from a trip card, and no button on a trip ' +
    'card may be able to take My Account down');
  const init = RIDER.slice(RIDER.indexOf('function _crInitPickers('));
  for (const step of ['initCalendar:cr', 'initTimePicker:cr', 'initPaxPicker:cr', 'initBagsPicker:cr']) {
    assert.ok(init.includes("_safe('" + step + "'"),
      step + ' must be built inside _safe() — one picker that will not build must cost that picker, not the form');
  }
});

test('the customer is told the booking has NOT changed', () => {
  assert.ok(/change request has been sent/i.test(RIDER), 'the confirmation must say the request was sent');
  assert.ok(/we[’']ll confirm the update shortly/i.test(RIDER),
    'the confirmation must make clear the change is not applied yet');
  assert.ok(/Your booking will not change yet/i.test(RIDER),
    'the form itself must say so too — a pre-filled form reads as an edit form');
});

test('the submit posts to the change-request route and nothing else', () => {
  const fn = RIDER.slice(RIDER.indexOf('async function submitChangeRequest('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(/\/change-request/.test(body), 'submit must call the change-request endpoint');
  assert.ok(!/method:'PATCH'/.test(body), 'the customer form must never PATCH the booking');
});

test('the rider service worker cache was bumped for this change', () => {
  const crypto = require('crypto');
  const sw = read('rider-sw.js');
  const actual = crypto.createHash('sha256').update(RIDER).digest('hex');
  const m = sw.match(/rider-html-sha256:\s*([0-9a-f]{64})/);
  assert.ok(m && m[1] === actual,
    'westmere-rider.html changed — bump CACHE in rider-sw.js and update the sha256 pin to:\n        ' + actual);
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/change-request\.test\.js/.test(read('package.json')),
    'change-request.test.js must run as part of `npm test`, or it guards nothing');
});

// ── Run ───────────────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
