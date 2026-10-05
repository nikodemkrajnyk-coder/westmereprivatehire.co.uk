/**
 * ONE LIST OF JOURNEYS, AND YOU CAN SEE ALL OF IT — run with:
 *   node server/tests/admin-journeys.test.js   (also gated by `npm test`)
 *
 * The admin app had TWO lists of the same journeys: a compact history of
 * finished trips, and an eleven-column table of everything with the actions in
 * its last column. The owner reported two things about it and both were true.
 *
 *   CROPPED. The table was 1142px of fixed content inside a scroller that is
 *   the window less a 220px sidebar and 4rem of padding — so at anything under
 *   about 1240px its Status and Actions columns sat off the right-hand edge
 *   behind an inner scrollbar. On a laptop he could not see the end of a row.
 *
 *   TWO OF THEM. "There shouldn't be two" — and he was choosing between them
 *   by guessing which one a booking was in.
 *
 * So: one list, every journey, newest first, with the Driver column he asked
 * for, and the actions on the page a row opens rather than in an eleventh
 * column. This file pins all four, and pins that the widths cannot grow back
 * past the edge of the page.
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
const C = require('../../wm-compact');
const LC = require('../../wm-lifecycle');

// ── 1. ONE LIST ───────────────────────────────────────────────────────────
console.log('\nOne journeys list, not two');

test('the All Journeys view and its table are gone', () => {
  const src = read('westmere-admin.html');
  assert.ok(!/id="view-all-jobs"/.test(src), 'the second journeys page is still there');
  assert.ok(!/id="jobs-tbody"/.test(src), 'the eleven-column table is still being built');
  assert.ok(!/nav\('all-jobs'/.test(src), 'the sidebar still offers two journeys pages');
  assert.ok(!/'all-jobs':/.test(src), 'the router still knows a page that does not exist');
});

test('the sidebar has exactly one journeys item, and it reaches the list', () => {
  const src = read('westmere-admin.html');
  const items = src.match(/class="sb-item"[^>]*onclick="nav\('([a-z-]+)'/g) || [];
  const journeys = items.filter((x) => /'(history|all-jobs|journeys)'/.test(x));
  assert.strictEqual(journeys.length, 1,
    'there are ' + journeys.length + ' journeys items in the sidebar');
  assert.ok(/id="view-history"/.test(src), 'the one journeys view is missing');
  assert.ok(/<div class="page-title"><em>Journeys<\/em><\/div>/.test(src),
    'the page is still called something other than Journeys');
});

test('nothing left behind points at the page that was removed', () => {
  const src = strip(read('westmere-admin.html'));
  assert.ok(!/view-all-jobs/.test(src), 'the flagged banner still looks for the old view');
  assert.ok(!/filterJobs|searchJobs|toggleJDetail/.test(src),
    'a handler for the removed table is still defined');
  assert.ok(/\['view-today','view-history'\]/.test(src),
    'the needs-attention banner has nowhere to land on the journeys page');
});

// ── 2. EVERY JOURNEY, NEWEST FIRST ────────────────────────────────────────
console.log('\nEverything, newest first');

test('the list is built from EVERY booking, not only the finished ones', () => {
  const fn = fnBlock(strip(read('westmere-admin.html')), 'buildAdmHistory');
  assert.ok(fn, 'buildAdmHistory is gone');
  assert.ok(/ALL_BOOKINGS\|\|\[\]\)\.slice\(\)/.test(fn),
    'the journeys list is filtering something out — a list he has to leave is a list he has to leave');
  assert.ok(!/st==='completed'\|\|st==='cancelled'/.test(fn),
    'the list still drops everything that has not happened yet');
  assert.ok(/WMCompact\.journeyTable/.test(fn), 'the list is not using the shared columns');
});

test('months run newest first, and so do the days inside them', () => {
  const groups = LC.groupByMonth([
    { date: '2026-08-02', ref: 'OLD' },
    { date: '2026-10-09', time: '05:30', ref: 'MID' },
    { date: '2026-10-09', time: '17:00', ref: 'LATE' },
    { date: '2026-09-14', ref: 'SEP' }
  ]);
  assert.deepStrictEqual(groups.map((g) => g.label),
    ['October 2026', 'September 2026', 'August 2026'],
    'the oldest month is at the top — he asked to start at today and scroll down');
  assert.deepStrictEqual(groups[0].items.map((j) => j.ref), ['LATE', 'MID'],
    'two jobs on one day are in the wrong order');
});

// ── 3. WHO DROVE IT ───────────────────────────────────────────────────────
console.log('\nThe Driver column');

test('the columns include Driver, and the row carries the name', () => {
  const keys = C.JOURNEY_COLUMNS.map((c) => c.key);
  assert.ok(keys.indexOf('driver') !== -1, 'there is no Driver column');
  assert.strictEqual(C.JOURNEY_COLUMNS.find((c) => c.key === 'driver').label, 'Driver');

  const gary = C.journeyCells({ ref: 'A', date: '2026-10-09', fare: 95, passed_at: 'x',
                                driver_id: 7, driver_name: 'Gary Mitchell', admin_fee: 9.5 });
  assert.strictEqual(gary.driver, 'Gary Mitchell');
  const firm = C.journeyCells({ ref: 'B', date: '2026-10-10', fare: 165, passed_at: 'x',
                                operator_id: 31, operator_name: 'Harding Executive Travel' });
  assert.strictEqual(firm.driver, 'Harding Executive Travel', 'a firm is who did it too');
});

test('his own jobs leave the column blank', () => {
  /* Every confirmed job carries him as its driver, so a list that printed a
     name on every row would be a column of noise down the middle of it. The
     thing he is scanning for is the exception. */
  const mine = C.journeyCells({ ref: 'C', date: '2026-10-05', fare: 97, driver_id: 1, driver_name: 'Westmere' });
  assert.strictEqual(mine.driver, '', 'his own work must not be labelled');
});

test('the Driver column is admin’s, and the phone list is untouched', () => {
  assert.ok(C.HISTORY_COLUMNS.every((c) => c.key !== 'driver'),
    "the owner's phone list has grown a sixth column");
  const admin = strip(read('westmere-admin.html'));
  const owner = strip(read('westmere-owner.html'));
  assert.ok(/WMCompact\.journeyTable/.test(admin), 'admin is not on the wide columns');
  assert.ok(!/WMCompact\.journeyTable/.test(owner), 'the owner app has taken the desktop columns');
});

// ── 4. IT FITS ────────────────────────────────────────────────────────────
console.log('\nAnd the whole of it fits on the page');

test('the column widths add to 100 — none of it can fall off the edge', () => {
  const sum = C.JOURNEY_COLUMNS.reduce((s, c) => {
    assert.ok(/^\d+(\.\d+)?%$/.test(c.w), c.key + ' has no fixed width: ' + c.w);
    return s + parseFloat(c.w);
  }, 0);
  assert.ok(sum <= 100.01,
    'the columns add to ' + sum + '% — over 100 is the crop he reported, coming back');
  assert.ok(sum >= 97, 'the columns add to only ' + sum + '% — the table would not fill the page');
});

test('the journeys view holds no table of its own that could overflow', () => {
  const src = read('westmere-admin.html');
  const i = src.indexOf('<div class="view" id="view-history">');
  const j = src.indexOf('</div>\n\n', i);
  const view = src.slice(i, j);
  assert.ok(!/<table/.test(view), 'a hand-written table is back in the journeys view');
  assert.ok(!/overflow-x:auto/.test(view),
    'a sideways scroller inside the page is how the last one hid its own columns');
});

// ── 5. THE ACTIONS MOVED, THEY DID NOT GO ─────────────────────────────────
console.log('\nEverything the row could do, the page can do');

test('the journey page offers every action the table row offered', () => {
  const fn = fnBlock(strip(read('westmere-admin.html')), 'admTripRender');
  assert.ok(fn, 'admTripRender is gone');
  const must = [
    ['the estimate',        /admSendEstimate/],
    ['mark as paid',        /admMarkPaid/],
    ['mark completed',      /markJobDone/],
    ['send to driver',      /dispOffer/],
    ['the payment reminder', /admSendPayReminder/],
    ['message the customer', /wmMessageOpen/],
    ['accept a change',     /admAcceptChange/],
    ['decline a change',    /admDeclineChange/],
    ['mark a change reviewed', /admReviewChange/],
    ['confirm a fare',      /admClearFareReview/],
    ['the refund',          /refundTrip/],
    ['cancel',              /cancelTrip/],
    ['delete',              /admDeleteBooking/]
  ];
  const missing = must.filter(([, re]) => !re.test(fn)).map(([n]) => n);
  assert.deepStrictEqual(missing, [],
    'the table is gone and took these with it: ' + missing.join(', '));
});

test('and every one of them is a function that exists', () => {
  const src = read('westmere-admin.html');
  const fn = fnBlock(strip(src), 'admTripRender');
  const called = [...fn.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
  assert.ok(called.length >= 10, 'only ' + called.length + ' actions found on the journey page');
  for (const name of [...new Set(called)]) {
    assert.ok(new RegExp('function\\s+' + name + '\\s*\\(|' + name + '\\s*=\\s*(async\\s*)?function').test(src),
      'the journey page offers ' + name + '(), which nobody wrote');
  }
});

test('which actions exist is still the shared module’s answer', () => {
  const fn = fnBlock(strip(read('westmere-admin.html')), 'admTripRender');
  assert.ok(/WMLifecycle\.actionsFor\(b\)/.test(fn),
    'the journey page has started deciding for itself what may be done to a booking');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/admin-journeys\.test\.js/.test(read('package.json')),
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
