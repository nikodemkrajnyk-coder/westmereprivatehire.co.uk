/**
 * 12-hour owner pickup reminder — server-side sweeper (Railway, no Claude).
 *
 * Every 15 minutes it finds going-ahead bookings whose pickup falls anywhere in
 * the next 12 hours — the window is 0 < gap <= 12h, so a booking made two hours
 * before pickup is picked up on the very next sweep rather than missed — and
 * which haven't been reminded yet, emails the OWNER (never the customer) the
 * details, and stamps bookings.reminder_sent_at so each booking reminds exactly
 * once. The email states the REAL remaining time, computed at send time.
 * Runs entirely on the server through Resend — there is NO dependency on Claude
 * or any assistant.
 */
const { getDb } = require('./db');
// ukNowMs/pickupMs live in time-gap.js so the sweeper and the email wording read
// the clock the same way — the email now states the REAL gap, and it must agree
// with the window this file used to decide the booking was due. Re-exported
// below, so this module's public surface is unchanged.
const { ukNowMs, pickupMs } = require('./time-gap');

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

  const nowMs = ukNowMs();
  const due = dueReminders(rows, nowMs, 12);
  if (!due.length) return { checked: rows.length, sent: 0 };

  const ownerEmail = ownerReminderEmail(db);
  const { sendOwnerBookingReminder } = require('./email');
  let sent = 0;
  for (const b of due) {
    try {
      const ok = await sendOwnerBookingReminder(b, ownerEmail, nowMs);
      if (ok) {
        db.prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
        sent++;
      }
    } catch (e) {
      console.error('[REMINDER] send failed for', b.ref, '-', e.message);
    }
  }
  if (sent) console.log('[REMINDER] sent', sent, 'owner pickup reminder(s) to', ownerEmail);
  return { checked: rows.length, sent };
}

function startBookingReminders() {
  const run = () => sweepDueReminders().catch((e) => console.error('[REMINDER] sweep error:', e.message));
  run();                                  // once on boot (catches anything already in-window)
  setInterval(run, 15 * 60 * 1000);       // then every 15 minutes
  console.log('[REMINDER] 12h owner pickup-reminder sweeper started (every 15 min)');
}

module.exports = { startBookingReminders, sweepDueReminders, dueReminders, ukNowMs, pickupMs, ownerReminderEmail };
