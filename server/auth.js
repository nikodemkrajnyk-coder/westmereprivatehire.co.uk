const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

const router = express.Router();

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const db = getDb();
  const row = db.prepare("SELECT value FROM integrations WHERE key = 'jwt_secret'").get();
  if (row) return row.value;
  const secret = 'wph_' + require('crypto').randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO integrations (provider, key, value) VALUES ('jwt_secret', 'jwt_secret', ?)").run(secret);
  return secret;
}
const JWT_SECRET = getJwtSecret();
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
  const customer = db.prepare('SELECT * FROM customers WHERE email = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(email.trim().toLowerCase());

  if (!customer || !bcrypt.compareSync(password, customer.password)) {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('customer', 0, 'login_failed', `email: ${email}`, req.ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Block unverified self-registered accounts
  if (customer.verified === 0) {
    return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for the verification link.' });
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

// ── Customer self-registration ───────────────────────────────────────────
router.post('/customer/register', async (req, res) => {
  const { full_name, email, phone, password, account_type } = req.body;
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email and password are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const db = getDb();
  const cleanEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id, verified, active FROM customers WHERE email = ?').get(cleanEmail);
  if (existing) {
    if (existing.active === 0) {
      // Soft-deleted account — reactivate with new credentials
      const hash = bcrypt.hashSync(password, 12);
      db.prepare("UPDATE customers SET password = ?, full_name = ?, phone = ?, active = 1, verified = 1, reset_token = NULL, reset_token_expires = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(hash, full_name.trim(), phone || null, existing.id);
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    if (existing.verified === 0) {
      return res.status(409).json({ error: 'An account with this email is awaiting verification. Please check your inbox.' });
    }
    return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  }

  const hash = bcrypt.hashSync(password, 12);
  const verificationToken = require('crypto').randomUUID().replace(/-/g, '');
  const acType = ['personal', 'business'].includes(account_type) ? account_type : 'personal';

  let newId;
  try {
    const result = db.prepare(`
      INSERT INTO customers (email, password, full_name, phone, account_type, verified, verification_token)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(cleanEmail, hash, full_name.trim(), phone || null, acType, verificationToken);
    newId = result.lastInsertRowid;
  } catch (e) {
    console.error('[AUTH] customer register insert failed:', e.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }

  // Send verification email (non-blocking)
  const { sendVerificationEmail } = require('./email');
  sendVerificationEmail({ email: cleanEmail, full_name: full_name.trim() }, verificationToken)
    .catch(e => console.error('[AUTH] verification email failed:', e.message));

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run('customer', newId, 'customer_registered', cleanEmail, req.ip);
  } catch (_) {}

  res.status(201).json({ ok: true, message: 'Account created. Please check your email to verify your address.' });
});

// ── Email verification ───────────────────────────────────────────────────
router.get('/customer/verify', (req, res) => {
  const token = String(req.query.token || '').replace(/[^a-f0-9]/gi, '');
  if (!token || token.length < 16) {
    return res.redirect('/westmere-account.html?verified=error&reason=invalid_token');
  }

  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE verification_token = ?').get(token);
  if (!customer) {
    return res.redirect('/westmere-account.html?verified=error&reason=invalid_token');
  }
  if (customer.verified === 1) {
    return res.redirect('/westmere-account.html?verified=already');
  }

  db.prepare("UPDATE customers SET verified = 1, verification_token = NULL, updated_at = datetime('now') WHERE id = ?").run(customer.id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, ip) VALUES (?,?,?,?)')
      .run('customer', customer.id, 'email_verified', req.ip);
  } catch (_) {}

  return res.redirect('/westmere-account.html?verified=1');
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
      const user = db.prepare('SELECT id, username, role, full_name, email, onboarding_status FROM users WHERE id = ? AND active = 1').get(payload.id);
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

// ── Forgot password (request reset link) ────────────────────────────────
router.post('/customer/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const db = getDb();
  const customer = db.prepare(
    'SELECT id, email, full_name FROM customers WHERE email = ? COLLATE NOCASE'
  ).get(email.trim().toLowerCase());

  // Always return success — prevents email enumeration
  if (!customer) {
    return res.json({ ok: true });
  }

  const token = require('crypto').randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare(
    "UPDATE customers SET reset_token = ?, reset_token_expires = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(token, expires, customer.id);

  const { sendPasswordResetEmail } = require('./email');
  sendPasswordResetEmail({ email: customer.email, full_name: customer.full_name }, token)
    .catch(e => console.error('[AUTH] reset email failed:', e.message));

  res.json({ ok: true });
});

// ── Reset password (consume token, set new password) ─────────────────────
router.post('/customer/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const customer = db.prepare(
    'SELECT id, reset_token_expires FROM customers WHERE reset_token = ?'
  ).get(String(token).replace(/[^a-f0-9]/gi, ''));

  if (!customer) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(customer.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    "UPDATE customers SET password = ?, active = 1, verified = 1, reset_token = NULL, reset_token_expires = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(hash, customer.id);

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, ip) VALUES (?,?,?,?)')
      .run('customer', customer.id, 'password_reset', req.ip);
  } catch (_) {}

  res.json({ ok: true });
});

module.exports = { router, JWT_SECRET };
