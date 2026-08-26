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
let exportRouter;
try { exportRouter = require('./export-routes'); } catch(e) { console.error('[EXPORT] Module failed:', e.message); }
const trackingRouter = require('./tracking-routes');
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

// IMPORTANT: the Stripe webhook needs the *raw* request body to verify the
// signature. express.json() would consume and parse the stream first, leaving
// the raw bytes unavailable — signature verification then fails with a 400 and
// the booking is never marked paid. Skip JSON parsing for the webhook path so
// the express.raw() parser inside the route sees the untouched body.
const jsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.originalUrl === '/api/public/stripe-webhook') return next();
  return jsonParser(req, res, next);
});

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

// (The public ref+phone tracking page and its router were removed in the
// cleanliness audit; a proper in-app tracker will replace them.)

/* THE ONE PLACE AN INVOICE IS RENDERED.
   Serves the PDF built by server/invoice-pdf.js — for the emailed link, and
   (with ?inline=1) for a preview. Print/Review and Download in the STAFF apps
   go through the authenticated route instead; this one is for the customer who
   was sent a link.

   IT REQUIRES A TOKEN, because the invoice number is not a secret.
   Invoice numbers are sequential — INV-202608-0001, 0002, 0003 — and this route
   used to accept one as its only credential. Anyone who guessed a number was
   handed a PDF carrying the business's bank details and a customer's name and
   address. The number stays in the path so the URL still says which invoice it
   is; `?t=` is what authorises.

   THE LOOKUP IS BY TOKEN, not by number. A query keyed on the number would
   answer "that invoice exists, but you lack the token" — which is an
   enumeration oracle even when the status code is 404. Here a wrong or missing
   token finds no row at all, and there is exactly ONE failure response, byte
   for byte, for every way this can go wrong: no token, wrong token, another
   invoice's token, a number that does not exist. Nothing distinguishes them.

   Earlier faults kept fixed here: the cache is keyed by TEMPLATE_VERSION so a
   redesign cannot serve a document drawn by the old one, and a failure returns
   a readable page rather than the white screen a bare 500 gives you in a new
   tab.
   GUARDRAILS: server/tests/invoice-access.test.js, invoice-paths.test.js */
app.get('/api/public/invoice/:invoiceNo/pdf', apiLimiter, async (req, res) => {
  const { resolveInvoicePdf } = require('./invoice-pdf');

  const safeNo = (req.params.invoiceNo || '').replace(/[^A-Za-z0-9\-_]/g, '');
  const token  = String(req.query.t || '').trim();
  const inline = req.query.inline === '1' || req.query.inline === 'true';

  function page(status, heading, detail) {
    res.status(status).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>' + heading + '</title>' +
      '<body style="font-family:Georgia,serif;color:#102a43;background:#fff;margin:0;' +
      'display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">' +
      '<div style="max-width:30rem;padding:2rem">' +
      '<p style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#657485;margin:0 0 .75rem">Westmere Private Hire</p>' +
      '<h1 style="font-size:1.5rem;font-weight:400;margin:0 0 .75rem">' + heading + '</h1>' +
      '<p style="color:#3B5268;line-height:1.6;margin:0">' + detail + '</p>' +
      '</div></body>');
  }
  /* ONE response for every refusal. Distinct wording — or a 403 — would tell a
     stranger which invoice numbers exist, which is the thing being closed. */
  const refuse = () => page(404, 'Invoice not available',
    'This link is not valid. Invoice links are personal to the recipient and can expire if an ' +
    'invoice is reissued &mdash; please reply to your invoice email, or call 07930&nbsp;342593, ' +
    'and we will send it across.');

  try {
    if (!safeNo || !token || token.length < 16) return refuse();

    const db = getDb();
    const row = db.prepare('SELECT * FROM invoices WHERE access_token = ?').get(token);
    if (!row) return refuse();

    /* The token found a row; it must be the row the URL names. Compared
       constant-time so the check itself cannot be used to narrow a guess. */
    const a = Buffer.from(String(row.invoice_no || ''));
    const b = Buffer.from(safeNo);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return refuse();

    const buf = await resolveInvoicePdf(db, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline ? 'inline' : 'attachment') + '; filename="' + safeNo + '.pdf"');
    // The document changes when the template does; never let a proxy hold one.
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    return res.send(buf);
  } catch (e) {
    console.error('[PUBLIC PDF]', safeNo, e && e.stack ? e.stack : e);
    return page(500, 'We could not produce that invoice',
      'Something went wrong generating the document. Please reply to your invoice email, or call 07930&nbsp;342593, and we will send it across.');
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

// Full data export — ZIP download of all business data
if (exportRouter) app.use('/api/export', apiLimiter, requireAuth, exportRouter);

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
app.get('/westmere-account.html', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(301, '/westmere-rider.html' + qs);
});

// ── Retired page: the old Premium Fleet spec sheet ──────────────────────
// Deleted, not merely unlinked. It was the last page still wearing the
// pre-redesign dark navy — a Tesla Model S spec sheet with filled navy panels
// — and Google had indexed it well enough to show it as a SITELINK, so it was
// being offered to people searching for the business.
//
// A 404 would keep that sitelink alive as a dead end for weeks. A 301 tells
// Google the page is gone and where its authority should go, and sends anyone
// who follows an old link or bookmark somewhere useful instead of nowhere.
// Home rather than the fleet content's nearest relative: there is no
// replacement page, and the homepage is what the search was looking for.
//
// Keep this route. It costs nothing and the alternative is a 404 for every
// stale link that still exists in the index, in someone's bookmarks, or in a
// message sent months ago. GUARDRAIL: server/tests/retired-pages.test.js
app.get('/westmere-fleet.html', (req, res) => {
  res.redirect(301, '/');
});

// ── Apple Pay domain verification ────────────────────────────────────────
// Stripe (and Apple) verify a site can offer Apple Pay by fetching this exact
// path and matching the association file against the domain registered in the
// Stripe Dashboard. express.static ignores dotfiles (the `.well-known` dir), so
// it MUST be served by an explicit route or Apple Pay never appears on iPhones.
// To enable: in Stripe Dashboard → Settings → Payments → Payment methods →
// Apple Pay, add `westmereprivatehire.co.uk`, download the association file, and
// commit it to the repo root as `apple-developer-merchantid-domain-association`.
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  const fs = require('fs');
  const file = path.join(__dirname, '..', 'apple-developer-merchantid-domain-association');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain').send('Apple Pay domain association not configured');
  }
  res.type('text/plain');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(file);
});

// ── PRIVATE PATHS — deny BEFORE anything is served from disk ────────────
// express.static below serves the WHOLE REPO ROOT, which also published the
// driver spreadsheet (personal data), the entire backend source and the test
// suite. The rule for what is private lives in server/private-paths.js and is
// exercised directly by server/tests/static-exposure.test.js.
//
// Answers 404, never 403 — a 403 confirms the file is there. This gate is
// registered BEFORE express.static and AFTER the Apple Pay route, so domain
// verification keeps working.
const { isPrivatePath } = require('./private-paths');
app.use((req, res, next) => {
  if (!isPrivatePath(req.path)) return next();
  res.status(404).type('text/plain').send('Not found');
});

// ── Static files (public pages, CSS, JS, images) ────────────────────────
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // Brand images are embedded CROSS-ORIGIN — email clients (Gmail's image
    // proxy, Apple Mail) and link-preview crawlers load them from a different
    // origin. Helmet's default `Cross-Origin-Resource-Policy: same-origin`
    // makes those clients refuse to render the image, which is exactly why the
    // estimate/confirmation hero image showed up blank. Mark images loadable
    // cross-origin so they display in every mail client.
    if (/\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  },
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

  // Background: email the owner ~12h before each upcoming pickup (once per
  // booking). Server-side via Resend — no Claude/assistant dependency.
  // NOTHING populates the customer list automatically any more — the owner adds
  // people by tapping Add on a booking. All that happens at boot is the schema
  // check, plus an OPTIONAL one-shot clear of the rows the old
  // more-than-two-bookings rule left behind (added_by='auto'). Set
  // CUSTDIR_CLEAR_AUTO=1 to run it; anything the owner added by hand is
  // 'manual' and is never touched, so the flag is safe to leave set.
  try {
    const dir = require('./customer-directory');
    const db = require('./db').getDb();
    dir.ensureSchema(db);
    if (process.env.CUSTDIR_CLEAR_AUTO === '1') {
      const n = dir.clearAutoAdded(db);
      console.log('[CUSTDIR] cleared', n, 'auto-added row(s) — the list is now manual-only');
    }
  } catch (e) { console.error('[CUSTDIR] schema check failed:', e.message); }

  try { require('./reminder').startBookingReminders(); }
  catch (e) { console.error('[REMINDER] failed to start:', e.message); }
});

module.exports = app;
// rebuild 1777531728
