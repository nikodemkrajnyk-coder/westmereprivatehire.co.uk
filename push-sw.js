// Westmere push notification service worker.
// Handles incoming Web Push messages and shows them as browser notifications.
// Registered separately from sw.js so it stays active (sw.js self-unregisters).

self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  var title = data.title || 'New Booking';
  var options = {
    body: data.body || '',
    icon: '/rider-icon-192.svg',
    badge: '/rider-icon-192.svg',
    tag: data.tag || 'wph-booking',
    data: data,
    requireInteraction: true
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.includes('westmere-owner') && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      return clients.openWindow('/westmere-owner.html');
    })
  );
});
