const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb, DATA_DIR } = require('./db');
const { sendAdminAlert } = require('./email');
const { sendAdminBookingWhatsApp } = require('./whatsapp');
const gcal = require('./google-calendar');
const events = require('./events');

const INVOICES_DIR = path.join(DATA_DIR, 'invoices');

const router = express.Router();

// ── Bookings ────────────────────────────────────────────────────────────

// List bookings (admin sees all, driver sees assigned, customer sees own)
router.get('/bookings', (req, res) => {
  const db = getDb();
  const { role, id, type } = req.auth;

  let rows;
  if (role === 'admin' || role === 'owner') {
    rows = db.prepare(`
      SELECT b.*,
             COALESCE(c.full_name, b.passenger_name) as customer_name,
             COALESCE(c.email,     b.passenger_email) as customer_email,
             COALESCE(c.phone,     b.passenger_phone) as customer_phone,
             u.full_name  as driver_name,
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
      SELECT b.*,
             COALESCE(c.full_name, b.passenger_name) as customer_name,
             COALESCE(c.phone,     b.passenger_phone) as customer_phone
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
  const { pickup, destination, date, time, passengers, bags, trip_type, flight, fare, payment, notes,
          passenger_name, passenger_phone, passenger_email, customer_id: bodyCustomerId } = req.body;

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
  const customerId = req.auth.type === 'customer' ? req.auth.id : (bodyCustomerId ? parseInt(bodyCustomerId, 10) : null);

  let result;
  try {
    result = db.prepare(`
      INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, passengers, bags, trip_type, flight, fare, payment, notes, passenger_name, passenger_phone, passenger_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ref, customerId, pickup, destination, date, time, passengers || 1, bags || 0, trip_type || null, flight || null, fare || null, payment || 'cash', notes || null,
           passenger_name || null, passenger_phone || null, passenger_email || null);
  } catch (e) {
    console.error('[API] booking insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to save booking. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_created', ref, req.ip);
  } catch (e) { /* audit failure must not block the response */ }

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
    sendAdminAlert(notifData)
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

  const allowed = ['status', 'driver_id', 'fare', 'notes', 'payment', 'passenger_name', 'passenger_phone', 'passenger_email', 'pickup', 'destination', 'date', 'time', 'passengers', 'customer_id'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  try {
    db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] booking update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update booking. Please try again.' });
  }

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

  // Broadcast all status changes so connected staff apps refresh immediately.
  if (req.body.status && req.body.status !== booking.status) {
    events.broadcast('booking:updated', {
      id: parseInt(req.params.id, 10), ref: booking.ref,
      status: req.body.status, prev_status: booking.status
    });
  }

  // Sync to Google Calendar in background
  const updated = db.prepare(`
    SELECT b.*,
           COALESCE(c.full_name, b.passenger_name) as customer_name,
           COALESCE(c.phone,     b.passenger_phone) as customer_phone
    FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(req.params.id);
  if (updated) {
    // ── Operator's shared calendar ───────────────────────────────────────
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

// Customer self-cancel — only the owning customer may cancel their own booking
// and only if the booking is still in a cancellable state.
router.post('/customer/bookings/:id/cancel', (req, res) => {
  if (req.auth.role !== 'customer') {
    return res.status(403).json({ error: 'Customer access required' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Ownership check — the booking must belong to this customer
  if (booking.customer_id !== req.auth.id) {
    return res.status(403).json({ error: 'You can only cancel your own bookings' });
  }

  // State guard — can't cancel a trip that's already underway or done
  const cancellable = ['pending', 'confirmed', 'offered'];
  if (!cancellable.includes(booking.status)) {
    return res.status(409).json({ error: 'This booking cannot be cancelled at this stage' });
  }

  try {
    db.prepare(`UPDATE bookings SET status = 'cancelled', notes = CASE WHEN notes IS NULL OR notes = '' THEN 'Cancelled by customer' ELSE notes || ' | Cancelled by customer' END, updated_at = datetime('now') WHERE id = ?`).run(id);
  } catch (e) {
    console.error('[API] customer cancel failed:', e.message);
    return res.status(500).json({ error: 'Failed to cancel booking. Please try again.' });
  }

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run('customer', req.auth.id, 'booking_cancelled_by_customer', booking.ref, req.ip);

  events.broadcast('booking:updated', {
    id, ref: booking.ref, status: 'cancelled', prev_status: booking.status
  });

  // Remove from Google Calendar in background
  if (booking.calendar_event_id) {
    const gcal = require('./google-calendar');
    gcal.deleteEvent(booking.calendar_event_id).then(ok => {
      if (ok) {
        try { db.prepare('UPDATE bookings SET calendar_event_id = NULL WHERE id = ?').run(id); } catch (e) {}
      }
    }).catch(() => {});
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

  try {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
  } catch (e) {
    console.error('[API] booking delete failed:', e.message);
    return res.status(500).json({ error: 'Failed to delete booking. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type, req.auth.id, 'booking_deleted', booking.ref, req.ip);
  } catch (e) { /* audit failure must not block the response */ }

  events.broadcast('booking:deleted', { id, ref: booking.ref });

  res.json({ ok: true });
});

// ── Customers (admin only) ──────────────────────────────────────────────

router.get('/customers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, email, full_name, phone, account_type, active, verified, created_at,
           address_line1, address_line2, postcode,
           bank_name, bank_sort_code, bank_account_no, bank_account_name
      FROM customers ORDER BY created_at DESC
  `).all();
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
  const {
    email, full_name, phone,
    address_line1, address_line2, postcode,
    bank_name, bank_sort_code, bank_account_no, bank_account_name
  } = req.body || {};
  if (!email || !full_name) {
    return res.status(400).json({ error: 'Email and full name are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  const cleanEmail = email.trim().toLowerCase();

  const db = getDb();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'Account already exists with this email' });

  const bcrypt = require('bcryptjs');
  const unusableHash = bcrypt.hashSync('!' + Math.random().toString(36) + Date.now(), 12);

  let result;
  try {
    result = db.prepare(`
      INSERT INTO customers (email, password, full_name, phone, account_type,
                             address_line1, address_line2, postcode,
                             bank_name, bank_sort_code, bank_account_no, bank_account_name)
      VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleanEmail, unusableHash, full_name.trim(), phone || null,
      (address_line1 || '').trim() || null,
      (address_line2 || '').trim() || null,
      (postcode || '').trim() || null,
      (bank_name || '').trim() || null,
      (bank_sort_code || '').trim() || null,
      (bank_account_no || '').trim() || null,
      (bank_account_name || '').trim() || null
    );
  } catch (e) {
    console.error('[API] customer insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to create customer account. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_created_by_admin', cleanEmail, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  const { sendCustomerWelcome } = require('./email');
  sendCustomerWelcome({ email: cleanEmail, full_name: full_name.trim() })
    .catch(e => console.error('[API] sendCustomerWelcome failed:', e.message));

  res.status(201).json({
    ok: true,
    customer: { id: result.lastInsertRowid, email: cleanEmail, full_name: full_name.trim() }
  });
});

// Update customer (admin/owner)
router.patch('/customers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });

  const existing = db.prepare('SELECT id, email FROM customers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  const body = req.body || {};
  const updates = [];
  const values = [];

  const plainFields = [
    'full_name', 'phone',
    'address_line1', 'address_line2', 'postcode',
    'bank_name', 'bank_sort_code', 'bank_account_no', 'bank_account_name'
  ];
  for (const f of plainFields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] === '' ? null : String(body[f]).trim() || null);
    }
  }

  if (body.email !== undefined) {
    const newEmail = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (newEmail !== existing.email) {
      const dup = db.prepare('SELECT id FROM customers WHERE email = ? AND id != ?').get(newEmail, id);
      if (dup) return res.status(409).json({ error: 'Email already in use by another customer' });
    }
    updates.push('email = ?');
    values.push(newEmail);
  }

  if (body.active !== undefined) {
    updates.push('active = ?');
    values.push(body.active ? 1 : 0);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(id);

  try {
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] customer update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update customer. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'customer_updated', existing.email, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  res.json({ ok: true });
});

// ── Set / reset a customer's portal password (admin-only) ───────────────
// Allows admin to grant a customer access to the account portal by setting
// a password. Customer then logs in via POST /api/auth/customer/login.
router.post('/customers/:id/set-password', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid customer ID' });

  const customer = db.prepare('SELECT id, email, full_name FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(String(password), 12);
  db.prepare("UPDATE customers SET password = ?, updated_at = datetime('now') WHERE id = ?").run(hash, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'customer_password_set', customer.email, req.ip);
  } catch (_) {}

  res.json({ ok: true, message: 'Password set. Customer can now log in via /api/auth/customer/login.' });
});

// Generate / send invoice for a customer.
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } or { month: 'YYYY-MM' }
// Optional: send_email (default true). When false, returns data only (for preview).
router.post('/customers/:id/invoice', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { month, from, to, send_email } = req.body || {};
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let dateFrom, dateTo, periodLabel, invoicePrefix;

  if (from && to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
    }
    dateFrom = from;
    dateTo = to;
    const fd = new Date(from + 'T00:00:00');
    const td = new Date(to + 'T00:00:00');
    if (fd.getMonth() === td.getMonth() && fd.getFullYear() === td.getFullYear()) {
      periodLabel = MONTH_NAMES[fd.getMonth()] + ' ' + fd.getFullYear();
    } else {
      periodLabel = fd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        + ' - ' + td.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    invoicePrefix = from.slice(0, 4) + from.slice(5, 7);
  } else if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(n => parseInt(n, 10));
    dateFrom = month + '-01';
    const nextMonthFirst = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    dateTo = nextMonthFirst.toISOString().slice(0, 10);
    periodLabel = MONTH_NAMES[m - 1] + ' ' + y;
    invoicePrefix = y + String(m).padStart(2, '0');
  } else {
    return res.status(400).json({ error: 'Provide either month (YYYY-MM) or from/to dates (YYYY-MM-DD)' });
  }

  const db = getDb();
  const customer = db.prepare('SELECT id, email, full_name, phone FROM customers WHERE id = ? AND active = 1').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const bookings = db.prepare(`
    SELECT ref, date, time, pickup, destination, fare, flight, passengers, status
      FROM bookings
     WHERE customer_id = ?
       AND date >= ?
       AND date < ?
       AND status IN ('confirmed','active','completed')
     ORDER BY date ASC, time ASC
  `).all(customer.id, dateFrom, dateTo);

  const invoiceNo = nextInvoiceNo(db, invoicePrefix);

  const due = new Date();
  due.setDate(due.getDate() + 14);
  const dueDate = due.toISOString().slice(0, 10);
  const issuedDate = new Date().toISOString().slice(0, 10);

  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}

  const total = bookings.reduce((s, b) => s + (+b.fare || 0), 0);
  const shouldEmail = send_email !== false;

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let pdfBuffer = null;
  try {
    const { buildInvoicePdf } = require('./invoice-pdf');
    const lineItemsForPdf = bookings.map(b => ({
      date: b.date, time: b.time, ref: b.ref,
      pickup: b.pickup, destination: b.destination,
      flight: b.flight, fare: b.fare
    }));
    pdfBuffer = await buildInvoicePdf({
      invoiceNo, kind: 'account', total, settings,
      customer: { full_name: customer.full_name, email: customer.email, phone: customer.phone },
      bookings: lineItemsForPdf,
      period: { issuedDate, dueDate, label: periodLabel }
    });
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(path.join(INVOICES_DIR, invoiceNo + '.pdf'), pdfBuffer);
    console.log('[INVOICE] PDF saved:', invoiceNo + '.pdf');
  } catch (e) {
    console.error('[INVOICE] PDF generation failed:', e.message);
  }

  if (shouldEmail) {
    if (!customer.email) return res.status(400).json({ error: 'Customer has no email address' });
    const { sendCustomerInvoice } = require('./email');
    const ok = await sendCustomerInvoice(customer, bookings, { label: periodLabel, dueDate }, invoiceNo, settings, pdfBuffer);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + customer.email, req.ip);
  }

  // Persist the invoice record so it can be looked up later.
  try {
    const lineItems = bookings.map(b => ({
      date: b.date, time: b.time, ref: b.ref,
      pickup: b.pickup, destination: b.destination,
      flight: b.flight, passengers: b.passengers, fare: b.fare
    }));
    db.prepare(`
      INSERT INTO invoices
        (invoice_no, kind, customer_id, recipient_name, recipient_email, recipient_phone,
         period_from, period_to, period_label, issued_date, due_date,
         line_items_json, booking_ids_json, total, emailed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNo, 'account', customer.id, customer.full_name, customer.email, customer.phone,
      dateFrom, dateTo, periodLabel, issuedDate, dueDate,
      JSON.stringify(lineItems), JSON.stringify(bookings.map(b => b.ref)),
      total, shouldEmail ? 1 : 0, req.auth.id
    );
  } catch (e) {
    console.error('[INVOICE] persist failed:', e.message);
  }

  res.json({
    ok: true, invoiceNo, journeys: bookings.length, total,
    customer: { id: customer.id, email: customer.email, full_name: customer.full_name, phone: customer.phone },
    bookings, period: { label: periodLabel, from: dateFrom, to: dateTo, dueDate, issuedDate },
    settings, emailed: shouldEmail
  });
});

// Bespoke / one-off invoice — for recipients not in the customers table.
// Body: { recipient: { name, email, address, phone }, items: [{ description, amount }], due_days, send_email }
router.post('/invoices/bespoke', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { recipient, items, due_days, send_email, notes } = req.body || {};
  if (!recipient || !recipient.name || !String(recipient.name).trim()) {
    return res.status(400).json({ error: 'Recipient name is required' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }

  const cleanItems = items
    .map(it => ({ description: String(it.description || '').trim(), date: it.date ? String(it.date).trim() : '', amount: +it.amount || 0 }))
    .filter(it => it.description && it.amount > 0);
  if (!cleanItems.length) {
    return res.status(400).json({ error: 'Items must have description and positive amount' });
  }

  const db = getDb();
  const now = new Date();
  const invoicePrefix = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0');
  const invoiceNo = nextInvoiceNo(db, invoicePrefix);

  const due = new Date();
  due.setDate(due.getDate() + (parseInt(due_days, 10) || 14));
  const dueDate = due.toISOString().slice(0, 10);
  const issuedDate = now.toISOString().slice(0, 10);

  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}

  const total = cleanItems.reduce((s, it) => s + it.amount, 0);
  const shouldEmail = send_email === true;

  const cleanRecipient = {
    name: String(recipient.name).trim(),
    email: recipient.email ? String(recipient.email).trim().toLowerCase() : '',
    phone: recipient.phone ? String(recipient.phone).trim() : '',
    address: recipient.address ? String(recipient.address).trim() : ''
  };

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let pdfBuffer = null;
  try {
    const { buildInvoicePdf } = require('./invoice-pdf');
    pdfBuffer = await buildInvoicePdf({
      invoiceNo, kind: 'bespoke', total, notes: notes || '', settings,
      recipient: cleanRecipient,
      items: cleanItems,
      period: { issuedDate, dueDate, label: '' }
    });
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(path.join(INVOICES_DIR, invoiceNo + '.pdf'), pdfBuffer);
    console.log('[INVOICE] PDF saved:', invoiceNo + '.pdf');
  } catch (e) {
    console.error('[INVOICE] PDF generation failed:', e.message);
  }

  if (shouldEmail) {
    if (!cleanRecipient.email) return res.status(400).json({ error: 'Recipient email required to send' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanRecipient.email)) {
      return res.status(400).json({ error: 'Invalid recipient email' });
    }
    const { sendBespokeInvoice } = require('./email');
    const ok = await sendBespokeInvoice(cleanRecipient, cleanItems, { dueDate, issuedDate, notes }, invoiceNo, settings, pdfBuffer);
    if (!ok) return res.status(502).json({ error: 'Email delivery failed' });

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(req.auth.type || 'user', req.auth.id, 'invoice_sent', invoiceNo + ' to ' + cleanRecipient.email, req.ip);
  }

  // Persist bespoke invoice so it can be reviewed later.
  try {
    db.prepare(`
      INSERT INTO invoices
        (invoice_no, kind, recipient_name, recipient_email, recipient_phone, recipient_addr,
         issued_date, due_date, notes, line_items_json, total, emailed, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNo, 'bespoke', cleanRecipient.name, cleanRecipient.email, cleanRecipient.phone, cleanRecipient.address,
      issuedDate, dueDate, notes || null,
      JSON.stringify(cleanItems), total, shouldEmail ? 1 : 0, req.auth.id
    );
  } catch (e) {
    console.error('[INVOICE] persist bespoke failed:', e.message);
  }

  // Upsert recipient into saved recipients for future auto-fill
  try {
    if (cleanRecipient.name) {
      if (cleanRecipient.email) {
        db.prepare(`
          INSERT INTO invoice_recipients (name, email, address, phone, last_used_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(email) DO UPDATE SET
            name         = excluded.name,
            address      = COALESCE(excluded.address, invoice_recipients.address),
            phone        = COALESCE(excluded.phone, invoice_recipients.phone),
            last_used_at = datetime('now')
        `).run(cleanRecipient.name, cleanRecipient.email, cleanRecipient.address || null, cleanRecipient.phone || null);
      } else {
        db.prepare(`INSERT INTO invoice_recipients (name, address, phone, last_used_at) VALUES (?, ?, ?, datetime('now'))`)
          .run(cleanRecipient.name, cleanRecipient.address || null, cleanRecipient.phone || null);
      }
    }
  } catch (e) {
    console.error('[API] invoice_recipients upsert failed:', e.message);
  }

  res.json({
    ok: true, invoiceNo, total, bespoke: true,
    recipient: cleanRecipient, items: cleanItems,
    period: { label: '', dueDate, issuedDate, notes: notes || '' },
    settings, emailed: shouldEmail
  });
});

// Saved invoice recipients for auto-fill
router.get('/invoice-recipients', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoice_recipients ORDER BY last_used_at DESC LIMIT 100').all();
  res.json({ ok: true, recipients: rows });
});

// List stored invoices (admin/owner). Supports optional ?customer_id, ?kind filters.
router.get('/invoices', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const where = [];
  const params = [];
  if (req.query.customer_id) { where.push('customer_id = ?'); params.push(parseInt(req.query.customer_id, 10)); }
  if (req.query.kind && ['account','bespoke'].includes(req.query.kind)) {
    where.push('kind = ?'); params.push(req.query.kind);
  }
  const sql = `SELECT id, invoice_no, kind, customer_id, recipient_name, recipient_email,
                      issued_date, due_date, period_label, total, emailed, created_at
                 FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...params);
  res.json({ ok: true, invoices: rows });
});

// Fetch a single stored invoice with full line items.
router.get('/invoices/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  try { row.line_items = JSON.parse(row.line_items_json || '[]'); } catch (e) { row.line_items = []; }
  try { row.booking_refs = JSON.parse(row.booking_ids_json || '[]'); } catch (e) { row.booking_refs = []; }
  delete row.line_items_json;
  delete row.booking_ids_json;
  res.json({ ok: true, invoice: row });
});

// Serve (or regenerate) the PDF for a stored invoice.
router.get('/invoices/:id/pdf', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });

  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  const safeNo = (row.invoice_no || '').replace(/[^A-Za-z0-9\-_]/g, '');
  const pdfPath = path.join(INVOICES_DIR, safeNo + '.pdf');

  // Serve cached file if it exists
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    return res.sendFile(pdfPath);
  }

  // Regenerate from stored invoice data
  try {
    let settings = {};
    try {
      const sr = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
      if (sr) settings = JSON.parse(sr.value);
    } catch (_) {}

    let lineItems = [];
    try { lineItems = JSON.parse(row.line_items_json || '[]'); } catch (_) {}

    const data = {
      invoiceNo: row.invoice_no,
      kind: row.kind,
      total: row.total,
      notes: row.notes || '',
      settings,
      period: { issuedDate: row.issued_date, dueDate: row.due_date || '', label: row.period_label || '' }
    };

    if (row.kind === 'bespoke') {
      data.recipient = {
        name: row.recipient_name, email: row.recipient_email || '',
        phone: row.recipient_phone || '', address: row.recipient_addr || ''
      };
      data.items = lineItems;
    } else {
      data.customer = {
        full_name: row.recipient_name, email: row.recipient_email || '', phone: row.recipient_phone || ''
      };
      data.bookings = lineItems;
    }

    const { buildInvoicePdf } = require('./invoice-pdf');
    const buf = await buildInvoicePdf(data);

    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(pdfPath, buf);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    res.send(buf);
  } catch (e) {
    console.error('[INVOICE PDF]', e.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Delete invoice — removes DB row and cached PDF
router.delete('/invoices/:id', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid invoice ID' });

  const row = db.prepare('SELECT id, invoice_no FROM invoices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Invoice not found' });

  // Delete cached PDF if it exists
  try {
    const safeNo = (row.invoice_no || '').replace(/[^A-Za-z0-9\-_]/g, '');
    const pdfPath = path.join(INVOICES_DIR, safeNo + '.pdf');
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  } catch (e) { /* non-fatal */ }

  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Invoice settings (business details + bank details for invoices)
router.get('/settings/invoice', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (e) {}
  res.json({ ok: true, settings });
});

router.put('/settings/invoice', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const settings = req.body || {};
  const allowed = ['business_name', 'owner_name', 'address_line1', 'address_line2', 'postcode',
    'phone', 'email', 'bank_name', 'sort_code', 'account_no', 'account_name'];
  const clean = {};
  for (const k of allowed) {
    if (settings[k] !== undefined) clean[k] = String(settings[k]).trim();
  }
  try {
    db.prepare("INSERT OR REPLACE INTO integrations (provider, key, value) VALUES ('invoice_settings', 'invoice_settings', ?)").run(JSON.stringify(clean));
  } catch (e) {
    console.error('[API] invoice settings save failed:', e.message);
    return res.status(500).json({ error: 'Failed to save settings. Please try again.' });
  }
  res.json({ ok: true });
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

// Pick the next sequential invoice number for a given prefix (YYYYMM).
// Looks at BOTH the stored invoices table and legacy audit_log entries to
// avoid collisions with the pre-invoices-table history.
function nextInvoiceNo(db, invoicePrefix) {
  const like = 'INV-' + invoicePrefix + '%';
  let maxNum = 0;
  try {
    const row = db.prepare("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1").get(like);
    if (row && row.invoice_no) {
      const m = row.invoice_no.match(/-(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch (_) {}
  try {
    const legacy = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'invoice_sent' AND detail LIKE ?").get(like).c;
    if (legacy > maxNum) maxNum = legacy;
  } catch (_) {}
  return 'INV-' + invoicePrefix + '-' + String(maxNum + 1).padStart(4, '0');
}

router.get('/drivers', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, username, full_name, email, phone, role, active, has_login,
           license_no, license_expiry, dbs_no, dbs_expiry, vehicle, reg,
           phv_no, insurance_no, driver_notes, photo, is_default_driver,
           max_passengers, max_bags, luggage_notes,
           onboarding_status, created_at
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
           phv_no, insurance_no, driver_notes, photo, is_default_driver,
           max_passengers, max_bags, luggage_notes,
           created_at
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
    vehicle, reg, phv_no, insurance_no, driver_notes, photo,
    max_passengers, max_bags, luggage_notes
  } = req.body;

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full name required' });
  }

  const db = getDb();
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');

  // Always auto-generate credentials for onboarding flow.
  // If admin supplies explicit username+password, use those instead.
  const wantsManualLogin = !!(username && password);
  if (username && !password) return res.status(400).json({ error: 'Password required when setting username' });
  if (password && !username) return res.status(400).json({ error: 'Username required when setting password' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  let finalUsername, finalHash, tempPassword = null;

  if (wantsManualLogin) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    finalUsername = username.trim();
    finalHash = bcrypt.hashSync(password, 12);
  } else {
    // Auto-generate: "firstname" + 3 random digits, e.g. "james472"
    const firstName = full_name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'driver';
    let candidate = firstName + (Math.floor(Math.random() * 900) + 100);
    let attempts = 0;
    while (db.prepare('SELECT id FROM users WHERE username = ?').get(candidate) && attempts++ < 20) {
      candidate = firstName + (Math.floor(Math.random() * 9000) + 1000);
    }
    finalUsername = candidate;
    // Temp password: readable 8 chars — "Wph" + 5 random mixed-case alphanumeric
    const pool = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    tempPassword = 'Wph' + Array.from({length:5}, () => pool[Math.floor(Math.random() * pool.length)]).join('');
    finalHash = bcrypt.hashSync(tempPassword, 12);
  }

  const calendarToken = require('crypto').randomUUID().replace(/-/g, '');

  let result;
  try {
    result = db.prepare(`
      INSERT INTO users
        (username, password, role, full_name, email, phone, active, has_login,
         license_no, license_expiry, dbs_no, dbs_expiry,
         vehicle, reg, phv_no, insurance_no, driver_notes, photo,
         max_passengers, max_bags, luggage_notes, onboarding_status, calendar_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      finalUsername, finalHash, role || 'driver', full_name.trim(),
      email || null, phone || null,
      active === 0 ? 0 : 1, 1,  // has_login always 1 — they get real credentials
      license_no || null, license_expiry || null,
      dbs_no || null, dbs_expiry || null,
      vehicle || null, reg || null,
      phv_no || null, insurance_no || null, driver_notes || null,
      photo || null,
      max_passengers == null || max_passengers === '' ? null : parseInt(max_passengers, 10),
      max_bags == null || max_bags === '' ? null : parseInt(max_bags, 10),
      luggage_notes || null,
      'pending',
      calendarToken
    );
  } catch (e) {
    console.error('[API] driver insert failed:', e.message);
    return res.status(500).json({ error: 'Failed to create driver account. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_created', full_name, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  // Send welcome email if driver has an email address
  if (email) {
    const { sendDriverWelcome } = require('./email');
    sendDriverWelcome({
      email,
      full_name: full_name.trim(),
      username: finalUsername,
      temp_password: tempPassword
    }).catch(e => console.error('[API] driver welcome email failed:', e.message));
  }

  res.status(201).json({
    ok: true,
    driver: {
      id: result.lastInsertRowid,
      username: finalUsername,
      temp_password: tempPassword,   // null if admin supplied their own password
      has_login: true,
      onboarding_status: 'pending',
      app_url: '/westmere-driver.html'
    }
  });
});

// Delete (deactivate) driver — soft delete preserves booking history
router.delete('/drivers/:id', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_removed', driver.full_name || driver.username, req.ip);
  } catch (e) { /* non-fatal */ }

  res.json({ ok: true });
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
    'vehicle', 'reg', 'phv_no', 'insurance_no', 'driver_notes', 'photo',
    'max_passengers', 'max_bags', 'luggage_notes'
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

  updates.push("updated_at = datetime('now')");
  values.push(id);

  try {
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    console.error('[API] driver update failed:', e.message);
    return res.status(500).json({ error: 'Failed to update driver. Please try again.' });
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_updated', existing.full_name || existing.username, req.ip);
  } catch (e) { /* audit failure must not block response */ }

  res.json({ ok: true });
});

// ── Grant / update driver login credentials (admin-only) ─────────────────
// Dedicated endpoint for provisioning a driver's portal username + password.
// Equivalent to PATCH /drivers/:id with {username, password} but more
// explicit — useful for admin UI "Set Login" button.
router.post('/drivers/:id/set-credentials', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });

  const driver = db.prepare("SELECT id, full_name, username FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(username).trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const cleanUsername = String(username).trim();
  const bcrypt = require('bcryptjs');

  // Check for duplicate username (skip if it's the same driver's current username)
  const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(cleanUsername, id);
  if (dup) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(String(password), 12);
  db.prepare(`
    UPDATE users
       SET username = ?, password = ?, has_login = 1, updated_at = datetime('now')
     WHERE id = ?
  `).run(cleanUsername, hash, id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'driver_credentials_set', driver.full_name || driver.username, req.ip);
  } catch (_) {}

  res.json({ ok: true, message: 'Driver credentials set. They can now log in via /api/auth/login.' });
});

// Earnings summary for a driver over a period. Used by admin driver
// detail / weekly statements. Commission is 10% on the fare by default;
// if driver_pay / admin_fee are set on a booking those override.
const COMMISSION_RATE = 0.10;
router.get('/drivers/:id/earnings', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  // Admins/owners can view any driver; drivers can only view themselves.
  const isStaff = ['admin', 'owner'].includes(req.auth.role);
  if (!isStaff && req.auth.id !== id) return res.status(403).json({ error: 'Forbidden' });

  // Default range: current week (Mon–Sun) if nothing provided.
  let from = req.query.from, to = req.query.to;
  if (!from || !to) {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const diffToMon = (day + 6) % 7;
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0, 10);
    to   = sun.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }

  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status,
           driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ?
       AND date >= ? AND date <= ?
       AND status IN ('confirmed','active','completed','done')
     ORDER BY date ASC, time ASC
  `).all(id, from, to);

  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    // If admin set explicit payouts use those; otherwise derive from commission rate.
    const itemCommission = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * COMMISSION_RATE).toFixed(2);
    const itemNet = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - itemCommission).toFixed(2);
    gross += fare; commission += itemCommission; net += itemNet;
    return {
      id: b.id, ref: b.ref, date: b.date, time: b.time,
      pickup: b.pickup, destination: b.destination,
      fare, commission: itemCommission, net: itemNet,
      payment: b.payment, status: b.status
    };
  });

  res.json({
    ok: true,
    driver: { id: driver.id, name: driver.full_name, email: driver.email },
    period: { from, to },
    commission_rate: COMMISSION_RATE,
    totals: {
      jobs: items.length,
      gross: +gross.toFixed(2),
      commission: +commission.toFixed(2),
      net: +net.toFixed(2)
    },
    items
  });
});

// Shortcut: earnings for the currently signed-in driver. Driver app uses this.
router.get('/me/earnings', (req, res) => {
  if (!['driver', 'owner', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Driver access required' });
  }
  req.params.id = String(req.auth.id);
  // Delegate by re-dispatching — simpler to inline the same logic:
  const db = getDb();
  let from = req.query.from, to = req.query.to;
  if (!from || !to) {
    const now = new Date();
    const day = now.getDay(); const diffToMon = (day + 6) % 7;
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0, 10); to = sun.toISOString().slice(0, 10);
  }
  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ?").get(req.auth.id);
  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status,
           driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ? AND date >= ? AND date <= ?
       AND status IN ('confirmed','active','completed','done')
     ORDER BY date ASC, time ASC
  `).all(req.auth.id, from, to);
  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    const c = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * COMMISSION_RATE).toFixed(2);
    const n = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - c).toFixed(2);
    gross += fare; commission += c; net += n;
    return {
      id: b.id, ref: b.ref, date: b.date, time: b.time,
      pickup: b.pickup, destination: b.destination,
      fare, commission: c, net: n, payment: b.payment, status: b.status
    };
  });
  res.json({
    ok: true,
    driver: driver ? { id: driver.id, name: driver.full_name } : null,
    period: { from, to }, commission_rate: COMMISSION_RATE,
    totals: { jobs: items.length, gross: +gross.toFixed(2), commission: +commission.toFixed(2), net: +net.toFixed(2) },
    items
  });
});

// Email a weekly earnings statement to a driver. Body: { from, to }.
router.post('/drivers/:id/statement', async (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const { from, to } = req.body || {};
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  }
  const driver = db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role IN ('driver','owner')").get(id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (!driver.email) return res.status(400).json({ error: 'Driver has no email on file' });

  const bookings = db.prepare(`
    SELECT id, ref, date, time, pickup, destination, fare, payment, status, driver_pay, admin_fee
      FROM bookings
     WHERE driver_id = ? AND date >= ? AND date <= ?
       AND status IN ('confirmed','active','completed','done')
     ORDER BY date ASC, time ASC
  `).all(id, from, to);
  let gross = 0, commission = 0, net = 0;
  const items = bookings.map(b => {
    const fare = +b.fare || 0;
    const c = (b.admin_fee != null) ? (+b.admin_fee || 0) : +(fare * 0.10).toFixed(2);
    const n = (b.driver_pay != null) ? (+b.driver_pay || 0) : +(fare - c).toFixed(2);
    gross += fare; commission += c; net += n;
    return { date: b.date, time: b.time, ref: b.ref, pickup: b.pickup, destination: b.destination, fare, commission: c, net: n };
  });
  const totals = { jobs: items.length, gross: +gross.toFixed(2), commission: +commission.toFixed(2), net: +net.toFixed(2) };

  const { sendDriverStatement } = require('./email');
  const ok = await sendDriverStatement({ name: driver.full_name, email: driver.email }, { from, to }, totals, items);
  if (!ok) return res.status(502).json({ error: 'Email delivery failed (check RESEND_API_KEY)' });
  db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(req.auth.type || 'user', req.auth.id, 'driver_statement_sent', driver.full_name + ' ' + from + '→' + to, req.ip);
  res.json({ ok: true, sent_to: driver.email, totals });
});

// Mark a driver as the default (auto-allocation target for new bookings).
// Only one driver can be default at a time, so this also clears any prior flag.
router.post('/drivers/:id/default', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid driver ID' });
  const existing = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role IN ('driver','owner') AND active = 1").get(id);
  if (!existing) return res.status(404).json({ error: 'Driver not found or inactive' });
  try {
    db.transaction(() => {
      db.prepare("UPDATE users SET is_default_driver = 0 WHERE is_default_driver = 1").run();
      db.prepare("UPDATE users SET is_default_driver = 1 WHERE id = ?").run(id);
    })();
  } catch (e) {
    console.error('[API] default driver update failed:', e.message);
    return res.status(500).json({ error: 'Failed to set default driver. Please try again.' });
  }
  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', req.auth.id, 'default_driver_set', existing.full_name, req.ip);
  } catch (e) { /* audit failure must not block the response */ }
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

// ── Analytics ────────────────────────────────────────────────────────────
router.get('/analytics', (req, res) => {
  if (!['admin', 'owner'].includes(req.auth.role)) return res.status(403).json({ error: 'Access denied' });
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek);
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';

  // Revenue overview
  const revToday   = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date=? AND status='completed'`).get(today).t;
  const revWeek    = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date>=? AND date<=? AND status='completed'`).get(weekStartStr, today).t;
  const revMonth   = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE date>=? AND status='completed'`).get(monthStart).t;
  const revAllTime = db.prepare(`SELECT COALESCE(SUM(fare),0) as t FROM bookings WHERE status='completed'`).get().t;

  // Weekly trend — last 12 weeks (oldest first)
  const weeklyTrend = [];
  for (let i = 11; i >= 0; i--) {
    const ws = new Date(weekStart); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws);        we.setDate(we.getDate() + 6);
    const wsStr = ws.toISOString().split('T')[0];
    const weStr = we.toISOString().split('T')[0];
    const row = db.prepare(`SELECT COALESCE(SUM(fare),0) as total, COUNT(*) as jobs FROM bookings WHERE date>=? AND date<=? AND status='completed'`).get(wsStr, weStr);
    weeklyTrend.push({ weekStart: wsStr, total: row.total, jobs: row.jobs });
  }

  // Driver performance
  const drivers = db.prepare(`
    SELECT u.id, u.full_name,
      COUNT(CASE WHEN b.status='completed' THEN 1 END) as jobs_completed,
      COALESCE(SUM(CASE WHEN b.status='completed' THEN b.fare ELSE 0 END), 0) as total_earnings,
      COUNT(CASE WHEN b.status IN ('completed','confirmed','active') THEN 1 END) as jobs_accepted,
      COUNT(b.id) as jobs_offered,
      COALESCE(AVG(CASE WHEN b.status='completed' THEN CAST(b.fare AS REAL) END), 0) as avg_fare
    FROM users u
    LEFT JOIN bookings b ON b.driver_id = u.id
    WHERE u.role IN ('driver','owner') AND u.active = 1
    GROUP BY u.id ORDER BY total_earnings DESC
  `).all();

  // Busiest times heatmap — [dayOfWeek 0=Mon][hour 0-23]
  const heatmap = Array.from({length:7}, () => Array(24).fill(0));
  db.prepare(`SELECT date, time FROM bookings WHERE status != 'cancelled' AND date IS NOT NULL AND time IS NOT NULL`).all().forEach(b => {
    const d = new Date(b.date);
    if (isNaN(d.getTime())) return;
    const dow = (d.getDay() + 6) % 7;
    const hr = parseInt((b.time || '').split(':')[0], 10);
    if (isNaN(hr) || hr < 0 || hr > 23) return;
    heatmap[dow][hr]++;
  });

  // Top customers
  const topCustomers = db.prepare(`
    SELECT c.id, c.full_name, c.email,
      COUNT(b.id) as total_bookings,
      COALESCE(SUM(CASE WHEN b.status='completed' THEN b.fare ELSE 0 END), 0) as total_spend
    FROM customers c
    LEFT JOIN bookings b ON b.customer_id = c.id
    WHERE c.active = 1
    GROUP BY c.id HAVING total_bookings > 0
    ORDER BY total_bookings DESC LIMIT 10
  `).all();

  // Booking breakdown
  const byStatus  = db.prepare(`SELECT status, COUNT(*) as count FROM bookings GROUP BY status`).all();
  const byPayment = db.prepare(`SELECT payment, COUNT(*) as count, COALESCE(SUM(CASE WHEN status='completed' THEN fare ELSE 0 END),0) as total FROM bookings WHERE payment IS NOT NULL GROUP BY payment`).all();

  res.json({ ok: true, revenue: { today: revToday, week: revWeek, month: revMonth, allTime: revAllTime }, weeklyTrend, drivers, heatmap, topCustomers, byStatus, byPayment });
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
