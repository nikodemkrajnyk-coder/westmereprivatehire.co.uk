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
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    // A test may return a promise (the service-worker handler is async). Await it
    // before the summary, or a real failure would be reported as a pass.
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log('  ✓ ' + name); passed++; },
        (e) => { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
      ));
      return;
    }
    console.log('  ✓ ' + name); passed++;
  } catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
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
test('the SW can NEVER respond with undefined (the blank-page outage)', () => {
  // THE OUTAGE: the fetch handler ended
  //     .catch(function(){ return caches.match(e.request); })
  // caches.match() resolves to UNDEFINED when nothing matches, and
  // respondWith(undefined) is a network error — the browser renders a
  // completely blank page. Paired with cache:'reload', which sends every
  // document straight to the network with no HTTP-cache fallback, one blip
  // blanked the whole account page on desktop. A query string (?verified=1,
  // ?reset_token=…) missed the precache key and blanked it too.
  //
  // Driven for real: run the shipped handler with a DEAD network and an EMPTY
  // cache and assert a genuine Response still comes back.
  const vm = require('vm');
  const handlerSrc = sw.slice(sw.indexOf("self.addEventListener('fetch'"));
  const body = handlerSrc.slice(handlerSrc.indexOf('{', handlerSrc.indexOf('function (e)')) + 1,
    handlerSrc.lastIndexOf('});'));

  function drive({ networkFails, cacheHas, requestUrl, mode }) {
    let responded = null;
    const sandbox = {
      URL, Response: class { constructor(b, i) { this.body = b; this.status = (i && i.status) || 200; this.ok = this.status < 400; this.headers = (i && i.headers) || {}; } clone() { return this; } },
      CACHE: 'test-v1',
      caches: {
        match: () => Promise.resolve(cacheHas ? { cached: true, ok: true, clone() { return this; } } : undefined),
        open: () => Promise.resolve({ put: () => Promise.resolve() })
      },
      fetch: () => networkFails ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, clone() { return this; } }),
      self: { location: { origin: 'https://westmereprivatehire.co.uk' } },
      console: { log() {}, warn() {}, error() {} },
      e: {
        request: { url: requestUrl, method: 'GET', mode: mode || 'navigate' },
        respondWith: (p) => { responded = p; }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext('(function(e){' + body + '})(e)', sandbox);
    return responded;
  }

  const cases = [
    { label: 'network down, nothing cached, plain URL', networkFails: true, cacheHas: false, requestUrl: 'https://westmereprivatehire.co.uk/westmere-rider.html' },
    { label: 'network down, nothing cached, URL WITH a query string', networkFails: true, cacheHas: false, requestUrl: 'https://westmereprivatehire.co.uk/westmere-rider.html?verified=1' },
    { label: 'network down, cache has a copy', networkFails: true, cacheHas: true, requestUrl: 'https://westmereprivatehire.co.uk/westmere-rider.html' }
  ];

  return Promise.all(cases.map(c => {
    const p = drive(c);
    assert.ok(p && typeof p.then === 'function', c.label + ': respondWith was not called with a promise');
    return p.then(res => {
      assert.ok(res !== undefined && res !== null,
        c.label + ': respondWith resolved to ' + res + ' — that is a network error and the ' +
        'customer sees a BLANK PAGE. It must always resolve to a Response.');
    });
  }));
});

test('a document fetch failure falls back before giving up', () => {
  assert.ok(/ignoreSearch/.test(sw),
    'the cache lookup must ignore the query string for documents, or arriving with ' +
    '?verified=1 or ?reset_token=… misses the precached page entirely');
  assert.ok(!/\.catch\(function \(\) \{\s*return caches\.match\(e\.request\);\s*\}\)/.test(sw),
    'the bare `catch -> caches.match` is the blank-page bug — it can resolve to undefined');
});

test('day mode never strips the My Account scenery (06:00–18:00 regression)', () => {
  // body.mode-day is toggled on between 06:00 and 18:00 and its rules are one
  // specificity step ABOVE the dashboard's own. This shipped a live regression:
  // body.mode-day::before replaced the Sussex backdrop with a flat cream
  // gradient, so for twelve hours a day customers saw the login screen on blank
  // grey. Anything mode-day restyles must be restated for mode-day.
  const hasDayOverride = (sel) => new RegExp('body\\.mode-day' + sel + '\\s*\\{').test(riderHtml);

  // 1. the fixed backdrop
  const dayBefore = [...riderHtml.matchAll(/body\.mode-day::before\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(dayBefore.length, 'body.mode-day::before must be restated by the dashboard styles');
  assert.ok(dayBefore.some(b => /sussex-coast\.webp/.test(b)),
    'day mode must keep the Sussex backdrop — it currently replaces it with a flat wash. ' +
    'Restate body.mode-day::before with the coast image.');

  // 2. the hero band
  assert.ok(hasDayOverride('\\s+\\.topbar'),
    'day mode must keep the hero band on .topbar, not a flat cream bar');

  // 3. the components the dashboard draws
  for (const sel of ['\\s+\\.trip-card', '\\s+\\.filter-btn']) {
    assert.ok(hasDayOverride(sel),
      'day mode must not re-skin ' + sel.trim() + ' back to the old palette');
  }

  // 4. and the last rule wins: every dashboard-level day override must come
  //    AFTER the original mode-day block, or it is dead CSS.
  const firstOriginal = riderHtml.indexOf('body.mode-day::before');
  const dashboardBlock = riderHtml.indexOf('wm-rider-dashboard');
  assert.ok(dashboardBlock !== -1, 'the dashboard style block must exist');
  const lastDayBefore = riderHtml.lastIndexOf('body.mode-day::before');
  assert.ok(lastDayBefore > dashboardBlock && lastDayBefore > firstOriginal,
    'the day-mode backdrop override must sit inside the dashboard block, after the original rule');
});

test('rider My Account has a DESKTOP layout (not mobile-width on a wide screen)', () => {
  // The breakpoint must fire at or below 720px CSS. A half-screen browser window
  // on a 1280–1440 desktop, or a browser at 150–200% page zoom, lands BELOW
  // 720px — and the account then renders as a full-width phone column on a
  // desktop machine, which is exactly the "My Account looks mobile on desktop"
  // report. Anything above 600px is comfortably wider than a phone in portrait.
  const bp = riderHtml.match(/@media\(min-width:\s*(\d+)px\)\{\s*\.screen\{/);
  assert.ok(bp, 'must have a @media(min-width:Npx) block that restyles .screen for desktop');
  const px = parseInt(bp[1], 10);
  assert.ok(px <= 720 && px >= 480,
    'the desktop breakpoint must be <=720px (half-screen windows and zoomed browsers sit below 720) and >=480px (do not catch phones): got ' + px);

  // …and it must actually FILL a desktop viewport rather than pin the app into a
  // fixed narrow box marooned in the middle of a wide screen.
  const block = riderHtml.match(/@media\(min-width:\s*\d+px\)\{\s*\.screen\{[\s\S]*?\}\s*\}/);
  assert.ok(block, 'desktop .screen block not found');
  assert.ok(/width:\s*calc\(100vw|width:\s*min\(/.test(block[0]),
    'the desktop shell must size off the viewport (calc(100vw - gutter) / min()), not a fixed max-width box');
  const cap = block[0].match(/max-width:\s*(\d+)px/);
  assert.ok(!cap || parseInt(cap[1], 10) >= 1280,
    'any desktop cap must be >=1280px so a normal desktop screen is filled, not cropped to a narrow column');
});
test('rider service worker revalidates HTML (stale desktop layout guard)', () => {
  // express.static sends no Cache-Control for .html — only ETag/Last-Modified —
  // so browsers apply heuristic freshness and can serve a stale rider HTML for
  // days. A plain fetch() inside the SW reads that same HTTP cache, so bumping
  // CACHE alone does NOT guarantee a returning desktop browser gets the new
  // layout. The document fetch must opt out of the HTTP cache.
  assert.ok(/cache:\s*'reload'/.test(sw),
    "rider-sw.js must fetch the document with { cache: 'reload' } so a returning browser cannot keep a stale HTML (and thus the old mobile-width layout)");
  const guard = sw.search(/cache:\s*'reload'/);
  const respond = sw.search(/respondWith/);
  assert.ok(guard !== -1 && respond !== -1 && guard < respond,
    "the document's no-HTTP-cache fetch must be set up before respondWith()");
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
