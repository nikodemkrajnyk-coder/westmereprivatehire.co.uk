// Bump CACHE whenever westmere-rider.html (or any precached asset) changes, so
// returning devices re-run install and drop the stale copy in activate().
// GUARDRAIL: server/tests/rider-cache.test.js pins this to the rider-html hash
// below — if you edit westmere-rider.html without bumping both, `npm test` fails.
// rider-html-sha256: d9fdc05de93eed85eed7e00ec13c1740f24beaa0525776db729af70d4fe36742
var CACHE = 'westmere-rider-v4';
var PRECACHE = [
  '/westmere-rider.html',
  '/config.js',
  '/address-normalize.js',
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

  e.respondWith(
    fetch(e.request).then(function (res) {
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
