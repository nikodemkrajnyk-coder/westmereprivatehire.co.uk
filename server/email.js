/**
 * Email service — Resend HTTP API
 *
 * Environment variables:
 *   RESEND_API_KEY — API key from resend.com
 *   GMAIL_USER    — Reply-to address
 *   ADMIN_EMAIL   — Where admin booking alerts go
 */

const RESEND_URL = 'https://api.resend.com/emails';

// Address DISPLAY normalizer — single source of truth (see address-normalize.js).
// Every pickup/drop-off/stop shown to a human goes through dispAddr(); the FULL
// address is still used for Waze/nav links so routing is never broken.
const { shortDisplay } = require('../address-normalize');
function dispAddr(a) { return escHtml(shortDisplay(a || '')); }

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// opts: { attachments: [{ filename, content }] }
// content must be a base64 string for Resend's HTTP API.
async function sendEmail(to, subject, html, fromLabel, preheader, opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL] RESEND_API_KEY not set — email disabled');
    return false;
  }

  const replyTo = process.env.GMAIL_USER || process.env.ADMIN_EMAIL || '';

  let finalHtml = html;
  if (preheader) {
    const hidden = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FAF7F1;opacity:0">${preheader}</div>`;
    finalHtml = html.replace('<body', hidden + '<body').replace(/<body([^>]*)>/, '<body$1>' + hidden);
  }

  const payload = {
    from: (fromLabel || 'Westmere Private Hire') + ' <bookings@westmereprivatehire.co.uk>',
    to,
    reply_to: replyTo || undefined,
    subject,
    html: finalHtml
  };

  if (opts && Array.isArray(opts.attachments) && opts.attachments.length) {
    payload.attachments = opts.attachments;
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[EMAIL] Resend error', res.status, ':', JSON.stringify(data));
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
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Westmere Private Hire</title>
<!--[if mso]><style>table,td{font-family:Georgia,serif!important}h1,h2,h3{font-family:Georgia,serif!important}</style><![endif]-->
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  /* Apple Mail dark mode: keep ivory canvas + navy ink instead of auto-invert. */
  @media (prefers-color-scheme: dark) {
    html, body, table, td { background-color: ${BG_OUTER} !important; color: ${INK} !important; }
    .wm-card { background-color: ${BG_CARD} !important; }
    .wm-ink { color: ${INK} !important; }
    .wm-soft { color: ${INK_SOFT} !important; }
    .wm-muted { color: ${INK_MUTED} !important; }
    .wm-gold { color: ${GOLD} !important; }
    .wm-hairline { border-color: ${HAIRLINE} !important; }
  }
  /* Gmail iOS dark mode (uses [data-ogsc] / [data-ogsb] attributes). */
  [data-ogsc] body, [data-ogsb] body { background-color: ${BG_OUTER} !important; }
  [data-ogsc] .wm-card, [data-ogsb] .wm-card { background-color: ${BG_CARD} !important; }
  [data-ogsc] .wm-ink, [data-ogsb] .wm-ink { color: ${INK} !important; }
  [data-ogsc] .wm-soft, [data-ogsb] .wm-soft { color: ${INK_SOFT} !important; }
  [data-ogsc] .wm-muted, [data-ogsb] .wm-muted { color: ${INK_MUTED} !important; }
  [data-ogsc] .wm-gold, [data-ogsb] .wm-gold { color: ${GOLD} !important; }
</style>
</head>
<body class="wm-ink" style="margin:0;padding:0;background:${BG_OUTER};color:${INK};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG_OUTER}" bgcolor="${BG_OUTER}">
<tr><td align="center" style="padding:32px 16px" bgcolor="${BG_OUTER}">

<table role="presentation" class="wm-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG_CARD}" style="max-width:560px;background:${BG_CARD};border:1px solid ${HAIRLINE};border-collapse:separate">

<!-- Header: wordmark only, no crest -->
<tr><td bgcolor="${BG_CARD}" style="padding:36px 44px 6px;text-align:center;background:${BG_CARD}">
  <p class="wm-ink" style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:400;color:${INK};letter-spacing:8px;line-height:1">WESTMERE</p>
  <p class="wm-muted" style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:3.5px;text-transform:uppercase;color:${INK_MUTED};font-weight:400">Private Hire &middot; Sussex</p>
</td></tr>

<!-- Hairline gold rule -->
<tr><td bgcolor="${BG_CARD}" style="padding:22px 44px 0;background:${BG_CARD}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td style="width:32px;height:1px;background:${GOLD};font-size:0;line-height:0" bgcolor="${GOLD}">&nbsp;</td>
  </tr></table>
</td></tr>

<!-- Body content -->
<tr><td bgcolor="${BG_CARD}" style="padding:24px 44px 36px;background:${BG_CARD}">
${bodyHtml}
</td></tr>

<!-- Footer -->
<tr><td bgcolor="${BG_CARD}" style="padding:18px 44px 28px;border-top:1px solid ${HAIRLINE};background:${BG_CARD}">
  <p class="wm-muted" style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:${INK_MUTED};letter-spacing:.5px;line-height:1.6">Reply to this email or call us if anything needs adjusting.</p>
  <p class="wm-muted" style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;color:${INK_MUTED};letter-spacing:.5px">Westmere Private Hire &middot; Licensed by Lewes District Council &middot; westmereprivatehire.co.uk</p>
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

// ── Customer ACKNOWLEDGEMENT (auto-sent the instant a booking is submitted) ──────────────
// A branded "thank you, we'll be in touch" receipt that goes out immediately on
// submission \u2014 separate from, and NOT a replacement for, the owner's manual Send
// Estimate step (which follows with tokenised payment links). It shows the INSTANT
// estimated fare (the same quick-estimate figure), clearly framed as an estimate,
// plus the reference and journey details in the SHORT address format.
async function sendCustomerAcknowledgement(booking) {
  const { ref, name, email, pickup, destination, date, time, flight, passengers, stop_address, notes } = booking;
  if (!email) return false;

  // Estimated fare = the server-side quick-estimate for this route (may be absent
  // for custom journeys the engine can't auto-price \u2014 then we skip the number).
  const rawEst = booking.estimated_fare != null ? booking.estimated_fare
               : (booking.suggested_fare != null ? booking.suggested_fare : booking.fare);
  const estNum = typeof rawEst === 'number' ? rawEst : parseFloat(rawEst);
  const hasEst = estNum && !isNaN(estNum);
  const money  = (n) => (n % 1 === 0) ? String(n) : n.toFixed(2);
  const estStr = hasEst ? ('~\u00a3' + money(estNum)) : null;

  const dateStr = formatDate(date, time);
  const firstName = (name || '').split(' ')[0] || 'there';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + escHtml(ref) + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  if (stop_address) rows += detailRow('Stop', dispAddr(stop_address));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (passengers && passengers > 1) rows += detailRow('Travellers', passengers + ' passengers');
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', escHtml(notes)); }
  rows += rowDivider();
  if (estStr) rows += detailRow('Estimated fare', estStr, { gold: true, large: true });

  // The estimate caveat \u2014 make it unmistakable this is not the final price.
  const estCaption = estStr
    ? `<p style="margin:14px 0 0;font-family:Georgia,serif;font-size:12px;color:${INK_SOFT};line-height:1.6;text-align:center">Estimated fare: <span style="color:${INK}">${estStr}</span> \u2014 we'll confirm your exact price shortly.</p>`
    : `<p style="margin:14px 0 0;font-family:Georgia,serif;font-size:12px;color:${INK_SOFT};line-height:1.6;text-align:center">We'll confirm your exact fare shortly.</p>`;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Booking received</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for booking with us \u2014 we will be in touch shortly.</p>
  ${buildDetailsTable(rows)}
  ${estCaption}
  <p style="margin:24px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Thank you for booking \u2014 ' + ref;
  const preheader = (estStr ? ('Estimated fare ' + estStr + ' \u2014 ') : '') + 'we\'ve received your booking and will be in touch shortly.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer acknowledgement sent (' + ref + ')');
  return ok;
}

// ── Customer booking CONFIRMED (sent after Claude or operator approves) ──
async function sendCustomerConfirmed(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight, passengers, pay_token, paid, stop_address, notes } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareNum = typeof fare === 'number' ? fare : parseFloat(fare);
  const fareStr = (fareNum && !isNaN(fareNum)) ? ('£' + fareNum.toFixed(2)) : null;
  const firstName = (name || '').split(' ')[0] || 'there';
  const alreadyPaid = paid || payment === 'card';

  const html = confirmationEmailHtml({
    ref, firstName, pickup, stop_address, destination, dateStr, flight, passengers,
    fareStr, alreadyPaid, pay_token, notes
  });
  const subject = 'Booking confirmed — ' + ref;
  const preheader = 'Your driver has been assigned. We look forward to seeing you.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer confirmed sent (' + ref + ')');
}

// New Westmere confirmation template (approved design). Mail-safe (tables +
// inline styles, hosted PNG icons) so it renders in Gmail / Apple Mail /
// Outlook. Cream card, gold-hairline brand header, coastal banner, gold
// outline row icons, dark footer. Intended shared shell for system emails.
const HOST = 'https://westmereprivatehire.co.uk';
function confRow(icon, label, valueHtml, opts) {
  opts = opts || {};
  const valStyle = opts.fare
    ? "font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;color:#b78635"
    : "font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.5;color:#1d1d1d";
  return `<tr>
    <td width="26" valign="top" style="padding:15px 0 0;border-bottom:1px solid #efe9dd"><img src="${HOST}/assets/${icon}.png" width="20" height="20" alt="" style="display:block;border:0;outline:none;line-height:100%"></td>
    <td width="98" valign="top" style="padding:17px 10px 15px 8px;border-bottom:1px solid #efe9dd;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:#8a857c;font-weight:700">${label}</td>
    <td valign="top" style="padding:15px 0;border-bottom:1px solid #efe9dd;${valStyle}">${valueHtml}</td>
  </tr>`;
}
function confBtn(href, icon, text) {
  return `<tr><td style="padding-bottom:12px">
    <a href="${href}" style="display:block;text-decoration:none;border:1px solid #1b1b1a;border-radius:10px;padding:14px 16px;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:1.3px;text-transform:uppercase;color:#1b1b1a;background:#fbfaf7">
      <img src="${HOST}/assets/${icon}.png" width="17" height="17" alt="" style="vertical-align:-3px;border:0;margin-right:9px">${text}</a>
  </td></tr>`;
}
function confirmationEmailHtml(d) {
  let rows = '';
  rows += confRow('ic-reference', 'Reference', `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:#1b1b1a">${escHtml(d.ref)}</span>`);
  rows += confRow('ic-pickup', 'Pickup', dispAddr(d.pickup));
  if (d.stop_address) rows += confRow('ic-stop', 'Stop', dispAddr(d.stop_address));
  rows += confRow('ic-dropoff', 'Drop-off', dispAddr(d.destination));
  rows += confRow('ic-datetime', 'Date &amp; Time', escHtml(d.dateStr));
  if (d.flight) rows += confRow('ic-flight', 'Flight', escHtml(d.flight));
  if (d.passengers && d.passengers > 1) rows += confRow('ic-travellers', 'Travellers', d.passengers + ' passengers');
  if (d.fareStr) rows += confRow('ic-fare', 'Fare', escHtml(d.fareStr), { fare: true });
  rows += confRow('ic-payment', 'Payment', d.alreadyPaid ? 'Paid online' : 'Choose below');

  let payBlock = '';
  if (!d.alreadyPaid && d.pay_token && d.fareStr) {
    const payUrl  = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(d.ref)}&t=${encodeURIComponent(d.pay_token)}`;
    const cashUrl = `${HOST}/api/public/pay/${encodeURIComponent(d.ref)}/cash?t=${encodeURIComponent(d.pay_token)}`;
    payBlock = `<tr><td style="padding:22px 40px 6px;background:#fbfaf7">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${confBtn(payUrl, 'ic-paynow', 'Pay Now &mdash; Apple Pay, Google Pay, or Card')}
        ${confBtn(cashUrl, 'ic-cash', 'Cash')}
      </table>
      <p style="margin:14px 0 4px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#6f6b64;line-height:1.6;text-align:center">Pay <strong style="color:#b78635">${escHtml(d.fareStr)}</strong> securely now, or settle with your driver on the day.</p>
    </td></tr>`;
  }

  // Secure actions available whenever we have the per-booking token: the
  // customer can add a special-requirement note, or cancel the request if the
  // price/timing doesn't suit. Both use the tokenised /api/public links (no
  // login) and mirror how the Pay/Cash links are secured.
  let actionsBlock = '';
  if (d.pay_token) {
    const noteUrl   = `${HOST}/api/public/note/${encodeURIComponent(d.ref)}?t=${encodeURIComponent(d.pay_token)}`;
    const cancelUrl = `${HOST}/api/public/cancel/${encodeURIComponent(d.ref)}?t=${encodeURIComponent(d.pay_token)}`;
    actionsBlock = `<tr><td style="padding:6px 40px 8px;background:#fbfaf7">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:12px">
          <a href="${cancelUrl}" style="display:block;text-decoration:none;border:1px solid #c9a3a3;border-radius:10px;padding:14px 16px;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:1.3px;text-transform:uppercase;color:#9a4a4a;background:#fbf6f5">Cancel Request</a>
        </td></tr>
      </table>
      <p style="margin:2px 0 4px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#6f6b64;line-height:1.6;text-align:center">Any special requirements (child seat, extra luggage, meet &amp; greet)? <a href="${noteUrl}" style="color:#b78635;font-weight:600;text-decoration:underline">Add a note</a> for your driver.</p>
    </td></tr>`;
  }

  const notesBlock = d.notes ? `<tr><td style="padding:4px 40px 8px;background:#fbfaf7">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:14px 16px;background:#f6efe1;border-left:2px solid #b78635">
        <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#b78635;font-weight:700">A message from Westmere</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#1b1b1a;line-height:1.6">${escHtml(d.notes).replace(/\n/g, '<br>')}</p>
      </td></tr></table>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Westmere &mdash; Booking Confirmation</title>
<!--[if mso]><style>table,td,a{font-family:Georgia,serif}</style><![endif]-->
<style>:root{color-scheme:light only;supported-color-schemes:light only}
@media(max-width:600px){.wm-pad{padding-left:22px!important;padding-right:22px!important}.wm-badge{display:block!important;width:100%!important;text-align:left!important;padding:14px 0 0 0!important}}</style>
</head>
<body style="margin:0;padding:0;background:#e7e4df;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7e4df" style="background:#e7e4df">
<tr><td align="center" style="padding:26px 14px">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#fbfaf7" style="width:600px;max-width:600px;background:#fbfaf7;border:1px solid #e2ddd3;border-radius:16px;overflow:hidden">

<tr><td align="center" style="padding:28px 20px 18px;background:#fbfaf7">
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#b78635;letter-spacing:1px;line-height:1">W</div>
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:29px;letter-spacing:11px;color:#1b1b1a;font-weight:400;margin-top:6px">WESTMERE</div>
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:5px;color:#b78635;text-transform:uppercase;margin-top:9px">Private Hire &middot; Sussex</div>
  <div style="width:60px;height:1px;background:#d9c8a8;line-height:1px;font-size:0;margin:14px auto 0">&nbsp;</div>
</td></tr>

<tr><td style="font-size:0;line-height:0;background:#fbfaf7"><img src="${HOST}/assets/westmere-email-hero.jpg" width="600" alt="Westmere car on the Sussex coast" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none"></td></tr>

<tr><td class="wm-pad" style="padding:30px 40px 6px;background:#fbfaf7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="top">
      <p style="margin:0 0 12px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#b78635;font-weight:700">Confirmed</p>
      <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#1b1b1a;line-height:1.15">Dear ${escHtml(d.firstName)},</h1>
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.65;color:#57544e">Your journey is confirmed. A driver has been assigned and we look forward to welcoming you on the day.</p>
    </td>
    <td class="wm-badge" valign="top" width="118" align="center" style="width:118px;padding-left:10px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td width="58" height="58" align="center" valign="middle" style="width:58px;height:58px;border:1px solid #cdb884;border-radius:50%;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#b78635;text-align:center">W</td></tr></table>
      <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#a99a7d;line-height:1.5">Thank you for travelling with us</p>
    </td>
  </tr></table>
</td></tr>

<tr><td class="wm-pad" style="padding:14px 40px 6px;background:#fbfaf7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e4dccb">
    ${rows}
  </table>
</td></tr>

${payBlock}
${notesBlock}
${actionsBlock}

<tr><td style="padding:22px 40px;background:#f4f1ea;border-top:1px solid #ece5d8">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="60" valign="middle"><img src="${HOST}/assets/westmere-email-thumb.jpg" width="60" height="60" alt="Westmere Private Hire" style="display:block;width:60px;height:60px;border-radius:50%;border:1px solid #dfd2bd"></td>
    <td valign="middle" style="padding-left:16px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#3a382f">With kind regards,<br><strong style="font-size:18px;color:#1b1b1a">Westmere Private Hire</strong></td>
  </tr></table>
</td></tr>

<tr><td style="padding:24px 30px;background:#191919;text-align:center">
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.7;color:#e8e8e8"><a href="tel:+447930342593" style="color:#e7c27f;text-decoration:none">07930 342593</a> &middot; <a href="mailto:bookings@westmereprivatehire.co.uk" style="color:#e7c27f;text-decoration:none">bookings@westmereprivatehire.co.uk</a> &middot; <a href="${HOST}" style="color:#e7c27f;text-decoration:none">westmereprivatehire.co.uk</a></p>
  <p style="margin:0 0 4px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.7;color:#cfcfcf">Reply to this email or call us if anything needs adjusting.</p>
  <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.7;color:#cfcfcf">Westmere Private Hire &middot; Licensed Private Hire Operator</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── Customer ESTIMATE (operator sends a manual quote for a request) ──────
// The customer no longer sees a fare when booking — they request an estimate.
// The owner reviews the request, sets a price, and sends this email. The
// booking stays pending until the customer replies to confirm.
async function sendCustomerEstimate(booking) {
  const ref         = booking.ref;
  const name        = booking.name  || booking.passenger_name;
  const email       = booking.email || booking.passenger_email;
  const pickup      = booking.pickup;
  const destination = booking.destination;
  const { date, time, flight, passengers, fare, stop_address, notes, pay_token } = booking;
  if (!email) return false;

  const fareNum = typeof fare === 'number' ? fare : parseFloat(fare);
  if (!fareNum || isNaN(fareNum)) return false;
  const fareStr = '£' + fareNum.toFixed(2);

  const dateStr = formatDate(date, time);
  const firstName = (name || '').split(' ')[0] || 'there';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + escHtml(ref) + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  if (stop_address) rows += detailRow('Stop', dispAddr(stop_address));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (passengers && passengers > 1) rows += detailRow('Travellers', passengers + ' passengers');
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', escHtml(notes)); }
  rows += rowDivider();
  rows += detailRow('Estimated fare', fareStr, { gold: true, large: true });

  // How the customer turns this ESTIMATE into a confirmed booking. Three
  // tokenised actions, all secured by the per-booking pay_token (same scheme as
  // the confirmation email). The booking stays PENDING until the customer acts:
  //   • Pay Now (card) → Stripe → webhook confirms + records 'card'
  //   • Pay driver on the day → /cash → confirms + records 'cash'
  //   • Cancel → /cancel → cancels
  // Without a token we cannot offer secure actions, so fall back to reply/call.
  let actionBlock;
  if (pay_token) {
    const payUrl    = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(pay_token)}`;
    const cashUrl   = `${HOST}/api/public/pay/${encodeURIComponent(ref)}/cash?t=${encodeURIComponent(pay_token)}`;
    const cancelUrl = `${HOST}/api/public/cancel/${encodeURIComponent(ref)}?t=${encodeURIComponent(pay_token)}`;
    const estBtn = (href, bg, color, brd, text) =>
      `<tr><td style="padding-bottom:11px"><a href="${href}" style="display:block;text-decoration:none;background:${bg};color:${color};border:1px solid ${brd};border-radius:10px;padding:14px 16px;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:1.3px;text-transform:uppercase">${text}</a></td></tr>`;
    actionBlock = `
  <p style="margin:22px 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.6;text-align:center">To confirm your journey, choose how you'd like to pay:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${estBtn(payUrl, INK, '#ffffff', INK, 'Pay Now &mdash; Card, Apple Pay or Google Pay')}
    ${estBtn(cashUrl, '#fbfaf7', INK, '#d8cfbe', 'Pay Your Driver On The Day')}
  </table>
  <p style="margin:6px 0 0;font-family:Georgia,serif;font-size:12px;color:${INK_SOFT};line-height:1.55;text-align:center">Nothing is confirmed until you choose. Changed your mind? <a href="${cancelUrl}" style="color:#9a4a4a;text-decoration:underline">Cancel this request</a>, reply to this email, or call <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930&nbsp;342593</a>.</p>`;
  } else {
    actionBlock = `
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.55;text-align:center">To confirm, simply reply to this email or call us on <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930 342593</a>. Nothing is confirmed until you're ready.</p>`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Your estimate</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for your enquiry. Below is the estimated fare for your journey — this is a quote, not yet a confirmed booking.</p>
  ${buildDetailsTable(rows)}
  ${actionBlock}
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Your estimate — ' + ref;
  const preheader = 'Estimated fare ' + fareStr + ' — pay by card, pay your driver, or reply to confirm.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer estimate sent (' + ref + ')');
  return ok;
}

// ── Admin booking alert ──────────────────────────────────────────────────
async function sendAdminAlert(booking) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return;

  const { ref, name, phone, email, pickup, destination, date, time, fare, payment, flight, passengers, bags, notes, stop_address } = booking;
  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : 'TBC';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Passenger', escHtml(name || 'Guest'));
  rows += detailRow('Phone', '<a href="tel:' + escAttr(phone) + '" style="color:' + INK + ';text-decoration:none;font-family:Georgia,serif;font-size:13px">' + escHtml(phone) + '</a>');
  if (email) rows += detailRow('Email', '<a href="mailto:' + escAttr(email) + '" style="color:' + INK_SOFT + ';text-decoration:none;font-family:Georgia,serif;font-size:12px">' + escHtml(email) + '</a>');
  rows += rowDivider();
  // Pickup + destination with Waze navigation links for quick tap-to-navigate.
  const puQ = encodeURIComponent(pickup || '');
  const deQ = encodeURIComponent(destination || '');
  const puWaze    = 'https://waze.com/ul?q=' + puQ + '&navigate=yes';
  const routeWaze = 'https://waze.com/ul?q=' + deQ + '&navigate=yes';
  const navLink = (url) =>
    ' <a href="' + url + '" style="color:' + GOLD + ';font-family:Helvetica Neue,Arial,sans-serif;font-size:10px;letter-spacing:.5px;text-decoration:none;margin-left:8px">Waze</a>';
  // DISPLAY is shortened; the Waze q= above keeps the FULL address for routing.
  rows += detailRow('Pickup', dispAddr(pickup) + navLink(puWaze));
  if (stop_address) {
    const stopQ = encodeURIComponent(stop_address);
    const stopWaze = 'https://waze.com/ul?q=' + stopQ + '&navigate=yes';
    rows += detailRow('Stop', dispAddr(stop_address) + navLink(stopWaze));
  }
  rows += detailRow('Drop-off', dispAddr(destination) + navLink(routeWaze));
  rows += rowDivider();
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (passengers) rows += detailRow('Passengers', String(passengers));
  if (bags && bags !== '0' && bags !== '0s+0l') rows += detailRow('Luggage', escHtml(bags));
  rows += rowDivider();
  rows += detailRow('Fare', fareStr, { gold: true, large: true });
  rows += detailRow('Payment', payment === 'card' ? 'Paid online' : (payment === 'cash' ? 'Cash on the day' : 'To be decided'));
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', escHtml(notes)); }

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">New booking</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">A new booking has just landed. Full details below.</p>
  ${buildDetailsTable(rows)}`;

  const html = emailShell(body);
  const subject = ref + ' \u00b7 ' + (name || 'Guest') + ' \u00b7 ' + shortDisplay(pickup) + ' \u2192 ' + shortDisplay(destination);
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

// ── Account welcome (sent when admin opens an invoicing account) ─────────
async function sendCustomerWelcome(customer) {
  if (!customer || !customer.email) return;
  const { email, full_name } = customer;
  const firstName = (full_name || '').split(' ')[0] || 'there';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Account opened</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for choosing Westmere Private Hire. Your account has been opened and is ready to use.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding:9px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:120px;font-weight:500">Account holder</td>
      <td style="padding:9px 0 9px 14px;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.45">${escHtml(full_name || '')}</td>
    </tr>
  </table>

  <p style="margin:24px 0 8px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">How it works:</p>
  <ul style="margin:0 0 18px;padding:0 0 0 18px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">
    <li>Book any journey by phone, email, or WhatsApp &mdash; just mention your name</li>
    <li>You'll receive a confirmation for every booking, with driver details</li>
    <li>We will send you an itemised invoice for your journeys &mdash; pay by bank transfer at your convenience</li>
  </ul>

  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Your Westmere account is ready';
  const preheader = 'Your account has been opened. Book any journey by phone, email, or WhatsApp.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Welcome sent to', email);
}

// ── Invoice (sent to account customers with all their journeys) ──────────
// `bookings` = array of { ref, date, time, pickup, destination, fare, flight, passengers }
// `period`   = { label: 'November 2025', dueDate: 'YYYY-MM-DD' }
// `invoiceNo`= 'INV-202511-0001'
// `settings` = { business_name, owner_name, address_line1, address_line2, postcode, phone, email, bank_name, sort_code, account_no, account_name }
// `pdfBuffer` = optional Buffer — attached to the email as a PDF file
async function sendCustomerInvoice(customer, bookings, period, invoiceNo, settings, pdfBuffer) {
  if (!customer || !customer.email) return false;
  const { email, full_name } = customer;
  const firstName = (full_name || '').split(' ')[0] || 'there';
  settings = settings || {};

  const rows = (bookings || []).map(b => {
    const fare = +b.fare || 0;
    const dateStr = formatDate(b.date, b.time);
    const routeStr = dispAddr(b.pickup) + ' &rarr; ' + dispAddr(b.destination);
    const refStr = '<span style="font-family:Menlo,Consolas,monospace;font-size:11px;color:' + INK_MUTED + '">' + escHtml(b.ref || '') + '</span>';
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:12px;color:${INK};vertical-align:top">
        <div>${escHtml(dateStr)}</div>
        <div style="margin-top:3px">${refStr}</div>
      </td>
      <td style="padding:10px 10px;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:12px;color:${INK};line-height:1.45;vertical-align:top">${routeStr}${b.flight ? '<div style="color:' + INK_MUTED + ';font-size:11px;margin-top:3px">Flight ' + escHtml(b.flight) + '</div>' : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:13px;color:${INK};text-align:right;vertical-align:top;white-space:nowrap">&pound;${fare.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const subtotal = (bookings || []).reduce((s, b) => s + (+b.fare || 0), 0);
  const total = subtotal;
  const summaryCount = (bookings || []).length;
  const dueStr = period && period.dueDate ? formatDate(period.dueDate, null) : '';

  const fromAddr = [
    settings.business_name || 'Westmere Private Hire',
    settings.owner_name || '',
    settings.address_line1 || '',
    [settings.address_line2, settings.postcode].filter(Boolean).join(' '),
    settings.phone || '',
    settings.email || ''
  ].filter(Boolean).map(l => escHtml(l)).join('<br>');

  const bankSection = (settings.sort_code && settings.account_no) ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;background:rgba(14,37,64,0.04);border:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 18px">
      <p style="margin:0 0 8px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Payment details</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${settings.bank_name ? `<tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Bank</td><td style="padding:3px 0 3px 10px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.bank_name)}</td></tr>` : ''}
        ${settings.account_name ? `<tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Name</td><td style="padding:3px 0 3px 10px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.account_name)}</td></tr>` : ''}
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Sort code</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.sort_code)}</td></tr>
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Account no.</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.account_no)}</td></tr>
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Reference</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(invoiceNo)}</td></tr>
      </table>
    </td></tr>
  </table>` : `<p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Payment is appreciated within 14 days by bank transfer. Please contact us for account details.</p>`;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Invoice &middot; ${escHtml(period.label || '')}</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 10px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please find attached your invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo)}</span> for ${escHtml(period.label || 'this period')}.</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">The total amount is <strong style="color:${INK}">&pound;${total.toFixed(2)}</strong>. Payment details are included below for your convenience.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Invoice no.</td>
      <td style="padding:6px 0 6px 14px;font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK}">${escHtml(invoiceNo || '')}</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">From</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:12px;color:${INK};line-height:1.6">${fromAddr}</td>
    </tr>
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Bill to</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(full_name || '')}${customer.phone ? '<br><span style="font-size:12px;color:' + INK_SOFT + '">' + escHtml(customer.phone) + '</span>' : ''}${customer.email ? '<br><span style="font-size:12px;color:' + INK_SOFT + '">' + escHtml(customer.email) + '</span>' : ''}</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px">
    <thead>
      <tr>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:500">Date &amp; Ref</th>
        <th style="padding:0 10px 8px;border-bottom:2px solid ${INK};font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:500">Journey</th>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:500">Fare</th>
      </tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="3" style="padding:22px 0;text-align:center;font-family:Georgia,serif;font-size:13px;color:${INK_MUTED};font-style:italic">No journeys in this period.</td></tr>`}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="padding:14px 10px 6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:500">Subtotal (${summaryCount} journey${summaryCount === 1 ? '' : 's'})</td>
        <td style="padding:14px 0 6px;font-family:Georgia,serif;font-size:13px;color:${INK};text-align:right">&pound;${subtotal.toFixed(2)}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding:6px 10px 6px 0;border-top:1px solid ${HAIRLINE};font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total</td>
        <td style="padding:6px 0;border-top:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:18px;color:${GOLD};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${bankSection}

  <div style="text-align:center;margin:28px 0 10px">
    <a href="https://westmereprivatehire.co.uk/api/public/invoice/${escHtml(invoiceNo)}/pdf" style="display:inline-block;padding:13px 32px;background:#0E2540;color:#ffffff;text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:.03em">Download Invoice PDF</a>
  </div>

  <p style="margin:18px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">We hope this is all in order. If you have any questions or would like to discuss anything, please don't hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>
  <p style="margin:12px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Thank you as always for choosing Westmere Private Hire. We look forward to welcoming you on your next journey.</p>
  <p style="margin:16px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Invoice ' + (invoiceNo || '') + ' \u2014 ' + (period.label || '');
  const preheader = summaryCount + ' journey' + (summaryCount === 1 ? '' : 's') + ' \u00b7 \u00a3' + total.toFixed(2) + ' total';
  let attachments;
  if (pdfBuffer) {
    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    attachments = [{ filename: (invoiceNo || 'invoice') + '.pdf', content: buf.toString('base64') }];
    console.log('[EMAIL] Attaching PDF:', (invoiceNo || 'invoice') + '.pdf', buf.length, 'bytes');
  } else {
    console.warn('[EMAIL] No PDF buffer — sending invoice', invoiceNo, 'without attachment');
  }
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader, attachments ? { attachments } : undefined);
  if (ok) console.log('[EMAIL] Invoice', invoiceNo, 'sent to', email, pdfBuffer ? '(with PDF)' : '(NO attachment)');
  return ok;
}

// ── Bespoke invoice (one-off, no bookings) ───────────────────────────────
// `recipient` = { name, email, phone, address }
// `items`     = [{ description, amount }]
// `period`    = { dueDate, issuedDate, notes }
// `pdfBuffer` = optional Buffer — attached to the email as a PDF file
async function sendBespokeInvoice(recipient, items, period, invoiceNo, settings, pdfBuffer) {
  if (!recipient || !recipient.email) return false;
  settings = settings || {};
  const firstName = (recipient.name || '').split(' ')[0] || 'there';

  const rows = (items || []).map(it => {
    const amount = +it.amount || 0;
    let datePrefix = '';
    if (it.date && String(it.date).trim()) {
      try {
        datePrefix = new Date(it.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' \u2014 ';
      } catch (_) {}
    }
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.5;vertical-align:top">${datePrefix ? `<span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:${INK_MUTED}">${escHtml(datePrefix)}</span>` : ''}${escHtml(it.description || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:13px;color:${INK};text-align:right;vertical-align:top;white-space:nowrap">&pound;${amount.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const total = (items || []).reduce((s, it) => s + (+it.amount || 0), 0);
  const dueStr = period && period.dueDate ? formatDate(period.dueDate, null) : '';
  const issuedStr = period && period.issuedDate ? formatDate(period.issuedDate, null) : '';

  const fromAddr = [
    settings.business_name || 'Westmere Private Hire',
    settings.owner_name || '',
    settings.address_line1 || '',
    [settings.address_line2, settings.postcode].filter(Boolean).join(' '),
    settings.phone || '',
    settings.email || ''
  ].filter(Boolean).map(l => escHtml(l)).join('<br>');

  const toAddr = [
    escHtml(recipient.name || ''),
    recipient.address ? escHtml(recipient.address).replace(/\n/g, '<br>') : '',
    recipient.phone ? escHtml(recipient.phone) : '',
    recipient.email ? escHtml(recipient.email) : ''
  ].filter(Boolean).join('<br>');

  const bankSection = (settings.sort_code && settings.account_no) ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;background:rgba(14,37,64,0.04);border:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 18px">
      <p style="margin:0 0 8px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Payment details</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${settings.bank_name ? `<tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Bank</td><td style="padding:3px 0 3px 10px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.bank_name)}</td></tr>` : ''}
        ${settings.account_name ? `<tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Name</td><td style="padding:3px 0 3px 10px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.account_name)}</td></tr>` : ''}
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Sort code</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.sort_code)}</td></tr>
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Account no.</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.account_no)}</td></tr>
        <tr><td style="padding:3px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:500">Reference</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(invoiceNo)}</td></tr>
      </table>
    </td></tr>
  </table>` : `<p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Payment is appreciated within 14 days by bank transfer. Please contact us for account details.</p>`;

  const notesSection = period && period.notes ? `
  <p style="margin:20px 0 0;padding:12px 14px;background:rgba(184,152,90,.08);border-left:2px solid ${GOLD};font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.6">${escHtml(period.notes).replace(/\n/g, '<br>')}</p>` : '';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Invoice</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 10px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please find attached invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo)}</span> from Westmere Private Hire.</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">The total amount is <strong style="color:${INK}">&pound;${total.toFixed(2)}</strong>. Payment details are included below for your convenience.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Invoice no.</td>
      <td style="padding:6px 0 6px 14px;font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK}">${escHtml(invoiceNo || '')}</td>
    </tr>
    ${issuedStr ? `<tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Issued</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(issuedStr)}</td>
    </tr>` : ''}
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">From</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:12px;color:${INK};line-height:1.6">${fromAddr}</td>
    </tr>
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Bill to</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.6">${toAddr}</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px">
    <thead>
      <tr>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:500">Description</th>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:500">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total</td>
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:18px;color:${GOLD};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${notesSection}
  ${bankSection}

  <div style="text-align:center;margin:28px 0 10px">
    <a href="https://westmereprivatehire.co.uk/api/public/invoice/${escHtml(invoiceNo)}/pdf" style="display:inline-block;padding:13px 32px;background:#0E2540;color:#ffffff;text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:.03em">Download Invoice PDF</a>
  </div>

  <p style="margin:18px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions about this invoice, please don&rsquo;t hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>
  <p style="margin:12px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Thank you for choosing Westmere Private Hire.</p>
  <p style="margin:16px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Invoice ' + (invoiceNo || '') + ' \u2014 Westmere Private Hire';
  const preheader = 'Invoice \u00b7 \u00a3' + total.toFixed(2);
  let attachments;
  if (pdfBuffer) {
    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    attachments = [{ filename: (invoiceNo || 'invoice') + '.pdf', content: buf.toString('base64') }];
    console.log('[EMAIL] Attaching PDF:', (invoiceNo || 'invoice') + '.pdf', buf.length, 'bytes');
  } else {
    console.warn('[EMAIL] No PDF buffer — sending bespoke invoice', invoiceNo, 'without attachment');
  }
  const ok = await sendEmail(recipient.email, subject, html, 'Westmere Private Hire', preheader, attachments ? { attachments } : undefined);
  if (ok) console.log('[EMAIL] Bespoke invoice', invoiceNo, 'sent to', recipient.email, pdfBuffer ? '(with PDF)' : '(NO attachment)');
  return ok;
}

// ── Invoice payment reminder ──────────────────────────────────────────────
// Polite, professional nudge for an outstanding (unpaid) invoice.
async function sendInvoiceReminder(recipient, invoiceNo, total, payUrl) {
  if (!recipient || !recipient.email) return false;
  const firstName = (recipient.name || '').split(' ')[0] || 'there';
  const totalStr = (Number(total) || 0).toFixed(2);
  const pdfUrl = `https://westmereprivatehire.co.uk/api/public/invoice/${encodeURIComponent(invoiceNo || '')}/pdf`;

  const payBtn = payUrl ? `
  <div style="text-align:center;margin:26px 0 8px">
    <a href="${escHtml(payUrl)}" style="display:inline-block;padding:13px 32px;background:${GOLD};color:#0E2540;text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:.03em">Pay Now</a>
  </div>` : '';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Payment reminder</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">This is a gentle reminder that invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo || '')}</span> for <strong style="color:${INK}">&pound;${totalStr}</strong> remains outstanding.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you&rsquo;ve already made payment, please disregard this message &mdash; and thank you.</p>
  ${payBtn}
  <div style="text-align:center;margin:${payUrl ? '14px' : '26px'} 0 8px">
    <a href="${pdfUrl}" style="display:inline-block;padding:13px 32px;background:#0E2540;color:#ffffff;text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:.03em">View Invoice</a>
  </div>
  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions about this invoice, please don&rsquo;t hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>
  <p style="margin:16px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Payment reminder — Invoice ' + (invoiceNo || '') + ' · Westmere Private Hire';
  const preheader = 'Invoice ' + (invoiceNo || '') + ' — £' + totalStr + ' outstanding';
  const ok = await sendEmail(recipient.email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Invoice reminder', invoiceNo, 'sent to', recipient.email);
  return ok;
}

// ── Password reset ────────────────────────────────────────────────────────
async function sendPasswordResetEmail(customer, token) {
  if (!customer || !customer.email) return false;
  const { email, full_name } = customer;
  const firstName = (full_name || '').split(' ')[0] || 'there';
  const resetUrl = `https://westmereprivatehire.co.uk/?skip=1&reset_token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Password reset</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">We received a request to reset the password on your Westmere account. Click the button below to choose a new one.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        <a href="${resetUrl}" style="display:inline-block;padding:14px 36px;background:${INK};color:#FFFFFF;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Reset Password</a>
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">This link will expire in one hour. If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.</p>
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Reset your Westmere password';
  const preheader = 'Click the link to set a new password. This link expires in one hour.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Password reset sent to', email);
  return ok;
}

// ── Admin / owner password reset ─────────────────────────────────────────
// Separate from the customer reset: the link lands on the admin console
// (westmere-admin.html), not the rider page.
async function sendAdminPasswordResetEmail(user, token) {
  if (!user || !user.email) return false;
  const { email, full_name } = user;
  const firstName = (full_name || '').split(' ')[0] || 'there';
  const resetUrl = `https://westmereprivatehire.co.uk/westmere-admin.html?reset_token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Admin password reset</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">We received a request to reset the password for your Westmere admin account. Click the button below to choose a new one.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        <a href="${resetUrl}" style="display:inline-block;padding:14px 36px;background:${INK};color:#FFFFFF;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Reset Password</a>
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">This link will expire in one hour. If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.</p>
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Reset your Westmere admin password';
  const preheader = 'Click the link to set a new admin password. This link expires in one hour.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Admin password reset sent to', email);
  return ok;
}

// ── Customer booking CANCELLED (apology) ─────────────────────────────────
async function sendCustomerCancellation(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, flight, cancellation_reason } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('\u00a3' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : null;
  const firstName = (name || '').split(' ')[0] || 'there';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (fareStr) { rows += rowDivider(); rows += detailRow('Original fare', fareStr); }

  const reasonBlock = cancellation_reason
    ? `<p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Reason: ${escHtml(cancellation_reason)}</p>`
    : '';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Cancellation</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Unfortunately we\u2019re unable to accommodate your booking. We apologise for the inconvenience.</p>
  ${reasonBlock}
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you have already paid by card we will refund you in full within two working days. Please reply to this email or call us if you would like us to arrange an alternative \u2014 we will do our best to help.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With our sincere apologies,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Booking cancelled \u2014 our apologies \u2014 ' + ref;
  const preheader = 'We are sorry \u2014 your journey can no longer go ahead. A refund will follow if you paid online.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer cancellation sent (' + ref + ')');
  return ok;
}

// ── Weekly driver statement ─────────────────────────────────────────────
// Plain-text-ish HTML summary of a driver's earnings for a date range.
// Triggered manually via admin UI, or automatically by a weekly cron.
async function sendDriverStatement(driver, period, totals, items) {
  if (!driver || !driver.email) return false;
  const rows = (items || []).map(it => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#555">${it.date}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#111">${it.ref} · ${dispAddr(it.pickup)} → ${dispAddr(it.destination)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#111;text-align:right;font-family:Menlo,Consolas,monospace">£${(+it.fare||0).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#9C2828;text-align:right;font-family:Menlo,Consolas,monospace">−£${(+it.commission||0).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#B8985A;text-align:right;font-family:Menlo,Consolas,monospace;font-weight:600">£${(+it.net||0).toFixed(2)}</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;background:#f5f2ed;padding:20px">
  <div style="max-width:640px;margin:0 auto;background:#fff;padding:26px 30px;border-top:4px solid #B8985A">
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:.2em;color:#111D2C">WESTMERE</div>
    <div style="font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:#B8985A;margin-top:2px">Driver Statement</div>
    <h2 style="font-family:Georgia,serif;font-size:16px;color:#111D2C;margin:22px 0 6px">Hi ${driver.name || 'driver'},</h2>
    <p style="font-size:13px;color:#333;line-height:1.6">Here is your earnings summary for <strong>${period.from}</strong> to <strong>${period.to}</strong>.</p>
    <div style="display:flex;gap:12px;margin:16px 0 10px;flex-wrap:wrap">
      <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Jobs</div><div style="font-size:18px;color:#111D2C;margin-top:2px">${totals.jobs}</div></div>
      <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Gross</div><div style="font-size:18px;color:#111D2C;margin-top:2px">£${(+totals.gross||0).toFixed(2)}</div></div>
      <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Commission (10%)</div><div style="font-size:18px;color:#9C2828;margin-top:2px">£${(+totals.commission||0).toFixed(2)}</div></div>
      <div style="flex:1;min-width:110px;padding:10px 12px;background:rgba(184,152,90,.08);border:1px solid rgba(184,152,90,.25)"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#8B7035">Net due to you</div><div style="font-size:18px;color:#B8985A;margin-top:2px;font-weight:600">£${(+totals.net||0).toFixed(2)}</div></div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:12px">
      <thead><tr>
        <th style="padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8985A;border-bottom:2px solid #B8985A">Date</th>
        <th style="padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8985A;border-bottom:2px solid #B8985A">Journey</th>
        <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8985A;border-bottom:2px solid #B8985A">Fare</th>
        <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8985A;border-bottom:2px solid #B8985A">Fee</th>
        <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8985A;border-bottom:2px solid #B8985A">Net</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#999;font-size:12px">No jobs this period.</td></tr>'}</tbody>
    </table>
    <div style="font-size:11px;color:#888;border-top:1px solid #eee;margin-top:24px;padding-top:14px;text-align:center">Westmere Private Hire · Licensed by Lewes District Council</div>
  </div></body></html>`;
  return sendEmail(driver.email, `Westmere — Weekly statement (${period.from} to ${period.to})`, html, 'Westmere Payroll', `Your earnings summary: £${(+totals.net||0).toFixed(2)} net`);
}

// ── Driver welcome email (sent when admin creates a driver account) ─────────
async function sendDriverWelcome(driver) {
  const { email, full_name, username, temp_password } = driver;
  if (!email) return false;

  const firstName = (full_name || 'Driver').split(' ')[0];
  const appUrl = 'https://westmereprivatehire.co.uk/westmere-driver.html';

  const body = `
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Welcome to Westmere Private Hire. Your driver account is ready — please log in at your earliest convenience to complete your profile and upload your documents.</p>
  ${buildDetailsTable(
    detailRow('Username', `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:${INK}">${escHtml(username)}</span>`) +
    rowDivider() +
    detailRow('Password', `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:${GOLD}">${escHtml(temp_password || '(use the password you were given)')}</span>`) +
    rowDivider() +
    detailRow('Driver App', `<a href="${appUrl}" style="color:${GOLD};text-decoration:none">westmereprivatehire.co.uk/westmere-driver.html</a>`)
  )}
  <p style="margin:22px 0 10px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};font-weight:500">Getting started</p>
  <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">1. Open the driver app on your phone and log in with the credentials above.</p>
  <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">2. Go to <em>Profile</em> and complete your personal details.</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">3. Upload your required documents — DBS, licence, PHV badge, insurance, and MOT — so they can be reviewed and approved before you start accepting jobs.</p>
  <p style="margin:0 0 22px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:${INK_MUTED};line-height:1.6">For security, please change your password once you have logged in. If you have any questions, reply to this email or contact us directly.</p>
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Welcome to Westmere — Your driver account is ready';
  const preheader = `Your driver login: ${username}. Open the driver app to get started.`;
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Driver welcome sent to', email);
  return ok;
}

// ── Customer email verification ──────────────────────────────────────────
async function sendVerificationEmail(customer, token) {
  if (!customer || !customer.email) return false;
  const { email, full_name } = customer;
  const firstName = (full_name || '').split(' ')[0] || 'there';
  const verifyUrl = `https://westmereprivatehire.co.uk/api/auth/customer/verify?token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Verify your email</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for creating a Westmere account. Please verify your email address to activate it.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 36px;background:${INK};color:#FFFFFF;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Verify Email Address</a>
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">If the button above does not work, copy and paste this link into your browser:</p>
  <p style="margin:0 0 22px;font-family:Menlo,Consolas,monospace;font-size:11px;color:${GOLD};word-break:break-all;line-height:1.6">${escHtml(verifyUrl)}</p>

  <p style="margin:0 0 0;font-family:Georgia,serif;font-size:12px;color:${INK_MUTED};line-height:1.6">This link will remain valid until your account is verified. If you did not create a Westmere account, you can safely ignore this email.</p>
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Verify your Westmere account';
  const preheader = 'One click to activate your account — then you can book and manage journeys online.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Verification email sent to', email);
  return ok;
}

// ── Recommendation email ─────────────────────────────────────────────────
// Branded invitation using the same emailShell as all other Westmere emails.
async function sendRecommendation(recipientEmail) {
  if (!recipientEmail) return false;

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">You've been recommended</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Hello,</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Someone you know thought you&rsquo;d appreciate our private hire service. We provide premium private-hire transfers across Sussex &mdash; airport runs to Gatwick and Heathrow, corporate travel, special occasions, and reliable local journeys.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">Licensed by Lewes District Council. Professional, punctual, and always at your service.</p>
  <div style="text-align:center;margin:26px 0 8px">
    <a href="https://westmereprivatehire.co.uk" style="display:inline-block;padding:13px 32px;background:${GOLD};color:#0E2540;text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:.03em">Book Your Journey</a>
  </div>
  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">We look forward to welcoming you.</p>
  <p style="margin:16px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'You\u2019ve been recommended \u2014 Westmere Private Hire';
  const preheader = 'Premium private-hire transfers across Sussex';
  const ok = await sendEmail(recipientEmail, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Recommendation sent to', recipientEmail);
  return ok;
}

// ── Payment reminder email ───────────────────────────────────────────────
// Sent when a completed booking hasn't been paid. Card-only (no cash option).
async function sendPaymentReminder(booking) {
  const { email, name, ref, fare, pickup, destination, date, time, pay_token } = booking;
  if (!email) return false;
  const firstName = (name || '').split(' ')[0] || 'there';
  const fareStr = fare ? '\u00a3' + Number(fare).toFixed(2) : '';
  const dateStr = formatDate(date, time);

  // Only card payment link — no cash option
  let payBlock = '';
  if (pay_token && fareStr) {
    const payUrl = `https://westmereprivatehire.co.uk/westmere-pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(pay_token)}`;
    payBlock = `
  <div style="text-align:center;margin:26px 0 8px">
    <a href="${payUrl}" style="display:inline-block;padding:13px 32px;background:${GOLD};color:${INK};text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:.03em">Pay Now \u2014 Apple Pay, Google Pay, or Card</a>
  </div>`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Payment reminder</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Thank you for travelling with us. We noticed that payment for your recent journey has not yet been completed.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Your trip from <strong>${dispAddr(pickup)}</strong> to <strong>${dispAddr(destination)}</strong> on ${dateStr}${fareStr ? ' for <strong style="color:' + GOLD + '">' + fareStr + '</strong>' : ''} is still outstanding.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you&rsquo;ve already made payment, please disregard this message. Otherwise, you can pay securely using the link below.</p>
  ${payBlock}
  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions, please don&rsquo;t hesitate to get in touch.</p>
  <p style="margin:16px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Payment reminder \u2014 ' + (ref || 'your journey') + ' \u00b7 Westmere Private Hire';
  const preheader = fareStr ? fareStr + ' outstanding for your recent journey' : 'Payment outstanding for your recent journey';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Payment reminder sent to', email, 'for', ref);
  return ok;
}

// ── Partnership outreach email ───────────────────────────────────────────
// Professional introduction to other private hire operators, offering
// subcontracting support during busy periods.
async function sendPartnershipOutreach(recipientEmail, companyName) {
  if (!recipientEmail) return false;
  const contactName = companyName || 'there';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Introduction</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(contactName)},</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I hope this message finds you well. My name is Nikodem Krajnyk and I am the owner and operator of <strong style="color:${INK}">Westmere Private Hire</strong>, a licensed driver service based in Sussex.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;m reaching out to introduce myself and to offer my services should you ever find yourself in need of additional driver support during busy periods, overflow work, or when covering a wider area. I understand the demands of running a private hire business and I&rsquo;m always happy to help fellow operators.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 0 4px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">What I offer</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Premium saloon vehicle (Tesla Model S)</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Fully licensed by Lewes District Council</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Professional, reliable, well-presented</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Airport transfers (Gatwick, Heathrow, Stansted, Luton, Southampton, London City)</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Corporate &amp; long-distance journeys across Sussex, Surrey &amp; London</td></tr>
    <tr><td style="padding:4px 0 14px;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Available for subcontract work at competitive rates</td></tr>
  </table>

  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;d welcome the opportunity to discuss how we might work together. Whether it&rsquo;s a one-off job or ongoing support, I&rsquo;m flexible and dependable.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please feel free to get in touch at any time &mdash; I&rsquo;d be delighted to hear from you.</p>

  <div style="text-align:center;margin:22px 0 8px">
    <a href="https://westmereprivatehire.co.uk" style="display:inline-block;padding:13px 32px;background:${GOLD};color:${INK};text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:.03em">Visit Our Website</a>
  </div>

  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With warm regards,</p>
  <p style="margin:4px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65"><strong>Nikodem Krajnyk</strong><br>
  <span style="color:${INK_SOFT}">Owner &amp; Operator</span><br>
  <span style="color:${INK_SOFT}">Westmere Private Hire</span></p>
  <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${INK_MUTED};line-height:1.6">
  <a href="tel:+447930342593" style="color:${GOLD};text-decoration:none">07930 342 593</a> &nbsp;&middot;&nbsp;
  <a href="mailto:westmereprivatehire@gmail.com" style="color:${GOLD};text-decoration:none">westmereprivatehire@gmail.com</a><br>
  66 High Street, Lewes, BN7 1XG &nbsp;&middot;&nbsp; Licensed by Lewes District Council</p>`;

  const html = emailShell(body);
  const subject = 'Introduction — Westmere Private Hire · Driver Support Available';
  const preheader = 'Licensed premium driver available for subcontract work across Sussex';
  const ok = await sendEmail(recipientEmail, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Partnership outreach sent to', recipientEmail);
  return ok;
}

// ── Corporate introduction email ────────────────────────────────────────
async function sendCorporateIntro(recipientEmail, companyName) {
  if (!recipientEmail) return false;
  const greeting = companyName ? `Dear ${escHtml(companyName)} Team` : 'Good afternoon';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Introduction</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">${greeting},</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">My name is Nikodem Krajnyk and I am the owner of <strong style="color:${INK}">Westmere Private Hire</strong>, a licensed driver service based locally in Sussex.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;m writing to introduce our services, which are ideally suited for businesses in the Horsham and Crawley area. Whether your team needs reliable airport transfers, client pickups, or comfortable transport for meetings and events, we provide a discreet, professional service at competitive corporate rates.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 0 4px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Our services</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Airport transfers &mdash; Gatwick, Heathrow, Stansted, Luton, Southampton &amp; London City</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Premium saloon vehicle (Tesla Model S) &mdash; comfortable, quiet, zero-emission</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Corporate account with monthly invoicing &mdash; no upfront payments needed</td></tr>
    <tr><td style="padding:4px 0;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Client pickups, meetings &amp; events across Sussex, Surrey &amp; London</td></tr>
    <tr><td style="padding:4px 0 14px;font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Fully licensed by Lewes District Council &mdash; professional, reliable, well-presented</td></tr>
  </table>

  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Many local businesses trust us for their regular travel needs. We offer a simple booking system, flight tracking for airport pickups, and the flexibility to handle last-minute requests.</p>
  <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;d welcome the opportunity to discuss how we could support your team. Please don&rsquo;t hesitate to get in touch.</p>

  <div style="text-align:center;margin:22px 0 8px">
    <a href="https://westmereprivatehire.co.uk" style="display:inline-block;padding:13px 32px;background:${GOLD};color:${INK};text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:.03em">Visit Our Website</a>
  </div>

  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With kind regards,</p>
  <p style="margin:4px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65"><strong>Nikodem Krajnyk</strong><br>
  <span style="color:${INK_SOFT}">Owner &amp; Operator</span><br>
  <span style="color:${INK_SOFT}">Westmere Private Hire</span></p>
  <p style="margin:8px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${INK_MUTED};line-height:1.6">
  <a href="tel:+447930342593" style="color:${GOLD};text-decoration:none">07930 342 593</a> &nbsp;&middot;&nbsp;
  <a href="mailto:westmereprivatehire@gmail.com" style="color:${GOLD};text-decoration:none">westmereprivatehire@gmail.com</a><br>
  66 High Street, Lewes, BN7 1XG &nbsp;&middot;&nbsp; Licensed by Lewes District Council</p>`;

  const html = emailShell(body);
  const subject = 'Premium Driver Services for ' + (companyName || 'Your Business') + ' — Westmere Private Hire';
  const preheader = 'Local licensed driver service offering corporate accounts, airport transfers and premium travel';
  const ok = await sendEmail(recipientEmail, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Corporate intro sent to', recipientEmail, companyName || '');
  return ok;
}

// ── Review request (sent once per customer after their first completed job) ──
async function sendReviewRequest(email, firstName, ref) {
  if (!email) return;
  firstName = firstName || 'there';
  const body = `
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for travelling with us today${ref ? ' (booking ' + escHtml(ref) + ')' : ''}. We truly hope your journey was comfortable and that we met your expectations.</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have a spare moment, we would be deeply grateful if you could share a few words about your experience. Reviews help other travellers find us and allow us to keep doing what we love.</p>
  <div style="text-align:center;margin:28px 0 24px">
    <a href="https://g.page/r/Ce764VxFTR4VEAE/review" style="display:inline-block;padding:14px 36px;background:${GOLD};color:${INK};text-decoration:none;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:.04em">Leave a Google Review</a>
  </div>
  <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">It takes less than a minute and means a great deal to a small, independent business like ours.</p>
  <p style="margin:20px 0 0;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With warm thanks,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Thank you for travelling with us \u2014 ' + (ref || 'Westmere Private Hire');
  const preheader = 'We hope your journey was just right \u2014 would you share a quick review?';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Review request sent to', email);
  return ok;
}

// ── Owner alert: customer cancelled their request from the email ─────────
// Fired when the customer clicks "Cancel Request" in their confirmation email.
async function sendOwnerCancelledRequest(booking) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return false;
  const { ref, name, email, pickup, destination, date, time, fare } = booking;
  const dateStr = formatDate(date, time);
  const fareStr = (fare && !isNaN(Number(fare))) ? ('£' + Number(fare).toFixed(2)) : null;

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + escHtml(ref) + '</span>');
  if (name)  rows += detailRow('Customer', escHtml(name));
  if (email) rows += detailRow('Email', escHtml(email));
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += detailRow('Date', dateStr);
  if (fareStr) { rows += rowDivider(); rows += detailRow('Quoted fare', fareStr); }

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Request cancelled</p>
  <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">The customer has cancelled the request.</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">They clicked <strong>Cancel Request</strong> in their email — the booking has been marked cancelled. No further action is needed unless you wish to follow up.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Westmere Private Hire</p>`;

  const html = emailShell(body);
  const subject = 'Customer cancelled the request — ' + ref;
  const preheader = (name || 'The customer') + ' cancelled ' + ref + ' — ' + shortDisplay(pickup) + ' to ' + shortDisplay(destination);
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Owner cancel-request alert sent (' + ref + ')');
  return ok;
}

// ── Owner alert: customer left a special-requirement note ────────────────
async function sendOwnerCustomerNote(booking, note) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return false;
  const { ref, name, email, pickup, destination, date, time } = booking;
  const dateStr = formatDate(date, time);

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + escHtml(ref) + '</span>');
  if (name)  rows += detailRow('Customer', escHtml(name));
  if (email) rows += detailRow('Email', escHtml(email));
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += detailRow('Date', dateStr);

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Special requirement</p>
  <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">The customer has left a note for their journey.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr><td style="padding:14px 16px;background:#f6efe1;border-left:2px solid ${GOLD}">
    <p style="margin:0;font-family:Georgia,serif;font-size:15px;color:${INK};line-height:1.6">${escHtml(note).replace(/\n/g, '<br>')}</p>
  </td></tr></table>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Westmere Private Hire</p>`;

  const html = emailShell(body);
  const subject = 'Customer note — ' + ref;
  const preheader = (name || 'The customer') + ' left a special requirement for ' + ref;
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Owner customer-note alert sent (' + ref + ')');
  return ok;
}

// ── Free-text message from operator to customer ──────────────────────────
// A lighter version of the brand template — the owner types a message (e.g. a
// question) and it is delivered to the customer from Westmere.
async function sendCustomerMessage(booking, message) {
  const { ref, name, email } = booking;
  if (!email || !message) return false;
  const firstName = (name || '').split(' ')[0] || 'there';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">A message from Westmere${ref ? ' · ' + escHtml(ref) : ''}</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.7">${escHtml(message).replace(/\n/g, '<br>')}</p>
  <p style="margin:0 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">You can simply reply to this email or call us on <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930 342593</a>.</p>
  <p style="margin:22px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = ref ? ('Regarding your booking — ' + ref) : 'A message from Westmere Private Hire';
  const preheader = String(message).replace(/\s+/g, ' ').slice(0, 90);
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer message sent (' + (ref || email) + ')');
  return ok;
}

module.exports = {
  sendCustomerAcknowledgement, sendCustomerConfirmed, sendCustomerEstimate, sendAdminAlert,
  sendOwnerCancelledRequest, sendOwnerCustomerNote, sendCustomerMessage,
  sendCustomerWelcome, sendCustomerInvoice, sendBespokeInvoice, sendInvoiceReminder,
  sendCustomerCancellation, sendDriverStatement, sendDriverWelcome,
  sendVerificationEmail, sendPasswordResetEmail, sendAdminPasswordResetEmail,
  sendRecommendation, sendPartnershipOutreach, sendCorporateIntro, sendReviewRequest, sendPaymentReminder, sendEmail, isConfigured,
  // Exposed for local template previews / potential reuse.
  confirmationEmailHtml
};
