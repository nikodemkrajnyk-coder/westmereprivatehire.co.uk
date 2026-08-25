/**
 * GOOGLE CALENDAR STAYS CONNECTED BY ITSELF —
 *   node server/tests/google-token-refresh.test.js   (also gated by `npm test`)
 *
 * THE BUG THIS EXISTS FOR
 *   The owner would add a job to his personal calendar from the assistant, and
 *   some time later the owner app's calendar would go blank. The only cure he
 *   ever found was Disconnect → Reconnect, and it kept coming back.
 *
 *   It was never the calendar. It was the token:
 *
 *     • getAccessToken() refreshed on the STORED CLOCK alone. A token Google
 *       had already invalidated went on being sent until the clock caught up.
 *     • NOTHING anywhere reacted to a 401 — not the assistant's create, not the
 *       owner app's read, not the sync. No call was ever retried with a fresh
 *       token.
 *     • listExternalEvents() turned every failure, 401 included, into `[]`.
 *       An auth failure was indistinguishable from an empty diary.
 *     • getStatus() reported `connected` from the mere PRESENCE of a refresh
 *       token string, so the UI showed a healthy connection above that empty
 *       calendar, and offered exactly one lever: reconnect.
 *
 *   Reconnecting worked because it is the only path in the app that performs a
 *   fresh OAuth grant. The refresh that should have made it unnecessary was
 *   never reached.
 *
 * WHAT IS PINNED HERE
 *   A fake Google, wired into global.fetch, that behaves like the real one:
 *   rejects a stale bearer with 401, honours a refresh, and can revoke the
 *   grant outright. Then: does a calendar call heal ITSELF, without anybody
 *   touching the Connect button?
 *
 * No real credentials, no network. Exit 1 on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-gcal-refresh-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://westmereprivatehire.co.uk/api/google/callback';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const gcal = require('../google-calendar');
const { getDb } = require('../db');
const db = getDb();

/* ── A FAKE GOOGLE ────────────────────────────────────────────────────────
   Holds one live access token. Any other bearer gets a 401, exactly as
   Google's does. `revoked` kills the refresh token itself (invalid_grant). */
const G = {
  live: 'access-1',
  refreshes: 0,
  calls: [],        // every calendar/API request, with the bearer used
  revoked: false,
  rotate(next) { this.live = next; }
};
function reset() {
  G.live = 'access-1'; G.refreshes = 0; G.calls = []; G.revoked = false;
}

global.fetch = async (url, opts) => {
  const u = String(url);
  const o = opts || {};

  // The token endpoint.
  if (u === 'https://oauth2.googleapis.com/token') {
    G.refreshes++;
    if (G.revoked) {
      return {
        ok: false, status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      };
    }
    G.rotate('access-' + (G.refreshes + 1));
    return { ok: true, status: 200, json: async () => ({ access_token: G.live, expires_in: 3600, scope: 'calendar' }) };
  }

  // Everything else is a Google API call, and it checks the bearer.
  const bearer = String((o.headers && (o.headers.Authorization || o.headers.authorization)) || '').replace('Bearer ', '');
  G.calls.push({ url: u, bearer });
  if (bearer !== G.live) {
    return { ok: false, status: 401, json: async () => ({ error: { code: 401, message: 'Invalid Credentials' } }),
             text: async () => '{}' };
  }
  if (/calendarList/.test(u)) {
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'primary', summary: 'Personal' }] }),
             text: async () => '{}' };
  }
  if (/\/events/.test(u)) {
    return { ok: true, status: 200,
             json: async () => ({ id: 'ev-1', htmlLink: 'https://cal/ev-1',
                                  items: [{ id: 'ev-1', summary: 'Dentist', status: 'confirmed',
                                            start: { dateTime: '2030-01-01T10:00:00Z' },
                                            end:   { dateTime: '2030-01-01T11:00:00Z' } }] }),
             text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

/** Put a connected account in the database — a STALE access token, not expired. */
function connect(opts) {
  const o = opts || {};
  db.prepare('DELETE FROM integrations WHERE provider = ?').run('google_calendar');
  gcal.saveTokens({
    access_token: o.access_token === undefined ? 'access-STALE' : o.access_token,
    refresh_token: 'refresh-1',
    expires_in: o.expires_in === undefined ? 3600 : o.expires_in,   // NOT expired by the clock
    scope: 'calendar', email: 'owner@example.com'
  });
  gcal.markNeedsReconnect(0);
}

// ── 1. THE HEART OF IT ───────────────────────────────────────────────────
console.log('\nA stale access token heals itself');

test('a calendar READ refreshes and retries after a 401 — no reconnect', async () => {
  reset(); connect();                       // stored token is dead; clock says fine
  const events = await gcal.listExternalEvents({ days: 7 });
  assert.ok(events.length > 0, 'the owner must get his personal calendar back');
  assert.strictEqual(G.refreshes, 1, 'exactly one refresh — not a loop');
  const bearers = G.calls.map(c => c.bearer);
  assert.ok(bearers.indexOf('access-STALE') !== -1, 'it tried the stored token first');
  assert.ok(bearers.indexOf('access-2') !== -1, 'then retried with the fresh one');
  assert.strictEqual(gcal.getStatus().connected, true, 'and the connection stays connected');
});

test('the assistant CREATE path heals itself the same way', async () => {
  reset(); connect();
  const id = await gcal.createEvent({ ref: 'WPH-1', date: '2030-01-01', time: '09:00',
    pickup: 'Caterham', destination: 'Gatwick', customer_name: 'Mr Ben Chan' });
  assert.strictEqual(id, 'ev-1', 'the event must actually be created');
  assert.strictEqual(G.refreshes, 1, 'one refresh');
});

test('a stale token is refreshed ONCE for a burst of calls, not once per call', async () => {
  reset(); connect();
  await gcal.listExternalEvents({ days: 7 });
  const after = G.refreshes;
  await gcal.createEvent({ ref: 'WPH-2', date: '2030-01-02', time: '09:00', pickup: 'A', destination: 'B' });
  assert.strictEqual(G.refreshes, after, 'the second call reuses the token the first one minted');
});

test('an expiry that has genuinely passed refreshes BEFORE the call', async () => {
  reset();
  connect({ access_token: 'access-1', expires_in: -10 });   // already expired
  await gcal.listExternalEvents({ days: 7 });
  assert.strictEqual(G.refreshes, 1, 'refreshed pre-emptively');
  assert.ok(G.calls.every(c => c.bearer !== 'access-1'), 'the expired token was never sent');
});

// ── 2. THE ONE CASE WHERE RECONNECTING IS THE REAL ANSWER ────────────────
console.log('\nA revoked grant is named, not hidden');

test('invalid_grant marks needs_reconnect and the status stops claiming connected', async () => {
  reset(); connect(); G.revoked = true;
  await assert.rejects(() => gcal.listExternalEvents({ days: 7 }),
    'a dead grant must NOT come back as an empty diary');
  const st = gcal.getStatus();
  assert.strictEqual(st.needsReconnect, true, 'the owner must be told to reconnect');
  assert.strictEqual(st.connected, false, 'and "connected" must stop being a lie');
});

test('a 401 that SURVIVES the retry is raised, never returned as "no events"', async () => {
  // The refresh works, but Google still refuses the call — scope pulled for
  // Calendar, account suspended. Returning [] here is precisely how the outage
  // disguised itself as a free diary for as long as it did.
  reset(); connect();
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return realFetch(url, opts);
    return { ok: false, status: 401, json: async () => ({ error: { code: 401, message: 'Invalid Credentials' } }),
             text: async () => '{}' };
  };
  let threw = null;
  try { await gcal.listExternalEvents({ days: 7 }); } catch (e) { threw = e; }
  global.fetch = realFetch;
  assert.ok(threw, 'it must NOT come back as an empty list');
  assert.strictEqual(threw.needsReconnect, true, 'and it must be flagged as an auth problem');
  assert.ok(G.refreshes >= 1, 'having genuinely tried a fresh token first');
});

test('a TRANSIENT refresh failure does not nag the owner to reconnect', async () => {
  reset(); connect();
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return { ok: false, status: 503, json: async () => ({ error: 'backendError' }) };
    }
    return realFetch(url, opts);
  };
  try { await gcal.listExternalEvents({ days: 7 }); } catch (_) {}
  global.fetch = realFetch;
  assert.strictEqual(gcal.getStatus().needsReconnect, false,
    'a Google outage is not a revoked grant — do not send him round the reconnect loop');
});

test('a successful refresh RETRACTS a previous reconnect warning', async () => {
  reset(); connect();
  gcal.markNeedsReconnect(1);
  await gcal.listExternalEvents({ days: 7 });
  assert.strictEqual(gcal.getStatus().needsReconnect, false, 'it works again — clear the alarm');
  assert.strictEqual(gcal.getStatus().connected, true);
});

// ── 3. THE GRANT MUST ISSUE A REFRESH TOKEN AT ALL ───────────────────────
console.log('\nThe consent screen asks for offline access');

test('the auth URL requests offline access with an explicit consent prompt', () => {
  const url = gcal.buildAuthUrl('state123');
  const q = new URL(url).searchParams;
  assert.strictEqual(q.get('access_type'), 'offline',
    'without access_type=offline Google issues NO refresh token, and every hour is a reconnect');
  assert.strictEqual(q.get('prompt'), 'consent',
    'without prompt=consent Google withholds the refresh token on re-consent');
  assert.ok(/calendar/.test(q.get('scope') || ''), 'and the calendar scope must be asked for');
});

test('a refresh never overwrites the stored refresh token with nothing', () => {
  reset(); connect();
  const before = gcal.loadTokens().refresh_token;
  gcal.saveTokens({ access_token: 'access-9', expires_in: 3600 });   // a refresh, no refresh_token
  assert.strictEqual(gcal.loadTokens().refresh_token, before,
    'COALESCE must protect it — losing it here would force a reconnect every hour');
});

// ── 4. NO PATH MAY GO ROUND THE CHOKE POINT ──────────────────────────────
console.log('\nOne door to Google');

test('every Google call goes through googleFetch', () => {
  for (const rel of ['server/google-calendar.js', 'server/google-routes.js', 'server/gmail.js']) {
    const src = read(rel);
    // fetchUserEmail runs during the OAuth exchange with a token handed to it
    // directly — it has no stored credentials to refresh, so it is exempt.
    const raw = src.split('\n').filter((l) =>
      /Authorization['"]?\s*:\s*['"]Bearer/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    const allowed = rel === 'server/google-calendar.js' ? 2 : 0;   // fetchUserEmail + googleFetch itself
    assert.ok(raw.length <= allowed,
      rel + ' attaches a bearer outside googleFetch (' + raw.length + ' place(s)) — that path cannot self-heal');
  }
});

test('the read route reports a dead grant instead of an empty week', () => {
  const src = read('server/google-routes.js');
  assert.ok(/needsReconnect[\s\S]{0,160}reason: 'needs_reconnect'/.test(src),
    '/external-events must distinguish "reconnect" from "nothing on"');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/google-token-refresh\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
