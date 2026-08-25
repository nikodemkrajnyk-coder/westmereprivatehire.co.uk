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
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
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

/* IS THE GRANT ITSELF DEAD?
   Distinct from "the access token expired", which is normal and handled
   silently. This is set only when Google rejects the REFRESH token, which no
   amount of retrying will fix — the owner has to consent again. Cleared the
   moment a refresh succeeds, so a transient outage cannot leave a false alarm
   on the screen. */
function markNeedsReconnect(v) {
  try {
    getDb().prepare("UPDATE integrations SET needs_reconnect = ?, updated_at = datetime('now') WHERE provider = ?")
      .run(v ? 1 : 0, PROVIDER);
  } catch (e) { console.error('[GCAL] needs_reconnect write failed:', e.message); }
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
  if (!res.ok) {
    const err = new Error('Refresh failed: ' + (data.error_description || data.error || res.status));
    // Google names the cause in `error`. invalid_grant means the refresh token
    // is revoked/expired — the ONE case where reconnecting is the real answer.
    err.googleError = (data && data.error) || null;
    err.status = res.status;
    throw err;
  }
  return data;
}

// The errors that mean "this grant is finished", as opposed to "try again".
const DEAD_GRANT = ['invalid_grant', 'invalid_client', 'unauthorized_client'];

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
/* THE ACCESS TOKEN, REFRESHED WHEN IT NEEDS TO BE — NOT WHEN A CLOCK SAYS SO.
   This used to decide purely on the stored expiry, which meant a token that
   Google had already invalidated (a re-consent, a scope change, a security
   event) went on being sent until the clock caught up. Nothing anywhere reacted
   to a 401, so those calls simply failed, `listExternalEvents` turned the
   failure into an empty list, and the owner's personal calendar went blank with
   the app still reporting "Connected".

   `opts.force` skips the cached token — googleFetch uses it after a 401, which
   is the answer from Google itself rather than a guess from a clock. */
async function getAccessToken(opts) {
  const force = !!(opts && opts.force);
  const t = loadTokens();
  if (!t || !t.refresh_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!force && t.access_token && t.expires_at && t.expires_at > now) return t.access_token;

  let refreshed;
  try {
    refreshed = await refreshAccessToken(t.refresh_token);
  } catch (e) {
    if (DEAD_GRANT.indexOf(e.googleError) !== -1) {
      // Only here. A network blip must never nag the owner to reconnect.
      markNeedsReconnect(1);
      e.needsReconnect = true;
      console.error('[GCAL] refresh token rejected by Google (' + e.googleError + ') — reconnect required');
    } else {
      console.error('[GCAL] token refresh failed (transient):', e.message);
    }
    throw e;
  }
  saveTokens({
    access_token: refreshed.access_token,
    expires_in: refreshed.expires_in,
    scope: refreshed.scope
  });
  markNeedsReconnect(0);   // it works — retract any previous alarm
  return refreshed.access_token;
}

/* EVERY CALL TO GOOGLE GOES THROUGH HERE.
   One choke point that attaches the token and, on a 401, mints a fresh one and
   tries again exactly once. 401 is the only status retried: it is Google saying
   "this token is no good". A 403 is permission or quota, and a new token will
   not change either — retrying it would just double the failures.

   Before this existed, the assistant's create path, the owner app's calendar
   read and the sync each fetched a token once and used it raw, so they could
   hold different opinions about whether the connection worked. */
async function googleFetch(url, init) {
  const opts = init || {};
  const withToken = (tok) => Object.assign({}, opts, {
    headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + tok })
  });

  let token = await getAccessToken();
  if (!token) {
    const e = new Error('Google Calendar not connected');
    e.status = 401;
    throw e;
  }
  let res = await fetch(url, withToken(token));
  if (res.status !== 401) return res;

  const fresh = await getAccessToken({ force: true });
  if (!fresh) return res;
  console.log('[GCAL] access token rejected — refreshed and retried once');
  return fetch(url, withToken(fresh));
}

// ── Calendar API helpers ─────────────────────────────────────────────────
async function apiCall(method, pathSuffix, body) {
  const t = loadTokens();
  const calendarId = encodeURIComponent((t && t.calendar_id) || DEFAULT_CAL);
  const url = `${API_BASE}/calendars/${calendarId}${pathSuffix}`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await googleFetch(url, opts);
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

// ── Address shortening + luggage + flight ────────────────────────────────
// These used to be three divergent local copies (here, driver-cal-routes.js
// and google-routes.js) of the shortener the apps and emails already shared,
// so a calendar event could show the long raw address that no other surface
// showed. They now delegate to the SINGLE sources of truth:
//   address-normalize.js — short display form + "is this an airport run?"
//   wm-lifecycle.js      — the integer luggage label
// Display only: LOCATION and the Waze links still carry the FULL address.
const { shortDisplay, tinyLabel, flightFor } = require('../address-normalize');
const { bagsText } = require('../wm-lifecycle');

// Single most-distinctive token for the event title (airport name or town).
function _tinyAddr(a) { return tinyLabel(a); }

// The short display form for description/location fields.
function _shortAddr(a) { return shortDisplay(a); }

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
      summary: booking.customer_name && !booking.pickup ? booking.customer_name : `${_tinyAddr(booking.pickup) || '?'} → ${_tinyAddr(booking.destination) || '?'}`,
      description: buildDescription(booking),
      start: { date: booking.date },
      end: { date: booking.date }
    };
  }

  return {
    summary: booking.customer_name && !booking.pickup ? booking.customer_name : `${_tinyAddr(booking.pickup) || '?'} → ${_tinyAddr(booking.destination) || '?'}`,
    description: buildDescription(booking),
    location: _shortAddr(booking.pickup) || booking.pickup || '',
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
  // Concise \u2014 one fact per line. Passenger, phone, route, money, then refs/nav.
  const money = [
    b.time ? b.time : null,
    b.fare ? `\u00a3${b.fare}` : null,
    b.payment || null
  ].filter(Boolean).join('  \u00b7  ');
  const flt = flightFor(b);          // airport runs only
  const extras = [
    b.passengers ? `${b.passengers} pax` : null,
    bagsText(b.bags) || null,        // integer label, omitted when zero
    flt ? `Flight ${flt}` : null
  ].filter(Boolean).join('  \u00b7  ');
  const lines = [
    `${b.customer_name || 'Guest'}${b.customer_phone ? '  \u00b7  ' + b.customer_phone : ''}`,
    b.stop_address ? `Stop: ${_shortAddr(b.stop_address) || b.stop_address}` : null,
    money || null,
    extras || null,
    b.notes ? `Notes: ${b.notes}` : null,
    `${b.ref ? b.ref + ' \u00b7 ' : ''}${b.status || 'pending'}`,
    b.destination ? `Navigate (Waze): https://waze.com/ul?q=${encodeURIComponent(b.destination)}` : null
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
  try {
    return await _pullChanges();
  } catch (e) {
    if (e && e.needsReconnect) return { ok: false, reason: 'needs_reconnect' };
    console.error('[GCAL] pullChanges failed:', e.message);
    return { ok: false, reason: 'error' };
  }
}

async function _pullChanges() {

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
    const res = await googleFetch(nextPage ? url + '&pageToken=' + encodeURIComponent(nextPage) : url);
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

      // Pull time changes — use Europe/London timezone so BST/GMT is correct.
      // FIX: getHours() returns UTC on Railway servers, causing 07:00 BST to
      // be stored as 06:00. Using Intl.DateTimeFormat with Europe/London instead.
      if (ev.start && ev.start.dateTime) {
        const d = new Date(ev.start.dateTime);
        const ukParts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/London',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
        const newDate = `${ukParts.year}-${ukParts.month}-${ukParts.day}`;
        const newTime = `${ukParts.hour}:${ukParts.minute}`;
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

// ── List external events (commitments from the user's calendar) ──────────
// Returns events from now through `days` ahead, EXCLUDING events we created
// ourselves (identified by extendedProperties.private.wph_booking_id).
// Fetches from ALL of the user's visible calendars (including subscribed
// ones like iCloud-published feeds) so operators who keep events elsewhere
// still see them surfaced in the admin UI.
/* A FAILURE HERE USED TO LOOK EXACTLY LIKE AN EMPTY DIARY.
   Every non-OK response returned [], so a 401 rendered as "you have nothing on"
   in the owner app — the "out of sync" the owner kept hitting. An auth failure
   now propagates (the caller turns it into an honest "reconnect Google"); a
   single misbehaving subscribed calendar still degrades quietly, because one
   broken feed should not blank the whole week. */
async function listExternalEvents(opts) {
  if (!isConfigured() || !loadTokens()) return [];

  // Accept either { from, to } as YYYY-MM-DD or { days } for a rolling window
  // from "now". Caps the window at 400 days to keep API responses sane.
  let from, to;
  const o = opts && typeof opts === 'object' ? opts : { days: opts };
  if (o.from && /^\d{4}-\d{2}-\d{2}$/.test(o.from) && o.to && /^\d{4}-\d{2}-\d{2}$/.test(o.to)) {
    from = new Date(o.from + 'T00:00:00.000Z').toISOString();
    to = new Date(o.to + 'T23:59:59.999Z').toISOString();
    const span = (new Date(to) - new Date(from)) / (24 * 3600 * 1000);
    if (span > 400) return [];
  } else {
    const daysAhead = Math.max(1, Math.min(60, parseInt(o.days, 10) || 7));
    from = new Date().toISOString();
    to = new Date(Date.now() + daysAhead * 24 * 3600 * 1000).toISOString();
  }

  // Enumerate every calendar in the user's list. `selected !== false` keeps
  // calendars the user has ticked as visible; `!hidden` excludes ones they
  // explicitly hid. Subscribed feeds (like iCloud Published) appear here
  // exactly like native Google calendars.
  let calendars = [];
  try {
    const lr = await googleFetch(`${API_BASE}/users/me/calendarList?minAccessRole=reader`);
    const ld = await lr.json();
    if (!lr.ok) {
      console.error('[GCAL] calendarList HTTP', lr.status, ld && ld.error && ld.error.message);
      // Still unauthorised AFTER a forced refresh — the grant is the problem,
      // and pretending the diary is empty is how this hid for so long.
      const e = new Error('Google rejected the calendar list (HTTP ' + lr.status + ')');
      e.status = lr.status;
      if (lr.status === 401 || lr.status === 403) e.needsReconnect = true;
      throw e;
    }
    calendars = (ld.items || []).filter(c => !c.hidden && c.selected !== false);
  } catch (e) {
    if (e && e.needsReconnect) throw e;
    console.error('[GCAL] calendarList failed:', e.message);
    return [];
  }
  if (!calendars.length) return [];

  const seenEventIds = new Set();
  const out = [];

  // Fetch events from every calendar in parallel.
  const fetches = calendars.map(async (cal) => {
    const id = encodeURIComponent(cal.id);
    const url = `${API_BASE}/calendars/${id}/events`
      + `?timeMin=${encodeURIComponent(from)}`
      + `&timeMax=${encodeURIComponent(to)}`
      + `&singleEvents=true&orderBy=startTime&maxResults=250`;
    try {
      const res = await googleFetch(url);
      const data = await res.json();
      if (!res.ok) {
        // Subscribed calendars that failed temporarily, calendars without
        // event access — swallow and move on rather than failing the whole
        // request.
        console.error('[GCAL] events HTTP', res.status, cal.id, data && data.error && data.error.message);
        return [];
      }
      return (data.items || []).map(ev => ({ ev, cal }));
    } catch (e) {
      console.error('[GCAL] events fetch failed for', cal.id, e.message);
      return [];
    }
  });

  const results = await Promise.all(fetches);
  for (const bucket of results) {
    for (const { ev, cal } of bucket) {
      if (ev.status === 'cancelled') continue;
      // Skip events we created on our primary calendar
      const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (priv.wph_booking_id) continue;
      // Skip declined events
      const me = (ev.attendees || []).find(a => a.self);
      if (me && me.responseStatus === 'declined') continue;
      // Dedupe — the same event can appear on multiple calendars (invites)
      if (seenEventIds.has(ev.id)) continue;
      seenEventIds.add(ev.id);

      const start = ev.start || {};
      const end = ev.end || {};
      out.push({
        id: ev.id,
        title: ev.summary || '(No title)',
        location: ev.location || '',
        notes: ev.description || '',
        allDay: !!start.date,
        start: start.dateTime || start.date,
        end: end.dateTime || end.date,
        htmlLink: ev.htmlLink || null,
        calendar: cal.summary || cal.id,
        calendarColor: cal.backgroundColor || null
      });
    }
  }

  // Sort chronologically
  out.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  return out;
}

// ── Status (for frontend) ────────────────────────────────────────────────
function getStatus() {
  const t = loadTokens();
  // `connected` used to mean "a refresh token string is in the database", which
  // stayed true long after Google stopped honouring it — the owner app showed a
  // healthy connection above an empty calendar. It now means the grant is
  // believed to still work.
  const needsReconnect = !!(t && t.needs_reconnect);
  return {
    configured: isConfigured(),
    connected: !!(t && t.refresh_token) && !needsReconnect,
    needsReconnect,
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
  listExternalEvents,
  getStatus,
  loadTokens,
  getAccessToken,
  googleFetch,
  markNeedsReconnect,
  bookingToEvent,
  _tinyAddr,
  _shortAddr
};
