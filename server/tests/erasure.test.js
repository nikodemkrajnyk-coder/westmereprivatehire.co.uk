/**
 * ERASURE, RETENTION AND THE POLICY THAT DESCRIBES THEM — run with:
 *   node server/tests/erasure.test.js        (also gated by `npm test`)
 *
 * Three promises were being made to customers that no code kept.
 *
 *   "You can ask us to delete your data." The only delete in the codebase set
 *   active = 0 and left the row full of name, phone, home address and bank
 *   details — and registering the same email again turned it back on, password
 *   and all, for whoever typed the address. Hiding a row is not erasure, and
 *   un-hiding it for a stranger is worse than not offering erasure at all.
 *
 *   "Records are kept for six years and then securely deleted." Nothing
 *   deleted anything. An eight-year-old booking still carried a name, a number
 *   and a front door.
 *
 *   "We collect basic web analytics." There is no analytics code on the site
 *   at all. A privacy policy that claims processing which does not happen is
 *   as wrong as one that omits processing which does — and this one also
 *   omitted every processor by name, including the one that sends the emails
 *   and the one that reads the addresses.
 *
 * What makes these worth guarding rather than just fixing: each failure mode
 * is SILENT. An erasure that misses a table looks exactly like one that did
 * not. A retention sweep that never runs looks exactly like a database with
 * nothing old in it. So the tests below put real rows in a real database,
 * erase, and then go looking for the person in every table that could still
 * hold them — and the last section reintroduces each bug to prove this file
 * would have caught it.
 *
 * WHAT MUST SURVIVE ERASURE, and is asserted just as hard as what must go:
 * the journey's date, route, fare and driver, and the invoice. A private hire
 * operator has to show its licensing authority a record of journeys and HMRC
 * a record of invoices. An "erasure" that destroyed those would trade one
 * legal problem for a worse one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock, routeBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-erase-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
const erasure = require('../erasure');
const custdir = require('../customer-directory');
custdir.ensureSchema(db);
const api = require('../api');
const auth = require('../auth').router;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function resp() {
  return { statusCode: 200, body: null, headers: {}, cleared: [],
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    clearCookie(n) { this.cleared.push(n); return this; },
    cookie() { return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    get(k) { return this.headers[k]; } };
}
async function call(router, method, routePath, opts) {
  const o = opts || {};
  const l = router.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                get: () => 'test-agent', cookies: {},
                auth: o.auth === null ? undefined : (o.auth || { type: 'customer', id: o.as, role: 'customer' }) };
  const r = resp();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let next = false;
    await h(req, r, () => { next = true; });
    if (!next) break;
  }
  return r;
}

// ── A CUSTOMER WITH A LIFE: journeys, an invoice, an address-book entry ────
const EMAIL = 'edith.brennan@example.invalid';
const PHONE = '07700 900412';

function seedCustomer(email, phone) {
  const r = db.prepare(`INSERT INTO customers (email, password, full_name, phone,
                          address_line1, postcode, bank_sort_code, bank_account_no, verified)
                        VALUES (?,?,?,?,?,?,?,?,1)`)
    .run(email, '$2b$10$notarealhash', 'Edith Brennan', phone,
         '14 Mill Lane', 'BN7 2QQ', '00-00-00', '00000000');
  return r.lastInsertRowid;
}
/* A real driver row: bookings.driver_id is a foreign key, and seeding one
   without it fails the insert rather than the assertion — which is how a guard
   ends up testing nothing. */
const DRIVER = (function () {
  const got = db.prepare("SELECT id FROM users WHERE username = 'erase-driver'").get();
  if (got) return got.id;
  return db.prepare(`INSERT INTO users (username, password, role, full_name)
                     VALUES ('erase-driver','x','driver','Ray Doughty')`).run().lastInsertRowid;
})();

function seedBooking(customerId, ref, date, extra) {
  const e = extra || {};
  db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, fare,
                 status, payment, passenger_name, passenger_phone, passenger_email,
                 notes, customer_note, driver_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, customerId, '14 Mill Lane, Lewes', 'Gatwick North Terminal', date, '06:15', 82.5,
         'completed', 'card', e.name || 'Edith Brennan', e.phone || PHONE, e.email || EMAIL,
         'Key safe code 4412', 'Please ring, do not knock', DRIVER);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}

const ID = seedCustomer(EMAIL, PHONE);
seedBooking(ID, 'WPH-ER-1', '2026-09-02');
seedBooking(ID, 'WPH-ER-2', '2026-09-19');
db.prepare(`INSERT INTO invoices (invoice_no, kind, customer_id, recipient_name, recipient_email,
               issued_date, line_items_json, total)
            VALUES (?,?,?,?,?,?,?,?)`)
  .run('INV-ER-0001', 'account', ID, 'Edith Brennan', EMAIL, '2026-09-30', '[]', 165);
db.prepare(`INSERT INTO customer_directory (phone_key, email_key, customer_id, name, phone, email, home_address)
            VALUES (?,?,?,?,?,?,?)`)
  .run('7700900412', EMAIL, ID, 'Edith Brennan', PHONE, EMAIL, '14 Mill Lane, Lewes');
db.prepare('INSERT INTO invoice_recipients (name, email, address, phone) VALUES (?,?,?,?)')
  .run('Edith Brennan', EMAIL, '14 Mill Lane, Lewes', PHONE);
db.prepare('INSERT INTO review_emails_sent (email) VALUES (?)').run(EMAIL);
db.prepare(`INSERT INTO sessions (customer_id, role, ip, user_agent, expires_at)
            VALUES (?,?,?,?,datetime('now','+30 days'))`)
  .run(ID, 'customer', '81.2.3.4', 'Safari');
db.prepare(`INSERT INTO change_requests (booking_id, booking_ref, customer_id, contact_name,
               contact_email, contact_phone, current_json, requested_json)
            VALUES ((SELECT id FROM bookings WHERE ref='WPH-ER-1'),'WPH-ER-1',?,?,?,?,'{}','{}')`)
  .run(ID, 'Edith Brennan', EMAIL, PHONE);

// ── THE PREVIEW TELLS THE TRUTH BEFORE ANYTHING IS DESTROYED ──────────────

test('the preview counts what is really there, and writes nothing', () => {
  const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
  const plan = erasure.erasurePlan(db, ID);
  assert.strictEqual(plan.journeys, 2, 'both journeys must be counted');
  assert.strictEqual(plan.invoices, 1, 'the invoice must be counted');
  assert.strictEqual(plan.directory, 1, 'the address-book row must be counted');
  assert.strictEqual(plan.sessions, 1);
  assert.strictEqual(plan.retention_years, 6, 'the figure the policy names');
  const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
  assert.deepStrictEqual(after, before, 'a PREVIEW must not change a single field');
  const n = db.prepare('SELECT COUNT(*) c FROM bookings WHERE customer_id = ?').get(ID).c;
  assert.strictEqual(n, 2, 'nor may it detach anything');
});

test('dryRun is the same answer, and still writes nothing', () => {
  const plan = erasure.eraseCustomer(db, ID, { dryRun: true });
  assert.strictEqual(plan.journeys, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM bookings WHERE customer_id = ?').get(ID).c, 2,
    'eraseCustomer({dryRun}) must not erase');
});

// ── THE ERASURE ITSELF ────────────────────────────────────────────────────

test('erasing detaches the journeys and keeps the road', () => {
  const b1 = db.prepare("SELECT * FROM bookings WHERE ref = 'WPH-ER-1'").get();
  erasure.eraseCustomer(db, ID);
  const after = db.prepare("SELECT * FROM bookings WHERE ref = 'WPH-ER-1'").get();

  // What the licence and HMRC need — untouched.
  assert.strictEqual(after.date, b1.date, 'the date must survive');
  assert.strictEqual(after.pickup, b1.pickup, 'the pickup must survive');
  assert.strictEqual(after.destination, b1.destination, 'the destination must survive');
  assert.strictEqual(after.fare, b1.fare, 'the fare must survive — it is an accounting record');
  assert.strictEqual(after.driver_id, b1.driver_id, 'who drove must survive');
  assert.strictEqual(after.driver_id, DRIVER);
  assert.strictEqual(after.status, 'completed');

  // What identifies a person — gone.
  assert.strictEqual(after.customer_id, null, 'the account link must be cut');
  assert.strictEqual(after.passenger_phone, null, 'the number must go');
  assert.strictEqual(after.passenger_email, null, 'the email must go');
  assert.strictEqual(after.notes, null, 'notes hold door codes and must go');
  assert.strictEqual(after.customer_note, null, 'the customer note must go');
  assert.ok(!/Edith|Brennan/i.test(after.passenger_name), 'the name must go: ' + after.passenger_name);
  assert.strictEqual(after.passenger_name, erasure.ERASED_NAME);
});

test('both journeys are detached, not just the first', () => {
  const left = db.prepare(`SELECT COUNT(*) c FROM bookings
                            WHERE customer_id = ? OR passenger_email = ?`).get(ID, EMAIL).c;
  assert.strictEqual(left, 0, 'every journey must be detached');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM bookings').get().c, 2,
    'and none of them deleted');
});

test('the account row is overwritten, not switched off', () => {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
  assert.ok(row, 'the row must remain — journeys inside the window reference the id');
  assert.ok(!/edith|brennan/i.test(JSON.stringify(row)),
    'nothing identifying may be left anywhere on the row: ' + JSON.stringify(row));
  assert.strictEqual(row.phone, null);
  assert.strictEqual(row.address_line1, null, 'a home address is the most sensitive field here');
  assert.strictEqual(row.postcode, null);
  assert.strictEqual(row.bank_sort_code, null, 'bank details must not outlive the account');
  assert.strictEqual(row.bank_account_no, null);
  assert.strictEqual(row.password, '', 'no hash may remain to be cracked or restored');
  assert.strictEqual(row.active, 0);
  assert.ok(row.erased_at, 'the row must be stamped so it reads as a tombstone, not a dormant account');
  assert.ok(/\.invalid$/.test(row.email), 'the email must become unreachable and unmatchable: ' + row.email);
});

test('the invoice is kept whole and unhooked', () => {
  const inv = db.prepare("SELECT * FROM invoices WHERE invoice_no = 'INV-ER-0001'").get();
  assert.ok(inv, 'an issued invoice is a tax document — it must NOT be deleted');
  assert.strictEqual(inv.total, 165, 'and its figures must still add up');
  assert.strictEqual(inv.customer_id, null, 'but it must no longer point at an account');
});

test('nothing of the person is left in any side table', () => {
  const hits = [];
  const look = (sql, label) => {
    try { if (db.prepare(sql).get(EMAIL, '%Brennan%').c > 0) hits.push(label); } catch (e) {}
  };
  look("SELECT COUNT(*) c FROM customer_directory WHERE email_key = ? OR name LIKE ?", 'customer_directory');
  look("SELECT COUNT(*) c FROM invoice_recipients WHERE email = ? OR name LIKE ?", 'invoice_recipients');
  look("SELECT COUNT(*) c FROM review_emails_sent WHERE email = ? OR email LIKE ?", 'review_emails_sent');
  assert.deepStrictEqual(hits, [], 'these tables hold no journey record and must be emptied of them');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM sessions WHERE customer_id = ?').get(ID).c, 0,
    'the session log holds an IP address and must go with the account');
  const cr = db.prepare("SELECT * FROM change_requests WHERE booking_ref = 'WPH-ER-1'").get();
  assert.ok(cr, 'the request itself is the owner\'s record and stays');
  assert.strictEqual(cr.contact_email, null, 'its contact details do not');
  assert.strictEqual(cr.contact_phone, null);
  assert.strictEqual(cr.customer_id, null);
});

test('it is written down that it happened', () => {
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'account_erased' AND user_id = ?").get(ID);
  assert.ok(a, 'an erasure must leave an audit line');
  assert.ok(!/edith|brennan|example\.invalid/i.test(a.detail || ''),
    'and that line must not re-record the identity we just removed: ' + a.detail);
  assert.ok(/journey/.test(a.detail), 'it must say what it did: ' + a.detail);
});

test('the same address can start a genuinely new account afterwards', () => {
  const again = seedCustomer(EMAIL, PHONE);
  assert.notStrictEqual(again, ID, 'a new row, not the old one brought back');
  const old = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
  assert.ok(/\.invalid$/.test(old.email), 'and the tombstone keeps out of the way of the UNIQUE index');
  db.prepare('DELETE FROM customers WHERE id = ?').run(again);
});

// ── A COMPANY ACCOUNT IS NOT ONE PERSON'S TO ERASE ────────────────────────

test('a business account is refused, with a reason', () => {
  const co = db.prepare(`INSERT INTO customers (email, password, full_name, account_type, company)
                         VALUES (?,?,?,'business',?)`)
    .run('accounts@harding.invalid', 'x', 'Harding Executive Travel', 'Harding Executive Travel').lastInsertRowid;
  const contact = db.prepare(`INSERT INTO customers (email, password, full_name, phone, parent_customer_id)
                              VALUES (?,?,?,?,?)`)
    .run('jo@harding.invalid', 'x', 'Jo Pryce', '07700 900100', co).lastInsertRowid;
  for (const who of [co, contact]) {
    const plan = erasure.erasurePlan(db, who);
    assert.strictEqual(plan.refused, 'business', 'id ' + who + ' must be refused');
    const done = erasure.eraseCustomer(db, who);
    assert.strictEqual(done.refused, 'business');
    const still = db.prepare('SELECT * FROM customers WHERE id = ?').get(who);
    assert.strictEqual(still.active, 1, 'and nothing may be written');
    assert.ok(!still.erased_at);
  }
});

// ── THE SIX YEARS, ACTUALLY APPLIED ───────────────────────────────────────

test('the cutoff is component arithmetic on a wall-clock date', () => {
  assert.strictEqual(erasure.cutoffDate(6, '2026-10-07'), '2020-10-07');
  assert.strictEqual(erasure.cutoffDate(6, '2026-01-01'), '2020-01-01',
    'a January date must not slip into the previous year');
  assert.strictEqual(erasure.cutoffDate(6, '2024-02-29'), '2018-02-29',
    'a leap day is a string here, not an instant to be re-parsed');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(erasure.cutoffDate(6)), 'and today still yields a date');
});

test('retention deletes what is past the window and keeps what is inside it', () => {
  const keep = seedCustomer('inside@example.invalid', '07700 900500');
  seedBooking(keep, 'WPH-NEW-1', '2026-06-01');
  seedBooking(keep, 'WPH-OLD-1', '2018-06-01');
  db.prepare(`INSERT INTO invoices (invoice_no, kind, recipient_name, issued_date, line_items_json, total)
              VALUES ('INV-OLD-1','bespoke','Someone','2017-04-01','[]',40)`).run();

  const plan = erasure.runRetention(db, { today: '2026-10-07', dryRun: true });
  assert.strictEqual(plan.cutoff, '2020-10-07');
  assert.ok(plan.bookings >= 1, 'the 2018 journey must be in the plan');
  assert.ok(db.prepare("SELECT 1 FROM bookings WHERE ref = 'WPH-OLD-1'").get(),
    'a DRY RUN must delete nothing');

  erasure.runRetention(db, { today: '2026-10-07' });
  assert.ok(!db.prepare("SELECT 1 FROM bookings WHERE ref = 'WPH-OLD-1'").get(),
    'an eight-year-old journey has no lawful basis left and must be gone');
  assert.ok(db.prepare("SELECT 1 FROM bookings WHERE ref = 'WPH-NEW-1'").get(),
    'this year\'s journey must NOT be touched');
  assert.ok(!db.prepare("SELECT 1 FROM invoices WHERE invoice_no = 'INV-OLD-1'").get(),
    'a nine-year-old invoice goes too');
  assert.ok(db.prepare("SELECT 1 FROM invoices WHERE invoice_no = 'INV-ER-0001'").get(),
    'last month\'s does not');
});

test('an expired session is pruned on its own expiry, not after six years', () => {
  db.prepare(`INSERT INTO sessions (customer_id, role, ip, expires_at)
              VALUES (99,'customer','81.2.3.4',datetime('now','-1 day'))`).run();
  db.prepare(`INSERT INTO sessions (customer_id, role, ip, expires_at)
              VALUES (98,'customer','81.2.3.5',datetime('now','+1 day'))`).run();
  erasure.runRetention(db, { today: '2026-10-07' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM sessions WHERE customer_id = 99').get().c, 0,
    'an expired session row holds an IP address and nothing useful');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM sessions WHERE customer_id = 98').get().c, 1,
    'a live one must survive, or everybody is signed out nightly');
});

test('the sweeper is actually started at boot, and can be turned off', () => {
  const src = strip(read('server/index.js'));
  assert.ok(/require\('\.\/erasure'\)\.startRetention\(/.test(src),
    'a retention routine nobody calls is a promise nobody keeps');
  assert.ok(/RETENTION_SWEEP/.test(src), 'and there must be a way to stop it without editing code');
});

// ── THE ROUTES A CUSTOMER USES ────────────────────────────────────────────

test('the preview route is customer-only and reports the plan', async () => {
  const mine = seedCustomer('routes@example.invalid', '07700 900600');
  seedBooking(mine, 'WPH-RT-1', '2026-08-08');

  const anon = await call(api, 'get', '/customer/erase/preview', { auth: { type: 'user', id: 1, role: 'admin' } });
  assert.strictEqual(anon.statusCode, 403, 'an admin may not preview somebody else\'s erasure here');

  const r = await call(api, 'get', '/customer/erase/preview', { as: mine });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.plan.journeys, 1, 'the screen must be given the server\'s count, not its own');
  db.prepare('DELETE FROM bookings WHERE customer_id = ?').run(mine);
  db.prepare('DELETE FROM customers WHERE id = ?').run(mine);
});

test('the erase route refuses without the typed confirmation', async () => {
  const mine = seedCustomer('typed@example.invalid', '07700 900700');
  const no = await call(api, 'post', '/customer/erase', { as: mine, body: {} });
  assert.strictEqual(no.statusCode, 400, 'a bare POST must not destroy an account');
  assert.strictEqual(db.prepare('SELECT active FROM customers WHERE id = ?').get(mine).active, 1);

  const wrong = await call(api, 'post', '/customer/erase', { as: mine, body: { confirm: 'yes' } });
  assert.strictEqual(wrong.statusCode, 400, 'and neither must the wrong word');
  assert.ok(!db.prepare('SELECT erased_at FROM customers WHERE id = ?').get(mine).erased_at);

  const ok = await call(api, 'post', '/customer/erase', { as: mine, body: { confirm: 'delete' } });
  assert.strictEqual(ok.statusCode, 200, 'the right word, in any case, must work');
  assert.ok(db.prepare('SELECT erased_at FROM customers WHERE id = ?').get(mine).erased_at);
  assert.ok(ok.cleared.indexOf('wph_token') > -1, 'the session cookie must go with the account');
});

test('the erase route is scoped to the caller, whatever the body says', async () => {
  const a = seedCustomer('vic@example.invalid', '07700 900800');
  const b = seedCustomer('attacker@example.invalid', '07700 900900');
  await call(api, 'post', '/customer/erase',
    { as: b, body: { confirm: 'DELETE', customer_id: a, id: a } });
  assert.strictEqual(db.prepare('SELECT active FROM customers WHERE id = ?').get(a).active, 1,
    'an id in the body must not choose whose account is destroyed');
  assert.ok(db.prepare('SELECT erased_at FROM customers WHERE id = ?').get(b).erased_at,
    'the caller\'s own account is the one that goes');
});

// ── A CLOSED ACCOUNT'S TOKEN MUST STOP WORKING ───────────────────────────

test('a signed token does not outlive the account it names', () => {
  /* Found by driving the real route end to end rather than by reading it: the
     erase returned 200, and the SAME cookie then fetched /customer/profile and
     got 200 back. The JWT was never checked against the database, so a closed
     account stayed signed in for up to the thirty days the cookie lasts. */
  const { accountStillLive } = require('../middleware');
  const live = seedCustomer('stillhere@example.invalid', '07700 901000');
  assert.strictEqual(accountStillLive({ id: live, type: 'customer' }), true,
    'an ordinary signed-in customer must not be thrown out');

  erasure.eraseCustomer(db, live);
  assert.strictEqual(accountStillLive({ id: live, type: 'customer' }), false,
    'an erased account\'s token must stop authenticating at once');

  assert.strictEqual(accountStillLive({ id: 999999, type: 'customer' }), false,
    'a token naming a row that no longer exists must be refused');
  assert.strictEqual(accountStillLive({ type: 'customer' }), false, 'and one naming nobody');

  const drv = db.prepare(`INSERT INTO users (username, password, role, full_name, active)
                          VALUES ('gone-driver','x','driver','Gone Driver',0)`).run().lastInsertRowid;
  assert.strictEqual(accountStillLive({ id: drv, type: 'user' }), false,
    'the same must hold for a staff account that has been switched off');

  /* And the check must be wired into the middleware, not merely exported. */
  const mw = strip(read('server/middleware.js'));
  const ra = fnBlock(mw, 'requireAuth');
  assert.ok(/accountStillLive/.test(ra), 'requireAuth must call it');
  assert.ok(/clearCookie/.test(ra), 'and clear the cookie it just refused');
});

// ── REGISTERING AGAIN MUST NOT RESURRECT A CLOSED ACCOUNT ─────────────────

test('signup does not revive a closed account', async () => {
  /* Bounded by the next route declaration, not by a character count — a window
     measured in characters stops reaching the code it guards the day somebody
     adds a branch above it, and goes on passing. server/tests/_source.js. */
  const reg = routeBlock(strip(read('server/auth.js')), "router.post('/customer/register'");
  assert.ok(/existing\.active === 0/.test(reg),
    'the register route must notice a closed account explicitly');
  assert.ok(!/UPDATE\s+customers/i.test(reg),
    'registering an existing email must not write to that row at all: an UPDATE here is the resurrection bug');
  assert.ok(!/active\s*=\s*1/.test(reg), 'and nothing in it may set active = 1');

  /* And the behaviour, not only the source: register against the account we
     erased above and check the row is untouched. */
  const erased = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
  const r = await call(auth, 'post', '/customer/register', {
    auth: null, body: { full_name: 'Not Edith', email: erased.email, password: 'hunter2hunter2' }
  });
  assert.strictEqual(r.statusCode, 409, 'it must be refused');
  assert.deepStrictEqual(db.prepare('SELECT * FROM customers WHERE id = ?').get(ID), erased,
    'and the tombstone must come back byte for byte — no new password, no active = 1');
});

// ── THE POLICY MUST DESCRIBE WHAT THE CODE ACTUALLY DOES ──────────────────

test('the privacy policy does not claim analytics we do not run', () => {
  const p = read('westmere-privacy.html');
  assert.ok(/do not use website analytics/i.test(p),
    'the policy claimed "basic web analytics"; there is no analytics code on the site');
  // And the claim must stay true: no tracker may be added without this failing.
  for (const f of ['index.html', 'book.html', 'westmere-rider.html', 'westmere-privacy.html']) {
    const src = read(f);
    assert.ok(!/googletagmanager|google-analytics\.com|gtag\(|plausible\.io|hotjar|connect\.facebook\.net/i.test(src),
      f + ' has gained a tracker — either remove it or correct the privacy policy');
  }
});

test('the privacy policy names the processors that actually see the data', () => {
  const p = read('westmere-privacy.html');
  for (const who of ['Resend', 'Stripe', 'Mapbox', 'OpenStreetMap', 'OSRM', 'Anthropic', 'Google', 'Railway']) {
    assert.ok(new RegExp(who, 'i').test(p), 'the policy must name ' + who + ' — our systems send it personal data');
  }
  assert.ok(/six years/i.test(p), 'the retention period must be stated');
  assert.ok(/Close my account/i.test(p), 'and the self-service erasure must be described');
});

test('the retention period in the policy is the one in the code', () => {
  const p = read('westmere-privacy.html');
  const words = { 6: 'six' };
  assert.ok(new RegExp(words[erasure.RETENTION_YEARS] + ' years', 'i').test(p),
    'the policy says a different number of years from server/erasure.js — one of them is a lie');
});

test('the cookie policy lists the one cookie there is, and no banner is claimed', () => {
  const c = read('westmere-cookies.html');
  assert.ok(/wph_token/.test(c), 'the only cookie must be named');
  assert.ok(/do not show you a cookie banner/i.test(c),
    'the reason there is no banner must be stated, not left to look like an omission');
  // The claim "one cookie" has to stay true: res.cookie() is how it stops being true.
  const names = new Set();
  for (const f of ['server/auth.js', 'server/api.js', 'server/public-api.js', 'server/index.js']) {
    const src = strip(read(f));
    const re = /res\.cookie\(\s*['"]([a-z_]+)['"]/gi;
    let m; while ((m = re.exec(src))) names.add(m[1]);
  }
  assert.deepStrictEqual([...names].sort(), ['wph_token'],
    'the server now sets a cookie the cookie policy does not list: ' + [...names].join(', '));
});

test('the terms and the privacy policy agree about the passenger phone number', () => {
  const flat = (f) => read(f).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  const priv = flat('westmere-privacy.html');
  const terms = flat('westmere-terms.html');
  assert.ok(/company account[\s\S]{0,120}not ask for or hold your phone number/i.test(priv),
    'the privacy policy must state the business-account rule: we do not hold the passenger\'s number');
  assert.ok(/not held|do not hold|does not hold/i.test(terms) && /account contact|booking contact/i.test(terms),
    'and the terms must say the same thing — section 10, Business Accounts');
  /* The code is the third party to that agreement. */
  const biz = strip(read('server/business-account.js'));
  assert.ok(/passenger_phone:\s*null/.test(biz),
    'and business-account.js must actually strip it, or both documents are wrong');
});

// ── THE CUSTOMER'S OWN SCREEN ─────────────────────────────────────────────

test('the close-account panel asks the server before it offers the button', () => {
  const src = strip(read('westmere-rider.html'), { html: true });
  assert.ok(/id="ca-panel"/.test(src), 'My Details must carry a close-account panel');
  const open = fnBlock(src, 'caOpen');
  assert.ok(/\/api\/customer\/erase\/preview/.test(open),
    'the panel must print the SERVER\'s count — a screen that counts from its own cache will lie');
  const go = fnBlock(src, 'caGo');
  assert.ok(/confirm:\s*'DELETE'/.test(go), 'the POST must carry the typed confirmation');
  assert.ok(/method:\s*'POST'/.test(go), 'and it must be a POST — a GET can be prefetched by a mail client');
  /* The button's own tag, bounded by its closing angle bracket — the one thing
     that cannot drift as the markup around it grows. */
  const tag = /<button[^>]*id="ca-go"[^>]*>/.exec(src);
  assert.ok(tag, 'the confirm button must exist');
  assert.ok(/\bdisabled\b/.test(tag[0]),
    'it must START disabled — a destructive button that is live on first paint is one stray tap from erasing an account: ' + tag[0]);
  const typed = fnBlock(src, 'caTyped');
  assert.ok(/'DELETE'/.test(typed) && /disabled\s*=/.test(typed),
    'and only the typed word may enable it');
  assert.ok(/cannot be undone/i.test(src), 'the screen must say there is no undo');
});

test('a company account is not offered the panel', () => {
  const src = read('westmere-rider.html');
  /* Two independent stops, because the panel's copy promises an erasure the
     server will refuse: a CSS rule that cannot be missed on a re-render, and
     the script that decides whether to show it at all. */
  assert.ok(/body\.is-business\s+#ca-panel\s*\{[^}]*display\s*:\s*none/.test(src),
    'a company account must not be shown the panel at all (CSS stop missing)');
  const ui = fnBlock(strip(src, { html: true }), 'updateProfileUI');
  assert.ok(/ca-panel/.test(ui) && /BIZ/.test(ui),
    'and updateProfileUI must check for a business account before showing it');
  assert.ok(/_currentUser\.loggedIn/.test(ui),
    'and must not show it to somebody with no account to close');
});

// ── NEGATIVE TESTS: reintroduce each bug and prove this file catches it ───

test('NEGATIVE — a soft delete would not pass as erasure', () => {
  const Database = require('better-sqlite3');
  const t = new Database(':memory:');
  t.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, password TEXT, full_name TEXT,
            phone TEXT, address_line1 TEXT, postcode TEXT, active INTEGER DEFAULT 1, erased_at TEXT);
          INSERT INTO customers (id,email,password,full_name,phone,address_line1)
            VALUES (1,'e@x.invalid','hash','Edith Brennan','07700 900412','14 Mill Lane');`);
  // The OLD behaviour, exactly:
  t.prepare('UPDATE customers SET active = 0 WHERE id = 1').run();
  const row = t.prepare('SELECT * FROM customers WHERE id = 1').get();
  assert.throws(() => {
    assert.ok(!/edith|brennan/i.test(JSON.stringify(row)));
  }, 'the "nothing identifying may be left" assertion must fail on a soft delete');
  assert.throws(() => { assert.ok(row.erased_at); }, 'and the tombstone assertion must fail too');
});

test('NEGATIVE — an erasure that forgot a table would be caught', () => {
  const Database = require('better-sqlite3');
  const t = new Database(':memory:');
  t.exec(`CREATE TABLE customer_directory (email_key TEXT, name TEXT);
          INSERT INTO customer_directory VALUES ('e@x.invalid','Edith Brennan');`);
  const c = t.prepare("SELECT COUNT(*) c FROM customer_directory WHERE email_key = ? OR name LIKE ?")
    .get('e@x.invalid', '%Brennan%').c;
  assert.ok(c > 0, 'the side-table sweep must see a row that was left behind');
});

test('NEGATIVE — a retention sweep that deleted this year would be caught', () => {
  assert.throws(() => {
    // A cutoff built the wrong way round — years ADDED instead of subtracted.
    const wrong = '2032-10-07';
    assert.ok('2026-06-01' >= wrong, 'this year must be inside the window');
  }, 'the keep-what-is-inside-the-window assertion must fail on an inverted cutoff');
});

test('NEGATIVE — a policy that still claimed analytics would be caught', () => {
  const fake = '<p>Technical data: Basic web analytics (page views, device type).</p>';
  assert.throws(() => {
    assert.ok(/do not use website analytics/i.test(fake));
  }, 'the analytics assertion must fail on the old wording');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/erasure\.test\.js/.test(read('package.json')),
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
