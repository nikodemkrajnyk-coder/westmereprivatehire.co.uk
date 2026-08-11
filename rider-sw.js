// Bump CACHE whenever westmere-rider.html (or any precached asset) changes, so
// returning devices re-run install and drop the stale copy in activate().
// GUARDRAIL: server/tests/rider-cache.test.js pins this to the rider-html hash
// below — if you edit westmere-rider.html without bumping both, `npm test` fails.
// rider-html-sha256: 39c40bb7246646be15b5c6b66a4bcb1748239b897f388f5ea3a4fe02b7afe1b4
var CACHE = 'westmere-rider-v2';
var PRECACHE = [
  '/westmere-rider.html',
  '/config.js',
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
