// ── Google Calendar routes ───────────────────────────────────────────────
// Mounted at /api/google. All routes require an authenticated admin or owner
// session except the OAuth callback itself (Google calls it from the user's
// browser after consent, so there is no cookie context we can rely on — but
// the frontend kicks it off from an authenticated page, so we still gate the
// auth-url endpoint).
//
// Flow:
//   1. Frontend calls GET /api/google/auth-url, receives Google consent URL,
//      redirects the user there.
//   2. Google redirects back to GOOGLE_REDIRECT_URI (/api/google/callback)
//      with ?code=...
//   3. We exchange the code for tokens, store them, and redirect back to the
//      originating page (/westmere-admin.html or /westmere-owner.html).

const express = require('express');
const gcal = require('./google-calendar');
const { getDb } = require('./db');

const router = express.Router();

function requireStaff(req, res, next) {
  if (req.auth && ['admin', 'owner'].includes(req.auth.role)) return next();
  return res.status(403).json({ error: 'Access denied' });
}

// ── GET /api/google/auth-url (protected) ─────────────────────────────────
router.get('/auth-url', requireStaff, (req, res) => {
  if (!gcal.isConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in Railway.'
    });
  }
  // State carries the return path so we can send the user back after consent.
  const from = req.query.from && String(req.query.from).startsWith('/') ? String(req.query.from) : '/westmere-admin.html';
  const state = Buffer.from(JSON.stringify({ from, uid: req.auth.id })).toString('base64url');
  res.json({ ok: true, url: gcal.buildAuthUrl(state) });
});

// ── GET /api/google/status (protected) ───────────────────────────────────
router.get('/status', requireStaff, (req, res) => {
  res.json({ ok: true, ...gcal.getStatus() });
});

// ── POST /api/google/disconnect (protected) ──────────────────────────────
router.post('/disconnect', requireStaff, (req, res) => {
  gcal.clearTokens();
  res.json({ ok: true });
});

// ── POST /api/google/sync (protected) — manual pull trigger ──────────────
router.post('/sync', requireStaff, async (req, res) => {
  try {
    const result = await gcal.pullChanges();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public callback route (mounted separately because Google calls it with
// no auth cookie by default — we still validate state, but the ultimate
// protection is that the code is single-use and bound to our client secret).
const publicCallback = express.Router();

publicCallback.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  let from = '/westmere-admin.html';
  try {
    if (state) {
      const decoded = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
      if (decoded.from && typeof decoded.from === 'string' && decoded.from.startsWith('/')) from = decoded.from;
    }
  } catch (e) {}

  if (error) {
    return res.redirect(from + '?gcal=error&reason=' + encodeURIComponent(String(error)));
  }
  if (!code) {
    return res.redirect(from + '?gcal=error&reason=no_code');
  }
  if (!gcal.isConfigured()) {
    return res.redirect(from + '?gcal=error&reason=not_configured');
  }

  try {
    const tokens = await gcal.exchangeCodeForTokens(String(code));
    const email = await gcal.fetchUserEmail(tokens.access_token);
    gcal.saveTokens({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in:    tokens.expires_in,
      scope:         tokens.scope,
      email
    });
    // Kick off an initial pull in the background
    gcal.pullChanges().catch(() => {});
    return res.redirect(from + '?gcal=connected');
  } catch (e) {
    console.error('[GCAL] callback error:', e.message);
    return res.redirect(from + '?gcal=error&reason=' + encodeURIComponent(e.message));
  }
});

module.exports = router;
module.exports.publicCallback = publicCallback;
