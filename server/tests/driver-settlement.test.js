/**
 * WHO HAS BEEN PAID FOR WHAT — run with:
 *   node server/tests/driver-settlement.test.js   (also gated by `npm test`)
 *
 * THE RECONCILIATION THIS FILE EXISTS TO HOLD
 *   There were two candidate truths about a driver's money and they could not
 *   both be right:
 *     (a) a running balance with lump settlements subtracted from it, and
 *     (b) a paid/unpaid mark on each job.
 *   Keep both and the first disagreement is permanent: tick three jobs, record
 *   a £300 payment for the same work, and the balance is £300 light with
 *   nothing on screen saying so.
 *
 *   THE JOB WINS. Each job carries `driver_settled` — how much of its movement
 *   has changed hands, signed the way the movement is — and
 *
 *       balance = Σ (delta(job) − settled(job))
 *
 *   A payment is not subtracted from that. It is SPENT across his oldest
 *   unsettled jobs and stamps them; driver_settlements keeps the receipt (what
 *   moved, when, how) and records which jobs it cleared, and the balance never
 *   reads that table. So there is one place to look, and "what is this £300
 *   for?" is answerable by pointing at rows.
 *
 *   It is the operator model with the invoice swapped for the job: an operator
 *   owes the invoices they have not paid; a driver is owed the jobs that have
 *   not been settled.
 *
 * AND THE MIGRATION, because the switch must not move anybody's balance: every
 * settlement already recorded is spent across the jobs it paid for at boot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-drvsettle-' + process.pid + '.db');
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
const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
function fnBody(code, name) {
  const i = code.indexOf('function ' + name + '(');
  assert.ok(i > -1, name + ' is gone');
  const end = code.indexOf('\n}', i);
  assert.ok(end > i, name + ' has no closing brace');
  return code.slice(i, end);
}

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
  const handlers = l.route.stack.map((x) => x.handle);
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: o.role || 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of handlers) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced && h !== handlers[handlers.length - 1]) break;
  }
  return r;
}

let seq = 0;
function seedDriver(pct) {
  const info = db.prepare(`INSERT INTO users (username,password,role,full_name,email,active,has_login,commission_pct)
                           VALUES (?, '', 'driver', ?, ?, 1, 0, ?)`)
    .run('drv' + (++seq) + Date.now().toString(36), 'Driver ' + seq, 'd' + seq + '@example.com',
         pct === undefined ? null : pct);
  return info.lastInsertRowid;
}
function seedJob(driverId, over) {
  const o = Object.assign({ fare: 100, payment: 'card', pct: 10, date: '2026-09-0' + ((seq % 9) + 1) }, over || {});
  const split = ledger.computeSplit(o.fare, o.pct / 100);
  const ref = 'WPH-S' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                    driver_id,driver_pay,admin_fee,passed_at)
              VALUES (?,?,?,?,?,1,?,?,'completed',?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick', o.date, '07:00', o.fare, o.payment, driverId,
         split.driver_pay, split.admin_fee, o.date);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

// ── 1. ONE TRUTH ─────────────────────────────────────────────────────────
console.log('\nThe balance is the jobs that have not been settled');

test('an unsettled job is owed, a settled one is not', () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });        // +90
  const b = seedJob(d, { fare: 200 });        // +180
  assert.strictEqual(ledger.driverBalance(d), 270);
  ledger.setJobSettled(a.id, true);
  assert.strictEqual(ledger.driverBalance(d), 180, 'marking a job paid must take it off the balance');
  ledger.setJobSettled(a.id, false);
  assert.strictEqual(ledger.driverBalance(d), 270, 'and un-marking it must put it back');
});

test('a cash job pulls the other way, and settling it clears what HE owes', () => {
  const d = seedDriver();
  const c = seedJob(d, { fare: 200, payment: 'cash' });   // −20: he holds the fare
  assert.strictEqual(ledger.driverBalance(d), -20);
  ledger.setJobSettled(c.id, true);
  assert.strictEqual(ledger.driverBalance(d), 0, 'he handed the commission back');
  assert.strictEqual(Number(rowOf(c.id).driver_settled), -20,
    'and the stamp is signed the way the job is, or the next sum of it is wrong');
});

test('THE BALANCE DOES NOT READ THE SETTLEMENTS TABLE', () => {
  /* The whole reconciliation in one assertion. A settlement row that moved the
     balance by itself would be the second truth this model exists to remove. */
  const d = seedDriver();
  seedJob(d, { fare: 100 });
  const before = ledger.driverBalance(d);
  db.prepare(`INSERT INTO driver_settlements (driver_id, amount, paid_on) VALUES (?,?,?)`)
    .run(d, 90, '2026-09-30');
  assert.strictEqual(ledger.driverBalance(d), before,
    'a bare settlement row moved the balance — there are two truths again');
  const src = strip(read('server/driver-ledger.js'));
  const fn = fnBody(src, 'driverBalance');
  assert.ok(!/driver_settlements|driverSettlements/.test(fn),
    'driverBalance reads the settlements table: ' + fn);
});

// ── 2. A PAYMENT IS SPENT, NOT SUBTRACTED ────────────────────────────────
console.log('\nA payment pays for jobs');

test('it clears the oldest first, and says which', () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, date: '2026-09-01' });   // +90
  const b = seedJob(d, { fare: 100, date: '2026-09-02' });   // +90
  const r = ledger.applyPayment(d, 150, { method: 'Bank transfer' });
  assert.deepStrictEqual(r.cleared.map((c) => [c.ref, c.amount, c.whole]),
    [[a.ref, 90, true], [b.ref, 60, false]], JSON.stringify(r.cleared));
  assert.strictEqual(r.unapplied, 0);
  assert.strictEqual(ledger.driverBalance(d), 30, '180 owed less 150 paid');
  assert.strictEqual(ledger.isSettled(rowOf(a.id)), true);
  assert.strictEqual(ledger.isSettled(rowOf(b.id)), false, 'a part-paid job is not a paid job');
});

test('a part-payment leaves the truth on the job, not in a remainder column', () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  ledger.applyPayment(d, 40);
  const row = rowOf(a.id);
  assert.strictEqual(Number(row.driver_settled), 40, 'what reached it is what is recorded');
  assert.strictEqual(ledger.outstandingOn(row), 50, 'and the rest is still owed');
  assert.strictEqual(ledger.driverBalance(d), 50);
});

test('money paid OUT cannot clear what the driver owes US', () => {
  /* Handing a driver cash does not settle the commission he owes on a cash
     job. Netting the two silently is how a statement stops being checkable. */
  const d = seedDriver();
  const cash = seedJob(d, { fare: 200, payment: 'cash' });    // −20
  const r = ledger.applyPayment(d, 50);
  assert.deepStrictEqual(r.cleared, [], 'it cleared a job pulling the other way');
  assert.strictEqual(r.unapplied, 50, 'and the money must be reported as unplaced');
  assert.strictEqual(Number(rowOf(cash.id).driver_settled || 0), 0);
});

test('the receipt records what it paid for', () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  const r = ledger.applyPayment(d, 90, { method: 'Bank transfer' });
  const stored = db.prepare('SELECT * FROM driver_settlements WHERE id = ?').get(r.receipt.id);
  const applied = JSON.parse(stored.applied_json);
  /* WHICH JOBS, AND HOW MUCH LANDED ON EACH. Two payments can touch one job —
     £50 off a £90 job, then the £40 — and undoing the first has to take back
     fifty rather than wiping the job and losing the other payment with it. */
  assert.deepStrictEqual(applied.jobs, [{ id: a.id, amount: 90 }],
    'the receipt must say which jobs it cleared and for how much');
  assert.strictEqual(stored.method, 'Bank transfer');
});

// ── 3. THE ROUTES ────────────────────────────────────────────────────────
console.log('\nThe toggle, and the rate, on one job');

test('PATCH /bookings/:id/driver-settled ticks and unticks', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  let r = await call('patch', '/bookings/:id/driver-settled', { params: { id: String(a.id) }, body: { settled: true } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.job.paid, true);
  assert.strictEqual(r.body.balance, 0);
  r = await call('patch', '/bookings/:id/driver-settled', { params: { id: String(a.id) }, body: { settled: false } });
  assert.strictEqual(r.body.balance, 90);
  r = await call('patch', '/bookings/:id/driver-settled', { params: { id: String(a.id) }, body: { settled: 'yes' } });
  assert.strictEqual(r.statusCode, 400, 'a string is not an answer to a yes/no question');
  r = await call('patch', '/bookings/:id/driver-settled', { params: { id: String(a.id) }, body: { settled: true }, role: 'driver' });
  assert.strictEqual(r.statusCode, 403, 'a driver must not tick his own jobs off');
});

test('PATCH /bookings/:id/commission re-cuts the job', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 200, pct: 10 });       // 20 / 180
  let r = await call('patch', '/bookings/:id/commission', { params: { id: String(a.id) }, body: { charge_commission: false } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.job.commission, 0, 'a cover job takes nothing');
  assert.strictEqual(r.body.job.payout, 200, 'and he keeps the fare');
  assert.strictEqual(r.body.balance, 200, 'the balance follows immediately');
  assert.strictEqual(ledger.westmereIncome(rowOf(a.id)), 0, 'and so does the turnover');

  r = await call('patch', '/bookings/:id/commission', { params: { id: String(a.id) }, body: { commission_pct: 12.5 } });
  assert.strictEqual(r.body.job.commission, 25);
  assert.strictEqual(r.body.job.payout, 175);
  assert.strictEqual(r.body.job.commission_pct, 12.5, 'the row must report the rate it is now on');
  assert.strictEqual(ledger.westmereIncome(rowOf(a.id)), 25);

  /* The fare is not what is being corrected here. */
  assert.strictEqual(Number(rowOf(a.id).fare), 200, 'the fare must not move');
});

test('a rate outside 0–100, or no answer at all, is refused', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  for (const body of [{ commission_pct: -1 }, { commission_pct: 101 }, { commission_pct: 'half' }, {}]) {
    const r = await call('patch', '/bookings/:id/commission', { params: { id: String(a.id) }, body });
    assert.strictEqual(r.statusCode, 400, 'accepted ' + JSON.stringify(body));
  }
  assert.strictEqual(Number(rowOf(a.id).admin_fee), 10, 'and nothing moved');
});

test('a SETTLED job will not have its commission changed under the money', async () => {
  /* The figures on a paid job are a receipt. Re-cutting it would leave the
     payment and the job disagreeing with nothing on screen to say which is
     right — so it is refused, and re-opening it is a deliberate act. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  await call('patch', '/bookings/:id/driver-settled', { params: { id: String(a.id) }, body: { settled: true } });
  const r = await call('patch', '/bookings/:id/commission', { params: { id: String(a.id) }, body: { charge_commission: false } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/unpaid first/i.test(r.body.error), 'and it must say how to proceed: ' + r.body.error);
  assert.strictEqual(Number(rowOf(a.id).admin_fee), 10, 'nothing moved');
});

test('a job nobody was passed has neither a commission nor a settlement', async () => {
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES ('WPH-OWN','A','B','2026-09-01','07:00',1,100,'card','completed')`).run();
  const own = db.prepare("SELECT id FROM bookings WHERE ref = 'WPH-OWN'").get().id;
  for (const p of ['/bookings/:id/commission', '/bookings/:id/driver-settled']) {
    const r = await call('patch', p, { params: { id: String(own) }, body: { settled: true, charge_commission: false } });
    assert.strictEqual(r.statusCode, 409, p + ' acted on a job we drove ourselves');
  }
});

test('recording a payment through the route clears jobs and reports them', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, date: '2026-09-01' });
  const b = seedJob(d, { fare: 100, date: '2026-09-02' });
  const r = await call('post', '/drivers/:id/settlements', { params: { id: String(d) }, body: { amount: 90, method: 'Cash' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.cleared.length, 1);
  assert.strictEqual(r.body.balance, 90);
  assert.strictEqual(ledger.isSettled(rowOf(a.id)), true);
  assert.strictEqual(ledger.isSettled(rowOf(b.id)), false);
});

test('two payments on one job, and undoing the first keeps the second', () => {
  /* The case that nulling the stamp got wrong. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });              // +90
  const first = ledger.applyPayment(d, 50);
  const second = ledger.applyPayment(d, 40);
  assert.strictEqual(ledger.driverBalance(d), 0);
  const r1 = db.prepare('SELECT * FROM driver_settlements WHERE id = ?').get(first.receipt.id);
  assert.strictEqual(ledger.unapplyPayment(r1, d), 1);
  assert.strictEqual(ledger.driverBalance(d), 50,
    'taking back the £50 must leave the £40 on the job, not wipe it');
  assert.strictEqual(Number(rowOf(a.id).driver_settled), 40);
});

test('undoing a payment puts its jobs back', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100 });
  const post = await call('post', '/drivers/:id/settlements', { params: { id: String(d) }, body: { amount: 90 } });
  const sid = post.body.settlement.id;
  assert.strictEqual(ledger.driverBalance(d), 0);
  const del = await call('delete', '/drivers/:id/settlements/:sid', { params: { id: String(d), sid: String(sid) } });
  assert.strictEqual(del.statusCode, 200, JSON.stringify(del.body));
  assert.strictEqual(del.body.reopened, 1, 'the job it cleared must go back to unpaid');
  assert.strictEqual(ledger.driverBalance(d), 90, 'or the balance keeps a payment that no longer exists');
  assert.strictEqual(rowOf(a.id).driver_settled, null);
});

// ── 4. THE MIGRATION ─────────────────────────────────────────────────────
console.log('\nNobody\'s balance moved when the model changed');

test('settlements recorded under the old model are spent across the jobs', () => {
  /* The old balance was "every job, less every payment". The new one is "the
     jobs not settled". They agree only if the payments already made are
     applied — otherwise every driver who has ever been paid is owed it twice. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, date: '2026-09-01' });
  const b = seedJob(d, { fare: 100, date: '2026-09-02' });
  db.prepare(`INSERT INTO driver_settlements (driver_id, amount, paid_on) VALUES (?,?,?)`).run(d, 90, '2026-09-05');
  const oldBalance = 180 - 90;

  const { runSettlementMigration } = require('../db');
  assert.strictEqual(typeof runSettlementMigration, 'function',
    'the migration must be callable, or it cannot be tested — only watched');
  runSettlementMigration();

  assert.strictEqual(ledger.driverBalance(d), oldBalance, 'the balance moved under the driver');
  assert.strictEqual(ledger.isSettled(rowOf(a.id)), true, 'the oldest job is the one it paid for');
  assert.strictEqual(ledger.isSettled(rowOf(b.id)), false);

  /* And a second boot changes nothing. */
  runSettlementMigration();
  assert.strictEqual(ledger.driverBalance(d), oldBalance, 'the migration is not idempotent');
});

// ── 5. THE SCREEN ────────────────────────────────────────────────────────
// The controls live on the TRIP PAGE, not on the list row. The owner's rule
// for every history surface: the list is a few short columns, and the row
// opens the page that carries everything else — the working, the payment
// method, the commission and the paid tick. What must not change is that all
// of it still EXISTS and is one click away.
// See also: server/tests/compact-history.test.js
console.log('\nThe trip page the owner opens from the list');

test('the trip page carries the toggle and the rate controls', () => {
  const H = strip(read('westmere-owner.html'));
  const fn = fnBody(H, 'owDrvTripHtml');
  assert.ok(/owJobPaid\(/.test(fn), 'no paid/unpaid toggle on the trip page');
  assert.ok(/owJobCommission\(/.test(fn), 'no way to make a job a cover job');
  assert.ok(/owJobRateOpen\(/.test(fn), 'no way to set the rate on one job');
  assert.ok(/it\.commission_pct/.test(fn), 'the trip page must say what rate it is on');
  // …and the list row is what opens it.
  const list = fnBody(H, 'owDriverLoad');
  assert.ok(/owDrvTripOpen/.test(list), 'the trips list must open the trip page');
  /* The figure at the top and the ticks below it are the same fact, so the
     page says so rather than leaving the owner to wonder. */
  assert.ok(/unpaid job/.test(list), 'the balance does not say it is the unpaid jobs');
});

test('the list row stays COMPACT — the money controls are not on it', () => {
  /* The row carried a route, a running balance, the working, three buttons and
     a rate box, and stopped being a row. If any of that comes back to the
     list, this fails. */
  const list = fnBody(strip(read('westmere-owner.html')), 'owDriverLoad');
  for (const ctl of ['owJobPaid(', 'owJobCommission(', 'owJobRateOpen(', 'jr-pct-']) {
    assert.ok(!list.includes(ctl), 'the compact trips list must not carry ' + ctl);
  }
});

test('the rate is typed in place, not into a native prompt', () => {
  /* prompt() is the control this app spent a release removing: it cannot be
     styled, it stops the page, and on a phone it is a grey box that says
     "Enter a number". The rate box is part of the trip page and opens in place. */
  const H = strip(read('westmere-owner.html'));
  for (const fn of ['owJobRateOpen', 'owJobRateSave', 'owJobRateClose']) {
    assert.ok(H.includes('function ' + fn + '('), fn + ' is missing');
  }
  assert.ok(!/prompt\(/.test(fnBody(H, 'owJobRateSave')), 'the rate still comes from a prompt box');
  assert.ok(/jr-pct-/.test(fnBody(H, 'owDrvTripHtml')), 'the trip page has no rate input to open');
});

test('a cash job does not claim the fare is going to him', () => {
  /* He was paid at the kerb. "£189.00 to him" is true of a prepaid job and
     nonsense on a cash one, where what moves is the commission he owes back. */
  const fn = fnBody(strip(read('westmere-owner.html')), 'owDrvTripHtml');
  assert.ok(/cash \?[\s\S]{0,80}He owes you/.test(fn),
    'the working line reads the same for cash and prepaid');
});

test('a payment with nowhere to go is reported, and stays out of the balance', () => {
  /* He pays what he pays, when he pays it, so a payment can overshoot. It must
     not quietly reduce a balance made of jobs — that is the second truth all
     over again — and it must not vanish either. */
  const d = seedDriver();
  seedJob(d, { fare: 100 });                    // +90 owed
  const r = ledger.applyPayment(d, 120);
  assert.strictEqual(r.unapplied, 30, 'the £30 over must be reported');
  assert.strictEqual(ledger.driverBalance(d), 0, 'and must not take the balance negative');
  const s = ledger.driverSettlements(d)[0];
  assert.strictEqual(s.applied.unapplied, 30, 'the receipt must carry it for the screen to state');
  const H = strip(read('westmere-owner.html'));
  assert.ok(/no job claimed/.test(fnBody(H, 'owDriverLoad')),
    'the driver page does not say that money was handed over with nothing to put it against');
});

test('the three row actions go to the server and reload', () => {
  const H = strip(read('westmere-owner.html'));
  for (const [fn, url, method] of [
    ['owJobPaid', '/driver-settled', 'PATCH'],
    ['owJobCommission', '/commission', 'PATCH'],
    ['owJobRateSave', '/commission', 'PATCH']
  ]) {
    const body = fnBody(H, fn.replace('async function ', ''));
    assert.ok(body.includes(url), fn + ' does not call ' + url);
    assert.ok(body.includes("method: '" + method + "'"), fn + ' must ' + method);
    assert.ok(/owDriverLoad\(\)/.test(body),
      fn + ' must redraw from the server — a row that updates itself is a second opinion');
  }
});

test('the Drivers tab can add a driver, with the car, the plate and the rate', () => {
  const H = read('westmere-owner.html');
  for (const id of ['nd-name', 'nd-email', 'nd-phone', 'nd-car', 'nd-reg', 'nd-pct', 'nd-login']) {
    assert.ok(H.includes('id="' + id + '"'), 'the add-driver form has no ' + id);
  }
  /* It belongs to the Drivers tab: above the tab bar it was on screen while
     the owner was looking at operators. */
  const pane = H.indexOf('id="drivers-pane"');
  const card = H.indexOf('id="add-driver-card"');
  const tabs = H.indexOf('id="tab-drivers"');
  assert.ok(card > pane && pane > tabs, 'the add-driver card is not inside the Drivers pane');
  const fn = fnBody(strip(H), 'createDriver');
  assert.ok(/with_login:\s*login/.test(fn), 'the login choice must reach the server');
  assert.ok(/commission_pct:/.test(fn) && /vehicle:/.test(fn) && /reg:/.test(fn),
    'the car, the plate and the rate must be sent');
});

test('the Operators tab can add an operator', () => {
  const H = strip(read('westmere-owner.html'));
  const fn = fnBody(H, 'owAddOperatorHtml');
  for (const id of ['no-company', 'no-email', 'no-addr', 'no-post']) {
    assert.ok(fn.includes("'" + id + "'"), 'the add-operator form has no ' + id);
  }
  const create = fnBody(H, 'createOperator');
  assert.ok(/is_operator: true/.test(create), 'it must flag them as an operator');
  assert.ok(/\/api\/customers/.test(create),
    'an operator is a customer row — a second table is the thing this model exists to avoid');
  assert.ok(/owLoadOperators\(\)/.test(create), 'and the list must redraw');
  const load = fnBody(H, 'owLoadOperators');
  assert.ok((load.match(/owAddOperatorHtml\(\)/g) || []).length >= 2,
    'the card must be there whether or not the list is empty');
});

// ── 6. NOTHING ELSE MOVED ────────────────────────────────────────────────
test('turnover still counts only what is ours', () => {
  const d = seedDriver();
  const own = db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
                          VALUES ('WPH-T1','A','B','2026-09-01','07:00',1,120,'card','completed')`).run();
  const kept = db.prepare("SELECT * FROM bookings WHERE ref = 'WPH-T1'").get();
  const passedJob = seedJob(d, { fare: 100, pct: 10 });
  assert.strictEqual(ledger.westmereIncome(kept), 120, 'our own work is worth its fare');
  assert.strictEqual(ledger.westmereIncome(rowOf(passedJob.id)), 10, 'a passed job is worth its commission');
  /* And settling a job changes nothing about what it earned. */
  ledger.setJobSettled(passedJob.id, true);
  assert.strictEqual(ledger.westmereIncome(rowOf(passedJob.id)), 10,
    'paying a driver changed the turnover — the two are different questions');
});

test('the migration works on a database that has never seen the new column', () => {
  /* THE ONLY BOOT THAT MATTERS is the first one after the deploy, and that is
     the one this got wrong: the call sat seventy lines ABOVE the ALTER that
     adds `driver_settled`, so on the first boot it threw, swallowed its own
     error, and left every driver's balance showing payments they had already
     been given — £75 became £255 in the dry run.

     So the function must stand on its own ground: run it against a database
     where the column is absent and it must still reconcile. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, date: '2026-09-01' });
  db.prepare('INSERT INTO driver_settlements (driver_id, amount, paid_on) VALUES (?,?,?)').run(d, 90, '2026-09-05');
  /* Put the database back the way it was before this feature existed. */
  db.exec('ALTER TABLE bookings DROP COLUMN driver_settled');
  db.exec('ALTER TABLE driver_settlements DROP COLUMN applied_json');
  assert.throws(() => db.prepare('SELECT driver_settled FROM bookings LIMIT 1').get(),
    'the column should be gone for this test to mean anything');

  const { runSettlementMigration } = require('../db');
  runSettlementMigration();
  assert.strictEqual(ledger.isSettled(rowOf(a.id)), true,
    'the migration did not reconcile a database it had to add its own column to');
  assert.strictEqual(ledger.driverBalance(d), 0, 'and the balance would have jumped back to £90');
});

test('it is the LAST thing migrate() does, after every column it reads', () => {
  /* Belt to the braces above: the call is where it belongs in the file, so the
     next column added to bookings does not quietly reopen the same hole. */
  /* Read inside migrate() only. The function itself also adds the column —
     that is the belt — so a search of the whole file would find that one and
     compare the call against the wrong line. */
  const src = strip(read('server/db.js'));
  const { regionFrom } = require('./_source');
  const migrate = regionFrom(src, '\nfunction migrate(', [/\nfunction seedDefaults\(/]);
  const call = migrate.indexOf('runSettlementMigration();');
  const alter = migrate.indexOf('ALTER TABLE bookings ADD COLUMN driver_settled');
  assert.ok(call > -1, 'migrate() no longer runs the settlement migration at all');
  assert.ok(alter > -1, 'migrate() no longer adds the column');
  assert.ok(call > alter,
    'runSettlementMigration() runs before the column it reads is added — on a first boot it throws and every paid job comes back');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('driver-settlement.test.js'),
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
