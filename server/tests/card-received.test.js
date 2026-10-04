/**
 * WHAT ACTUALLY LANDED FROM A CARD PAYMENT — run with:
 *   node server/tests/card-received.test.js   (also gated by `npm test`)
 *
 * Stripe takes its cut whoever drove the job: a £96 fare arrives as about £93.
 * On a job passed on for NO commission nothing covered that, and the owner was
 * paying it out of his own pocket on work he kept nothing from.
 *
 * HE TYPES THE AMOUNT RECEIVED. Not a fee, not a rate — the number on his
 * statement, which is the one he can check without doing arithmetic first. The
 * fee is the difference from the fare, derived and never stored beside it, so
 * the two can never disagree. An earlier version estimated it at 1.5% + 20p;
 * there is no rate anywhere in this system now.
 *
 * THE RULE, in his words: the driver's payout is worked out from the real
 * received amount, then less commission if it is a commission job.
 *   • CARD + an amount typed  → payout = received − commission
 *   • CARD + nothing typed    → payout = fare − commission. Nothing is guessed.
 *   • cash / account / invoice / pending → the fare, less commission. A figure
 *     left on the row is IGNORED: a method can change after a job is passed,
 *     and a deduction for a payment never made by card is money off a driver
 *     for nothing.
 *
 * AND IT IS NOT THE OWNER'S INCOME. The fare comes in, Stripe takes its cut,
 * the rest goes out: it nets to nothing, so westmereIncome on a cover job
 * stays zero and the turnover SQL needs no term for it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock, regionFrom } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-cardrecv-' + process.pid + '.db');
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
const api = require('../api');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(method, routePath, opts) {
  const o = opts || {};
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: o.role || 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced) break;
  }
  return r;
}

let seq = 0;
function seedDriver() {
  return db.prepare(`INSERT INTO users (username,password,role,full_name,email,active,has_login)
                     VALUES (?, '', 'driver', ?, ?, 1, 0)`)
    .run('pf' + (++seq) + Date.now().toString(36), 'Fee Driver ' + seq, 'pf' + seq + '@example.com').lastInsertRowid;
}
function seedJob(driverId, over) {
  const o = Object.assign({ fare: 96, payment: 'card', pct: 0, date: '2026-10-07' }, over || {});
  const split = ledger.computeSplit(o.fare, o.pct / 100);
  const ref = 'WPH-F' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                    driver_id,driver_pay,admin_fee,passed_at,card_received)
              VALUES (?,?,?,?,?,1,?,?,'completed',?,?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick', o.date, '07:00', o.fare, o.payment, driverId,
         split.driver_pay, split.admin_fee, o.date, o.card_received == null ? null : o.card_received);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

// ── 1. NOTHING IS ESTIMATED ──────────────────────────────────────────────
console.log('\nThe figure is the one he typed, or there is none');

test('a card job with nothing typed pays on the whole fare', () => {
  const s = ledger.jobSplit({ fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96 });
  assert.strictEqual(s.received, 96, 'with nothing said, the fare IS what arrived');
  assert.strictEqual(s.card_fee, 0);
  assert.strictEqual(s.payout, 96, 'the driver gets the whole fare until the owner says otherwise');
  /* And no rate exists anywhere to be reintroduced by accident. */
  const src = read('server/driver-ledger.js');
  assert.ok(!/CARD_FEE_DEFAULT|cardFeeSettings|computeCardFee/.test(src),
    'the estimated card-fee rate must stay gone — the owner types the real figure');
  assert.ok(!/0\.015|1\.5 *\/ *100/.test(strip(src)), 'no Stripe percentage may survive in the ledger');
});

test('the driver is paid out of what arrived — £96 fare, £93 received', () => {
  const j = { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93 };
  const s = ledger.jobSplit(j);
  assert.strictEqual(s.received, 93, 'what he typed');
  assert.strictEqual(s.card_fee, 3, 'and the fee is the difference, not a second stored figure');
  assert.strictEqual(s.payout, 93, 'the driver gets what arrived');
  assert.strictEqual(ledger.balanceDelta(j), 93, 'and the balance follows it');
});

test('a COMMISSION job takes the commission off what arrived', () => {
  /* The owner's words: worked out from the real received amount, THEN minus
     commission. */
  const s = ledger.jobSplit({ fare: 96, payment: 'card', admin_fee: 9.6, driver_pay: 86.4, card_received: 93 });
  assert.strictEqual(s.received, 93);
  assert.strictEqual(s.card_fee, 3);
  assert.strictEqual(s.commission, 9.6);
  assert.strictEqual(s.payout, 83.4, '93 − 9.60');
});

test('no card, no deduction — whatever is stored on the row', () => {
  for (const payment of ['cash', 'account', 'invoice', 'pending', '', null]) {
    const s = ledger.jobSplit({ fare: 96, payment, admin_fee: 0, driver_pay: 96, card_received: 93 });
    assert.strictEqual(s.card_fee, 0, payment + ' costs nothing to collect');
    assert.strictEqual(s.received, 96, payment + ' receives the whole fare');
    assert.strictEqual(s.payout, 96, payment + ' must pay the driver the whole fare');
  }
  /* …and still less commission where there is commission. */
  const cash = ledger.jobSplit({ fare: 96, payment: 'cash', admin_fee: 9.6, driver_pay: 86.4, card_received: 93 });
  assert.strictEqual(cash.payout, 86.4);
});

test('an EMPTY column is "not said", not "nothing arrived"', () => {
  /* The column is NULL until the owner says what landed, and Number(null) is
     0 — which read as "nothing arrived", made the fee the whole fare and paid
     the driver £0.00 on every card job in the system. Found by this file on a
     real database row; an object literal without the key had hidden it. */
  for (const empty of [null, undefined, '']) {
    const j = { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: empty };
    assert.strictEqual(ledger.receivedOn(j), 96, String(empty) + ' means he has not said yet');
    assert.strictEqual(ledger.jobSplit(j).payout, 96, String(empty) + ' must not zero the payout');
  }
  /* …and a real zero IS an answer: nothing arrived, the fee is the whole fare. */
  assert.strictEqual(ledger.receivedOn({ fare: 96, payment: 'card', card_received: 0 }), 0);
});

test('a nonsense figure never makes the driver worse off than the fare', () => {
  assert.strictEqual(ledger.receivedOn({ fare: 96, payment: 'card', card_received: 999 }), 96,
    'more than the fare cannot have arrived');
  assert.strictEqual(ledger.receivedOn({ fare: 96, payment: 'card', card_received: -5 }), 96,
    'a negative is not an answer — fall back to the fare');
  assert.strictEqual(ledger.receivedOn({ fare: 96, payment: 'card', card_received: 'x' }), 96);
  assert.strictEqual(ledger.cardFeeOn({ fare: 96, payment: 'card', card_received: 0 }), 96,
    'nothing arriving is a real answer, and the whole fare is the fee');
});

// ── 2. ENTERED BY HAND, EITHER FIGURE ────────────────────────────────────
console.log('\nHe types what landed, or the fee if that is what he has');

test('PATCH with the received amount sets it and recalculates the payout', async () => {
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: { received: 93 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.job.received, 93);
  assert.strictEqual(r.body.job.card_fee, 3);
  assert.strictEqual(r.body.job.payout, 93);
  assert.strictEqual(r.body.balance, 93, 'the balance follows immediately');
  assert.strictEqual(Number(rowOf(j.id).card_received), 93, 'and it is stored, not recomputed');
});

test('PATCH with the FEE stores the same one figure', async () => {
  /* Two ways in, one number on the row — there is no second opinion to drift. */
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: { fee: 3 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(Number(rowOf(j.id).card_received), 93, 'the fee is stored as what arrived');
  assert.strictEqual(r.body.job.card_fee, 3);
  assert.strictEqual(r.body.job.payout, 93);
});

test('more than the fare is refused, either way round', async () => {
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  for (const body of [{ received: 200 }, { fee: 200 }]) {
    const r = await call('patch', '/bookings/:id/card-received',
      { params: { id: String(j.id) }, body });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(body) + ' → ' + JSON.stringify(r.body));
    assert.ok(/96\.00/.test(r.body.error), 'it must name the fare: ' + r.body.error);
  }
  assert.strictEqual(rowOf(j.id).card_received, null, 'and nothing is stored');
});

test('receiving the full fare stores nothing at all', async () => {
  /* Otherwise the driver's email prints "card fee −£0.00" for ever. */
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: { received: 96 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(rowOf(j.id).card_received, null);
  assert.strictEqual(r.body.job.card_fee, 0);
});

test('it can be cleared again', async () => {
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0, card_received: 93 });
  assert.strictEqual(ledger.driverBalance(d), 93);
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: {} });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(rowOf(j.id).card_received, null);
  assert.strictEqual(ledger.driverBalance(d), 96, 'and the driver is owed the whole fare again');
});

test('a job that was not paid by card refuses the figure outright', async () => {
  for (const payment of ['cash', 'account', 'invoice']) {
    const d = seedDriver();
    const j = seedJob(d, { fare: 96, pct: 0, payment });
    const r = await call('patch', '/bookings/:id/card-received',
      { params: { id: String(j.id) }, body: { received: 93 } });
    assert.strictEqual(r.statusCode, 409, payment + ': ' + JSON.stringify(r.body));
    assert.ok(/not paid by card/i.test(r.body.error), r.body.error);
    assert.strictEqual(rowOf(j.id).card_received, null);
  }
});

test('a settled job will not have it changed under the money', async () => {
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  ledger.setJobSettled(j.id, true);
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: { received: 93 } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/mark it unpaid first/i.test(r.body.error), r.body.error);
});

test('a driver cannot set what he is paid out of', async () => {
  const d = seedDriver();
  const j = seedJob(d, { fare: 96, pct: 0 });
  const r = await call('patch', '/bookings/:id/card-received',
    { params: { id: String(j.id) }, body: { received: 96 }, role: 'driver' });
  assert.strictEqual(r.statusCode, 403);
});

// ── 3. IT IS NOT INCOME ──────────────────────────────────────────────────
test('westmereIncome on a cover card job is still nothing', () => {
  const j = { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93, passed_at: 'x' };
  assert.strictEqual(ledger.westmereIncome(j), 0,
    'the fare comes in, Stripe takes its cut, the rest goes out — it nets to nothing');
  const src = read('server/driver-ledger.js');
  assert.ok(!/card_received/.test(fnBlock(strip(src), 'incomeSql')),
    'if this ever becomes income, move westmereIncome WITH the turnover SQL');
});

// ── 4. THE WEEKLY PAYOUT ─────────────────────────────────────────────────
test('the week to transfer is net of what actually arrived', async () => {
  const d = seedDriver();
  seedJob(d, { fare: 96, pct: 0, card_received: 93 });   // 93
  seedJob(d, { fare: 100, pct: 10 });                    // 90, nothing typed
  const view = await call('get', '/drivers/:id/payout',
    { params: { id: String(d) }, query: { week: '2026-10-07' } });
  assert.strictEqual(view.body.total, 183);
  assert.strictEqual(view.body.total, ledger.driverBalance(d), 'the payout and the balance are one figure');
  const cover = view.body.items.find((i) => i.fare === 96);
  assert.strictEqual(cover.received, 93, 'the row carries it so the page can show the subtraction');
  assert.strictEqual(cover.card_fee, 3);
});

// ── 5. THE DRIVER IS TOLD WHY, IN ONE LINE ───────────────────────────────
console.log('\nOne line: fare, what came off, what he gets');

let _lastDispatch = null;
/** The most recent dispatch email, for the shape assertions below. */
function await0() { assert.ok(_lastDispatch, 'no dispatch email has been rendered yet'); return _lastDispatch; }

async function dispatched(job) {
  SENT.length = 0;
  const email = require('../email');
  const ok = await email.sendDriverDispatch(Object.assign({
    driver_email: 'driver@example.com', driver_name: 'Gary', ref: 'WPH-1',
    date: '2026-10-07', time: '07:00', pickup: 'Steyning', destination: 'Gatwick'
  }, job));
  assert.ok(ok, 'the email did not send');
  const html = (SENT[0] && SENT[0].html) || '';
  const m = /Fare [^<]*/.exec(html);
  _lastDispatch = { html, line: m ? m[0].replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim() : '' };
  return _lastDispatch;
}

test('a no-commission card job reads "Fare £96.00 · Card fee −£3.00 · Payout £93.00"', async () => {
  const { html, line } = await dispatched({
    fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93, commission_pct: 0 });
  assert.strictEqual(line, 'Fare £96.00 · Card fee −£3.00 · Payout £93.00', 'got: ' + line);
  assert.ok(/£93\.00/.test(html), 'and the total he actually gets');
  assert.ok(!/£96\.00[\s\S]{0,160}Total[\s\S]{0,60}£96\.00/.test(html),
    'the total must not still be the pre-fee figure');
});

test('a commission card job shows the commission too, on the same line', async () => {
  const { line } = await dispatched({
    fare: 96, payment: 'card', admin_fee: 9.6, driver_pay: 86.4, card_received: 93, commission_pct: 10 });
  assert.strictEqual(line, 'Fare £96.00 · Commission (10%) −£9.60 · Card fee −£3.00 · Payout £83.40', 'got: ' + line);
});

test('a cash job shows no card fee at all', async () => {
  const { html, line } = await dispatched({
    fare: 96, payment: 'cash', admin_fee: 9.6, driver_pay: 86.4, card_received: 93, commission_pct: 10 });
  assert.strictEqual(line, 'Fare £96.00 · Commission (10%) −£9.60 · Payout £86.40', 'got: ' + line);
  assert.ok(!/card fee/i.test(html), 'a cash job costs nothing to collect');
});

test('the line REPLACES the itemised rows — he asked for the short breakdown', () => {
  /* The block used to list Fare / Commission / Card fee / Total as rows AND
     then say the same thing in a line. He asked for the one line, twice; two
     renderings of one sum is what he was trying to get rid of. */
  const { html } = await0();
  const rows = [...html.matchAll(/>(Fare|Commission[^<]*|Card fee|Total|You get|Payout)</g)].map((m) => m[1]);
  assert.deepStrictEqual(rows, ['Payout'],
    'the pay block should carry one labelled figure and the breakdown line: got ' + rows.join(', '));
});

// ── THE WORDING IS A DOCUMENT'S, NOT A CONVERSATION'S ───────────────────
// The owner asked for the driver-facing text to read professionally: no "you
// get", no "you receive", no second person at all around the money. A driver
// is being paid, and the record of it should sound like a record.
test('nothing driver-facing says "you get" or "you receive"', async () => {
  const shapes = [
    { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93, commission_pct: 0 },
    { fare: 96, payment: 'card', admin_fee: 9.6, driver_pay: 86.4, card_received: 93, commission_pct: 10 },
    { fare: 96, payment: 'cash', admin_fee: 9.6, driver_pay: 86.4, commission_pct: 10 },
    { fare: 96, payment: 'account', admin_fee: 0, driver_pay: 96, commission_pct: 0 }
  ];
  const BANNED = /you get|you'll get|you will get|you receive|you'll receive|your pay\b|to you\b/i;
  for (const shape of shapes) {
    const { html } = await dispatched(shape);
    /* The subject and the preheader go to his phone's lock screen, so they are
       swept too — the first wording a driver reads is the one in the list. */
    const sent = SENT[0] || {};
    for (const [where, text] of [['body', html], ['subject', sent.subject || ''], ['preheader', sent.text || '']]) {
      const hit = BANNED.exec(String(text));
      assert.ok(!hit, 'the ' + where + ' of a ' + shape.payment + ' job still says "' + (hit && hit[0]) + '"');
    }
  }
});

test('EVERY driver email shape is swept, not just the three above', async () => {
  /* A wording rule that covers the shapes a test happened to write is a rule
     with holes in it. This drives both driver emails through every shape they
     have — priced, unpriced, cash, card, operator — and sweeps body, subject
     and preheader each time. */
  const email = require('../email');
  const BAD = /\bto you\b|\byou get\b|\byou receive\b|\byou'll get\b|\byou will get\b|\byour pay\b/i;
  const base = { driver_name: 'D', driver_email: 'd@e.com', ref: 'R',
                 pickup: 'A', destination: 'B', date: '2026-10-09', time: '07:00' };
  const cases = [
    ['dispatch cover+card', email.sendDriverDispatch, { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93, commission_pct: 0 }],
    ['dispatch comm+card',  email.sendDriverDispatch, { fare: 96, payment: 'card', admin_fee: 9.6, driver_pay: 86.4, card_received: 93, commission_pct: 10 }],
    ['dispatch cash',       email.sendDriverDispatch, { fare: 96, payment: 'cash', admin_fee: 9.6, driver_pay: 86.4, commission_pct: 10 }],
    ['dispatch operator',   email.sendDriverDispatch, { fare: 96, payment: 'card', as_operator: true }],
    ['dispatch no fare',    email.sendDriverDispatch, { payment: 'card' }],
    ['offer priced',        email.sendDriverJobOffer, { fare: 150, driver_pay: 135, admin_fee: 15, offer_token: 't' }],
    ['offer unpriced',      email.sendDriverJobOffer, { offer_token: 't' }]
  ];
  for (const [label, fn, job] of cases) {
    SENT.length = 0;
    await fn(Object.assign({}, base, job));
    const m = SENT[0] || {};
    for (const [where, text] of [['body', String(m.html || '').replace(/<[^>]+>/g, ' ')],
                                 ['subject', m.subject || ''], ['preheader', m.text || '']]) {
      const hit = BAD.exec(text);
      assert.ok(!hit, label + ' — the ' + where + ' says "' + (hit && hit[0]) + '"');
    }
  }
});

test('the labels are the professional ones, everywhere the payout is shown', () => {
  /* The line and the figure above it in the email… */
  const src = strip(read('server/email.js'));
  assert.ok(/payRow\('Payout', money\(payout\), true\)/.test(src),
    "the driver's figure must be labelled Payout");
  assert.ok(/'Payout ' \+ money\(payout\)/.test(src), 'and the line must end on Payout');
  assert.ok(/'Fare ' \+/.test(src) && /'Commission'/.test(src) && /'Card fee −'/.test(src),
    'every part of the line must be a capitalised label');
  /* …the driver app… */
  assert.ok(/Payout \\u00a3/.test(read('westmere-driver.html')),
    'the driver app still puts the figure before a conversational label');
  /* …and the payout UI the owner works from. */
  for (const [f, src2] of [['westmere-owner.html', read('westmere-owner.html')],
                           ['westmere-admin.html', read('westmere-admin.html')]]) {
    assert.ok(/'Due from driver'/.test(src2) && /'Payout'/.test(src2),
      f + ' must label the two directions plainly');
    assert.ok(!/To him'|He owes you'/.test(src2), f + ' still has the conversational labels');
    assert.ok(!/What did you receive\?|he gets '/.test(src2), f + ' still asks conversationally');
  }
  assert.ok(/label: 'Payout'/.test(read('wm-compact.js')), 'the payout column must be labelled Payout');
  assert.ok(!/label: 'To him'/.test(read('wm-compact.js')));
});

test('it is a LINE, not a paragraph', () => {
  /* The owner asked for the short breakdown and said so twice. */
  const src = strip(read('server/email.js'));
  /* Bounded by the end of the paragraph it builds, not by a character count —
     a window measured in characters stops covering its subject the day
     somebody adds a line above it (server/tests/guard-hygiene.test.js). */
  const block = regionFrom(src, "'Fare ' +", [/<\/p>/]);
  assert.ok(/'Payout ' \+ money\(payout\)/.test(block), 'it must end on the payout');
  assert.ok(/filter\(Boolean\)\.join\(' &middot; '\)/.test(block),
    'the parts must join into ONE line, dropping the ones that do not apply');
  /* …and it IS a paragraph of one line, not a block of them. */
  assert.ok(!/<br\s*\/?>/.test(block), 'the breakdown must not break into several lines');
});

// ── 6. THE SCREENS ───────────────────────────────────────────────────────
test('both trip pages show what arrived and offer the box — on card jobs only', () => {
  for (const [who, file, fn] of [['owner', 'westmere-owner.html', 'owDrvTripHtml'],
                                 ['admin', 'westmere-admin.html', 'admDrvTripHtml']]) {
    const src = fnBlock(strip(read(file)), fn);
    assert.ok(/Less card fee/.test(src), who + ' must name the deduction');
    assert.ok(/it\.received/.test(src) && /it\.card_fee/.test(src),
      who + ' must read both figures from the ledger row');
    assert.ok(/payMethod\(it\) *=== *'card'/.test(src.replace(/\s+/g, ' ')),
      who + ' must offer the box on card jobs only');
    assert.ok(/Enter the amount received/.test(src), who + ' must ask for the amount received');
  }
});

test('the screens send what he typed, and never a rate', () => {
  for (const [who, file, fn] of [['owner', 'westmere-owner.html', 'owJobFeeSave'],
                                 ['admin', 'westmere-admin.html', 'admJobFeeSave']]) {
    const src = fnBlock(strip(read(file)), fn);
    assert.ok(/received:/.test(src) && /fee:/.test(src), who + ' must send either figure');
    assert.ok(!/0\.015|1\.5/.test(src), who + ' must not carry a rate of its own');
  }
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    const src = read(f);
    assert.ok(!/cf-pct|settings\/card-fee/.test(src), f + ' still has the old configured-rate control');
    assert.ok(!/processing-fee/.test(src), f + ' still calls the superseded route');
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/card-received\.test\.js/.test(read('package.json')),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
