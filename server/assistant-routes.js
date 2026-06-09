const express = require('express');
const { getDb } = require('./db');
const gcal = require('./google-calendar');
const { deadMilesFee } = require('./dead-miles');

const router = express.Router();

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Two tiers to keep token costs down: Haiku handles simple lookups (fares,
// calendar checks, vehicle status), Sonnet handles complex work (reading
// screenshots, building invoices). MODEL is kept as the complex default for
// the vision/scan path which always needs the stronger model.
const MODEL_COMPLEX = process.env.ASSISTANT_MODEL || 'claude-sonnet-4-6';
const MODEL_SIMPLE  = process.env.ASSISTANT_MODEL_SIMPLE || 'claude-haiku-4-5-20251001';
const MODEL = MODEL_COMPLEX;
const API_URL = 'https://api.anthropic.com/v1/messages';

// Pick the cheapest model that can handle the conversation. Anything with an
// image, or an explicit complex intent (invoicing, extracting from a message),
// goes to Sonnet; everything else (fare quotes, calendar/vehicle checks) to Haiku.
function pickChatModel(messages) {
  const hasImage = (messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b && b.type === 'image'));
  if (hasImage) return MODEL_COMPLEX;
  const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
  let text = '';
  if (lastUser) {
    if (typeof lastUser.content === 'string') text = lastUser.content;
    else if (Array.isArray(lastUser.content)) {
      text = lastUser.content.map(b => (b && b.text) || '').join(' ');
    }
  }
  return /invoice|screenshot|scan|extract|statement|reconcile/i.test(text)
    ? MODEL_COMPLEX : MODEL_SIMPLE;
}

// In-memory cache for repeated fare quotes (5-minute TTL). Fare lookups are
// pure functions of pickup/destination/time, so identical queries within a
// few minutes can skip both the routing call and the model round-trip.
const FARE_CACHE = new Map();
const FARE_CACHE_TTL = 5 * 60 * 1000;
function fareCacheGet(key) {
  const hit = FARE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > FARE_CACHE_TTL) { FARE_CACHE.delete(key); return null; }
  return hit.v;
}
function fareCacheSet(key, value) {
  FARE_CACHE.set(key, { v: value, t: Date.now() });
  // Bound the cache so it can't grow without limit.
  if (FARE_CACHE.size > 200) {
    const oldest = FARE_CACHE.keys().next().value;
    FARE_CACHE.delete(oldest);
  }
}

const REFERENCE_FARES = [
  'Brighton/Hove/Saltdean/Rottingdean→Gatwick £114 (ret £111), →Heathrow £159 (ret £163), →Stansted £243 (ret £248), →Luton £228 (ret £233), →Southampton £178 (ret £174), →London City £195 (ret £199)',
  'Lewes→Gatwick £116 (ret £113), →Heathrow £166 (ret £171), →Stansted £249 (ret £254), →Luton £234 (ret £239), →Southampton £182 (ret £178), →London City £200 (ret £204)',
  'Horsham→Gatwick £69 (ret £66), →Heathrow £122 (ret £127), →Stansted £182 (ret £187), →Luton £154 (ret £158), →Southampton £134 (ret £130), →London City £160 (ret £165)',
  'Crawley→Gatwick £56 (ret £54), →Heathrow £105 (ret £109)',
  'Worthing/Lancing/Shoreham→Gatwick £108 (ret £105), →Heathrow £155 (ret £159)',
  'Haywards Heath→Gatwick £81 (ret £78), Burgess Hill→Gatwick £81 (ret £77)',
  'Eastbourne→Gatwick £153 (ret £150), →Heathrow £205 (ret £210)',
  'Seaford→Gatwick £138 (ret £135), Uckfield→Gatwick £93 (ret £89), East Grinstead→Gatwick £78 (ret £74)',
  'All fares are all-inclusive — airport charges, dead miles and road tolls included'
].join('\n');

// ── Fare engine ──────────────────────────────────────────────────────────
// The pricing logic lives in ./fare-engine.js (shared with public-api.js so
// the AI assistant and the public booking flow quote identical fares).
const { calculateFare, _fareGeocode, _fareRoute } = require('./fare-engine');

// ── Tool definitions ─────────────────────────────────────────────────────
const CHECK_VEHICLE_TOOL = {
  name: 'check_vehicle',
  description: 'Check the Tesla vehicle status — battery level, estimated range in miles, charging state, and odometer. Use this when the driver asks about the car charge, range, or whether they can make it to a destination. If a destination is provided, also calculate the route distance and compare to available range.',
  input_schema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Optional destination to check range against (e.g. "Heathrow Airport"). If provided, will calculate route distance and compare to battery range.' }
    }
  }
};

const CALCULATE_FARE_TOOL = {
  name: 'calculate_fare',
  description: 'Calculate the fare for a journey between two locations using the Westmere fare engine. Checks fixed airport fares first (Gatwick, Heathrow, Stansted, Luton, Southampton, London City), then falls back to tapered per-mile calculation via OSRM routing. Use this whenever the driver asks for a price/quote/fare.',
  input_schema: {
    type: 'object',
    properties: {
      pickup:      { type: 'string', description: 'Pickup address or location name' },
      destination: { type: 'string', description: 'Destination address or location name' },
      time:        { type: 'string', description: 'Journey time in HH:MM 24h format. Used to determine day/night rate. Omit to use current time.' }
    },
    required: ['pickup', 'destination']
  }
};

const CREATE_INVOICE_TOOL = {
  name: 'create_invoice',
  description: 'Create a bespoke invoice for a recipient. Use this when the user asks to create an invoice for a person or company, or mentions billing details, amounts owed, or line items.',
  input_schema: {
    type: 'object',
    properties: {
      recipient_name:    { type: 'string',  description: 'Full name or company name of invoice recipient' },
      recipient_email:   { type: 'string',  description: 'Recipient email address' },
      recipient_address: { type: 'string',  description: 'Recipient postal address' },
      items: {
        type: 'array',
        description: 'Line items on the invoice. Each item can be from a different date — include the date so it appears on the invoice. For multi-job invoices, add one item per job.',
        items: {
          type: 'object',
          properties: {
            date:        { type: 'string', description: 'Date of the job in YYYY-MM-DD format (optional but recommended)' },
            description: { type: 'string', description: 'Description of the service or item, e.g. "Horsham → Gatwick"' },
            amount:      { type: 'number', description: 'Unit price in GBP' },
            quantity:    { type: 'number', description: 'Quantity (default 1)' }
          },
          required: ['description', 'amount']
        }
      },
      notes:    { type: 'string', description: 'Additional notes shown on the invoice' }
    },
    required: ['recipient_name', 'items']
  }
};

const SEARCH_BOOKINGS_TOOL = {
  name: 'search_bookings',
  description: 'Search the Westmere bookings database by date, time, customer name, pickup or destination. Use this to find a past or upcoming job so you can pull the fare, customer details, and route for invoicing or answering questions.',
  input_schema: {
    type: 'object',
    properties: {
      date:        { type: 'string', description: 'Date in YYYY-MM-DD format' },
      time:        { type: 'string', description: 'Approximate time in HH:MM — matches within ±1 hour' },
      customer:    { type: 'string', description: 'Customer or passenger name to search for (partial match)' },
      pickup:      { type: 'string', description: 'Pickup address keyword to search for' },
      destination: { type: 'string', description: 'Destination keyword to search for' }
    }
  }
};

const CALENDAR_TOOLS = [
  {
    name: 'list_calendar_events',
    description: 'List Google Calendar events — past OR future. Use start_date/end_date to look up a specific date or range (e.g. a past job). Use days for a rolling forward window. If the user mentions a specific past date, always use start_date and end_date.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format. Use this to look up events on or after a specific date (including past dates).' },
        end_date:   { type: 'string', description: 'End date in YYYY-MM-DD format. Use together with start_date.' },
        days:       { type: 'number', description: 'Alternative to start_date/end_date: look N days ahead from today (default 14, max 60). Do NOT use this for past dates.' }
      }
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new Google Calendar event (block-out time, personal appointment, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        title:        { type: 'string', description: 'Event title' },
        date:         { type: 'string', description: 'Date in YYYY-MM-DD' },
        time:         { type: 'string', description: 'Start time in HH:MM (omit for all-day event)' },
        duration_min: { type: 'number', description: 'Duration in minutes (default 60)' },
        location:     { type: 'string', description: 'Location or address' },
        notes:        { type: 'string', description: 'Additional notes or description' }
      },
      required: ['title', 'date']
    }
  },
  {
    name: 'update_calendar_event',
    description: 'Update an existing Google Calendar event. You must first call list_calendar_events to get the event ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:     { type: 'string', description: 'Google Calendar event ID (from list_calendar_events)' },
        title:        { type: 'string', description: 'New title (leave out to keep existing)' },
        date:         { type: 'string', description: 'New date in YYYY-MM-DD' },
        time:         { type: 'string', description: 'New start time in HH:MM' },
        duration_min: { type: 'number', description: 'New duration in minutes' },
        location:     { type: 'string', description: 'New location' },
        notes:        { type: 'string', description: 'New notes' }
      },
      required: ['event_id']
    }
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a Google Calendar event by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Google Calendar event ID (from list_calendar_events)' }
      },
      required: ['event_id']
    }
  }
];

async function executeCalendarTool(name, input) {
  switch (name) {
    case 'check_vehicle': {
      try {
        // Get Tesla status from DB directly (no HTTP round-trip needed server-side)
        const { getDb: _gdb } = require('./db');
        const teslaRow = _gdb().prepare("SELECT * FROM integrations WHERE provider='tesla'").get();
        if (!teslaRow || !teslaRow.access_token) {
          return 'Tesla not connected. The driver has not linked their Tesla account yet.';
        }

        // Re-use tesla-routes token logic inline
        const nowSec = Math.floor(Date.now() / 1000);
        let accessToken = teslaRow.access_token;
        if (teslaRow.expires_at && teslaRow.expires_at - nowSec < 300 && teslaRow.refresh_token) {
          const rb = new URLSearchParams({ grant_type:'refresh_token', client_id:process.env.TESLA_CLIENT_ID||'', client_secret:process.env.TESLA_CLIENT_SECRET||'', refresh_token:teslaRow.refresh_token });
          const rr = await fetch('https://auth.tesla.com/oauth2/v3/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:rb.toString() });
          if (rr.ok) { const rt = await rr.json(); accessToken = rt.access_token; }
        }

        const TESLA_BASE = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
        const listR = await fetch(TESLA_BASE + '/api/1/vehicles', { headers: { Authorization: 'Bearer ' + accessToken } });
        if (!listR.ok) return 'Could not reach Tesla API (HTTP ' + listR.status + ')';
        const listD = await listR.json();
        const vehicles = listD.response || [];
        if (!vehicles.length) return 'No vehicles found on the Tesla account.';

        const vid = vehicles[0].id;
        let vd = null;
        try {
          const vr = await fetch(`${TESLA_BASE}/api/1/vehicles/${vid}/vehicle_data?endpoints=charge_state%3Bdrive_state%3Bvehicle_state`, { headers: { Authorization: 'Bearer ' + accessToken } });
          if (vr.ok) vd = (await vr.json()).response;
        } catch (_) {}

        if (!vd) {
          const state = vehicles[0].state || 'unknown';
          return `Tesla is ${state}. Could not retrieve live data — car may be asleep. Last known charge unavailable.`;
        }

        const charge = vd.charge_state || {};
        const battPct   = charge.battery_level ?? null;
        const rangeMi   = charge.battery_range != null ? Math.round(charge.battery_range) : null;
        const chargeSt  = charge.charging_state ?? 'Unknown';
        const odo       = (vd.vehicle_state || {}).odometer != null ? Math.round(vd.vehicle_state.odometer) : null;

        let summary = `Tesla ${vehicles[0].display_name || 'Model S'}: `;
        summary += battPct != null ? `${battPct}% battery` : 'battery unknown';
        summary += rangeMi != null ? `, ~${rangeMi} miles range` : '';
        summary += `, ${chargeSt}`;
        if (odo) summary += `, odometer ${odo.toLocaleString()} mi`;

        // If destination provided, check if range is sufficient
        if (input.destination && rangeMi != null) {
          try {
            const gc = await _fareGeocode(input.destination);
            // Use driver home coords as rough origin (Horsham area)
            const HOME = { lat: 51.0632, lon: -0.3234 };
            if (gc) {
              const rt = await _fareRoute(HOME.lat, HOME.lon, gc.lat, gc.lon);
              if (rt) {
                const distMi = Math.round(rt.distance / 1609.34);
                const margin = rangeMi - distMi;
                summary += `. Route to ${input.destination}: ~${distMi} miles.`;
                if (margin > 20) summary += ` Range is sufficient — ${margin} miles to spare.`;
                else if (margin > 0) summary += ` Range is tight — only ${margin} miles to spare. Consider charging first.`;
                else summary += ` RANGE INSUFFICIENT — ${Math.abs(margin)} miles short. Charge before this trip.`;
              }
            }
          } catch (_) {}
        }

        return summary;
      } catch (e) {
        return 'Vehicle check error: ' + e.message;
      }
    }
    case 'calculate_fare': {
      try {
        // Serve repeated identical fare queries from the 5-minute cache.
        const cacheKey = [
          (input.pickup || '').trim().toLowerCase(),
          (input.destination || '').trim().toLowerCase(),
          (input.time || '').trim()
        ].join('|');
        const cached = fareCacheGet(cacheKey);
        if (cached) return cached;

        const result = await calculateFare(input.pickup, input.destination, input.time || null);
        const mi = result.distance_miles != null ? result.distance_miles + ' miles' : 'distance unknown';
        const ti = result.duration_min != null ? '~' + result.duration_min + ' min' : 'duration unknown';

        // Dead miles: always from Horsham home base → pickup. First 5 miles are
        // free; beyond that the rate is TIERED to keep long collections fair:
        //   • next 20 chargeable miles @ £1.50/mi
        //   • everything above that  @ £1.00/mi
        let deadNote = '';
        try {
          const driverLat = 51.0632;
          const driverLng = -0.3254;
          const pickupGc = await _fareGeocode(input.pickup);
          if (pickupGc) {
            const rt = await _fareRoute(driverLat, driverLng, pickupGc.lat, pickupGc.lon);
            if (rt) {
              const deadMi = Math.round(rt.distance / 1609.34 * 10) / 10;
              const dm = deadMilesFee(deadMi);
              if (dm.fee > 0) {
                const total = parseFloat((result.fare + dm.fee).toFixed(2));
                deadNote = ` | Dead miles: ${deadMi.toFixed(1)} mi (${dm.freeMi} mi free → ${dm.chargeableMi.toFixed(1)} mi: ${dm.breakdown} = +£${dm.fee.toFixed(2)}) | Total inc. collection: £${total}`;
              } else {
                deadNote = ` | Dead miles: ${deadMi.toFixed(1)} mi (within ${dm.freeMi} mi free — no charge)`;
              }
            }
          }
        } catch (dmErr) { deadNote = ' | Dead miles: unavailable'; }

        const out = `Fare: £${result.fare} | ${mi} | ${ti} | Rate: ${result.rate_type} | ${result.breakdown}${deadNote}`;
        fareCacheSet(cacheKey, out);
        return out;
      } catch (e) {
        return 'Fare calculation error: ' + e.message;
      }
    }
    case 'search_bookings': {
      const db = getDb();
      const conditions = [];
      const params = [];

      if (input.date) {
        conditions.push('b.date = ?');
        params.push(input.date);
      }
      if (input.customer) {
        conditions.push('(LOWER(COALESCE(c.full_name, b.passenger_name, \'\')) LIKE ? OR LOWER(b.notes) LIKE ?)');
        const q = '%' + input.customer.toLowerCase() + '%';
        params.push(q, q);
      }
      if (input.pickup) {
        conditions.push('LOWER(b.pickup) LIKE ?');
        params.push('%' + input.pickup.toLowerCase() + '%');
      }
      if (input.destination) {
        conditions.push('LOWER(b.destination) LIKE ?');
        params.push('%' + input.destination.toLowerCase() + '%');
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const rows = db.prepare(`
        SELECT b.id, b.ref, b.date, b.time, b.pickup, b.destination, b.fare, b.payment,
               b.passengers, b.flight, b.notes, b.status,
               COALESCE(c.full_name, b.passenger_name) AS customer_name,
               COALESCE(c.email, b.passenger_email) AS customer_email,
               COALESCE(c.phone, b.passenger_phone) AS customer_phone
        FROM bookings b
        LEFT JOIN customers c ON b.customer_id = c.id
        ${where}
        ORDER BY b.date DESC, b.time DESC
        LIMIT 10
      `).all(...params);

      if (!rows.length) return 'No bookings found matching those criteria.';

      // If a time was given, narrow to bookings within ±90 minutes
      let results = rows;
      if (input.time) {
        const [th, tm] = input.time.split(':').map(Number);
        const pivot = th * 60 + (tm || 0);
        results = rows.filter(r => {
          if (!r.time) return true;
          const [rh, rm] = r.time.split(':').map(Number);
          return Math.abs(rh * 60 + (rm || 0) - pivot) <= 90;
        });
        if (!results.length) results = rows; // fall back to all if none match window
      }

      return results.map(r =>
        `Ref:${r.ref} | ${r.date} ${r.time || ''} | ${r.customer_name || 'Unknown'} | ${r.pickup} → ${r.destination} | £${r.fare || '?'} | ${r.payment || 'cash'} | Status:${r.status}` +
        (r.customer_email ? ` | Email:${r.customer_email}` : '') +
        (r.customer_phone ? ` | Phone:${r.customer_phone}` : '') +
        (r.notes ? ` | Notes:${r.notes}` : '')
      ).join('\n');
    }
    case 'create_invoice': {
      const db = getDb();
      // Auto-fill missing recipient details from saved recipients
      if (input.recipient_name && (!input.recipient_email || !input.recipient_address)) {
        try {
          const saved = db.prepare(`
            SELECT * FROM invoice_recipients
            WHERE LOWER(name) LIKE ? OR LOWER(name) LIKE ?
            ORDER BY last_used_at DESC LIMIT 1
          `).get(
            '%' + input.recipient_name.toLowerCase() + '%',
            input.recipient_name.toLowerCase().split(' ')[0] + '%'
          );
          if (saved) {
            if (!input.recipient_email && saved.email) input = { ...input, recipient_email: saved.email };
            if (!input.recipient_address && saved.address) input = { ...input, recipient_address: saved.address };
            if (!input.recipient_name || input.recipient_name.length < saved.name.length) input = { ...input, recipient_name: saved.name };
          }
        } catch (e) { /* ignore */ }
      }
      const items = (input.items || []).map(it => ({
        date: it.date || null,
        description: it.description,
        amount: Number(it.amount) || 0,
        quantity: Number(it.quantity) || 1
      }));
      const total = items.reduce((s, it) => s + it.amount * it.quantity, 0);
      const today2 = new Date().toISOString().split('T')[0];
      const invoiceNo = 'INV-' + Date.now().toString(36).toUpperCase();
      try {
        db.prepare(`INSERT INTO invoices (invoice_no, kind, recipient_name, recipient_email, recipient_addr, line_items_json, total, notes, issued_date)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          invoiceNo, 'bespoke',
          input.recipient_name || '', input.recipient_email || null, input.recipient_address || null,
          JSON.stringify(items), total, input.notes || null, today2
        );
        const itemLines = items.map(it => `  • ${it.date ? it.date + ' — ' : ''}${it.description}${it.quantity > 1 ? ' ×' + it.quantity : ''}: £${(it.amount * it.quantity).toFixed(2)}`).join('\n');
        return `Invoice ${invoiceNo} created.\nRecipient: ${input.recipient_name}${input.recipient_email ? ' <' + input.recipient_email + '>' : ''}\nItems:\n${itemLines}\nTotal: £${total.toFixed(2)}`;
      } catch (e) {
        return 'Failed to create invoice: ' + e.message;
      }
    }
    case 'list_calendar_events': {
      let gcalOpts;
      if (input.start_date) {
        // Specific date range — works for past and future dates
        const from = input.start_date;
        const to   = input.end_date || input.start_date; // single day if no end_date
        gcalOpts = { from, to };
      } else {
        // Rolling forward window
        const days = Math.min(60, Math.max(1, input.days || 14));
        gcalOpts = { days };
      }
      const events = await gcal.listExternalEvents(gcalOpts);
      if (!events.length) return input.start_date
        ? `No calendar events found between ${input.start_date} and ${input.end_date || input.start_date}.`
        : 'No events found.';
      return events.map(e => {
        const fmtOpts = { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
        const start = e.allDay ? e.start : new Date(e.start).toLocaleString('en-GB', fmtOpts);
        const end = (!e.allDay && e.end) ? ' – ' + new Date(e.end).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
        let line = `ID:${e.id} | ${e.title} | ${start}${end}`;
        if (e.location) line += ` @ ${e.location}`;
        if (e.notes) line += `\n  Description: ${e.notes}`;
        return line;
      }).join('\n');
    }
    case 'create_calendar_event': {
      const event = {
        ref: '', customer_name: input.title, pickup: input.location || '',
        destination: '', date: input.date, time: input.time || null,
        duration_min: input.duration_min || 60, status: 'confirmed',
        notes: input.notes || '', id: 0
      };
      const eventId = await gcal.createEvent(event);
      if (eventId) return 'Event created successfully. ID: ' + eventId;
      return 'Failed to create event — Google Calendar may not be connected.';
    }
    case 'update_calendar_event': {
      const event = {
        ref: '', customer_name: input.title || '', pickup: input.location || '',
        destination: '', date: input.date || undefined, time: input.time || undefined,
        duration_min: input.duration_min || 60, status: 'confirmed',
        notes: input.notes || '', id: 0
      };
      const ok = await gcal.updateEvent(input.event_id, event);
      return ok ? 'Event updated successfully.' : 'Event not found or update failed.';
    }
    case 'delete_calendar_event': {
      const ok = await gcal.deleteEvent(input.event_id);
      return ok ? 'Event deleted successfully.' : 'Failed to delete event.';
    }
    default:
      return 'Unknown tool: ' + name;
  }
}

function buildSystemPrompt(todayJobs) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/London' });
  const jobsSummary = todayJobs.length
    ? todayJobs.map(j => `${j.time} ${j.customer_name || 'Guest'} ${j.pickup}→${j.destination} £${j.fare || '?'} ${j.payment || ''}`).join('\n')
    : 'No bookings today.';

  return `You are Westmere, the hands-free voice assistant for Westmere Private Hire (luxury chauffeur service, Sussex UK). The operator is driving.

RULES:
- Be extremely concise: one or two short sentences. Today is ${today}.
- BOOKINGS: extract all details the driver dictates. Ask only for missing required fields (pickup, destination, date, time, passenger name). When you have enough, output a one-line summary then a JSON block on its own line:
  <<<BOOKING>>>{ "name", "phone", "email", "pickup", "destination", "date" (YYYY-MM-DD), "time" (HH:MM), "passengers", "flight", "fare", "payment", "notes" }<<<END>>>
  Use null for unknown optional fields. payment defaults to "cash" (also: card, account, invoice). "tomorrow"/"next Monday"/"3pm" resolve relative to today.
- After a summary: "yes/confirm/book it" → output <<<CONFIRM>>> on its own line; "cancel/no" → <<<CANCEL>>>.
- FARES: ALWAYS use the calculate_fare tool, never guess. Day rate 06:00–21:59, night 22:00–05:59.
- TOOLS: calculate_fare (fare quotes), search_bookings (find jobs by date/time/name/route), create_invoice (to invoice a job, search_bookings first — or list_calendar_events if not found — then create_invoice from the fare/name/email/route), check_vehicle (Tesla charge/range/"can I make it to X"), and the Google Calendar tools (list/create/edit/delete events).

Today's schedule:
${jobsSummary}`;
}

router.post('/chat', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Assistant not configured — ANTHROPIC_API_KEY not set' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  const db = getDb();
  const todayStr = new Date().toISOString().split('T')[0];
  const todayJobs = db.prepare(`
    SELECT b.time, b.pickup, b.destination, b.fare, b.payment, b.flight,
           c.full_name as customer_name
    FROM bookings b
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.date = ? AND b.status IN ('confirmed','active')
    ORDER BY b.time ASC
  `).all(todayStr);

  const system = buildSystemPrompt(todayJobs);

  try {
    // Cap history at the last 10 messages to keep the prompt (and cost) small.
    let currentMessages = messages.slice(-10);
    // Choose model once per request: Haiku for simple lookups, Sonnet for
    // complex tasks (invoicing, anything with an image).
    const model = pickChatModel(currentMessages);
    let finalReply = '';
    const MAX_ITER = 5;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const apiRes = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 600,
          system,
          tools: [...CALENDAR_TOOLS, SEARCH_BOOKINGS_TOOL, CREATE_INVOICE_TOOL, CALCULATE_FARE_TOOL, CHECK_VEHICLE_TOOL],
          messages: currentMessages
        })
      });

      const data = await apiRes.json();
      if (!apiRes.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + apiRes.status);
        return res.status(502).json({ error: 'Claude API: ' + msg });
      }

      const content = data.content || [];
      const toolUseBlocks = content.filter(b => b.type === 'tool_use');

      // No tool calls — we have our final answer
      if (!toolUseBlocks.length || data.stop_reason === 'end_turn') {
        finalReply = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        break;
      }

      // Append assistant turn (with tool_use blocks)
      currentMessages = [...currentMessages, { role: 'assistant', content }];

      // Execute each tool in parallel
      const toolResults = await Promise.all(toolUseBlocks.map(async (tb) => {
        let result;
        try {
          result = await executeCalendarTool(tb.name, tb.input || {});
        } catch (e) {
          result = 'Tool error: ' + e.message;
        }
        return { type: 'tool_result', tool_use_id: tb.id, content: result };
      }));

      // Feed results back as a user turn
      currentMessages = [...currentMessages, { role: 'user', content: toolResults }];
    }

    res.json({ ok: true, reply: finalReply });
  } catch (e) {
    res.status(502).json({ error: 'Assistant unavailable: ' + e.message });
  }
});

// ── POST /api/assistant/scan — extract booking from image ────────────────
// Accepts a base64-encoded image and uses Claude vision to extract booking
// details, returning them as structured JSON inside <<<BOOKING>>>...<<<END>>>
router.post('/scan', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Assistant not configured' });

  const { image, media_type } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) required' });

  // Strip data URL prefix if present
  const base64 = image.replace(/^data:[^;]+;base64,/, '');
  const mimeType = media_type || (image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/London'
  });

  const scanSystem = `You are an extraction assistant for Westmere Private Hire, Sussex UK.
Today is ${today}.

TASK: Read the image and determine what it contains — it may be:
A) One or more private hire / taxi BOOKINGS (WhatsApp, text, email with trip details)
B) An INVOICE or BILLING REQUEST (email/letter requesting payment, listing services and amounts)
C) Both

── BOOKINGS ──
The image may be a screenshot of a WhatsApp conversation, email, text message, booking form, or handwritten note.

MULTIPLE BOOKING RULES:
- WhatsApp screenshots often contain multiple bookings — each message or exchange may be a separate booking.
- Look for different dates, times, passenger names, pickup/destination pairs, or visual separators.
- If a return journey is mentioned (e.g. "and can you pick up on the way back"), treat it as a SECOND booking.
- If one person is making a booking for multiple separate trips on different dates/times, extract each as its own booking.
- A single message with ONE set of pickup/destination/date/time is ONE booking.

For EACH booking extract:
- name (passenger full name)
- phone (UK mobile, e.g. 07700 900123)
- email
- pickup (full address or location)
- destination (full address or location)
- date (convert to YYYY-MM-DD — e.g. "22nd April" → "${new Date().getFullYear()}-04-22")
- time (HH:MM 24h — e.g. "3pm" → "15:00")
- passengers (number, default 1)
- flight (flight number if airport job, e.g. BA2490)
- fare (numeric — look up from reference table if route matches)
- payment (cash/card/account — default cash)
- notes (any special requests, luggage info, etc.)

Fixed airport fares (out/return):
${REFERENCE_FARES}

── INVOICE / BILLING ──
If the image contains billing information, invoice details, or a request to pay for services:
Extract: recipient name, email, address, line items (description, amount, quantity), notes, due date / payment terms.

OUTPUT FORMAT — include ONLY the blocks that apply:

For bookings (always use array format, even for one booking):
<<<BOOKINGS>>>
[{"name":"...","phone":"...","email":null,"pickup":"...","destination":"...","date":"YYYY-MM-DD","time":"HH:MM","passengers":1,"flight":null,"fare":0,"payment":"cash","notes":null}]
<<<END>>>

For invoice/billing:
<<<INVOICE>>>
{"recipient":{"name":"...","email":"...","address":"..."},"items":[{"description":"...","amount":0,"quantity":1}],"notes":"..."}
<<<END_INVOICE>>>

Start your response with a brief one-line summary of what you found.
If nothing relevant is found, say so clearly without any JSON blocks.
Use null for any field you cannot determine.`;

  try {
    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // Screenshot extraction is a complex vision task — keep the strong model.
        model: MODEL_COMPLEX,
        max_tokens: 1200,
        system: scanSystem,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: 'Please extract ALL booking details from this image.' }
          ]
        }]
      })
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + apiRes.status);
      return res.status(502).json({ error: 'Claude API: ' + msg });
    }

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Parse bookings — support new <<<BOOKINGS>>> array format and legacy <<<BOOKING>>> single object
    let bookings = [];
    const arrayMatch = reply.match(/<<<BOOKINGS>>>([\s\S]*?)<<<END>>>/);
    const singleMatch = reply.match(/<<<BOOKING>>>([\s\S]*?)<<<END>>>/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[1].trim());
        bookings = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {}
    } else if (singleMatch) {
      try { bookings = [JSON.parse(singleMatch[1].trim())]; } catch (_) {}
    }

    // Parse invoice block
    let invoice = null;
    const invoiceMatch = reply.match(/<<<INVOICE>>>([\s\S]*?)<<<END_INVOICE>>>/);
    if (invoiceMatch) {
      try { invoice = JSON.parse(invoiceMatch[1].trim()); } catch (_) {}
    }

    // Strip all marker blocks from the reply text shown to the user
    const cleanReply = reply
      .replace(/<<<BOOKINGS>>>[\s\S]*?<<<END>>>/g, '')
      .replace(/<<<BOOKING>>>[\s\S]*?<<<END>>>/g, '')
      .replace(/<<<INVOICE>>>[\s\S]*?<<<END_INVOICE>>>/g, '')
      .trim();

    res.json({
      ok: true,
      reply: cleanReply,
      bookings,                       // always an array
      booking: bookings[0] || null,   // backwards compat for old frontend code
      invoice                         // invoice object or null
    });
  } catch (e) {
    res.status(502).json({ error: 'Scan unavailable: ' + e.message });
  }
});

router.post('/analyse', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Assistant not configured' });

  const { system, prompt, max_tokens, complex } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // Default to the cheap model; callers can opt into Sonnet with complex:true.
        model: complex ? MODEL_COMPLEX : MODEL_SIMPLE,
        max_tokens: Math.min(max_tokens || 300, 1024),
        system: system || undefined,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + apiRes.status);
      return res.status(502).json({ error: 'Claude API: ' + msg });
    }

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    res.json({ ok: true, reply });
  } catch (e) {
    res.status(502).json({ error: 'Assistant unavailable' });
  }
});

// Calendar event management (W assistant can create/update/delete events)
router.post('/calendar/create', async (req, res) => {
  const { title, date, time, duration, location, notes } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'title and date required' });
  try {
    const event = {
      ref: '', customer_name: title, pickup: location || '',
      destination: '', date, time: time || null,
      duration_min: duration || 60, status: 'confirmed',
      notes: notes || '', id: 0
    };
    const eventId = await gcal.createEvent(event);
    if (eventId) {
      res.json({ ok: true, eventId });
    } else {
      res.status(502).json({ error: 'Calendar not connected or event creation failed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/calendar/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const { title, date, time, duration, location, notes } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  try {
    const event = {
      ref: '', customer_name: title || '', pickup: location || '',
      destination: '', date: date || undefined, time: time || undefined,
      duration_min: duration || 60, status: 'confirmed',
      notes: notes || '', id: 0
    };
    const ok = await gcal.updateEvent(eventId, event);
    if (ok) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Event not found or update failed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/calendar/:eventId', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  try {
    const ok = await gcal.deleteEvent(eventId);
    res.json({ ok: !!ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
