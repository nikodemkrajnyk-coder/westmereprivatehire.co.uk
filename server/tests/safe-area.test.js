/**
 * THE TOP-LEFT CONTROL MUST BE REACHABLE — run with:
 *   node server/tests/safe-area.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   "The top-left Driver / back control sits too high and can't be clicked —
 *   it's under the iPhone status bar. Same for the return button on any
 *   preview." Both are the first thing inside a layer pinned to `inset:0`,
 *   which starts at the PHYSICAL top of the display: behind the clock on a
 *   notched iPhone, and behind the dynamic island on a newer one.
 *
 *   The page header got this right long ago — `--safe-top`, which is
 *   env(safe-area-inset-top). Layers opened on top of it did not, because each
 *   sets its own inline geometry and there is nothing to inherit. The admin app
 *   had no safe-area handling anywhere at all.
 *
 * WHAT IS GUARDED
 *   1. Every full-screen layer that carries a top-left control declares the
 *      inset — by name (.wm-safe-top) or in its own padding.
 *   2. The class actually resolves to a top padding built from the inset, and
 *      the token it is built on is defined in both apps.
 *   3. env() is zero unless the page asks for viewport-fit=cover, so the staff
 *      apps must keep asking.
 *   4. A sheet that rises from the bottom stops short of the notch instead of
 *      sliding under it.
 *   5. NEGATIVE: the reader actually fails on a layer with no inset.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { stripComments: strip } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { regionFrom } = require('./_source');

/* A layer is "safe" when the element that is pinned to the top of the screen
   either carries the class or builds the inset into its own padding. Read from
   the FUNCTION that creates it, bounded by the next function — not by a count
   of characters either side, which stops covering its subject the moment
   somebody adds a line. A safe-area rule elsewhere in a 9,000-line app proves
   nothing about this layer. */
function layerDeclaration(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, 'the layer is gone: ' + marker);
  /* Back to the function this statement lives in, then forward to the next. */
  const start = src.lastIndexOf('function ', i);
  assert.ok(start > -1, 'the layer is not built inside a function: ' + marker);
  return regionFrom(src, start, [/\nfunction /, /\nasync function /]);
}
const hasInset = (s) => /wm-safe-top/.test(s) || /padding(-top)?:\s*(calc\()?[^;'"]*(env\(safe-area-inset-top|var\(--safe-top)/.test(s);

// ── 1. THE LAYERS THE OWNER NAMED ────────────────────────────────────────
console.log('\nEvery full-screen layer clears the status bar');

const LAYERS = [
  ['westmere-owner.html', "the driver page",        "ov.id = 'ow-driver';"],
  ['westmere-owner.html', "the operator page",      "ov.id = 'ow-operator';"],
  ['westmere-owner.html', "the invoice/PDF preview", "aria-label', title || 'Invoice preview'"],
  ['westmere-admin.html', "the admin PDF preview",  "aria-label', title || 'Invoice preview'"]
];
for (const [file, what, marker] of LAYERS) {
  test(file + ': ' + what + ' sits below the clock', () => {
    const decl = layerDeclaration(strip(read(file)), marker);
    assert.ok(hasInset(decl),
      what + ' is pinned to the top of the display with no safe-area inset — its back control is '
      + 'behind the status bar on an iPhone:\n      ' + decl.replace(/\s+/g, ' ').slice(0, 220));
  });
}

test('the trip page and the assistant, which already had it, still do', () => {
  /* They were right before this change; a sweep that "tidied" them would put
     the bug back somewhere nobody is looking. */
  const css = read('westmere-owner.html');
  for (const sel of ['.trip-page-hd{', '.assist-header{']) {
    const i = css.indexOf(sel);
    assert.ok(i > -1, sel + ' is gone');
    assert.ok(hasInset(css.slice(i, css.indexOf('}', i))), sel + ' lost its safe-area padding');
  }
});

test('both staff app headers carry it', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    const css = read(f);
    const i = css.indexOf('.topbar{');
    assert.ok(i > -1, f + ' has no .topbar');
    assert.ok(hasInset(css.slice(i, css.indexOf('}', i))),
      f + ': the page header sits under the status bar');
  }
});

// ── 2. THE CLASS, AND THE TOKEN UNDER IT ─────────────────────────────────
test('the class is real, and is built from the inset', () => {
  const T = read('westmere-theme.css');
  const i = T.indexOf('.wm-safe-top{');
  assert.ok(i > -1, 'the theme has no .wm-safe-top — the layers reference a class that does not exist');
  const rule = T.slice(i, T.indexOf('}', i));
  assert.ok(/padding-top:\s*env\(safe-area-inset-top/.test(rule),
    '.wm-safe-top does not pad the top from the inset: ' + rule);
  /* A fallback, because env() is unknown to older engines and an unresolvable
     value would drop the declaration entirely. */
  assert.ok(/env\(safe-area-inset-top,\s*0px\)/.test(rule),
    'the inset needs its 0px fallback or the padding is dropped where env() is unknown');
});

test('the token is defined in both apps', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    assert.ok(/--safe-top:\s*env\(safe-area-inset-top,\s*0px\)/.test(read(f)),
      f + ' does not define --safe-top, so every calc() that uses it is dropped');
  }
});

test('the staff apps still ask for the full screen', () => {
  /* env(safe-area-inset-top) is ZERO on an iPhone unless the page opts into
     drawing under the bars with viewport-fit=cover. Lose that and every
     padding above silently becomes nothing — the bug comes back with all the
     code still in place, which is the hardest kind to find. */
  for (const f of ['westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html']) {
    const m = /<meta name="viewport"[^>]*content="([^"]*)"/i.exec(read(f));
    assert.ok(m, f + ' has no viewport meta');
    assert.ok(/viewport-fit=cover/.test(m[1]),
      f + ' no longer asks for viewport-fit=cover, so every safe-area inset computes to zero');
  }
});

// ── 3. BOTTOM SHEETS ─────────────────────────────────────────────────────
test('a sheet that rises from the bottom stops short of the notch', () => {
  const T = read('westmere-theme.css');
  const i = T.indexOf('.wm-sheet-top-cap{');
  assert.ok(i > -1, 'the theme has no cap for a tall bottom sheet');
  assert.ok(/max-height:\s*calc\(100vh - env\(safe-area-inset-top/.test(T.slice(i, T.indexOf('}', i))),
    'the cap must be measured from the usable height, not from 100vh');
  const H = strip(read('westmere-owner.html'));
  assert.ok(/wm-sheet-top-cap/.test(H), 'no sheet in the owner app uses it');
  /* The send sheet is the tall one — a job, the money and two buttons. Read as
     the function that builds it, bounded by the next one. */
  const sheet = layerDeclaration(H, "el.id = 'dispatch-sheet'");
  assert.ok(/wm-sheet-top-cap/.test(sheet), 'the send sheet can still slide under the notch');
});

// ── 4. NEGATIVE ──────────────────────────────────────────────────────────
test('NEGATIVE: the reader fails a layer with no inset', () => {
  assert.strictEqual(hasInset("o.style.cssText = 'position:fixed;inset:0;padding:1rem'"), false,
    'a plain 1rem padding was accepted as a safe area — the guard would not have caught the bug it was written for');
  assert.strictEqual(hasInset("ov.className = 'wm-safe-top';"), true);
  assert.strictEqual(hasInset("padding:calc(.8rem + env(safe-area-inset-top,0px)) 1rem"), true);
  assert.strictEqual(hasInset("padding:calc(var(--safe-top) + .6rem) 1rem"), true);
  /* And a safe-area inset on the BOTTOM is not the top. */
  assert.strictEqual(hasInset("padding-bottom:env(safe-area-inset-bottom,0px)"), false,
    'the bottom inset was read as the top one');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('safe-area.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
