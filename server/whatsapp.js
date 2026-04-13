/**
 * WhatsApp Cloud API integration (Meta Business Platform)
 *
 * Environment variables:
 *   WHATSAPP_TOKEN       — Permanent access token from Meta Business
 *   WHATSAPP_PHONE_ID    — WhatsApp Business phone number ID
 *   WHATSAPP_ADMIN_PHONE — Admin phone in international format (e.g. 447700900000)
 *
 * Setup guide:
 *   1. Go to developers.facebook.com → Create App → Business type
 *   2. Add WhatsApp product → Get phone number ID + token
 *   3. Register your business phone number
 *   4. Create message templates in WhatsApp Manager (or use text messages for testing)
 */

const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

function isConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

// ── Send a text message ──────────────────────────────────────────────────
async function sendMessage(to, text) {
  if (!isConfigured()) {
    console.warn('[WHATSAPP] Not configured — skipping message');
    return null;
  }

  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  // Normalize phone: remove spaces, dashes, leading +
  const phone = to.replace(/[\s\-\+]/g, '').replace(/^0/, '44');

  const res = await fetch(`${WHATSAPP_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text }
    })
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('[WHATSAPP] Send failed:', JSON.stringify(data.error || data));
    return null;
  }

  console.log('[WHATSAPP] Message sent to', phone);
  return data;
}

// ── Booking confirmation to customer ─────────────────────────────────────
async function sendCustomerBookingWhatsApp(booking) {
  if (!isConfigured() || !booking.phone) return;

  const lines = [
    `*Westmere Private Hire*`,
    ``,
    `Booking Confirmed`,
    `Ref: *${booking.ref}*`,
    ``,
    `From: ${booking.pickup}`,
    `To: ${booking.destination}`,
    `Date: ${booking.date}${booking.time ? ' at ' + booking.time : ''}`,
  ];

  if (booking.flight) lines.push(`Flight: ${booking.flight}`);
  if (booking.fare) lines.push(`Fare: \u00a3${typeof booking.fare === 'number' ? booking.fare.toFixed(2) : booking.fare}`);
  lines.push(`Payment: ${booking.payment === 'card' ? 'Paid online' : 'Pay driver'}`);
  lines.push('');
  lines.push('Thank you for choosing Westmere.');

  try {
    await sendMessage(booking.phone, lines.join('\n'));
    console.log('[WHATSAPP] Customer confirmation sent (' + booking.ref + ')');
  } catch (err) {
    console.error('[WHATSAPP] Customer message failed:', err.message);
  }
}

// ── Booking alert to admin ───────────────────────────────────────────────
async function sendAdminBookingWhatsApp(booking) {
  const adminPhone = process.env.WHATSAPP_ADMIN_PHONE;
  if (!isConfigured() || !adminPhone) return;

  const lines = [
    `*NEW BOOKING* - ${booking.ref}`,
    ``,
    `${booking.name} (${booking.phone})`,
    `${booking.pickup} \u2192 ${booking.destination}`,
    `${booking.date} at ${booking.time || 'ASAP'}`,
  ];

  if (booking.flight) lines.push(`Flight: ${booking.flight}`);
  if (booking.passengers) lines.push(`Pax: ${booking.passengers}`);
  if (booking.bags) lines.push(`Bags: ${booking.bags}`);
  if (booking.fare) lines.push(`Fare: \u00a3${typeof booking.fare === 'number' ? booking.fare.toFixed(2) : booking.fare}`);
  lines.push(`Payment: ${booking.payment === 'card' ? 'PAID' : 'PAY DRIVER'}`);
  if (booking.notes) lines.push(`Notes: ${booking.notes}`);

  try {
    await sendMessage(adminPhone, lines.join('\n'));
    console.log('[WHATSAPP] Admin alert sent (' + booking.ref + ')');
  } catch (err) {
    console.error('[WHATSAPP] Admin message failed:', err.message);
  }
}

module.exports = { sendMessage, sendCustomerBookingWhatsApp, sendAdminBookingWhatsApp, isConfigured };
