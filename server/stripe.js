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
async function createPaymentIntent({ amount, currency = 'gbp', booking, customer }) {
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

// Issue a refund against a PaymentIntent. amount in pence; omit for a full refund.
async function createRefund({ paymentIntentId, amount }) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');
  if (!paymentIntentId) throw new Error('No payment intent to refund');
  const params = { payment_intent: paymentIntentId };
  if (amount) params.amount = Math.round(amount);
  return s.refunds.create(params);
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

module.exports = { getStripe, isConfigured, createPaymentIntent, verifyWebhook, getBalance, createPayout, listRecentPayouts, findPaymentIntentByRef, createRefund };
