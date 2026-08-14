/**
 * "Pre-bookings only" — run with:
 *   node server/tests/advance-booking.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   Westmere is a PRE-BOOKED service. It takes no on-demand work. A customer
 *   phoned expecting a car within the minute, which is a wasted call for him
 *   and a bad first impression for them, so the site now says so at the three
 *   moments where that expectation forms — the booking form, the homepage and
 *   the contact page — plus My Account, which is the same booking form again.
 *
 *   Copy is the easiest thing in a codebase to lose. It gets dropped in a
 *   redesign, or the class gets renamed and the line stops being styled and
 *   nobody notices because it still *renders*. So this pins three things:
 *   that the note is present on every surface that needs it, that it says the
 *   thing it needs to say, and that it stays QUIET — small, muted, and not a
 *   banner. A note that grows into an alert is as wrong as a missing one.
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

const THEME = read('westmere-theme.css');

// Every surface where somebody could form the wrong expectation.
const SURFACES = [
  ['book.html', 'the booking form'],
  ['index.html', 'the homepage'],
  ['contact.html', 'the contact page'],
  ['westmere-rider.html', "My Account's booking form"]
];

console.log('\nPre-bookings only');

test('every surface that takes a booking carries the note', () => {
  const missing = SURFACES.filter(([f]) => !/class="wm-advance"/.test(read(f)))
    .map(([f, what]) => f + ' (' + what + ')');
  assert.deepStrictEqual(missing, [],
    'these surfaces no longer tell the customer we are pre-booked only:\n      ' + missing.join('\n      '));
});

test("the note actually says 'Pre-bookings only', not something vague", () => {
  for (const [f, what] of SURFACES) {
    const src = read(f);
    const m = /<p class="wm-advance">([\s\S]*?)<\/p>/.exec(src);
    assert.ok(m, f + ' has the class but no note');
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    // The owner chose this phrase. It is deliberately general — no lead time
    // is quoted anywhere, because quoting one ("24 hours") invites an argument
    // about whether 23 counts.
    assert.ok(/pre-bookings only/i.test(text),
      what + ' no longer says "Pre-bookings only" — it reads: ' + JSON.stringify(text));
    assert.ok(!/\b(hour|day|notice period|\d+\s*h)\b/i.test(text),
      what + ' has started quoting a lead time. The phrase is deliberately general: ' + JSON.stringify(text));
    assert.ok(text.length > 30, what + "'s note is too short to be understood: " + JSON.stringify(text));
  }
});

test('the two surfaces where someone is ABOUT to act spell out why', () => {
  // The booking form and the contact page are where the wrong expectation
  // turns into a wasted call. Those two say what we do NOT do, in words.
  for (const f of ['book.html', 'contact.html']) {
    const text = /<p class="wm-advance">([\s\S]*?)<\/p>/.exec(read(f))[1].replace(/<[^>]+>/g, '');
    assert.ok(/on-demand/i.test(text),
      f + ' no longer says we do not do on-demand pickups — "Pre-bookings only" alone is easy to read past');
    assert.ok(/reserve ahead/i.test(text), f + ' should tell the customer what to do instead, not only what we will not do');
  }
});

test('the note is placed where the decision is made, not at the bottom', () => {
  // Booking form: immediately after the Time field. A line under the submit
  // button is read after the expectation has already formed.
  const book = read('book.html');
  const time = book.indexOf('<label>Time</label>');
  const note = book.indexOf('class="wm-advance"');
  assert.ok(note > time && note - time < 400,
    'the booking-form note has drifted away from the date/time fields — that is the moment it matters');

  // Contact page: above the phone number, since the phone is how the wrong
  // expectation arrived in the first place.
  const contact = read('contact.html');
  assert.ok(contact.indexOf('class="wm-advance"') < contact.indexOf('tel:+447930342593'),
    'the contact note must sit ABOVE the phone number, or it is read after the call is made');
});

test('it stays a quiet note, not a banner', () => {
  const i = THEME.indexOf('.wm-advance {');
  assert.ok(i !== -1, 'the theme no longer styles .wm-advance — the note would render as raw body copy');
  const block = THEME.slice(i, THEME.indexOf('}', i));

  const size = /font-size:\s*var\((--text-[a-z0-9]+)/.exec(block);
  assert.ok(size, 'the note size must come from the type scale');
  const rem = parseFloat(new RegExp('\\' + size[1] + ':\\s*([0-9.]+)rem').exec(THEME)[1]);
  assert.ok(rem <= 0.8,
    'the note now renders at ' + size[1] + ' = ' + rem + 'rem. It is meant to be understated — ' +
    'above ~0.8rem it reads as an alert, which is exactly what the owner did not want.');

  assert.ok(/color:\s*var\(--westmere-muted/.test(block), 'the note must be in the muted tone, not full-strength ink');
  // A banner is a filled strip. §20's rule applies here too.
  assert.ok(!/background/.test(block),
    'the note has grown a background — nothing highlights by filling, and a filled strip IS the banner ' +
    'the owner asked us not to build');
  assert.ok(!/border/.test(block), 'the note has grown a border — it is a line of copy, not a callout box');
});

test('the wording and the tone come from tokens, not literals', () => {
  const i = THEME.indexOf('.wm-advance {');
  const whole = THEME.slice(i, THEME.indexOf('#scr-app .wm-advance'));
  const literals = [...whole.matchAll(/:\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map(m => m[1]);
  assert.deepStrictEqual(literals, [],
    'the note hardcodes a colour outside a var() fallback: ' + literals.join(', '));
  assert.ok(/var\(--space-/.test(whole) && /var\(--weight-/.test(whole),
    'spacing and weight should come off the scales so the note can be re-tuned in one place');
});

test('My Account keeps the muted tone despite the navy blanket', () => {
  // §15.2 paints every descendant of #scr-app navy with !important, which would
  // flatten the muted note into full-strength copy and make it shout.
  assert.ok(/#scr-app \.wm-advance/.test(THEME),
    "the rider app's note has no exception from §15.2 — it will render at full navy and stop being quiet");
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/advance-booking\.test\.js/.test(read('package.json')),
    'advance-booking.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
