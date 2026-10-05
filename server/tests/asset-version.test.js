/**
 * THE APPS CANNOT BE SERVED STALE — run with:
 *   node server/tests/asset-version.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   The redesign went live and was verified byte-for-byte on the server, and
 *   the owner's iPhone went on showing the old black-and-white app for days.
 *   Nothing was wrong with the deploy: the HTML is served `no-store` and the
 *   stylesheets `max-age=0`, so an ordinary browser revalidates every load.
 *   A home-screen web app on iOS is not an ordinary browser — it keeps its own
 *   copy, and a service worker installed before any of this was fixed serves
 *   that copy instead of asking the network at all. The eviction code in the
 *   NEW page cannot run, because the new page is exactly what never loads.
 *
 * THE FIX THAT DOES NOT DEPEND ON THE DEVICE COOPERATING
 *   Every local stylesheet and script is requested at a URL that carries the
 *   release in it — /westmere-theme.css?v=2026-10-04a. A cache cannot answer
 *   with the old file because it has never seen that URL. The HTML itself is
 *   `no-store`, so the new URLs arrive on the next load, and everything behind
 *   them comes down fresh.
 *
 * …and so the next person does not have to guess what a phone is running, the
 * owner app prints the same version on its Settings sheet.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments } = require('./_source');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const APPS = ['westmere-owner.html', 'westmere-admin.html',
              'westmere-driver.html', 'westmere-rider.html'];
/** Every local stylesheet/script reference in an app, with its version. */
function refs(src) {
  const out = [];
  const re = /(?:src|href)="(\/[A-Za-z0-9._-]+\.(?:js|css))(\?v=([^"]*))?"/g;
  let m;
  while ((m = re.exec(src))) out.push({ file: m[1], version: m[3] || null });
  return out;
}

console.log('\nEvery app asset is requested at a versioned URL');

test('no app references a local script or stylesheet without a version', () => {
  const bare = [];
  for (const f of APPS) {
    for (const r of refs(read(f))) if (!r.version) bare.push(f + '  ' + r.file);
  }
  assert.deepStrictEqual(bare, [],
    'these can be answered from a stale cache for ever:\n      ' + bare.join('\n      '));
});

test('…and every reference in one app carries the SAME version', () => {
  /* Half a release is worse than none: a new stylesheet against old script, or
     the reverse, is a combination nobody has ever run. */
  for (const f of APPS) {
    const vs = [...new Set(refs(read(f)).map((r) => r.version))];
    assert.strictEqual(vs.length, 1, f + ' mixes asset versions: ' + vs.join(', '));
  }
});

test('the four staff and customer apps are on the same release', () => {
  const vs = APPS.map((f) => (refs(read(f))[0] || {}).version);
  assert.strictEqual(new Set(vs).size, 1,
    'the apps are on different releases: ' + APPS.map((f, i) => f + '=' + vs[i]).join(', '));
  assert.ok(/^\d{4}-\d{2}-\d{2}[a-z]?$/.test(vs[0]),
    'the version should read as a dated release, not a number nobody can place: ' + vs[0]);
});

test('every versioned file actually exists', () => {
  /* A typo in a versioned URL is a 404 that a bare one would have survived.
     /config.js is the exception by design: the server writes it per request
     (server/index.js) from the deploy environment, so there is no file. */
  const SERVED = ['/config.js'];
  const missing = [];
  for (const f of APPS) {
    for (const r of refs(read(f))) {
      if (SERVED.includes(r.file)) continue;
      if (!fs.existsSync(path.join(ROOT, r.file.replace(/^\//, '')))) missing.push(f + ' → ' + r.file);
    }
  }
  assert.deepStrictEqual(missing, [], 'these point at files that are not there:\n      ' + missing.join('\n      '));
  // …and the one that is generated must still be routed, or it 404s in silence.
  assert.ok(/app\.get\('\/config\.js'/.test(read('server/index.js')),
    '/config.js is referenced by the apps but no route serves it');
});

console.log('\nThe owner can read back what his phone is running');

test('the owner app prints its version, and it is the one on its assets', () => {
  const src = read('westmere-owner.html');
  const shown = /id="app-version">([^<]+)</.exec(src);
  assert.ok(shown, 'the owner app must show its version somewhere he can find it');
  assert.strictEqual(shown[1].trim(), refs(src)[0].version,
    'the version on screen disagrees with the one on the assets — the stamp is decoration');
});

test('there is a one-tap way out of a stuck device', () => {
  const src = stripComments(read('westmere-owner.html'));
  assert.ok(/function owForceRefresh/.test(src), 'the reload escape hatch is gone');
  const fn = src.slice(src.indexOf('function owForceRefresh'), src.indexOf('function owForceRefresh') + 900);
  assert.ok(/getRegistrations/.test(fn) && /unregister/.test(fn),
    'it must unregister any service worker — that is what serves the old page');
  assert.ok(/caches\.keys/.test(fn) && /caches\.delete/.test(fn), 'and empty the caches');
  assert.ok(/location\.replace/.test(fn), 'and reload past the HTTP cache');
  assert.ok(/onclick="owForceRefresh\(\)"/.test(read('westmere-owner.html')),
    'and he must be able to reach it without the console');
});

console.log('\nNothing may re-introduce an offline cache of the apps');

test('the service worker still caches nothing and uninstalls itself', () => {
  /* It was a real caching worker once, and that is what pinned the old
     Automation UI on devices after the source had been stripped. It is a
     self-uninstaller now and must stay one until somebody deliberately builds
     offline support with a versioned cache name. */
  const sw = read('sw.js');
  assert.ok(/registration\.unregister\(\)/.test(sw), 'sw.js must unregister itself');
  assert.ok(/caches\.delete/.test(sw), 'and empty every cache it finds');
  const fetchHandler = /addEventListener\('fetch'[\s\S]*$/.exec(sw);
  assert.ok(fetchHandler, 'sw.js must still declare a fetch handler');
  assert.ok(!/respondWith/.test(fetchHandler[0]),
    'the service worker must never answer a request from a cache again');
});

test('the staff apps evict a worker they find, on every load', () => {
  for (const f of ['westmere-owner.html']) {
    const src = stripComments(read(f));
    assert.ok(/getRegistrations\(\)[\s\S]{0,200}unregister\(\)/.test(src),
      f + ' no longer evicts a stale service worker on load');
  }
});

/* ════════════════════════════════════════════════════════════════════════
   A SHARED ASSET MAY NOT CHANGE WITHOUT THE RELEASE TOKEN MOVING.
   ════════════════════════════════════════════════════════════════════════
   THIS IS THE HOLE THAT LET THE BUG THROUGH, and it is worth stating exactly.
   Everything above checks that the token is PRESENT, that it is the SAME
   everywhere, and that the files it names EXIST. Not one of those notices the
   failure that actually happens: a release edits wm-compact.js, wm-lifecycle.js,
   address-normalize.js and westmere-theme.css, ships new HTML that references
   them at the OLD ?v= — and every check stays green while every warm browser
   keeps serving yesterday's copies against today's page.

   That is not a theoretical cache problem. The owner reported it once already
   ("the app still looks black and white on my iPhone"), and the consequences
   are worse than a stale look: the new HTML calls WMCompact.compareLine(),
   which does not exist in a cached wm-compact.js, and the handler throws
   part-way through rendering the page.

   So: a manifest of content hashes, checked in beside the token. Change a
   versioned file and this fails until the manifest is regenerated — and the
   manifest carries the token, so regenerating it is where you notice the token
   has to move too.

       node server/tests/asset-version.test.js --write    # regenerate
*/
const MANIFEST = 'asset-manifest.json';
const sha = (rel) => require('crypto').createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 16);

if (process.argv.includes('--write')) {
  const m = JSON.parse(read(MANIFEST));
  m.version = (/[?&]v=([\d-]+[a-z]?)/.exec(read('westmere-owner.html')) || [])[1] || m.version;
  Object.keys(m.files).forEach((f) => { m.files[f] = sha(f); });
  fs.writeFileSync(path.join(ROOT, MANIFEST), JSON.stringify(m, null, 2) + '\n');
  console.log('asset-manifest.json rewritten at version ' + m.version);
  process.exit(0);
}

test('every versioned asset still hashes to what the manifest recorded', () => {
  const m = JSON.parse(read(MANIFEST));
  const drifted = Object.keys(m.files).filter((f) => sha(f) !== m.files[f]);
  assert.deepStrictEqual(drifted, [],
    'these shipped files changed but the release token did not move, so warm '
    + 'browsers will keep the old copies: ' + drifted.join(', ')
    + '\n      → bump ?v= in every app, then: node server/tests/asset-version.test.js --write');
});

test('the manifest records the token the apps are actually serving', () => {
  const m = JSON.parse(read(MANIFEST));
  const inApp = (/[?&]v=([\d-]+[a-z]?)/.exec(read('westmere-owner.html')) || [])[1];
  assert.strictEqual(m.version, inApp,
    'the manifest was regenerated without the token being bumped — which is the '
    + 'whole point of regenerating it');
});

test('the manifest covers every asset the apps load with a version', () => {
  const m = JSON.parse(read(MANIFEST));
  const referenced = new Set();
  for (const app of ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html', 'westmere-driver.html']) {
    if (!fs.existsSync(path.join(ROOT, app))) continue;
    for (const hit of read(app).matchAll(/(?:src|href)="\/([A-Za-z0-9._-]+)\?v=/g)) referenced.add(hit[1]);
  }
  // config.js is generated per-request by the server, so it has no file to hash.
  referenced.delete('config.js');
  const missing = [...referenced].filter((f) => !(f in m.files));
  assert.deepStrictEqual(missing, [],
    'a versioned asset nothing is watching: ' + missing.join(', '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/asset-version\.test\.js/.test(read('package.json')),
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
