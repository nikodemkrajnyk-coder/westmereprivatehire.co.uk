/**
 * The homepage's prime spot is a price, not a commitment — run with:
 *   node server/tests/price-first.test.js   (also gated by `npm test`)
 *
 * ONE CHANGE, deliberately small. Under the hero — beneath the title, the
 * description and the "Pre-bookings only" note — there used to be a "Book your
 * journey" button. People are wary of booking and would not start, so that spot
 * now holds the quick-estimate search instead: two addresses in, an instant
 * approximate fare back, nothing asked of them.
 *
 * The two things that make it work are both easy to undo by accident, so both
 * are pinned:
 *   · NO booking control sits under the estimate. Putting one back turns a free
 *     price check into a funnel step again, which is the whole thing this
 *     replaced.
 *   · BOOK NOW stays in the header. Someone who already knows they want to book
 *     must never have to hunt for it — the estimate is for the undecided, not a
 *     toll gate for the decided.
 *
 * Everything else on the page — the heading, the copy, the caveats, book.html —
 * is unchanged, and this file checks that too, because "while I'm in here" is
 * how a narrow change stops being narrow.
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

const HOME = read('index.html');
const BOOK = read('book.html');
const APP = read('booking-app.js');
const BODY = HOME.slice(HOME.indexOf('</nav>'));      // below the navigation

console.log('\nThe prime spot is a price, not a commitment');

// ── The swap ─────────────────────────────────────────────────────────────
test('the estimate search stands where the "Book your journey" button was', () => {
  // Match the LINK, not the phrase: the comment above the widget names the old
  // button to explain what it replaced, and asserting on any mention meant the
  // test failed on its own documentation.
  assert.ok(!/<a[^>]*>\s*Book your journey\s*<\/a>/i.test(HOME),
    'the old "Book your journey" button is back under the intro');
  assert.ok(/data-quick-estimate/.test(HOME), 'the homepage has no estimate widget');

  // In the prime spot: after the intro copy, before the fares table.
  const intro = BODY.indexOf('Home of the Airport Transfers');
  const note = BODY.indexOf('Pre-bookings only');
  const quick = BODY.indexOf('data-quick-estimate');
  const fares = BODY.indexOf('id="fares-window"');
  assert.ok(intro !== -1 && note !== -1 && quick !== -1, 'intro, note or estimate missing from the page body');
  assert.ok(quick > note && note > intro,
    'the estimate must sit under the title, description and the pre-bookings note');
  if (fares !== -1) assert.ok(quick < fares, 'the estimate must come before the airport fares table');
});

test('it is the real widget, with the hooks the fare engine needs', () => {
  const w = HOME.slice(HOME.indexOf('data-quick-estimate'), HOME.indexOf('id="fares-window"'));
  for (const hook of ['name="pickup"', 'name="destination"', 'data-fare-estimate']) {
    assert.ok(w.includes(hook), 'the estimate widget is missing ' + hook + ' — it would render no price');
  }
  assert.strictEqual((HOME.match(/data-quick-estimate/g) || []).length, 1,
    'there is more than one estimate widget on the homepage');
});

// ── No booking control under it ──────────────────────────────────────────
test('NOTHING under the estimate offers to book', () => {
  const from = BODY.indexOf('data-quick-estimate');
  const to = BODY.indexOf('id="fares-window"');
  const block = BODY.slice(from, to === -1 ? from + 3000 : to);
  assert.ok(!/href="book\.html"/.test(block),
    'a booking link has appeared under the estimate — the point of this spot is that it asks for nothing');
  assert.ok(!/data-book-after-price/.test(HOME),
    'the reveal-after-price booking button is back; the owner asked for no book button beneath the estimate');
});

// ── BOOK NOW stays where it always was ───────────────────────────────────
test('BOOK NOW is still in the header, on every public page', () => {
  // book.html is excluded on purpose: it has never carried the header CTA,
  // because you are already on it. Requiring one there would be inventing a
  // change, not guarding one.
  const missing = [];
  for (const f of ['index.html', 'airport-transfers.html', 'services.html', 'about.html', 'contact.html']) {
    if (!/<a class="book-btn" href="book\.html">Book Now<\/a>/.test(read(f))) missing.push(f);
  }
  assert.deepStrictEqual(missing, [],
    'these pages lost the header BOOK NOW — someone ready to book must never have to hunt for it:\n      ' +
    missing.join('\n      '));
  assert.ok(!/class="book-btn"/.test(BOOK), 'book.html has gained a header CTA to itself');
});

// ── The line that lets people start typing ───────────────────────────────
test('the estimate says, before you type, that it is not a booking', () => {
  // Some visitors hesitate over the first keystroke: entering an address feels
  // like the start of a commitment. The widget has to say otherwise, and say it
  // where it will be read — above the fields, not in the small print below.
  const m = /<p class="wm-reassure">([\s\S]*?)<\/p>/.exec(HOME);
  assert.ok(m, 'the reassurance line is gone from the homepage estimate');
  const text = m[1].replace(/<[^>]*>/g, '').trim();
  assert.ok(/no booking/i.test(text),
    'the line must say plainly that this is not a booking — that is the fear it exists to answer: ' +
    JSON.stringify(text));
  assert.ok(/estimate|price/i.test(text), 'the line must say what it IS as well as what it is not: ' + JSON.stringify(text));
  assert.ok(text.length < 70, 'the line has grown into a paragraph; it is meant to be glanced at: ' + JSON.stringify(text));

  // Inside the widget, and above the inputs.
  const widget = HOME.indexOf('data-quick-estimate');
  const pickup = HOME.indexOf('name="pickup"');
  assert.ok(m.index > widget && m.index < pickup,
    'the reassurance must sit inside the estimate and BEFORE the fields — under them it arrives ' +
    'too late to be the thing that lets somebody start typing');
});

test('the reassurance is quiet, and separate from the pre-bookings note', () => {
  const T = read('westmere-theme.css');
  const i = T.indexOf('.wm-reassure {');
  assert.ok(i !== -1, 'the theme no longer styles .wm-reassure');
  const block = T.slice(i, T.indexOf('}', i));
  assert.ok(/font-size:\s*var\(--text-sm/.test(block), 'the size must come off the type scale');
  assert.ok(/color:\s*var\(--westmere-muted/.test(block), 'a reassurance that shouts is not reassuring');
  assert.ok(!/background|border/.test(block), 'it has grown into a callout box; it is one line of copy');
  // Two different notes on one screen: policy and permission. They must not be
  // the same class, or moving one drags the other.
  assert.ok(!/wm-advance/.test(block), 'the reassurance is sharing the pre-bookings note’s rule');
  assert.ok(/Pre-bookings only/.test(HOME), 'the pre-bookings note was lost');
});

// ── The caveats ──────────────────────────────────────────────────────────
test('the estimate is still labelled as an estimate', () => {
  assert.ok(/Approximate estimate — not a confirmed booking/.test(APP),
    'the "not a confirmed booking" label is gone — a price in the prime spot must not read as a quote');
  assert.ok(/Pre-bookings only/.test(HOME), 'the homepage lost its pre-bookings note');
});

// ── The narrowing: nothing else moved ────────────────────────────────────
test('the heading is the airport-transfer positioning, and the lead copy is unchanged', () => {
  // The owner's brand line. The site is being steered toward airport transfers
  // rather than general private hire, and this heading is where that is said.
  assert.ok(/<h2 class="section-title">Home of the Airport Transfers\.<\/h2>/.test(HOME),
    'the homepage heading is no longer the airport-transfer positioning');
  assert.ok(/RELIABLE\. DISCREET\. PROFESSIONAL\.|Reliable\. Discreet\. Professional\./.test(HOME),
    'the eyebrow above the heading was changed');
  assert.ok(/Professional drivers, immaculate vehicles and 24\/7 airport transfers/.test(HOME),
    'the homepage lead copy was changed');
  assert.ok(!/Check your price/i.test(HOME), 'price-check wording is back on the homepage');
});

test('book.html was not touched', () => {
  assert.ok(/Request<br>a quote/.test(BOOK), 'the booking page hero was changed');
  assert.ok(/<span class="eyebrow">Request a quote<\/span>/.test(BOOK), 'the booking page eyebrow was changed');
  assert.ok(/type="submit">Request booking<\/button>/.test(BOOK), 'the booking page submit was renamed');
  assert.ok(/<b>This is the booking step\.<\/b>/.test(BOOK), 'the booking-step note was reworded');
  assert.ok(!/Happy with the price/.test(BOOK), 'price-first wording is back on the booking page');
});

test('the fare engine and the estimate wording are untouched', () => {
  assert.ok(!/function revealBooking\(/.test(APP), 'the reveal-after-price mechanism is back in booking-app.js');
  assert.ok(/Request your booking below/.test(APP), 'the estimate wording was changed');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/price-first\.test\.js/.test(read('package.json')), 'price-first.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
