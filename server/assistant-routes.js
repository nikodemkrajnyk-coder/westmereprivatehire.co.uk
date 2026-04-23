const express = require('express');
const { getDb } = require('./db');
const gcal = require('./google-calendar');

const router = express.Router();

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

const REFERENCE_FARES = [
  'Brighton→Gatwick £72/£68, Brighton→Heathrow £128/£133, Brighton→Stansted £215/£220, Brighton→Luton £205/£210, Brighton→Southampton £152/£147, Brighton→City £166/£171',
  'Lewes→Gatwick £78/£74, Lewes→Heathrow £140/£145, Lewes→Stansted £225/£230, Lewes→Luton £215/£220',
  'Horsham→Gatwick £55/£50, Horsham→Heathrow £120/£125',
  'Crawley→Gatwick £35/£32, Crawley→Heathrow £95/£100',
  'Worthing→Gatwick £72/£68, Worthing→Heathrow £130/£135',
  'Haywards Heath→Gatwick £52/£48, Burgess Hill→Gatwick £48/£44',
  'Eastbourne→Gatwick £98/£94, Eastbourne→Heathrow £162/£167',
  'Seaford→Gatwick £92/£88, Uckfield→Gatwick £62/£58, East Grinstead→Gatwick £42/£38',
  'Outside town centre: nearest town price + £2.50/extra mile'
].join('\n');

// ── Google Calendar tool definitions ─────────────────────────────────────
const CALENDAR_TOOLS = [
  {
    name: 'list_calendar_events',
    description: 'List upcoming Google Calendar events to check the schedule or find event IDs for editing/deletion.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (default 14, max 60)' }
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
    case 'list_calendar_events': {
      const days = Math.min(60, Math.max(1, input.days || 14));
      const events = await gcal.listExternalEvents({ days });
      if (!events.length) return 'No upcoming events found in the next ' + days + ' days.';
      return events.map(e => {
        const start = e.allDay ? e.start : new Date(e.start).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `ID:${e.id} | ${e.title} | ${start}${e.location ? ' @ ' + e.location : ''}`;
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

  return `You are Westmere, the voice assistant for Westmere Private Hire — a luxury chauffeur service in Sussex, UK. The operator is driving and dictating to you hands-free.

RULES:
- Be extremely concise. One or two short sentences max. The driver is on the road.
- Today is ${today}.
- When the driver dictates booking details (from a message, WhatsApp, phone call etc.), extract all details you can.
- Ask for any MISSING required fields: pickup, destination, date, time, passenger name. Phone/email are optional but useful.
- When you believe you have enough details for a booking, output a confirmation summary followed by a JSON block on a new line starting with <<<BOOKING>>> and ending with <<<END>>>
- The JSON must contain: { "name", "phone", "email", "pickup", "destination", "date" (YYYY-MM-DD), "time" (HH:MM), "passengers", "flight", "fare", "payment", "notes" }
- Use null for unknown optional fields. For fare, look up from the reference table if the route matches.
- If the driver says "yes", "confirm", "book it", "go ahead" after seeing a summary, output <<<CONFIRM>>> on its own line.
- If driver says "cancel", "no", "forget it", output <<<CANCEL>>> on its own line.
- For general questions (fare quotes, schedule, etc.), just answer directly.
- "payment" should default to "cash" unless stated otherwise. Options: cash, card, account, invoice.
- Dates: "tomorrow" = tomorrow's date, "next Monday" = compute from today, etc.
- If driver says just a time like "3pm", assume today's date.
- You can manage the Google Calendar: list upcoming events, create block-outs or appointments, edit or delete events. Use the calendar tools when asked.

Fixed fares (drop-off / return):
${REFERENCE_FARES}

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
    // Agentic loop — handles calendar tool calls, max 5 iterations
    let currentMessages = messages.slice(-16);
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
          model: MODEL,
          max_tokens: 1000,
          system,
          tools: CALENDAR_TOOLS,
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

  const scanSystem = `You are a booking extraction assistant for Westmere Private Hire, Sussex UK.
Today is ${today}.

TASK: Read the image and extract ALL private hire / taxi booking details. There may be ONE or MULTIPLE bookings.

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

ALWAYS respond with:
1. A brief summary: "Found X booking(s): [one line per booking]"
2. ALL extracted bookings as a JSON array inside <<<BOOKINGS>>> and <<<END>>> markers

Format exactly like this (always use the array format, even for a single booking):
Found 2 bookings: James Smith to Gatwick on 14 May, return on 21 May.

<<<BOOKINGS>>>
[
  {"name":"James Smith","phone":"07700900123","email":null,"pickup":"14 High Street, Horsham","destination":"Gatwick Airport","date":"2025-05-14","time":"06:00","passengers":1,"flight":null,"fare":55,"payment":"cash","notes":null},
  {"name":"James Smith","phone":"07700900123","email":null,"pickup":"Gatwick Airport","destination":"14 High Street, Horsham","date":"2025-05-21","time":"13:30","passengers":1,"flight":"BA2490","fare":50,"payment":"cash","notes":"return leg"}
]
<<<END>>>

If no booking details are found, just say so clearly without the JSON block.
Use null for any field you cannot determine. For fare, use 0 if unknown.`;

  try {
    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
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

    // Strip the marker block from the reply text shown to the user
    const cleanReply = reply
      .replace(/<<<BOOKINGS>>>[\s\S]*?<<<END>>>/g, '')
      .replace(/<<<BOOKING>>>[\s\S]*?<<<END>>>/g, '')
      .trim();

    res.json({
      ok: true,
      reply: cleanReply,
      bookings,                       // always an array
      booking: bookings[0] || null    // backwards compat for old frontend code
    });
  } catch (e) {
    res.status(502).json({ error: 'Scan unavailable: ' + e.message });
  }
});

router.post('/analyse', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Assistant not configured' });

  const { system, prompt, max_tokens } = req.body;
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
        model: MODEL,
        max_tokens: Math.min(max_tokens || 300, 2000),
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
