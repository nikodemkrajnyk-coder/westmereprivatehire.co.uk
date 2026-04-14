// ── Google Calendar OAuth + API ──────────────────────────────────────────
// Self-contained module. Uses built-in fetch (Node 18+). No extra deps.
//
// Environment variables (set in Railway):
//   GOOGLE_CLIENT_ID       — OAuth 2.0 client id
//   GOOGLE_CLIENT_SECRET   — OAuth 2.0 client secret
//   GOOGLE_REDIRECT_URI    — Must match the value you registered in Google
//                            Cloud console (e.g. https://westmereprivatehire.co.uk/api/google/callback)
//   GOOGLE_CALENDAR_ID     — Optional; defaults to "primary"
//
// Scopes: we use the full Calendar scope so we can read + write events.

const { getDb } = require('./db');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || '';
const DEFAULT_CAL   = process.env.GOOGLE_CALENDAR_ID || 'primary';
const SCOPES        = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
].join(' ');

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE  = 'https://www.googleapis.com/calendar/v3';

const PROVIDER = 'google_calendar';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

// ── Token storage ────────────────────────────────────────────────────────
function loadTokens() {
  const db = getDb();
  return db.prepare('SELECT * FROM integrations WHERE provider = ?').get(PROVIDER) || null;
}

function saveTokens(payload) {
  const db = getDb();
  const existing = loadTokens();
  const now = Math.floor(Date.now() / 1000);
  const expires_at = payload.expires_in ? now + payload.expires_in - 60 : (existing && existing.expires_at) || null;

  if (existing) {
    db.prepare(`
      UPDATE integrations SET
        account_email = COALESCE(?, account_email),
        access_token  = COALESCE(?, access_token),
        refresh_token = COALESCE(?, refresh_token),
        expires_at    = COALESCE(?, expires_at),
        scope         = COALESCE(?, scope),
        calendar_id   = COALESCE(?, calendar_id),
        updated_at    = datetime('now')
      WHERE provider = ?
    `).run(
      payload.email || null,
      payload.access_token || null,
      payload.refresh_token || null,
      expires_at,
      payload.scope || null,
      payload.calendar_id || null,
      PROVIDER
    );
  } else {
    db.prepare(`
      INSERT INTO integrations (provider, account_email, access_token, refresh_token, expires_at, scope, calendar_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      payload.email || null,
      payload.access_token || null,
      payload.refresh_token || null,
      expires_at,
      payload.scope || null,
      payload.calendar_id || DEFAULT_CAL
    );
  }
  return loadTokens();
}

function clearTokens() {
  const db = getDb();
  db.prepare('DELETE FROM integrations WHERE provider = ?').run(PROVIDER);
}

function updateSyncToken(syncToken) {
  const db = getDb();
  db.prepare('UPDATE integrations SET sync_token = ?, updated_at = datetime(\'now\') WHERE provider = ?')
    .run(syncToken || null, PROVIDER);
}

// ── OAuth flow ───────────────────────────────────────────────────────────
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: state || ''
  });
  return AUTH_URL + '?' + params.toString();
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token exchange failed: ' + (data.error_description || data.error || res.status));
  return data;
}

async function refreshAccessToken(refresh_token) {
  const body = new URLSearchParams({
    refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Refresh failed: ' + (data.error_description || data.error || res.status));
  return data;
}

async function fetchUserEmail(access_token) {
  try {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  } catch (e) { return null; }
}

// ── Access token getter (auto-refresh) ───────────────────────────────────
async function getAccessToken() {
  const t = loadTokens();
  if (!t || !t.refresh_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (t.access_token && t.expires_at && t.expires_at > now) return t.access_token;

  const refreshed = await refreshAccessToken(t.refresh_token);
  saveTokens({
    access_token: refreshed.access_token,
    expires_in: refreshed.expires_in,
    scope: refreshed.scope
  });
  return refreshed.access_token;
}

// ── Calendar API helpers ─────────────────────────────────────────────────
async function apiCall(method, pathSuffix, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Google Calendar not connected');
  const t = loadTokens();
  const calendarId = encodeURIComponent((t && t.calendar_id) || DEFAULT_CAL);
  const url = `${API_BASE}/calendars/${calendarId}${pathSuffix}`;
  const opts = { method, headers: { Authorization: 'Bearer ' + token } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Convert a booking row into a Google Calendar event body
function bookingToEvent(booking) {
  // Build start/end datetimes. Default 90 min if no explicit duration.
  const durationMin = booking.duration_min || 90;
  const tz = 'Europe/London';

  let startIso, endIso;
  if (booking.time && /^\d{2}:\d{2}$/.test(booking.time) && booking.date) {
    startIso = `${booking.date}T${booking.time}:00`;
    const end = new Date(`${booking.date}T${booking.time}:00Z`);
    end.setUTCMinutes(end.getUTCMinutes() + durationMin);
    const pad = n => String(n).padStart(2, '0');
    endIso = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:00`;
  } else {
    // All-day if no time
    return {
      summary: `WPH ${booking.ref || ''} — ${booking.customer_name || 'Guest'}`,
      description: buildDescription(booking),
      start: { date: booking.date },
      end: { date: booking.date }
    };
  }

  return {
    summary: `WPH ${booking.ref || ''} — ${booking.customer_name || 'Guest'} (${booking.pickup || ''} → ${booking.destination || ''})`,
    description: buildDescription(booking),
    location: booking.pickup || '',
    start: { dateTime: startIso, timeZone: tz },
    end:   { dateTime: endIso,   timeZone: tz },
    extendedProperties: {
      private: {
        wph_ref: booking.ref || '',
        wph_booking_id: String(booking.id || '')
      }
    }
  };
}

function buildDescription(b) {
  const lines = [
    `Ref: ${b.ref || ''}`,
    `Customer: ${b.customer_name || 'Guest'}`,
    b.customer_phone ? `Phone: ${b.customer_phone}` : null,
    `Pickup: ${b.pickup || ''}`,
    `Destination: ${b.destination || ''}`,
    b.passengers ? `Passengers: ${b.passengers}` : null,
    b.bags ? `Bags: ${b.bags}` : null,
    b.flight ? `Flight: ${b.flight}` : null,
    b.fare ? `Fare: £${b.fare}` : null,
    b.payment ? `Payment: ${b.payment}` : null,
    b.notes ? `Notes: ${b.notes}` : null,
    `Status: ${b.status || 'pending'}`
  ].filter(Boolean);
  return lines.join('\n');
}

async function createEvent(booking) {
  if (!isConfigured() || !loadTokens()) return null;
  try {
    const event = await apiCall('POST', '/events', bookingToEvent(booking));
    return event && event.id ? event.id : null;
  } catch (e) {
    console.error('[GCAL] createEvent failed:', e.message);
    return null;
  }
}

async function updateEvent(eventId, booking) {
  if (!isConfigured() || !loadTokens() || !eventId) return false;
  try {
    await apiCall('PATCH', '/events/' + encodeURIComponent(eventId), bookingToEvent(booking));
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    console.error('[GCAL] updateEvent failed:', e.message);
    return false;
  }
}

async function deleteEvent(eventId) {
  if (!isConfigured() || !loadTokens() || !eventId) return false;
  try {
    await apiCall('DELETE', '/events/' + encodeURIComponent(eventId));
    return true;
  } catch (e) {
    if (e.status === 404 || e.status === 410) return true;
    console.error('[GCAL] deleteEvent failed:', e.message);
    return false;
  }
}

// ── Two-way sync: pull changes from Google into our bookings ─────────────
async function pullChanges() {
  if (!isConfigured() || !loadTokens()) return { ok: false, reason: 'not_connected' };

  const token = await getAccessToken();
  if (!token) return { ok: false, reason: 'no_token' };
  const t = loadTokens();
  const calendarId = encodeURIComponent((t && t.calendar_id) || DEFAULT_CAL);
  const syncToken = t && t.sync_token;

  let url;
  if (syncToken) {
    url = `${API_BASE}/calendars/${calendarId}/events?syncToken=${encodeURIComponent(syncToken)}&singleEvents=true`;
  } else {
    // First sync: pull next 90 days only
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    url = `${API_BASE}/calendars/${calendarId}/events?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&maxResults=250`;
  }

  const db = getDb();
  let changed = 0;
  let nextPage = null;
  let newSyncToken = null;

  do {
    const res = await fetch(nextPage ? url + '&pageToken=' + encodeURIComponent(nextPage) : url, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.status === 410) {
      // Sync token invalid — reset and full-sync next time
      updateSyncToken(null);
      return { ok: false, reason: 'sync_expired' };
    }
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };

    for (const ev of data.items || []) {
      const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      const bookingId = priv.wph_booking_id ? parseInt(priv.wph_booking_id, 10) : null;
      if (!bookingId) continue;

      const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      if (!booking) continue;

      if (ev.status === 'cancelled') {
        // User deleted/cancelled on Google Calendar
        if (booking.status !== 'cancelled') {
          db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(bookingId);
          changed++;
        }
        continue;
      }

      // Pull time changes
      if (ev.start && ev.start.dateTime) {
        const d = new Date(ev.start.dateTime);
        const pad = n => String(n).padStart(2, '0');
        const newDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const newTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (newDate !== booking.date || newTime !== booking.time) {
          db.prepare("UPDATE bookings SET date = ?, time = ?, updated_at = datetime('now') WHERE id = ?").run(newDate, newTime, bookingId);
          changed++;
        }
      }
    }

    nextPage = data.nextPageToken || null;
    if (data.nextSyncToken) newSyncToken = data.nextSyncToken;
  } while (nextPage);

  if (newSyncToken) updateSyncToken(newSyncToken);
  return { ok: true, changed };
}

// ── Status (for frontend) ────────────────────────────────────────────────
function getStatus() {
  const t = loadTokens();
  return {
    configured: isConfigured(),
    connected: !!(t && t.refresh_token),
    email: t ? t.account_email : null,
    calendarId: t ? t.calendar_id : null
  };
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserEmail,
  saveTokens,
  clearTokens,
  createEvent,
  updateEvent,
  deleteEvent,
  pullChanges,
  getStatus,
  loadTokens
};
