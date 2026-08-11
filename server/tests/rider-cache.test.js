/**
 * Rider service-worker cache guardrail — run with:
 *   node server/tests/rider-cache.test.js   (also gated by `npm test`)
 *
 * The rider PWA (westmere-rider.html) is served through rider-sw.js. The browser
 * only re-installs a service worker when the SW file's BYTES change; if the HTML
 * is edited but `CACHE` in rider-sw.js is not bumped, returning devices keep the
 * stale precached HTML and render the old layout (the "My Account desktop shows
 * mobile width" incident).
 *
 * This test pins the CACHE version to a hash of westmere-rider.html: change the
 * HTML and you MUST bump `CACHE` and update the `rider-html-sha256:` comment, or
 * this fails and blocks the deploy. Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nRider service-worker cache guardrail');

const sw = read('rider-sw.js');

test('rider-sw.js declares a versioned CACHE', () => {
  assert.ok(/var CACHE = 'westmere-rider-v\d+';/.test(sw),
    "rider-sw.js must declare  var CACHE = 'westmere-rider-v<N>';");
});

test('fetch handler has a same-origin guard (never proxies Stripe/fonts/cross-origin)', () => {
  // The SW scope is the whole site. Without a cross-origin guard it proxies
  // https://js.stripe.com through fetch(), Stripe returns 503 in a SW context,
  // window.Stripe stays undefined and the pay page falls back to "payment
  // temporarily unavailable". The guard must bail BEFORE respondWith/fetch.
  assert.ok(/origin\s*!==\s*self\.location\.origin\s*\)\s*return;/.test(sw),
    "rider-sw.js fetch handler must bail on cross-origin requests: `if (url.origin !== self.location.origin) return;`");
  // And the guard must sit before the caching respondWith (so it can't be reached).
  const guardIdx = sw.search(/origin\s*!==\s*self\.location\.origin/);
  const respondIdx = sw.search(/respondWith/);
  assert.ok(guardIdx !== -1 && respondIdx !== -1 && guardIdx < respondIdx,
    'the cross-origin guard must come BEFORE respondWith(), or cross-origin requests still get proxied');
});

test('activate() deletes every cache except the current CACHE', () => {
  assert.ok(/keys\.filter\([^)]*\)[\s\S]*?k !== CACHE[\s\S]*?caches\.delete/.test(sw),
    'activate() must delete stale caches so returning users get fresh HTML');
});

test('CACHE version matches the current westmere-rider.html (bump on every edit)', () => {
  const actual = crypto.createHash('sha256').update(read('westmere-rider.html')).digest('hex');
  const m = sw.match(/rider-html-sha256:\s*([0-9a-f]{64})/);
  assert.ok(m, 'rider-sw.js is missing the `rider-html-sha256:` pin comment');
  assert.strictEqual(m[1], actual,
    'westmere-rider.html changed. Bump CACHE (westmere-rider-vN → vN+1) in rider-sw.js ' +
    'AND update the rider-html-sha256 comment to:\n        ' + actual);
});

// ── Items 1 & 2: My Account readability + desktop layout ─────────────────
const riderHtml = read('westmere-rider.html');
test('rider My Account pickers/inputs are light + readable (color-scheme light)', () => {
  assert.ok(/<meta name="color-scheme" content="light"/.test(riderHtml), 'must declare a light color-scheme (readable date/time pickers)');
  // The custom date/time/pick dropdowns + form inputs force a light scheme so
  // native controls and text render dark-on-light (the dark/unreadable picker bug).
  for (const cls of ['.cal-drop', '.time-drop', '.pick-drop', '.fi']) {
    const m = riderHtml.match(new RegExp(cls.replace('.', '\\.') + '\\{[^}]*\\}'));
    assert.ok(m && /color-scheme:\s*light/.test(m[0]), cls + ' must set color-scheme:light for readable pickers');
  }
});
test('rider My Account has a DESKTOP layout (not mobile-width on a wide screen)', () => {
  const m = riderHtml.match(/@media\(min-width:\s*720px\)\{[\s\S]*?max-width:\s*(\d+)px/);
  assert.ok(m, 'must have a @media(min-width:720px) desktop layout so it is not a narrow mobile column');
  assert.ok(parseInt(m[1], 10) >= 720, 'desktop layout must widen the container beyond mobile width');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
