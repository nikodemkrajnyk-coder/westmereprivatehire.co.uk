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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
