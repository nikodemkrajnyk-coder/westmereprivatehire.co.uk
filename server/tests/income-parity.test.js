/**
 * WHAT THE FIRM EARNED — run with:
 *   node server/tests/income-parity.test.js   (also gated by `npm test`)
 *
 * The owner looked at a Tuesday with two jobs on it and the admin dashboard
 * told him he had earned £192. One of the two had been driven by Gary, who was
 * paid £85.50 of it. The tile had added the FARES up.
 *
 * It is the same mistake the server's turnover made before it was fixed, and
 * the reason it came back is that the fix was made in SQL: the dashboard draws
 * its figures from the list of bookings the page already has, in the browser,
 * where none of that rule existed. So the rule now exists in both places —
 * server/driver-ledger.js westmereIncome() and wm-lifecycle.js
 * westmereIncome() — and this file drives BOTH over the same jobs and requires
 * the same answer to the penny. A copy nobody checks is how two answers to one
 * question get shipped.
 *
 * It also pins the screens: no earnings figure may be a sum of fares.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LC = require('../../wm-lifecycle');
const ledger = require('../driver-ledger');

/* Every shape of job the business actually has. The commission on a passed job
   is whatever was STORED — a driver on 12.5%, a cover job at nothing — because
   that is what the job was passed on at. */
const JOBS = [
  ['his own card job',              { fare: 95, payment: 'card', status: 'completed' }],
  ['his own cash job',              { fare: 165, payment: 'cash', status: 'completed' }],
  ['passed to a driver at 10%',     { fare: 95, passed_at: 'x', driver_id: 7, admin_fee: 9.5, driver_pay: 85.5 }],
  ['passed to a driver at 12.5%',   { fare: 80, passed_at: 'x', driver_id: 8, admin_fee: 10, driver_pay: 70 }],
  ['a cover job at no commission',  { fare: 120, passed_at: 'x', driver_id: 9, admin_fee: 0, driver_pay: 120 }],
  ['an agreed payout',              { fare: 95, passed_at: 'x', driver_id: 7, admin_fee: 9.5, driver_pay: 85.5, driver_payout_set: 70 }],
  ['passed to another FIRM',        { fare: 165, passed_at: 'x', operator_id: 31 }],
  ['passed, nothing stored',        { fare: 95, passed_at: 'x', driver_id: 7 }],
  ['an unpriced job',               { fare: null, status: 'pending' }],
  ['a fare that is a string',       { fare: '95.00', status: 'completed' }],
  ['nothing at all',                {}]
];

// ── 1. ONE ANSWER, TWO IMPLEMENTATIONS ────────────────────────────────────
console.log('\nThe browser and the server agree about what was earned');

test('every shape of job earns the same, to the penny, in both', () => {
  for (const [what, job] of JOBS) {
    const client = LC.westmereIncome(job);
    const server = ledger.westmereIncome(job);
    assert.strictEqual(client, server,
      what + ': the dashboard says £' + client + ' and the server says £' + server);
  }
});

test('and the two agree about WHO drove it, which is what decides it', () => {
  /* The browser reads a booking in two spellings — the owner app camel-cases
     the row on its way in, the admin app uses it raw — and both must reach the
     same answer, or one app's figures are the other's with the passed jobs
     counted whole. */
  const raw   = { fare: 95, passed_at: 'x', driver_id: 7, driver_name: 'Gary', admin_fee: 9.5 };
  const camel = { fare: 95, passedAt: 'x', driverName: 'Gary', admin_fee: 9.5 };
  assert.strictEqual(LC.whoDrove(raw).kind, 'driver');
  assert.strictEqual(LC.whoDrove(camel).kind, 'driver');
  assert.strictEqual(LC.westmereIncome(raw), LC.westmereIncome(camel),
    'the same job earns differently depending on which app is holding it');

  assert.strictEqual(LC.whoDrove({ fare: 95 }).kind, 'own', 'an unpassed job is his own');
  assert.strictEqual(LC.whoDrove({ fare: 95, driver_id: 7, driver_name: 'Gary' }).kind, 'own',
    'EVERY confirmed job has a driver_id — his own. Only passed_at makes it somebody else’s');
  assert.strictEqual(LC.whoDrove({ passed_at: 'x', operator_id: 31, operator_name: 'Harding' }).kind, 'firm');
  assert.strictEqual(LC.whoDrove({ passed_at: 'x', operatorName: 'Harding' }).name, 'Harding');
});

test('the house rate is one number, not two', () => {
  const srv = strip(read('server/driver-ledger.js'));
  const cli = strip(read('wm-lifecycle.js'));
  const grab = (src) => {
    const m = /ADMIN_FEE_PCT\s*=\s*([0-9.]+)/.exec(src);
    assert.ok(m, 'ADMIN_FEE_PCT is gone');
    return Number(m[1]);
  };
  assert.strictEqual(grab(cli), grab(srv),
    'the browser and the server disagree about the house commission rate');
  assert.strictEqual(LC.ADMIN_FEE_PCT, ledger.ADMIN_FEE_PCT != null ? ledger.ADMIN_FEE_PCT : grab(srv));
});

// ── 2. THE DAY THAT STARTED IT ────────────────────────────────────────────
console.log('\nThe Tuesday the dashboard got wrong');

test('two jobs, £192 of fares, one driven by Gary — the day earned £106.50', () => {
  const day = [
    { fare: 97, payment: 'card', status: 'completed', paid_at: 'x' },
    { fare: 95, payment: 'card', status: 'completed', paid_at: 'x',
      passed_at: 'x', driver_id: 7, driver_name: 'Gary Mitchell', admin_fee: 9.5, driver_pay: 85.5 }
  ];
  const fares  = day.reduce((s, b) => s + Number(b.fare), 0);
  const earned = Math.round(day.reduce((s, b) => s + LC.westmereIncome(b), 0) * 100) / 100;
  assert.strictEqual(fares, 192, 'the fares');
  assert.strictEqual(earned, 106.5, 'what was actually his');
  assert.notStrictEqual(earned, fares, 'the whole point');
});

test('a month of mixed work: the header figure is income, the takings are kept too', () => {
  const g = LC.groupByMonth([
    { date: '2026-10-09', fare: 95, status: 'completed' },
    { date: '2026-10-02', fare: 95, status: 'completed', passed_at: 'x', driver_id: 7, admin_fee: 9.5 },
    { date: '2026-10-05', fare: 85, status: 'cancelled' },
    { date: '2026-10-07', fare: 165, status: 'completed', passed_at: 'x', operator_id: 31 }
  ])[0];
  assert.strictEqual(g.takings, 355, 'what came through the business');
  assert.strictEqual(g.income, 269.5, 'what was ours of it');
  assert.strictEqual(g.cancelled, 1, 'and a cancelled journey earns nothing either way');
});

// ── 3. NO SCREEN MAY ADD FARES UP AND CALL IT EARNINGS ────────────────────
console.log('\nNo earnings figure is a sum of fares');

test('the admin dashboard tiles ask the shared rule', () => {
  const src = strip(read('westmere-admin.html'));
  const fn = fnBlock(src, 'loadLiveBookings');
  assert.ok(fn, 'loadLiveBookings is gone');
  assert.ok(/WMLifecycle\.westmereIncome/.test(fn),
    "today's earnings is not going through the shared income rule");
  assert.ok(!/(todayRev|monthRev)\s*=\s*[^;]*reduce\([^;]*\bfare\b/.test(fn),
    'a dashboard earnings figure is still a sum of fares');
  assert.ok(/westmereIncome\(b\)/.test(fn) && /weekCompare/.test(fn),
    'the week-against-last-week line still compares fares while the cards show income');
});

test("the admin dashboard's today is the UK day, not the host's", () => {
  const fn = fnBlock(strip(read('westmere-admin.html')), 'loadLiveBookings');
  assert.ok(/toLocaleDateString\('sv-SE',\{timeZone:'Europe\/London'\}\)/.test(fn),
    "today is read with toISOString — which is yesterday between midnight and 1am BST");
  assert.ok(!/var today=new Date\(\)\.toISOString\(\)/.test(fn), 'the UTC date is back');
});

test("the owner's earnings page asks the same rule", () => {
  const src = strip(read('westmere-owner.html'));
  const fn = fnBlock(src, 'buildEarnings');
  assert.ok(fn, 'buildEarnings is gone');
  assert.ok(/WMLifecycle\.westmereIncome/.test(fn), 'the earnings page is not using the shared rule');
  for (const name of ['todayTotal', 'monthTotal', 'totalRev']) {
    assert.ok(!new RegExp(name + "\\s*=\\s*[^;]*reduce\\([^;]*\\+b\\.fare").test(fn),
      name + ' is still a sum of fares');
  }
  assert.ok(/weeks\[k\]\.total\+=earned\(b\)/.test(fn), 'the weekly totals still add fares up');
  /* THE SENTENCE UNDER THE CARDS COUNTS TOO. This line was still adding fares
     up after the three figures above it had moved, so one screen gave two
     answers to "how is the week going" — and the bigger, wrong one was the one
     written out in words. */
  assert.ok(/weekCompare\(bookings,earned\)/.test(fn),
    'the week-against-last-week line still compares FARES while the cards show income');
  assert.ok(!/weekCompare\([^)]*Number\(b\.fare\)/.test(fn), 'the fare comparison is back');
  /* THE AVERAGE FARE IS STILL A FARE. What a journey costs a customer and what
     the firm keeps of it are different questions; this row asks the first. */
  assert.ok(/totalFares/.test(fn) && /totalFares\/totalJobs/.test(fn),
    'the average fare must still average FARES, not income');
  assert.ok(/toLocaleDateString\('sv-SE',\{timeZone:'Europe\/London'\}\)/.test(fn),
    "the earnings page's today is still the host's, not the UK's");
});

test('a cancelled journey earns nothing, even when it was paid for', () => {
  /* A cancelled booking keeps its paid_at until somebody refunds it, and the
     owner's earnings test asked only whether the money had ARRIVED — so a
     journey that never ran sat in the day's total. Trip History has said "it
     did not run, so it counts nothing" for months; this is the same rule where
     the money is added up. Found while checking his figures were his own. */
  const fn = fnBlock(strip(read('westmere-owner.html')), 'isEarning');
  assert.ok(fn, 'isEarning is gone');
  assert.ok(/statusOf\(b\)==='cancelled'\)return false/.test(fn),
    'a cancelled booking that was paid for still counts as earnings');
  const cancelledPaid = { date: '2026-10-05', fare: 85, status: 'cancelled', paid_at: '2026-09-30 11:20' };
  /* and the shared rule agrees about what it is */
  assert.strictEqual(LC.statusOf(cancelledPaid), 'cancelled');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/income-parity\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
