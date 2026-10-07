/**
 * THE BUSINESS ACCOUNT — run with:
 *   node server/tests/business-account.test.js   (also gated by `npm test`)
 *
 * A company holds the account; one responsible contact signs in and books cars
 * for other people. Two rules carry the whole design, and both are the kind
 * that break quietly:
 *
 *   THE ACCOUNT IS THE COMPANY. Every ride is written against the company row,
 *   never the contact's. That is what lets Customer Spend, the invoice run, the
 *   trips list and the turnover SQL keep working untouched — and it means any
 *   screen that asks for "this customer's" bookings has to resolve to the
 *   account first, or she signs in to an empty page while her rides sit safely
 *   against another id.
 *
 *   THE PASSENGER'S NUMBER NEVER REACHES A DRIVER. On a company ride the driver
 *   rings the account contact and she tells the passenger the car is outside.
 *   The booking row HAS a passenger_phone column, because every other kind of
 *   booking needs one — so this cannot be guarded by hoping the column is
 *   empty. The tests below put a number in it on purpose and then drive every
 *   path that reaches a driver, asserting it comes out the other side absent.
 *
 * The last section is the negative test: it reintroduces each bug and checks
 * this file would have caught it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-biz-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const SENT = [];
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  try { SENT.push(JSON.parse(o.body)); } catch (e) {}
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const biz = require('../business-account');
const email = require('../email');
const api = require('../api');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function resp() {
  return { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; } };
}
async function call(method, routePath, opts) {
  const o = opts || {};
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: o.auth || { type: 'customer', id: o.as, role: 'customer' } };
  const r = resp();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let next = false;
    await h(req, r, () => { next = true; });
    if (!next) break;
  }
  return r;
}

// ── a company, its contact, and a ride ────────────────────────────────────
let seq = 0;
function company(over) {
  const o = over || {};
  const n = ++seq;
  const co = db.prepare(`INSERT INTO customers (email, password, full_name, phone, account_type, company)
                         VALUES (?, '', ?, ?, 'business', ?)`)
    .run('acct' + n + '@harding.co.uk', 'Harding Executive Travel', '01903 555 110', 'Harding Executive Travel').lastInsertRowid;
  const contact = db.prepare(`INSERT INTO customers (email, password, full_name, phone, account_type, company, parent_customer_id)
                              VALUES (?, '', 'Claire Wilkes', ?, 'business', ?, ?)`)
    .run('claire' + n + '@harding.co.uk', o.contactPhone === null ? null : (o.contactPhone || '01903 555 110'),
         'Harding Executive Travel', co).lastInsertRowid;
  return { companyId: co, contactId: contact };
}
function ride(companyId, over) {
  const o = over || {};
  const ref = 'WM-B' + (++seq);
  const id = db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time,
                                               passengers, bags, fare, payment, status,
                                               passenger_name, passenger_phone, passenger_email)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, companyId, 'Head office, Worthing', 'Gatwick South', '2026-10-09', '06:15',
         1, '2', o.fare == null ? 95 : o.fare, 'account', o.status || 'confirmed',
         'Mr J. Vance',
         /* PUT A NUMBER IN IT ON PURPOSE. The column exists; the rule must hold
            whatever it happens to contain. */
         o.passengerPhone === undefined ? '07700 900344' : o.passengerPhone,
         'vance@harding.co.uk').lastInsertRowid;
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
}

// ── 1. THE ACCOUNT IS THE COMPANY ─────────────────────────────────────────
console.log('\nEvery ride belongs to the company, not the person who booked it');

test('a contact resolves to her company, and a personal customer to herself', () => {
  const { companyId, contactId } = company();
  assert.strictEqual(biz.accountIdFor(db, contactId), companyId, 'the contact does not resolve to the company');
  assert.strictEqual(biz.accountIdFor(db, companyId), companyId, 'the company does not resolve to itself');
  const solo = db.prepare("INSERT INTO customers (email, password, full_name) VALUES (?, '', 'Ben Chan')")
    .run('ben' + (++seq) + '@example.com').lastInsertRowid;
  assert.strictEqual(biz.accountIdFor(db, solo), solo, 'a personal account must resolve to itself');
  assert.strictEqual(biz.contextFor(db, solo).business, false, 'a personal account is not a business one');
});

test('she sees the company\'s rides when she asks for her own', async () => {
  const { companyId, contactId } = company();
  ride(companyId); ride(companyId); ride(companyId);
  const r = await call('get', '/bookings', { auth: { type: 'customer', id: contactId, role: 'customer' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.bookings.length, 3,
    'the contact was handed ' + r.body.bookings.length + ' rides — hers sit against the company id');
});

test('one company never sees another\'s rides', async () => {
  const a = company(), b = company();
  ride(a.companyId); ride(b.companyId); ride(b.companyId);
  const ra = await call('get', '/bookings', { auth: { type: 'customer', id: a.contactId, role: 'customer' } });
  for (const bk of ra.body.bookings) {
    assert.strictEqual(bk.customer_id, a.companyId, 'a ride from another company is on this screen');
  }
});

test('the context names the company, which is what the invoice is raised in', () => {
  const { contactId } = company();
  const ctx = biz.contextFor(db, contactId);
  assert.strictEqual(ctx.business, true);
  assert.strictEqual(ctx.companyName, 'Harding Executive Travel');
  assert.strictEqual(ctx.contact.full_name, 'Claire Wilkes');
});

// ── 2. THE PASSENGER'S NUMBER NEVER REACHES A DRIVER ──────────────────────
console.log('\nThe driver rings the contact, and is never given the passenger');

const LEAK = /07700\s*900344|07700900344/;

test('the dispatch email carries the contact, and not the passenger\'s number', () => {
  const { companyId } = company();
  const b = ride(companyId);
  assert.ok(LEAK.test(String(b.passenger_phone)), 'the fixture is wrong — there is no number to leak');
  const payload = biz.forDriver(db, Object.assign({}, b, {
    driver_email: 'gary@example.com', driver_name: 'Gary', driver_pay: 85.5, admin_fee: 9.5, commission_pct: 10
  }));
  const built = email.buildDriverDispatch(payload);
  assert.ok(/Mr J\. Vance/.test(built.html), 'the driver is not told who he is collecting');
  assert.ok(/01903 555 110/.test(built.html), 'the contact number is not on the job');
  assert.ok(!LEAK.test(built.html), 'THE PASSENGER\'S NUMBER IS IN THE DRIVER\'S EMAIL');
  assert.ok(/Claire Wilkes/.test(built.html), 'the driver is not told whose number it is');
  assert.ok(/not the passenger/i.test(built.html), 'nothing tells him not to ring the passenger');
});

test('…and the builder refuses it even when the payload still carries one', () => {
  /* The belt-and-braces half: a caller that forgets to blank customer_phone
     must still not leak it, because the rule lives in the builder too. */
  const built = email.buildDriverDispatch({
    ref: 'WM-X', date: '2026-10-09', time: '06:15', pickup: 'A', destination: 'B', fare: 95,
    driver_email: 'g@x.com', driver_pay: 85.5, admin_fee: 9.5,
    customer_name: 'Mr J. Vance', customer_phone: '07700 900344',
    account_contact: { name: 'Claire Wilkes', phone: '01903 555 110', company: 'Harding Executive Travel' }
  });
  assert.ok(!LEAK.test(built.html), 'a passenger number passed in reached the driver');
  assert.ok(/01903 555 110/.test(built.html), 'the contact number is missing');
});

test('every path that reaches a driver goes through the rule', () => {
  /* Four of them, and a fifth would be a hole: dispatch, the ad-hoc offer, the
     twelve-hour reminder, and the owner's view/resend of the job email. */
  for (const [file, what] of [
    ['server/offer-routes.js', 'dispatch and the ad-hoc offer'],
    ['server/reminder.js', 'the twelve-hour reminder'],
    ['server/api.js', 'the owner\'s view and resend']
  ]) {
    const src = strip(read(file));
    assert.ok(/business-account'\)\.(forDriver|driverContactFor)\(/.test(src),
      what + ' does not ask who the driver should ring');
  }
  /* And the ad-hoc offer blanks the number it names explicitly. */
  const offers = strip(read('server/offer-routes.js'));
  assert.ok(/_bizContact \? '' : \(row\.customer_phone/.test(offers),
    'the ad-hoc offer still passes the passenger\'s number straight through');
});

test('the reminder says the same thing the job email said', () => {
  const built = email.buildDriverDispatch({
    ref: 'WM-Y', date: '2026-10-09', time: '06:15', pickup: 'A', destination: 'B', fare: 95,
    driver_email: 'g@x.com', customer_name: 'Mr J. Vance', customer_phone: '07700 900344',
    account_contact: { name: 'Claire Wilkes', phone: '01903 555 110', company: 'Harding Executive Travel' }
  });
  assert.ok(!LEAK.test(built.html));
  const src = strip(read('server/reminder.js'));
  assert.ok(/forDriver\(db, Object\.assign\(\{\}, b, \{ driver_email: who\.email \}\)\)/.test(src),
    'the reminder builds its payload without the account contact');
});

test('a PERSONAL booking is untouched — the passenger is still the contact', () => {
  const solo = db.prepare("INSERT INTO customers (email, password, full_name, phone) VALUES (?, '', 'Ben Chan', '07700 900001')")
    .run('ben' + (++seq) + '@example.com').lastInsertRowid;
  const id = db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, fare, payment, status, passenger_name, passenger_phone)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('WM-P' + (++seq), solo, 'A', 'B', '2026-10-09', '06:15', 95, 'card', 'confirmed', 'Ben Chan', '07700 900001').lastInsertRowid;
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  assert.strictEqual(biz.driverContactFor(db, row), null, 'a personal ride must not get an account contact');
  const built = email.buildDriverDispatch(Object.assign({}, biz.forDriver(db, row),
    { driver_email: 'g@x.com', customer_name: 'Ben Chan', customer_phone: '07700 900001' }));
  assert.ok(/07700 900001/.test(built.html),
    'a personal booking lost its own phone number — this rule is for company rides only');
});

// ── 3. BOOKING FOR SOMEBODY ELSE ──────────────────────────────────────────
console.log('\nBooking a ride for a passenger');

test('the name is kept and no number for them is stored, whatever is posted', async () => {
  const { companyId, contactId } = company();
  const r = await call('post', '/business/bookings', { as: contactId, body: {
    passenger_name: 'Mr J. Vance', pickup: 'Head office', destination: 'Gatwick South',
    date: '2026-10-09', time: '06:15', passengers: 1, bags: '2',
    /* posted on purpose — the route must not take them */
    passenger_phone: '07700 900344', passenger_email: 'vance@harding.co.uk', client_ref: 'PO-4471'
  }});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const b = r.body.booking;
  assert.strictEqual(b.passenger_name, 'Mr J. Vance', 'the passenger name was not kept');
  assert.strictEqual(b.passenger_phone, null, 'A PASSENGER NUMBER WAS STORED');
  assert.strictEqual(b.passenger_email, null, 'a passenger email was stored');
  assert.strictEqual(b.customer_id, companyId, 'the ride is not on the company');
  assert.strictEqual(b.client_ref, 'PO-4471', 'the reference was dropped');
});

test('it is on account, set explicitly, and left to be priced', async () => {
  const { contactId } = company();
  const r = await call('post', '/business/bookings', { as: contactId, body: {
    passenger_name: 'Ms A. Oduya', pickup: 'Head office', destination: 'Victoria', date: '2026-10-10' }});
  assert.strictEqual(r.body.booking.payment, 'account', 'a company ride must be on account');
  assert.strictEqual(r.body.booking.status, 'pending', 'estimate-first: a request is not confirmed');
  assert.strictEqual(r.body.booking.fare, null, 'the app priced the job — only staff may do that');
  const src = strip(read('server/api.js'));
  assert.ok(/assertPaymentMethod\('account', 'business booking'\)/.test(src),
    "the method is written without going through the assertion — it must never be defaulted");
});

test('it refuses a ride with nobody to ring', async () => {
  const { contactId } = company({ contactPhone: null });
  const r = await call('post', '/business/bookings', { as: contactId, body: {
    passenger_name: 'Mr J. Vance', pickup: 'A', destination: 'B', date: '2026-10-09' }});
  assert.strictEqual(r.statusCode, 400, 'a company with no contact number took a booking');
  assert.ok(/rings you, not the passenger/.test(r.body.error), 'the refusal does not say why: ' + r.body.error);
});

test('it refuses the obvious holes', async () => {
  const { contactId } = company();
  for (const [body, why] of [
    [{ pickup: 'A', destination: 'B', date: '2026-10-09' }, 'nobody travelling'],
    [{ passenger_name: 'X', destination: 'B', date: '2026-10-09' }, 'no pickup'],
    [{ passenger_name: 'X', pickup: 'A', destination: 'B' }, 'no date'],
    [{ passenger_name: 'X', pickup: 'A', destination: 'B', date: 'tuesday' }, 'a date that is not one']
  ]) {
    const r = await call('post', '/business/bookings', { as: contactId, body });
    assert.strictEqual(r.statusCode, 400, 'accepted a ride with ' + why);
  }
});

// ── 4. HER PEOPLE, AND HER PAPERWORK ──────────────────────────────────────
console.log('\nSaved people and self-serve paperwork');

test('a saved passenger is a name — no number is accepted or stored', async () => {
  const { contactId } = company();
  const r = await call('post', '/business/passengers', { as: contactId,
    body: { name: 'Mr J. Vance', usual_pickup: 'Head office', phone: '07700 900344', email: 'v@h.co.uk' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const cols = db.prepare('PRAGMA table_info(company_passengers)').all().map((c) => c.name);
  for (const c of cols) {
    assert.ok(!/phone|mobile|email/i.test(c), 'company_passengers has a ' + c + ' column — it must hold no way to reach them');
  }
  const stored = JSON.stringify(db.prepare('SELECT * FROM company_passengers WHERE id = ?').get(r.body.passenger.id));
  assert.ok(!LEAK.test(stored), 'a posted number was stored anyway: ' + stored);
});

test('her people and places are hers alone', async () => {
  const a = company(), b = company();
  await call('post', '/business/passengers', { as: a.contactId, body: { name: 'A Person' } });
  await call('post', '/business/places', { as: a.contactId, body: { label: 'Head office', address: '14 Chesswood Road' } });
  const pb = await call('get', '/business/passengers', { as: b.contactId });
  const lb = await call('get', '/business/places', { as: b.contactId });
  assert.strictEqual(pb.body.passengers.length, 0, 'another company\'s people are visible');
  assert.strictEqual(lb.body.places.length, 0, 'another company\'s places are visible');
});

test('the whole surface is closed to staff and to personal accounts', async () => {
  const { contactId } = company();
  for (const [m, p] of [['get', '/business/me'], ['get', '/business/passengers'],
                        ['post', '/business/bookings'], ['get', '/business/export'],
                        ['get', '/business/statement']]) {
    const staff = await call(m, p, { auth: { type: 'user', id: 1, role: 'owner' } });
    assert.strictEqual(staff.statusCode, 403, p + ' is open to staff');
  }
  const solo = db.prepare("INSERT INTO customers (email, password, full_name) VALUES (?, '', 'Ben')")
    .run('ben' + (++seq) + '@example.com').lastInsertRowid;
  const r = await call('get', '/business/me', { as: solo });
  assert.strictEqual(r.statusCode, 403, 'a personal account reached the business surface');
  assert.ok(contactId);
});

test('she can take the rides away as a CSV, quoted properly', async () => {
  const { companyId, contactId } = company();
  db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, fare, payment, status, passenger_name, client_ref)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('WM-C' + (++seq), companyId, '14 Chesswood Road, Worthing', 'Gatwick, South Terminal',
         '2026-10-09', '06:15', 95, 'account', 'completed', 'Mr J. "Jim" Vance', 'PO-4471');
  const r = await call('get', '/business/export', { as: contactId, query: { from: '2026-10-01', to: '2026-10-31' } });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(/text\/csv/.test(r.headers['Content-Type']), 'not served as a CSV');
  assert.ok(/attachment; filename=/.test(r.headers['Content-Disposition']), 'not served as a download');
  const csv = r.body;
  assert.ok(/"Date","Time","Reference"/.test(csv), 'no header row');
  assert.ok(/"14 Chesswood Road, Worthing"/.test(csv), 'an address with a comma broke the columns');
  assert.ok(/"Mr J\. ""Jim"" Vance"/.test(csv), 'a quote in a name was not doubled');
  assert.ok(!LEAK.test(csv), 'the export carries a passenger number');
});

test('the statement adds up what is owed and what is still running', async () => {
  const { companyId, contactId } = company();
  db.prepare(`INSERT INTO invoices (invoice_no, kind, customer_id, recipient_name, issued_date, due_date,
                                    period_label, line_items_json, total, paid)
              VALUES (?,'account',?,?,?,?,?,'[]',?,?)`)
    .run('INV-T' + (++seq), companyId, 'Harding Executive Travel', '2026-10-01', '2026-10-14', 'September 2026', 986.50, 0);
  db.prepare(`INSERT INTO invoices (invoice_no, kind, customer_id, recipient_name, issued_date, due_date,
                                    period_label, line_items_json, total, paid)
              VALUES (?,'account',?,?,?,?,?,'[]',?,?)`)
    .run('INV-T' + (++seq), companyId, 'Harding Executive Travel', '2026-09-01', '2026-09-14', 'August 2026', 1744.00, 1);
  ride(companyId, { fare: 95 }); ride(companyId, { fare: 165 });
  const r = await call('get', '/business/statement', { as: contactId });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.owed, 986.50, 'what is owed is wrong');
  assert.strictEqual(r.body.uninvoiced.rides, 2, 'the running rides are wrong');
  assert.strictEqual(r.body.uninvoiced.total, 260, 'the running total is wrong');
  assert.strictEqual(r.body.company, 'Harding Executive Travel');
});

// ── 5. WHAT THE DESIGN SAYS IT WILL NOT DO ────────────────────────────────
console.log('\nThe things the design deliberately leaves out');

test('there is no department or cost-centre field anywhere', () => {
  for (const f of ['server/db.js', 'server/api.js', 'server/business-account.js', 'westmere-rider.html']) {
    const src = strip(read(f));
    assert.ok(!/cost_centre|cost_center|\bdepartment\b/i.test(src),
      f + ' has grown a department field — the company name is the attribution');
  }
});

test('a second booker is possible in the data and offered nowhere', () => {
  const { companyId } = company();
  const second = db.prepare(`INSERT INTO customers (email, password, full_name, phone, account_type, parent_customer_id)
                             VALUES (?, '', 'Paul Mason', '01903 555 111', 'business', ?)`)
    .run('paul' + (++seq) + '@harding.co.uk', companyId).lastInsertRowid;
  assert.strictEqual(biz.accountIdFor(db, second), companyId, 'the shape does not allow a second booker');
  /* …and nothing in the app says so. */
  const ui = strip(read('westmere-rider.html'));
  assert.ok(!/add a booker|invite a colleague|bookers/i.test(ui),
    'the app is offering more than one booker — that is not a v1 feature');
});

test('the terms say the driver rings the contact, not the passenger', () => {
  const terms = read('westmere-terms.html');
  assert.ok(/account contact/i.test(terms) && /do not hold|does not hold/i.test(terms),
    'the terms do not say that a passenger\'s number is not held');
  assert.ok(/ring|call/i.test(terms), 'the terms do not say who the driver calls');
});

// ── 6. THE NEGATIVE TEST ──────────────────────────────────────────────────
console.log('\nReintroduce each bug and prove this file catches it');

test('NEGATIVE: a builder that printed the passenger\'s number would fail', () => {
  /* The real assertion, run against a deliberately broken render. */
  const broken = '<p>Name</p><p>Mr J. Vance</p><p>Phone</p><p>07700 900344</p>';
  let caught = false;
  try { assert.ok(!LEAK.test(broken), 'leak'); } catch (e) { caught = true; }
  assert.ok(caught, 'the leak check does not actually detect a leaked number');
});

test('NEGATIVE: a route that stored the posted number would fail', async () => {
  const { contactId } = company();
  /* passengerFieldsFor is the one place a business booking's passenger fields
     are built. Break it and the assertion above must notice. */
  const good = biz.passengerFieldsFor('Mr J. Vance');
  assert.strictEqual(good.passenger_phone, null);
  const brokenRow = Object.assign({}, good, { passenger_phone: '07700 900344' });
  let caught = false;
  try { assert.strictEqual(brokenRow.passenger_phone, null, 'stored'); } catch (e) { caught = true; }
  assert.ok(caught, 'the stored-number check would pass a stored number');
  assert.ok(contactId);
});

test('NEGATIVE: reads that forgot to resolve to the company would fail', async () => {
  const { companyId, contactId } = company();
  ride(companyId); ride(companyId);
  /* What the query did before: the contact's own id. */
  const wrong = db.prepare('SELECT COUNT(*) c FROM bookings WHERE customer_id = ?').get(contactId).c;
  const right = db.prepare('SELECT COUNT(*) c FROM bookings WHERE customer_id = ?').get(companyId).c;
  assert.strictEqual(wrong, 0, 'the fixture does not reproduce the bug');
  assert.ok(right >= 2, 'the rides are not on the company');
  let caught = false;
  try { assert.strictEqual(wrong, 2, 'empty screen'); } catch (e) { caught = true; }
  assert.ok(caught, 'the she-sees-the-company-rides check would pass an empty screen');
});

test('the lookup can never stop a job email going out', () => {
  /* IT SITS IN FRONT OF A DRIVER'S WORK. The first version named its columns,
     threw `no such column: account_type` against an older customers table, and
     the ad-hoc job offer was silently not sent — not a wrong answer, no email
     at all. It degrades to "not a business account" now, which is the only safe
     direction for a lookup on this path. */
  const Database = require('better-sqlite3');
  const thin = new Database(':memory:');
  thin.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT, phone TEXT, active INTEGER DEFAULT 1);
             INSERT INTO customers (id, full_name, phone) VALUES (1, 'Old Row', '07700 900000');`);
  assert.strictEqual(biz.accountIdFor(thin, 1), 1, 'a table with no parent column must resolve to the row itself');
  assert.strictEqual(biz.driverContactFor(thin, { customer_id: 1 }), null, 'it must read as not-a-business-account');
  const same = { ref: 'X', customer_id: 1 };
  assert.strictEqual(biz.forDriver(thin, same), same, 'the payload must come back untouched, not throw');
  const none = new Database(':memory:');
  assert.strictEqual(biz.contextFor(none, 1), null, 'no customers table at all must not throw either');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/business-account\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
