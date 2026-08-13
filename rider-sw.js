// Bump CACHE whenever westmere-rider.html (or any precached asset) changes, so
// returning devices re-run install and drop the stale copy in activate().
// GUARDRAIL: server/tests/rider-cache.test.js pins this to the rider-html hash
// below — if you edit westmere-rider.html without bumping both, `npm test` fails.
// rider-html-sha256: 79740ecd71a70b079659f43a1276085c5bca30e8d0b24c212a94dd4abf357772
var CACHE = 'westmere-rider-v32';
var PRECACHE = [
  '/westmere-rider.html',
  '/config.js',
  '/address-normalize.js',
  '/wm-lifecycle.js',
  '/wm-buttons.css',
  '/westmere-theme.css',
  '/rider-manifest.json',
  '/rider-icon-192.svg',
  '/rider-icon-512.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // CROSS-ORIGIN GUARD: never intercept requests to other origins. This SW's
  // scope is the whole site, so without this it would proxy https://js.stripe.com
  // and Google Fonts through fetch() — and Stripe REFUSES to be served via a
  // service worker (returns 503), which left window.Stripe undefined and the pay
  // page stuck on "Online payment temporarily unavailable". Let cross-origin
  // requests go straight to the network. GUARDRAIL: rider-cache.test.js.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // HTML/navigation: bypass the BROWSER HTTP CACHE, not just our own cache.
  // express.static sends no Cache-Control for .html — only ETag/Last-Modified —
  // so Chrome/Safari apply *heuristic* freshness (~10% of the document's age)
  // and can serve a stale westmere-rider.html for days WITHOUT revalidating.
  // A plain fetch() here reads that same HTTP cache, so "network-first" still
  // returned the old HTML: this is why the desktop layout fix kept appearing
  // not to land on a returning desktop browser. `cache: 'reload'` forces a
  // real revalidation for the document itself. GUARDRAIL: rider-cache.test.js.
  // (Fetch by URL rather than re-wrapping the Request: a navigate-mode Request
  // cannot be reconstructed with its mode intact, and an HTML GET needs nothing
  // from the original but its URL and cookies.)
  var isDoc = e.request.mode === 'navigate' || /\.html$/.test(url.pathname) || url.pathname === '/';
  var hit = isDoc
    ? fetch(e.request.url, { cache: 'reload', credentials: 'include', redirect: 'follow' })
    : fetch(e.request);

  // ── respondWith MUST ALWAYS RESOLVE TO A RESPONSE ──
  // This handler previously ended `.catch(function(){ return caches.match(e.request); })`.
  // caches.match() resolves to UNDEFINED when nothing matches, and
  // respondWith(undefined) is a network error — the browser renders a
  // COMPLETELY BLANK PAGE. Combined with the cache:'reload' above, which sends
  // every document straight to the network with no HTTP-cache fallback, one
  // network blip on a desktop browser blanked the whole account page. A cached
  // copy did not always save it either: the precache key is
  // "/westmere-rider.html", so arriving with ?verified=1 or ?reset_token=…
  // missed the cache entirely and blanked too.
  //
  // The ladder below can never produce undefined:
  //   network → our cache (ignoring the query string) → a plain retry that MAY
  //   use the HTTP cache → a readable last-resort page.
  // GUARDRAIL: rider-cache.test.js drives this handler with a failing network
  // and an empty cache and asserts a real Response still comes back.
  function cachedOrRetry() {
    return caches.match(e.request, { ignoreSearch: isDoc })
      .then(function (cached) {
        if (cached) return cached;
        // Our cache has nothing. Try the network once more WITHOUT cache:'reload',
        // so a browser HTTP-cache copy can still answer.
        return fetch(e.request).catch(function () { return null; });
      })
      .then(function (res) {
        if (res) return res;
        if (!isDoc) return new Response('', { status: 504, statusText: 'Offline' });
        // Last resort for a page: say so plainly and offer a retry, rather than
        // handing the browser a network error and showing nothing at all.
        return new Response(
          '<!doctype html><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Westmere · My Account</title>' +
          '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
          'background:#f5f2ec;color:#1b1b1a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-align:center}' +
          'div{max-width:22rem;padding:2rem}h1{font-family:Georgia,serif;font-weight:400;font-size:1.5rem;margin:0 0 .6rem}' +
          'p{color:rgba(27,27,26,.6);line-height:1.7;margin:0 0 1.4rem}' +
          'a{display:inline-block;padding:.8rem 1.6rem;border:1px solid #1b1b1a;color:#1b1b1a;text-decoration:none;' +
          'letter-spacing:.18em;text-transform:uppercase;font-size:.7rem}</style>' +
          '<div><h1>We could not load your account</h1>' +
          '<p>You appear to be offline. Your bookings are safe — please try again in a moment, ' +
          'or call us on 07930 342593.</p>' +
          '<a href="' + url.pathname + '">Try again</a></div>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      });
  }

  e.respondWith(
    hit.then(function (res) {
      if (res.ok) {
        var clone = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(e.request, clone); }).catch(function () {});
      }
      return res;
    }).catch(cachedOrRetry)
  );
});
