/**
 * Email service — Resend HTTP API
 *
 * Environment variables:
 *   RESEND_API_KEY — API key from resend.com
 *   GMAIL_USER    — Reply-to address
 *   ADMIN_EMAIL   — Where admin booking alerts go
 */

const RESEND_URL = 'https://api.resend.com/emails';

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendEmail(to, subject, html, fromLabel) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL] RESEND_API_KEY not set — email disabled');
    return false;
  }

  const replyTo = process.env.GMAIL_USER || process.env.ADMIN_EMAIL || '';

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: (fromLabel || 'Westmere Private Hire') + ' <bookings@westmereprivatehire.co.uk>',
        to: to,
        reply_to: replyTo || undefined,
        subject: subject,
        html: html
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[EMAIL] Resend error:', JSON.stringify(data));
      return false;
    }

    console.log('[EMAIL] Sent to', to, '— id:', data.id);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
    return false;
  }
}

// ── Shared email wrapper ─────────────────────────────────────────────────
function emailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0D0A06;font-family:'Georgia','Times New Roman',serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0A06">
<tr><td align="center" style="padding:2rem 1rem">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(175deg,#111D2C 0%,#0F1820 100%);border:1px solid rgba(184,152,90,.2);border-radius:16px;overflow:hidden">

<!-- Header -->
<tr><td style="padding:2.5rem 2rem 1.5rem;text-align:center;border-bottom:1px solid rgba(184,152,90,.15)">
  <h1 style="margin:0;font-family:'Georgia','Times New Roman',serif;font-size:2rem;font-weight:400;font-style:italic;color:#B8985A;letter-spacing:.12em">WESTMERE</h1>
  <p style="margin:.4rem 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.6rem;letter-spacing:.25em;text-transform:uppercase;color:rgba(184,152,90,.5)">PRIVATE HIRE</p>
</td></tr>

<!-- Body -->
<tr><td style="padding:2rem">
${bodyHtml}
</td></tr>

<!-- Footer -->
<tr><td style="padding:1.5rem 2rem;border-top:1px solid rgba(184,152,90,.1);text-align:center">
  <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.7rem;color:rgba(245,242,237,.25);letter-spacing:.06em">Westmere Private Hire &middot; Licensed by Lewes District Council</p>
  <p style="margin:.4rem 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.7rem;color:rgba(245,242,237,.2)">Questions? Simply reply to this email.</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function row(label, value, highlight) {
  return `<tr>
  <td style="padding:.65rem 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(184,152,90,.5);vertical-align:top;width:110px">${label}</td>
  <td style="padding:.65rem 0;padding-left:.8rem;font-family:'Georgia','Times New Roman',serif;font-size:.95rem;color:${highlight ? '#B8985A' : '#F5F2ED'};${highlight ? 'font-weight:600;font-style:italic' : 'font-weight:300'}">${value}</td>
</tr>`;
}

function divider() {
  return '<tr><td colspan="2" style="padding:.3rem 0"><div style="border-top:1px solid rgba(184,152,90,.08)"></div></td></tr>';
}

// ── Customer booking confirmation ────────────────────────────────────────
async function sendCustomerConfirmation(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : null;

  let rows = '';
  rows += row('Reference', ref, true);
  rows += divider();
  rows += row('Passenger', name);
  rows += divider();
  rows += row('Pickup', pickup);
  rows += row('Destination', destination);
  rows += divider();
  rows += row('Date', dateStr);
  if (flight) { rows += row('Flight', flight); }
  rows += divider();
  if (fareStr) { rows += row('Fare', fareStr, true); }
  rows += row('Payment', payment === 'card' ? 'Paid online \u2713' : 'Pay driver on arrival');

  const body = `
  <h2 style="margin:0 0 .3rem;font-family:'Georgia','Times New Roman',serif;font-size:1.15rem;font-weight:400;font-style:italic;color:#F5F2ED">Booking Confirmed</h2>
  <p style="margin:0 0 1.8rem;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.78rem;color:rgba(245,242,237,.35);font-weight:300">Your journey has been reserved</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${rows}
  </table>
  <div style="margin-top:2rem;padding:1.2rem;background:rgba(184,152,90,.06);border:1px solid rgba(184,152,90,.12);border-radius:10px;text-align:center">
    <p style="margin:0;font-family:'Georgia','Times New Roman',serif;font-size:.85rem;font-style:italic;color:rgba(245,242,237,.5)">Thank you for choosing Westmere</p>
  </div>`;

  const html = emailShell(body);
  const ok = await sendEmail(email, 'Booking Confirmed \u2014 ' + ref, html, 'Westmere Private Hire');
  if (ok) console.log('[EMAIL] Customer confirmation sent (' + ref + ')');
}

// ── Admin booking alert ──────────────────────────────────────────────────
async function sendAdminAlert(booking) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return;

  const { ref, name, phone, email, pickup, destination, date, time, fare, payment, flight, passengers, bags, notes } = booking;
  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : 'TBC';

  let rows = '';
  rows += row('Reference', ref, true);
  rows += divider();
  rows += row('Passenger', name);
  rows += row('Phone', '<a href="tel:' + phone + '" style="color:#B8985A;text-decoration:none">' + phone + '</a>');
  rows += row('Email', '<a href="mailto:' + email + '" style="color:rgba(245,242,237,.6);text-decoration:none;font-size:.85rem">' + email + '</a>');
  rows += divider();
  rows += row('Pickup', pickup);
  rows += row('Destination', destination);
  rows += divider();
  rows += row('Date', dateStr);
  if (flight) { rows += row('Flight', flight); }
  rows += row('Passengers', (passengers || 1).toString());
  if (bags && bags !== '0' && bags !== '0s+0l') { rows += row('Luggage', bags); }
  rows += divider();
  rows += row('Fare', fareStr, true);
  rows += row('Payment', payment === 'card'
    ? '<span style="color:#4CAF50;font-weight:600">PAID ONLINE</span>'
    : '<span style="color:#B8985A;font-weight:600">PAY DRIVER</span>');
  if (notes) { rows += divider(); rows += row('Notes', notes); }

  const body = `
  <h2 style="margin:0 0 .3rem;font-family:'Georgia','Times New Roman',serif;font-size:1.15rem;font-weight:400;font-style:italic;color:#F5F2ED">New Booking</h2>
  <p style="margin:0 0 1.8rem;font-family:'Helvetica Neue',Arial,sans-serif;font-size:.78rem;color:rgba(245,242,237,.35);font-weight:300">${pickup} \u2192 ${destination}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${rows}
  </table>`;

  const html = emailShell(body);
  const ok = await sendEmail(adminEmail, '[BOOKING] ' + ref + ' \u2014 ' + name + ' \u2014 ' + pickup + ' \u2192 ' + destination, html, 'Westmere Bookings');
  if (ok) console.log('[EMAIL] Admin alert sent (' + ref + ')');
}

// ── Helper: format date nicely ───────────────────────────────────────────
function formatDate(date, time) {
  if (!date) return 'Not specified';
  try {
    const d = new Date(date + 'T' + (time || '00:00'));
    const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    let str = d.toLocaleDateString('en-GB', opts);
    if (time) str += ' at ' + time;
    return str;
  } catch (e) {
    return date + (time ? ' at ' + time : '');
  }
}

module.exports = { sendCustomerConfirmation, sendAdminAlert, sendEmail, isConfigured };
