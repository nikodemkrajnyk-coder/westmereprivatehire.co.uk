// ── Tesla Fleet API integration ──────────────────────────────────────────
// Mounted at /api/tesla. OAuth callback is public (Tesla redirects here),
// all other routes require an authenticated owner or driver session.
//
// Flow:
//   1. Frontend calls GET /api/tesla/auth-url → receives Tesla consent URL
//   2. Tesla redirects to /api/tesla/callback?code=...
//   3. We exchange code for tokens, store in integrations table (provider='tesla')
//   4. Subsequent calls use stored access token, auto-refreshing when expired

const express = require('express');
const { getDb } = require('./db');

const router = express.Router();
const publicCallback = express.Router();

const TESLA_AUTH_URL  = 'https://auth.tesla.com/oauth2/v3/authorize';
const TESLA_TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';
const TESLA_API_BASE  = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
const REDIRECT_URI    = 'https://westmereprivatehire.co.uk/api/tesla/callback';
const PROVIDER        = 'tesla';

function isConfigured() {
  return !!(process.env.TESLA_CLIENT_ID && process.env.TESLA_CLIENT_SECRET);
}

function requireOwnerOrDriver(req, res, next) {
  if (req.auth && ['admin', 'owner', 'driver'].includes(req.auth.role)) return next();
  return res.status(403).json({ error: 'Access denied' });
}

// ── Token helpers ─────────────────────────────────────────────────────────

function getStoredTokens() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM integrations WHERE provider = ?").get(PROVIDER);
  return row || null;
}

function saveTokens({ access_token, refresh_token, expires_in, scope }) {
  const db = getDb();
  const expires_at = Math.floor(Date.now() / 1000) + (expires_in || 3600);
  const existing = db.prepare("SELECT id FROM integrations WHERE provider = ?").get(PROVIDER);
  if (existing) {
    db.prepare(`UPDATE integrations SET access_token=?, refresh_token=?, expires_at=?, scope=?, updated_at=datetime('now') WHERE provider=?`)
      .run(access_token, refresh_token || existing.refresh_token, expires_at, scope || null, PROVIDER);
  } else {
    db.prepare(`INSERT INTO integrations (provider, access_token, refresh_token, expires_at, scope) VALUES (?,?,?,?,?)`)
      .run(PROVIDER, access_token, refresh_token || null, expires_at, scope || null);
  }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.TESLA_CLIENT_ID,
    client_secret: process.env.TESLA_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const r = await fetch(TESLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error('Token refresh failed: HTTP ' + r.status);
  return r.json();
}

async function getValidAccessToken() {
  const row = getStoredTokens();
  if (!row || !row.access_token) throw new Error('Tesla not connected');

  const nowSec = Math.floor(Date.now() / 1000);
  // Refresh if expired or within 5 minutes of expiry
  if (row.expires_at && row.expires_at - nowSec < 300) {
    if (!row.refresh_token) throw new Error('Tesla token expired and no refresh token stored');
    const tokens = await refreshAccessToken(row.refresh_token);
    saveTokens(tokens);
    return tokens.access_token;
  }
  return row.access_token;
}

async function teslaGet(path) {
  const token = await getValidAccessToken();
  const r = await fetch(TESLA_API_BASE + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Tesla API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// ── Public callback (Tesla redirects here — no auth cookie) ──────────────

publicCallback.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('[TESLA] OAuth error:', error, error_description);
    return res.redirect('/westmere-driver.html?tesla=error&reason=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/westmere-driver.html?tesla=error&reason=no_code');
  }

  if (!isConfigured()) {
    return res.redirect('/westmere-driver.html?tesla=error&reason=not_configured');
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.TESLA_CLIENT_ID,
      client_secret: process.env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri:  REDIRECT_URI,
    });

    const r = await fetch(TESLA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[TESLA] Token exchange failed:', r.status, txt.slice(0, 300));
      return res.redirect('/westmere-driver.html?tesla=error&reason=token_exchange');
    }

    const tokens = await r.json();
    saveTokens(tokens);
    console.log('[TESLA] Connected successfully');

    // Redirect back — the page will pick up ?tesla=connected and refresh UI
    const from = req.query.state ? (() => {
      try { return JSON.parse(Buffer.from(req.query.state, 'base64url').toString()).from || '/westmere-driver.html'; }
      catch (_) { return '/westmere-driver.html'; }
    })() : '/westmere-driver.html';

    res.redirect(from + '?tesla=connected');
  } catch (e) {
    console.error('[TESLA] Callback error:', e.message);
    res.redirect('/westmere-driver.html?tesla=error&reason=' + encodeURIComponent(e.message));
  }
});

// ── Protected routes ──────────────────────────────────────────────────────

// GET /api/tesla/auth-url — generate Tesla OAuth URL
router.get('/auth-url', requireOwnerOrDriver, (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Tesla not configured. Set TESLA_CLIENT_ID and TESLA_CLIENT_SECRET in Railway.'
    });
  }

  const from = req.query.from || '/westmere-driver.html';
  const state = Buffer.from(JSON.stringify({ from, uid: req.auth.id })).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.TESLA_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         'openid vehicle_device_data vehicle_location offline_access',
    state,
  });

  res.json({ ok: true, url: TESLA_AUTH_URL + '?' + params.toString() });
});

// GET /api/tesla/status — is Tesla connected?
router.get('/status', requireOwnerOrDriver, (req, res) => {
  if (!isConfigured()) return res.json({ ok: true, connected: false, reason: 'not_configured' });
  const row = getStoredTokens();
  if (!row || !row.access_token) return res.json({ ok: true, connected: false });
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = row.expires_at && row.expires_at < nowSec && !row.refresh_token;
  res.json({ ok: true, connected: !expired, expires_at: row.expires_at });
});

// GET /api/tesla/vehicle — vehicle data (battery, range, charge, location)
router.get('/vehicle', requireOwnerOrDriver, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Tesla not configured' });

  try {
    // List vehicles
    const listData = await teslaGet('/api/1/vehicles');
    const vehicles = listData.response || [];
    if (!vehicles.length) return res.json({ ok: true, vehicle: null, reason: 'no_vehicles' });

    const vehicle = vehicles[0];
    const vid = vehicle.id;

    // Fetch full vehicle data — may return 408 if car is asleep
    let vehicleData = null;
    try {
      const vd = await teslaGet(`/api/1/vehicles/${vid}/vehicle_data?endpoints=charge_state%3Bdrive_state%3Bclimate_state%3Bvehicle_state`);
      vehicleData = vd.response || null;
    } catch (e) {
      // Car asleep — return what we know without live data
      if (e.message.includes('408') || e.message.toLowerCase().includes('sleep')) {
        return res.json({
          ok: true,
          vehicle: {
            id: vehicle.id,
            display_name: vehicle.display_name,
            vin: vehicle.vin,
            state: 'asleep',
            battery_level: null,
            battery_range_miles: null,
            charging_state: null,
            charge_rate_mph: null,
            minutes_to_full: null,
            odometer_miles: null,
            latitude: null,
            longitude: null,
            speed_mph: null,
            climate_on: null,
            inside_temp_c: null,
          }
        });
      }
      throw e;
    }

    const charge = vehicleData.charge_state || {};
    const drive  = vehicleData.drive_state  || {};
    const climate= vehicleData.climate_state|| {};
    const vstate = vehicleData.vehicle_state|| {};

    res.json({
      ok: true,
      vehicle: {
        id:                   vehicle.id,
        display_name:         vehicle.display_name || 'Tesla',
        vin:                  vehicle.vin,
        state:                vehicle.state, // 'online', 'asleep', etc.
        battery_level:        charge.battery_level ?? null,          // %
        battery_range_miles:  charge.battery_range != null ? Math.round(charge.battery_range) : null, // Tesla reports in miles
        charging_state:       charge.charging_state ?? null,         // 'Charging', 'Disconnected', 'Complete'
        charge_rate_mph:      charge.charge_rate ?? null,
        minutes_to_full:      charge.minutes_to_full_charge ?? null,
        odometer_miles:       vstate.odometer != null ? Math.round(vstate.odometer) : null,
        latitude:             drive.latitude ?? null,
        longitude:            drive.longitude ?? null,
        speed_mph:            drive.speed ?? null,
        climate_on:           climate.is_climate_on ?? null,
        inside_temp_c:        climate.inside_temp ?? null,
      }
    });
  } catch (e) {
    console.error('[TESLA] vehicle error:', e.message);
    if (e.message.includes('not connected') || e.message.includes('not connected')) {
      return res.status(401).json({ error: 'Tesla not connected', code: 'not_connected' });
    }
    res.status(502).json({ error: e.message });
  }
});

// POST /api/tesla/disconnect — clear stored tokens
router.post('/disconnect', requireOwnerOrDriver, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM integrations WHERE provider = ?").run(PROVIDER);
  res.json({ ok: true });
});

module.exports = router;
module.exports.publicCallback = publicCallback;
