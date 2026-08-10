// ── Payment-method guardrail ─────────────────────────────────────────────
// Single source of truth for the payment methods a booking may carry, plus a
// validator that makes a *silent wrong-default* impossible.
//
// INVARIANT (see CLAUDE.md): a booking's `payment` value is only ever one of
// PAYMENT_METHODS. It must reflect the customer's real, explicit choice —
// 'card' only after a genuine card payment, 'cash' only after the customer
// chose to pay their driver. An unknown/blank method must resolve to 'pending'
// (awaiting a choice) and be LOGGED — never quietly assumed to be 'cash'.
//
// This module exists because a previous class of bug defaulted a missing
// method to 'cash' in several places, so a customer who chose card could be
// recorded as cash. Route through normalizePaymentMethod() instead of `x || 'cash'`.

// 'pending' = no choice yet. 'card'/'cash' = customer paid online / on the day.
// 'account'/'invoice' = billed to a corporate account.
const PAYMENT_METHODS = ['pending', 'card', 'cash', 'account', 'invoice'];

function isValidPaymentMethod(m) {
  return typeof m === 'string' && PAYMENT_METHODS.includes(m.toLowerCase());
}

// Coerce any input to a known method. Unknown/blank → 'pending' (NEVER 'cash'),
// and the coercion is logged so a defaulting bug can't reappear silently.
// `where` is a short tag naming the call site for the log line.
function normalizePaymentMethod(m, where) {
  if (m == null || m === '') return 'pending';
  const lower = String(m).toLowerCase();
  if (PAYMENT_METHODS.includes(lower)) return lower;
  console.error(`[PAYMENT] Unknown payment method ${JSON.stringify(m)} at ${where || 'unknown'} — coercing to 'pending' (NOT 'cash').`);
  return 'pending';
}

// Assert-style guard for write paths that set a concrete method. Throws on an
// invalid value so a bad write fails loudly in tests / dev instead of silently
// persisting. Use for the explicit 'card'/'cash' writes.
function assertPaymentMethod(m, where) {
  if (!isValidPaymentMethod(m)) {
    throw new Error(`[PAYMENT] Refusing to write invalid payment method ${JSON.stringify(m)} at ${where || 'unknown'}`);
  }
  return String(m).toLowerCase();
}

module.exports = { PAYMENT_METHODS, isValidPaymentMethod, normalizePaymentMethod, assertPaymentMethod };
