const express = require('express');
const { getDb } = require('./db');
const { sendAdminAlert } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const gcal = require('./google-calendar');
const events = require('./events');

const router = express.Router();

// ── Bookings ────────────────────────────────────────────────────────────

// List bookings (admin sees all, driver sees assigned, customer sees own)
router.get('/bookings', (req, res) => {
  const db = getDb();
  const { role, id, type } = req.auth;

  let rows;
  if (role === 'admin' || role === 'owner') {
    rows = db.prepare(`
      SELECT b.*, c.full_name as customer_name, c.email as customer_email, c.phone as customer_phone,
             u.full_name as driver_name,
             od.full_name as offered_driver_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN users u ON b.driver_id = u.id
      LEFT JOIN users od ON b.offered_to_driver_id = od.id
      ORDER BY b.date DESC, b.time DESC
      LIMIT 200
    `).all();
  } else if (role === 'driver') {
    rows = db.prepare(`
      SELECT b.*, c.full_name as customer_name, c.phone as customer_phone
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      WHERE b.driver_id = ?
      ORDER BY b.date DESC, b.time DESC
      LIMIT 100
    `).all(id);
  } else if (type === 'customer') {
    rows = db.prepare(`
      SELECT b.*, u.full_name as driver_name
      FROM bookings b
      LEFT JOIN users u ON b.driver_id = u.id
      WHERE b.customer_id = ?
      ORDER BY b.date DESC, b.time DESC
      LIMIT 100
    `).all(id);
  } else {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ ok: true, bookings: rows });
});

// Create booking
router.post('/bookings', (req, res) => {
  const { pickup, destination, date, time, passengers, bags, trip_type, flight, fare, payment, notes } = req.body;

  if (!pickup || !destination || !date || !time) {
    return res.status(400).json({ error: 'Pickup, destination, date, and time required' });
  }

  // Reject bookings in the past (Europe/London timezone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const ukNowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const todayStr = `${ukNowParts.year}-${ukNowParts.month}-${ukNowParts.day}`;
  if (date < todayStr) {
    return res.status(400).json({ error: 'Pickup date is in the past' });
  }
  if (date === todayStr && time && time !== 'ASAP') {
    const m = String(time).match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const reqMins = (+m[1]) * 60 + (+m[2]);
      const nowMins = parseInt(ukNowParts.hour, 10) * 60 + parseInt(ukNowParts.minute, 10);
      if (reqMins < nowMins) {
        return res.status(400).json({ error: 'Pickup time is in the past' });
      }
    }
  }

  const db = getDb();
  const ref = 'WPH-' + Date.now().toString(36).toUpperCase();
  const customerId = req.auth.type === 'customer' ? req.auth.id : null;

  const result = db.prepare(`
    INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, passengers, bags, trip_type, flight, fare, payment, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref, customerId, pickup, destination, date, time, passengers || 1, bags || 0, trip_type || null, flight || null, fare || null, payment || 'cash', notes || null);

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type, req.auth.id, 'booking_created', ref, req.ip);

  // Send admin notifications in background
  const customerName = customerId
    ? (db.prepare('SELECT full_name, email, phone FROM customers WHERE id = ?').get(customerId) || {})
    : {};
  const notifData = {
    ref, name: customerName.full_name || 'Guest', email: customerName.email || '',
    phone: customerName.phone || '', pickup, destination, date, time,
    passengers, bags, flight, fare, payment, notes
  };
  Promise.allSettled([
    sendAdminAlert(notifData),
    sendAdminBookingWhatsApp(notifData)
  ]).catch(() => {});

  // Push to Google Calendar in background
  const bookingForCal = {
    id: result.lastInsertRowid, ref, pickup, destination, date, time,
    passengers, bags, flight, fare, payment, notes,
    customer_name: customerName.full_name || 'Guest',
    customer_phone: customerName.phone || '',
    status: 'pending'
  };
  gcal.createEvent(bookingForCal).then(eventId => {
    if (eventId) {
      try {
        getDb().prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?')
          .run(eventId, result.lastInsertRowid);
      } catch (e) {}
    }
  }).catch(() => {});

  res.status(201).json({ ok: true, booking: { id: result.lastInsertRowid, ref } });
});

// Update booking status
router.patch('/bookings/:id', (req, res) => {
  const { role } = req.auth;
  if (!['admin', 'owner', 'driver'].includes(role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (role === 'driver' && booking.driver_id !== req.auth.id) {
    return res.status(403).json({ error: 'You can only update your own bookings' });
  }

  const allowed = ['status', 'driver_id', 'fare', 'notes', 'payment'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push('updated_at = datetime("now")');
  values.push(req.params.id);

  db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // If THIS update transitioned the booking from pending → confirmed, fire
  // the customer "Booking confirmed" email + WhatsApp. We only fire on the
  // edge so a second confirm doesn't spam the customer.
  const becameConfirmed = req.body.status === 'confirmed' && booking.status === 'pending';
  if (becameConfirmed) {
    const intake = require('./intake');
    intake.notifyCustomerConfirmed(parseInt(req.params.id, 10))
      .catch(e => console.error('[API] notifyCustomerConfirmed failed:', e.message));
    events.broadcast('booking:confirmed', { id: parseInt(req.params.id, 10), ref: booking.ref, reason: 'Confirmed by operator' });
  }

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type, req.auth.id, 'booking_updated', booking.ref, req.ip);

  // Sync to Google Calendar in background
  const updated = db.prepare(`
    SELECT b.*, c.full_name as customer_name, c.phone as customer_phone
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(req.params.id);
  if (updated) {
    if (updated.status === 'cancelled' && updated.calendar_event_id) {
      gcal.deleteEvent(updated.calendar_event_id).then(ok => {
        if (ok) {
          try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(updated.id); } catch (e) {}
        }
      }).catch(() => {});
    } else if (updated.calendar_event_id) {
      gcal.updateEvent(updated.calendar_event_id, updated).catch(() => {});
    } else if (updated.status !== 'cancelled') {
      gcal.createEvent(updated).then(eventId => {
        if (eventId) {
          try { db.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').run(eventId, updated.id); } catch (e) {}
        }
      }).catch(() => {});
    }
  }

  res.json({ ok: true });
});

// Delete booking (admin/owner only — permanently removes the record)
router.delete('/bookings/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.calendar_event_id) {
    gcal.deleteEvent(booking.calendar_event_id).catch(() => {});
  }

  db.prepare('DELETE FROM bookings WHERE id = ?').run(id);

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type, req.auth.id, 'booking_deleted', booking.ref, req.ip);

  events.broadcast('booking:deleted', { id, ref: booking.ref });

  res.json({ ok: true });
});

// ── Customers (admin only) ──────────────────────────────────────────────

router.get('/customers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare('SELECT id, email, full_name, phone, account_type, active, created_at FROM customers ORDER BY created_at DESC').all();
  res.json({ ok: true, customers: rows });
});

// Create customer (admin/owner only) — admin opens the account for a customer
// who wants monthly invoicing. The customer does NOT get a login password:
// the account is managed entirely by the admin and the customer just receives
// a welcome email confirming the account was opened on their behalf.
router.post('/customers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { email, full_name, phone, account_type } = req.body || {};
  if (!email || !full_name) {
    return res.status(400).json({ error: 'Email and full name are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const type = (account_type === 'business') ? 'business' : 'personal';

  const db = getDb();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'Account already exists with this email' });

  // Store a random hash in the password column — the customer never logs in,
  // the column is NOT NULL in the existing schema so we need something.
  const bcrypt = require('bcryptjs');
  const unusableHash = bcrypt.hashSync('!' + Math.random().toString(36) + Date.now(), 12);

  const result = db.prepare(`
    INSERT INTO customers (email, password, full_name, phone, account_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(cleanEmail, unusableHash, full_name.trim(), phone || null, type);

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type || 'user', req.auth.id, 'customer_created_by_admin', cleanEmail, req.ip);

  // Send the welcome email in the background — don't block the HTTP response.
  const { sendCustomerWelcome } = require('./email');
  sendCustomerWelcome({ email: cleanEmail, full_name: full_name.trim(), account_type: type })
    .catch(e => console.error('[API] sendCustomerWelcome failed:', e.message));

  res.status(201).json({
    ok: true,
    customer: { id: result.lastInsertRowid, email: cleanEmail, full_name: full_name.trim(), account_type: type }
  });
});

// Send a monthly invoice to an account customer. Body: { month: 'YYYY-MM' }
// Pulls every booking for this customer dated within that month and emails
// an itemised statement with journey details and total fare.
router.post('/customers/:id/invoice', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { month } = req.body || {};
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month (YYYY-MM) is required' });
  }
  const db = getDb();
  const customer = db.prepare('SELECT id, email, full_name, account_type FROM customers WHERE id = ? AND active = 1').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.email) return res.status(400).json({ error: 'Customer has no email address' });

  const monthStart = month + '-01';
  const [y, m] = month.split('-').map(n => parseInt(n, 10));
  const nextMonthFirst = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  const monthEnd = nextMonthFirst.toISOString().slice(0, 10);

  const bookings = db.prepare(`
    SELECT ref, date, time, pickup, destination, fare, flight, passengers, status
      FROM bookings
     WHERE customer_id = ?
       AND date >= ?
       AND date < ?
       AND status IN ('confirmed','active','completed')
     ORDER BY date ASC, time ASC
  `).all(customer.id, monthStart, monthEnd);

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const label = MONTH_NAMES[m - 1] + ' ' + y;

  // Invoice number: INV-YYYYMM-<seq> — count existing invoices in audit log for uniqueness
  const prevCount = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'invoice_sent' AND detail LIKE ?").get('INV-' + y + String(m).padStart(2, '0') + '%').c;
  const invoiceNo = 'INV-' + y + String(m).padStart(2, '0') + '-' + String(prevCount + 1).padStart(4, '0');

  // Due date: 14 days from today
  const due = new Date();
  due.setDate(due.getDate() + 14);
  const dueDate = due.toISOString().slice(0, 10);

  const { sendCustomerInvoice } = require('./email');
  const ok = await sendCustomerInvoice(customer, bookings, { label, month, dueDate }, invoiceNo);
  if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + customer.email, req.ip);

  const total = bookings.reduce((s, b) => s + (+b.fare || 0), 0);
  res.json({ ok: true, invoiceNo, journeys: bookings.length, total });
});

// ── Drivers (admin only) ────────────────────────────────────────────────

function sanitizeDriver(row) {
  if (!row) return row;
  if (!row.has_login || (row.username && row.username.startsWith('__nolgn_'))) {
    row.username = null;
    row.has_login = 0;
  }
  return row;
}

router.get('/drivers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, username, full_name, email, phone, role, active, has_login,
           license_no, license_expiry, dbs_no, dbs_expiry, vehicle, reg,
           phv_no, insurance_no, driver_notes, created_at
    FROM users WHERE role IN ('driver','owner') ORDER BY created_at DESC
  `).all().map(sanitizeDriver);
  res.json({ ok: true, drivers: rows });
});

router.get('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const row = db.prepare(`
    SELECT id, username, full_name, email, phone, role, active, has_login,
           license_no, license_expiry, dbs_no, dbs_expiry, vehicle, reg,
           phv_no, insurance_no, driver_notes, created_at
    FROM users WHERE id = ? AND role IN ('driver','owner')
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Driver not found' });
  res.json({ ok: true, driver: sanitizeDriver(row) });
});

// Create driver (admin/owner). Login credentials are optional — admin can
// register a driver on the roster first, and issue username/password later.
router.post('/drivers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const {
    username, password, full_name, email, phone, role, active,
    license_no, license_expiry, dbs_no, dbs_expiry,
    vehicle, reg, phv_no, insurance_no, driver_notes
  } = req.body;

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full name required' });
  }

  const wantsLogin = !!(username && password);
  if (username && !password) return res.status(400).json({ error: 'Password required when setting username' });
  if (password && !username) return res.status(400).json({ error: 'Username required when setting password' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');

  let finalUsername, finalHash;
  if (wantsLogin) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    finalUsername = username.trim();
    finalHash = bcrypt.hashSync(password, 12);
  } else {
    finalUsername = '__nolgn_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    finalHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
  }

  const result = db.prepare(`
    INSERT INTO users
      (username, password, role, full_name, email, phone, active, has_login,
       license_no, license_expiry, dbs_no, dbs_expiry,
       vehicle, reg, phv_no, insurance_no, driver_notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    finalUsername, finalHash, role || 'driver', full_name.trim(),
    email || null, phone || null,
    active === 0 ? 0 : 1, wantsLogin ? 1 : 0,
    license_no || null, license_expiry || null,
    dbs_no || null, dbs_expiry || null,
    vehicle || null, reg || null,
    phv_no || null, insurance_no || null, driver_notes || null
  );

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run('user', req.auth.id, 'driver_created', full_name, req.ip);

  res.status(201).json({ ok: true, driver: { id: result.lastInsertRowid, has_login: wantsLogin } });
});

// Update driver (admin/owner)
router.patch('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const existing = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!existing) return res.status(404).json({ error: 'Driver not found' });

  const body = req.body || {};
  const updates = [];
  const values = [];

  const plainFields = [
    'full_name', 'email', 'phone', 'active',
    'license_no', 'license_expiry', 'dbs_no', 'dbs_expiry',
    'vehicle', 'reg', 'phv_no', 'insurance_no', 'driver_notes'
  ];
  for (const f of plainFields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] === '' ? null : body[f]);
    }
  }

  // Grant / change app access
  if (body.username !== undefined || body.password !== undefined) {
    const bcrypt = require('bcryptjs');
    if (body.username) {
      const newUsername = String(body.username).trim();
      if (newUsername !== existing.username) {
        const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, id);
        if (dup) return res.status(409).json({ error: 'Username already exists' });
        updates.push('username = ?'); values.push(newUsername);
      }
    }
    if (body.password) {
      if (String(body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      updates.push('password = ?'); values.push(bcrypt.hashSync(body.password, 12));
    }
    if (body.username && body.password) {
      updates.push('has_login = 1');
    }
  }
  if (body.revoke_login === true) {
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    updates.push('username = ?'); values.push('__nolgn_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'));
    updates.push('password = ?'); values.push(bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10));
    updates.push('has_login = 0');
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = datetime("now")');
  values.push(id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run('user', req.auth.id, 'driver_updated', existing.full_name || existing.username, req.ip);

  res.json({ ok: true });
});

// ── Audit log (admin only) ──────────────────────────────────────────────

router.get('/audit', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
  res.json({ ok: true, logs: rows });
});

// ── Stats (admin/owner) ─────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const totalBookings = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
  const todayBookings = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date = ?').get(today).c;
  const pendingBookings = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c;
  const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE active = 1').get().c;
  const totalDrivers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('driver','owner') AND active = 1").get().c;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(fare),0) as total FROM bookings WHERE status = ?').get('completed').total;

  res.json({
    ok: true,
    stats: { totalBookings, todayBookings, pendingBookings, totalCustomers, totalDrivers, totalRevenue }
  });
});

// ── Stripe Payouts (owner only) ──────────────────────────────────────────
const stripe = require('./stripe');

function ownerOnly(req, res, next) {
  if (req.auth.role !== 'owner' && req.auth.role !== 'admin') return res.status(403).json({ error: 'Owner only' });
  next();
}

router.get('/stripe/balance', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.json({ ok: true, available: 0, pending: 0, currency: 'gbp', reason: 'not_configured' });
    const bal = await stripe.getBalance();
    res.json({ ok: true, ...bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stripe/payout', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.status(400).json({ error: 'Stripe not configured' });
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum payout is £1.00' });
    const payout = await stripe.createPayout({ amount, description: req.body.description || 'Westmere payout' });
    res.json({ ok: true, payout: { id: payout.id, amount: payout.amount, status: payout.status, arrival_date: payout.arrival_date } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stripe/payouts', ownerOnly, async (req, res) => {
  try {
    if (!stripe.isConfigured()) return res.json({ ok: true, payouts: [] });
    const payouts = await stripe.listRecentPayouts();
    res.json({ ok: true, payouts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
