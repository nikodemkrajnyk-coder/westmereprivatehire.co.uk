/**
 * Email service — Gmail SMTP via Nodemailer
 *
 * Environment variables:
 *   GMAIL_USER          — Gmail address (e.g. bookings@westmereprivatehire.co.uk)
 *   GMAIL_APP_PASSWORD  — Gmail App Password (16-char, from Google Account → Security → App passwords)
 *   ADMIN_EMAIL         — Where admin booking alerts go (defaults to GMAIL_USER)
 */

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    console.warn('[EMAIL] GMAIL_USER or GMAIL_APP_PASSWORD not set — email disabled');
    return null;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });

  console.log('[EMAIL] Gmail transporter ready (' + user + ')');
  return transporter;
}

// ── Send booking confirmation to customer ────────────────────────────────
async function sendCustomerConfirmation(booking) {
  const t = getTransporter();
  if (!t) return;

  const { ref, name, email, pickup, destination, date, time, fare, payment, flight } = booking;

  const html = `
    <div style="font-family:'Georgia',serif;max-width:600px;margin:0 auto;background:#111D2C;color:#F5F2ED;padding:2rem;border-radius:12px">
      <div style="text-align:center;border-bottom:1px solid rgba(184,152,90,.3);padding-bottom:1.5rem;margin-bottom:1.5rem">
        <h1 style="font-size:1.8rem;color:#B8985A;margin:0;letter-spacing:.05em">WESTMERE</h1>
        <p style="font-size:.75rem;letter-spacing:.15em;color:rgba(245,242,237,.5);margin:.3rem 0 0">PRIVATE HIRE</p>
      </div>
      <h2 style="color:#F5F2ED;font-size:1.1rem;font-weight:400;margin:0 0 1.5rem">Booking Confirmation</h2>
      <table style="width:100%;border-collapse:collapse;font-size:.95rem">
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0;width:120px">Reference</td><td style="color:#B8985A;font-weight:600;padding:.4rem 0">${ref}</td></tr>
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">Passenger</td><td style="color:#F5F2ED;padding:.4rem 0">${name}</td></tr>
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">From</td><td style="color:#F5F2ED;padding:.4rem 0">${pickup}</td></tr>
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">To</td><td style="color:#F5F2ED;padding:.4rem 0">${destination}</td></tr>
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">Date &amp; Time</td><td style="color:#F5F2ED;padding:.4rem 0">${date}${time ? ' at ' + time : ''}</td></tr>
        ${flight ? `<tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">Flight</td><td style="color:#F5F2ED;padding:.4rem 0">${flight}</td></tr>` : ''}
        ${fare ? `<tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">Fare</td><td style="color:#B8985A;font-weight:600;padding:.4rem 0">&pound;${typeof fare === 'number' ? fare.toFixed(2) : fare}</td></tr>` : ''}
        <tr><td style="color:rgba(245,242,237,.5);padding:.4rem 0">Payment</td><td style="color:#F5F2ED;padding:.4rem 0">${payment === 'card' ? 'Paid online' : 'Pay driver'}</td></tr>
      </table>
      <div style="margin-top:2rem;padding-top:1.5rem;border-top:1px solid rgba(184,152,90,.3);text-align:center">
        <p style="font-size:.8rem;color:rgba(245,242,237,.4);margin:0">Westmere Private Hire &middot; Licensed by Lewes District Council</p>
        <p style="font-size:.8rem;color:rgba(245,242,237,.4);margin:.3rem 0 0">Questions? Reply to this email or call us.</p>
      </div>
    </div>
  `;

  try {
    await t.sendMail({
      from: `"Westmere Private Hire" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Booking Confirmed — ${ref}`,
      html
    });
    console.log('[EMAIL] Customer confirmation sent to', email, '(' + ref + ')');
  } catch (err) {
    console.error('[EMAIL] Failed to send customer confirmation:', err.message);
  }
}

// ── Send booking alert to admin/driver ───────────────────────────────────
async function sendAdminAlert(booking) {
  const t = getTransporter();
  if (!t) return;

  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  const { ref, name, phone, email, pickup, destination, date, time, fare, payment, flight, passengers, bags, notes } = booking;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#111D2C;border-bottom:2px solid #B8985A;padding-bottom:.5rem">New Booking — ${ref}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:.95rem">
        <tr><td style="padding:.4rem 0;font-weight:600;width:130px">Passenger</td><td>${name}</td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Pickup</td><td>${pickup}</td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Destination</td><td>${destination}</td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Date / Time</td><td>${date} at ${time || 'ASAP'}</td></tr>
        ${flight ? `<tr><td style="padding:.4rem 0;font-weight:600">Flight</td><td>${flight}</td></tr>` : ''}
        <tr><td style="padding:.4rem 0;font-weight:600">Passengers</td><td>${passengers || 1}</td></tr>
        <tr><td style="padding:.4rem 0;font-weight:600">Luggage</td><td>${bags || 'None'}</td></tr>
        ${fare ? `<tr><td style="padding:.4rem 0;font-weight:600">Fare</td><td>&pound;${typeof fare === 'number' ? fare.toFixed(2) : fare}</td></tr>` : ''}
        <tr><td style="padding:.4rem 0;font-weight:600">Payment</td><td style="color:${payment === 'card' ? '#22863a' : '#b08800'};font-weight:600">${payment === 'card' ? 'PAID ONLINE' : 'PAY DRIVER'}</td></tr>
        ${notes ? `<tr><td style="padding:.4rem 0;font-weight:600">Notes</td><td>${notes}</td></tr>` : ''}
      </table>
    </div>
  `;

  try {
    await t.sendMail({
      from: `"Westmere Bookings" <${process.env.GMAIL_USER}>`,
      to: adminEmail,
      subject: `[NEW BOOKING] ${ref} — ${name} — ${pickup} → ${destination}`,
      html
    });
    console.log('[EMAIL] Admin alert sent to', adminEmail, '(' + ref + ')');
  } catch (err) {
    console.error('[EMAIL] Failed to send admin alert:', err.message);
  }
}

module.exports = { sendCustomerConfirmation, sendAdminAlert };
