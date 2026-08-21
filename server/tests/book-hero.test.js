/**
 * REQUEST-A-QUOTE HERO — run with:
 *   node server/tests/book-hero.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   book.html puts the hero photo and the booking form side by side in a grid.
 *   The form is ~1700px tall, so a stretched hero grid item inherited that
 *   height: a 712 x 1719 box, aspect 0.41, holding a 1600 x 900 photo. With
 *   `cover` the browser scales by HEIGHT and shows a 23%-wide vertical slice —
 *   and the part of that slice above the fold was terminal canopy and empty
 *   sky. The car, the chauffeur and the case were all below the fold. The photo
 *   looked fine in a full-element screenshot and wrong to an actual visitor,
 *   which is how it survived a review.
 *
 *   The hero is now pinned to the viewport, so its aspect is set by the WINDOW
 *   rather than by however long the form happens to be. `cover` then scales by
 *   width and the subject is in frame on load, at every desktop width.
 *
 * WHAT IS PINNED
 *   · the hero is viewport-bounded on desktop and the grid does not stretch it;
 *   · the mobile branch explicitly puts all three properties back, so the phone
 *     keeps the plain 300px band and never inherits a sticky viewport panel;
 *   · the sticky offset matches the sticky nav's height — if the nav grows and
 *     this does not, the hero slides under it;
 *   · the hero photo exists, is landscape, and is small enough to be a hero.
 *
 * Pure static analysis plus a real read of the image header. Exit 1 on failure.
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

const book = read('book.html');
const heroRule = (book.match(/\.book-hero\{[^}]*\}/) || [])[0] || '';
const mobileRule = (book.match(/@media\(max-width:850px\)\{[^]*?\.book-hero\{[^}]*\}/) || [])[0] || '';

console.log('\nREQUEST-A-QUOTE HERO\n');

test('the desktop hero is bounded by the viewport, not by the form', () => {
  assert.ok(/position:sticky/.test(heroRule),
    '.book-hero is no longer sticky. It will stretch to the booking form\'s ' +
    'height (~1700px), and `cover` will crop the 1600x900 photo to a ~23% ' +
    'vertical slice of sky. Keep it pinned to the viewport.');
  assert.ok(/height:calc\(100vh - \d+px\)/.test(heroRule),
    '.book-hero lost its viewport-relative height — its aspect ratio goes back ' +
    'to being decided by the length of the form beside it.');
});

test('the grid does not stretch the hero back to the form height', () => {
  const layout = (book.match(/\.book-layout\{[^}]*\}/) || [])[0] || '';
  assert.ok(/align-items:start/.test(layout),
    '.book-layout must not stretch its items — a stretched grid item is taller ' +
    'than its grid area and then has no room to stick.');
});

test('the sticky offset clears the sticky nav exactly', () => {
  const navH = (read('styles.css').match(/nav\{height:(\d+)px/) || [])[1];
  assert.ok(navH, 'could not read the nav height out of styles.css');
  const top = (heroRule.match(/top:(\d+)px/) || [])[1];
  const h = (heroRule.match(/height:calc\(100vh - (\d+)px\)/) || [])[1];
  assert.strictEqual(top, navH, 'hero sticks at ' + top + 'px but the nav is ' + navH + 'px tall — it will slide under the nav');
  assert.strictEqual(h, navH, 'hero height subtracts ' + h + 'px but the nav is ' + navH + 'px tall — the panel will overflow the viewport');
});

test('mobile explicitly resets all three properties', () => {
  // Not "mobile happens to look right" — the phone branch has to put position,
  // top and height back by name, or a future desktop tweak leaks onto phones.
  for (const prop of ['position:relative', 'top:auto', 'height:auto']) {
    assert.ok(mobileRule.includes(prop),
      'the max-width:850px branch does not reset ' + prop + ' on .book-hero — ' +
      'the phone would inherit the desktop viewport panel');
  }
  assert.ok(/min-height:300px/.test(mobileRule), 'the mobile hero lost its 300px band');
});

test('the hero photo exists and is a landscape image', () => {
  const src = (heroRule.match(/url\('([^']+)'\)/) || [])[1];
  assert.ok(src, '.book-hero has no background image');
  const file = path.join(ROOT, src);
  assert.ok(fs.existsSync(file), '.book-hero points at ' + src + ', which does not exist');
  const b = fs.readFileSync(file);
  assert.ok(b.length < 400 * 1024, src + ' is ' + Math.round(b.length / 1024) + 'KB — too heavy for an above-the-fold hero');
  // WebP VP8X extended header carries the canvas size as two 24-bit LE values.
  const i = b.indexOf(Buffer.from('VP8X'));
  assert.ok(i > 0, src + ' is not an extended WebP — cannot read its dimensions');
  const w = 1 + (b[i + 12] | (b[i + 13] << 8) | (b[i + 14] << 16));
  const h = 1 + (b[i + 15] | (b[i + 16] << 8) | (b[i + 17] << 16));
  assert.ok(w > h, src + ' is ' + w + 'x' + h + ' — a portrait hero crops badly in a wide band on phones');
  console.log('      ' + src + '  ' + w + 'x' + h + '  ' + Math.round(b.length / 1024) + 'KB');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/book-hero\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
