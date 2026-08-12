/**
 * Customer "My Account" guardrail — run with:
 *   node server/tests/customer-account.test.js   (also gated by `npm test`)
 *
 * My Account (westmere-rider.html) stopped being a read-only list and became
 * the real account: the customer can now EDIT their details, CANCEL a trip and
 * DOWNLOAD an invoice. Each of those writes or exposes real data, so each has a
 * way to go badly wrong:
 *
 *   · PATCH /customer/profile — email IS the login. If it can be blanked,
 *     malformed, or set to an address another account already uses, the
 *     customer locks themselves out or two accounts collide on one login.
 *     A customer must also not be able to edit anyone else's row, or fields
 *     beyond name/email/phone.
 *
 *   · POST /customer/bookings/:id/cancel — ownership cannot be judged on
 *     customer_id alone. That column is NULL for every manually-entered job
 *     and for anything booked before the customer registered (see
 *     rider-trips.test.js). Those trips ARE listed in My Account, so if cancel
 *     used a stricter rule than the list does, the customer would press Cancel
 *     on their own booking and get "you can only cancel your own bookings".
 *
 *   · GET /customer/invoices/:id/pdf — an invoice is a financial document with
 *     a name and address on it. It must never be served to anyone but its
 *     owner, and an /:id route is trivially enumerable.
 *
 * These run the SHIPPED handlers (extracted from server/api.js) against a
 * throwaway database, so the test cannot pass on code we no longer ship.
 * Pure Node, no framework. Exit 1 on failure.
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

console.log('\nCustomer My Account — profile save / cancel / invoice download');

const apiSrc = read('server/api.js');
const riderHtml = read('westmere-rider.html');

// ── Pull a real route handler out of server/api.js ───────────────────────
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

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE, full_name TEXT, phone TEXT,
      account_type TEXT DEFAULT 'personal', active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT, customer_id INTEGER, passenger_email TEXT,
      status TEXT, notes TEXT, calendar_event_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT, customer_id INTEGER, recipient_email TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT, user_id INTEGER, action TEXT, detail TEXT, ip TEXT
    );
  `);
  db.prepare("INSERT INTO customers (id,email,full_name,phone) VALUES (1,'eleanor@example.com','Eleanor Voss','+44 7700 900812')").run();
  db.prepare("INSERT INTO customers (id,email,full_name,phone) VALUES (2,'martin@example.com','Martin Ford','+44 7700 900999')").run();
  return db;
}

// Minimal res double: records status + payload.
function makeRes() {
  const res = {
    statusCode: 200, body: null, headers: {}, sentFile: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    sendFile(p) { this.sentFile = p; return this; }
  };
  return res;
}

function run(handlerSrc, db, req) {
  const res = makeRes();
  const sandbox = {
    getDb: () => db, req, res, console: { error: () => {}, log: () => {}, warn: () => {} },
    events: { broadcast: () => {} },
    require: (m) => (m === './google-calendar' ? { deleteEvent: () => Promise.resolve(false) } : require(m)),
    path, fs, INVOICES_DIR: path.join(ROOT, 'data', 'invoices'),
    parseInt, isNaN, String, Number, Object, JSON, Date
  };
  vm.createContext(sandbox);
  vm.runInContext('(function(req,res){' + handlerSrc + '})(req,res)', sandbox);
  return res;
}

// ── 1. PATCH /customer/profile ───────────────────────────────────────────
const patchProfile = extractHandler('patch', '/customer/profile');
const custReq = (body, id) => ({ auth: { type: 'customer', role: 'customer', id: id || 1 }, body: body, params: {}, ip: '::1' });

test('a customer can save their own name / email / phone', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({ full_name: 'Eleanor V Voss', email: 'eleanor.voss@example.com', phone: '+44 7700 900111' }));
  assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode + ' ' + JSON.stringify(res.body));
  const row = db.prepare('SELECT * FROM customers WHERE id = 1').get();
  assert.strictEqual(row.full_name, 'Eleanor V Voss');
  assert.strictEqual(row.email, 'eleanor.voss@example.com');
  assert.strictEqual(row.phone, '+44 7700 900111');
  assert.ok(res.body.emailChanged, 'the response must flag that the login email changed');
});

test('a customer can NEVER take an email another account already uses', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: 'MARTIN@example.com' }));
  assert.strictEqual(res.statusCode, 409, 'a colliding email must be refused (409), got ' + res.statusCode);
  const row = db.prepare('SELECT email FROM customers WHERE id = 1').get();
  assert.strictEqual(row.email, 'eleanor@example.com', 'the row must be untouched after a rejected save');
});

test('keeping your own email (any casing) is not treated as a collision', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: 'Eleanor@Example.com' }));
  assert.strictEqual(res.statusCode, 200, 'own email must not collide with itself, got ' + res.statusCode);
});

test('a blank or malformed email is refused — it is the login', () => {
  for (const bad of ['', '   ', 'not-an-email', 'two@@at.com', 'no-at.example.com']) {
    const db = makeDb();
    const res = run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: bad }));
    assert.strictEqual(res.statusCode, 400, 'email "' + bad + '" must be refused, got ' + res.statusCode);
    assert.strictEqual(db.prepare('SELECT email FROM customers WHERE id = 1').get().email, 'eleanor@example.com');
  }
});

test('a blank name is refused', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({ full_name: '   ', email: 'eleanor@example.com' }));
  assert.strictEqual(res.statusCode, 400);
});

test('phone is optional, but junk is refused', () => {
  const db = makeDb();
  const ok = run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: 'eleanor@example.com', phone: '' }));
  assert.strictEqual(ok.statusCode, 200, 'a blank phone must be allowed');
  const bad = run(patchProfile, makeDb(), custReq({ full_name: 'Eleanor Voss', email: 'eleanor@example.com', phone: 'call me' }));
  assert.strictEqual(bad.statusCode, 400, 'a non-phone must be refused');
});

test('the save touches ONLY name/email/phone on the caller\'s own row', () => {
  const db = makeDb();
  run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: 'eleanor@example.com', id: 2, account_type: 'account', active: 0 }));
  const me = db.prepare('SELECT * FROM customers WHERE id = 1').get();
  const other = db.prepare('SELECT * FROM customers WHERE id = 2').get();
  assert.strictEqual(me.account_type, 'personal', 'account_type must not be settable by the customer');
  assert.strictEqual(me.active, 1, 'active must not be settable by the customer');
  assert.strictEqual(other.full_name, 'Martin Ford', 'another customer\'s row must never be touched');
  // and the UPDATE must be scoped by id, not by anything the body carries
  assert.ok(/UPDATE customers SET full_name = \?, email = \?, phone = \? WHERE id = \?/.test(apiSrc),
    'the profile UPDATE must set exactly name/email/phone and be scoped WHERE id = ?');
});

test('a non-customer (owner/driver token) cannot use the customer profile route', () => {
  const db = makeDb();
  const res = run(patchProfile, db, { auth: { type: 'user', role: 'owner', id: 1 }, body: { full_name: 'x' }, params: {}, ip: '::1' });
  assert.strictEqual(res.statusCode, 403);
});

// ── 2. POST /customer/bookings/:id/cancel ────────────────────────────────
const cancelBooking = extractHandler('post', '/customer/bookings/:id/cancel');
const cancelReq = (id, authId) => ({ auth: { type: 'customer', role: 'customer', id: authId || 1 }, params: { id: String(id) }, body: {}, ip: '::1' });

test('a customer can cancel a booking linked by customer_id', () => {
  const db = makeDb();
  db.prepare("INSERT INTO bookings (id,ref,customer_id,status) VALUES (10,'WPH-1',1,'confirmed')").run();
  const res = run(cancelBooking, db, cancelReq(10));
  assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode + ' ' + JSON.stringify(res.body));
  assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id = 10').get().status, 'cancelled');
});

test('a customer can cancel their OWN manually-entered booking (customer_id NULL, email match)', () => {
  // The exact shape from the "my trips disappeared" incident: the owner took
  // this one over the phone, so it carries an email and no customer_id. My
  // Account lists it — cancel must accept it too.
  const db = makeDb();
  db.prepare("INSERT INTO bookings (id,ref,customer_id,passenger_email,status) VALUES (11,'WPH-2',NULL,'  ELEANOR@example.com ','confirmed')").run();
  const res = run(cancelBooking, db, cancelReq(11));
  assert.strictEqual(res.statusCode, 200,
    'an email-matched booking must be cancellable — it is listed in My Account. Got ' + res.statusCode + ' ' + JSON.stringify(res.body));
  assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id = 11').get().status, 'cancelled');
});

test('a customer can NEVER cancel someone else\'s booking', () => {
  const db = makeDb();
  db.prepare("INSERT INTO bookings (id,ref,customer_id,status) VALUES (12,'WPH-3',2,'confirmed')").run();
  db.prepare("INSERT INTO bookings (id,ref,customer_id,passenger_email,status) VALUES (13,'WPH-4',NULL,'martin@example.com','confirmed')").run();
  for (const id of [12, 13]) {
    const res = run(cancelBooking, db, cancelReq(id));
    assert.strictEqual(res.statusCode, 403, 'booking ' + id + ' belongs to someone else — expected 403, got ' + res.statusCode);
    assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'confirmed');
  }
});

test('a trip already underway or finished cannot be cancelled', () => {
  for (const status of ['active', 'completed', 'cancelled']) {
    const db = makeDb();
    db.prepare("INSERT INTO bookings (id,ref,customer_id,status) VALUES (14,'WPH-5',1,?)").run(status);
    const res = run(cancelBooking, db, cancelReq(14));
    assert.strictEqual(res.statusCode, 409, status + ' must not be cancellable, got ' + res.statusCode);
  }
});

// ── 3. GET /customer/invoices/:id/pdf ────────────────────────────────────
const invoicePdf = extractHandler('get', '/customer/invoices/:id/pdf');
const invReq = (id, authId) => ({ auth: { type: 'customer', role: 'customer', id: authId || 1 }, params: { id: String(id) }, body: {}, ip: '::1' });

test('a customer can NEVER download another customer\'s invoice', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id,recipient_email) VALUES (5,'INV-1',2,'martin@example.com')").run();
  const res = run(invoicePdf, db, invReq(5));
  assert.strictEqual(res.statusCode, 403, 'someone else\'s invoice must be refused, got ' + res.statusCode);
  assert.strictEqual(res.sentFile, null, 'no file may be sent for a refused invoice');
});

test('an invoice matched only by email is still the customer\'s own', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id,recipient_email) VALUES (6,'INV-2',NULL,'Eleanor@Example.com')").run();
  const res = run(invoicePdf, db, invReq(6));
  assert.notStrictEqual(res.statusCode, 403, 'an email-matched invoice must not be refused as someone else\'s');
});

test('a missing PDF says so plainly instead of 500ing or serving nothing', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id) VALUES (7,'INV-DOES-NOT-EXIST',1)").run();
  const res = run(invoicePdf, db, invReq(7));
  assert.strictEqual(res.statusCode, 404);
  assert.ok(/not available/i.test(res.body.error || ''), 'the message must tell the customer what to do');
});

test('the invoice filename is sanitised (no path traversal via invoice_no)', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id) VALUES (8,'../../../etc/passwd',1)").run();
  const res = run(invoicePdf, db, invReq(8));
  assert.strictEqual(res.statusCode, 404);
  assert.ok(!/\.\./.test(res.sentFile || ''), 'a traversal attempt must never reach sendFile');
});

// ── 4. The client actually calls these ───────────────────────────────────
test('My Account cancel goes to the SERVER, not just localStorage', () => {
  const m = riderHtml.match(/function cancelTrip\([\s\S]*?\n\}/);
  assert.ok(m, 'westmere-rider.html no longer defines cancelTrip()');
  assert.ok(/\/api\/customer\/bookings\/'?\s*\+?[\s\S]*?\/cancel/.test(m[0]),
    'cancelTrip must POST to /api/customer/bookings/:id/cancel — a local-only cancel tells the ' +
    'customer their trip is cancelled while the office and the driver still have it');
  const localWrite = m[0].indexOf('localStorage.setItem');
  const serverCall = m[0].indexOf('/api/customer/bookings/');
  assert.ok(serverCall !== -1 && (localWrite === -1 || serverCall < localWrite),
    'the local copy may only be updated AFTER the server confirms the cancellation');
});

test('the Invoices tab reads the real endpoint and offers a download', () => {
  assert.ok(/fetch\('\/api\/customer\/invoices'/.test(riderHtml),
    'the Invoices tab must load GET /api/customer/invoices');
  assert.ok(/\/api\/customer\/invoices\/'\s*\+\s*encodeURIComponent\(i\.id\)\s*\+\s*'\/pdf/.test(riderHtml),
    'each invoice row must link to its own /pdf download');
});

test('My Details saves through PATCH /api/customer/profile', () => {
  const m = riderHtml.match(/async function saveMyDetails\([\s\S]*?\n\}/);
  assert.ok(m, 'westmere-rider.html no longer defines saveMyDetails()');
  assert.ok(/method:'PATCH'/.test(m[0]) && /\/api\/customer\/profile/.test(m[0]),
    'saveMyDetails must PATCH /api/customer/profile');
});

test('the verification landing (?verified=) is handled', () => {
  assert.ok(/verified/.test(riderHtml) && /already/.test(riderHtml),
    'westmere-rider.html must handle ?verified=1|already|error — it is where ' +
    'server/auth.js sends the customer after they click the link in their email');
  const authSrc = read('server/auth.js');
  assert.ok(!/westmere-account\.html\?verified/.test(authSrc),
    'verification should land on the live app directly, not via the retired mirror');
});

test('the retired duplicate is gone but its 301 lives on forever', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'westmere-account.html')),
    'westmere-account.html is the dead duplicate — it must not come back');
  const indexSrc = read('server/index.js');
  assert.ok(/app\.get\('\/westmere-account\.html'/.test(indexSrc) && /redirect\(301/.test(indexSrc),
    'the /westmere-account.html 301 must stay: it is linked from the public site nav, ' +
    'from sent emails, and from anyone\'s bookmarks');
});

test('the app presents as "My Account", not a separate "Rider" app', () => {
  assert.ok(/<title>Westmere · My Account<\/title>/.test(riderHtml), 'title must be "Westmere · My Account"');
  const man = JSON.parse(read('rider-manifest.json'));
  assert.strictEqual(man.name, 'Westmere Account');
  assert.strictEqual(man.short_name, 'My Account');
  assert.strictEqual(man.start_url, '/westmere-rider.html',
    'start_url must NOT change — installed PWAs already point at this file');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
