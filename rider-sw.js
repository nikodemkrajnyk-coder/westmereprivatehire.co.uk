// Bump CACHE whenever westmere-rider.html (or any precached asset) changes, so
// returning devices re-run install and drop the stale copy in activate().
// GUARDRAIL: server/tests/rider-cache.test.js pins this to the rider-html hash
// below — if you edit westmere-rider.html without bumping both, `npm test` fails.
// rider-html-sha256: 4a4b8a1ea7f66ae6f00637563586e35a82fa370db7353bd2da21f935a69ca0eb
var CACHE = 'westmere-rider-v15';
var PRECACHE = [
  '/westmere-rider.html',
  '/config.js',
  '/address-normalize.js',
  '/wm-lifecycle.js',
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

  e.respondWith(
    hit.then(function (res) {
      if (res.ok) {
        var clone = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(e.request, clone); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
