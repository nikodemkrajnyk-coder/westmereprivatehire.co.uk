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
async function sendCustomerInvoice(customer, bookings, period, invoiceNo, settings) {
  if (!customer || !customer.email) return false;
  const { email, full_name } = customer;
  const firstName = (full_name || '').split(' ')[0] || 'there';
  settings = settings || {};

  const rows = (bookings || []).map(b => {
    const fare = +b.fare || 0;
    const dateStr = formatDate(b.date, b.time);
    const routeStr = escHtml(b.pickup || '') + ' &rarr; ' + escHtml(b.destination || '');
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
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Please find below your statement of journeys for ${escHtml(period.label || 'this period')}.</p>

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
    ${dueStr ? `<tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Due</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(dueStr)}</td>
    </tr>` : ''}
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
        <td colspan="2" style="padding:6px 10px 6px 0;border-top:1px solid ${HAIRLINE};font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total due</td>
        <td style="padding:6px 0;border-top:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:18px;color:${GOLD};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${bankSection}

  <p style="margin:18px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Invoice ' + (invoiceNo || '') + ' \u2014 ' + (period.label || '');
  const preheader = summaryCount + ' journey' + (summaryCount === 1 ? '' : 's') + ' \u00b7 \u00a3' + total.toFixed(2) + ' total';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Invoice', invoiceNo, 'sent to', email);
  return ok;
}

// ── Bespoke invoice (one-off, no bookings) ───────────────────────────────
// `recipient` = { name, email, phone, address }
// `items`     = [{ description, amount }]
// `period`    = { dueDate, issuedDate, notes }
async function sendBespokeInvoice(recipient, items, period, invoiceNo, settings) {
  if (!recipient || !recipient.email) return false;
  settings = settings || {};
  const firstName = (recipient.name || '').split(' ')[0] || 'there';

  const rows = (items || []).map(it => {
    const amount = +it.amount || 0;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:13px;color:${INK};line-height:1.5;vertical-align:top">${escHtml(it.description || '')}</td>
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
  <p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Please find your invoice below for services provided by Westmere Private Hire.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
    <tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Invoice no.</td>
      <td style="padding:6px 0 6px 14px;font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK}">${escHtml(invoiceNo || '')}</td>
    </tr>
    ${issuedStr ? `<tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Issued</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(issuedStr)}</td>
    </tr>` : ''}
    ${dueStr ? `<tr>
      <td style="padding:6px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:500">Due</td>
      <td style="padding:6px 0 6px 14px;font-family:Georgia,serif;font-size:13px;color:${INK}">${escHtml(dueStr)}</td>
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
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total due</td>
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:Georgia,serif;font-size:18px;color:${GOLD};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${notesSection}
  ${bankSection}

  <p style="margin:18px 0 0;font-family:Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With kind regards,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = emailShell(body);
  const subject = 'Invoice ' + (invoiceNo || '') + ' \u2014 Westmere Private Hire';
  const preheader = 'Invoice \u00b7 \u00a3' + total.toFixed(2) + ' due';
  const ok = await sendEmail(recipient.email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Bespoke invoice', invoiceNo, 'sent to', recipient.email);
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
  rows += detailRow('Pickup', escHtml(pickup));
  rows += detailRow('Drop-off', escHtml(destination));
  rows += detailRow('Date', dateStr);
  if (flight) rows += detailRow('Flight', escHtml(flight));
  if (fareStr) { rows += rowDivider(); rows += detailRow('Original fare', fareStr); }

  const reasonBlock = cancellation_reason
    ? `<p style="margin:0 0 22px;font-family:Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Reason: ${escHtml(cancellation_reason)}</p>`
    : '';

  const body = `
  <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};font-weight:600">Cancellation</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 14px;font-family:Georgia,serif;font-size:14px;color:${INK};line-height:1.65">We are very sorry \u2014 your journey with Westmere Private Hire can no longer go ahead and we must cancel the booking below.</p>
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
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#111">${it.ref} · ${it.pickup} → ${it.destination}</td>
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

module.exports = {
  sendCustomerConfirmation, sendCustomerConfirmed, sendAdminAlert,
  sendCustomerWelcome, sendCustomerInvoice, sendBespokeInvoice,
  sendCustomerCancellation, sendDriverStatement, sendEmail, isConfigured
};
