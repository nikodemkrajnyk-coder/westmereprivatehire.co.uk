/**
 * RE-PRICING A TRIP THE CUSTOMER HAS ALREADY PAID FOR — run with:
 *   node server/tests/fare-adjust.test.js   (also gated by `npm test`)
 *
 * THE ONE RULE
 *   Only the DIFFERENCE ever moves. A customer who paid £42 for a journey now
 *   priced at £57 owes £15 — never £57. A customer who paid £42 for a journey
 *   now priced at £30 is owed £12 back — never £30. Getting this wrong takes a
 *   customer's money twice for one trip, or hands back money that was never
 *   collected, and neither is recoverable by a test written afterwards.
 *
 * THE OTHER RULE: NOTHING MOVES BY ITSELF
 *   Saving an edit records what is outstanding and emails the customer. It does
 *   NOT refund and it does NOT charge. A refund needs the owner's deliberate
 *   press; a balance needs the customer to pay it. That is the owner's safety
 *   step and it is asserted here.
 *
 * WHAT IS PINNED
 *   1. The difference is computed against what was ACTUALLY collected, capped
 *      at it, and never exceeds it.
 *   2. Lower + card  → a Stripe refund of the difference, on the owner's click,
 *      against the original charge, ONCE. Twice is refused by the database
 *      latch AND by a Stripe idempotency key, because a double-tap on a phone
 *      is not a hypothetical.
 *   3. Lower + cash  → Stripe is NEVER called. It is flagged for the owner to
 *      settle by hand.
 *   4. Higher        → the balance only, the booking goes to awaiting_payment,
 *      the pay page and the email charge the DIFFERENCE, and the card door
 *      shuts once the customer says they will pay the driver.
 *   5. The refund email offers nothing to pay; the top-up email never shows the
 *      full new fare as the amount due.
 *   6. A Stripe failure loses neither the edit nor the truth: the booking is
 *      not marked refunded.
 *
 * Runs the SHIPPED handlers (lifted from server/api.js) and the SHIPPED email
 * template against a throwaway database, a stubbed Resend and a stubbed Stripe.
 * No network, no real money. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

process.env.RESEND_API_KEY = 'test_fake';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const apiSrc = read('server/api.js');
const pubSrc = read('server/public-api.js');
const OWNER = read('westmere-owner.html');
const EMAIL = require('../email');
const LOCK = require('../pay-lock');

// ── Pull the real handlers out of server/api.js ──────────────────────────
function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces at ' + from);
}
function extractFn(name) {
  const start = apiSrc.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'server/api.js no longer defines ' + name + '()');
  const head = apiSrc.slice(apiSrc.indexOf('(', start) + 1, apiSrc.indexOf('{', start)).trim().replace(/\)$/, '');
  return 'function ' + name + '(' + head + ') {' + braceBody(apiSrc, start) + '}';
}
function handler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  return braceBody(apiSrc, apiSrc.indexOf('=>', start));
}
const fieldsDecl = apiSrc.match(/const CUSTOMER_FIELDS = \[[\s\S]{0,300}?\];/);
assert.ok(fieldsDecl, 'server/api.js no longer declares CUSTOMER_FIELDS');
const CUSTOMER_FIELDS = new Function(fieldsDecl[0] + '; return CUSTOMER_FIELDS;')();

const runPatch = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console', 'autoFile', 'gcal',
  'sendCustomerCancellation', 'CUSTOMER_FIELDS',
  extractFn('sameCustomerValue') + '\nreturn (async () => {' + handler('patch', '/bookings/:id') + '})();'
);
const runRefund = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console',
  'return (async () => {' + handler('post', '/bookings/:id/fare-refund') + '})();'
);
const runMarkPaid = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console',
  'return (async () => {' + handler('post', '/bookings/:id/mark-paid') + '})();'
);

// ── Throwaway database, shaped like the shipped one ──────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, full_name TEXT, phone TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE, customer_id INTEGER, driver_id INTEGER,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, stop_address TEXT,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT 'ASAP',
      passengers INTEGER NOT NULL DEFAULT 1, bags TEXT NOT NULL DEFAULT '0',
      trip_type TEXT, flight TEXT, fare REAL, payment TEXT DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT,
      trip_miles REAL, paid_at TEXT, paid_amount REAL, pay_token TEXT,
      payment_intent_id TEXT, calendar_event_id TEXT, review_request_sent_at TEXT,
      refund_status TEXT, refund_amount REAL, refunded_at TEXT, refund_method TEXT,
      fare_adjust_kind TEXT, fare_adjust_amount REAL, fare_adjust_paid REAL,
      fare_adjust_at TEXT, fare_adjust_method TEXT, fare_adjust_settled_at TEXT,
      fare_adjust_ref TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT NOT NULL,
      user_id INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT, ip TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE review_emails_sent (email TEXT PRIMARY KEY);
  `);
  return db;
}

// A trip already paid for. `payment` decides whether a refund can go back
// through Stripe at all — the whole point of case B.
function seedPaid(db, over) {
  over = over || {};
  db.prepare(`INSERT INTO bookings
      (id,ref,pickup,destination,date,time,passengers,bags,flight,fare,payment,status,
       passenger_name,passenger_email,passenger_phone,paid_at,paid_amount,payment_intent_id,pay_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(10, 'WPH-ADJ1',
      '14 Queens Road, Haywards Heath, RH16 1EA', 'Gatwick Airport, South Terminal',
      '2026-09-24', '05:30', 2, '2s+1l', 'BA2431',
      over.fare === undefined ? 42 : over.fare,
      over.payment || 'card',
      over.status || 'confirmed',
      'Eleanor Whitfield', 'whitfield@example.com', '07700900123',
      over.paid_at === undefined ? '2026-08-14 09:00:00' : over.paid_at,
      over.paid_amount === undefined ? 42 : over.paid_amount,
      over.payment_intent_id === undefined ? 'pi_original_1' : over.payment_intent_id,
      'tok-live-1');
  return db.prepare('SELECT * FROM bookings WHERE id = 10').get();
}

// ── Stubbed Resend ───────────────────────────────────────────────────────
let sent = [];
global.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ id: 'test-id' }) };
};

// ── Stubbed Stripe — records every call, so "was Stripe touched?" is a fact ──
let stripeCalls = [];
let stripeFails = false;
const stripeStub = {
  isConfigured: () => true,
  findPaymentIntentByRef: async (ref) => { stripeCalls.push({ op: 'find', ref }); return 'pi_original_1'; },
  createRefund: async ({ paymentIntentId, amount, idempotencyKey }) => {
    stripeCalls.push({ op: 'refund', paymentIntentId, amount, idempotencyKey });
    if (stripeFails) throw new Error('card_declined_test');
    // A real idempotency key replays the FIRST refund rather than making a new
    // one — modelled here so a double-click cannot look like two refunds.
    const prior = stripeCalls.find(c => c.op === 'refund' && c.idempotencyKey === idempotencyKey && c.id);
    if (prior) return { id: prior.id, amount, replayed: true };
    const id = 're_' + stripeCalls.filter(c => c.op === 'refund').length;
    stripeCalls[stripeCalls.length - 1].id = id;
    return { id, amount };
  }
};

const AS_API = { './email': '../email', './intake': '../intake', './pay-lock': '../pay-lock',
                 './payment-methods': '../payment-methods', './stripe': '../stripe' };
const INTAKE_STUB = { ensurePayToken: () => 'tok-live-1', notifyCustomerConfirmed: async () => true };
const inject = (m) => {
  if (m === './intake') return INTAKE_STUB;
  if (m === './stripe') return stripeStub;
  return require(Object.prototype.hasOwnProperty.call(AS_API, m) ? AS_API[m] : m);
};
const noopAutoFile = { fileBooking() {}, updateEarnings() {} };
const noopGcal = { createEvent: () => Promise.resolve(null), updateEvent: () => Promise.resolve(true),
                   deleteEvent: () => Promise.resolve(true) };
const OWNER_AUTH = { role: 'owner', type: 'user', id: 7 };

function reply() {
  const out = { code: 200, payload: null };
  return { out, res: { status(c) { out.code = c; return this; }, json(p) { out.payload = p; return this; } } };
}
function callPatch(db, body) {
  sent = [];
  const { out, res } = reply();
  const req = { auth: OWNER_AUTH, params: { id: '10' }, body, ip: '127.0.0.1' };
  return runPatch(req, res, () => db, { broadcast() {} }, inject, console,
    noopAutoFile, noopGcal, () => Promise.resolve(true), CUSTOMER_FIELDS).then(() => out);
}
function callRefund(db, auth) {
  const { out, res } = reply();
  const req = { auth: auth || OWNER_AUTH, params: { id: '10' }, body: {}, ip: '127.0.0.1' };
  return runRefund(req, res, () => db, { broadcast() {} }, inject, console).then(() => out);
}
function callMarkPaid(db) {
  const { out, res } = reply();
  const req = { auth: OWNER_AUTH, params: { id: '10' }, body: {}, ip: '127.0.0.1' };
  return Promise.resolve(runMarkPaid(req, res, () => db, { broadcast() {} }, inject, console)).then(() => out);
}
const row = (db) => db.prepare('SELECT * FROM bookings WHERE id = 10').get();
const updateEmail = () => sent.find(m => /booking has been updated/i.test(m.subject || ''));

/* ═══════════════════════════════════════════════════════════════════════
   1. THE DIFFERENCE, AND ONLY THE DIFFERENCE
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nOnly the difference ever moves');

test('lowering the fare records a refund of exactly the difference', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  const out = await callPatch(db, { fare: 30 });
  assert.strictEqual(out.code, 200);
  assert.deepStrictEqual(out.payload.fareAdjust,
    { kind: 'refund', amount: 12, paid: 42, newFare: 30, method: 'stripe', error: false });
  const b = row(db);
  assert.strictEqual(b.fare_adjust_kind, 'refund');
  assert.strictEqual(b.fare_adjust_amount, 12, 'the recorded refund is not the difference');
  assert.strictEqual(b.fare_adjust_paid, 42, 'what was collected was not recorded');
  assert.strictEqual(b.fare_adjust_settled_at, null, 'saving must not settle anything');
});

test('raising the fare records a balance of exactly the difference — never the new fare', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  const out = await callPatch(db, { fare: 57.5 });
  assert.strictEqual(out.payload.fareAdjust.kind, 'topup');
  assert.strictEqual(out.payload.fareAdjust.amount, 15.5, 'the balance is not the difference');
  assert.notStrictEqual(out.payload.fareAdjust.amount, 57.5, 'the FULL new fare was recorded as due — double charge');
  assert.strictEqual(row(db).fare_adjust_amount, 15.5);
});

test('a fare that lands back on what was paid clears the difference', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 57.5 });
  assert.strictEqual(row(db).fare_adjust_kind, 'topup');
  const out = await callPatch(db, { fare: 42 });
  assert.strictEqual(out.payload.fareAdjust, null, 'nothing should be outstanding');
  assert.strictEqual(row(db).fare_adjust_kind, null, 'the stale balance was left open');
});

test('a NOT-prepaid booking is untouched by any of this', async () => {
  const db = makeDb(); seedPaid(db, { paid_at: null, paid_amount: null, payment: 'pending', status: 'pending' });
  const out = await callPatch(db, { fare: 30 });
  assert.strictEqual(out.payload.fareAdjust, null, 'an unpaid booking must raise no refund');
  assert.strictEqual(row(db).fare_adjust_kind, null);
  assert.ok(updateEmail(), 'it should still get the ordinary updated-details email');
});

test('a booking paid before paid_amount existed falls back to the fare it was charged', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: null });
  const out = await callPatch(db, { fare: 30 });
  assert.strictEqual(out.payload.fareAdjust.paid, 42, 'the pre-edit fare is what they were charged');
  assert.strictEqual(out.payload.fareAdjust.amount, 12);
});

test('a refund can never be recorded for more than was collected', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 0 });
  const b = row(db);
  assert.ok(b.fare_adjust_amount <= 42 + 0.005, 'recorded a refund larger than the payment');
  assert.strictEqual(b.fare_adjust_amount, 42);
});

/* ═══════════════════════════════════════════════════════════════════════
   2. NOTHING MOVES WITHOUT THE OWNER
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nSaving never moves money — the owner presses the button');

test('saving a lower fare does NOT call Stripe', async () => {
  const db = makeDb(); seedPaid(db); stripeCalls = [];
  await callPatch(db, { fare: 30 });
  assert.deepStrictEqual(stripeCalls, [], 'the save auto-refunded — it must never touch Stripe');
});

test('saving a higher fare does NOT charge anything', async () => {
  const db = makeDb(); seedPaid(db); stripeCalls = [];
  await callPatch(db, { fare: 80 });
  assert.deepStrictEqual(stripeCalls, [], 'the save auto-charged the customer');
});

test('the owner app offers a deliberate refund control, and only presses it on click', () => {
  assert.ok(/function wmAdjustOpen\(/.test(OWNER), 'the owner app has no refund panel');
  assert.ok(/function wmAdjustGo\(/.test(OWNER), 'the owner app has no refund action');
  const open = OWNER.slice(OWNER.indexOf('function wmAdjustOpen('));
  const body = open.slice(0, open.indexOf('\n}\n'));
  assert.ok(/Nothing has been refunded yet/.test(body), 'the panel does not say nothing has happened yet');
  assert.ok(/onclick="wmAdjustGo\(/.test(body), 'the refund is not behind a click');
  // The save handler opens the panel; it must not call the refund itself.
  const save = OWNER.slice(OWNER.indexOf('async function upcomingSave'));
  const saveBody = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(/wmAdjustOpen\(/.test(saveBody), 'the save never surfaces the outstanding money');
  assert.ok(!/fare-refund/.test(saveBody), 'the save calls the refund endpoint directly — no safety step');
  assert.ok(/fare-refund/.test(OWNER.slice(OWNER.indexOf('async function wmAdjustGo'))), 'the click does not call the refund route');
});

/* ═══════════════════════════════════════════════════════════════════════
   3. A: LOWER + CARD → A STRIPE REFUND OF THE DIFFERENCE, ONCE
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nLower + card: one Stripe refund of the difference');

test('the click refunds exactly the difference against the original charge', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, payment: 'card' });
  await callPatch(db, { fare: 30 });
  stripeCalls = [];
  const out = await callRefund(db);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.payload.outcome, 'refunded_stripe');
  assert.strictEqual(out.payload.amount, 12);
  const r = stripeCalls.find(c => c.op === 'refund');
  assert.ok(r, 'Stripe was never asked to refund');
  assert.strictEqual(r.amount, 1200, 'the refund was not 1200 pence (£12)');
  assert.strictEqual(r.paymentIntentId, 'pi_original_1', 'refunded against the wrong charge');
  assert.ok(r.idempotencyKey, 'the refund carries no idempotency key');
});

test('it is recorded, and what we hold drops by the refund', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 30 });
  await callRefund(db);
  const b = row(db);
  assert.ok(b.fare_adjust_settled_at, 'the refund was not latched');
  assert.strictEqual(b.fare_adjust_method, 'stripe');
  assert.ok(/^re_/.test(b.fare_adjust_ref || ''), 'the Stripe refund id was not recorded');
  assert.strictEqual(b.paid_amount, 30, 'paid_amount must drop to what we still hold');
  assert.strictEqual(b.status, 'confirmed', 'a refund must not cancel a live trip');
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'fare_refunded'").get();
  assert.ok(a && /£12\.00/.test(a.detail), 'no audit entry for the refund');
});

test('pressing twice refunds ONCE — the database latch holds', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 30 });
  stripeCalls = [];
  const first = await callRefund(db);
  const second = await callRefund(db);
  assert.strictEqual(first.payload.outcome, 'refunded_stripe');
  assert.strictEqual(second.payload.outcome, 'already_refunded', 'the second press refunded again');
  assert.strictEqual(stripeCalls.filter(c => c.op === 'refund').length, 1, 'Stripe was asked to refund twice');
  assert.strictEqual(row(db).paid_amount, 30, 'the second press took another £12 off the record');
});

test('two presses that RACE past the latch still cost one refund at Stripe', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 30 });
  stripeCalls = [];
  const [a, b] = await Promise.all([callRefund(db), callRefund(db)]);
  const refunds = stripeCalls.filter(c => c.op === 'refund');
  // Both may reach Stripe; the idempotency key must make them one refund.
  const keys = new Set(refunds.map(c => c.idempotencyKey));
  assert.strictEqual(keys.size, 1, 'racing presses used different idempotency keys — two real refunds');
  const outcomes = [a.payload.outcome, b.payload.outcome].sort();
  assert.ok(outcomes.includes('already_refunded'), 'both presses claimed to have refunded: ' + outcomes.join(','));
  assert.strictEqual(row(db).paid_amount, 30, 'the record was reduced twice');
});

test('re-pricing again mints a NEW key, so the old refund cannot settle the new difference', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 30 });
  const key1 = LOCK.adjustKey(row(db));
  await callRefund(db);
  await new Promise(r => setTimeout(r, 1100));   // datetime('now') is second-resolution
  await callPatch(db, { fare: 25 });
  const b = row(db);
  assert.strictEqual(b.fare_adjust_kind, 'refund');
  assert.strictEqual(b.fare_adjust_amount, 5, 'the second difference is £30 − £25, not £42 − £25');
  assert.notStrictEqual(LOCK.adjustKey(b), key1, 'the idempotency key was reused across two refunds');
});

test('a Stripe failure loses neither the edit nor the truth', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 30 });
  stripeFails = true;
  try {
    const out = await callRefund(db);
    assert.strictEqual(out.code, 502, 'a failed refund did not report as a failure');
    const b = row(db);
    assert.strictEqual(b.fare_adjust_settled_at, null, 'the booking claims a refund that never happened');
    assert.strictEqual(b.paid_amount, 42, 'money was written off without a refund');
    assert.strictEqual(b.fare, 30, 'the edit itself was lost');
    assert.strictEqual(b.status, 'confirmed', 'the booking was corrupted by a Stripe failure');
  } finally { stripeFails = false; }
  // …and it can still be retried afterwards.
  const retry = await callRefund(db);
  assert.strictEqual(retry.payload.outcome, 'refunded_stripe', 'the refund could not be retried');
});

test('refunding when nothing is outstanding is refused, not invented', async () => {
  const db = makeDb(); seedPaid(db);
  const out = await callRefund(db);
  assert.strictEqual(out.code, 409);
  assert.ok(/no refund outstanding/i.test(out.payload.error));
});

test('only an owner or admin may refund', async () => {
  const db = makeDb(); seedPaid(db);
  await callPatch(db, { fare: 30 });
  for (const role of ['driver', 'customer']) {
    const out = await callRefund(db, { role, type: 'user', id: 3 });
    assert.strictEqual(out.code, 403, role + ' was allowed to refund');
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   4. B: LOWER + CASH → STRIPE IS NEVER CALLED
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nLower + cash: no Stripe, flagged for the owner');

test('a cash booking records the refund as one to settle by hand', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, payment: 'cash' });
  const out = await callPatch(db, { fare: 30 });
  assert.strictEqual(out.payload.fareAdjust.kind, 'refund');
  assert.strictEqual(out.payload.fareAdjust.amount, 12);
  assert.strictEqual(out.payload.fareAdjust.method, 'cash', 'a cash refund must not be marked for Stripe');
});

test('settling a cash refund NEVER calls Stripe', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, payment: 'cash' });
  await callPatch(db, { fare: 30 });
  stripeCalls = [];
  const out = await callRefund(db);
  assert.strictEqual(out.payload.outcome, 'refunded_manual');
  assert.strictEqual(out.payload.method, 'cash');
  assert.deepStrictEqual(stripeCalls, [], 'Stripe was called for a cash refund');
  assert.ok(/by hand/i.test(out.payload.message), 'the owner is not told to return it by hand');
  const b = row(db);
  assert.strictEqual(b.fare_adjust_method, 'cash');
  assert.strictEqual(b.paid_amount, 30);
});

test('the owner panel says plainly there is no card to refund against', () => {
  const open = OWNER.slice(OWNER.indexOf('function wmAdjustOpen('));
  const body = open.slice(0, open.indexOf('\n}\n'));
  assert.ok(/no card charge to refund against/i.test(body), 'the cash case is not explained to the owner');
  assert.ok(/returned by hand/i.test(body), 'the owner is not told to return it by hand');
});

/* ═══════════════════════════════════════════════════════════════════════
   5. C: HIGHER → THEY OWE THE BALANCE, NOT THE FARE
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nHigher: the balance only, and the booking waits for it');

test('the trip moves to awaiting_payment until the balance is settled', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, status: 'confirmed' });
  await callPatch(db, { fare: 57.5 });
  assert.strictEqual(row(db).status, 'awaiting_payment', 'a re-priced trip must wait for the balance');
});

test('the pay lock offers the DIFFERENCE, not the fare', () => {
  const b = { ref: 'WPH-ADJ1', status: 'awaiting_payment', payment: 'card', fare: 57.5,
              paid_at: '2026-08-14 09:00:00',
              fare_adjust_kind: 'topup', fare_adjust_amount: 15.5, fare_adjust_paid: 42,
              fare_adjust_at: '2026-08-16 10:00:00', fare_adjust_settled_at: null };
  const l = LOCK.paymentLock(b);
  assert.strictEqual(l.locked, false, 'a booking owing a balance must not be locked as paid');
  assert.strictEqual(l.payable, true);
  assert.strictEqual(l.reason, 'top_up');
  assert.strictEqual(l.amountDue, 15.5, 'the lock offers the wrong amount');
  assert.notStrictEqual(l.amountDue, 57.5, 'the lock would charge the full fare again');
  assert.ok(l.adjustKey, 'the lock carries no adjustment key for idempotency');
});

test('the intent route charges lock.amountDue, never the fare', () => {
  const start = pubSrc.indexOf("router.post('/pay/:ref/intent'");
  const rest = pubSrc.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  const block = pubSrc.slice(start, start + 10 + (next === -1 ? rest.length : next));
  assert.ok(/Math\.round\(Number\(lock\.amountDue\) \* 100\)/.test(block),
    'the intent route no longer charges the amount the lock decided');
  assert.ok(!/Math\.round\(Number\(b\.fare\) \* 100\)/.test(block),
    'the intent route still charges the raw fare — a prepaid customer would pay twice');
  assert.ok(/adjust_key/.test(block), 'the top-up intent carries no adjustment key');
});

test('the pay page can SEE the balance — it reads the adjust columns', () => {
  const start = pubSrc.indexOf("router.get('/pay/:ref'");
  const rest = pubSrc.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  const block = pubSrc.slice(start, start + 10 + (next === -1 ? rest.length : next));
  // Without these columns the lock sees paid_at, reports 'paid', and the Pay
  // button we emailed the customer lands on "this trip has already been paid".
  for (const col of ['fare_adjust_kind', 'fare_adjust_amount', 'fare_adjust_paid',
                     'fare_adjust_at', 'fare_adjust_method', 'fare_adjust_settled_at']) {
    assert.ok(block.includes(col), 'GET /pay/:ref does not select ' + col + ' — a balance would read as fully paid');
  }
  assert.ok(/amountDue: lock\.amountDue/.test(block), 'the pay page is not told what is actually due');
});

test('the pay page DISPLAYS and charges the same figure the server will take', () => {
  const page = read('westmere-pay.html');
  assert.ok(/booking\.amountDue != null/.test(page), 'the pay page still quotes the raw fare');
  // The wallet, the button label and the amount line must all agree with the
  // server. Showing £57.50 while taking £15.50 reads as a fault even when the
  // smaller number is the correct one.
  assert.ok(!/var amount = Math\.round\(Number\(booking\.fare\) \* 100\)/.test(page),
    'Apple/Google Pay would ask for the full fare on a re-priced trip');
  assert.ok(!/fmtMoney\(booking\.fare\)\s*;?\s*$/m.test(page.replace(/d-fare[\s\S]{0,40}/g, '')) ||
            /"Pay " \+ fmtMoney\(booking\.amountDue/.test(page),
    'a Pay button still names the full fare');
  assert.ok(/d-due-row/.test(page) && /d-paid-row/.test(page),
    'the page has nowhere to show what was already paid and what is now due');
});

test('My Account is told the balance too, not just the fare', () => {
  const start = apiSrc.indexOf("router.get('/customer/bookings/:id/pay-options'");
  assert.ok(start !== -1, 'the pay-options route is gone');
  const block = apiSrc.slice(start, start + 2000);
  assert.ok(/amountDue: lock\.amountDue/.test(block), 'My Account would quote the full new fare');
});

test('a settled balance closes, once, however often Stripe replays the webhook', () => {
  const start = pubSrc.indexOf("router.post('/stripe-webhook'");
  const block = pubSrc.slice(start, start + 6000);
  assert.ok(/metadata\.topup === '1'/.test(block), 'the webhook cannot tell a balance payment apart');
  assert.ok(/fare_adjust_settled_at IS NULL/.test(block), 'the webhook would bank a replayed balance twice');
  assert.ok(/paid_amount = COALESCE\(paid_amount, 0\) \+ \?/.test(block), 'the balance is not added to what we hold');
});

test('once they choose to pay the driver, the card door shuts', () => {
  const b = { ref: 'WPH-ADJ1', status: 'awaiting_payment', payment: 'card', fare: 57.5,
              paid_at: '2026-08-14 09:00:00',
              fare_adjust_kind: 'topup', fare_adjust_amount: 15.5, fare_adjust_paid: 42,
              fare_adjust_at: '2026-08-16 10:00:00', fare_adjust_method: 'cash',
              fare_adjust_settled_at: null };
  const l = LOCK.paymentLock(b);
  assert.strictEqual(l.locked, true, 'a card charge is still open after they chose cash');
  assert.strictEqual(l.reason, 'cash_chosen');
});

test('choosing cash for the balance does NOT rewrite how they originally paid', () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, payment: 'card', status: 'awaiting_payment' });
  db.prepare(`UPDATE bookings SET fare_adjust_kind='topup', fare_adjust_amount=15.5,
              fare_adjust_paid=42, fare_adjust_at=datetime('now'), fare=57.5 WHERE id=10`).run();
  const r = LOCK.applyCashChoice(db, 10, { source: 'test' });
  assert.strictEqual(r.ok, true, 'the customer could not choose to pay the driver');
  const b = row(db);
  assert.strictEqual(b.payment, 'card', 'the record of the original CARD payment was overwritten with cash');
  assert.ok(b.paid_at, 'the original payment was erased');
  assert.strictEqual(b.fare_adjust_method, 'cash');
  assert.strictEqual(b.fare_adjust_settled_at, null, 'the balance was settled without anyone paying it');
});

test('mark-as-paid settles the balance once, and adds it to what we hold', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42, status: 'confirmed' });
  await callPatch(db, { fare: 57.5 });
  await callMarkPaid(db);
  let b = row(db);
  assert.ok(b.fare_adjust_settled_at, 'the balance was not settled');
  assert.strictEqual(b.paid_amount, 57.5, 'what we hold did not go up by the balance');
  assert.strictEqual(b.status, 'confirmed');
  await callMarkPaid(db);
  b = row(db);
  assert.strictEqual(b.paid_amount, 57.5, 'a second mark-as-paid banked the balance twice');
});

/* ═══════════════════════════════════════════════════════════════════════
   6. WHAT THE CUSTOMER IS SHOWN
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nThe emails: a refund offers nothing to pay, a balance never quotes the fare');

const BOOKING = {
  ref: 'WPH-ADJ1', name: 'Eleanor Whitfield', email: 'whitfield@example.com',
  pickup: '14 Queens Road, Haywards Heath, RH16 1EA', destination: 'Gatwick Airport, South Terminal',
  date: '2026-09-24', time: '05:30', passengers: 2, bags: '2s+1l', flight: 'BA2431',
  paid_at: '2026-08-14 09:00:00', payment: 'card', pay_token: 'tok-live-1'
};
async function render(fare, adjust) {
  sent = [];
  await EMAIL.sendCustomerBookingUpdated(Object.assign({}, BOOKING, { fare }),
    [{ key: 'fare', from: 42, to: fare }], adjust);
  return (sent[0] || {}).html || '';
}

test('the REFUND email promises the refund and offers nothing to pay', async () => {
  const html = await render(30, { kind: 'refund', amount: 12, paid: 42, method: 'stripe' });
  assert.ok(/refund of <strong>£12\.00<\/strong>/.test(html), 'the refund amount is not stated');
  assert.ok(/issued to the card you paid with/i.test(html), 'it does not say where the refund goes');
  assert.ok(!/Pay Now/i.test(html), 'a customer owed money was shown a Pay Now button');
  assert.ok(!/Pay Your Driver/i.test(html), 'a paid customer was offered a payment option');
  assert.ok(/£30\.00/.test(html), 'the new fare is missing');
  assert.ok(/£42\.00/.test(html), 'the old fare is missing from the diff');
});

test('the CASH refund email does not promise a card refund that cannot happen', async () => {
  const html = await render(30, { kind: 'refund', amount: 12, paid: 42, method: 'cash' });
  assert.ok(/£12\.00/.test(html), 'the amount owed back is missing');
  assert.ok(!/issued to the card/i.test(html), 'a cash customer was promised a card refund');
  assert.ok(/return it to you directly/i.test(html), 'it does not say how they get their money');
  assert.ok(!/Pay Now/i.test(html), 'a Pay Now button on a refund email');
});

test('the TOP-UP email charges the difference and says so twice over', async () => {
  const html = await render(57.5, { kind: 'topup', amount: 15.5, paid: 42 });
  assert.ok(/£15\.50/.test(html), 'the balance is missing');
  assert.ok(/Already paid/i.test(html) && /£42\.00/.test(html), 'what they already paid is not shown');
  assert.ok(/Now due/i.test(html), 'the amount now due is not labelled');
  assert.ok(/not be charged the full fare/i.test(html), 'it does not reassure them about double charging');
  assert.ok(/Pay £15\.50 Now/.test(html), 'the pay button does not name the difference');
  assert.ok(/Pay The Difference To Your Driver/.test(html), 'no cash option for the difference');
});

test('the TOP-UP email never presents the full new fare as the amount to pay', async () => {
  const html = await render(57.5, { kind: 'topup', amount: 15.5, paid: 42 });
  const btn = html.slice(html.indexOf('Pay '), html.indexOf('Pay ') + 300);
  assert.ok(!/Pay £57\.50/.test(html), 'the button asks for the whole new fare again');
  assert.ok(!/Pay <strong[^>]*>£57\.50/.test(html), 'the caption asks for the whole new fare again');
  assert.ok(btn.length > 0);
});

test('both money emails keep the house style — framed, no gold, no green, no fills', async () => {
  for (const [fare, adj] of [[30, { kind: 'refund', amount: 12, paid: 42, method: 'stripe' }],
                             [57.5, { kind: 'topup', amount: 15.5, paid: 42 }]]) {
    const html = await render(fare, adj);
    assert.ok(!/#b78635|#c9a227|#d4af37|#25D366|#2D6E47|goldenrod/i.test(html), 'gold or green in a money email');
    for (const m of html.matchAll(/<td[^>]*style="([^"]*border:\d+px solid[^"]*)"[^>]*>\s*<a\b/g)) {
      assert.ok(/background-color:#ffffff/i.test(m[1]), 'a button cell is filled: ' + m[1].slice(0, 80));
    }
    for (const m of html.matchAll(/<a\b[^>]*style="([^"]*)"/g)) {
      const bg = /background(?:-color)?:\s*([^;"]+)/i.exec(m[1]);
      if (bg) assert.ok(/^(transparent|none|#fff|#ffffff|white)$/i.test(bg[1].trim()), 'a filled link: ' + bg[1]);
    }
    assert.ok(/font-family:Cormorant/.test(html), 'not set in Cormorant');
  }
});

test('the whole path end-to-end: save lower → email promises the refund', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  const out = await callPatch(db, { fare: 30 });
  assert.strictEqual(out.payload.customerNotified, true, 'the customer was not told');
  const m = updateEmail();
  assert.ok(m, 'no email was sent');
  assert.ok(/refund of £12\.00/i.test(m.text || ''), 'the refund is not in the plain-text part');
  assert.ok(!/Pay Now/i.test(m.html), 'the end-to-end refund email still offers to take money');
});

test('the whole path end-to-end: save higher → email asks only for the difference', async () => {
  const db = makeDb(); seedPaid(db, { fare: 42, paid_amount: 42 });
  await callPatch(db, { fare: 57.5 });
  const m = updateEmail();
  assert.ok(m, 'no email was sent');
  assert.ok(/£15\.50/.test(m.html), 'the difference is missing from the email');
  assert.ok(!/Pay £57\.50/.test(m.html), 'the end-to-end email asks for the full fare');
});

// ── Run ──────────────────────────────────────────────────────────────────
(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
