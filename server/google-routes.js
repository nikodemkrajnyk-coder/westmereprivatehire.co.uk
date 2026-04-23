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
  const ALLOWED_RETURNS = ['/westmere-admin.html', '/westmere-owner.html', '/westmere-driver.html'];
  const from = req.query.from && ALLOWED_RETURNS.includes(String(req.query.from)) ? String(req.query.from) : '/westmere-admin.html';
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

// ── GET /api/google/external-events (protected) ──────────────────────────
// Returns the operator's personal/other calendar events (not WPH bookings)
// so the UI can display "you're busy at 14:00" etc.
router.get('/external-events', requireStaff, async (req, res) => {
  try {
    if (!gcal.isConfigured()) return res.json({ ok: true, events: [], reason: 'not_configured' });
    const status = gcal.getStatus();
    if (!status.connected) return res.json({ ok: true, events: [], reason: 'not_connected' });
    const events = await gcal.listExternalEvents({
      days: req.query.days,
      from: req.query.from,
      to:   req.query.to
    });
    res.json({ ok: true, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/google/events — create a one-off calendar event (no booking) ──
// Used by the "Add to Calendar Only" button in the AI assistant for jobs from
// other operators that don't need to go through the Westmere booking system.
// Normalize various time strings to HH:MM (24h). Returns null if not parseable.
function normalizeTime(t) {
  if (!t) return null;
  t = String(t).trim();
  if (/^\d{2}:\d{2}$/.test(t)) return t;                              // already HH:MM
  if (/^\d{1}:\d{2}$/.test(t)) return '0' + t;                        // H:MM → 0H:MM
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    let h = parseInt(m[1]), mins = parseInt(m[2] || '0');
    const period = m[3] ? m[3].toLowerCase() : null;
    if (period === 'pm' && h < 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
  }
  return null;
}

router.post('/events', requireStaff, async (req, res) => {
  if (!gcal.isConfigured()) return res.status(503).json({ error: 'Google Calendar not configured' });
  const status = gcal.getStatus();
  if (!status.connected) return res.status(503).json({ error: 'Google Calendar not connected. Connect Google Calendar in Settings first.' });

  const { title, date, time, pickup, destination, name, phone, fare, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });

  const normalTime = normalizeTime(time);
  const tz = 'Europe/London';
  let eventBody;

  if (normalTime) {
    const startIso = `${date}T${normalTime}:00`;
    const endDate = new Date(`${date}T${normalTime}:00Z`);
    endDate.setUTCMinutes(endDate.getUTCMinutes() + 60);
    const pad = n => String(n).padStart(2, '0');
    const endIso = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth()+1)}-${pad(endDate.getUTCDate())}T${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}:00`;
    eventBody = {
      summary: title || `${name || 'Pickup'} — ${pickup || ''}${destination ? ' → ' + destination : ''}`,
      location: pickup || '',
      description: [
        name    ? `Passenger: ${name}`    : null,
        phone   ? `Phone: ${phone}`       : null,
        pickup  ? `Pickup: ${pickup}`     : null,
        destination ? `Drop-off: ${destination}` : null,
        fare    ? `Fare: £${fare}`        : null,
        notes   ? `Notes: ${notes}`       : null,
        '',
        pickup      ? `Pickup (Waze): https://waze.com/ul?q=${encodeURIComponent(pickup)}`           : null,
        destination ? `Drop-off (Waze): https://waze.com/ul?q=${encodeURIComponent(destination)}`   : null
      ].filter(x => x !== null).join('\n'),
      start: { dateTime: startIso, timeZone: tz },
      end:   { dateTime: endIso,   timeZone: tz }
    };
  } else {
    eventBody = {
      summary: title || `${name || 'Pickup'} — ${pickup || ''}${destination ? ' → ' + destination : ''}`,
      description: [
        name  ? `Passenger: ${name}`  : null,
        phone ? `Phone: ${phone}`     : null,
        notes ? `Notes: ${notes}`     : null
      ].filter(Boolean).join('\n'),
      start: { date },
      end:   { date }
    };
  }

  try {
    const token = await gcal.getAccessToken();
    const t = gcal.loadTokens();
    const calId = encodeURIComponent((t && t.calendar_id) || 'primary');
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody)
    });
    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: (d.error && d.error.message) || 'Calendar API error' });
    res.json({ ok: true, eventId: d.id, htmlLink: d.htmlLink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/google/booking-events — purge all WPH events from calendar ──
// Lists events in a 90-day window, identifies any with wph_booking_id in their
// extendedProperties, and deletes them. Used to clean up test bookings.
router.delete('/booking-events', requireStaff, async (req, res) => {
  if (!gcal.isConfigured()) return res.status(503).json({ error: 'Google Calendar not configured' });
  const token = await gcal.getAccessToken().catch(() => null);
  if (!token) return res.status(503).json({ error: 'Google Calendar not connected' });

  const t = gcal.loadTokens();
  const calId = encodeURIComponent((t && t.calendar_id) || 'primary');
  const API = 'https://www.googleapis.com/calendar/v3';
  const from = new Date(Date.now() - 14 * 86400000).toISOString();
  const to   = new Date(Date.now() + 60 * 86400000).toISOString();

  let items = [];
  try {
    const r = await fetch(
      `${API}/calendars/${calId}/events?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&maxResults=500`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const d = await r.json();
    items = d.items || [];
  } catch (e) {
    return res.status(500).json({ error: 'List failed: ' + e.message });
  }

  const wphEvents = items.filter(ev => {
    const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
    return priv.wph_booking_id || priv.wph_ref;
  });

  let deleted = 0;
  for (const ev of wphEvents) {
    try {
      await fetch(`${API}/calendars/${calId}/events/${encodeURIComponent(ev.id)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      deleted++;
    } catch (e) {
      console.error('[GCAL] delete event failed:', ev.id, e.message);
    }
  }

  console.log(`[GCAL] Purged ${deleted}/${wphEvents.length} WPH booking events`);
  res.json({ ok: true, found: wphEvents.length, deleted });
});

// ── Public callback route (mounted separately because Google calls it with
// no auth cookie by default — we still validate state, but the ultimate
// protection is that the code is single-use and bound to our client secret).
const publicCallback = express.Router();

publicCallback.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const ALLOWED_RETURNS = ['/westmere-admin.html', '/westmere-owner.html', '/westmere-driver.html'];
  let from = '/westmere-admin.html';
  try {
    if (state) {
      const decoded = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
      if (decoded.from && ALLOWED_RETURNS.includes(decoded.from)) from = decoded.from;
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
