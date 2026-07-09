/**
 * Web Push helper — sends push notifications to subscribed owner browsers.
 *
 * Requires the `web-push` npm package and three Railway env vars:
 *   VAPID_PUBLIC_KEY   — generated with: npx web-push generate-vapid-keys
 *   VAPID_PRIVATE_KEY
 *   VAPID_EMAIL        — e.g. mailto:bookings@westmereprivatehire.co.uk
 */

let webpush = null;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[PUSH] web-push package not installed — push notifications disabled');
}

function isConfigured() {
  return !!(
    webpush &&
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_EMAIL
  );
}

let _vapidSet = false;
function _ensureVapid() {
  if (_vapidSet || !isConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  _vapidSet = true;
}

/**
 * Send a push notification payload to all stored subscriptions.
 * Expired/gone subscriptions (HTTP 410/404) are automatically deleted.
 *
 * @param {object} payload  — { title, body, data? }
 */
async function sendToAll(payload) {
  if (!isConfigured()) return;
  _ensureVapid();

  const { getDb } = require('./db');
  const db = getDb();
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;

  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 }
      )
    )
  );

  // Remove subscriptions that have gone away (browser unsubscribed or expired)
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason && r.reason.statusCode;
      if (code === 410 || code === 404) {
        try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subs[i].endpoint); } catch (_) {}
      } else {
        console.error('[PUSH] send failed for subscription', i, r.reason && r.reason.message);
      }
    }
  });
}

module.exports = { isConfigured, sendToAll };
