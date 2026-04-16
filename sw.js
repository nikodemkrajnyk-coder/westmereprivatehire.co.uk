// Westmere service worker — self-uninstaller.
// Previous versions cached owner/admin HTML aggressively, which kept stale
// Automation UI visible even after the source had been stripped. Until we
// wrap the apps for the App Store we don't need offline support, so this
// version clears every cache on activation and unregisters itself.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (clients) { clients.forEach(function (c) { c.navigate(c.url); }); })
  );
});

// Never intercept requests — let the network handle everything fresh.
self.addEventListener('fetch', function () { /* no-op */ });
