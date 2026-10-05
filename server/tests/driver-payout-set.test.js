/**
 * THE AMOUNT THE OWNER AGREED WITH THE DRIVER — run with:
 *   node server/tests/driver-payout-set.test.js   (also gated by `npm test`)
 *
 * Passing a job is a conversation, not a formula. The rate answers most of
 * them — and the send sheet still opens with that answer already filled in, so
 * the ordinary job is one tap. But sometimes the two of them settle on a
 * number instead: a long one, a favour returned, a driver who will not do it
 * for the ten per cent. The owner asked to be able to type that number.
 *
 * WHATEVER HE SETS IS THE PAYOUT. Not a hint, not a starting point: it is the
 * figure in the driver's email, on his statement, in his balance, and in the
 * week's transfer. Everything downstream already reads the ledger, so the job
 * of this guard is to prove that the ledger itself changed — and that it
 * changed for nothing else.
 *
 * THREE THINGS THAT WOULD BREAK THE BOOKS, each pinned below:
 *
 *   1. AN AGREED FIGURE MUST NOT BE ERODED BY THE CARD FEE. The fee normally
 *      comes off the driver's side, which is the owner's own earlier rule. An
 *      agreed number is one he has given a man; Stripe's cut turning up three
 *      days later is the firm's problem, not a quiet £3 off what was promised.
 *
 *   2. COMMISSION + PAYOUT MUST STILL EQUAL THE FARE. The turnover SQL knows
 *      nothing about any of this — it reads admin_fee — so the route stores
 *      whatever is LEFT of the fare there. If that ever drifts, the dashboard
 *      and the ledger start telling two different stories about the same job.
 *
 *   3. MORE THAN THE FARE IS REFUSED. Not because it is unthinkable, but
 *      because £950 typed into a £95 job looks exactly like it and would ride
 *      straight into the weekly transfer.
 *
 * AND NOTHING CHANGES WHEN HE DOES NOT TYPE ONE: the no-override cases below
 * are the same arithmetic this system had before the field existed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-payoutset-' + process.pid + '.db');
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
const ledger = require('../driver-ledger');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let seq = 0;
function seedDriver(pct) {
  return db.prepare(`INSERT INTO users (username,password,role,full_name,email,active,has_login,commission_pct)
                     VALUES (?, '', 'driver', ?, ?, 1, 0, ?)`)
    .run('ps' + (++seq) + Date.now().toString(36), 'Set Driver ' + seq,
         'ps' + seq + '@example.com', pct === undefined ? 10 : pct).lastInsertRowid;
}
function seedBooking(over) {
  const o = Object.assign({ fare: 100, payment: 'card', date: '2026-10-09' }, over || {});
  const ref = 'WPH-S' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES (?,?,?,?,?,1,?,?,'confirmed')`)
    .run(ref, 'Steyning', 'Gatwick', o.date, '07:00', o.fare, o.payment);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

// The real route, over a real socket — not a hand-rolled stand-in.
let srv, base;
function startServer() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((q, _r, n) => { q.auth = { id: 1, role: 'owner', type: 'user' }; n(); });
  app.use('/api', require('../offer-routes'));
  srv = app.listen(0);
  base = 'http://127.0.0.1:' + srv.address().port;
}
const dispatch = (id, body) => fetch(base + '/api/bookings/' + id + '/dispatch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

// ── 1. THE LEDGER TAKES THE AGREED FIGURE ─────────────────────────────────
console.log('\nWhatever he sets is the payout');

test('a set amount is the payout, and the card fee does not touch it', () => {
  const agreed = { fare: 100, payment: 'card', admin_fee: 30, driver_pay: 70,
                   driver_payout_set: 70, card_received: 97, passed_at: 'x' };
  const s = ledger.jobSplit(agreed);
  assert.strictEqual(s.payout, 70, 'the agreed figure was eroded by the card fee');
  assert.strictEqual(s.payout_set, true, 'the split does not say the figure was set');
  assert.strictEqual(s.card_fee, 3, 'the fee is still REPORTED — it is a fact about the job');
  assert.strictEqual(ledger.balanceDelta(agreed), 70, 'his balance does not follow the agreed figure');
});

test('…and without one, every case is exactly what it was before', () => {
  const cases = [
    [{ fare: 100, payment: 'card', admin_fee: 10, driver_pay: 90, passed_at: 'x' }, 90, 90, 10],
    [{ fare: 100, payment: 'card', admin_fee: 10, driver_pay: 90, card_received: 97, passed_at: 'x' }, 87, 87, 10],
    [{ fare: 100, payment: 'cash', admin_fee: 10, driver_pay: 90, passed_at: 'x' }, 90, -10, 10],
    [{ fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, passed_at: 'x' }, 96, 96, 0]
  ];
  for (const [b, payout, delta, income] of cases) {
    const s = ledger.jobSplit(b);
    assert.strictEqual(s.payout, payout, JSON.stringify(b) + ' payout');
    assert.strictEqual(s.payout_set, false, 'nothing was set, yet the split says otherwise');
    assert.strictEqual(ledger.balanceDelta(b), delta, JSON.stringify(b) + ' delta');
    assert.strictEqual(ledger.westmereIncome(b), income, JSON.stringify(b) + ' income');
  }
});

test('a cash job: he holds the fare, so he owes back whatever is not his', () => {
  const b = { fare: 100, payment: 'cash', admin_fee: 30, driver_pay: 70,
              driver_payout_set: 70, passed_at: 'x' };
  assert.strictEqual(ledger.balanceDelta(b), -30,
    'he collected £100 and was to keep £70 — £30 comes back, not £10');
});

test('rubbish in the column is ignored rather than believed', () => {
  for (const v of [null, undefined, '', 'abc', NaN, -5]) {
    const b = { fare: 100, payment: 'card', admin_fee: 10, driver_pay: 90, driver_payout_set: v, passed_at: 'x' };
    assert.strictEqual(ledger.jobSplit(b).payout, 90, 'a payout of ' + String(v) + ' was taken seriously');
  }
  // Zero IS a real answer — a cover job the other way round.
  const nil = { fare: 100, payment: 'card', admin_fee: 100, driver_pay: 0, driver_payout_set: 0, passed_at: 'x' };
  assert.strictEqual(ledger.jobSplit(nil).payout, 0, 'nothing is a figure he is allowed to set');
  assert.strictEqual(ledger.jobSplit(nil).payout_set, true);
});

// ── 2. THROUGH THE ROUTE, WHICH IS WHERE IT IS STORED ─────────────────────
console.log('\nThe send sheet writes it three ways, and they agree');

test('the route stores the figure, the pay and the leftover commission', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  const r = await dispatch(b.id, { driver_id: d, driver_payout: 70 });
  assert.strictEqual(r.status, 200, await r.text());
  const row = rowOf(b.id);
  assert.strictEqual(row.driver_payout_set, 70, 'the decision itself was not recorded');
  assert.strictEqual(row.driver_pay, 70, 'driver_pay must carry it, for every reader that already looks there');
  assert.strictEqual(row.admin_fee, 30, 'commission must be WHAT IS LEFT, or the fare stops adding up');
  assert.strictEqual(row.admin_fee + row.driver_pay, row.fare, 'commission + payout ≠ fare');
});

test('the turnover SQL agrees with the ledger on the same job', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  await dispatch(b.id, { driver_id: d, driver_payout: 70 });
  const row = rowOf(b.id);
  const sql = db.prepare(`SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE id = ?`)
    .get(b.id).t;
  assert.strictEqual(sql, 30, 'the dashboard sees a different number from the ledger');
  assert.strictEqual(ledger.westmereIncome(row), 30, 'and the ledger from itself');
});

test('no override still writes the rate, and leaves the column empty', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  await dispatch(b.id, { driver_id: d });
  const row = rowOf(b.id);
  assert.strictEqual(row.driver_payout_set, null, 'a job nobody overrode must not look overridden');
  assert.strictEqual(row.driver_pay, 90);
  assert.strictEqual(row.admin_fee, 10);
});

test('more than the fare is refused, and says both numbers', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 95 });
  const r = await dispatch(b.id, { driver_id: d, driver_payout: 950 });
  assert.strictEqual(r.status, 400);
  const body = await r.json();
  assert.ok(/950\.00/.test(body.error) && /95\.00/.test(body.error),
    'the refusal must name what was asked and what the fare is: ' + body.error);
  assert.strictEqual(rowOf(b.id).passed_at, null, 'the job was passed anyway');
});

test('a negative amount, and an unpriced job, are both refused', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  const neg = await dispatch(b.id, { driver_id: d, driver_payout: -5 });
  assert.strictEqual(neg.status, 400, 'a negative payout was accepted');

  const unpriced = seedBooking({ fare: null });
  const r = await dispatch(unpriced.id, { driver_id: d, driver_payout: 40 });
  assert.strictEqual(r.status, 400, 'an amount was set against a job with no fare');
  assert.ok(/Price the job/.test((await r.json()).error));
});

test('an operator job refuses an amount — it settles on the invoice', async () => {
  const op = db.prepare(`INSERT INTO customers (full_name,email,password,is_operator,active)
                         VALUES ('Harding Exec','ops@h.co.uk','',1,1)`).run().lastInsertRowid;
  const b = seedBooking({ fare: 100 });
  const r = await dispatch(b.id, { operator_id: op, driver_payout: 70 });
  assert.strictEqual(r.status, 400, 'an operator job took a payout amount');
  assert.ok(/invoice/i.test((await r.json()).error));
});

test('zero is accepted — it is a real answer, not a missing one', async () => {
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  const r = await dispatch(b.id, { driver_id: d, driver_payout: 0 });
  assert.strictEqual(r.status, 200, await r.text());
  const row = rowOf(b.id);
  assert.strictEqual(row.driver_payout_set, 0);
  assert.strictEqual(row.driver_pay, 0);
  assert.strictEqual(row.admin_fee, 100);
});

// ── 3. THE DRIVER'S EMAIL SHOWS THE FIGURE HE SET ─────────────────────────
console.log('\nThe email says what was agreed');

test('the payout in the email is the agreed one, and says so', async () => {
  SENT.length = 0;
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  await dispatch(b.id, { driver_id: d, driver_payout: 70 });
  const mail = SENT.map((m) => String(m.html || '')).filter((h) => /Payout/.test(h))[0];
  assert.ok(mail, 'no driver email carried a payout');
  assert.ok(/£70\.00/.test(mail), 'the email does not show the agreed figure: ' + (mail.match(/Payout[^<]*/) || []));
  assert.ok(!/£90\.00/.test(mail), 'the email still shows the figure from the rate');
  assert.ok(/\(agreed\)/.test(mail), 'the email does not say the amount was agreed');
  assert.ok(!/\(10%\)/.test(mail), 'an agreed payout must not name a rate — there was not one');
});

test('…and without one, the email is the breakdown it always was', async () => {
  SENT.length = 0;
  const d = seedDriver(10);
  const b = seedBooking({ fare: 100 });
  await dispatch(b.id, { driver_id: d });
  const mail = SENT.map((m) => String(m.html || '')).filter((h) => /Payout/.test(h))[0];
  assert.ok(/£90\.00/.test(mail), 'the ordinary payout is gone');
  assert.ok(/\(10%\)/.test(mail), 'the rate no longer travels with the deduction');
  assert.ok(!/\(agreed\)/.test(mail), 'a job nobody overrode is being called agreed');
});

// ── 4. THE FIELD ITSELF, IN BOTH APPS ─────────────────────────────────────
console.log('\nThe field is editable, pre-filled, and what it holds is what is sent');

for (const app of ['westmere-owner.html', 'westmere-admin.html']) {
  test(app + ': the amount is an input, pre-filled from the calculation', () => {
    const src = strip(read(app), { html: true });
    const money = fnBlock(src, 'dispMoneyHtml');
    assert.ok(/id="disp-payout"/.test(money), 'there is no amount field on the confirm step');
    assert.ok(/<input/.test(money) && /type="number"/.test(money), 'the amount is not editable');
    assert.ok(/value="' \+ dflt \+ '"/.test(money), 'the field is not pre-filled');
    assert.ok(/sp\.payout/.test(money), 'the pre-fill does not come from the calculated payout');
    // The calculated figure stays visible beside it, or he cannot tell what he changed.
    assert.ok(/'Fare'/.test(money) && /commission/i.test(money),
      'the fare and commission no longer show beside the amount');
  });

  test(app + ': what is in the box at send time is what is sent', () => {
    const src = strip(read(app), { html: true });
    const send = fnBlock(src, 'dispSend');
    assert.ok(/getElementById\('disp-payout'\)/.test(send),
      'dispSend does not read the field — it would send a figure drawn minutes ago');
    assert.ok(/driver_payout:/.test(send), 'the amount is not put in the payload');
    assert.ok(/_DISPATCH\.operator/.test(send), 'an operator job must not send a payout');
  });

  test(app + ': the sentence under the box follows the amount in it', () => {
    /* It named the derived payout and stayed on it after he typed, so the
       screen said he was setting £70 and owed £85.50 in the same breath. */
    const src = strip(read(app), { html: true });
    const status = fnBlock(src, 'dispPayoutStatus');
    assert.ok(/amount/.test(status), 'the sentence does not take the amount it is to describe');
    assert.ok(/you owe him/.test(status), 'the prepaid sentence is gone');
    const bind = fnBlock(src, 'dispBindPayout');
    assert.ok(/disp-money-note/.test(bind) && /dispPayoutStatus\(/.test(bind),
      'typing a new amount does not update the sentence under it');
  });

  test(app + ': switching the rate re-fills the box, but never over a typed figure', () => {
    const src = strip(read(app), { html: true });
    const setc = fnBlock(src, 'dispSetComm');
    assert.ok(/payoutTyped/.test(setc),
      'changing the commission option would wipe an amount he had decided on');
    assert.ok(/dispBindPayout\(\)/.test(setc), 'the field loses its binding when the rate changes');
    const bind = fnBlock(src, 'dispBindPayout');
    assert.ok(/oninput/.test(bind), 'nothing notices him typing');
    assert.ok(/disp-payout-reset/.test(bind), 'there is no way back to the calculated figure');
  });
}

test('the column is migrated additively, like every other one', () => {
  const src = read('server/db.js');
  assert.ok(/\['driver_payout_set','REAL'\]/.test(src), 'the column is not in the boot migration');
  const info = db.prepare('PRAGMA table_info(bookings)').all();
  assert.ok(info.find((c) => c.name === 'driver_payout_set'), 'the column is not on the table');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/driver-payout-set\.test\.js/.test(read('package.json')),
    'driver-payout-set.test.js is not in the npm test chain — an unrun guard is no guard');
});

(async () => {
  startServer();
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  try { srv.close(); } catch (_) {}
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
