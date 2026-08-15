/**
 * The hero photograph rotates — run with:
 *   node server/tests/hero-rotate.test.js   (also gated by `npm test`)
 *
 * A slow crossfade between hero photographs, in the same register as the
 * reviews. The owner will add photographs to these lists himself, so the two
 * things that must not rot are (a) adding one stays a one-line job, and (b) a
 * photograph he adds cannot make the heading unreadable.
 *
 * WHAT THIS PINS
 *   · every hero page carries a list, and the list leads with the photo that is
 *     also its inline background — that inline photo is what paints before this
 *     script runs, and if the first entry differed the hero would visibly jump;
 *   · every path in every list actually exists in assets/;
 *   · one photo degrades to a static hero, reduced motion disables it entirely;
 *   · the SCRIM still sits above the photographs, so a bright one cannot wash
 *     out the copy halfway through a fade;
 *   · the timings still match reviews.js — two things moving at two speeds on
 *     one page is what makes a page feel restless.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const JS = read('hero-rotate.js');
const THEME = read('westmere-theme.css');
const PAGES = ['index.html', 'airport-transfers.html', 'services.html', 'contact.html', 'about.html'];

function heroTag(src) {
  const m = /<section class="hero[^"]*"[\s\S]*?>/.exec(src);
  assert.ok(m, 'no hero section');
  return m[0];
}
function photosOf(tag) {
  const m = /data-hero-photos="([\s\S]*?)"/.exec(tag);
  return m ? m[1].split('|').map(s => s.trim()).filter(Boolean) : [];
}

console.log('\nThe hero photograph rotates');

// ── The lists ────────────────────────────────────────────────────────────
test('every hero page carries a photo list and loads the script', () => {
  for (const p of PAGES) {
    const src = read(p);
    assert.ok(/data-hero-photos=/.test(src), p + ' has no data-hero-photos list');
    assert.ok(/hero-rotate\.js/.test(src), p + ' never loads hero-rotate.js, so its list does nothing');
    assert.ok(/<script defer src="\/hero-rotate\.js">/.test(src),
      p + ' loads the rotation without defer — it must not compete with first paint');
  }
});

test('every photograph in every list actually exists', () => {
  const missing = [];
  for (const p of PAGES) {
    for (const photo of photosOf(heroTag(read(p)))) {
      if (!exists(photo)) missing.push(p + ' -> ' + photo);
    }
  }
  assert.deepStrictEqual(missing, [],
    'these hero photos are listed but not in the repo — each would fade in as a grey rectangle:\n      ' +
    missing.join('\n      '));
});

test('the list LEADS with the photo the page already paints inline', () => {
  // The inline background-image is what shows before the script runs, and if
  // the rotation started on a different photograph the hero would jump.
  for (const p of PAGES) {
    const tag = heroTag(read(p));
    const first = photosOf(tag)[0];
    assert.ok(first, p + ' has an empty list');
    assert.ok(tag.includes(first),
      p + ' starts its rotation on ' + first + ', which is not the photo in its inline background — the hero would jump on load');
  }
});

test('adding a photo is one line — the list is the only thing to edit', () => {
  // No page may hard-code its photographs into the script or a per-page copy.
  for (const p of PAGES) {
    const src = read(p);
    // NB: not /hero-photo/ — the ATTRIBUTE is data-hero-photos and would match
    // itself. What must not appear is the mechanism: a layer class, a timer.
    assert.ok(!/class="hero-photo"|heroRotate|DWELL_MS|setInterval/.test(src),
      p + ' has its own copy of the rotation logic — adding a photo would mean editing code, not a list');
  }
  assert.strictEqual((JS.match(/DWELL_MS\s*=/g) || []).length, 1, 'the dwell is defined more than once');
});

// ── The behaviour ────────────────────────────────────────────────────────
test('one photo degrades to a static hero — no layers, no timer', () => {
  assert.ok(/photos\.length < 2\)\s*return;/.test(JS),
    'a single-photo hero would still build layers and run a timer, which is how a static hero flickers');
});

test('reduced motion turns it off entirely', () => {
  assert.ok(/prefers-reduced-motion: reduce/.test(JS), 'the script never checks prefers-reduced-motion');
  // The guard must sit BEFORE the code that builds layers, not merely exist.
  const guard = JS.indexOf('if (reduce) return;');
  const build = JS.indexOf('insertBefore');
  assert.ok(guard !== -1, 'the script reads the preference but never acts on it');
  assert.ok(guard < build || JS.indexOf('function init()') < guard,
    'reduced motion must stop the rotation before any layer is built, not merely shorten the fade');
  assert.ok(!/querySelectorAll\('\[data-hero-photos\]'\)[\s\S]{0,400}if \(reduce\)/.test(JS),
    'the heroes are collected before the reduced-motion check');
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.hero-photo\s*{\s*transition: none/.test(THEME),
    'the CSS must also kill the transition, for a visitor who turns it on mid-visit');
});

test('a photo that fails to load is dropped, not shown', () => {
  assert.ok(/img\.onerror/.test(JS), 'a 404 would fade in as a grey rectangle');
  assert.ok(/ok\.length > 1/.test(JS), 'if only one photo survives preloading, it must not rotate against itself');
});

// ── Legibility: the thing a new photo could break ────────────────────────
test('the scrim stays ABOVE the photographs', () => {
  assert.ok(/\.hero-photo\s*{[\s\S]*?z-index:\s*0/.test(THEME), '.hero-photo must sit at the bottom of the stack');
  assert.ok(/\.hero:after\s*{\s*z-index:\s*1;?\s*}/.test(THEME),
    'the scrim has no explicit layer — paint order changes the moment a positioned child is inserted, ' +
    'which is exactly what the rotation does, and the copy would end up over a bare photograph');
  assert.ok(/\.hero-content{[^}]*z-index:2/.test(read('styles.css')), 'the hero copy must stay on top');
});

test('every hero still carries its own scrim over the photographs', () => {
  for (const p of PAGES) {
    const tag = heroTag(read(p));
    const hasGradient = /linear-gradient\(/.test(tag);
    const src = read(p);
    // Either the hero's own gradient, or the shared .hero:after wash — both is
    // the norm. What must never happen is neither.
    assert.ok(hasGradient || /\.hero:after|\.hero\.center:after/.test(read('styles.css')),
      p + ' has no overlay at all — a light photograph in the rotation would wash the heading out');
  }
  assert.ok(/\.hero:after\{content:''/.test(read('styles.css')), 'the shared hero scrim is gone from styles.css');
});

test("each layer carries the PAGE'S OWN gradient, not just the shared wash", () => {
  // Found on the countryside photo: the hero's inline background is a gradient
  // AND a photo in one declaration, and the layers are children that paint OVER
  // it. Without copying that gradient forward, the rotation kept only the much
  // lighter .hero:after wash and a bright photograph left the tagline barely
  // readable. Each page's gradient is tuned to that page; it has to travel.
  assert.ok(/function scrimOf\(/.test(JS), 'the page gradient is no longer carried onto the layers');
  assert.ok(/backgroundImage = scrim \+ 'url\('/.test(JS),
    'a layer is set without the scrim in front of its photo');
  assert.strictEqual((JS.match(/scrim \+ 'url\('/g) || []).length, 2,
    'both the first layer and every subsequent swap must carry the scrim');

  // And it must actually extract what each page declares.
  const scrimOf = new Function('el',
    JS.slice(JS.indexOf('function scrimOf'), JS.indexOf('function rotate(el, photos)')) + '\nreturn scrimOf(el);');
  for (const p of PAGES) {
    const tag = heroTag(read(p));
    const m = /style="([^"]*)"/.exec(tag);
    const el = { style: { backgroundImage: (m ? m[1] : '').replace(/^background-image:/, '') } };
    const got = scrimOf(el);
    const declares = /linear-gradient\(/.test(tag);
    if (declares) {
      assert.ok(/^linear-gradient\(/.test(got) && /,\s*$/.test(got),
        p + ' declares a gradient the extractor did not pick up: ' + JSON.stringify(got));
    }
  }
});

test('the "Pre-bookings only" note and the buttons are untouched', () => {
  // The rotation inserts BEFORE the hero content; nothing else may move.
  assert.ok(/el\.insertBefore\(d, el\.firstChild\)/.test(JS),
    'the photo layers must be inserted first in the hero, beneath everything else');
  for (const p of ['index.html', 'contact.html']) {
    assert.ok(/Pre-bookings only/.test(read(p)), p + ' lost its pre-bookings note');
  }
});

// ── Feel: it must move at the same speed as the reviews ──────────────────
test('the timings match the reviews fade', () => {
  const R = read('reviews.js');
  const rDwell = /setInterval\(step,\s*(\d+)\)/.exec(R);
  const rFade = /\},\s*(\d+)\);/.exec(R.slice(R.indexOf("classList.add('is-out')")));
  assert.ok(rDwell && rFade, 'could not read the reviews timings — re-point this assertion');
  const hDwell = +/DWELL_MS\s*=\s*(\d+)/.exec(JS)[1];
  const hFade = +/FADE_MS\s*=\s*(\d+)/.exec(JS)[1];
  assert.strictEqual(hDwell, +rDwell[1], 'the hero dwells for ' + hDwell + 'ms, the reviews for ' + rDwell[1] + 'ms');
  assert.strictEqual(hFade, +rFade[1], 'the hero fade is ' + hFade + 'ms, the reviews fade is ' + rFade[1] + 'ms');
  assert.ok(/transition: opacity 1\.4s ease/.test(THEME), 'the CSS fade must match the reviews easing and duration');
});

test('it does not animate a hero nobody is looking at', () => {
  assert.ok(/visibilitychange/.test(JS), 'a background tab would keep crossfading, for nothing, on battery');
});

test('it does not block first paint', () => {
  assert.ok(/readyState === 'complete'|addEventListener\('load'/.test(JS),
    'the rotation must wait for load — decoding photographs must not compete with first paint');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/hero-rotate\.test\.js/.test(read('package.json')), 'hero-rotate.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
