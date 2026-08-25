/**
 * THE TAB BADGE IS A NUMBER, AND IT READS LIKE ONE —
 *   node server/tests/nav-count-badge.test.js   (also gated by `npm test`)
 *
 * The owner reported the To Confirm tab as showing "a plain red dot". The count
 * was in fact being written into it all along — but at 16px, in Cormorant (a
 * light high-contrast display serif, with old-style figures), a single digit
 * reduced to a smudge inside a red circle. Reported as a dot because that is
 * what it looked like.
 *
 * Worse, font-weight:700 was set on a face fetched only at 300/400/500, so the
 * browser synthesised the bold and smeared the single glyph that mattered.
 *
 * The house runs ONE typeface on purpose, so the cure is not a UI font — it is
 * a bigger circle, a bigger glyph, and a weight that is genuinely loaded. This
 * pins those, plus tabular figures and no inherited tracking, so a later
 * re-skin cannot quietly put the owner back to squinting at a dot.
 *
 * Pure Node. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { regionFrom } = require('./_source');
const OWNER = read('westmere-owner.html');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const rule = (() => {
  const i = OWNER.indexOf('.bn-dot{');
  assert.ok(i !== -1, '.bn-dot rule is missing entirely');
  return OWNER.slice(i, OWNER.indexOf('}', i) + 1);
})();

console.log('\nThe count badge');

test('the weight is one that is actually LOADED, never a synthesised bold', () => {
  // Cormorant Garamond is fetched at 300/400/500 only. font-weight:700 made the
  // browser fake it, and a faked bold on a single 13px numeral is a smudge —
  // half of why this read as a dot.
  const m = /font-weight:\s*([0-9]+|bold)/.exec(rule);
  assert.ok(m, 'the badge must state a weight');
  assert.ok(['300', '400', '500'].indexOf(m[1]) !== -1,
    'font-weight:' + m[1] + ' is not loaded for this face — the browser would synthesise it');
  // The css2 request, not the preconnect hint that precedes it.
  const link = /<link[^>]+fonts\.googleapis\.com\/css2\?[^>]*>/.exec(OWNER);
  assert.ok(link, 'the webfont request is missing');
  const weights = (/wght@([^&"']+)/.exec(link[0]) || [])[1] || '';
  assert.ok(weights.split(/[;,]/).indexOf(m[1]) !== -1,
    'font-weight:' + m[1] + ' is not among the weights fetched (' + weights + ') — it would be synthesised');
});

test('it takes its face from the theme, declaring none of its own', () => {
  // The house runs ONE typeface (DESIGN.md §1) — reaching for a UI stack here
  // would be a design decision smuggled in as a bug fix.
  assert.ok(!/font-family/.test(rule), 'the badge must inherit the theme face');
});

test('figures are tabular and untracked', () => {
  assert.ok(/font-variant-numeric:[^;]*tabular-nums/.test(rule),
    '9 → 10 must not make the badge jump');
  // Cormorant defaults to OLD-STYLE figures: its "1" draws as a small-cap I and
  // its "3" drops below the baseline. Lovely in prose, unreadable as a count.
  assert.ok(/font-variant-numeric:[^;]*lining-nums/.test(rule),
    'the badge must ask for lining figures, or the numerals sit at text height');
  assert.ok(/letter-spacing:\s*0/.test(rule),
    'the nav tracks its labels; a single digit inherits that and sits off-centre');
});

test('there is room for the glyph', () => {
  const px = (prop) => {
    const m = new RegExp(prop + ':\\s*([0-9.]+)px').exec(rule);
    return m ? parseFloat(m[1]) : null;
  };
  assert.ok(px('min-width') >= 20, 'min-width must be at least 20px (was 16, and it showed)');
  assert.ok(px('height') >= 20, 'height must be at least 20px');
  const fs_ = /font-size:\s*([0-9.]+)rem/.exec(rule);
  assert.ok(fs_ && parseFloat(fs_[1]) >= 0.8,
    'the numeral must be at least .8rem — .72rem is where it stopped being a number');
});

console.log('\nWhat the badge says');

const wmCountLabel = (() => {
  const m = /function wmCountLabel\(n\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(m, 'wmCountLabel is missing');
  return new Function('return ' + m[0])();
})();

test('zero shows nothing at all', () => {
  for (const v of [0, null, undefined, '', NaN, -1]) {
    assert.strictEqual(wmCountLabel(v), '', 'a badge with no work behind it must not appear (' + v + ')');
  }
});

test('a real count shows the number', () => {
  assert.strictEqual(wmCountLabel(1), '1');
  assert.strictEqual(wmCountLabel(3), '3', 'the owner asked to see "3", not a dot');
  assert.strictEqual(wmCountLabel(99), '99');
});

test('a runaway count is capped rather than stretching the tab', () => {
  assert.strictEqual(wmCountLabel(100), '99+');
  assert.strictEqual(wmCountLabel(4821), '99+');
});

/* Bounded by what follows in the source, never by a character count — a fixed
   slice silently stops covering its subject the moment the code around it
   grows (server/tests/guard-hygiene.test.js). */
const badgeRegion = (id) => regionFrom(OWNER, "var dot=document.getElementById('" + id + "')",
  [/\n\s*\/\//, /\n\s*if\(!drivers\.length\)/, /\n\s*buildToday\(\)/]);

test('BOTH badges are written by the same helper', () => {
  // Two badges formatting counts two ways is how they start disagreeing.
  assert.ok(/wmCountLabel\(/.test(badgeRegion('toconfirm-dot')), 'the To Confirm badge must use wmCountLabel');
  assert.ok(/wmCountLabel\(/.test(badgeRegion('drivers-dot')), 'and so must the Drivers badge');
});

test('a badge is hidden at zero and shown otherwise', () => {
  for (const id of ['toconfirm-dot', 'drivers-dot']) {
    assert.ok(/display=\s*\w+\s*\?\s*'flex'\s*:\s*'none'/.test(badgeRegion(id)),
      id + ' must be hidden when the count is zero');
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/nav-count-badge\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
