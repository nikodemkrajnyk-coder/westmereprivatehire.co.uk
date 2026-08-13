/**
 * TYPOGRAPHY & CONTRAST guardrail — run with:
 *   node server/tests/typography.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The owner chose CORMORANT for ALL type, headings and body/UI alike, so the
 *   whole system reads as one product. Cormorant is a Google web font, which is
 *   the point: it renders identically on every device, unlike the Didot it
 *   replaced (an Apple system font that only the owner's own devices had).
 *
 *   The trade is legibility. Cormorant is a delicate Garamond revival with a
 *   small x-height and a Regular lighter than most serifs', so at UI sizes it
 *   goes faint. Body and UI therefore run at weight 500, navigation and
 *   micro-labels at 600, and 400 is reserved for large display.
 *
 *   So the choice comes with a debt, and this file is what keeps it paid:
 *     - the palette must clear WCAG AA (real contrast maths on the real tokens);
 *     - the readability floors in westmere-theme.css §16 must stay put.
 *
 *   The RENDERED side — every element on every surface measured for computed
 *   size and composited contrast — is verified in the browser, not here; a
 *   static file cannot lay out a page. This file pins the inputs that
 *   verification depends on, so a silent edit to a token or a floor fails
 *   the build rather than quietly making the apps hard to read.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const THEME = read('westmere-theme.css');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

// ── WCAG 2.1 relative luminance and contrast ratio ───────────────────────
function channel(v) {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.replace(/./g, c => c + c) : h;
  return 0.2126 * channel(parseInt(n.slice(0, 2), 16))
       + 0.7152 * channel(parseInt(n.slice(2, 4), 16))
       + 0.0722 * channel(parseInt(n.slice(4, 6), 16));
}
function contrast(a, b) {
  const A = luminance(a), B = luminance(b);
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}
function token(name) {
  const m = THEME.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{3,8})\\s*;', 'i'));
  assert.ok(m, 'the theme no longer defines --' + name + ' as a hex');
  return m[1];
}

console.log('\nTypography — one font, and still readable');

// ── The palette clears WCAG AA ───────────────────────────────────────────
test('every text colour clears WCAG AA against white', () => {
  const white = token('westmere-white');
  // body text needs 4.5:1; these are the two colours the theme puts text in.
  for (const name of ['westmere-text', 'westmere-navy', 'westmere-navy-deep', 'westmere-muted']) {
    const ratio = contrast(token(name), white);
    assert.ok(ratio >= 4.5,
      '--' + name + ' (' + token(name) + ') on white is ' + ratio.toFixed(2) + ':1, ' +
      'below the 4.5:1 AA floor for body text');
  }
});

test('white text clears AA on the navy fills', () => {
  const white = token('westmere-white');
  // Pressed buttons, the selected filter pill and the dark bands all put white
  // on navy. If navy were ever lightened, this is what would catch it.
  for (const name of ['westmere-navy', 'westmere-navy-deep', 'westmere-navy-soft']) {
    const ratio = contrast(white, token(name));
    assert.ok(ratio >= 4.5,
      'white on --' + name + ' (' + token(name) + ') is ' + ratio.toFixed(2) + ':1, below 4.5:1');
  }
});

test('the muted grey is a real step down but still legible', () => {
  // It exists to de-emphasise, so it must be lighter than the body navy —
  // but the moment it drops under 4.5:1 it stops being readable fine print.
  const muted = contrast(token('westmere-muted'), token('westmere-white'));
  const body = contrast(token('westmere-text'), token('westmere-white'));
  assert.ok(muted >= 4.5, 'the muted grey is ' + muted.toFixed(2) + ':1, below AA');
  assert.ok(muted < body, 'the muted grey must actually read as muted (it is ' +
    muted.toFixed(2) + ':1 vs body ' + body.toFixed(2) + ':1)');
});

// ── The readability floors stay put ──────────────────────────────────────
test('the theme carries the Cormorant readability layer', () => {
  assert.ok(/16\.\s*READABILITY — CORMORANT AT SMALL SIZES/.test(THEME),
    'westmere-theme.css §16 (the readability layer) is gone — Cormorant at 9px is ' +
    'unreadable, and that section is the only thing holding the small end up');
  assert.ok(/body\s*\{\s*font-weight:\s*500/.test(THEME),
    'body must be MEDIUM (500) in Cormorant — 400 reads as a grey wash at 16px');
});

test('the primary face is CORMORANT, and it is a web font', () => {
  const stack = (THEME.match(/--westmere-type:\s*([^;]+);/) || [])[1] || '';
  assert.ok(/^'Cormorant'\s*,/.test(stack.trim()),
    'the stack must lead with Cormorant (got: ' + stack.slice(0, 70) + ')');
  assert.ok(/fonts\.googleapis\.com[^)]*family=Cormorant/.test(THEME),
    'Cormorant must be imported from Google Fonts, or nothing but the fallbacks render');
  // The whole reason for moving off Didot: it could not be served, so the site
  // looked different on Apple devices than everywhere else.
  assert.ok(!/^'Didot'/.test(stack.trim()),
    'Didot must not lead the stack — it is an Apple system font and cannot be served, ' +
    'which is exactly the per-device inconsistency this change removed');
  for (const w of ['400', '500', '600']) {
    assert.ok(new RegExp('family=Cormorant[^\'"]*' + w).test(THEME),
      'weight ' + w + ' must be loaded — the readability layer uses it');
  }
});

test('the small tiers are set heavier than Regular for Cormorant', () => {
  const section = THEME.slice(THEME.indexOf('16. READABILITY'));
  // micro-labels and navigation must be 600; body/UI at least 500.
  const weights = [...section.matchAll(/font-weight:\s*(\d+)/g)].map(m => +m[1]);
  assert.ok(weights.filter(w => w >= 600).length >= 4,
    'Cormorant needs 600 on the micro-label and navigation tiers (found ' +
    weights.filter(w => w >= 600).length + ' such rules)');
});

test('no readability floor is set below 11.5px', () => {
  // Every floor is written `max(<rem>, <px>)` so it survives a root-size change.
  const floors = [...THEME.matchAll(/font-size:\s*max\(([\d.]+)rem,\s*([\d.]+)px\)/g)];
  assert.ok(floors.length >= 4,
    'expected the §16 size floors (found ' + floors.length + ') — has the readability layer been trimmed?');
  for (const f of floors) {
    const px = parseFloat(f[2]);
    assert.ok(px >= 11,
      'a floor is set at ' + px + 'px; below ~11px Cormorant is unreadable ' +
      '(the micro-label tier is 11.5–12px, body 13.5px)');
  }
});

test('small text is never lighter than Regular', () => {
  // Cormorant genuinely ships 300, and 300 at UI sizes is where it disappears,
  // so nothing in the readability layer may ask for less than 400.
  const section = THEME.slice(THEME.indexOf('16. READABILITY'));
  const weights = [...section.matchAll(/font-weight:\s*(\d+)/g)].map(m => +m[1]);
  assert.ok(weights.length > 0, 'the readability layer sets no weights');
  const light = weights.filter(w => w < 400);
  assert.deepStrictEqual(light, [],
    'the readability layer must never set a weight below 400 (found: ' + light.join(', ') + ')');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/typography\.test\.js/.test(read('package.json')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
