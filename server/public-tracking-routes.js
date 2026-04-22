// Public rider-facing live tracking — fetch driver location for an own booking.
//
// Access is gated by booking ref + the last 9 digits of the customer phone.
// That's not auth-grade, but it stops casual enumeration and is the same
// pattern used by the major rideshare apps for their "track your trip"
// SMS links.

const express = require('express');
const { getDb } = require('./db');

const router = express.Router();

function phoneTail(s) {
  return String(s || '').replace(/\D/g, '').slice(-9);
}

router.get('/tracking/:ref', (req, res) => {
  const db = getDb();
  const ref = String(req.params.ref || '').trim().toUpperCase();
  const phone = phoneTail(req.query.phone);
  if (!ref) return res.status(400).json({ error: 'Booking ref required' });
  if (!phone || phone.length < 6) return res.status(400).json({ error: 'Phone required to verify booking' });

  const booking = db.prepare(`
    SELECT b.id, b.ref, b.pickup, b.destination, b.date, b.time, b.status,
           b.fare, b.driver_id, b.passenger_phone,
           c.phone AS cust_phone, c.full_name AS cust_name
      FROM bookings b
      LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.ref = ?
  `).get(ref);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Accept either the linked customer's phone or the guest passenger phone
  // captured on the booking itself.
  const cust = phoneTail(booking.cust_phone);
  const pax  = phoneTail(booking.passenger_phone);
  if ((!cust || cust !== phone) && (!pax || pax !== phone)) {
    return res.status(403).json({ error: 'Phone does not match this booking' });
  }

  const out = {
    ok: true,
    booking: {
      ref: booking.ref, pickup: booking.pickup, destination: booking.destination,
      date: booking.date, time: booking.time, status: booking.status, fare: booking.fare
    },
    driver: null,
    location: null
  };

  if (booking.driver_id) {
    const drv = db.prepare(`
      SELECT id, full_name, vehicle, reg, photo
        FROM users WHERE id = ?
    `).get(booking.driver_id);
    if (drv) {
      out.driver = {
        name: drv.full_name,
        vehicle: drv.vehicle,
        reg: drv.reg,
        photo: drv.photo || null
      };
    }
    const loc = db.prepare(`
      SELECT lat, lng, heading, speed, accuracy, updated_at
        FROM driver_locations WHERE driver_id = ?
    `).get(booking.driver_id);
    if (loc) {
      out.location = {
        lat: loc.lat, lng: loc.lng,
        heading: loc.heading, speed: loc.speed, accuracy: loc.accuracy,
        updated_at: loc.updated_at
      };
    }
  }

  res.json(out);
});

module.exports = router;
