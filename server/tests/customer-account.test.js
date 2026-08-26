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
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

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
      address_line1 TEXT, address_line2 TEXT, postcode TEXT,
      account_type TEXT DEFAULT 'personal', active INTEGER DEFAULT 1,
      -- Owner-only columns. Present here precisely so a test can prove a
      -- customer cannot write them through their own profile route.
      bank_name TEXT, bank_sort_code TEXT, bank_account_no TEXT,
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
  db.prepare("INSERT INTO customers (id,email,full_name,phone,address_line1,address_line2,postcode,account_type,bank_name,bank_sort_code,bank_account_no) VALUES (1,'eleanor@example.com','Eleanor Voss','+44 7700 900812','14 Queens Road','Haywards Heath','RH16 1EA','personal','Starling','60-83-71','12345678')").run();
  db.prepare("INSERT INTO customers (id,email,full_name,phone,address_line1,postcode) VALUES (2,'martin@example.com','Martin Ford','+44 7700 900999','9 Cliffe High Street','BN7 2AH')").run();
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
  /* The wrapper is ASYNC because the invoice route became async when it started
     rebuilding a missing PDF instead of refusing — a synchronous wrapper turns
     that into "await is only valid in async functions", which reads like four
     broken authorisation checks and is really a broken harness.

     `res` is still returned synchronously: an async function runs its body
     eagerly up to the first await, so a handler with no await has already
     finished by the time this returns, and the sync callers below are
     unchanged. Handlers that DO await use runAsync. */
  const out = vm.runInContext(
    '(async function(req,res){' + handlerSrc + '})(req,res)', sandbox);
  res.__done = (out && typeof out.then === 'function')
    ? out.then(() => res, () => res)
    : Promise.resolve(res);
  return res;
}

/** For handlers that actually await something. → Promise<res> */
function runAsync(handlerSrc, db, req) {
  return run(handlerSrc, db, req).__done;
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

// ── The home address in My Details ───────────────────────────────────────
// The address columns were populated but nothing ever showed them to the
// customer. Surfacing them widens what a customer may write to their own row,
// so the boundary matters more than the feature: exactly three more fields,
// on their OWN record, and the owner-only columns stay untouchable.
const getProfile = extractHandler('get', '/customer/profile');

test('the profile route returns the caller\'s own home address', () => {
  const db = makeDb();
  const res = run(getProfile, db, custReq({}));
  assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode);
  const p = res.body.profile;
  assert.strictEqual(p.address_line1, '14 Queens Road');
  assert.strictEqual(p.address_line2, 'Haywards Heath');
  assert.strictEqual(p.postcode, 'RH16 1EA');
});

test('the profile route is scoped to the authenticated caller, never a client id', () => {
  const db = makeDb();
  // Customer 2 asks; they must get THEIR row, whatever else is in the request.
  const res = run(getProfile, db, { auth: { type: 'customer', id: 2 }, body: { id: 1 }, params: { id: 1 }, ip: '::1' });
  assert.strictEqual(res.body.profile.address_line1, '9 Cliffe High Street',
    'the route must read req.auth.id — never an id supplied by the client');
  assert.strictEqual(res.body.profile.postcode, 'BN7 2AH');
  // And the SQL must literally use req.auth.id.
  assert.ok(/FROM customers WHERE id = \?'\)\.get\(req\.auth\.id\)/.test(apiSrc),
    'the profile SELECT must be parameterised on req.auth.id');
});

test('a customer can save their own address', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({
    full_name: 'Eleanor Voss', email: 'eleanor@example.com', phone: '+44 7700 900812',
    address_line1: '2 Southover High Street', address_line2: 'Lewes', postcode: 'bn7 1hu'
  }));
  assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode + ' ' + JSON.stringify(res.body));
  const row = db.prepare('SELECT * FROM customers WHERE id = 1').get();
  assert.strictEqual(row.address_line1, '2 Southover High Street');
  assert.strictEqual(row.address_line2, 'Lewes');
  assert.strictEqual(row.postcode, 'BN7 1HU', 'the postcode should be stored upper-cased');
  assert.strictEqual(res.body.profile.address_line1, '2 Southover High Street',
    'the response must echo the saved address so the form can repaint');
});

test('the address is optional and an omitted field keeps its stored value', () => {
  const db = makeDb();
  const res = run(patchProfile, db, custReq({ full_name: 'Eleanor Voss', email: 'eleanor@example.com' }));
  assert.strictEqual(res.statusCode, 200);
  const row = db.prepare('SELECT * FROM customers WHERE id = 1').get();
  assert.strictEqual(row.address_line1, '14 Queens Road', 'an omitted address must not be blanked');
  assert.strictEqual(row.postcode, 'RH16 1EA');
});

test('a junk postcode or an absurd address line is refused', () => {
  for (const body of [
    { postcode: 'not a postcode!!' },
    { address_line1: 'x'.repeat(200) },
    { address_line2: 'y'.repeat(200) }
  ]) {
    const db = makeDb();
    const res = run(patchProfile, db, custReq(Object.assign({ full_name: 'Eleanor Voss', email: 'eleanor@example.com' }, body)));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body) + ' must be refused, got ' + res.statusCode);
    assert.strictEqual(db.prepare('SELECT address_line1 FROM customers WHERE id = 1').get().address_line1,
      '14 Queens Road', 'the row must be untouched after a rejected save');
  }
});

test('a customer can NOT write bank details or account_type through their profile', () => {
  // The reason this route reads named fields instead of looping over req.body:
  // a loop would happily carry these straight into the UPDATE.
  const db = makeDb();
  const res = run(patchProfile, db, custReq({
    full_name: 'Eleanor Voss', email: 'eleanor@example.com',
    account_type: 'business',
    bank_name: 'Attacker Bank', bank_sort_code: '00-00-00', bank_account_no: '99999999',
    active: 0, id: 2
  }));
  assert.strictEqual(res.statusCode, 200, 'the save itself should succeed, ignoring the extra fields');
  const row = db.prepare('SELECT * FROM customers WHERE id = 1').get();
  assert.strictEqual(row.account_type, 'personal', 'account_type must NOT be customer-editable');
  assert.strictEqual(row.bank_name, 'Starling', 'bank_name must NOT be customer-editable');
  assert.strictEqual(row.bank_sort_code, '60-83-71', 'bank_sort_code must NOT be customer-editable');
  assert.strictEqual(row.bank_account_no, '12345678', 'bank_account_no must NOT be customer-editable');
  assert.strictEqual(row.active, 1, 'active must NOT be customer-editable');
  // The UPDATE statement itself must name only the six permitted columns.
  const upd = apiSrc.match(/UPDATE customers SET ([^']*?) WHERE id = \?/);
  assert.ok(upd, 'could not find the profile UPDATE');
  const setClause = upd[1];
  for (const forbidden of ['bank_', 'account_type', 'active', 'id']) {
    assert.ok(!new RegExp('\\b' + forbidden).test(setClause),
      'the customer profile UPDATE must not SET ' + forbidden + ': ' + setClause);
  }
  // …and it must still be scoped by the id, which is the WHERE, not the SET.
  assert.ok(/WHERE id = \?/.test(upd[0]), 'the UPDATE must be scoped WHERE id = ?');
});

test('saving my own profile cannot reach another customer\'s record', () => {
  const db = makeDb();
  const before = db.prepare('SELECT * FROM customers WHERE id = 2').get();
  run(patchProfile, db, custReq({
    full_name: 'Eleanor Voss', email: 'eleanor@example.com',
    address_line1: 'Mine', postcode: 'BN1 1AA', id: 2, customer_id: 2
  }));
  const after = db.prepare('SELECT * FROM customers WHERE id = 2').get();
  assert.deepStrictEqual(after, before, "customer 2's row must be byte-identical after customer 1 saves");
});

test('My Details shows and sends the address fields', () => {
  for (const id of ['md-addr1', 'md-addr2', 'md-postcode']) {
    assert.ok(riderHtml.includes('id="' + id + '"'), 'My Details must have an ' + id + ' input');
  }
  assert.ok(/address_line1:addr1\.trim\(\)/.test(riderHtml) && /postcode:postcode\.trim\(\)/.test(riderHtml),
    'saveMyDetails must send the address fields');
  assert.ok(/f\('md-addr1',_currentUser\.address_line1\)/.test(riderHtml),
    'fillMyDetails must populate the address');
  assert.ok(/loadProfileAddress/.test(riderHtml),
    'My Details must fetch the profile so the stored address appears without a save');
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
  // and the UPDATE must be scoped by id, not by anything the body carries.
  // The permitted set grew by exactly three address fields when the home
  // address was surfaced in My Details; it is still a closed list, and it is
  // still the caller's own row.
  assert.ok(/UPDATE customers SET full_name = \?, email = \?, phone = \?, address_line1 = \?, address_line2 = \?, postcode = \? WHERE id = \?/.test(apiSrc),
    'the profile UPDATE must set exactly name/email/phone + the three address ' +
    'fields, and be scoped WHERE id = ?');
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

test('a customer can NEVER download another customer\'s invoice', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id,recipient_email) VALUES (5,'INV-1',2,'martin@example.com')").run();
  const res = await runAsync(invoicePdf, db, invReq(5));
  assert.strictEqual(res.statusCode, 403, 'someone else\'s invoice must be refused, got ' + res.statusCode);
  assert.strictEqual(res.sentFile, null, 'no file may be sent for a refused invoice');
});

test('an invoice matched only by email is still the customer\'s own', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id,recipient_email) VALUES (6,'INV-2',NULL,'Eleanor@Example.com')").run();
  const res = await runAsync(invoicePdf, db, invReq(6));
  assert.notStrictEqual(res.statusCode, 403, 'an email-matched invoice must not be refused as someone else\'s');
});

test('a cold cache REBUILDS the invoice instead of refusing it', async () => {
  /* This used to assert a 404 reading "not available yet — please contact the
     office", and that was the bug, not the contract: the invoice exists, the
     data to draw it is in the row, and the only thing missing was a file on a
     volume. It is rebuilt now. What still has to hold is that a genuine
     failure is a stated error and never an empty response. */
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id) VALUES (7,'INV-NOT-CACHED',1)").run();
  const res = await runAsync(invoicePdf, db, invReq(7));
  assert.notStrictEqual(res.statusCode, 404,
    'the customer must not be told to ring the office for an invoice the system can draw');
  if (res.statusCode >= 400) {
    assert.ok((res.body.error || '').length > 10, 'a failure must say something usable, never blank');
  }
});

test('the invoice filename is sanitised (no path traversal via invoice_no)', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO invoices (id,invoice_no,customer_id) VALUES (8,'../../../etc/passwd',1)").run();
  const res = await runAsync(invoicePdf, db, invReq(8));
  assert.ok(!/\.\./.test(res.sentFile || ''), 'a traversal attempt must never reach sendFile');
  assert.ok(!/\.\./.test(String((res.headers || {})['Content-Disposition'] || '')),
    'nor the filename offered to the browser');
  // And the cache path it would write is inside the invoices directory.
  const { invoiceCachePath, invoiceCacheDir } = require('../invoice-pdf');
  assert.ok(invoiceCachePath('../../../etc/passwd').indexOf(invoiceCacheDir()) === 0,
    'a traversal attempt must not escape the invoices directory');
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

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
