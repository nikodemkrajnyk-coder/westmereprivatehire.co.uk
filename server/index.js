// build: 2026-04-30b
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { getDb, DATA_DIR } = require('./db');
const { router: authRouter, JWT_SECRET } = require('./auth');
const apiRouter = require('./api');
const publicApiRouter = require('./public-api');
const googleRouter = require('./google-routes');
const gmailRouter = require('./gmail-routes');
const intakeRouter = require('./intake-routes');
const offerRouter = require('./offer-routes');
const assistantRouter = require('./assistant-routes');
const backupRouter = require('./backup-routes');
const trackingRouter = require('./tracking-routes');
const publicTrackingRouter = require('./public-tracking-routes');
const onboardingRouter = require('./driver-onboarding-routes');
const driverCalRouter = require('./driver-cal-routes');
const { createAuthMiddleware } = require('./middleware');
const gcal = require('./google-calendar');
const intake = require('./intake');
const events = require('./events');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ── Security ────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
        "https://fonts.googleapis.com", "https://fonts.gstatic.com",
        "https://js.stripe.com",
        "https://cdn.jsdelivr.net", "https://www.google.com",
        "https://www.gstatic.com",
        "https://api.mapbox.com"],
      workerSrc: ["'self'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://api.mapbox.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.mapbox.com", "https://events.mapbox.com",
        "https://nominatim.openstreetmap.org", "https://router.project-osrm.org",
        "https://api.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://www.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
    }
  }
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

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

// Public tracking (rider views their own booking by ref + phone)
app.use('/api/public', apiLimiter, publicTrackingRouter);

// Public invoice download — no auth required. Invoice number is the access key.
// Used by the "Download Invoice PDF" button in emailed invoices.
app.get('/api/public/invoice/:invoiceNo/pdf', apiLimiter, async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const db = getDb();
  const safeNo = (req.params.invoiceNo || '').replace(/[^A-Za-z0-9\-_]/g, '');
  if (!safeNo) return res.status(400).send('Invalid invoice number');
  const row = db.prepare("SELECT * FROM invoices WHERE invoice_no = ?").get(safeNo);
  if (!row) return res.status(404).send('Invoice not found');
  const INVOICES_DIR = process.env.INVOICES_DIR || '/data/invoices';
  const pdfPath = path.join(INVOICES_DIR, safeNo + '.pdf');
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    return res.sendFile(pdfPath);
  }
  // Regenerate if not cached
  try {
    let settings = {};
    try { const sr = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get(); if (sr) settings = JSON.parse(sr.value); } catch (_) {}
    let lineItems = []; try { lineItems = JSON.parse(row.line_items_json || '[]'); } catch (_) {}
    const data = { invoiceNo: row.invoice_no, kind: row.kind, total: row.total, notes: row.notes || '', settings, period: { issuedDate: row.issued_date, dueDate: row.due_date || '', label: row.period_label || '' } };
    if (row.kind === 'bespoke') { data.recipient = { name: row.recipient_name, email: row.recipient_email || '', phone: row.recipient_phone || '', address: row.recipient_addr || '' }; data.items = lineItems; }
    else { data.customer = { full_name: row.recipient_name, email: row.recipient_email || '', phone: row.recipient_phone || '' }; data.bookings = lineItems; }
    const { buildInvoicePdf } = require('./invoice-pdf');
    const buf = await buildInvoicePdf(data);
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(pdfPath, buf);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeNo + '.pdf"');
    res.send(buf);
  } catch (e) {
    console.error('[PUBLIC PDF]', e.message);
    res.status(500).send('Failed to generate PDF');
  }
});

// Google Calendar OAuth callback (public — Google redirects here after consent)
app.use('/api/google', apiLimiter, googleRouter.publicCallback);

// Driver .ics calendar subscription feed (public — token-protected)
app.use('/api/driver', apiLimiter, driverCalRouter);

// Driver onboarding routes (profile update, document upload/review)
app.use('/api', apiLimiter, requireAuth, onboardingRouter);

// Protected API routes
app.use('/api', apiLimiter, requireAuth, apiRouter);

// Driver location push (authenticated driver/owner)
app.use('/api', apiLimiter, requireAuth, trackingRouter);

// Protected Google Calendar routes (auth-url, status, disconnect, sync)
app.use('/api/google', requireAuth, googleRouter);

// Protected Gmail routes (inbox, read, send)
app.use('/api/gmail', apiLimiter, requireAuth, gmailRouter);

// Protected intake routes (time-off, reassignment, apology drafting)
app.use('/api/intake', apiLimiter, requireAuth, intakeRouter);

// Protected driver-offer workflow (offer/accept/decline/done/cancel)
app.use('/api', apiLimiter, requireAuth, offerRouter);

// Protected assistant (voice booking helper)
app.use('/api/assistant', apiLimiter, requireAuth, assistantRouter);

// Protected backup routes (export/save/list)
app.use('/api/backup', apiLimiter, requireAuth, backupRouter);

// ── Real-time push (SSE) ───────────────────────────────────────────────
// Long-lived stream — must NOT pass through the api rate limiter (one
// open connection per browser tab would burn the quota in seconds).
app.get('/api/events', requireAuth, (req, res) => {
  events.addClient(req, res);
  // Don't call res.end() — the connection stays open until the client closes.
});

// ── Protected app pages ─────────────────────────────────────────────────
// These pages require authentication — the frontend handles showing login UI
const protectedPages = [
  'westmere-admin.html',
  'westmere-owner.html',
  'westmere-driver.html',
];

for (const page of protectedPages) {
  app.get('/' + page, protectPage(null), (req, res) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', page));
  });
}

// Service worker must never be cached by the browser — otherwise stale SW
// code continues serving stale HTML long after deploys.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'sw.js'));
});

app.get('/rider-sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'rider-sw.js'));
});

// ── Health check (Railway uses this) ─────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── DB path diagnostic (admin/owner only) ────────────────────────────────
app.get('/api/debug/db-path', requireAuth, (req, res) => {
  if (!['admin', 'owner'].includes(req.auth && req.auth.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const fs = require('fs');
  const dbFile = require('path').join(DATA_DIR, 'westmere.db');
  const dataDir = DATA_DIR;
  let fileExists = false, fileSizeBytes = null, dirExists = false, dirWritable = false;
  try { dirExists = fs.existsSync(dataDir); } catch (_) {}
  try {
    const probe = require('path').join(dataDir, '.probe');
    fs.writeFileSync(probe, ''); fs.unlinkSync(probe);
    dirWritable = true;
  } catch (_) {}
  try { fileExists = fs.existsSync(dbFile); } catch (_) {}
  try { if (fileExists) fileSizeBytes = fs.statSync(dbFile).size; } catch (_) {}
  res.json({
    SQLITE_DB_env: process.env.SQLITE_DB || null,
    resolved_db_path: dbFile,
    data_dir: dataDir,
    dir_exists: dirExists,
    dir_writable: dirWritable,
    file_exists: fileExists,
    file_size_bytes: fileSizeBytes,
    node_env: process.env.NODE_ENV || null,
  });
});

// ── Redirect legacy account page to rider app ───────────────────────────
app.get('/westmere-account.html', (req, res) => res.redirect(301, '/westmere-rider.html'));

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
  const intakeOk = intake.isConfigured();
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const icloudParent = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const icloudOk = fs.existsSync(icloudParent);
  const pad = s => String(s).padEnd(16);
  console.log(`
╔═══════════════════════════════════════════════╗
║  Westmere Private Hire — Backend Server       ║
║  http://localhost:${PORT}                        ║
║                                               ║
║  Database: data/westmere.db                   ║
║                                               ║
║  Stripe:   ${pad(stripeOk() ? 'ACTIVE' : 'NOT CONFIGURED')}               ║
║  Gmail:    ${pad(gmailOk ? 'ACTIVE' : 'NOT CONFIGURED')}               ║
║  WhatsApp: ${pad(waOk() ? 'ACTIVE' : 'NOT CONFIGURED')}               ║
║  GCal:     ${pad(gcalOk ? 'ACTIVE' : 'NOT CONFIGURED')}               ║
║  Intake:   ${pad(intakeOk ? 'ACTIVE' : 'NOT CONFIGURED')}               ║
║  Backup:   ${pad(icloudOk ? 'iCloud + local' : 'local only')}               ║
╚═══════════════════════════════════════════════╝
  `);

  // Background: poll Google Calendar for remote changes every 5 minutes
  if (gcalOk) {
    setInterval(() => {
      gcal.pullChanges().catch(e => console.error('[GCAL] poll error:', e.message));
    }, 5 * 60 * 1000);
  }

  // Background: reclaim stale driver offers (10 min window)
  offerRouter.startOfferSweeper();

  // Background: auto-backup database on start + every 6h → iCloud + data/backups/
  backupRouter.startAutoBackup();
});

module.exports = app;
// rebuild 1777531728
// persistence-test-1 1777715895
// persistence-test-2 1777715999
// persistence-test-3 1777716099
// persistence-test-4 1777716202
// persistence-test-5 1777716202
