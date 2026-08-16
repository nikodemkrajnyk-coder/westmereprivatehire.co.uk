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
 *   · The estimate asks for NOTHING until it has given something. BOOK NOW
 *     sits under it, but ships hidden and is revealed only once a real price is
 *     on screen — gated on the rendered amount, not on a flag, and re-evaluated
 *     on every render so editing an address takes the button away with the
 *     stale number. (This reverses the original "no control at all" rule, on
 *     the owner's instruction; the property that made it worth having — a
 *     visitor who has asked for nothing is offered nothing — is unchanged.)
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

// ── BOOK NOW under the estimate: absent until there is a price ───────────
// REVERSAL, deliberate and on the owner's instruction. This spot used to
// forbid any booking control; it now carries one, but ONLY after a price is on
// screen. The property that made the original rule worth having is unchanged —
// a visitor who has asked for nothing is offered nothing — so what is pinned
// here is the GATE, not the absence.
const CTA_BLOCK = (() => {
  const from = BODY.indexOf('data-quick-estimate');
  const to = BODY.indexOf('id="fares-window"');
  return BODY.slice(from, to === -1 ? from + 3000 : to);
})();

test('the estimate carries a BOOK NOW, and it ships hidden', () => {
  assert.ok(/data-book-cta/.test(CTA_BLOCK), 'the estimate has no Book Now control');
  const tag = CTA_BLOCK.match(/<a[^>]*data-book-cta[^>]*>/);
  assert.ok(tag, 'the Book Now control is not a link');
  assert.ok(/\bhidden\b/.test(tag[0]),
    'the Book Now button ships visible — it must not appear before a price exists');
  assert.ok(/href="book\.html"/.test(tag[0]), 'Book Now does not point at book.html');
  assert.ok(/>\s*Book Now\s*</i.test(CTA_BLOCK), 'the button does not read "Book Now"');
});

test('it sits BELOW the estimate, not above it', () => {
  const fare = CTA_BLOCK.indexOf('data-fare-estimate');
  const cta  = CTA_BLOCK.indexOf('data-book-cta');
  assert.ok(fare !== -1 && cta !== -1 && cta > fare,
    'the Book Now button is not below the price it is meant to follow');
});

test('the reveal is gated on the RENDERED price, and re-runs on every render', () => {
  const q = APP.slice(APP.indexOf('function initQuick'));
  const body = q.slice(0, q.indexOf('\n  }\n'));
  assert.ok(/data-book-cta/.test(body), 'the quick estimate never looks for the button');
  // The gate must read the price that is actually on screen. A flag set by the
  // success path would drift the moment a new ending is added to the estimate.
  assert.ok(/querySelector\('\.fe-amount'\)/.test(body),
    'the reveal is not gated on the rendered .fe-amount — it could show with no price');
  assert.ok(/MutationObserver/.test(body),
    'nothing re-evaluates the button when the estimate re-renders; editing an address would leave a stale button');
  assert.ok(/setAttribute\('hidden'/.test(body) && /removeAttribute\('hidden'\)/.test(body),
    'the button is never actually hidden again');
  // Watching the estimate box alone is not enough: updateFare is debounced by
  // half a second, and on a non-airport route a network lookup follows. For
  // that whole window BOOK NOW would sit under a price that no longer matches
  // the fields. Measured: without this the button survived the full 500ms.
  assert.ok(/addEventListener\('input', function \(\) \{ cta\.setAttribute\('hidden', ''\); \}\)/.test(body),
    'a keystroke does not hide the button — it would advertise a stale price for the debounce window');
});

test('a "we could not price this" ending shows no button', () => {
  // Both graceful-degrade endings render .fe-note and NO .fe-amount, so the
  // same gate that reveals on a price keeps them silent. Pinned so nobody
  // "helpfully" adds an amount span to a message that has no number in it.
  const est = APP.slice(APP.indexOf('function makeEstimator'));
  const body = est.slice(0, est.indexOf('\n  }\n\n'));
  const msgEndings = body.match(/fare-estimate msg[\s\S]{0,400}?fe-note/g) || [];
  assert.ok(msgEndings.length >= 2, 'expected the two "could not price it" endings');
  for (const m of msgEndings) {
    assert.ok(!/fe-amount/.test(m), 'a no-price message now renders an amount — the button would appear with no fare');
  }
});

test('clicking it carries the addresses over rather than re-asking', () => {
  const q = APP.slice(APP.indexOf('function initQuick'));
  const body = q.slice(0, q.indexOf('\n  }\n'));
  assert.ok(/cta\.addEventListener\('(mousedown|click)', remember\)/.test(body),
    'the draft is not saved on the way out — the booking form would open empty');
  // …into the mechanism that already exists, not a second one.
  assert.ok(/sessionStorage\.setItem\(DRAFT_KEY/.test(APP), 'the carry-over no longer uses sessionStorage');
  assert.ok(/function applyDraft/.test(APP) && /applyDraft\(draftFields\)/.test(APP),
    'book.html no longer applies the carried-over draft');
  assert.ok(/draft\[k\] = \{ full: full, label:/.test(APP),
    'the FULL address is no longer preserved beside the short label');
});

test('the button is the primary frame, and takes its look from the system', () => {
  const tag = CTA_BLOCK.match(/<a[^>]*data-book-cta[^>]*>/)[0];
  assert.ok(/class="[^"]*\bwm-primary\b/.test(tag),
    'the button does not carry .wm-primary, so it is not the primary bolder-label frame');
  const THEME = read('westmere-theme.css');
  const sec = THEME.slice(THEME.indexOf('.qe-book {'));
  assert.ok(sec, 'the button has no layout rule');
  const block = sec.slice(0, sec.indexOf('}'));
  // Position only. A size or a colour here would fork the button system.
  assert.ok(!/font-size|font-weight|background|border(?!-)|color/.test(block),
    'the .qe-book rule restates a look instead of leaving it to .wm-primary: ' + block.replace(/\s+/g, ' '));
  assert.ok(/\.qe-book\[hidden\]\s*{\s*display:\s*none/.test(THEME),
    'display:block would out-specify the hidden attribute and the button would show with no price');
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
