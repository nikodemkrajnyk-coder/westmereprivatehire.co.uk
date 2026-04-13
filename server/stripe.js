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

// ── Verify webhook signature ─────────────────────────────────────────────
function verifyWebhook(payload, signature) {
  const s = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return null;
  return s.webhooks.constructEvent(payload, signature, secret);
}

module.exports = { getStripe, isConfigured, createPaymentIntent, verifyWebhook };
