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

// ── Full-width premium email shell ──────────────────────────────────────
function emailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Westmere Private Hire</title>
<!--[if mso]><style>table,td{font-family:Georgia,serif!important}h1,h2,h3{font-family:Georgia,serif!important}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0A0E14;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">

<!-- Full-width dark background -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0A0E14">
<tr><td align="center" style="padding:0">

<!-- Main container — full width on mobile, 640px max on desktop -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#111D2C;border-collapse:collapse">

<!-- Top gold accent line -->
<tr><td style="height:3px;background:linear-gradient(90deg,transparent 0%,#B8985A 20%,#C9A96E 50%,#B8985A 80%,transparent 100%);font-size:0;line-height:0">&nbsp;</td></tr>

<!-- Header: W crest + brand -->
<tr><td style="padding:48px 40px 36px;text-align:center;background-color:#111D2C">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td style="width:72px;height:72px;border:1.5px solid rgba(184,152,90,.4);text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:400;color:#B8985A;letter-spacing:2px">W</td></tr>
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:20px">
    <tr><td style="width:40px;height:1px;background-color:#B8985A;font-size:0;line-height:0">&nbsp;</td></tr>
  </table>
  <h1 style="margin:18px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;font-style:italic;color:#B8985A;letter-spacing:6px;line-height:1">WESTMERE</h1>
  <p style="margin:6px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:rgba(184,152,90,.45);font-weight:400">PRIVATE HIRE &middot; SUSSEX</p>
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 40px"><div style="border-top:1px solid rgba(184,152,90,.12)"></div></td></tr>

<!-- Body content -->
<tr><td style="padding:36px 40px 40px">
${bodyHtml}
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 40px"><div style="border-top:1px solid rgba(184,152,90,.08)"></div></td></tr>

<!-- Footer -->
<tr><td style="padding:32px 40px 24px;text-align:center">
  <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:rgba(245,242,237,.2);letter-spacing:1px">Questions? Simply reply to this email or call us.</p>
  <p style="margin:12px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:rgba(245,242,237,.15);letter-spacing:0.5px">Westmere Private Hire &middot; Licensed by Lewes District Council</p>
  <p style="margin:4px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:rgba(245,242,237,.1)">westmereprivatehire.co.uk</p>
</td></tr>

<!-- Bottom gold accent line -->
<tr><td style="height:2px;background:linear-gradient(90deg,transparent 0%,#B8985A 30%,#C9A96E 50%,#B8985A 70%,transparent 100%);font-size:0;line-height:0">&nbsp;</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── Detail row ──────────────────────────────────────────────────────────
function detailRow(label, value, isHighlight) {
  const valStyle = isHighlight
    ? 'font-family:Georgia,serif;font-size:18px;color:#B8985A;font-weight:600;font-style:italic;letter-spacing:0.5px'
    : 'font-family:Georgia,serif;font-size:16px;color:#F5F2ED;font-weight:300;line-height:1.5';
  return `<tr>
  <td style="padding:10px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:rgba(184,152,90,.5);vertical-align:top;width:110px;font-weight:500">${label}</td>
  <td style="padding:10px 0;padding-left:16px;${valStyle}">${value}</td>
</tr>`;
}

function rowDivider() {
  return '<tr><td colspan="2" style="padding:4px 0"><div style="border-top:1px solid rgba(184,152,90,.06)"></div></td></tr>';
}

// ── Customer booking confirmation ────────────────────────────────────────
async function sendCustomerConfirmation(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight, passengers } = booking;
  if (!email) return;

  const firstName = (name || '').split(' ')[0] || 'there';
  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : null;

  let rows = '';
  rows += detailRow('Reference', ref, true);
  rows += rowDivider();
  rows += detailRow('Passenger', name);
  if (passengers && passengers > 1) rows += detailRow('Travellers', passengers + ' passengers');
  rows += rowDivider();
  rows += detailRow('Pickup', pickup);
  rows += detailRow('Drop-off', destination);
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) { rows += detailRow('Flight', flight); }
  rows += rowDivider();
  if (fareStr) { rows += detailRow('Fare', fareStr, true); }
  rows += detailRow('Payment', payment === 'card' ? 'Paid online \u2713' : 'Pay driver on arrival');

  const body = `
  <!-- Greeting -->
  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:300;color:#F5F2ED;line-height:1.3">Hello ${firstName},</p>
  <p style="margin:0 0 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:rgba(245,242,237,.4);font-weight:300;line-height:1.6">Your journey has been confirmed. Here are your booking details:</p>

  <!-- Booking details card -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(245,242,237,.03);border:1px solid rgba(184,152,90,.1);border-radius:12px;overflow:hidden">
    <tr><td style="padding:6px 24px 4px;background:rgba(184,152,90,.08)">
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:rgba(184,152,90,.6);font-weight:500">Booking Details</p>
    </td></tr>
    <tr><td style="padding:16px 24px 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows}
      </table>
    </td></tr>
  </table>

  <!-- Route visual -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px">
    <tr>
      <td style="padding:16px 20px;background:rgba(184,152,90,.04);border-left:3px solid #B8985A;border-radius:0 8px 8px 0">
        <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:rgba(184,152,90,.5);font-weight:500">Your Route</p>
        <p style="margin:8px 0 0;font-family:Georgia,serif;font-size:16px;color:#F5F2ED;font-weight:300;line-height:1.5">${pickup}</p>
        <p style="margin:4px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;color:rgba(184,152,90,.4);">\u2193</p>
        <p style="margin:0;font-family:Georgia,serif;font-size:16px;color:#B8985A;font-weight:400;font-style:italic;line-height:1.5">${destination}</p>
      </td>
    </tr>
  </table>

  <!-- Thank you block -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px">
    <tr><td style="padding:24px;text-align:center">
      <p style="margin:0;font-family:Georgia,serif;font-size:18px;font-style:italic;color:rgba(245,242,237,.35);font-weight:300">Thank you for choosing Westmere</p>
      <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:rgba(245,242,237,.2);font-weight:300">We look forward to your journey.</p>
    </td></tr>
  </table>`;

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
  rows += detailRow('Reference', ref, true);
  rows += rowDivider();
  rows += detailRow('Passenger', name);
  rows += detailRow('Phone', '<a href="tel:' + phone + '" style="color:#B8985A;text-decoration:none;font-family:Georgia,serif;font-size:16px">' + phone + '</a>');
  if (email) rows += detailRow('Email', '<a href="mailto:' + email + '" style="color:rgba(245,242,237,.5);text-decoration:none;font-family:Georgia,serif;font-size:14px">' + email + '</a>');
  rows += rowDivider();
  rows += detailRow('Pickup', pickup);
  rows += detailRow('Drop-off', destination);
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) { rows += detailRow('Flight', flight); }
  rows += detailRow('Passengers', (passengers || 1).toString());
  if (bags && bags !== '0' && bags !== '0s+0l') { rows += detailRow('Luggage', bags); }
  rows += rowDivider();
  rows += detailRow('Fare', fareStr, true);
  rows += detailRow('Payment', payment === 'card'
    ? '<span style="color:#4CAF50;font-weight:600;font-family:\'Helvetica Neue\',Arial,sans-serif;font-size:13px;letter-spacing:1px">PAID ONLINE</span>'
    : '<span style="color:#B8985A;font-weight:600;font-family:\'Helvetica Neue\',Arial,sans-serif;font-size:13px;letter-spacing:1px">PAY DRIVER</span>');
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', notes); }

  const body = `
  <!-- Alert banner -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
    <tr><td style="padding:14px 20px;background:rgba(184,152,90,.1);border:1px solid rgba(184,152,90,.2);border-radius:8px;text-align:center">
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#B8985A;font-weight:600">New Booking Received</p>
    </td></tr>
  </table>

  <!-- Route summary -->
  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:20px;font-weight:300;color:#F5F2ED;line-height:1.3">${name}</p>
  <p style="margin:0 0 28px;font-family:Georgia,serif;font-size:15px;color:rgba(245,242,237,.4);font-weight:300;font-style:italic">${pickup} \u2192 ${destination}</p>

  <!-- Booking details card -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(245,242,237,.03);border:1px solid rgba(184,152,90,.1);border-radius:12px;overflow:hidden">
    <tr><td style="padding:6px 24px 4px;background:rgba(184,152,90,.08)">
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:rgba(184,152,90,.6);font-weight:500">Full Details</p>
    </td></tr>
    <tr><td style="padding:16px 24px 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows}
      </table>
    </td></tr>
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
