/**
 * Stripe payment integration
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_PUBLISHABLE_KEY — Stripe publishable key (pk_live_... or pk_test_...)
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
 */

let stripe = null;

function getStripe() {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[STRIPE] STRIPE_SECRET_KEY not set — payments disabled');
    return null;
  }
  stripe = require('stripe')(key);
  console.log('[STRIPE] Stripe initialized');
  return stripe;
}

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// ── Create a PaymentIntent ───────────────────────────────────────────────
async function createPaymentIntent({ amount, currency = 'gbp', booking, customer, extraMetadata }) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');

  const metadata = {};
  if (booking) {
    if (booking.ref) metadata.booking_ref = booking.ref;
    if (booking.from) metadata.pickup = booking.from;
    if (booking.to) metadata.destination = booking.to;
    if (booking.date) metadata.date = booking.date;
    if (booking.time) metadata.time = booking.time;
  }
  if (customer) {
    if (customer.name) metadata.customer_name = customer.name;
    if (customer.email) metadata.customer_email = customer.email;
    if (customer.phone) metadata.customer_phone = customer.phone;
  }

  // Extra metadata (the top-up marker + its adjustment key). Applied LAST so a
  // caller can never silently lose it to a booking/customer field of the same
  // name — the key is what makes a balance payment idempotent.
  if (extraMetadata && typeof extraMetadata === 'object') {
    for (const k of Object.keys(extraMetadata)) {
      if (extraMetadata[k] != null) metadata[k] = String(extraMetadata[k]);
    }
  }

  const params = {
    amount: Math.max(amount, 100), // minimum 100p = £1.00
    currency,
    metadata,
    automatic_payment_methods: { enabled: true }
  };

  // Attach receipt email if provided
  if (customer && customer.email) {
    params.receipt_email = customer.email;
  }

  const intent = await s.paymentIntents.create(params);
  return intent;
}

// ── Refunds ──────────────────────────────────────────────────────────────
// Find the succeeded PaymentIntent for a booking ref (we stamp booking_ref
// into every PaymentIntent's metadata). Lets us refund even for bookings paid
// before we started storing the intent id on the row.
async function findPaymentIntentByRef(ref) {
  const s = getStripe();
  if (!s || !ref) return null;
  try {
    const r = await s.paymentIntents.search({
      query: `metadata['booking_ref']:'${String(ref).replace(/'/g, '')}' AND status:'succeeded'`,
      limit: 1
    });
    return (r.data && r.data[0]) ? r.data[0].id : null;
  } catch (e) {
    console.error('[STRIPE] findPaymentIntentByRef failed:', e.message);
    return null;
  }
}

// Find an OPEN (not yet succeeded) PaymentIntent for a booking, so a second
// payment attempt on the same journey reuses it instead of minting a rival.
// Returns the intent OBJECT (we need its client_secret), or null.
//
// WHY: the estimate is payable from two places at once — the tokenised link in
// the email and My Account. Each would otherwise create its own intent, and two
// live intents for one booking is the one window where both can legitimately be
// completed. One intent per booking closes it.
async function findOpenPaymentIntentByRef(ref) {
  const s = getStripe();
  if (!s || !ref) return null;
  try {
    const safe = String(ref).replace(/'/g, '');
    const r = await s.paymentIntents.search({
      query: `metadata['booking_ref']:'${safe}' AND status:'requires_payment_method'`,
      limit: 1
    });
    return (r.data && r.data[0]) ? r.data[0] : null;
  } catch (e) {
    console.error('[STRIPE] findOpenPaymentIntentByRef failed:', e.message);
    return null;
  }
}

/* Find a PaymentIntent by the ADJUSTMENT key rather than the booking ref.
   A re-priced booking already has one succeeded intent — the original fare —
   so "has this ref been paid?" is the wrong question for a balance payment and
   would refuse every top-up. This asks the right one: has THIS difference been
   paid? `status` is 'succeeded' to check for a completed balance payment, or
   'requires_payment_method' to reuse an open one instead of minting a rival. */
async function findIntentByAdjustKey(key, status) {
  const s = getStripe();
  if (!s || !key) return null;
  try {
    const safe = String(key).replace(/'/g, '');
    const r = await s.paymentIntents.search({
      query: `metadata['adjust_key']:'${safe}' AND status:'${status === 'open' ? 'requires_payment_method' : 'succeeded'}'`,
      limit: 1
    });
    return (r.data && r.data[0]) ? r.data[0] : null;
  } catch (e) {
    console.error('[STRIPE] findIntentByAdjustKey failed:', e.message);
    return null;
  }
}

// Issue a refund against a PaymentIntent. amount in pence; omit for a full refund.
//
// `idempotencyKey` is not optional in spirit: Stripe replays the FIRST result
// for a repeated key instead of creating a second refund, which is the only
// thing that holds when a double-click races past our own database latch.
// Money left the account once; a retry must not make it leave twice.
async function createRefund({ paymentIntentId, amount, idempotencyKey }) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');
  if (!paymentIntentId) throw new Error('No payment intent to refund');
  const params = { payment_intent: paymentIntentId };
  if (amount) params.amount = Math.round(amount);
  const opts = idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : undefined;
  return opts ? s.refunds.create(params, opts) : s.refunds.create(params);
}

// ── Verify webhook signature ─────────────────────────────────────────────
function verifyWebhook(payload, signature) {
  const s = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return null;
  return s.webhooks.constructEvent(payload, signature, secret);
}

// ── Payouts ─────────────────────────────────────────────────────────────
async function getBalance() {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');
  const bal = await s.balance.retrieve();
  const available = (bal.available || []).find(b => b.currency === 'gbp') || { amount: 0 };
  const pending = (bal.pending || []).find(b => b.currency === 'gbp') || { amount: 0 };
  return {
    available: available.amount,
    pending: pending.amount,
    currency: 'gbp'
  };
}

async function createPayout({ amount, description }) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');
  if (!amount || amount < 100) throw new Error('Minimum payout is £1.00');
  const payout = await s.payouts.create({
    amount,
    currency: 'gbp',
    description: description || 'Westmere Private Hire payout',
  });
  return payout;
}

async function listRecentPayouts() {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');
  const list = await s.payouts.list({ limit: 10 });
  return (list.data || []).map(p => ({
    id: p.id,
    amount: p.amount,
    status: p.status,
    arrival_date: p.arrival_date,
    created: p.created,
    description: p.description
  }));
}

module.exports = { getStripe, isConfigured, createPaymentIntent, verifyWebhook, getBalance, createPayout, listRecentPayouts, findPaymentIntentByRef, findOpenPaymentIntentByRef, findIntentByAdjustKey, createRefund };
