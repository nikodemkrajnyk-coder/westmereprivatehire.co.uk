/**
 * Non-airport quick estimate guardrail — run with:
 *   node server/tests/quick-estimate-nonairport.test.js   (also gated by `npm test`)
 *
 * THIS IS REAL MONEY, so the test executes the SHIPPED function rather than
 * regex-matching it.
 *
 * The owner's spec: a town-to-town journey shows an approximate guide of
 *   £2.50 per routed mile, with a £40 floor.
 * Before this, non-airport showed no price at all.
 *
 * What must NOT move: airport journeys. They keep the fixed FARE_CF fares and
 * the tapered per-mile engine (day 3.79/2.37/2.13, night 3.60/2.95/2.64, with a
 * 10-mile floor). The non-airport rule is a separate function that only ever
 * runs when there is no airport at either end — so this file also pins that
 * separation, because a leak either way changes what a customer is quoted.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nNon-airport quick estimate — £2.50/mile, £40 floor');

const APP = read('booking-app.js');

// Pull the SHIPPED helper out and run it for real.
function extract(name) {
  const i = APP.indexOf('function ' + name + '(');
  assert.ok(i !== -1, 'booking-app.js no longer defines ' + name);
  let depth = 0, start = APP.indexOf('{', i);
  for (let j = start; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

const sandbox = { Math, console };
vm.createContext(sandbox);
// The constants live beside the function; take them from source so the test
// cannot pass on a stale copy of the numbers.
const perMile = APP.match(/var NONAP_PER_MILE = ([\d.]+);/);
const minFare = APP.match(/var NONAP_MIN = ([\d.]+);/);
assert.ok(perMile && minFare, 'the non-airport rate/minimum constants are missing');
vm.runInContext(`var NONAP_PER_MILE=${perMile[1]};var NONAP_MIN=${minFare[1]};` + extract('nonAirportEstimate'), sandbox);
const est = sandbox.nonAirportEstimate;

test('the rate is £2.50 a mile and the floor is £40', () => {
  assert.strictEqual(parseFloat(perMile[1]), 2.50, 'the per-mile rate has moved');
  assert.strictEqual(parseFloat(minFare[1]), 40, 'the minimum fare has moved');
});

test('a long run is priced at £2.50 a mile', () => {
  assert.strictEqual(est(100), 250);
  assert.strictEqual(est(40), 100);
  assert.strictEqual(est(20), 50);
  assert.strictEqual(est(16), 40);       // exactly on the floor
});

test('anything under the floor shows £40, never less', () => {
  for (const mi of [0.1, 1, 5, 10, 15, 15.9]) {
    assert.strictEqual(est(mi), 40, mi + ' miles must floor at £40, got ' + est(mi));
  }
});

test('the floor is a FLOOR, not a flat fare', () => {
  assert.ok(est(30) > 40, '30 miles must price above the floor');
  assert.strictEqual(est(30), 75);
});

test('an odd distance rounds up to the nearest 50p, like the rest of the system', () => {
  assert.strictEqual(est(20.3), 51);      // 50.75 → 51.00
  assert.strictEqual(est(24.1), 60.5);    // 60.25 → 60.50
});

test('no distance means no price — it never guesses', () => {
  for (const bad of [0, -5, null, undefined, NaN]) {
    assert.strictEqual(est(bad), null, 'a missing distance must not produce a fare (' + bad + ')');
  }
});

// ── The separation from the airport pricing ──────────────────────────────
console.log('\nAirport pricing is untouched');

test('the non-airport rule can never price an airport journey', () => {
  // quoteNonAirport is only reached from the !isAirportJourney branch, and
  // calculateFare still refuses town-to-town itself — belt and braces, both
  // pinned here.
  assert.ok(/if \(!isAirportJourney\(p, d\)\) \{[\s\S]{0,600}?quoteNonAirport\(p, d\)/.test(APP),
    'the non-airport quote must be reached only from the non-airport branch');
  assert.ok(/if \(!puAP && !deAP\) return Promise\.resolve\(\{ fare:null, on_request:true/.test(APP),
    'calculateFare must still refuse to price a town-to-town journey itself');
  // Scope this to calculateFare's OWN body — quoteNonAirport legitimately
  // appears later in the file, inside updateFare's non-airport branch.
  assert.ok(!/quoteNonAirport/.test(extract('calculateFare')),
    'calculateFare must not call the non-airport rule');
});

test('the airport engine and its rates are unchanged', () => {
  // The tapered per-mile ladder and its 10-mile floor.
  assert.ok(/m <= 10 \? m\*3\.79 : m <= 20 \? 37\.9\+\(m-10\)\*2\.37 : 61\.6\+\(m-20\)\*2\.13/.test(APP),
    'the DAY per-mile ladder has changed');
  assert.ok(/m <= 10 \? m\*3\.60 : m <= 20 \? 36\.0\+\(m-10\)\*2\.95 : 65\.5\+\(m-20\)\*2\.64/.test(APP),
    'the NIGHT per-mile ladder has changed');
  assert.ok(/var m = Math\.max\(mi, 10\)/.test(APP), 'the 10-mile floor has changed');
  // …and the £40 non-airport floor must not have leaked into it.
  const calcMile = extract('calcMile');
  assert.ok(!/NONAP_MIN|40/.test(calcMile.replace(/3\.60|2\.64|2\.95|61\.6|65\.5|37\.9|3\.79|2\.37|2\.13|36\.0/g, '')),
    'the non-airport minimum has leaked into the airport per-mile engine: ' + calcMile);
});

test('FARE_CF is untouched by this change', () => {
  // Spot-check the owner's flat fares that the quick estimate quotes.
  for (const [town, ap, out] of [['brighton', 'ga', 75], ['lewes', 'ga', 80], ['horsham', 'ga', 50], ['haywards', 'ga', 65]]) {
    const re = new RegExp(town + ':\\s*\\{[^}]*' + ap + ':\\{out:' + out + '\\b');
    assert.ok(re.test(APP), 'FARE_CF ' + town + '→' + ap + ' out:' + out + ' has changed');
  }
  assert.ok(/crawley: true/.test(APP), 'the quote-on-request town list has changed');
});

test('the estimate geocodes an autocomplete address without doubling the country', () => {
  // The shared geocode() appends ", UK" unless the string contains the token
  // "UK". Every address the autocomplete stores ends in "United Kingdom", which
  // does not — so it queried "…, United Kingdom, UK" and Nominatim returned
  // NOTHING. The estimate would have failed closed for almost every real
  // customer. Its own geocoder recognises the full country name too.
  const fn = extract('geocodeForEstimate');
  assert.ok(/united kingdom/i.test(fn),
    'the estimate geocoder must recognise "United Kingdom", not just the token "UK"');
  // Run the exact expression against both shapes.
  const re = fn.match(/var q = ([^;]+);/);
  assert.ok(re, 'could not read the query builder');
  const build = new Function('a', 'return ' + re[1].replace(/\ba\b/g, 'a') + ';');
  // Already carries a country → must be passed through UNCHANGED.
  for (const addr of ['Brighton, Brighton and Hove, England, United Kingdom',
                      'Gatwick Airport, Crawley, West Sussex, UK']) {
    assert.strictEqual(build(addr), addr,
      'the country was appended to an address that already had one: ' + build(addr));
  }
  assert.strictEqual(build('Lewes'), 'Lewes, UK', 'a bare town must still get the country appended');

  // …and the SHARED geocode() must be left exactly as it was: "fixing" it there
  // would start pricing airport journeys that currently quote nothing.
  const shared = extract('geocode');
  assert.ok(/\/\\bUK\\b\/i\.test\(addr\)/.test(shared),
    'the shared geocode() must keep its original country test — changing it moves airport quotes');
});

// ── A TYPED ADDRESS MUST NEVER PRODUCE A CONFIDENT WRONG PRICE ───────────
// The owner wants free typing allowed ("sometimes geo can't find it"). The risk
// that creates is not a failed lookup — it is a confident WRONG one.
//
// The real case: "Brighton, East Sussex" returns as its single best match
// "Brighton&Hove Buses Eastbourne Depot" — a depot in EASTBOURNE, ~20 miles
// from Brighton. Brighton is in "Brighton and Hove", not East Sussex, so no
// exact match exists and Nominatim falls back to a fuzzy one whose NAME
// contains "Brighton". The customer would have been quoted £40 for a 21-mile
// journey. These are the ACTUAL payloads that search returned.
console.log('\nA typed address never yields a confident wrong price');

vm.runInContext(extract('_normPlace') + extract('placeIsPlausible'), sandbox);
const plausible = sandbox.placeIsPlausible;

// Verbatim from Nominatim for "Brighton, East Sussex, UK".
const BAD = [
  { display_name: "Brighton&Hove Buses Eastbourne Depot, St Anthony's Hill, Eastbourne, East Sussex, England, United Kingdom",
    class: 'landuse', type: 'industrial', address: { city: 'Eastbourne', county: 'East Sussex' } },
  { display_name: 'Brighton Road, Wallands Park, Lewes, East Sussex, England, BN7 1EA, United Kingdom',
    class: 'highway', type: 'primary', address: { town: 'Lewes', county: 'East Sussex' } },
  { display_name: 'Brighton Road, Nevill, Lewes, East Sussex, England, BN7 1EW, United Kingdom',
    class: 'highway', type: 'primary', address: { town: 'Lewes', county: 'East Sussex' } }
];
// …and for the two that resolve correctly.
const GOOD_BRIGHTON = { display_name: 'Brighton, Brighton and Hove, England, BN1 1HJ, United Kingdom',
  class: 'place', type: 'city', address: { city: 'Brighton' } };
const GOOD_CRAWLEY = { display_name: 'Crawley, West Sussex, England, United Kingdom',
  class: 'boundary', type: 'administrative', address: { town: 'Crawley', county: 'West Sussex' } };

test('THE REPORTED CASE: an Eastbourne depot is rejected for a Brighton query', () => {
  for (const cand of BAD) {
    assert.strictEqual(plausible(cand, 'Brighton, East Sussex'), false,
      'accepted a result in the wrong town: ' + cand.display_name.slice(0, 60));
  }
});

test('the COUNTY alone never makes a result plausible', () => {
  // The hole the first version of this check had: the depot carries
  // county "East Sussex", which the query also contains — but Brighton and
  // Eastbourne are both in East Sussex, so it proves nothing about the town.
  const countyOnly = { display_name: 'Somewhere Else, Eastbourne, East Sussex, England, United Kingdom',
    address: { city: 'Eastbourne', county: 'East Sussex' } };
  assert.strictEqual(plausible(countyOnly, 'Brighton, East Sussex'), false,
    'a shared COUNTY must not be enough to accept a result in a different town');
});

test('a correctly resolved address is accepted', () => {
  assert.strictEqual(plausible(GOOD_BRIGHTON, 'Brighton, Brighton and Hove, England, United Kingdom'), true);
  assert.strictEqual(plausible(GOOD_CRAWLEY, 'Crawley, West Sussex, England, United Kingdom'), true);
});

test('a TYPED street address still resolves — free typing is not blocked', () => {
  // The owner explicitly does not want customers forced through autocomplete.
  const typed = { display_name: '14, Queens Road, Haywards Heath, West Sussex, England, RH16 1EA, United Kingdom',
    class: 'building', type: 'house', address: { road: 'Queens Road', town: 'Haywards Heath', county: 'West Sussex' } };
  assert.strictEqual(plausible(typed, '14 Queens Road, Haywards Heath'), true,
    'a hand-typed street address that resolves correctly must still be priced');
  assert.strictEqual(plausible(typed, 'Queens Road Haywards Heath'), true);
});

test('the check reads the whole candidate, not just one field', () => {
  // A POI with no town in addressdetails must still pass on its own name.
  const poi = { display_name: 'Gatwick Airport, Crawley, West Sussex, England, United Kingdom',
    class: 'aeroway', type: 'aerodrome', address: {} };
  assert.strictEqual(plausible(poi, 'Gatwick Airport'), true);
  assert.strictEqual(plausible(null, 'anything'), false, 'a missing candidate is never plausible');
});

test('the geocoder asks for enough candidates to be able to judge', () => {
  const fn = extract('geocodeForEstimate');
  assert.ok(/limit=5/.test(fn), 'limit=1 gives no way to tell a good match from a bad one');
  assert.ok(/addressdetails=1/.test(fn), 'the town fields are what the plausibility check reads');
  assert.ok(/placeIsPlausible\(arr\[i\], a\)/.test(fn), 'candidates must be filtered by plausibility');
  assert.ok(/return null;/.test(fn), 'when nothing is plausible it must return null, not a guess');
});

test('an unresolvable address degrades to the safe message, never a price', () => {
  // quoteNonAirport returns null when either end will not geocode…
  const q = extract('quoteNonAirport');
  assert.ok(/if \(!g\[0\] \|\| !g\[1\]\) return null;/.test(q),
    'a failed geocode must produce no quote');
  assert.ok(/if \(!rt\) return null;/.test(q), 'a failed route must produce no quote');
  // …and the widget then shows the fallback, with no number in it.
  const branch = APP.slice(APP.indexOf('quoteNonAirport(p, d).then'));
  const fallback = branch.slice(branch.indexOf('} else {'), branch.indexOf('} else {') + 700);
  assert.ok(/We couldn’t look that route up automatically/.test(fallback),
    'the fallback must explain itself rather than showing a blank box');
  assert.ok(/Request your booking below and we’ll confirm your fare/.test(fallback),
    'the fallback must send the customer to the booking request');
  assert.ok(!/approx £|fe-amount/.test(fallback),
    'the fallback must NEVER render a price');
});

// ── Crawley stays on the per-mile estimate ───────────────────────────────
test('Crawley town-to-town is priced like anywhere else (owner decision)', () => {
  // FARE_ON_REQUEST is consulted ONLY inside calculateFare's airport branches,
  // so a Crawley town-to-town journey reaches the £2.50/mile rule like any
  // other. Pinned so it cannot silently become quote-only again.
  const calc = extract('calculateFare');
  const onRequestCalls = (calc.match(/onRequest\(/g) || []).length;
  assert.strictEqual(onRequestCalls, 2,
    'onRequest must be checked exactly twice, in the two airport branches');
  const nonAirportBranch = APP.slice(APP.indexOf('if (!isAirportJourney(p, d)) {'),
                                     APP.indexOf('if (!isAirportJourney(p, d)) {') + 1400);
  assert.ok(!/onRequest\(/.test(nonAirportBranch),
    'the non-airport estimate must NOT consult the quote-on-request town list — ' +
    'the owner wants Crawley priced at £2.50/mile like anywhere else');
});

// ── #B: an estimate is not a booking ─────────────────────────────────────
console.log('\nThe estimate reads as an estimate, not a booking');

test('every estimate is headed "not a confirmed booking"', () => {
  assert.ok(/Approximate estimate — not a confirmed booking/.test(APP),
    'the estimate heading must say it is not a confirmed booking');
  // BOTH branches must use it — the airport quote is the one customers were
  // mistaking for a booking.
  const uses = APP.split('ESTIMATE_LABEL').length - 1;
  assert.ok(uses >= 3, 'both the airport and non-airport estimates must use the shared heading (found ' + (uses - 1) + ' uses)');
});

test('the estimate still points at Request booking as the real step', () => {
  assert.ok(/Request your booking below and we’ll confirm the exact fare/.test(APP),
    'the non-airport estimate must send the customer to the booking request');
  assert.ok(/we confirm the exact price with your request/.test(APP),
    'the airport estimate must keep its confirm-on-request wording');
  assert.ok(/Request booking/.test(read('book.html')),
    'the booking form must still have its Request booking action');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
