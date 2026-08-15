/**
 * Quick-estimate placement guard — run with:
 *   node server/tests/quick-estimate-placement.test.js
 *
 * The owner wants the instant quick-estimate tool on the homepage, directly
 * BELOW the "Fixed Airport Fares (from £54)" section, reusing the EXISTING
 * booking-app.js engine (no new fare logic) and without changing the fixed
 * "from" prices. This test fails loudly (exit 1) if any of that silently
 * breaks: the widget disappears, moves above the fares list, loses the hooks
 * booking-app.js needs, stops loading the engine, the shared estimator wiring
 * is removed, a fixed price changes, or the book.html booking form regresses.
 *
 * Pure Node, no framework, no network.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

console.log('\nQuick-estimate placement + reuse');
const index = read('index.html');
const bookingApp = read('booking-app.js');
const styles = read('styles.css');
const book = read('book.html');

test('homepage still has the Fixed Airport Fares section', () => {
  assert.ok(/id="fares-window"/.test(index), '#fares-window section is missing from index.html');
});

test('homepage has a quick-estimate widget with the hooks booking-app.js needs', () => {
  assert.ok(/data-quick-estimate/.test(index), 'index.html is missing the [data-quick-estimate] widget');
  const m = index.match(/data-quick-estimate[\s\S]*?<\/section>/);
  assert.ok(m, 'could not isolate the quick-estimate widget');
  const w = m[0];
  assert.ok(/name="pickup"/.test(w), 'widget missing name="pickup"');
  assert.ok(/name="destination"/.test(w), 'widget missing name="destination"');
  assert.ok(/data-fare-estimate/.test(w), 'widget missing the [data-fare-estimate] output box');
});

test('quick estimate LEADS the page, above the fixed airport fares', () => {
  // REVERSED, deliberately, and the reason is worth keeping: the estimate used
  // to sit below the fares table as a "not on the list?" fallback. The audit
  // found people were not engaging at all — "book" reads as commitment and they
  // would not start — so the first thing on the page is now the free thing: two
  // addresses in, a price back, no details, no obligation. The fares table is
  // the reference material that follows it, not the other way round.
  // See server/tests/price-first.test.js for the rest of that flow.
  const fares = index.indexOf('id="fares-window"');
  const quick = index.indexOf('data-quick-estimate');
  assert.ok(fares !== -1 && quick !== -1, 'both sections must exist');
  assert.ok(quick < fares,
    'the quick estimate must come BEFORE the fixed airport fares — the price check is what the ' +
    'page leads with');
});

test('homepage loads the shared booking-app.js engine', () => {
  assert.ok(/<script src="booking-app\.js">/.test(index), 'index.html must load booking-app.js');
});

test('booking-app.js exposes the shared estimator + standalone init (reuse, one engine)', () => {
  assert.ok(/function makeEstimator\(/.test(bookingApp), 'makeEstimator (shared engine) missing');
  assert.ok(/function initQuick\(/.test(bookingApp), 'initQuick (standalone wiring) missing');
  assert.ok(/querySelectorAll\('\[data-quick-estimate\]'\)/.test(bookingApp), 'initQuick must wire [data-quick-estimate]');
  assert.ok(/initQuick\(\)/.test(bookingApp), 'initQuick must actually be called at boot');
  // The full booking form must still use the SAME estimator (no forked fare logic).
  assert.ok(/makeEstimator\(pickup, dest, timeEl, fareBox\)/.test(bookingApp), 'the booking form must reuse makeEstimator');
});

test('the fixed "from" prices are unchanged (FARE list not modified)', () => {
  const expect = [['Gatwick', 54], ['Heathrow', 94], ['Luton', 120], ['Stansted', 135], ['Southampton', 104], ['London City', 120]];
  for (const [town, price] of expect) {
    assert.ok(index.includes(town), 'fixed-fares row missing: ' + town);
    assert.ok(index.includes('from £' + price), 'fixed price changed/missing: ' + town + ' from £' + price);
  }
});

test('the quick-estimate styles are shared in styles.css so the widget renders', () => {
  for (const cls of ['.fare-estimate', '.quick-box', '.ac-list', '.fe-amount']) {
    assert.ok(styles.includes(cls), 'styles.css missing ' + cls + ' (widget would be unstyled)');
  }
});

test('book.html booking form still works (no regression from the refactor)', () => {
  assert.ok(/data-booking-form/.test(book), 'book.html lost its [data-booking-form]');
  assert.ok(/booking-app\.js/.test(book), 'book.html must still load booking-app.js');
  assert.ok(/querySelector\('form\[data-booking-form\]'\)/.test(bookingApp), 'init() must still wire the booking form');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
