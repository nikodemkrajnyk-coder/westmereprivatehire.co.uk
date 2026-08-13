/**
 * PAY LOCK — the one answer to "can this booking still be paid, and how?"
 *
 * WHY THIS MODULE EXISTS
 *   A booking's estimate is now payable from TWO places at once: the tokenised
 *   Pay Now link in the estimate email, and the customer's own My Account. Both
 *   act on the SAME booking, the SAME pay_token and the SAME Stripe payment.
 *   Two channels racing for one fare is exactly how a customer gets charged
 *   twice, so the rule that decides whether payment may proceed lives here and
 *   NOWHERE else. Every entry point on both channels asks this module, against
 *   the LIVE booking row, immediately before it does anything:
 *
 *     · GET  /api/public/pay/:ref            (what the pay page renders)
 *     · POST /api/public/pay/:ref/intent     (card, email channel)
 *     · POST /api/public/pay/:ref/cash       (cash, email channel)
 *     · GET  /api/customer/bookings/:id/pay-options   (what My Account renders)
 *     · POST /api/customer/bookings/:id/choose-cash   (cash, My Account)
 *
 *   Whichever channel completes first sets the state that locks the other.
 *
 * THE STATES THAT LOCK
 *   paid        — a genuine card payment landed (Stripe webhook stamped
 *                 paid_at / payment='card'), or staff settled it. Nothing more
 *                 is owed and NEITHER channel may take money again.
 *   cash_chosen — the customer chose "pay your driver on the day" in one
 *                 channel. The method is decided, so the other channel must not
 *                 also take a card payment for the same journey.
 *   cancelled   — there is no journey to pay for.
 *   no_fare     — no price has been set yet (estimate not sent, or the owner is
 *                 mid re-estimate). Nothing to pay *yet*; not an error.
 *
 * Deliberately NOT a lock: `status`. A booking can sit in pending or
 * awaiting_payment and still be payable — status tracks the lifecycle, this
 * tracks the money. Reading them as one is how "awaiting_payment" bookings
 * became unpayable in the past.
 *
 * GUARDRAIL: server/tests/double-payment.test.js
 */

const { assertPaymentMethod } = require('./payment-methods');

// Has real money been collected for this booking?
function isSettled(b) {
  if (!b) return false;
  return !!b.paid_at || String(b.payment || '').toLowerCase() === 'card';
}

// Has the customer already committed to a method that rules out a card charge?
function isCashChosen(b) {
  return !!b && String(b.payment || '').toLowerCase() === 'cash';
}

/**
 * → { locked, reason, message, payable, fare }
 *   `locked`  — true when NO payment action may proceed on either channel.
 *   `payable` — true only when a card payment or a cash choice is still open.
 *   `message` — customer-facing wording, identical in the email channel and in
 *               My Account so the two never contradict each other.
 */
function paymentLock(b) {
  if (!b) {
    return { locked: true, reason: 'not_found', payable: false, fare: null,
             message: 'We could not find that booking.' };
  }
  const fare = (b.fare == null || b.fare === '') ? null : Number(b.fare);

  if (String(b.status || '') === 'cancelled') {
    return { locked: true, reason: 'cancelled', payable: false, fare,
             message: 'This booking has been cancelled. Please call us if you need to rebook.' };
  }
  if (isSettled(b)) {
    return { locked: true, reason: 'paid', payable: false, fare,
             message: 'This trip has already been paid.' };
  }
  if (isCashChosen(b)) {
    // NOT an error and NOT "paid" — the customer made a choice, and saying
    // "already paid" here would be a lie they would notice on the day.
    return { locked: true, reason: 'cash_chosen', payable: false, fare,
             message: 'You have chosen to pay your driver on the day, so there is nothing to pay online. Call us on 07930 342593 if you would rather pay by card.' };
  }
  if (!fare || fare <= 0) {
    return { locked: false, reason: 'no_fare', payable: false, fare,
             message: 'There is nothing to pay on this booking just yet — we will send your estimate shortly.' };
  }
  return { locked: false, reason: null, payable: true, fare, message: '' };
}

/**
 * Record the customer's "pay my driver on the day" choice.
 *
 * Shared by BOTH channels (the tokenised email link and the authenticated
 * My Account button) so they cannot drift into two different behaviours — the
 * whole double-payment guarantee rests on them being the same act.
 *
 * The UPDATE is CONDITIONAL on the booking still being unsettled. That closes
 * the real race: a card payment landing between the lock check above and this
 * write would otherwise be overwritten by `payment = 'cash'`, turning a paid
 * booking into an unpaid one. If nothing is written we re-read and report what
 * actually happened, rather than claiming a success that did not occur.
 *
 * → { ok, already, reason, message, wasChosen }
 *   wasChosen — true only on the pending/offered → awaiting_payment edge, so
 *               the caller knows whether to fire the confirmation email once.
 */
function applyCashChoice(db, bookingId, ctx) {
  ctx = ctx || {};
  const before = db.prepare('SELECT id, ref, fare, status, payment, paid_at FROM bookings WHERE id = ?').get(bookingId);
  const lock = paymentLock(before);
  if (lock.locked) {
    return { ok: false, already: true, reason: lock.reason, message: lock.message, wasChosen: false };
  }

  // Validated, never a silent default — see CLAUDE.md payment invariant #1.
  const method = assertPaymentMethod('cash', ctx.source || 'pay-lock applyCashChoice');
  const wasChosen = before.status === 'pending' || before.status === 'offered';

  const info = db.prepare(`
    UPDATE bookings
       SET payment = ?,
           status = CASE WHEN status IN ('pending','offered') THEN 'awaiting_payment' ELSE status END,
           updated_at = datetime('now')
     WHERE id = ?
       AND paid_at IS NULL
       AND payment <> 'card'
       AND status <> 'cancelled'
  `).run(method, bookingId);

  if (info.changes === 0) {
    // Something settled it underneath us between the read and the write.
    const after = db.prepare('SELECT id, ref, fare, status, payment, paid_at FROM bookings WHERE id = ?').get(bookingId);
    const now = paymentLock(after);
    return { ok: false, already: true, reason: now.reason || 'locked', message: now.message, wasChosen: false };
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(ctx.userType || 'public', ctx.userId || 0, 'payment_cash_chosen',
           before.ref + (ctx.source ? ' — ' + ctx.source : ''), ctx.ip || null);
  } catch (e) { console.error('[PAY-LOCK] cash audit failed:', e.message); }

  return { ok: true, already: false, reason: null, message: '', wasChosen: wasChosen, ref: before.ref, id: before.id, fare: before.fare };
}

module.exports = { paymentLock, applyCashChoice, isSettled, isCashChosen };
