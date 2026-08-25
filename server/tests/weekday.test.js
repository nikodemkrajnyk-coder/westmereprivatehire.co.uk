/**
 * The day of the week, wherever a booking date is shown — run with:
 *   node server/tests/weekday.test.js   (also gated by `npm test`)
 *
 * The owner works from the weekday, not the number. He asked whether the app
 * showed it everywhere; it did not — the trip page's own Date row read
 * "2026-08-25 at 10:00", a raw ISO string with no day name, sitting directly
 * under a glance row that said "Tuesday". A screen that gives you the answer
 * in two different shapes makes you check twice.
 *
 * This pins the fix in both directions:
 *   (a) no human-facing booking date is printed as a bare ISO string;
 *   (b) the helpers that format them obey the timezone invariant — built from
 *       the literal Y-M-D components, never parsed as an instant, because
 *       new Date('2026-08-25') is UTC midnight and reads back as MONDAY the
 *       24th anywhere west of UTC. Getting the weekday wrong is worse than
 *       not showing one.
 *
 * DELIBERATELY NOT COVERED: the licensing record-book export and the CSV, which
 * stay ISO because a council reads them by machine, and the analytics axis,
 * which has no room. Those are named here so their absence is a decision.
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

// Pull a function body out of a page and run it, so the assertions are about
// what the code DOES, not about what it looks like.
function fnFrom(src, startMarker, name) {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, 'cannot find ' + startMarker);
  const body = src.slice(i, src.indexOf('\n}', i) + 2);
  return new Function(body + '\nreturn ' + name + ';')();
}

console.log('\nThe day of the week, wherever a date is shown');

// ── (a) The long form ────────────────────────────────────────────────────
test('the owner app spells the weekday out in full on a trip detail', () => {
  const f = fnFrom(OWNER, 'var _DOW_LONG=', '_fmtLongDate');
  assert.strictEqual(f('2026-08-25'), 'Tuesday 25 August 2026');
  assert.strictEqual(f('2026-01-01'), 'Thursday 1 January 2026');   // month index, not off by one
  assert.strictEqual(f('2026-12-31'), 'Thursday 31 December 2026');
});

test('the admin app formats it identically — one wording, two apps', () => {
  const o = fnFrom(OWNER, 'var _DOW_LONG=', '_fmtLongDate');
  const a = fnFrom(ADMIN, 'var _ADM_DOW_LONG=', '_admLongDate');
  for (const d of ['2026-08-25', '2026-02-28', '2027-03-01']) {
    assert.strictEqual(a(d), o(d), 'the two apps disagree about ' + d + ': ' + a(d) + ' vs ' + o(d));
  }
});

test('junk and blanks pass through instead of becoming "Invalid Date"', () => {
  // `time` defaults to 'ASAP' and `date` has been blank on old rows. Printing
  // "Invalid Date" to the owner has happened before and must not happen again.
  for (const src of [[OWNER, 'var _DOW_LONG=', '_fmtLongDate'], [ADMIN, 'var _ADM_DOW_LONG=', '_admLongDate']]) {
    const f = fnFrom(src[0], src[1], src[2]);
    assert.strictEqual(f(''), '');
    assert.strictEqual(f(null), '');
    assert.strictEqual(f('ASAP'), 'ASAP');
    assert.strictEqual(f('not-a-date'), 'not-a-date');
    for (const v of ['', null, 'ASAP', 'not-a-date', '2026-08-25']) {
      assert.ok(!/Invalid/.test(String(f(v))), 'produced an Invalid Date for ' + JSON.stringify(v));
    }
  }
});

// ── (b) The timezone invariant ───────────────────────────────────────────
test('the date is built from components, never parsed as an instant', () => {
  for (const [src, marker, name] of [[OWNER, 'var _DOW_LONG=', 'owner'], [ADMIN, 'var _ADM_DOW_LONG=', 'admin']]) {
    const i = src.indexOf(marker);
    const body = src.slice(i, src.indexOf('\n}', i) + 2);
    assert.ok(!/new Date\(\s*(s|dateStr|String\()/.test(body),
      name + " parses the date string as an instant — new Date('2026-08-25') is UTC midnight " +
      'and renders as Monday the 24th west of UTC');
    assert.ok(/new Date\(y\s*,\s*m\s*-\s*1\s*,\s*d\)/.test(body),
      name + ' must construct the date from its numeric Y-M-D components');
    assert.ok(!/T00:00:00/.test(body), name + " concatenates a time onto the date — 'ASAP' makes that an Invalid Date");
  }
});

// ── (c) No bare ISO left on a human-facing surface ───────────────────────
test('no booking date reaches the owner or admin as a bare ISO string', () => {
  const RAW = [
    [OWNER, 'westmere-owner.html', /escH\(\s*(?:j|b)\.date\s*(?:\|\|[^)]*)?\)/g],
    [ADMIN, 'westmere-admin.html', /escTo\(\s*(?:j|b)\.date\s*(?:\|\|[^)]*)?\)/g]
  ];
  const offenders = [];
  for (const [src, file, re] of RAW) {
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      const ctx = src.slice(Math.max(0, m.index - 220), m.index + 80);
      // The licensing record-book and the CSV stay ISO on purpose — a council
      // reads those by machine.
      if (/rb-|record|csv|Csv|journeyRecord/i.test(ctx)) continue;
      // A date handed to an onclick handler is DATA being passed along, not
      // something anybody reads. Formatting it there would corrupt the value.
      const attr = ctx.lastIndexOf('onclick="');
      if (attr !== -1 && !ctx.slice(attr).includes('")')) continue;
      offenders.push(file + ':' + line + '  ' + m[0]);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these print a raw YYYY-MM-DD to a person — wrap them in the weekday helper:\n      ' +
    offenders.join('\n      '));
});

test('the trip detail Date row and the glance row agree on the day', () => {
  // Same booking, same screen. The glance says "Tue 25 Aug", the detail row
  // must not say a different weekday — or worse, none at all.
  const long = fnFrom(OWNER, 'var _DOW_LONG=', '_fmtLongDate');
  const months = OWNER.slice(OWNER.indexOf('var _CAL_MONTHS_S='));
  const short = new Function(
    months.slice(0, months.indexOf('\n')) + '\n' +
    (() => { const i = OWNER.indexOf('function _fmtUpcomingDate'); return OWNER.slice(i, OWNER.indexOf('\n}', i) + 2); })() +
    '\nreturn _fmtUpcomingDate;')();
  /* A DATE FAR ENOUGH OUT TO HAVE A WEEKDAY NAME.
     This was hardcoded to '2026-08-25', which quietly became a time bomb: the
     glance deliberately says "Today"/"Tomorrow" inside its two-day window, so
     on 24 and 25 August 2026 the fixture had no weekday to compare and the
     guard failed on a calendar date rather than on a defect. Derived from the
     run date instead, so it can never sit in that window again. */
  const far = new Date(Date.now() + 30 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
  const d = far;
  const dow = long(d).split(' ')[0];                       // e.g. Tuesday
  assert.ok(short(d).startsWith(dow.slice(0, 3)),
    'the glance says "' + short(d) + '" and the detail row says "' + long(d) + '" — different days');

  const row = OWNER.slice(OWNER.indexOf('>Date</td>'), OWNER.indexOf('>Date</td>') + 220);
  assert.ok(/_fmtLongDate\(j\.date\)/.test(row),
    'the trip detail Date row is no longer formatted — it would print the raw column value again');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/weekday\.test\.js/.test(read('package.json')), 'weekday.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
