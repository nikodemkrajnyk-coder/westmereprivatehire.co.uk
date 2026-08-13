/**
 * Rider "My Trips" guardrail — run with:
 *   node server/tests/rider-trips.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS (the "all my trips have disappeared" incident):
 *   A real customer opened My Account (westmere-rider.html) and saw
 *   "No trips found" while every one of his bookings was sitting safely in the
 *   production database. Two separate faults could produce that screen:
 *
 *   1) SCOPE — GET /api/bookings only matched `bookings.customer_id`. That
 *      column is set only when a booking is created while an account with that
 *      email already exists, so it is NULL for every booking the owner enters
 *      manually (phone/WhatsApp jobs) and for everything a customer booked
 *      BEFORE they registered. Those trips are theirs but were never returned.
 *
 *   2) RENDERING — renderTrips() built the whole list in one pass with no
 *      per-row guard, so a single row with a null status (or a corrupt
 *      localStorage cache) threw and blanked the ENTIRE history rather than
 *      dropping one card.
 *
 * This test pins both: the shipped SQL really returns email-matched bookings,
 * and the shipped renderTrips really survives edge-case rows. Pure Node, no
 * framework. Exit 1 on failure.
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

console.log('\nRider My Account — trip history guardrail');

// ── 1. SERVER SCOPE ──────────────────────────────────────────────────────
// Pull the ACTUAL customer-branch SQL out of server/api.js and run it against a
// throwaway database, so this can never pass on a query we no longer ship.
const apiSrc = read('server/api.js');

function customerBookingsSql() {
  const branch = apiSrc.split("} else if (type === 'customer') {")[1];
  assert.ok(branch, "server/api.js no longer has a `type === 'customer'` branch in GET /bookings");
  const m = branch.match(/db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'could not extract the customer bookings query from server/api.js');
  return m[1];
}

test('GET /bookings still has a customer branch with an extractable query', () => {
  assert.ok(/SELECT[\s\S]*FROM bookings/i.test(customerBookingsSql()));
});

test("a customer sees bookings linked by customer_id AND by their account email", () => {
  const sql = customerBookingsSql()
    // the shipped query joins `users` for driver details; keep the join honest
    // but strip nothing — we create the same tables below.
    ;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, vehicle TEXT, reg TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY, ref TEXT, customer_id INTEGER, driver_id INTEGER,
      pickup TEXT, destination TEXT, date TEXT, time TEXT, status TEXT,
      fare REAL, passengers INTEGER, passenger_email TEXT
    );
    INSERT INTO customers (id,email,full_name) VALUES (1,'ben@example.com','Ben');
    INSERT INTO customers (id,email,full_name) VALUES (2,'other@example.com','Other');
    -- linked the modern way
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-LINKED',1,'Horsham','Gatwick','2026-09-02','07:30','confirmed',NULL);
    -- taken over the phone / entered by the owner: no customer_id, email only
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-MANUAL',NULL,'Gatwick','Horsham','2026-07-11','19:05','completed','Ben@Example.com ');
    -- booked before the account existed
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-OLD',NULL,'Brighton','Gatwick','2026-05-19','05:15','completed','ben@example.com');
    -- somebody else's trip: must NEVER leak into this customer's history
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-THEIRS',2,'Crawley','Heathrow','2026-09-09','08:00','confirmed','other@example.com');
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-NOBODY',NULL,'Crawley','Heathrow','2026-09-09','08:00','confirmed',NULL);
  `);
  const email = db.prepare('SELECT email FROM customers WHERE id = ?').get(1).email;
  const refs = db.prepare(sql).all(1, email, email).map(r => r.ref).sort();
  assert.deepStrictEqual(refs, ['WM-LINKED', 'WM-MANUAL', 'WM-OLD'],
    'the customer must see their linked AND email-matched trips (case/whitespace insensitive) — got ' + refs.join(', '));
});

test('a customer with no bookings never sees anyone else\'s', () => {
  const sql = customerBookingsSql();
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, vehicle TEXT, reg TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY, ref TEXT, customer_id INTEGER, driver_id INTEGER,
      pickup TEXT, destination TEXT, date TEXT, time TEXT, status TEXT,
      fare REAL, passengers INTEGER, passenger_email TEXT
    );
    INSERT INTO customers (id,email,full_name) VALUES (9,'new@example.com','New');
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-A',NULL,'x','y','2026-09-02','07:30','pending',NULL);
    INSERT INTO bookings (ref,customer_id,pickup,destination,date,time,status,passenger_email)
      VALUES ('WM-B',NULL,'x','y','2026-09-02','07:30','pending','');
  `);
  // An account with a blank/NULL email must not match the NULL/'' passenger rows.
  const rows = db.prepare(sql).all(9, '', '');
  assert.strictEqual(rows.length, 0, 'a blank email must never match other people\'s unlinked bookings');
});

// ── 2. CLIENT RENDERING ──────────────────────────────────────────────────
// Load the REAL getBookings/renderTrips out of westmere-rider.html and run them
// against edge-case rows in a tiny DOM shim.
const riderHtml = read('westmere-rider.html');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'westmere-rider.html no longer defines ' + name + '()');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name + '()');
}

function makeSandbox(stored) {
  const store = { wph_rider_bookings: stored };
  const listEl = { innerHTML: '' };
  const warnings = [];
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; }
    },
    document: { getElementById: (id) => (id === 'trips-list' ? listEl : null) },
    console: { warn: (...a) => warnings.push(a), error: (...a) => warnings.push(a), log: () => {} },
    // display helpers, wired to the real shared normalizer
    esc: (s) => (s == null ? '' : String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))),
    _shortAddr: (a) => require(path.join(ROOT, 'address-normalize')).shortDisplay(a),
    // …and the other two shared display helpers the trip card uses: the integer
    // luggage label and the airport-only flight number.
    _bagsText: (b) => require(path.join(ROOT, 'wm-lifecycle')).bagsText(b),
    _flightOf: (b) => require(path.join(ROOT, 'address-normalize')).flightFor(b),
    renderActiveTrip: () => {},
    Date, JSON, Array, String, Object
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFn(riderHtml, 'getBookings') + '\n' +
    // the real Europe/London "today" helper the filters depend on — see
    // server/tests/timezone-dayofweek.test.js
    extractFn(riderHtml, 'todayUK') + '\n' +
    // The REAL status/action derivation and pay panel, not stubs: the status
    // chip and the buttons on a row are now decided by these, so a row that
    // renders here is a row that renders in the app. See live-status.test.js
    // for what they decide; this file cares that a hostile row cannot blank
    // the list through them.
    extractFn(riderHtml, '_payState') + '\n' +
    extractFn(riderHtml, '_tripStatus') + '\n' +
    extractFn(riderHtml, '_tripActions') + '\n' +
    extractFn(riderHtml, '_payPanel') + '\n' +
    "var _tripFilter='upcoming';\n" +
    extractFn(riderHtml, 'renderTrips') + '\n', sandbox);
  return { sandbox, listEl, warnings };
}

const GATWICK = 'Gatwick Airport, Station Approach Road, Lowfield Heath, Crawley, West Sussex, England, RH6 0RD, United Kingdom';
const HORSHAM = '12, High Street, Horsham, West Sussex, England, RH12 1AB, United Kingdom';

test('renders a normal trip history without throwing', () => {
  const rows = [
    { ref: 'WM-1', from: HORSHAM, dest: GATWICK, date: '2099-01-02', time: '07:30', status: 'confirmed', fare: 68, pax: 2 },
    { ref: 'WM-2', from: GATWICK, dest: HORSHAM, date: '2099-01-09', time: '19:05', status: 'pending', fare: null, pax: 1 }
  ];
  const { sandbox, listEl } = makeSandbox(JSON.stringify(rows));
  sandbox.renderTrips('all');
  assert.strictEqual((listEl.innerHTML.match(/class="trip-card"/g) || []).length, 2);
});

test('addresses are shown in the SHORT form', () => {
  const rows = [{ ref: 'WM-1', from: HORSHAM, dest: GATWICK, date: '2099-01-02', time: '07:30', status: 'confirmed', fare: 68, pax: 1 }];
  const { sandbox, listEl } = makeSandbox(JSON.stringify(rows));
  sandbox.renderTrips('all');
  assert.ok(/12 High Street, Horsham, RH12 1AB/.test(listEl.innerHTML), 'house+town+postcode short form expected');
  assert.ok(/Gatwick Airport/.test(listEl.innerHTML), 'airport short form expected');
  assert.ok(!/United Kingdom/.test(listEl.innerHTML), 'the raw geocoder string must never reach the trip card');
});

test('EDGE CASES: a bad row never blanks the rest of the history', () => {
  const rows = [
    { ref: 'WM-OK1', from: HORSHAM, dest: GATWICK, date: '2099-01-02', time: '07:30', status: 'confirmed', fare: 68, pax: 2 },
    { ref: 'WM-NULLSTATUS', from: HORSHAM, dest: GATWICK, date: '2099-01-03', time: '08:00', status: null, fare: 40, pax: 1 },
    { ref: 'WM-NOADDR', from: null, dest: undefined, date: '2099-01-04', time: '09:00', status: 'pending', fare: null, pax: 1 },
    { ref: 'WM-BARE', date: '2099-01-05' },
    { ref: 'WM-NODATE', from: GATWICK, dest: HORSHAM, status: 'completed' },
    { ref: 'WM-OK2', from: GATWICK, dest: HORSHAM, date: '2099-01-06', time: '19:05', status: 'pending', fare: 74, pax: 3 }
  ];
  const { sandbox, listEl } = makeSandbox(JSON.stringify(rows));
  sandbox.renderTrips('all');
  const cards = (listEl.innerHTML.match(/class="trip-card"/g) || []).length;
  assert.strictEqual(cards, rows.length,
    'every booking must still render a card — a missing address/status/date is normal for phone bookings');
  assert.ok(/WM-OK2|Gatwick/.test(listEl.innerHTML), 'the good rows after a bad one must still be there');
});

test('EDGE CASES: a corrupt cached list degrades to empty, it does not throw', () => {
  const { sandbox, listEl } = makeSandbox('{not json at all');
  sandbox.renderTrips('all');
  assert.ok(/No trips found/.test(listEl.innerHTML), 'a corrupt cache must fall back to the empty state');
});

test('EDGE CASES: a non-array / null-entry cache does not throw', () => {
  for (const bad of ['null', '"a string"', '{"a":1}', '[null,null]']) {
    const { sandbox, listEl } = makeSandbox(bad);
    sandbox.renderTrips('all');
    assert.ok(/No trips found/.test(listEl.innerHTML), 'cache value ' + bad + ' must degrade cleanly');
  }
});

test('past and upcoming filters both return the customer\'s trips', () => {
  const rows = [
    { ref: 'WM-FUTURE', from: HORSHAM, dest: GATWICK, date: '2099-01-02', time: '07:30', status: 'confirmed', fare: 68, pax: 1 },
    { ref: 'WM-PAST', from: GATWICK, dest: HORSHAM, date: '2000-01-02', time: '19:05', status: 'completed', fare: 45, pax: 1 }
  ];
  const { sandbox, listEl } = makeSandbox(JSON.stringify(rows));
  sandbox.renderTrips('upcoming');
  assert.strictEqual((listEl.innerHTML.match(/class="trip-card"/g) || []).length, 1, 'one upcoming trip');
  sandbox.renderTrips('past');
  assert.strictEqual((listEl.innerHTML.match(/class="trip-card"/g) || []).length, 1, 'one past trip');
  sandbox.renderTrips('all');
  assert.strictEqual((listEl.innerHTML.match(/class="trip-card"/g) || []).length, 2, 'both under All');
});

test('the server sync overwrites a stale cache instead of no-oping on empty', () => {
  // The old code only wrote to localStorage `if (data.bookings.length)`, so a
  // customer whose server list was empty kept whatever stale copy was cached and
  // could never be corrected. Pin the write-through.
  const src = riderHtml.slice(riderHtml.indexOf('async function loadServerTrips()'));
  const body = src.slice(0, src.indexOf('\nfunction doLogout'));
  assert.ok(!/if\(data\.bookings&&data\.bookings\.length\)/.test(body),
    'loadServerTrips must not skip the cache write when the server returns an empty list');
  assert.ok(/Array\.isArray\(data\.bookings\)/.test(body),
    'loadServerTrips should validate the payload shape before mapping it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
