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

/* ── AN OPEN DIFFERENCE ON AN ALREADY-PAID BOOKING ───────────────────────
   The owner re-priced a trip the customer had already paid for. Only the
   DIFFERENCE moves: either we owe them (`refund`) or they owe us (`topup`).
   Never the full new fare — that would take the money twice for one journey.

   `fare_adjust_settled_at` is the latch. Once it is stamped the difference is
   closed and this returns null, which is what stops a second refund and a
   second charge. The key pairs the ref with the moment the edit raised it, so
   re-pricing again mints a NEW key and a refund issued against the old one can
   never be mistaken for settling the new one. */
function round2(n) { return Math.round(Number(n) * 100) / 100; }

function adjustKey(b) {
  return String((b && b.ref) || '') + ':' + String((b && b.fare_adjust_at) || '');
}

function openAdjustment(b) {
  if (!b) return null;
  const kind = String(b.fare_adjust_kind || '').toLowerCase();
  if (kind !== 'refund' && kind !== 'topup') return null;
  if (b.fare_adjust_settled_at) return null;
  const amount = Number(b.fare_adjust_amount);
  if (!isFinite(amount) || amount < 0.01) return null;
  return {
    kind,
    amount: round2(amount),
    paid: b.fare_adjust_paid == null ? null : round2(b.fare_adjust_paid),
    method: String(b.fare_adjust_method || '') || null,
    key: adjustKey(b)
  };
}
function openTopUp(b) { const a = openAdjustment(b); return a && a.kind === 'topup' ? a : null; }

/**
 * → { locked, reason, message, payable, fare, amountDue }
 *   `locked`    — true when NO payment action may proceed on either channel.
 *   `payable`   — true only when a card payment or a cash choice is still open.
 *   `amountDue` — THE AMOUNT TO CHARGE, in pounds. Normally the fare; on a
 *                 re-priced prepaid booking it is the DIFFERENCE only. Every
 *                 charging path must read this and never `fare`, or a customer
 *                 who has already paid £42 is asked for the whole £57 again.
 *   `message`   — customer-facing wording, identical in the email channel and
 *                 in My Account so the two never contradict each other.
 */
function paymentLock(b) {
  if (!b) {
    return { locked: true, reason: 'not_found', payable: false, fare: null, amountDue: null,
             message: 'We could not find that booking.' };
  }
  const fare = (b.fare == null || b.fare === '') ? null : Number(b.fare);

  if (String(b.status || '') === 'cancelled') {
    return { locked: true, reason: 'cancelled', payable: false, fare, amountDue: null,
             message: 'This booking has been cancelled. Please call us if you need to rebook.' };
  }

  // AN OPEN TOP-UP OUTRANKS "already paid". The booking IS paid — for the old
  // price — and that is exactly why the difference is still owed. Checked
  // before isSettled(), which would otherwise lock a re-priced trip and leave
  // the customer with no way to settle the balance.
  const topUp = openTopUp(b);
  if (topUp) {
    if (topUp.method === 'cash') {
      // They chose to settle the difference with the driver. The card door is
      // shut, or both channels could take the same balance.
      return { locked: true, reason: 'cash_chosen', payable: false, fare, amountDue: null,
               message: 'You have chosen to settle the difference with your driver on the day, so there is nothing to pay online. Call us on 07930 342593 if you would rather pay by card.' };
    }
    return { locked: false, reason: 'top_up', payable: true, fare, amountDue: topUp.amount,
             adjustKey: topUp.key, alreadyPaid: topUp.paid, message: '' };
  }

  if (isSettled(b)) {
    return { locked: true, reason: 'paid', payable: false, fare, amountDue: null,
             message: 'This trip has already been paid.' };
  }
  if (isCashChosen(b)) {
    // NOT an error and NOT "paid" — the customer made a choice, and saying
    // "already paid" here would be a lie they would notice on the day.
    return { locked: true, reason: 'cash_chosen', payable: false, fare, amountDue: null,
             message: 'You have chosen to pay your driver on the day, so there is nothing to pay online. Call us on 07930 342593 if you would rather pay by card.' };
  }
  if (!fare || fare <= 0) {
    return { locked: false, reason: 'no_fare', payable: false, fare, amountDue: null,
             message: 'There is nothing to pay on this booking just yet — we will send your estimate shortly.' };
  }
  return { locked: false, reason: null, payable: true, fare, amountDue: round2(fare), message: '' };
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
  const COLS = `id, ref, fare, status, payment, paid_at,
                fare_adjust_kind, fare_adjust_amount, fare_adjust_paid,
                fare_adjust_at, fare_adjust_method, fare_adjust_settled_at`;
  const before = db.prepare('SELECT ' + COLS + ' FROM bookings WHERE id = ?').get(bookingId);
  const lock = paymentLock(before);
  if (lock.locked) {
    return { ok: false, already: true, reason: lock.reason, message: lock.message, wasChosen: false };
  }

  // Validated, never a silent default — see CLAUDE.md payment invariant #1.
  const method = assertPaymentMethod('cash', ctx.source || 'pay-lock applyCashChoice');
  const wasChosen = before.status === 'pending' || before.status === 'offered';
  const topUp = openTopUp(before);

  // TWO different writes, because they mean two different things.
  //
  // Normally: the customer is choosing HOW to pay a fare nobody has paid yet,
  // so `payment` becomes cash and the guard refuses to touch a row that has
  // since been settled by card.
  //
  // On a TOP-UP the booking is already paid — by card, most likely — and the
  // customer is choosing how to settle only the DIFFERENCE. `payment` must NOT
  // be rewritten to cash: that would erase the record of a real card charge and
  // make a settled booking look unpaid. Only the adjustment's method moves, and
  // it moves once (settled_at IS NULL), which is what closes the card door.
  const info = topUp
    ? db.prepare(`
        UPDATE bookings
           SET fare_adjust_method = 'cash',
               status = CASE WHEN status IN ('pending','offered') THEN 'awaiting_payment' ELSE status END,
               updated_at = datetime('now')
         WHERE id = ?
           AND fare_adjust_settled_at IS NULL
           AND COALESCE(fare_adjust_method, '') <> 'cash'
           AND status <> 'cancelled'
      `).run(bookingId)
    : db.prepare(`
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
    const after = db.prepare('SELECT ' + COLS + ' FROM bookings WHERE id = ?').get(bookingId);
    const now = paymentLock(after);
    return { ok: false, already: true, reason: now.reason || 'locked', message: now.message, wasChosen: false };
  }

  try {
    db.prepare('INSERT INTO audit_log (user_type, user_id, action, detail, ip) VALUES (?,?,?,?,?)')
      .run(ctx.userType || 'public', ctx.userId || 0, 'payment_cash_chosen',
           before.ref + (ctx.source ? ' — ' + ctx.source : ''), ctx.ip || null);
  } catch (e) { console.error('[PAY-LOCK] cash audit failed:', e.message); }

  return { ok: true, already: false, reason: null, message: '', wasChosen: wasChosen,
           ref: before.ref, id: before.id, fare: before.fare,
           topUp: topUp ? topUp.amount : null };
}

module.exports = { paymentLock, applyCashChoice, isSettled, isCashChosen,
                   openAdjustment, openTopUp, adjustKey, round2 };
