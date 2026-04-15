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

async function sendEmail(to, subject, html, fromLabel, preheader) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL] RESEND_API_KEY not set — email disabled');
    return false;
  }

  const replyTo = process.env.GMAIL_USER || process.env.ADMIN_EMAIL || '';

  // Inject a hidden preheader (the snippet email clients show next to the
  // subject) so the inbox preview reads cleanly instead of pulling random
  // body text.
  let finalHtml = html;
  if (preheader) {
    const hidden = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FAF7F1;opacity:0">${preheader}</div>`;
    finalHtml = html.replace('<body', hidden + '<body').replace(/<body([^>]*)>/, '<body$1>' + hidden);
  }

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
        html: finalHtml
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

// ── Refined palette: ivory canvas, deep navy ink, single gold accent ─────
const BG_OUTER    = '#F7F4EE';   // warm ivory page
const BG_CARD     = '#FFFFFF';   // letter card
const INK         = '#0E2540';   // primary type
const INK_SOFT    = '#5A6B7F';   // secondary
const INK_MUTED   = '#9AA3B2';   // labels & footer
const GOLD        = '#B8985A';   // single accent
const HAIRLINE    = 'rgba(14,37,64,0.10)';

// ── Master shell ─────────────────────────────────────────────────────────
function emailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Westmere Private Hire</title>
<!--[if mso]><style>table,td{font-family:Georgia,serif!important}h1,h2,h3{font-family:Georgia,serif!important}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${BG_OUTER};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG_OUTER}">
<tr><td align="center" style="padding:32px 16px">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${BG_CARD};border:1px solid ${HAIRLINE};border-collapse:separate">

<!-- Header: wordmark only, no crest -->
<tr><td style="padding:36px 44px 6px;text-align:center">
  <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:400;color:${INK};letter-spacing:8px;line-height:1">WESTMERE</p>
  <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:3.5px;text-transform:uppercase;color:${INK_MUTED};font-weight:400">Private Hire &middot; Sussex</p>
</td></tr>

<!-- Hairline gold rule -->
<tr><td style="padding:22px 44px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td style="width:32px;height:1px;background:${GOLD};font-size:0;line-height:0">&nbsp;</td>
  </tr></table>
</td></tr>

<!-- Body content -->
<tr><td style="padding:24px 44px 36px">
${bodyHtml}
</td></tr>

<!-- Footer -->
<tr><td style="padding:18px 44px 28px;border-top:1px solid ${HAIRLINE}">
  <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:${INK_MUTED};letter-spacing:.5px;line-height:1.6">Reply to this email or call us if anything needs adjusting.</p>
  <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;color:${INK_MUTED};letter-spacing:.5px">Westmere Private Hire &middot; Licensed by Lewes District Council &middot; westmereprivatehire.co.uk</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── Detail row: clean two-column, no boxes ───────────────────────────────
function detailRow(label, value, opts) {
  opts = opts || {};
  const valSize = opts.large ? 15 : 13;
  const valColor = opts.gold ? GOLD : INK;
  const valWeight = opts.large ? 500 : 400;
  const valStyle = `font-family:Georgia,serif;font-size:${valSize}px;color:${valColor};font-weight:${valWeight};line-height:1.45`;
  return `<tr>
  <td style="padding:9px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:96px;font-weight:500">${label}</td>
  <td style="padding:9px 0 9px 14px;${valStyle}">${value}</td>
</tr>`;
}

function rowDivider() {
  return `<tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>`;
}

// ── Common booking-details table (borderless) ────────────────────────────
function buildDetailsTable(rowsHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rowsHtml}
</table>`;
}

// ── Customer booking RECEIVED (sent immediately on booking) ──────────────
async function sendCustomerConfirmation(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight, passengers } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : null;
  const firstName = (name || '').split(' ')[0] || 'there';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', pickup);
  rows += detailRow('Drop-off', destination);
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', flight);
  if (passengers && passengers > 1) rows += detailRow('Travellers', passengers + ' passengers');
  rows += rowDivider();
  if (fareStr) rows += detailRow('Fare', fareStr, { gold: true, large: true });
  rows += detailRow('Payment', payment === 'card' ? 'Paid online' : 'Pay driver on arrival');

  const body = `
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for your booking request. We have received the details below and will be in touch shortly to confirm your driver.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Booking received \u2014 ' + ref;
  const preheader = 'We have your request; a confirmation email will follow shortly.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer received-notice sent (' + ref + ')');
}

// ── Customer booking CONFIRMED (sent after Claude or operator approves) ──
async function sendCustomerConfirmed(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight, passengers } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : null;
  const firstName = (name || '').split(' ')[0] || 'there';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', pickup);
  rows += detailRow('Drop-off', destination);
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', flight);
  if (passengers && passengers > 1) rows += detailRow('Travellers', passengers + ' passengers');
  rows += rowDivider();
  if (fareStr) rows += detailRow('Fare', fareStr, { gold: true, large: true });
  rows += detailRow('Payment', payment === 'card' ? 'Paid online' : 'Pay driver on arrival');

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Confirmed</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Your journey is confirmed. A driver has been assigned and we look forward to welcoming you on the day.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Booking confirmed \u2014 ' + ref;
  const preheader = 'Your driver has been assigned. We look forward to seeing you.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer confirmed sent (' + ref + ')');
}

// ── Admin booking alert ──────────────────────────────────────────────────
async function sendAdminAlert(booking) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return;

  const { ref, name, phone, email, pickup, destination, date, time, fare, payment, flight, passengers, bags, notes } = booking;
  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : 'TBC';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Passenger', escHtml(name || 'Guest'));
  rows += detailRow('Phone', '<a href="tel:' + escAttr(phone) + '" style="color:' + INK + ';text-decoration:none;font-family:Georgia,serif;font-size:13px">' + escHtml(phone) + '</a>');
  if (email) rows += detailRow('Email', '<a href="mailto:' + escAttr(email) + '" style="color:' + INK_SOFT + ';text-decoration:none;font-family:Georgia,serif;font-size:12px">' + escHtml(email) + '</a>');
  rows += rowDivider();
  rows += detailRow('Pickup', escHtml(pickup));
  rows += detailRow('Drop-off', escHtml(destination));
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (passengers) rows += detailRow('Passengers', String(passengers));
  if (bags && bags !== '0' && bags !== '0s+0l') rows += detailRow('Luggage', escHtml(bags));
  rows += rowDivider();
  rows += detailRow('Fare', fareStr, { gold: true, large: true });
  rows += detailRow('Payment', payment === 'card' ? 'Paid online' : 'Pay driver');
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', escHtml(notes)); }

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">New booking</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">A new booking has just landed. Full details below.</p>
  ${buildDetailsTable(rows)}`;

  const html = emailShell(body);
  const subject = ref + ' \u00b7 ' + (name || 'Guest') + ' \u00b7 ' + pickup + ' \u2192 ' + destination;
  const preheader = (name || 'Guest') + ' \u2014 ' + dateStr;
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Admin alert sent (' + ref + ')');
}

// ── Helpers ──────────────────────────────────────────────────────────────
function formatDate(date, time) {
  if (!date) return 'Not specified';
  try {
    const d = new Date(date + 'T' + (time || '00:00'));
    const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    let str = d.toLocaleDateString('en-GB', opts);
    if (time && time !== 'ASAP') str += ' \u00b7 ' + time;
    else if (time === 'ASAP') str += ' \u00b7 ASAP';
    return str;
  } catch (e) {
    return date + (time ? ' \u00b7 ' + time : '');
  }
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(s) { return escHtml(s); }

module.exports = { sendCustomerConfirmation, sendCustomerConfirmed, sendAdminAlert, sendEmail, isConfigured };
