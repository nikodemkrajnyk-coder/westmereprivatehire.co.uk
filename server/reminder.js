/**
 * 12-hour owner pickup reminder — server-side sweeper (Railway, no Claude).
 *
 * Every 15 minutes it finds going-ahead bookings whose pickup is within the next
 * 12 hours and which haven't been reminded yet, emails the OWNER (never the
 * customer) the details, and stamps bookings.reminder_sent_at so each booking
 * reminds exactly once. Runs entirely on the server through Resend — there is NO
 * dependency on Claude or any assistant.
 */
const { getDb } = require('./db');

// "now" as UK wall-clock, parsed as a naive UTC timestamp. Pickup times are also
// stored as UK-local wall-clock, so parsing BOTH the same naive way makes the
// difference correct in UK-local terms (DST edges are negligible for a 12h gap).
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

// PURE: given booking rows + "now", return those due for a reminder — pickup is
// still in the future but within the next `windowHours`, and not yet reminded.
function dueReminders(rows, nowMs, windowHours) {
  windowHours = windowHours || 12;
  return (rows || []).filter((r) => {
    if (r.reminder_sent_at) return false;
    const pm = pickupMs(r.date, r.time);
    if (pm == null) return false;
    const hours = (pm - nowMs) / 3600000;
    return hours > 0 && hours <= windowHours;
  });
}

// Where the owner reminder goes: OWNER_REMINDER_EMAIL, else the owner account's
// email, else ADMIN_EMAIL, else the known owner address.
function ownerReminderEmail(db) {
  if (process.env.OWNER_REMINDER_EMAIL) return process.env.OWNER_REMINDER_EMAIL;
  try {
    const u = db.prepare("SELECT email FROM users WHERE role = 'owner' AND email IS NOT NULL AND email != '' ORDER BY id LIMIT 1").get();
    if (u && u.email) return u.email;
  } catch (_) {}
  return process.env.ADMIN_EMAIL || 'nikodem.krajnyk@gmail.com';
}

async function sweepDueReminders() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.*,
           COALESCE(c.full_name, b.passenger_name) AS customer_name,
           COALESCE(c.phone,     b.passenger_phone) AS customer_phone
      FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.status IN ('confirmed', 'awaiting_payment', 'active')
       AND b.reminder_sent_at IS NULL
       AND b.time IS NOT NULL AND b.time != 'ASAP'
       AND b.date >= date('now', '-1 day')
  `).all();

  const due = dueReminders(rows, ukNowMs(), 12);
  if (!due.length) return { checked: rows.length, sent: 0 };

  const ownerEmail = ownerReminderEmail(db);
  const { sendOwnerBookingReminder } = require('./email');
  let sent = 0;
  for (const b of due) {
    try {
      const ok = await sendOwnerBookingReminder(b, ownerEmail);
      if (ok) {
        db.prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
        sent++;
      }
    } catch (e) {
      console.error('[REMINDER] send failed for', b.ref, '-', e.message);
    }
  }
  if (sent) console.log('[REMINDER] sent', sent, 'owner 12h reminder(s) to', ownerEmail);
  return { checked: rows.length, sent };
}

function startBookingReminders() {
  const run = () => sweepDueReminders().catch((e) => console.error('[REMINDER] sweep error:', e.message));
  run();                                  // once on boot (catches anything already in-window)
  setInterval(run, 15 * 60 * 1000);       // then every 15 minutes
  console.log('[REMINDER] 12h owner pickup-reminder sweeper started (every 15 min)');
}

module.exports = { startBookingReminders, sweepDueReminders, dueReminders, ukNowMs, pickupMs, ownerReminderEmail };
