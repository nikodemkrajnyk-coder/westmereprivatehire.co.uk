// ── Driver calendar subscription feed ───────────────────────────────────
// Public endpoint — no auth cookie needed. Protected by the driver's unique
// calendar_token (a random UUID stored in users.calendar_token).
//
// URL: GET /api/driver/cal/:token.ics
//
// Drivers subscribe using the webcal:// protocol on their iPhone/Android:
//   webcal://westmereprivatehire.co.uk/api/driver/cal/TOKEN.ics
// Apple Calendar, Google Calendar, and Outlook all support webcal:// URLs.
// The calendar app fetches the feed on a schedule (typically every few hours)
// so changes appear automatically.

const express = require('express');
const { getDb } = require('./db');

const router = express.Router();

// ── Address shortening (airport-aware) — keeps SUMMARY lines readable ──────
const _SKIP_ADDR = /^(england|scotland|wales|northern ireland|united kingdom|uk|gb|great britain|west sussex|east sussex|sussex|surrey|kent|hampshire|hants|essex|berkshire|berks|london|greater london)$/i;
const _POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i;
const _AIRPORTS = [
  [/gatwick/i, 'Gatwick'], [/heathrow/i, 'Heathrow'], [/stansted/i, 'Stansted'],
  [/luton/i, 'Luton'], [/\bcity airport\b|london city/i, 'London City'],
  [/southampton airport/i, 'Southampton'], [/\bbristol airport\b/i, 'Bristol'],
  [/st pancras|kings cross|king's cross/i, 'St Pancras'],
  [/\beuston\b/i, 'Euston'], [/\bvictoria station\b/i, 'Victoria']
];
function _tinyAddr(a) {
  if (!a) return '';
  for (const [re, name] of _AIRPORTS) if (re.test(a)) return name;
  const parts = String(a).split(',').map(p => p.trim()).filter(Boolean)
    .filter(p => !_SKIP_ADDR.test(p) && !_POSTCODE.test(p));
  if (!parts.length) return String(a).split(',')[0].trim().slice(0, 24);
  // First meaningful part = the town/place the customer entered; the
  // administrative district (e.g. "Tandridge", "Mid Sussex") is appended
  // AFTER the town, so never use the last part. Skip a leading house number.
  const idx = (parts.length > 1 && /^\d+[a-z]?$/i.test(parts[0])) ? 1 : 0;
  return parts[idx].slice(0, 24);
}

// Escape text for iCalendar DESCRIPTION / SUMMARY (RFC 5545 §3.3.11)
// Commas, semicolons and backslashes must be escaped; newlines become \n
function icsEscape(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold long lines per RFC 5545 §3.1 (max 75 octets per line, indent with space)
function foldLine(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  chunks.push(line.slice(0, 75));
  let pos = 75;
  while (pos < line.length) {
    chunks.push(' ' + line.slice(pos, pos + 74));
    pos += 74;
  }
  return chunks.join('\r\n');
}

// Format a JS Date as an iCalendar datetime string in UTC
function toIcsDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

// Stable UID for a booking — must be consistent across fetches so calendar
// apps can detect updates rather than creating duplicates
function bookingUid(booking) {
  return `wph-${booking.id}@westmereprivatehire.co.uk`;
}

// Build a VEVENT block for a booking
function buildVEvent(booking) {
  const durationMin = 90;
  let dtStart, dtEnd;

  if (booking.date && booking.time && /^\d{2}:\d{2}$/.test(booking.time)) {
    // Parse as Europe/London local time. For a correct UTC offset we use a
    // heuristic: check if the date falls in BST (last Sun Mar → last Sun Oct).
    // This is good enough for a calendar feed; the event time will be right.
    const [y, mo, day] = booking.date.split('-').map(Number);
    const [h, m] = booking.time.split(':').map(Number);

    // Is this date in British Summer Time?
    function lastSundayOf(year, month) {
      // month is 0-based JS month
      const d = new Date(Date.UTC(year, month + 1, 0)); // last day of month
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return d;
    }
    const bstStart = lastSundayOf(y, 2); // last Sun of March
    const bstEnd   = lastSundayOf(y, 9); // last Sun of October
    const localMs  = Date.UTC(y, mo - 1, day, h, m, 0);
    const isBST    = localMs >= bstStart.getTime() && localMs < bstEnd.getTime();
    const offsetMs = isBST ? -3600000 : 0; // BST = UTC+1, so subtract 1h to get UTC

    dtStart = new Date(localMs + offsetMs);
    dtEnd   = new Date(dtStart.getTime() + durationMin * 60000);
  } else if (booking.date) {
    // All-day event
    const [y, mo, day] = booking.date.split('-').map(Number);
    const pad = n => String(n).padStart(2, '0');
    return [
      'BEGIN:VEVENT',
      foldLine('UID:' + bookingUid(booking)),
      'DTSTART;VALUE=DATE:' + y + pad(mo) + pad(day),
      'DTEND;VALUE=DATE:'   + y + pad(mo) + pad(day),
      foldLine('SUMMARY:'  + icsEscape(`Pickup: ${_tinyAddr(booking.pickup) || '?'}`)),
      foldLine('LOCATION:' + icsEscape(booking.pickup || '')),
      'STATUS:CONFIRMED',
      'END:VEVENT'
    ].join('\r\n');
  } else {
    return null; // no date — skip
  }

  const name  = booking.customer_name  || booking.passenger_name  || '';
  const phone = booking.customer_phone || booking.passenger_phone || '';
  const descLines = [
    booking.ref    ? `Ref: ${booking.ref}` : null,
    name           ? `Passenger: ${name}`  : null,
    phone          ? `Phone: ${phone}`     : null,
    booking.pickup ? `Pickup: ${booking.pickup}` : null,
    booking.destination ? `Drop-off: ${booking.destination}` : null,
    booking.flight ? `Flight: ${booking.flight}` : null,
    booking.fare   ? `Fare: \u00a3${booking.fare}` : null,
    booking.notes  ? `Notes: ${booking.notes}`     : null,
    '',
    booking.pickup      ? `Pickup (Waze): https://waze.com/ul?q=${encodeURIComponent(booking.pickup)}&navigate=yes` : null,
    booking.destination ? `Drop-off (Waze): https://waze.com/ul?q=${encodeURIComponent(booking.destination)}&navigate=yes` : null
  ].filter(x => x !== null).join('\\n');

  const now = toIcsDate(new Date());

  return [
    'BEGIN:VEVENT',
    foldLine('UID:'        + bookingUid(booking)),
    'DTSTAMP:'             + now,
    'DTSTART:'             + toIcsDate(dtStart),
    'DTEND:'               + toIcsDate(dtEnd),
    foldLine('SUMMARY:'   + icsEscape(`Pickup: ${_tinyAddr(booking.pickup) || '?'} \u2192 ${_tinyAddr(booking.destination) || '?'}`)),
    foldLine('LOCATION:'  + icsEscape(booking.pickup || '')),
    foldLine('DESCRIPTION:' + icsEscape(descLines)),
    'STATUS:CONFIRMED',
    'END:VEVENT'
  ].join('\r\n');
}

// GET /api/driver/cal/:token.ics
router.get('/cal/:tokenfile', (req, res) => {
  // Strip the .ics suffix from the param
  const rawToken = String(req.params.tokenfile).replace(/\.ics$/i, '').replace(/[^a-f0-9]/gi, '');
  if (!rawToken || rawToken.length < 16) {
    return res.status(404).send('Not found');
  }

  const db = getDb();
  const driver = db.prepare("SELECT * FROM users WHERE calendar_token = ? AND role = 'driver' AND active = 1").get(rawToken);
  if (!driver) {
    return res.status(404).send('Not found');
  }

  // Fetch upcoming assigned bookings (confirmed, offered, active)
  const bookings = db.prepare(`
    SELECT b.*,
           COALESCE(c.full_name, b.passenger_name) AS customer_name,
           COALESCE(c.phone,     b.passenger_phone) AS customer_phone
    FROM bookings b
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.driver_id = ?
      AND b.status IN ('confirmed', 'offered', 'active', 'pending')
      AND b.date >= date('now', '-1 day')
    ORDER BY b.date, b.time
    LIMIT 200
  `).all(driver.id);

  const vevents = bookings.map(buildVEvent).filter(Boolean).join('\r\n');

  const cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Westmere Private Hire//Driver Jobs//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine('X-WR-CALNAME:WPH Jobs — ' + icsEscape(driver.full_name || driver.username)),
    'X-WR-TIMEZONE:Europe/London',
    'X-PUBLISHED-TTL:PT1H',
    vevents,
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="wph-jobs.ics"',
    'Cache-Control': 'no-cache, no-store'
  });
  res.send(cal);
});

module.exports = router;
