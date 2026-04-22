// Live driver tracking — authenticated driver location push + admin helpers.
// The public rider-facing tracking lookup lives in public-tracking-routes.js.

const express = require('express');
const { getDb } = require('./db');
const events = require('./events');

const router = express.Router();

// Driver (or owner/admin) pushes current GPS. Requires JWT auth — router is
// mounted behind requireAuth in index.js.
router.post('/driver/location', (req, res) => {
  if (!['driver', 'owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Driver access required' });
  }
  const { lat, lng, heading, accuracy, speed } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng required' });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat/lng out of range' });
  }
  const db = getDb();
  // Admin/owner may post on behalf of a specific driver by including driver_id.
  const driverId = (['admin', 'owner'].includes(req.auth.role) && req.body.driver_id)
    ? parseInt(req.body.driver_id, 10)
    : req.auth.id;
  db.prepare(`
    INSERT INTO driver_locations (driver_id, lat, lng, heading, accuracy, speed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(driver_id) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng,
      heading = excluded.heading, accuracy = excluded.accuracy,
      speed = excluded.speed, updated_at = datetime('now')
  `).run(driverId, lat, lng,
    heading == null ? null : +heading,
    accuracy == null ? null : +accuracy,
    speed == null ? null : +speed);
  try {
    events.broadcast('driver:location', { driverId, lat, lng, heading, speed, accuracy }, { roles: ['admin', 'owner'] });
  } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
