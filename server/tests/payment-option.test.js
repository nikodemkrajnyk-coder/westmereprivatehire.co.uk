/**
 * CHANGING THE PAYMENT OPTION, AND THE REMINDER THAT FOLLOWS — run with:
 *   node server/tests/payment-option.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   A customer chose "pay your driver" when he meant to pay by card. That choice
 *   is a LOCK (server/pay-lock.js): it shuts the card door so two channels can
 *   never charge one fare. The lock was correct and one-way — there was no route
 *   back — so the owner sent a payment reminder instead, and the reminder mailed
 *   a Pay Now button to a customer whose booking would refuse the payment. The
 *   button was real, the link was valid, and it could not work.
 *
 *   Two things are fixed here and both are pinned below. The owner can reopen
 *   the payment option from Edit, and the reminder refuses to send a card button
 *   into a booking that cannot take one.
 *
 * WHAT IS PINNED
 *   1. Reopening clears the cash lock and makes the booking payable again.
 *   2. Reopening moves confirmed/active → awaiting_payment, which the owner app
 *      labels "To be confirmed" while no method is chosen.
 *   3. A CARD-CAPTURED booking is refused outright — no confirm flag opens it,
 *      because reopening it is the double-charge path.
 *   4. A CASH-marked-paid booking needs an explicit confirm, and un-settles only
 *      when that confirm is given.
 *   5. The reminder in the reopened state renders BOTH options and a working
 *      tokenised link to each.
 *   6. The reminder is NEVER sent into a cash-locked booking.
 *   7. A booking with no pay_token gets one minted, so the button always works.
 *   8. 'card' can never be set by hand — only the Stripe webhook writes it.
 *
 * Runs the SHIPPED handlers (lifted out of server/api.js) and the SHIPPED email
 * template against a throwaway database and a stubbed Resend. No network.
 * Exit 1 on failure.
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
const OWNER = read('westmere-owner.html');
const LIFECYCLE = require('../../wm-lifecycle.js');

// ── Pull the real handlers out of server/api.js ──────────────────────────
function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces at ' + from);
}
function handler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  return braceBody(apiSrc, apiSrc.indexOf('=>', start));
}
const runOption = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console',
  'return (async () => {' + handler('post', '/bookings/:id/payment-option') + '})();'
);
const runReminder = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console',
  'return (async () => {' + handler('post', '/bookings/:id/payment-reminder') + '})();'
);

// ── Throwaway database ───────────────────────────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, full_name TEXT, phone TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE, customer_id INTEGER,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, stop_address TEXT,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT 'ASAP',
      fare REAL, payment TEXT DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT,
      paid_at TEXT, pay_token TEXT, payment_intent_id TEXT,
      fare_adjust_kind TEXT, fare_adjust_amount REAL, fare_adjust_paid REAL,
      fare_adjust_at TEXT, fare_adjust_method TEXT, fare_adjust_settled_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_id INTEGER,
      action TEXT, detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  return db;
}
function seed(db, o) {
  db.prepare(`INSERT INTO bookings (ref, pickup, destination, date, time, fare, payment, status,
              passenger_name, passenger_email, paid_at, pay_token, payment_intent_id)
              VALUES (@ref,@pickup,@destination,@date,@time,@fare,@payment,@status,
                      @passenger_name,@passenger_email,@paid_at,@pay_token,@payment_intent_id)`)
    .run(Object.assign({
      ref: 'WPH-T1', pickup: 'Eastbourne', destination: 'Gatwick', date: '2026-09-01', time: '09:00',
      fare: 129, payment: 'pending', status: 'pending', passenger_name: 'Mr Ben Chan',
      passenger_email: 'ben@example.com', paid_at: null, pay_token: 'tok123', payment_intent_id: null
    }, o));
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(o && o.ref ? o.ref : 'WPH-T1');
}
const rowOf = (db, id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

function mkRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const AUTH = { role: 'owner', id: 1, type: 'user' };
const NOOP_EVENTS = { broadcast() {} };

// The shipped modules the handlers reach for, with Resend stubbed.
let SENT = [];
function fakeRequire(db) {
  return (m) => {
    if (m === './email') {
      const email = require('../email');
      return email;
    }
    if (m === './pay-lock') return require('../pay-lock');
    if (m === './payment-methods') return require('../payment-methods');
    if (m === './intake') {
      // The real ensurePayToken, pointed at the throwaway db.
      const intake = require('../intake');
      return { ensurePayToken: (id) => intake.ensurePayToken(id, db) };
    }
    return require(m);
  };
}
global.fetch = async (u, o) => {
  SENT.push(JSON.parse(o.body));
  return { ok: true, status: 200, json: async () => ({ id: 'rid' }) };
};

async function callOption(db, id, body) {
  const res = mkRes();
  await runOption({ params: { id: String(id) }, body: body || {}, auth: AUTH, ip: '1.1.1.1' },
    res, () => db, NOOP_EVENTS, fakeRequire(db), console);
  return res;
}
async function callReminder(db, id) {
  SENT = [];
  const res = mkRes();
  await runReminder({ params: { id: String(id) }, body: {}, auth: AUTH, ip: '1.1.1.1' },
    res, () => db, NOOP_EVENTS, fakeRequire(db), console);
  return res;
}

console.log('\nPayment option — reopening a wrong choice');

// ── 1 + 2. THE MAIN CASE ─────────────────────────────────────────────────
test('reopening a cash-locked CONFIRMED booking unlocks it and moves it to awaiting_payment', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'confirmed' });
  const { paymentLock } = require('../pay-lock');
  assert.strictEqual(paymentLock(b).payable, false, 'precondition: cash-locked is not payable');

  const res = await callOption(db, b.id, { payment: 'pending' });
  assert.strictEqual(res.statusCode, 200, 'reopen must succeed: ' + JSON.stringify(res.body));
  const after = rowOf(db, b.id);
  assert.strictEqual(after.payment, 'pending', 'the cash lock must be cleared');
  assert.strictEqual(after.status, 'awaiting_payment', 'confirmed must drop back to awaiting_payment');
  const lock = paymentLock(after);
  assert.strictEqual(lock.payable, true, 'the booking must be payable again');
  assert.strictEqual(lock.locked, false, 'no lock reason may remain');
  assert.strictEqual(Number(lock.amountDue), 129, 'the full fare is due again');
});

test('the owner app labels that state "To be confirmed", not "Awaiting payment"', () => {
  assert.strictEqual(LIFECYCLE.statusLabel({ status: 'awaiting_payment', payment: 'pending' }).label,
    'To be confirmed', 'a reopened booking reads "To be confirmed"');
  assert.strictEqual(LIFECYCLE.statusLabel({ status: 'awaiting_payment', payment: null }).label,
    'To be confirmed', 'no method chosen also reads "To be confirmed"');
  // Not a blanket rename: a cash job really IS awaiting the money.
  assert.strictEqual(LIFECYCLE.statusLabel({ status: 'awaiting_payment', payment: 'cash' }).label,
    'Awaiting payment', 'a cash booking must keep the accurate "Awaiting payment"');
});

test('an active job also reopens; a pending one keeps its earlier status', async () => {
  const db = makeDb();
  const a = seed(db, { ref: 'WPH-A', payment: 'cash', status: 'active' });
  await callOption(db, a.id, { payment: 'pending' });
  assert.strictEqual(rowOf(db, a.id).status, 'awaiting_payment', 'active → awaiting_payment');

  const p = seed(db, { ref: 'WPH-P', payment: 'cash', status: 'pending' });
  await callOption(db, p.id, { payment: 'pending' });
  assert.strictEqual(rowOf(db, p.id).status, 'pending', 'pending must not be pushed forward');
});

test('the owner can also set cash directly', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'pending', status: 'pending' });
  const res = await callOption(db, b.id, { payment: 'cash' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rowOf(db, b.id).payment, 'cash');
});

// ── 3 + 4. THE SAFEGUARDS ────────────────────────────────────────────────
test('a CARD-CAPTURED booking is refused outright — no confirm opens it', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'card', status: 'confirmed', paid_at: '2026-08-20 10:00', payment_intent_id: 'pi_1' });

  const plain = await callOption(db, b.id, { payment: 'pending' });
  assert.strictEqual(plain.statusCode, 409, 'must refuse');
  assert.strictEqual(plain.body.reason, 'card_paid');
  assert.strictEqual(plain.body.blocked, true);

  // The important half: confirm:true must NOT be a way through.
  const forced = await callOption(db, b.id, { payment: 'pending', confirm: true });
  assert.strictEqual(forced.statusCode, 409, 'confirm:true must NOT override a captured card payment');
  assert.strictEqual(forced.body.reason, 'card_paid');

  const after = rowOf(db, b.id);
  assert.strictEqual(after.payment, 'card', 'the card record must survive untouched');
  assert.strictEqual(after.paid_at, '2026-08-20 10:00', 'paid_at must survive untouched');
  assert.strictEqual(after.status, 'confirmed', 'status must survive untouched');
});

test('a payment_intent_id alone is enough to block, even if payment says cash', async () => {
  // Defence in depth: a Stripe charge exists, whatever the payment column says.
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'confirmed', payment_intent_id: 'pi_2' });
  const res = await callOption(db, b.id, { payment: 'pending' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.reason, 'card_paid');
});

test('a CASH-marked-paid booking needs an explicit confirm, then un-settles', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'confirmed', paid_at: '2026-08-20 10:00' });

  const first = await callOption(db, b.id, { payment: 'pending' });
  assert.strictEqual(first.statusCode, 409, 'must ask first');
  assert.strictEqual(first.body.reason, 'needs_confirm');
  assert.strictEqual(first.body.needsConfirm, true);
  assert.strictEqual(rowOf(db, b.id).paid_at, '2026-08-20 10:00', 'nothing may change on the refusal');

  const second = await callOption(db, b.id, { payment: 'pending', confirm: true });
  assert.strictEqual(second.statusCode, 200, 'confirmed reopen must succeed');
  const after = rowOf(db, b.id);
  assert.strictEqual(after.paid_at, null, 'the cash settlement must be cleared');
  assert.strictEqual(after.payment, 'pending');
  assert.strictEqual(after.status, 'awaiting_payment');
});

// ── 8. 'card' IS NOT SETTABLE BY HAND ────────────────────────────────────
test('"card" and anything else are rejected — only the webhook writes card', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'confirmed' });
  for (const bad of ['card', 'account', 'invoice', 'paid', '', 'CASH ']) {
    const res = await callOption(db, b.id, { payment: bad });
    assert.strictEqual(res.statusCode, 400, 'payment="' + bad + '" must be rejected');
  }
  assert.strictEqual(rowOf(db, b.id).payment, 'cash', 'nothing may have changed');
});

test('a cancelled booking cannot have its payment reopened', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'cancelled' });
  const res = await callOption(db, b.id, { payment: 'pending' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.reason, 'cancelled');
});

// ── 5 + 6 + 7. THE REMINDER ──────────────────────────────────────────────
console.log('\nPayment reminder — both doors, or no email at all');

test('in the reopened state the reminder renders BOTH options with working links', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'pending', status: 'awaiting_payment' });
  const res = await callReminder(db, b.id);
  assert.strictEqual(res.statusCode, 200, 'must send: ' + JSON.stringify(res.body));
  assert.strictEqual(SENT.length, 1, 'exactly one email');
  const html = SENT[0].html;

  const payUrl = 'https://westmereprivatehire.co.uk/westmere-pay.html?ref=WPH-T1&t=tok123';
  const cashUrl = 'https://westmereprivatehire.co.uk/api/public/pay/WPH-T1/cash?t=tok123';
  assert.ok(html.includes(payUrl), 'the card link must be present and tokenised');
  assert.ok(html.includes(cashUrl), 'the CASH link must be present and tokenised');
  assert.ok(/Card, Apple Pay or Google Pay/.test(html), 'the card button must be labelled');
  assert.ok(/Pay Your Driver On The Day/i.test(html), 'the cash option must be offered in words');
  assert.ok(html.includes('£129.00'), 'the amount must be named');
});

test('the reminder is NEVER sent into a cash-locked booking', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'cash', status: 'awaiting_payment' });
  const res = await callReminder(db, b.id);
  assert.strictEqual(res.statusCode, 409, 'must refuse rather than mail a dead button');
  assert.strictEqual(res.body.reason, 'cash_chosen');
  assert.strictEqual(SENT.length, 0, 'NOTHING may be emailed');
  assert.ok(/To be confirmed/.test(res.body.error),
    'the refusal must tell the owner how to fix it');
});

test('an already-paid booking is refused too', async () => {
  const db = makeDb();
  const paid = seed(db, { ref: 'WPH-PD', payment: 'card', status: 'confirmed', paid_at: '2026-08-20 10:00' });
  const res = await callReminder(db, paid.id);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.reason, 'paid');
  assert.strictEqual(SENT.length, 0);
});

test('a booking with no fare is refused rather than chased for nothing', async () => {
  const db = makeDb();
  const b = seed(db, { fare: null, payment: 'pending', status: 'pending' });
  const res = await callReminder(db, b.id);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(SENT.length, 0);
});

test('a missing pay_token is MINTED, so the buttons always work', async () => {
  const db = makeDb();
  const b = seed(db, { payment: 'pending', status: 'awaiting_payment', pay_token: null });
  const res = await callReminder(db, b.id);
  assert.strictEqual(res.statusCode, 200, 'must send: ' + JSON.stringify(res.body));
  const token = rowOf(db, b.id).pay_token;
  assert.ok(token && token.length >= 16, 'a token must have been minted, got ' + JSON.stringify(token));
  assert.ok(SENT[0].html.includes('t=' + token), 'the email must carry the freshly minted token');
});

// ── The owner app wiring ─────────────────────────────────────────────────
console.log('\nOwner app — the control and how it saves');

test('the edit form has the payment control with both settable values', () => {
  assert.ok(/id="eb-payment"/.test(OWNER), 'the edit form must carry #eb-payment');
  assert.ok(/<option value="pending">To be confirmed/.test(OWNER), 'the reopen option must be offered');
  assert.ok(/<option value="cash">Pay driver/.test(OWNER), 'cash must be offered');
  assert.ok(!/<option value="card"/.test(OWNER),
    'a hard-coded "card" option must NOT exist — only the Stripe webhook writes card');
});

test('the payment change goes through its own endpoint, never the generic PATCH', () => {
  // PATCH would move `payment` with no lock check and no safeguard at all.
  assert.ok(/\/payment-option'/.test(OWNER) || /payment-option/.test(OWNER),
    'the owner app must call the payment-option endpoint');
  const collect = OWNER.slice(OWNER.indexOf('function ebCollectBody'));
  const body = collect.slice(0, collect.indexOf('\n  }'));
  assert.ok(!/body\.payment\s*=/.test(body),
    'ebCollectBody must NOT put `payment` in the PATCH body');
});

test('the owner is asked before a settled booking is un-settled', () => {
  assert.ok(/needsConfirm/.test(OWNER), 'the app must handle the needs_confirm answer');
  assert.ok(/confirm\(d\.error\)/.test(OWNER), 'and put the question to the owner');
  assert.ok(/if\(!\(await ebApplyPaymentOption\(id\)\)\)return;/.test(OWNER),
    'a cancelled confirm must abort the whole save, not just the payment part');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/payment-option\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
