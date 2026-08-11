/**
 * Airport-fares PAGE ↔ engine consistency — run with:  node server/tests/fares-page.test.js
 *
 * The owner wants the airport fares page to DISPLAY the all-in town prices, and
 * for what customers see to match the quote engine exactly. This asserts:
 *   1) every all-in Gatwick/Heathrow cell on airport-transfers.html shows the
 *      SAME number the engine returns (and the engine treats it as all-in:
 *      airport_fee = toll = 0);
 *   2) both directions (drop-off / pickup) display that one flat figure;
 *   3) Crawley is NOT shown as a fixed price (no crawley fare cell) and the
 *      engine quotes it on request (no number);
 *   4) westmere-fares.html carries the same figures for the towns it lists.
 *
 * Pure Node, no network (fixed CF routes resolve without geocoding). Exit 1 on
 * any failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { calculateFare } = require('../fare-engine');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// Pull the £ figure shown in a given fare cell (town:ap:dir) of the page HTML.
function cellAmount(html, cellKey) {
  const re = new RegExp('data-fare-cell="' + cellKey + '">\\s*<span data-fare-amount>([^<]*)</span>');
  const m = html.match(re);
  if (!m) return null;
  const num = m[1].replace(/[^0-9.]/g, '');
  return num ? Number(num) : null;
}

const AP = { ga: 'Gatwick Airport', he: 'Heathrow Airport' };
// town key on the page → the input string the engine normalises from
const TOWN_INPUT = {
  brighton: 'Brighton', haywards: 'Haywards Heath', burgess: 'Burgess Hill',
  horsham: 'Horsham', lewes: 'Lewes',
};
// The owner's published all-in figures (must equal the engine).
const EXPECTED = [
  ['brighton', 'ga', 65], ['brighton', 'he', 125],
  ['haywards', 'ga', 60], ['haywards', 'he', 126],
  ['burgess',  'ga', 56], ['burgess',  'he', 126],
  ['horsham',  'ga', 45], ['horsham',  'he', 90],
  ['lewes',    'ga', 80], ['lewes',    'he', 150],
];

console.log('\nAirport-fares page matches the engine (all-in)');

for (const [town, ap, expected] of EXPECTED) {
  test(`${town} ${ap}: page shows £${expected}, both directions, = engine all-in`, async () => {
    const html = read('airport-transfers.html');
    const out = cellAmount(html, `${town}:${ap}:out`);
    const ret = cellAmount(html, `${town}:${ap}:ret`);
    assert.strictEqual(out, expected, `${town}:${ap}:out shows £${out}, expected £${expected}`);
    assert.strictEqual(ret, expected, `${town}:${ap}:ret shows £${ret}, expected £${expected}`);
    // Engine agrees AND treats it as all-in (no fee/toll on top).
    const r = await calculateFare(TOWN_INPUT[town], AP[ap], '10:00');
    assert.strictEqual(r.fare, expected, `engine ${town}→${ap} = £${r.fare}, page shows £${expected}`);
    assert.strictEqual(r.airport_fee, 0, `engine ${town}→${ap} must be all-in (fee 0)`);
    assert.strictEqual(r.toll_fee || 0, 0, `engine ${town}→${ap} must be all-in (toll 0)`);
  });
}

// ── Crawley: not a fixed price on the page, and on-request in the engine ──────
test('Crawley is NOT shown as a fixed fare on the page', () => {
  const html = read('airport-transfers.html');
  assert.ok(!/data-fare-cell="crawley:/.test(html), 'airport-transfers.html must not show a Crawley fixed fare cell');
});
test('Crawley → Gatwick quotes on request (engine returns no number)', async () => {
  const r = await calculateFare('Crawley', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.fare, null, 'Crawley must not auto-return a fare');
  assert.ok(r.on_request === true || r.rate_type === 'on_request', 'Crawley must be flagged on_request');
});

// ── westmere-fares.html carries the same figures for the towns it lists ──────
test('westmere-fares.html Horsham/Lewes/Brighton figures match the engine', () => {
  const src = read('westmere-fares.html');
  // These appear as [name, dist, drop, pickup] tuples in the AREAS data.
  for (const [needle, why] of [
    ['name:"Brighton", fares:[["Gatwick Airport","~27 mi · ~40 min",65,65],["Heathrow Airport","~58 mi · ~75 min",125,125]', 'Brighton'],
    ['name:"Lewes", fares:[["Gatwick Airport","~28 mi · ~38 min",80,80],["Heathrow Airport","~62 mi · ~80 min",150,150]', 'Lewes'],
    ['name:"Horsham", fares:[["Gatwick Airport","~12 mi · ~22 min",45,45],["Heathrow Airport","~38 mi · ~55 min",90,90]', 'Horsham'],
  ]) {
    assert.ok(src.includes(needle), 'westmere-fares.html ' + why + ' figures are out of sync with the engine');
  }
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
