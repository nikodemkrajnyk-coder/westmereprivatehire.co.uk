/**
 * TWO CHANNELS, ONE FARE — run with:
 *   node server/tests/double-payment.test.js   (also gated by `npm test`)
 *
 * WHAT CHANGED, AND WHY THIS EXISTS
 *   An estimate used to be payable in exactly one place: the tokenised Pay Now
 *   link in the email. It is now ALSO payable from My Account, so a customer
 *   who has lost the email is not stuck — and so the re-priced estimate that
 *   follows an accepted journey change can be settled wherever they happen to
 *   be looking.
 *
 *   Two doors to one till is how a customer gets charged twice. The rule that
 *   decides whether payment may proceed therefore lives in exactly one place
 *   (server/pay-lock.js), and EVERY entry point on BOTH channels asks it,
 *   against the LIVE booking row, immediately before doing anything:
 *
 *     email channel     : GET /pay/:ref · POST /pay/:ref/intent · POST /pay/:ref/cash
 *     My Account channel: GET /customer/bookings/:id/pay-options
 *                         POST /customer/bookings/:id/choose-cash
 *
 *   Whichever channel completes FIRST sets the state that locks the other, and
 *   the loser is told plainly rather than being allowed to pay again.
 *
 * WHAT THIS FILE PINS
 *   (a) card paid in one channel  → the other refuses ("already paid")
 *   (b) cash chosen in one channel → the other refuses a CARD charge
 *   (c) the re-sent estimate carries the OWNER'S manual fare, and money already
 *       collected is never lost when the booking is re-priced
 *   (d) accepting a change still never charges, refunds or re-prices anything
 *   (e) the customer's change-request route still cannot mutate the booking
 *
 * Runs the SHIPPED pay-lock module and the SHIPPED route handlers against a
 * throwaway database, with Resend and Stripe stubbed. Exit 1 on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

// Point the shared connection at a throwaway file BEFORE anything requires
// ./db. The routes under test reach for server/intake.js, which opens the
// shared database at load time and would otherwise run migrations against — and
// mint pay tokens into — the real data/westmere.db. Tests must never touch it.
const TMP_DB = path.join(os.tmpdir(), 'wm-double-payment-' + process.pid + '.db');
try { fs.unlinkSync(TMP_DB); } catch (_) {}
process.env.SQLITE_DB = TMP_DB;
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch (_) {} } });

process.env.RESEND_API_KEY = 'test_fake';
process.env.ADMIN_EMAIL = 'owner@westmereprivatehire.co.uk';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const apiSrc = read('server/api.js');
const publicSrc = read('server/public-api.js');
const RIDER = read('westmere-rider.html');
const PAYPAGE = read('westmere-pay.html');

// The REAL gate — not a re-implementation.
const { paymentLock, applyCashChoice, isSettled, isCashChosen } = require('../pay-lock');

// ── Pull real handlers out of server/api.js ──────────────────────────────
function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces at ' + from);
}
function extractHandler(src, method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'no longer defines ' + method.toUpperCase() + ' ' + route);
  return braceBody(src, src.indexOf('=>', start));
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'no longer defines ' + name + '()');
  // Keep `async` — rebuilding an async helper as a plain function turns its
  // `await` into a syntax error, and silently changes what is being tested.
  const isAsync = src.slice(Math.max(0, start - 6), start) === 'async ';
  const head = src.slice(src.indexOf('(', start) + 1, src.indexOf('{', start)).trim().replace(/\)$/, '');
  return (isAsync ? 'async ' : '') + 'function ' + name + '(' + head + ') {' + braceBody(src, start) + '}';
}

// Helpers the customer/staff routes share, lifted alongside them so the
// handlers run exactly as shipped.
const API_HELPERS =
  extractFn(apiSrc, 'customerOwnedBooking') + '\n' +
  extractFn(apiSrc, 'staffBooking') + '\n' +
  extractFn(apiSrc, 'settledPaymentOf') + '\n' +
  extractFn(apiSrc, 'suggestFareFor') + '\n';

function makeRunner(body) {
  return new Function(
    'req', 'res', 'getDb', 'events', 'require', 'console',
    API_HELPERS + 'return (async () => {' + body + '})();'
  );
}
const runPayOptions = makeRunner(extractHandler(apiSrc, 'get',  '/customer/bookings/:id/pay-options'));
const runChooseCash = makeRunner(extractHandler(apiSrc, 'post', '/customer/bookings/:id/choose-cash'));
const runReEstimate = makeRunner(extractHandler(apiSrc, 'post', '/bookings/:id/re-estimate'));

// The route bodies require() by paths relative to server/api.js.
const AS_API = {
  './email': '../email', './pay-lock': '../pay-lock', './intake': '../intake',
  './payment-methods': '../payment-methods', './fare-engine': '../fare-engine',
  '../wm-lifecycle': '../../wm-lifecycle'
};
const inject = (m) => require(Object.prototype.hasOwnProperty.call(AS_API, m) ? AS_API[m] : m);

// ── Throwaway DB, shipped shape ──────────────────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE, full_name TEXT, phone TEXT, active INTEGER DEFAULT 1
    );
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE, customer_id INTEGER, driver_id INTEGER,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, stop_address TEXT,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT 'ASAP',
      passengers INTEGER NOT NULL DEFAULT 1, bags TEXT NOT NULL DEFAULT '0',
      trip_type TEXT, flight TEXT, fare REAL, payment TEXT DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT,
      paid_at TEXT, pay_token TEXT, payment_intent_id TEXT, calendar_event_id TEXT,
      estimate_sent_at TEXT, re_estimated_at TEXT,
      change_requested_at TEXT, change_request_summary TEXT, change_request_detail TEXT,
      fare_review_at TEXT, prior_payments_json TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO customers (id,email,full_name,phone) VALUES (?,?,?,?)').run(1, 'ben@example.com', 'Mr Ben', '07700900123');
  db.prepare('INSERT INTO customers (id,email,full_name,phone) VALUES (?,?,?,?)').run(2, 'other@example.com', 'Someone Else', '07700900999');
  return db;
}

// A priced, unpaid estimate — the state both channels compete over.
function seed(db, over) {
  over = over || {};
  db.prepare(`INSERT INTO bookings
      (id,ref,customer_id,pickup,destination,date,time,passengers,bags,fare,payment,status,pay_token,passenger_name,passenger_email,passenger_phone,paid_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(10, 'WPH-PAY1', 1,
      '12 Greenhill Avenue, Caterham', 'Gatwick Airport, South Terminal',
      '2026-09-06', '11:30', 3, '2s+1l',
      over.fare === undefined ? 137 : over.fare,
      over.payment || 'pending',
      over.status || 'pending',
      over.pay_token === undefined ? 'tok-abc123' : over.pay_token,
      'Mr Ben', 'ben@example.com', '07700900123',
      over.paid_at || null);
  return db.prepare('SELECT * FROM bookings WHERE id = 10').get();
}

// What the SHIPPED Stripe webhook does on payment_intent.succeeded, lifted from
// server/public-api.js so this test can never diverge from the real thing.
const WEBHOOK_SQL = (() => {
  const i = publicSrc.indexOf("SET payment = 'card'");
  assert.ok(i !== -1, 'the Stripe webhook no longer marks payment=card');
  const start = publicSrc.lastIndexOf('UPDATE bookings', i);
  const end = publicSrc.indexOf('`', i);
  return publicSrc.slice(start, end);
})();
function payByCardViaWebhook(db, ref) {
  db.prepare(WEBHOOK_SQL).run('pi_test_123', ref);
}

let sent = [];
global.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ id: 'test-id' }) };
};

function call(runner, db, auth, body) {
  const out = { code: 200, payload: null };
  const res = { status(c) { out.code = c; return this; }, json(p) { out.payload = p; return this; } };
  const req = { auth: auth, params: { id: '10' }, body: body || {}, ip: '127.0.0.1' };
  return Promise.resolve(runner(req, res, () => db, { broadcast() {} }, inject, console)).then(() => out);
}
const CUSTOMER = { role: 'customer', type: 'customer', id: 1 };
const STRANGER = { role: 'customer', type: 'customer', id: 2 };
const OWNER = { role: 'owner', type: 'user', id: 7 };

// ══════════════════════════════════════════════════════════════════════════
console.log('\nThe gate itself — one rule, asked by both channels');

test('an unpaid, priced estimate is payable', () => {
  const l = paymentLock({ status: 'pending', payment: 'pending', fare: 137, paid_at: null });
  assert.ok(l.payable && !l.locked, 'a live estimate must be payable');
});

test('a card payment locks everything', () => {
  for (const b of [{ status: 'confirmed', payment: 'card', fare: 137 },
                   { status: 'confirmed', payment: 'pending', fare: 137, paid_at: '2026-08-13 10:00' }]) {
    const l = paymentLock(b);
    assert.strictEqual(l.reason, 'paid');
    assert.ok(l.locked && !l.payable);
    assert.ok(/already been paid/i.test(l.message), 'the wording must tell the customer it is already paid');
  }
});

test('choosing cash locks card payment — and does NOT claim to be paid', () => {
  const l = paymentLock({ status: 'awaiting_payment', payment: 'cash', fare: 137, paid_at: null });
  assert.strictEqual(l.reason, 'cash_chosen');
  assert.ok(l.locked && !l.payable, 'a card charge must be refused once the driver will be paid');
  assert.ok(!/already been paid/i.test(l.message),
    'nothing has been collected yet — telling the customer it is "paid" is a lie they would find out on the day');
  assert.ok(/pay your driver/i.test(l.message));
});

test('a cancelled booking is locked; an unpriced one is simply not payable yet', () => {
  assert.strictEqual(paymentLock({ status: 'cancelled', fare: 137 }).reason, 'cancelled');
  const np = paymentLock({ status: 'pending', payment: 'pending', fare: null });
  assert.strictEqual(np.reason, 'no_fare');
  assert.ok(!np.payable, 'nothing to pay yet');
  assert.ok(!np.locked, 'but not an error — the estimate simply has not been priced');
});

test('awaiting_payment is still payable — status is not a payment lock', () => {
  // Reading the lifecycle as a money-state is how awaiting_payment bookings
  // became unpayable in the past.
  assert.ok(paymentLock({ status: 'awaiting_payment', payment: 'pending', fare: 137 }).payable);
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(a) Card paid in one channel → the other refuses');

test('after a card payment, My Account offers nothing and says why', async () => {
  const db = makeDb();
  seed(db);
  payByCardViaWebhook(db, 'WPH-PAY1');            // the email channel completes
  const out = await call(runPayOptions, db, CUSTOMER);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.payload.payable, false, 'My Account must not offer to take money again');
  assert.strictEqual(out.payload.can_card, false);
  assert.strictEqual(out.payload.can_cash, false);
  assert.strictEqual(out.payload.reason, 'paid');
  assert.strictEqual(out.payload.pay_url, null, 'no pay link may be handed out for a settled trip');
  assert.ok(/already been paid/i.test(out.payload.message));
});

test('after a card payment, a My Account cash choice is REFUSED', async () => {
  const db = makeDb();
  seed(db);
  payByCardViaWebhook(db, 'WPH-PAY1');
  const out = await call(runChooseCash, db, CUSTOMER);
  assert.strictEqual(out.code, 409, 'the second channel must refuse (got ' + out.code + ')');
  const b = db.prepare('SELECT payment, paid_at FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.payment, 'card', 'a refused cash choice must not overwrite the card payment');
  assert.ok(b.paid_at, 'the payment record must survive');
});

test('the webhook clears pay_token, so the emailed link cannot be replayed', () => {
  const db = makeDb();
  seed(db);
  payByCardViaWebhook(db, 'WPH-PAY1');
  assert.strictEqual(db.prepare('SELECT pay_token FROM bookings WHERE id = 10').get().pay_token, null,
    'a settled booking must not keep a live pay link');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(b) Cash chosen in one channel → the other refuses a card charge');

test('cash chosen in My Account locks the email channel', async () => {
  const db = makeDb();
  seed(db);
  const out = await call(runChooseCash, db, CUSTOMER);
  assert.strictEqual(out.code, 200, 'the first choice must succeed');
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.payment, 'cash');
  assert.strictEqual(b.status, 'awaiting_payment', 'pending → awaiting_payment on the edge');
  // …and now the email channel's card route asks the same gate:
  const l = paymentLock(b);
  assert.ok(l.locked && !l.payable, 'the tokenised Pay Now link must now refuse');
  assert.strictEqual(l.reason, 'cash_chosen');
});

test('cash chosen via the email link locks My Account', async () => {
  const db = makeDb();
  const b0 = seed(db);
  const r = applyCashChoice(db, b0.id, { source: 'email link', ip: '1.2.3.4' });  // the shared write both channels use
  assert.ok(r.ok);
  const out = await call(runPayOptions, db, CUSTOMER);
  assert.strictEqual(out.payload.payable, false, 'My Account must not offer a card payment');
  assert.strictEqual(out.payload.can_card, false);
  assert.strictEqual(out.payload.reason, 'cash_chosen');
});

test('choosing cash twice is refused the second time, not double-recorded', async () => {
  const db = makeDb();
  seed(db);
  assert.strictEqual((await call(runChooseCash, db, CUSTOMER)).code, 200);
  const second = await call(runChooseCash, db, CUSTOMER);
  assert.strictEqual(second.code, 409);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='payment_cash_chosen'").get().c, 1,
    'the choice must be recorded once, not once per click');
});

test('the cash write is CONDITIONAL, so it can never clobber a card payment', () => {
  // The real race: a card payment lands between the lock check and the write.
  const src = read('server/pay-lock.js');
  const upd = src.slice(src.indexOf('UPDATE bookings'), src.indexOf('`).run(method'));
  assert.ok(/paid_at IS NULL/.test(upd), 'the cash UPDATE must require paid_at IS NULL');
  assert.ok(/payment <> 'card'/.test(upd), "the cash UPDATE must require payment <> 'card'");
  assert.ok(/status <> 'cancelled'/.test(upd), 'the cash UPDATE must not resurrect a cancelled booking');
  assert.ok(/changes === 0/.test(src), 'a write that changed nothing must be reported, not assumed to have worked');
});

test('applyCashChoice reports the truth when the booking is already settled', () => {
  const db = makeDb();
  const b = seed(db, { payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  const r = applyCashChoice(db, b.id, { source: 'test' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'paid');
  assert.strictEqual(db.prepare('SELECT payment FROM bookings WHERE id = 10').get().payment, 'card');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\nOwnership — paying is as scoped as everything else in My Account');

test("a customer cannot see or use another customer's pay options", async () => {
  const db = makeDb();
  seed(db);
  assert.strictEqual((await call(runPayOptions, db, STRANGER)).code, 403);
  assert.strictEqual((await call(runChooseCash, db, STRANGER)).code, 403);
  assert.strictEqual(db.prepare('SELECT payment FROM bookings WHERE id = 10').get().payment, 'pending',
    "a stranger's refused cash choice must leave the booking alone");
});

test('a booking matched only by account EMAIL is still the customer’s own to pay', async () => {
  // customer_id is NULL for every job the owner enters by hand and for anything
  // booked before the customer registered. Those trips ARE listed in My
  // Account, so a stricter rule here would show a Pay button and then refuse it
  // — the same fault the trip list and self-cancel already guard against.
  const db = makeDb();
  seed(db);
  db.prepare('UPDATE bookings SET customer_id = NULL WHERE id = 10').run();
  const mine = await call(runPayOptions, db, CUSTOMER);
  assert.strictEqual(mine.code, 200, 'the owner of the email on the booking must be able to pay it');
  assert.strictEqual(mine.payload.payable, true);
  const theirs = await call(runPayOptions, db, STRANGER);
  assert.strictEqual(theirs.code, 403, 'matching on email must not become a way in for everyone');
});

test('the pay link handed to My Account is the booking’s OWN token', async () => {
  const db = makeDb();
  seed(db);
  const out = await call(runPayOptions, db, CUSTOMER);
  assert.ok(out.payload.pay_url.indexOf('ref=WPH-PAY1') !== -1, 'the link must name this booking');
  assert.ok(out.payload.pay_url.indexOf('t=tok-abc123') !== -1,
    'the link must carry the SAME pay_token as the email — one token, one booking, one payment');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(c) Re-estimate: the owner’s fare, and money already taken is never lost');

test('re-estimate writes the OWNER’S fare, not a suggestion', async () => {
  const db = makeDb();
  seed(db, { fare: 96 });
  const out = await call(runReEstimate, db, OWNER, { fare: 152.5 });
  assert.strictEqual(out.code, 200, JSON.stringify(out.payload));
  assert.strictEqual(db.prepare('SELECT fare FROM bookings WHERE id = 10').get().fare, 152.5);
});

test('re-estimate puts the booking back to pending for the new fare', async () => {
  const db = makeDb();
  seed(db, { fare: 96, payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  await call(runReEstimate, db, OWNER, { fare: 152.5 });
  const b = db.prepare('SELECT status, payment, paid_at FROM bookings WHERE id = 10').get();
  assert.strictEqual(b.status, 'pending', 'the estimate-first ladder must run again for the new price');
  assert.strictEqual(b.payment, 'pending', 'the method is the customer’s to choose again');
  assert.strictEqual(b.paid_at, null, 'the new fare is not paid');
});

test('money already collected is FILED, not forgotten', async () => {
  const db = makeDb();
  seed(db, { fare: 96, payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  const out = await call(runReEstimate, db, OWNER, { fare: 152.5 });
  const priors = JSON.parse(db.prepare('SELECT prior_payments_json FROM bookings WHERE id = 10').get().prior_payments_json);
  assert.strictEqual(priors.length, 1, 'the payment that was cleared must be recorded');
  assert.strictEqual(priors[0].amount, 96, 'the AMOUNT already taken must survive re-pricing');
  assert.strictEqual(priors[0].method, 'card');
  assert.strictEqual(out.payload.prior_payment.amount, 96, 'and the owner must be told, so they do not charge it twice');
  const a = db.prepare("SELECT detail FROM audit_log WHERE action = 'booking_re_estimated'").get();
  assert.ok(/prior payment £96\.00/.test(a.detail), 'the audit trail must carry it too (got: ' + a.detail + ')');
});

test('re-estimate on an unpaid booking files nothing and still works', async () => {
  const db = makeDb();
  seed(db, { fare: 96 });
  const out = await call(runReEstimate, db, OWNER, { fare: 120 });
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.payload.prior_payment, null);
  assert.deepStrictEqual(JSON.parse(db.prepare('SELECT prior_payments_json FROM bookings WHERE id = 10').get().prior_payments_json), []);
});

test('re-estimate sends the ORDINARY estimate email, with working pay links', async () => {
  const db = makeDb();
  seed(db, { fare: 96 });
  sent = [];
  await call(runReEstimate, db, OWNER, { fare: 152.5 });
  assert.strictEqual(sent.length, 1, 'exactly one estimate must go out');
  const mail = sent[0];
  assert.strictEqual(mail.to, 'ben@example.com', 'it goes to the CUSTOMER, not the owner');
  assert.ok(/^Your estimate — WPH-PAY1$/.test(mail.subject),
    'it must be the ordinary estimate subject, not a bespoke one (got: ' + mail.subject + ')');
  assert.ok(/£152\.50/.test(mail.html), 'the email must quote the owner’s fare');
  // The same tokenised actions as any estimate. `&` is HTML-escaped inside the
  // href, so match the parts rather than the raw query string.
  assert.ok(/westmere-pay\.html\?ref=WPH-PAY1(&amp;|&)t=tok-abc123/.test(mail.html), 'Pay Now link must be tokenised');
  assert.ok(mail.html.indexOf('/pay/WPH-PAY1/cash?t=tok-abc123') !== -1, 'pay-your-driver link must be tokenised');
  assert.ok(mail.html.indexOf('/cancel/WPH-PAY1?t=tok-abc123') !== -1, 'cancel link must be tokenised');
});

test('re-estimate keeps an existing pay_token so a link already sent still works', async () => {
  const db = makeDb();
  seed(db, { fare: 96, pay_token: 'tok-abc123' });
  await call(runReEstimate, db, OWNER, { fare: 120 });
  assert.strictEqual(db.prepare('SELECT pay_token FROM bookings WHERE id = 10').get().pay_token, 'tok-abc123',
    're-minting would silently break the link in the customer’s inbox');
});

test('re-estimate mints a token when the card payment cleared it', async () => {
  const db = makeDb();
  seed(db, { fare: 96, payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed', pay_token: null });
  await call(runReEstimate, db, OWNER, { fare: 152.5 });
  const t = db.prepare('SELECT pay_token FROM bookings WHERE id = 10').get().pay_token;
  assert.ok(t && t.length >= 16, 'without a fresh token the new estimate would have dead pay links');
});

test('re-estimate refuses a nonsense fare and only staff may call it', async () => {
  for (const fare of [0, -5, null, 'free']) {
    const db = makeDb(); seed(db);
    assert.strictEqual((await call(runReEstimate, db, OWNER, { fare })).code, 400, 'fare ' + fare + ' must be refused');
  }
  const db = makeDb(); seed(db);
  assert.strictEqual((await call(runReEstimate, db, CUSTOMER, { fare: 200 })).code, 403,
    'a customer must never be able to set their own fare');
  assert.strictEqual(db.prepare('SELECT fare FROM bookings WHERE id = 10').get().fare, 137);
});

test('the re-priced estimate is immediately payable in BOTH channels', async () => {
  const db = makeDb();
  seed(db, { fare: 96, payment: 'card', paid_at: '2026-08-13 10:00', status: 'confirmed' });
  await call(runReEstimate, db, OWNER, { fare: 152.5 });
  const b = db.prepare('SELECT * FROM bookings WHERE id = 10').get();
  assert.ok(paymentLock(b).payable, 'the email link must work for the new fare');
  const out = await call(runPayOptions, db, CUSTOMER);
  assert.strictEqual(out.payload.payable, true, 'and so must My Account');
  assert.strictEqual(out.payload.fare, 152.5, 'both must quote the same new fare');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n(d)+(e) Accept still never charges; the customer route still cannot mutate');

test('the ACCEPT route writes no money column', () => {
  const body = extractHandler(apiSrc, 'post', '/bookings/:id/change-request/accept');
  const updates = body.match(/UPDATE\s+bookings\s+SET[\s\S]*?WHERE/gi) || [];
  for (const u of updates) {
    for (const col of ['fare', 'payment', 'paid_at', 'status']) {
      assert.ok(!new RegExp('\\b' + col + '\\s*=').test(u),
        'accepting a journey change must never write bookings.' + col + ' — the owner prices it deliberately');
    }
  }
  assert.ok(/suggestFareFor/.test(body), 'accept should SUGGEST a fare');
  assert.ok(!/sendCustomerEstimate/.test(body), 'accept must not send the estimate on its own — the owner sets the fare first');
});

test('the CUSTOMER change-request route still writes only its flag columns', () => {
  const body = extractHandler(apiSrc, 'post', '/customer/bookings/:id/change-request');
  const u = (body.match(/UPDATE\s+bookings\s+SET([\s\S]*?)WHERE/i) || [])[1] || '';
  const cols = (u.match(/(\w+)\s*=/g) || []).map(s => s.replace(/\s*=$/, '')).sort();
  assert.deepStrictEqual(cols, ['change_request_detail', 'change_request_summary', 'change_requested_at']);
});

test('neither new customer payment route writes a journey or fare column', () => {
  for (const [name, body] of [
    ['pay-options', extractHandler(apiSrc, 'get', '/customer/bookings/:id/pay-options')],
    ['choose-cash', extractHandler(apiSrc, 'post', '/customer/bookings/:id/choose-cash')]
  ]) {
    assert.ok(!/UPDATE\s+bookings/i.test(body),
      name + ' must not write to bookings directly — the only cash write is the shared, conditional one in pay-lock.js');
    for (const col of ['fare =', 'pickup =', 'destination =', 'date =', 'time =']) {
      assert.ok(body.indexOf(col) === -1, name + ' must not touch ' + col);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\nEvery entry point asks the one gate');

test('all five payment entry points go through pay-lock', () => {
  const intent = extractHandler(publicSrc, 'post', '/pay/:ref/intent');
  const cash   = extractHandler(publicSrc, 'post', '/pay/:ref/cash');
  const info   = extractHandler(publicSrc, 'get',  '/pay/:ref');
  assert.ok(/paymentLock\(/.test(intent), 'the card route must ask the gate');
  assert.ok(/applyCashChoice\(/.test(cash), 'the email cash route must use the shared write');
  assert.ok(/paymentLock\(/.test(info), 'the pay page must render from the gate');
  assert.ok(/paymentLock\(/.test(extractHandler(apiSrc, 'get', '/customer/bookings/:id/pay-options')));
  assert.ok(/applyCashChoice\(/.test(extractHandler(apiSrc, 'post', '/customer/bookings/:id/choose-cash')));
});

test('the card route also asks STRIPE, closing the webhook-delay window', () => {
  const intent = extractHandler(publicSrc, 'post', '/pay/:ref/intent');
  assert.ok(/findPaymentIntentByRef/.test(intent),
    'a payment that succeeded at Stripe but whose webhook has not landed must still block a second attempt');
  assert.ok(/findOpenPaymentIntentByRef/.test(intent),
    'a second attempt must REUSE the open intent rather than mint a rival one that could also be completed');
});

// ── The two customer-facing surfaces say the same thing ──────────────────
console.log('\nMy Account and the pay page tell the customer the same story');

test('My Account offers both options, and re-checks the server before acting', () => {
  assert.ok(/Pay by card/.test(RIDER) && /Pay my driver on the day/.test(RIDER),
    'My Account must offer the SAME two options as the email');
  assert.ok(/Change accepted — choose how you.{1,3}d like to pay/.test(RIDER),
    'an accepted change must be named as such, so the quote reads as the answer to what they asked');
  const fn = RIDER.slice(RIDER.indexOf('async function payTripByCard('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(/pay-options/.test(body),
    'the card button must re-check the live booking before opening a card form');
  assert.ok(/d\.payable/.test(body), 'and must refuse when the other channel has settled it');
});

test('My Account shows the settled states plainly instead of a pay button', () => {
  const fn = RIDER.slice(RIDER.indexOf('function _payPanel('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(/already been paid/i.test(body), 'a paid trip must say so');
  assert.ok(/paying your driver/i.test(body), 'a cash trip must say so');
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body),
    'the pay panel is reached from the trip list — it must never be able to blank it');
});

test('the pay page distinguishes "already paid" from "you chose to pay your driver"', () => {
  assert.ok(/cashChosen/.test(PAYPAGE), 'the pay page must handle the cash lock');
  assert.ok(/lockMessage/.test(PAYPAGE),
    'it must use the server’s wording so the two channels never contradict each other');
});

test('the rider trip list survives a missing pay panel', () => {
  assert.ok(/typeof _payPanel==='function'/.test(RIDER),
    'renderTrips must degrade if the panel helper is unavailable — one bad row may never blank the history');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/double-payment\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
