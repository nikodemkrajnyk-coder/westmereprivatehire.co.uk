// ── Server-Sent Events broker ────────────────────────────────────────────
// Lightweight in-memory pub/sub for staff apps (admin, owner, driver).
// Each connected browser keeps a long-lived GET to /api/events open, and
// receives JSON-encoded events whenever the server emits one (new booking,
// intake decision, driver assigned, etc.).
//
// Why SSE not WebSockets:
//   - Pure HTTP, sails through Railway's proxy with zero config
//   - Auto-reconnects in the browser
//   - One-way (server → client) is exactly what we need
//
// Audience filtering:
//   broadcast(eventName, payload, audience)
//     audience.roles      — array, e.g. ['admin','owner']  (default: all staff)
//     audience.driverId   — number, deliver only to this driver session
//
// Drivers see only events that concern their own jobs, plus generic
// "booking_created" so the bell rings when a new request arrives.

const STAFF_ROLES = ['admin', 'owner', 'driver'];

// Each client: { id, res, role, userId }
const clients = new Set();
let _nextId = 1;

function addClient(req, res) {
  const role = req.auth && req.auth.role;
  const userId = req.auth && req.auth.id;
  if (!STAFF_ROLES.includes(role)) {
    res.status(403).end();
    return null;
  }

  // SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'      // disable proxy buffering on nginx-like layers
  });
  res.flushHeaders && res.flushHeaders();

  const client = { id: _nextId++, res, role, userId };
  clients.add(client);

  // Initial hello so the browser knows the pipe is live
  write(res, 'hello', { ok: true, role, at: Date.now() });

  // Keep-alive comment every 25s — proxies often kill idle connections at 30s
  const ka = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) { /* gone */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ka);
    clients.delete(client);
  });

  return client;
}

function write(res, event, payload) {
  try {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  } catch (e) {
    // Client likely disconnected; ignore.
  }
}

// Broadcast an event. audience is optional; defaults to all staff.
function broadcast(event, payload, audience) {
  const opts = audience || {};
  const roles = opts.roles || STAFF_ROLES;
  const driverId = opts.driverId || null;
  const enriched = Object.assign({ at: Date.now() }, payload || {});

  for (const c of clients) {
    if (!roles.includes(c.role)) continue;
    // Drivers: only deliver if the event is generic OR explicitly for them
    if (c.role === 'driver') {
      if (driverId != null && c.userId !== driverId) continue;
    }
    write(c.res, event, enriched);
  }
}

function clientCount() { return clients.size; }

module.exports = { addClient, broadcast, clientCount };
