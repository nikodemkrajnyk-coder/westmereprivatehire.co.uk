/**
 * How long until a pickup — the clock the reminder email speaks with.
 *
 * WHY THIS IS ITS OWN MODULE
 *   The owner reminder said "A booking is coming up in about 12 hours" no matter
 *   when it actually went out. The sweeper has always fired for anything inside
 *   the next 12 hours, so a booking made 45 minutes before pickup got an email
 *   claiming twelve. The number was decoration; now it is computed.
 *
 *   The parsing lives here rather than in email.js because it has to obey the
 *   TIMEZONE INVARIANT (see CLAUDE.md), and there should be exactly one place
 *   that knows how. reminder.js re-exports ukNowMs/pickupMs from here so its
 *   public surface is unchanged.
 *
 * TIMEZONE INVARIANT
 *   bookings.date/.time are UK WALL-CLOCK strings, not instants. "Now" is
 *   therefore also taken as UK wall-clock and parsed the same naive way, so the
 *   subtraction is correct in UK-local terms on a UTC host. Never build a Date
 *   from date + 'T' + time without excluding ASAP — 'YYYY-MM-DDTASAP' is an
 *   Invalid Date, and that has shipped before.
 */

// "now" as UK wall-clock, parsed as a naive UTC timestamp.
function ukNowMs() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London' }); // "YYYY-MM-DD HH:MM:SS"
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

// Pickup wall-clock → ms (naive UTC). Returns null for ASAP / no fixed time.
function pickupMs(date, time) {
  if (!date || !time) return null;
  const m = String(time).match(/^(\d{2}):(\d{2})/);
  if (!m) return null; // 'ASAP' or malformed → no scheduled reminder
  const t = Date.parse(String(date) + 'T' + m[1] + ':' + m[2] + ':00Z');
  return isNaN(t) ? null : t;
}

/**
 * The gap, in words. Returns a phrase that follows "A booking is coming up …".
 *
 * Accuracy first: hours round to the nearest hour, minutes to the nearest five.
 * The one deliberate imprecision is the 50-something-minute band — rounding it
 * to "60 minutes" would be wrong and "in about 1 hour" overstates it, so it
 * becomes "in under an hour", which is both true and what a person would say.
 */
function gapPhrase(ms) {
  if (ms == null || isNaN(ms)) return 'shortly';
  const mins = ms / 60000;
  if (mins <= 0) return 'any moment now';
  if (mins < 5) return 'in just a few minutes';
  if (mins < 60) {
    const r = Math.round(mins / 5) * 5;
    return r >= 60 ? 'in under an hour' : 'in about ' + r + ' minutes';
  }
  const h = Math.round(mins / 60);
  return 'in about ' + h + (h === 1 ? ' hour' : ' hours');
}

/**
 * The line under the headline. "Give yourself plenty of time" is fine twelve
 * hours out and faintly absurd at half an hour, so it scales with the gap.
 */
function urgencyLine(ms) {
  const mins = ms == null || isNaN(ms) ? Infinity : ms / 60000;
  if (mins < 60) return 'This one is close — full details below.';
  // Round the same way gapPhrase does, or the headline can say "about 3 hours"
  // while the line underneath is still using the under-3-hours wording.
  const h = mins === Infinity ? Infinity : Math.round(mins / 60);
  if (h < 3) return 'Time to start getting ready — full details below.';
  return 'Give yourself plenty of time — full details below.';
}

module.exports = { ukNowMs, pickupMs, gapPhrase, urgencyLine };
