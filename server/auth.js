const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'wph_' + require('crypto').randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[AUTH] WARNING: JWT_SECRET not set — sessions will not survive server restarts. Set JWT_SECRET in your environment variables.');
}
const JWT_EXPIRY = '8h';
const JWT_EXPIRY_REMEMBER = '30d';
const COOKIE_MAX_AGE = 8 * 3600000; // 8 hours
const COOKIE_MAX_AGE_REMEMBER = 30 * 24 * 3600000; // 30 days

// ── Login (admin / owner / driver) ──────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password)) {
    // Log failed attempt
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('user', 0, 'login_failed', `username: ${username}`, req.ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const expiry = remember ? JWT_EXPIRY_REMEMBER : JWT_EXPIRY;
  const maxAge = remember ? COOKIE_MAX_AGE_REMEMBER : COOKIE_MAX_AGE;

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, type: 'user' },
    JWT_SECRET,
    { expiresIn: expiry }
  );

  // Log session
  const expires = new Date(Date.now() + maxAge).toISOString();
  db.prepare('INSERT INTO sessions (user_id, role, ip, user_agent, expires_at) VALUES (?,?,?,?,?)')
    .run(user.id, user.role, req.ip, req.get('User-Agent'), expires);

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, ip) VALUES (?,?,?,?)')
    .run('user', user.id, 'login_success', req.ip);

  res.cookie('wph_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge
  });

  res.json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name }
  });
});

// ── Customer login (account page) ───────────────────────────────────────
router.post('/customer/login', (req, res) => {
  const { email, password, remember } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE email = ? AND active = 1').get(email.trim().toLowerCase());

  if (!customer || !bcrypt.compareSync(password, customer.password)) {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('customer', 0, 'login_failed', `email: ${email}`, req.ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const expiry = remember ? JWT_EXPIRY_REMEMBER : JWT_EXPIRY;
  const maxAge = remember ? COOKIE_MAX_AGE_REMEMBER : COOKIE_MAX_AGE;

  const token = jwt.sign(
    { id: customer.id, email: customer.email, role: 'customer', type: 'customer' },
    JWT_SECRET,
    { expiresIn: expiry }
  );

  db.prepare('INSERT INTO sessions (customer_id, role, ip, user_agent, expires_at) VALUES (?,?,?,?,?)')
    .run(customer.id, 'customer', req.ip, req.get('User-Agent'), new Date(Date.now() + maxAge).toISOString());

  db.prepare('INSERT INTO audit_log (user_type, user_id, action, ip) VALUES (?,?,?,?)')
    .run('customer', customer.id, 'login_success', req.ip);

  res.cookie('wph_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge
  });

  res.json({
    ok: true,
    customer: { id: customer.id, email: customer.email, full_name: customer.full_name, account_type: customer.account_type }
  });
});

// ── Customer registration — DISABLED for public self-service ─────────────
// Accounts are now opened by admin only via POST /api/customers. Keeping
// the route so we can return a friendly error instead of a 404.
router.post('/customer/register', (req, res) => {
  return res.status(403).json({
    error: 'Accounts are opened by Westmere on request. Please contact bookings@westmereprivatehire.co.uk or call 07930 342593.'
  });
});

// ── Verify session ──────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies.wph_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db = getDb();

    if (payload.type === 'customer') {
      const customer = db.prepare('SELECT id, email, full_name, phone, account_type FROM customers WHERE id = ? AND active = 1').get(payload.id);
      if (!customer) return res.status(401).json({ error: 'Account not found' });
      return res.json({ ok: true, type: 'customer', customer });
    } else {
      const user = db.prepare('SELECT id, username, role, full_name, email FROM users WHERE id = ? AND active = 1').get(payload.id);
      if (!user) return res.status(401).json({ error: 'Account not found' });
      return res.json({ ok: true, type: 'user', user });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
});

// ── Logout ──────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('wph_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ ok: true });
});

// ── Change password ─────────────────────────────────────────────────────
router.post('/change-password', (req, res) => {
  const token = req.cookies.wph_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const db = getDb();
    let record;
    if (payload.type === 'customer') {
      record = db.prepare('SELECT * FROM customers WHERE id = ?').get(payload.id);
    } else {
      record = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    }

    if (!record || !bcrypt.compareSync(current_password, record.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = bcrypt.hashSync(new_password, 12);
    if (payload.type === 'customer') {
      db.prepare('UPDATE customers SET password = ?, updated_at = datetime("now") WHERE id = ?').run(hash, payload.id);
    } else {
      db.prepare('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?').run(hash, payload.id);
    }

    db.prepare('INSERT INTO audit_log (user_type, user_id, action, ip) VALUES (?,?,?,?)')
      .run(payload.type, payload.id, 'password_changed', req.ip);

    res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
});

module.exports = { router, JWT_SECRET };
