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
  assert.ok(/<meta name="color-scheme" content="only light"/.test(riderHtml),
    "must declare color-scheme 'only light' — plain 'light' still lets Android auto-dark repaint the page (see payment-settled.test.js)");
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

test('a navigation is NEVER answered with a redirected response (Safari outage)', () => {
  // THE OUTAGE: iPhone Safari refused to open the site —
  //     "Safari can't open the page. The error was: 'Response served by service
  //      worker has redirections'"
  // — and My Account only appeared after a second reload.
  //
  // /westmere-account.html 301s to /westmere-rider.html (server/index.js). The
  // SW fetched documents with redirect:'follow', so it followed that 301 itself
  // and handed the navigation a response with redirected=true. The Fetch spec
  // forbids exactly that: a service worker may not answer a navigation with a
  // response that followed a redirect, because the URL bar would then disagree
  // with the document. Safari enforces it by failing the navigation outright.
  //
  // Driven for real: run the shipped handler against a network that redirects,
  // and assert that whatever reaches respondWith is not a redirected response.
  const vm = require('vm');
  const handlerSrc = sw.slice(sw.indexOf("self.addEventListener('fetch'"));
  const body = handlerSrc.slice(handlerSrc.indexOf('{', handlerSrc.indexOf('function (e)')) + 1,
    handlerSrc.lastIndexOf('});'));

  function drive({ requestUrl, mode, redirectMode, cachedIsRedirected }) {
    let responded = null;
    let fetchOpts = null;
    class Res {
      constructor(b, i) {
        this.body = b; this.status = (i && i.status) || 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = (i && i.headers) || {}; this.redirected = false; this.type = 'basic';
      }
      clone() { return this; }
      blob() { return Promise.resolve('body-bytes'); }
    }
    const sandbox = {
      URL, Response: Res, CACHE: 'test-v1',
      caches: {
        match: () => Promise.resolve(cachedIsRedirected
          ? { cached: true, ok: true, redirected: true, status: 200, headers: {}, type: 'basic',
              clone() { return this; }, blob() { return Promise.resolve('cached-bytes'); } }
          : undefined),
        open: () => Promise.resolve({ put: () => Promise.resolve() })
      },
      // The server 301s this path. What comes back depends on the redirect mode
      // the handler asked for — exactly as a real browser would behave.
      fetch: (u, opts) => {
        fetchOpts = opts || {};
        if (redirectMode === 'network-down') return Promise.reject(new Error('offline'));
        if (fetchOpts.redirect === 'manual') {
          return Promise.resolve({ type: 'opaqueredirect', status: 0, ok: false, redirected: false,
            headers: {}, clone() { return this; }, blob() { return Promise.resolve(''); } });
        }
        // redirect:'follow' (or unspecified) → the redirect was followed for us.
        return Promise.resolve({ type: 'basic', status: 200, ok: true, redirected: true,
          headers: {}, clone() { return this; }, blob() { return Promise.resolve('followed-bytes'); } });
      },
      self: { location: { origin: 'https://westmereprivatehire.co.uk' } },
      console: { log() {}, warn() {}, error() {} },
      e: {
        request: { url: requestUrl, method: 'GET', mode: mode || 'navigate' },
        respondWith: (p) => { responded = p; }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext('(function(e){' + body + '})(e)', sandbox);
    return { responded, opts: () => fetchOpts };
  }

  const ACCOUNT = 'https://westmereprivatehire.co.uk/westmere-account.html';
  const cases = [
    { label: 'navigating to the redirecting /westmere-account.html', requestUrl: ACCOUNT },
    { label: 'navigating to the site root', requestUrl: 'https://westmereprivatehire.co.uk/' },
    { label: 'navigation falling back to a REDIRECTED cached copy',
      requestUrl: ACCOUNT, redirectMode: 'network-down', cachedIsRedirected: true }
  ];

  return Promise.all(cases.map(c => {
    const { responded } = drive(c);
    assert.ok(responded && typeof responded.then === 'function', c.label + ': respondWith was not called');
    return responded.then(res => {
      assert.ok(res, c.label + ': respondWith resolved to nothing');
      assert.ok(!res.redirected,
        c.label + ': the service worker handed a NAVIGATION a response with redirected=true. ' +
        'Safari refuses to open the page ("Response served by service worker has redirections").');
    });
  }));
});

test('the SW asks for redirect:manual on navigations, so the browser does the redirect', () => {
  // The root fix, pinned at source: with 'manual' a 3xx comes back as an
  // opaqueredirect, which a service worker IS allowed to return for a
  // navigation. Switching this back to 'follow' reintroduces the outage.
  assert.ok(/redirect:\s*isNav\s*\?\s*'manual'\s*:\s*'follow'/.test(sw),
    "document fetches must use redirect:'manual' for navigations — 'follow' makes " +
    'the response carry the redirect and Safari rejects the navigation');
  assert.ok(/!res\.redirected/.test(sw),
    'a redirected response must never be written to the cache — a later navigation would read it back');
});

// ── NAVIGATION IS A SIDE MENU, NOT A BOTTOM BAR ──────────────────────────
// The owner asked for the nav to move off the bottom of the screen and into a
// drawer opened from the header. The risk in a change like this is silent loss
// of navigation: a drawer that cannot be opened, or that stays over the page
// after a selection, leaves the customer stuck on whatever tab they were on.
test('the bottom tab bar is gone and the side menu replaces it', () => {
  assert.ok(!/<div class="bottom-nav/.test(riderHtml) && !/id="bn-/.test(riderHtml),
    'the bottom tab bar markup must be removed — the side menu is the navigation now');
  assert.ok(/<aside class="side"[^>]*id="side-nav"/.test(riderHtml), 'the side menu must exist');
  // Every section the bottom bar carried must still be reachable.
  for (const id of ['sd-trips', 'sd-payments', 'sd-invoices', 'sd-details', 'sd-book']) {
    assert.ok(riderHtml.includes('id="' + id + '"'), 'the side menu is missing ' + id);
  }
});

test('NOTHING is mounted at the bottom of My Account', () => {
  // The owner's rule: the side menu is the only navigation. The bottom tab bar
  // went first; a slim secondary strip carrying Contact Us and Airport Rewards
  // survived it and is now gone too. Both items live in the side menu, so the
  // strip lost nothing — but a future "just a small bar at the bottom" is
  // exactly what this is here to stop.
  for (const gone of ['class="subnav"', 'id="sub-nav"', 'class="sub-item"', 'class="bottom-nav"', 'id="bn-']) {
    assert.ok(!riderHtml.includes(gone),
      'My Account still mounts something at the bottom (' + gone + ') — the side menu is the only nav');
  }
  // Nothing useful may be lost with it: both items must be in the side menu.
  for (const id of ['sd-contact', 'sd-rewards']) {
    assert.ok(riderHtml.includes('id="' + id + '"'),
      'the side menu must carry ' + id + ' — it was in the strip that was removed');
  }
  // And no orphan CSS pretending the strip is still there.
  assert.ok(!/\.subnav\s*\{/.test(riderHtml) && !/\.sub-item\s*\{/.test(riderHtml),
    'the removed bottom strip still has CSS in the page');
});

test('the side menu can be opened, and always closes again', () => {
  assert.ok(/class="tb-menu"[\s\S]{0,200}onclick="toggleSideMenu\(\)"/.test(riderHtml),
    'the header must carry a menu button wired to toggleSideMenu()');
  for (const fn of ['function openSideMenu', 'function closeSideMenu', 'function toggleSideMenu']) {
    assert.ok(riderHtml.includes(fn), 'missing ' + fn);
  }
  // Closing paths: the scrim, the close button, Escape, and — the one that
  // matters most on a phone — choosing a section.
  assert.ok(/id="side-scrim"[^>]*onclick="closeSideMenu\(\)"/.test(riderHtml), 'the scrim must close the menu');
  assert.ok(/class="side-close"[\s\S]{0,160}onclick="closeSideMenu\(\)"/.test(riderHtml), 'the drawer needs a close button');
  assert.ok(/e\.key==='Escape'[\s\S]{0,120}closeSideMenu\(\)/.test(riderHtml), 'Escape must close the menu');
  const goPage = riderHtml.slice(riderHtml.indexOf('function goPage(id){'), riderHtml.indexOf('function goPage(id){') + 700);
  assert.ok(/closeSideMenu\(\)/.test(goPage),
    'goPage() must close the drawer — otherwise the section it just opened is ' +
    'sitting behind a full-height panel on a phone');
});

test('the side menu is a drawer on a phone and a static column on desktop', () => {
  const drawer = riderHtml.match(/\.side\{[^}]*position:fixed[^}]*\}/);
  assert.ok(drawer, '.side must be a fixed off-canvas drawer at phone widths');
  assert.ok(/transform:translateX\(-10?2?%\)/.test(drawer[0]), 'the drawer must start off-canvas');
  assert.ok(/\.side\.open\{transform:translateX\(0\)\}/.test(riderHtml), '.side.open must slide it in');
  // …and above 980px it must go back to being an ordinary column, or the
  // desktop layout would have a permanently-hidden sidebar.
  const desktop = riderHtml.match(/@media\(min-width:980px\)\{[\s\S]{0,900}?\n\}/);
  assert.ok(desktop && /position:relative;transform:none/.test(desktop[0]),
    'at >=980px the sidebar must revert to a static column');
  assert.ok(desktop && /\.tb-menu,\.side-close\{display:none\}/.test(desktop[0]),
    'the hamburger and close button belong to the phone layout only');
});

test('the menu button is a real touch target and is accessible', () => {
  const btn = riderHtml.match(/\.tb-menu\{[^}]*\}/);
  assert.ok(btn, '.tb-menu rule missing');
  const size = btn[0].match(/width:(\d+)px;height:(\d+)px/);
  assert.ok(size && +size[1] >= 44 && +size[2] >= 44,
    'the menu button must be at least 44x44px to be tappable: ' + btn[0]);
  assert.ok(/aria-label="Open menu"/.test(riderHtml), 'the menu button needs an accessible name');
  assert.ok(/aria-controls="side-nav"/.test(riderHtml) && /aria-expanded="false"/.test(riderHtml),
    'the menu button must declare aria-controls and aria-expanded');
  assert.ok(/setAttribute\('aria-expanded','true'\)/.test(riderHtml) &&
            /setAttribute\('aria-expanded','false'\)/.test(riderHtml),
    'aria-expanded must track the drawer state, not be a static attribute');
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
