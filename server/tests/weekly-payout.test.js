/**
 * THE WEEKLY DRIVER PAYOUT — run with:
 *   node server/tests/weekly-payout.test.js   (also gated by `npm test`)
 *
 * THE OWNER'S MONDAY, in his words: jobs accumulate through the week unpaid;
 * on Monday he wants ONE figure per driver, makes ONE bank transfer by hand,
 * and ticks the whole week off in ONE action rather than tapping each job.
 *
 * WHY THIS FILE EXISTS
 *   A batch settle is the exact move that could quietly reintroduce the second
 *   truth this system spent a release removing. Mark a week paid by recording
 *   a lump payment and the balance and the job ticks are two records of the
 *   same money again. So "mark the week paid" is not a payment at all — it is
 *   the per-job tick, applied to a known set of jobs, with one receipt kept
 *   beside them so the act can be taken back whole.
 *
 *   Everything here is therefore about agreement:
 *     • the total is the sum of what the jobs are worth, never typed;
 *     • it is net of EACH JOB'S OWN commission — a cover job pays the whole
 *       fare, a commission job nets the rate, a cash job pulls the other way
 *       because the driver is holding our money;
 *     • after the batch, every job in it reads paid AND the balance is zero;
 *     • undo puts exactly those jobs back and nothing else.
 *
 * AND THE WEEK ITSELF is wall-clock. A pay week drawn from a parsed instant is
 * a day out west of UTC, which puts a job in the wrong transfer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-payout-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const api = require('../api');
const LC = require('../../wm-lifecycle');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { stripComments: strip } = require('./_source');
const { fnBlock } = require('./_source');

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
    .run('pdrv' + (++seq) + Date.now().toString(36), 'Payout Driver ' + seq,
         'p' + seq + '@example.com', pct === undefined ? null : pct);
  return info.lastInsertRowid;
}
/** A job already passed to the driver, priced at `pct` commission. */
function seedJob(driverId, over) {
  const o = Object.assign({ fare: 100, payment: 'card', pct: 10, date: '2026-10-07' }, over || {});
  const split = ledger.computeSplit(o.fare, o.pct / 100);
  const ref = 'WPH-P' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                    driver_id,driver_pay,admin_fee,passed_at)
              VALUES (?,?,?,?,?,1,?,?,'completed',?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick', o.date, '07:00', o.fare, o.payment, driverId,
         split.driver_pay, split.admin_fee, o.date);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const WEEK = '2026-10-07';                      // a Wednesday: Mon 5 → Sun 11

// ── 1. THE PAY WEEK IS WALL-CLOCK ────────────────────────────────────────
console.log('\nThe pay week is the same week on every machine');

test('a week runs Monday to Sunday, from the components', () => {
  assert.deepStrictEqual(LC.weekBounds('2026-10-07'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepStrictEqual(LC.weekBounds('2026-10-05'), { from: '2026-10-05', to: '2026-10-11' },
    'the Monday itself belongs to its own week');
  assert.deepStrictEqual(LC.weekBounds('2026-10-11'), { from: '2026-10-05', to: '2026-10-11' },
    'and so does the Sunday');
  assert.deepStrictEqual(LC.weekShift('2026-10-07', -1), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepStrictEqual(LC.weekShift('2026-10-07', 1), { from: '2026-10-12', to: '2026-10-18' });
  assert.strictEqual(LC.payWeekLabel(LC.weekBounds('2026-10-07')), 'Mon 5 Oct – Sun 11 Oct 2026');
});

test('it never parses the date as an instant', () => {
  /* `new Date('2026-10-05')` is UTC midnight read back locally — Sunday the
     4th west of UTC, which moves the whole pay week by a day and puts a job in
     the wrong transfer. The source must do UTC component arithmetic.
     See the timezone invariant in CLAUDE.md. */
  const src = fnBlock(strip(read('wm-lifecycle.js')), 'weekBounds');
  assert.ok(/Date\.UTC\(/.test(src), 'weekBounds must build its dates with Date.UTC');
  assert.ok(!/new Date\(\s*(ymd|String\(ymd)/.test(src),
    'weekBounds must never parse the date string into a Date');
  assert.ok(/getUTCDay/.test(src), 'the day of the week must be read in UTC too');
  // A month boundary and a year boundary, which is where off-by-one lives.
  assert.deepStrictEqual(LC.weekBounds('2026-01-01'), { from: '2025-12-29', to: '2026-01-04' });
  assert.deepStrictEqual(LC.weekBounds('2026-03-29'), { from: '2026-03-23', to: '2026-03-29' },
    'the clocks going forward must not move the week');
});

// ── 2. THE TOTAL IS NET, PER JOB ─────────────────────────────────────────
console.log("\nThe figure he types into the bank");

test('the total nets each job by ITS OWN commission setting', () => {
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10 });          // commission job → £90 to him
  seedJob(d, { fare: 200, pct: 0 });           // COVER job      → £200, the whole fare
  seedJob(d, { fare: 150, pct: 20 });          // a different rate → £120
  const p = ledger.unpaidUpTo(d, '2026-10-11', { from: '2026-10-05' });
  assert.strictEqual(p.items.length, 3);
  assert.strictEqual(p.total, 410, '90 + 200 + 120 — each job on its own rate');
  const byRef = {};
  p.items.forEach((i) => { byRef[i.fare] = i.outstanding; });
  assert.strictEqual(byRef[200], 200, 'a cover job pays the driver the WHOLE fare');
  assert.strictEqual(byRef[100], 90);
  assert.strictEqual(byRef[150], 120);
  assert.strictEqual(p.total, ledger.driverBalance(d), 'the payout and the balance are one figure');
});

test('a cash job pulls the other way, and the transfer is the net', () => {
  /* He collected the fare at the kerb, so what moves is the commission he owes
     back. One transfer settles both directions — which is what the owner
     actually does at the bank. */
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10 });                      // +90 to him
  seedJob(d, { fare: 210, pct: 10, payment: 'cash' });     // −21 he owes us
  const p = ledger.unpaidUpTo(d, '2026-10-11', { from: '2026-10-05' });
  assert.strictEqual(p.total, 69, '90 owed less the 21 he is holding');
  assert.strictEqual(p.total, ledger.driverBalance(d));
});

test('nothing is typed: the total is the sum of the jobs', () => {
  const src = fnBlock(strip(read('server/driver-ledger.js')), 'settleBatch');
  assert.ok(/outstandingOn\(b\)/.test(src), 'each job is settled for what it is worth');
  assert.ok(!/req\.body|opts\.amount|o\.amount/.test(src),
    'a batch must never take an amount from the caller — that is the second truth');
});

// ── 3. ONE ACTION, THE WHOLE WEEK ────────────────────────────────────────
console.log('\nOne action settles the week');

test('the batch marks exactly those jobs paid, and the balance goes to zero', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  const b = seedJob(d, { fare: 200, pct: 0, date: '2026-10-08' });
  const later = seedJob(d, { fare: 80, pct: 10, date: '2026-10-19' });   // NEXT week
  assert.strictEqual(ledger.driverBalance(d), 362);

  const r = await call('post', '/drivers/:id/payout',
    { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.total, 290, '90 + 200');
  assert.strictEqual(r.body.settled.length, 2);

  assert.strictEqual(ledger.isSettled(rowOf(a.id)), true, 'the week\'s jobs read paid');
  assert.strictEqual(ledger.isSettled(rowOf(b.id)), true);
  assert.strictEqual(ledger.isSettled(rowOf(later.id)), false,
    'a job dated after the week must NOT be swept into it');
  assert.strictEqual(ledger.driverBalance(d), 72, 'only next week\'s job is left');
});

test('…and with nothing left after it, the balance really is zero', async () => {
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  seedJob(d, { fare: 210, pct: 10, date: '2026-10-09', payment: 'cash' });
  const r = await call('post', '/drivers/:id/payout',
    { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.total, 69);
  assert.strictEqual(r.body.balance, 0, 'paying the week out clears him');
  assert.strictEqual(ledger.driverBalance(d), 0);
});

test('it sweeps up what was missed in earlier weeks, and says so', async () => {
  /* A job missed a fortnight ago is money he is still owed. A payout that
     stepped over it would leave a "paid up" driver whose balance never
     reaches zero — which is the one thing the owner asked this to do. */
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10, date: '2026-09-21' });    // three weeks back
  seedJob(d, { fare: 100, pct: 10, date: '2026-10-07' });    // this week
  const view = await call('get', '/drivers/:id/payout',
    { params: { id: String(d) }, query: { week: WEEK } });
  assert.strictEqual(view.statusCode, 200, JSON.stringify(view.body));
  assert.strictEqual(view.body.items.length, 2);
  assert.strictEqual(view.body.total, 180);
  assert.strictEqual(view.body.carried, 1, 'the older one must be counted as carried over');
  assert.strictEqual(view.body.carried_total, 90, '…and named, so the figure is explainable');
  assert.strictEqual(view.body.items.filter((i) => i.carried).length, 1);

  const r = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.body.total, 180);
  assert.strictEqual(ledger.driverBalance(d), 0);
});

test('a job already paid by hand is not paid twice', async () => {
  /* The per-job instant tick stays — he pays some drivers on the spot. A job
     settled that way must simply not be in the week's batch. */
  const d = seedDriver();
  const paid = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  const owed = seedJob(d, { fare: 100, pct: 10, date: '2026-10-07' });
  ledger.setJobSettled(paid.id, true);
  const view = await call('get', '/drivers/:id/payout',
    { params: { id: String(d) }, query: { week: WEEK } });
  assert.strictEqual(view.body.items.length, 1, 'the hand-paid job is out of the batch');
  assert.strictEqual(view.body.total, 90);
  const r = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.body.total, 90);
  assert.strictEqual(Number(rowOf(paid.id).driver_settled), 90, 'and keeps its own tick, untouched');
  assert.strictEqual(ledger.driverBalance(d), 0);
});

test('a week with nothing in it is refused, not recorded as an empty payment', async () => {
  const d = seedDriver();
  const r = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/nothing unpaid/i.test(r.body.error));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM driver_settlements WHERE driver_id = ?').get(d).n, 0);
});

test('a week that changed under him is refused rather than guessed at', async () => {
  /* He opens the payout, a job completes, he presses the button. Settling a
     list he never saw — for a total he never read — is how a driver gets paid
     the wrong amount and nobody notices. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  const b = seedJob(d, { fare: 100, pct: 10, date: '2026-10-07' });
  const r = await call('post', '/drivers/:id/payout',
    { params: { id: String(d) }, body: { week: WEEK, job_ids: [a.id] } });   // b arrived late
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/reopen/i.test(r.body.error), 'it must say what to do: ' + r.body.error);
  assert.strictEqual(ledger.driverBalance(d), 180, 'and settle nothing at all');
});

test('a zero-net week still settles its jobs', async () => {
  /* One prepaid job and one cash job of the same size square each other. No
     money leaves the bank and the jobs still have to be ticked — and the act
     still has to be undoable, so the receipt is still written. */
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });                    // +90
  seedJob(d, { fare: 900, pct: 10, date: '2026-10-07', payment: 'cash' });   // −90
  const r = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.total, 0);
  assert.strictEqual(r.body.settled.length, 2, 'both jobs are squared');
  assert.strictEqual(ledger.driverBalance(d), 0);
  assert.ok(r.body.settlement_id, 'and the receipt exists, so it can be undone');
});

// ── 4. UNDOABLE, EXACTLY ─────────────────────────────────────────────────
console.log('\nA payout can be taken back');

test('undoing the week re-opens exactly its jobs', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  const b = seedJob(d, { fare: 200, pct: 0, date: '2026-10-07' });
  const later = seedJob(d, { fare: 80, pct: 10, date: '2026-10-19' });
  const paid = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(ledger.driverBalance(d), 72);

  const undo = await call('delete', '/drivers/:id/settlements/:sid',
    { params: { id: String(d), sid: String(paid.body.settlement_id) } });
  assert.strictEqual(undo.statusCode, 200, JSON.stringify(undo.body));
  assert.strictEqual(undo.body.reopened, 2);
  assert.strictEqual(ledger.isSettled(rowOf(a.id)), false, 'the jobs are owed again');
  assert.strictEqual(ledger.isSettled(rowOf(b.id)), false);
  assert.strictEqual(ledger.isSettled(rowOf(later.id)), false, 'and the one it never touched is unchanged');
  assert.strictEqual(ledger.driverBalance(d), 362, 'the balance is exactly where it started');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM driver_settlements WHERE driver_id = ?').get(d).n, 0);
});

test('undoing a payout leaves a job\'s OTHER payment alone', async () => {
  /* Fifty pounds off a ninety-pound job by hand, then the week pays the forty.
     Undoing the week must take back forty, not wipe the job and lose the fifty
     with it — the receipt records the amount per job for exactly this. */
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });   // +90
  ledger.applyPayment(d, 50);                                         // part paid by hand
  assert.strictEqual(ledger.driverBalance(d), 40);
  const paid = await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  assert.strictEqual(paid.body.total, 40, 'the week pays only what is LEFT on the job');
  assert.strictEqual(ledger.driverBalance(d), 0);

  await call('delete', '/drivers/:id/settlements/:sid',
    { params: { id: String(d), sid: String(paid.body.settlement_id) } });
  assert.strictEqual(ledger.driverBalance(d), 40, 'back to what was still owed, not to 90');
  assert.strictEqual(Number(rowOf(a.id).driver_settled), 50, 'the hand payment survives');
});

// ── 5. ONE TRUTH, STILL ──────────────────────────────────────────────────
console.log('\nStill one truth, not two');

test('the balance never reads the settlements table', () => {
  const src = fnBlock(strip(read('server/driver-ledger.js')), 'driverBalance');
  assert.ok(!/driver_settlements/.test(src),
    'driverBalance must stay a sum over the JOBS — a batch payout changes nothing about that');
});

test('a paid week shows as paid on every surface that asks', async () => {
  const d = seedDriver();
  const a = seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  await call('post', '/drivers/:id/payout', { params: { id: String(d) }, body: { week: WEEK } });
  // The ledger the driver page draws…
  const led = await call('get', '/drivers/:id/ledger', { params: { id: String(d) }, query: {} });
  const row = led.body.items.find((i) => i.id === a.id);
  assert.strictEqual(row.paid, true, 'the per-job tick and the batch are the same fact');
  assert.strictEqual(led.body.balance, 0);
  // …and the receipt names the week it paid.
  assert.strictEqual(led.body.settlements.length, 1);
  assert.ok(/2026-10-05/.test(led.body.settlements[0].note || ''),
    'the receipt must say which week it was: ' + led.body.settlements[0].note);
  assert.ok(led.body.settlements[0].applied.batch, 'and that it was a batch, not a typed payment');
});

test('the Monday round totals every driver he owes', async () => {
  const a = seedDriver(), b = seedDriver(), c = seedDriver();
  seedJob(a, { fare: 100, pct: 10, date: '2026-10-06' });                    // +90
  seedJob(b, { fare: 200, pct: 0, date: '2026-10-07' });                     // +200
  seedJob(c, { fare: 210, pct: 10, date: '2026-10-07', payment: 'cash' });   // −21, HE owes US
  const r = await call('get', '/drivers/payouts', { query: { week: WEEK } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const by = {}; r.body.drivers.forEach((d) => { by[d.id] = d; });
  assert.strictEqual(by[a].total, 90);
  assert.strictEqual(by[b].total, 200);
  assert.strictEqual(by[c].total, -21);
  /* The money to SEND, not a net of both directions: a figure covering the
     driver who owes him is not a figure he can transfer. */
  assert.ok(r.body.to_pay_total >= 290, 'the round total must include both drivers he owes');
  assert.ok(!r.body.drivers.some((d) => d.total === null), 'no driver may come back unreadable');
});

// ── 6. WHO MAY DO IT ─────────────────────────────────────────────────────
test('a driver cannot pay his own week out', async () => {
  const d = seedDriver();
  seedJob(d, { fare: 100, pct: 10, date: '2026-10-06' });
  for (const [m, p] of [['get', '/drivers/:id/payout'], ['post', '/drivers/:id/payout']]) {
    const r = await call(m, p, { params: { id: String(d) }, body: { week: WEEK }, query: { week: WEEK }, role: 'driver' });
    assert.strictEqual(r.statusCode, 403, m + ' ' + p + ' must be staff-only');
  }
  assert.strictEqual(ledger.driverBalance(d), 90);
});

// ── 7. THE SCREEN ────────────────────────────────────────────────────────
console.log('\nThe screen he does it from');

test('both apps have a weekly payout block on the driver page', () => {
  const O = strip(read('westmere-owner.html'));
  const A = strip(read('westmere-admin.html'));
  assert.ok(/id="ow-payout"/.test(O), 'the owner driver page needs the payout block');
  assert.ok(/id="dm-payout"/.test(A), 'the admin driver panel needs the payout block');
  for (const [who, src, load] of [['owner', O, 'owPayoutLoad'], ['admin', A, 'dmPayoutLoad']]) {
    assert.ok(src.includes('function ' + load), who + ' has no ' + load);
    assert.ok(/\/payout/.test(fnBlock(src, load)), who + ' must read the shared payout route');
  }
});

test('the screen adds nothing up — the total comes from the server', () => {
  for (const [who, file, fn] of [['owner', 'westmere-owner.html', 'owPayoutHtml'],
                                 ['admin', 'westmere-admin.html', 'dmPayoutHtml']]) {
    const src = fnBlock(strip(read(file)), fn);
    assert.ok(/d\.total/.test(src), who + ' must print the server\'s total');
    assert.ok(!/reduce\(|\.map\([^)]*fare[^)]*\)\s*\./.test(src),
      who + ' must not re-derive the figure in the browser — that is the second truth');
    assert.ok(/d\.carried/.test(src), who + ' must say when the payout clears earlier weeks too');
    assert.ok(/Mark week as paid/.test(src), who + ' needs the one-tap settle');
    assert.ok(/WMCompact\.payoutTable/.test(src), who + ' must list the jobs the figure is made of');
  }
});

test('the settle call sends the week AND the ids that were on screen', () => {
  for (const [who, file, fn] of [['owner', 'westmere-owner.html', 'owPayoutSettle'],
                                 ['admin', 'westmere-admin.html', 'dmPayoutSettle']]) {
    const src = fnBlock(strip(read(file)), fn);
    assert.ok(/method: *'POST'|method:'POST'/.test(src), who + ' must POST the payout');
    assert.ok(/job_ids/.test(src), who + ' must send the ids it showed, so a changed week is caught');
    assert.ok(/week: *d\.week\.from|week:d\.week\.from/.test(src), who + ' must name the week it settled');
    assert.ok(!/amount/.test(src), who + ' must never send an amount — the jobs decide it');
    assert.ok(/WMAsk\.confirm/.test(src), who + ' must confirm before moving money, in a light card');
  }
});

test('the button says the transfer comes FIRST', () => {
  /* He pays at the bank and then tells the system. A button that reads like it
     sends the money is the one misreading that would matter. */
  for (const file of ['westmere-owner.html', 'westmere-admin.html']) {
    const src = read(file);
    assert.ok(/transfer first/i.test(src), file + ' must say the transfer happens first');
    assert.ok(/undo/i.test(src), file + ' must say the payout can be undone');
  }
});

test('the roster says what the whole Monday costs, in both apps', () => {
  const O = strip(read('westmere-owner.html'));
  const A = strip(read('westmere-admin.html'));
  assert.ok(/id="drv-week"/.test(O) && /id="adm-week-round"/.test(A),
    'both rosters need the week line');
  for (const [who, src, fn] of [['owner', O, 'owWeekRound'], ['admin', A, 'admWeekRound']]) {
    const body = fnBlock(src, fn);
    assert.ok(/\/api\/drivers\/payouts/.test(body), who + ' must read the shared round route');
    assert.ok(/d\.to_pay_total/.test(body), who + ' must print the server\'s figure');
    assert.ok(!/reduce\(/.test(body), who + ' must not total the drivers itself');
    assert.ok(/display *= *'none'|style\.display='none'/.test(body),
      who + ' must hide the line when there is nobody to pay — and when the call fails');
  }
});

test('the per-job instant tick is still there beside it', () => {
  /* "I pay drivers instantly sometimes" — the weekly batch is an addition, not
     a replacement, and both write the same field. */
  for (const [file, fn] of [['westmere-owner.html', 'owDrvTripHtml'], ['westmere-admin.html', 'admDrvTripHtml']]) {
    const src = fnBlock(strip(read(file)), fn);
    assert.ok(/Mark paid/.test(src), file + ' lost the per-job tick');
  }
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('weekly-payout.test.js'),
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
