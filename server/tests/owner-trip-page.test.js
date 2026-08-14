/**
 * Owner-app readability + trip page guardrail — run with:
 *   node server/tests/owner-trip-page.test.js   (also gated by `npm test`)
 *
 * Four owner-reported items, each easy to half-apply:
 *
 *   1. the staff apps were too small to read on a phone;
 *   2. tapping a booking expanded it inline, burying the detail mid-list —
 *      it now opens its own full-screen page with a back button;
 *   3. the old → new change comparison rendered ONLY on a committed booking,
 *      so a change to a not-yet-confirmed trip showed a one-line summary and
 *      the detail lived only in the email;
 *   4. after sending a change request the customer had no clear "waiting for a
 *      reply" state.
 *
 * Static analysis of the shipped files. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const RIDER = read('westmere-rider.html');

// ── 1. READABILITY ───────────────────────────────────────────────────────
console.log('\nThe staff apps are readable on a phone');

// 0.6rem ≈ 9.6px. Below that is where the owner said he could not read it.
const FLOOR_REM = 0.6;

test('no text in the owner or admin app is set below the readable floor', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN]]) {
    const tooSmall = [...src.matchAll(/font-size:(\.\d+|0\.\d+)rem/g)]
      .map(m => parseFloat(m[1]))
      .filter(v => v < FLOOR_REM);
    assert.deepStrictEqual([...new Set(tooSmall)].sort(), [],
      name + ' still sets text below ' + FLOOR_REM + 'rem: ' + [...new Set(tooSmall)].join(', '));
  }
});

test('no pixel-sized text is below 13px either', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN]]) {
    const tooSmall = [...src.matchAll(/font-size:(\d+)px/g)].map(m => +m[1]).filter(v => v < 13);
    assert.deepStrictEqual([...new Set(tooSmall)].sort(), [], name + ' has text below 13px: ' + tooSmall.join(', '));
  }
});

test('the trip card headline tiers actually grew', () => {
  // Spot-check the lines the owner named: name, route, time/pax.
  // The WHOLE function, not a fixed 4000-character window: a comment added at
  // the top used to push the sized elements out of the window and the test
  // then failed on markup it had not even looked at.
  const i = OWNER.indexOf('function jobCardHtml(j){');
  assert.ok(i !== -1, 'jobCardHtml is missing');
  const body = OWNER.slice(i, OWNER.indexOf('\n}\n', i));
  const sizes = [...body.matchAll(/font-size:(\.\d+)rem/g)].map(m => parseFloat(m[1]));
  assert.ok(sizes.length > 5, 'expected several sized elements on the trip card');
  assert.ok(Math.min(...sizes) >= FLOOR_REM,
    'the trip card still has text below the floor: ' + Math.min(...sizes) + 'rem');
});

// ── 2. THE TRIP PAGE ─────────────────────────────────────────────────────
console.log('\nTapping a trip opens its own page');

test('a trip card opens the page instead of expanding inline', () => {
  assert.ok(/onclick="openTripPage\(/.test(OWNER),
    'the card header must open the trip page');
  assert.ok(!/onclick="upcomingToggle\(\\'\'\+detailId/.test(OWNER),
    'the card header must no longer toggle an inline accordion');
});

test('the page exists, has a back button, and can be dismissed', () => {
  assert.ok(/id="trip-page"/.test(OWNER) && /id="trip-page-body"/.test(OWNER), 'the trip page markup is missing');
  assert.ok(/class="trip-back"[\s\S]{0,160}onclick="closeTripPage\(\)"/.test(OWNER), 'the page needs a back button');
  assert.ok(/function openTripPage\(/.test(OWNER) && /function closeTripPage\(/.test(OWNER), 'open/close missing');
  assert.ok(/e\.key==='Escape'[\s\S]{0,80}closeTripPage\(\)/.test(OWNER), 'Escape must close the page');
  const btn = OWNER.match(/\.trip-back\{[^}]*\}/);
  assert.ok(btn && /width:44px;height:44px/.test(btn[0]), 'the back button must be a real touch target');
});

test('the page reuses the card renderer, so it cannot drift from the list', () => {
  const open = OWNER.match(/function openTripPage\(id\)\{[\s\S]*?\n\}/);
  assert.ok(open, 'openTripPage is missing');
  assert.ok(/jobCardHtml\(j\)/.test(open[0]),
    'the page must render the SAME jobCardHtml as the list — a second copy would drift');
  assert.ok(/uj-det-'\)\.join\('tp-det-/.test(open[0]),
    'the page copy must rewrite the detail ids so they cannot collide with the card behind it');
  assert.ok(/display='block'/.test(open[0]), 'the detail must be open on the page — it is the point of it');
});

// ── 3. THE CHANGE REQUEST IS REVIEWABLE IN THE APP ───────────────────────
console.log('\nThe owner can review a change request in the app');

test('the old → new comparison renders at BOTH change-request stages', () => {
  const block = OWNER.match(/function wmChangeBlock\(j\)\{[\s\S]*?\n\}/);
  assert.ok(block, 'wmChangeBlock is missing');
  const early = block[0].slice(block[0].indexOf("if(stage==='early')"), block[0].indexOf('// ── DECISION'));
  assert.ok(/wmChangeRow/.test(early),
    'the EARLY stage still shows no old→new table — that is the state a change on an ' +
    'unconfirmed booking lands in, and it is why the comparison was visible only in the email');
  // …and the decision stage keeps its own.
  assert.ok((block[0].match(/wmChangeRow/g) || []).length >= 2,
    'both stages must render the comparison rows');
});

test('the comparison strikes the old value through and highlights the new', () => {
  const row = OWNER.match(/function wmChangeRow\(c\)\{[\s\S]*?\n\}/);
  assert.ok(row, 'wmChangeRow is missing');
  assert.ok(/text-decoration:line-through/.test(row[0]), 'the OLD value must be struck through');
  assert.ok(/c\.current/.test(row[0]) && /c\.requested/.test(row[0]), 'both values must render');
  assert.ok(/→/.test(row[0]), 'the two must read as old → new');
});

test('the owner can act on the request from the page', () => {
  for (const fn of ['ownerAcceptChange', 'ownerDeclineChange', 'wmMessageOpen']) {
    assert.ok(OWNER.includes(fn + '('), 'the change panel must offer ' + fn);
  }
});

// ── 4. THE CUSTOMER SEES THAT THEY ARE WAITING ───────────────────────────
console.log('\nThe customer is told they are waiting for a reply');

test('sending a change request returns to the trips, it does not sit on the form', () => {
  const submit = RIDER.match(/async function submitChangeRequest\(\)\{[\s\S]*?\n\}/);
  assert.ok(submit, 'submitChangeRequest is missing');
  assert.ok(/closeChangeModal\(\);/.test(submit[0]), 'the form must close on success');
  assert.ok(/loadServerTrips\(\);/.test(submit[0]), 'the trips must refresh from the server');
  assert.ok(/function closeChangeModal\(/.test(RIDER), 'closeChangeModal must actually exist');
});

test('the trip then shows that it is awaiting a reply', () => {
  assert.ok(/Change requested &middot; awaiting reply/.test(RIDER),
    'the chip must say the customer is waiting, not just that a change was requested');
  assert.ok(/var awaitingChange=!!\(b\.changeRequestedAt\)/.test(RIDER),
    'the waiting state must be derived from the stored change_requested_at');
  assert.ok(/_stLower!=='cancelled'&&_stLower!=='completed'/.test(RIDER),
    'a cancelled or completed trip has nothing left to wait for');
});

test('the waiting badge does NOT touch payment status', () => {
  // The double-payment and live-status invariants rest on _tripStatus deriving
  // payment state. A change request is orthogonal and must stay a separate chip.
  const st = RIDER.match(/function _tripStatus\(b\)\{[\s\S]*?\n\}/);
  assert.ok(st, '_tripStatus is missing');
  assert.ok(!/changeRequested/i.test(st[0]),
    '_tripStatus must not consider the change request — it would mask "Paid" / "Awaiting payment"');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
