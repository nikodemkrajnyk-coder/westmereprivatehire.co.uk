/**
 * THE HERO OVERLAY IS CENTRED ON ITS INK —
 *   node server/tests/hero-centring.test.js   (also gated by `npm test`)
 *
 * letter-spacing puts its gap AFTER every letter, the last one included. A
 * tracked line's box therefore ends one tracking unit past the final glyph, and
 * text-align:center centres the BOX — so the visible ink sits half a tracking
 * unit to the LEFT of true centre.
 *
 * On the hero that was visible, because each line is tracked differently and so
 * the stack did not line up with itself. Measured on the homepage:
 *
 *     WESTMERE          -3.12px   (.09em on 69.12px)
 *     PRIVATE HIRE      -2.05px   (.32em on 12.8px)
 *     TRAVEL, REDEFINED -0.61px   (.10em on 12px)
 *     the rule           0.00px   (no tracking — the only honest one)
 *
 * §24 of the theme pulls each line back by ONE tracking unit on the right.
 *
 * WHAT THIS GUARDS: that the compensation still MATCHES the tracking. The two
 * numbers live in different files and different sections — the h1's tracking is
 * in §3 and §14, the .sub's is in styles.css, and the .tag's comes from §16.3's
 * generic micro-label tier, which catches the hero's tag by accident of naming.
 * Change any one of them without the other and the hero goes quietly crooked
 * again, by an amount too small to notice in a diff and big enough to see on a
 * phone.
 *
 * It also pins the two decisions that are easy to undo by tidying: the fix is
 * margin-right (padding would narrow a line that already nearly wraps), and it
 * applies to CENTRED heroes only (on .hero.left the trailing space falls at the
 * far end, where shifting it would introduce the fault, not remove it).
 *
 * Pure static analysis of the shipped stylesheets. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* COMMENTS STRIPPED BEFORE ANY SELECTOR IS MATCHED. These files explain
   themselves at length — §24 alone names ".hero.left" and "padding-left" in
   order to say it uses neither — and a rule that cannot tell prose from code
   fails on the explanation. That has now happened five times in this codebase;
   it is stripped at the door here rather than worked around per assertion.
   Newlines are preserved so nothing else shifts. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const THEME_RAW = read('westmere-theme.css');
const THEME = strip(THEME_RAW);
const STYLES = strip(read('styles.css'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

/** The em value a declaration sets, from the LAST rule that matches — later
 *  wins in CSS, and .tag is set twice in the theme. */
function lastEm(css, selectorRe, prop) {
  const re = new RegExp('([^{}]*)\\{([^}]*)\\}', 'g');
  let m, found = null;
  while ((m = re.exec(css))) {
    if (!selectorRe.test(m[1])) continue;
    const d = new RegExp(prop + '\\s*:\\s*(-?[\\d.]+)em', 'i').exec(m[2]);
    if (d) found = parseFloat(d[1]);
  }
  return found;
}
/** Same, but only inside a given @media block. */
function inMedia(css, mediaRe, selectorRe, prop) {
  const re = /@media([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  let m, found = null;
  while ((m = re.exec(css))) {
    if (!mediaRe.test(m[1])) continue;
    const v = lastEm(m[2], selectorRe, prop);
    if (v !== null) found = v;
  }
  return found;
}
// The theme's @media blocks must not pollute the top-level scan.
const THEME_TOP = THEME.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
const STYLES_TOP = STYLES.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

console.log('\nThe compensation matches the tracking');

test('WESTMERE — h1 desktop', () => {
  const track = lastEm(THEME_TOP, /(?:^|[,\s])\.hero h1\b/, 'letter-spacing');
  const comp  = lastEm(THEME_TOP, /(?:^|[,\s])\.hero\.center h1\b/, 'margin-right');
  assert.ok(track !== null, 'the hero h1 tracking is gone from the theme');
  assert.ok(comp !== null, 'no margin-right compensation on .hero.center h1');
  assert.strictEqual(comp, -track,
    'h1 is tracked ' + track + 'em but compensated ' + comp + 'em — the hero is ' +
    Math.abs((track + comp) / 2).toFixed(4) + 'em off centre');
});

test('WESTMERE — h1 on a phone (the ≤900px override)', () => {
  const track = inMedia(THEME, /max-width:\s*900px/, /(?:^|[,\s])\.hero h1\b/, 'letter-spacing');
  const comp  = inMedia(THEME, /max-width:\s*900px/, /\.hero\.center h1/, 'margin-right');
  assert.ok(track !== null, '§14 no longer re-tracks the hero h1 — check this is still needed');
  assert.ok(comp !== null, 'the mobile tracking is overridden but the compensation is not');
  assert.strictEqual(comp, -track,
    'mobile h1 tracked ' + track + 'em, compensated ' + comp + 'em');
});

test('PRIVATE HIRE — .sub', () => {
  const track = lastEm(STYLES_TOP, /\.hero \.sub\b/, 'letter-spacing');
  const comp  = lastEm(THEME_TOP, /\.hero\.center \.sub\b/, 'margin-right');
  assert.ok(track !== null && comp !== null, 'tracking or compensation missing for .sub');
  assert.strictEqual(comp, -track, '.sub tracked ' + track + 'em, compensated ' + comp + 'em');
});

test('TRAVEL, REDEFINED — .tag', () => {
  /* Its tracking comes from §16.3's micro-label tier, which lists .tag among a
     dozen app labels and catches the hero's by name. That is why this is
     checked rather than assumed. */
  const track = lastEm(THEME_TOP, /(?:^|[,\s])\.tag\s*(?:,|$)/, 'letter-spacing');
  const comp  = lastEm(THEME_TOP, /\.hero\.center \.tag\b/, 'margin-right');
  assert.ok(track !== null, '.tag is no longer tracked by the micro-label tier');
  assert.ok(comp !== null, 'no compensation on .hero.center .tag');
  assert.strictEqual(comp, -track, '.tag tracked ' + track + 'em, compensated ' + comp + 'em');
});

console.log('\nThe decisions behind it');

test('it is margin-right, never padding-left', () => {
  assert.ok(/24\. TRACKED HERO TYPE/.test(THEME_RAW), '§24 is gone');
  const block = /\.hero\.center h1[\s\S]*$/.exec(THEME);   // the rules, not the prose
  assert.ok(!/\.hero\.center[^{]*\{[^}]*padding-left/.test(block[0]),
    'padding narrows the line, and WESTMERE already fills 330px of a 343px measure ' +
    'on a phone — a few pixels less and it wraps');
  assert.ok(/margin-right/.test(block[0]), 'the correction must widen, not narrow');
});

test('LEFT-aligned heroes are left alone', () => {
  const block = /\.hero\.center h1[\s\S]*$/.exec(THEME)[0];
  assert.ok(!/\.hero\.left[^{]*\{[^}]*margin-right\s*:\s*-/.test(block),
    'on .hero.left the trailing space falls at the far end where nobody sees it — ' +
    'shifting those would introduce the fault, not remove it');
  assert.ok(/\.hero\.center/.test(block), 'the compensation must be scoped to centred heroes');
});

test('every centred hero page gets it; the left ones do not', () => {
  const centred = [], left = [];
  for (const p of ['index.html', 'airport-transfers.html', 'services.html', 'contact.html', 'about.html']) {
    const m = /<section class="hero([^"]*)"/.exec(read(p));
    assert.ok(m, p + ' has no hero');
    (/\bcenter\b/.test(m[1]) ? centred : left).push(p);
  }
  assert.deepStrictEqual(centred, ['index.html', 'airport-transfers.html', 'contact.html'],
    'the set of centred heroes changed — check §24 still covers them');
  assert.deepStrictEqual(left, ['services.html', 'about.html']);
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/hero-centring\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
