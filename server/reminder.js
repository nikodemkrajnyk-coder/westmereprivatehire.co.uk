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
    // BOTH latches must be set before a booking stops being due — there are two
    // reminders now (owner and customer) and they fire independently.
    if (r.reminder_sent_at && r.customer_reminder_sent_at) return false;
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
           COALESCE(c.phone,     b.passenger_phone) AS customer_phone,
           COALESCE(c.email,     b.passenger_email) AS customer_email,
           -- The assigned driver and his car, when the job has been given to
           -- somebody. Left NULL when it has not, and the email falls back to
           -- the owner's own car (driverDetails in email.js).
           d.full_name AS driver_name, d.vehicle AS driver_vehicle, d.reg AS driver_reg
      FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
                      LEFT JOIN users     d ON b.driver_id   = d.id
     WHERE b.status IN ('confirmed', 'awaiting_payment', 'active')
       -- Either reminder still outstanding. This used to test reminder_sent_at
       -- alone; with two independent latches that would drop a booking out of the
       -- sweep the moment the OWNER's went, and the customer would never get
       -- theirs. Cancelled bookings are excluded by the status filter above.
       AND (b.reminder_sent_at IS NULL OR b.customer_reminder_sent_at IS NULL)
       AND b.time IS NOT NULL AND b.time != 'ASAP'
       AND b.date >= date('now', '-1 day')
  `).all();

  const nowMs = ukNowMs();
  const due = dueReminders(rows, nowMs, 12);
  if (!due.length) return { checked: rows.length, sent: 0, sentCustomer: 0 };

  const ownerEmail = ownerReminderEmail(db);
  const { sendOwnerBookingReminder, sendCustomerJourneyReminder } = require('./email');
  const { paymentLock } = require('./pay-lock');
  const intake = require('./intake');
  let sent = 0, sentCustomer = 0;
  for (const b of due) {
    // ── The OWNER's reminder, latched on reminder_sent_at ──
    if (!b.reminder_sent_at) {
      try {
        const ok = await sendOwnerBookingReminder(b, ownerEmail, nowMs);
        if (ok) {
          db.prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
          sent++;
        }
      } catch (e) {
        console.error('[REMINDER] owner send failed for', b.ref, '-', e.message);
      }
    }

    /* ── The CUSTOMER's reminder, latched on its OWN column ──
       A separate latch, so one send can never suppress the other. It needs an
       email address, and it needs a token before it can offer a Pay button —
       ensurePayToken is idempotent, so a token already sitting in a delivered
       estimate is never re-minted.

       paymentLock is asked the same question every other channel asks: only a
       genuinely payable booking gets the two buttons. A cash-locked or settled
       booking gets the status line and nothing to press. */
    const custEmail = b.customer_email || b.passenger_email;
    if (!b.customer_reminder_sent_at && custEmail) {
      try {
        const lock = paymentLock(b);
        const payToken = lock.payable ? (intake.ensurePayToken(b.id, db) || b.pay_token || null) : (b.pay_token || null);
        const ok = await sendCustomerJourneyReminder(
          Object.assign({}, b, { email: custEmail, pay_token: payToken }),
          { gapMs: pickupMs(b.date, b.time) - nowMs,
            pay: { payable: !!lock.payable, amountDue: lock.amountDue } });
        if (ok) {
          db.prepare("UPDATE bookings SET customer_reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
          sentCustomer++;
        }
      } catch (e) {
        console.error('[REMINDER] customer send failed for', b.ref, '-', e.message);
      }
    }
  }
  if (sent) console.log('[REMINDER] sent', sent, 'owner pickup reminder(s) to', ownerEmail);
  if (sentCustomer) console.log('[REMINDER] sent', sentCustomer, 'customer journey reminder(s)');
  return { checked: rows.length, sent, sentCustomer };
}

function startBookingReminders() {
  const run = () => sweepDueReminders().catch((e) => console.error('[REMINDER] sweep error:', e.message));
  run();                                  // once on boot (catches anything already in-window)
  setInterval(run, 15 * 60 * 1000);       // then every 15 minutes
  console.log('[REMINDER] 12h owner pickup-reminder sweeper started (every 15 min)');
}

module.exports = { startBookingReminders, sweepDueReminders, dueReminders, ukNowMs, pickupMs, ownerReminderEmail };
