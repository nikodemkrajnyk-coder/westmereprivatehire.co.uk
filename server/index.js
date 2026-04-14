const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { getDb } = require('./db');
const { router: authRouter, JWT_SECRET } = require('./auth');
const apiRouter = require('./api');
const publicApiRouter = require('./public-api');
const googleRouter = require('./google-routes');
const gmailRouter = require('./gmail-routes');
const { createAuthMiddleware } = require('./middleware');
const gcal = require('./google-calendar');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
        "https://fonts.googleapis.com", "https://fonts.gstatic.com",
        "https://js.stripe.com",
        "https://cdn.jsdelivr.net", "https://www.google.com",
        "https://www.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.mapbox.com",
        "https://nominatim.openstreetmap.org", "https://router.project-osrm.org",
        "https://api.anthropic.com", "https://api.stripe.com"],
      frameSrc: ["https://js.stripe.com", "https://www.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
    }
  }
}));

app.use(cookieParser());
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth middleware ──────────────────────────────────────────────────────
const { requireAuth, requireRole, protectPage } = createAuthMiddleware(JWT_SECRET);

// ── Routes ──────────────────────────────────────────────────────────────

// Public config (serves tokens from env vars — no auth needed)
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(`window._MB='${process.env.MAPBOX_TOKEN || ''}';\nwindow._SK='${process.env.STRIPE_PUBLISHABLE_KEY || ''}';`);
});

// Auth routes (login, register, logout, etc.)
app.use('/api/auth', authLimiter, authRouter);

// Public API routes (booking, payment — no auth needed)
app.use('/api/public', apiLimiter, publicApiRouter);

// Google Calendar OAuth callback (public — Google redirects here after consent)
app.use('/api/google', apiLimiter, googleRouter.publicCallback);

// Protected API routes
app.use('/api', apiLimiter, requireAuth, apiRouter);

// Protected Google Calendar routes (auth-url, status, disconnect, sync)
app.use('/api/google', requireAuth, googleRouter);

// Protected Gmail routes (inbox, read, send)
app.use('/api/gmail', apiLimiter, requireAuth, gmailRouter);

// ── Protected app pages ─────────────────────────────────────────────────
// These pages require authentication — the frontend handles showing login UI
const protectedPages = [
  'westmere-admin.html',
  'westmere-owner.html',
  'westmere-driver.html',
  'westmere-account.html',
];

for (const page of protectedPages) {
  app.get('/' + page, protectPage(null), (req, res) => {
    res.sendFile(path.join(__dirname, '..', page));
  });
}

// ── Health check (Railway uses this) ─────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Static files (public pages, CSS, JS, images) ────────────────────────
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html',
  extensions: ['html'],
}));

// ── 404 ─────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────
// Initialize database
getDb();

// Log service status
const { isConfigured: stripeOk } = require('./stripe');
const { isConfigured: waOk } = require('./whatsapp');

app.listen(PORT, () => {
  const { isConfigured: emailOk } = require('./email');
  const gmailOk = emailOk();
  const gcalOk = gcal.isConfigured();
  console.log(`
╔═══════════════════════════════════════════════╗
║  Westmere Private Hire — Backend Server       ║
║  http://localhost:${PORT}                        ║
║                                               ║
║  Admin login: westmere / sussex               ║
║  Database: data/westmere.db                   ║
║                                               ║
║  Stripe:   ${stripeOk() ? 'ACTIVE' : 'NOT CONFIGURED'}                        ║
║  Gmail:    ${gmailOk ? 'ACTIVE' : 'NOT CONFIGURED'}                        ║
║  WhatsApp: ${waOk() ? 'ACTIVE' : 'NOT CONFIGURED'}                        ║
║  GCal:     ${gcalOk ? 'ACTIVE' : 'NOT CONFIGURED'}                        ║
╚═══════════════════════════════════════════════╝
  `);

  // Background: poll Google Calendar for remote changes every 5 minutes
  if (gcalOk) {
    setInterval(() => {
      gcal.pullChanges().catch(e => console.error('[GCAL] poll error:', e.message));
    }, 5 * 60 * 1000);
  }
});

module.exports = app;
