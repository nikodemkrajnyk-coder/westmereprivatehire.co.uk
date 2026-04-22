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
    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system,
        messages: messages.slice(-16)
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

TASK: Read the image and extract any private hire / taxi booking details.

The image may be a screenshot of a WhatsApp message, email, text message, booking form, or handwritten note.

Extract these fields if present:
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
1. A brief 1-2 sentence summary of what you found
2. The extracted data as JSON inside <<<BOOKING>>> and <<<END>>> markers

Format exactly like this:
I found a booking from [name] going to [destination] on [date].

<<<BOOKING>>>
{"name":"...","phone":"...","email":null,"pickup":"...","destination":"...","date":"YYYY-MM-DD","time":"HH:MM","passengers":1,"flight":null,"fare":0,"payment":"cash","notes":null}
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
        max_tokens: 800,
        system: scanSystem,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: 'Please extract the booking details from this image.' }
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

    // Try to parse the booking JSON out of the response
    const match = reply.match(/<<<BOOKING>>>([\s\S]*?)<<<END>>>/);
    let booking = null;
    if (match) {
      try { booking = JSON.parse(match[1].trim()); } catch (_) {}
    }

    res.json({ ok: true, reply, booking });
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
