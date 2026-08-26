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
const { shortDisplay, flightFor, isAirportRun } = require('../address-normalize');
function dispAddr(a) { return escHtml(shortDisplay(a || '')); }
// Luggage label — single source of truth (see wm-lifecycle.js). Bags are always
// a whole number here; the raw column value is never printed.
const { bagsText, bagsLabel } = require('../wm-lifecycle');
// A flight number is shown ONLY on an airport run — flightFor() returns '' for
// a town-to-town job, so `if (flt)` omits the row entirely.
function dispFlight(booking) { return flightFor(booking); }

/* A tracking link for a flight number the CUSTOMER typed.
   flightFor() has already uppercased it and stripped spaces, but it hands back
   whatever was entered — so anything going into a URL is VALIDATED here, not
   merely escaped. Only a plausible airline ident gets a link; free text like
   "Terminal 5 arrivals" gets none, and the flight number is still shown either
   way. A dead "Track your flight" button is worse than no button.

   An airline designator is 2 characters (IATA) or 3 (ICAO), and IATA codes are
   NOT always two letters: easyJet is U2, Germanwings was 4U. A two-LETTER rule
   rejected U21234, and easyJet flies out of Gatwick all day — so the prefix is
   alphanumeric with at least one letter, which still refuses a bare "12345".

   FlightAware's /live/flight/<ident> takes both IATA and ICAO idents and is a
   real tracker rather than a search-results page. */
const FLIGHT_IDENT = /^([A-Z0-9]{2,3})([0-9]{1,4})([A-Z]?)$/;
function flightTrackUrl(raw) {
  const ident = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = ident && FLIGHT_IDENT.exec(ident);
  if (!m || !/[A-Z]/.test(m[1])) return null;
  return 'https://www.flightaware.com/live/flight/' + encodeURIComponent(ident);
}

/* THE AIRPORT BLOCK — meet & greet, and flight tracking.
   Shared by the CONFIRMATION and the customer's 12-hour REMINDER, so the two
   carry exactly the same promises. Two copies of a promise is how one of them
   quietly stops matching the other.

   Needs pickup / destination / stop_address / flight. Returns '' for a
   town-to-town job; omits the flight half when there is no flight number, so
   there is no empty "Flight:" label anywhere.

   "Airport" is isAirportRun() from address-normalize.js — the same detector
   that gates the flight-number field, so the form and the emails agree. It is
   deliberately BROADER than the fare engine's six priced airports: a Birmingham
   run is still met, and still has parking. */
/* WHO IS COMING, AND IN WHAT.
   bookings.driver_id joins users(full_name, vehicle, reg), so a booking CAN
   carry an assigned driver and car. Callers pass whatever the join found; these
   three are the fallback for the (currently usual) case of no assignment, which
   is the owner's own car.

   Kept as one helper so the confirmation and the reminder can never disagree
   about who is turning up. */
const DEFAULT_DRIVER  = 'Nikodem';
const DEFAULT_VEHICLE = 'Tesla Model S';
const DEFAULT_REG     = 'ML68 YHC';
function driverDetails(d) {
  const pick = (v, fallback) => {
    const t = String(v == null ? '' : v).trim();
    return t || fallback;
  };
  return {
    name: pick(d && d.driver_name, DEFAULT_DRIVER),
    vehicle: pick(d && d.driver_vehicle, DEFAULT_VEHICLE),
    reg: pick(d && d.driver_reg, DEFAULT_REG)
  };
}

/* ── WHO IS TURNING UP, AND IN WHAT ──────────────────────────────────────
   One renderer, used by BOTH customer emails, so the confirmation and the
   12-hour reminder can never disagree about the car that is coming. Rendered
   as its own strip rather than a details-table row because the two emails
   build their tables differently (icon rows vs plain rows) — this way the
   customer sees the identical thing in each.

   The plate is set in the mono face the Reference row uses: a registration is
   a code to be read off against a car on a kerb, not prose.
   GUARDRAIL: server/tests/booking-notes.test.js, rider-reminder.test.js */
/* ── THE WAY OUT, UNDER THE PAY DOORS ────────────────────────────────────
   A customer who is being asked for money is entitled to the other answer in
   the same breath. This renders under the pay buttons in the reminder and in
   the owner's Send Message email, and ONLY there — both callers gate it behind
   paymentLock, so a paid booking never gets an auto-cancel link in an email.
   Cancelling a paid trip is refund territory and stays a phone call.

   It is a LINK, not a button: the pay doors are the offer, this is the exit,
   and the weight difference is the whole message.

   The href is the EXISTING tokenised cancel flow — /api/public/cancel/:ref is
   a GET that only ever renders a confirmation page, with the cancellation
   itself behind a POST from that page. An email scanner or a mis-tap therefore
   cannot cancel anybody's car. Do not "simplify" this into a one-click GET.
   GUARDRAIL: server/tests/rider-reminder.test.js */
function cancelLinkHtml(ref, token) {
  if (!ref || !token) return '';
  const url = `${HOST}/api/public/cancel/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`;
  return `<p style="margin:14px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6;text-align:center">Need to cancel? <a href="${escAttr(url)}" style="color:${INK};text-decoration:underline">Cancel this trip</a></p>`;
}

function driverBlockHtml(d) {
  const dv = driverDetails(d);
  const serif = 'Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #dfe5ea;margin-top:2px">
  <tr><td style="padding:14px 0 0">
    <p style="margin:0 0 4px;font-family:${serif};font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Your driver and car</p>
    <p style="margin:0;font-family:${serif};font-size:15px;color:${INK};line-height:1.5">${escHtml(dv.name)} &mdash; ${escHtml(dv.vehicle)}</p>
    <p style="margin:2px 0 0;font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:1px;color:${INK_MUTED}">${escHtml(dv.reg)}</p>
  </td></tr>
</table>`;
}

function airportBlockHtml(d) {
  if (!isAirportRun(d.pickup, d.destination, d.stop_address)) return '';
  let flightBlock = '';
  const flightNo = dispFlight(d);
  if (flightNo) {
    const trackUrl = flightTrackUrl(flightNo);
    const trackLink = trackUrl
      ? ' &nbsp;<a href="' + trackUrl + '" style="color:#102a43;text-decoration:underline">Track your flight</a>'
      : '';
    flightBlock = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border-top:1px solid #eef1f4">'
      + '<tr><td style="padding-top:10px">'
      + '<p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:#102a43;line-height:1.65"><strong style="font-weight:500">Flight ' + escHtml(flightNo) + '</strong>' + trackLink + '</p>'
      + '<p style="margin:6px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:#657485;line-height:1.6">We track your flight, so delays are no problem.</p>'
      + '</td></tr></table>';
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + '<tr><td style="padding:12px 16px;border:1px solid #dfe5ea;border-radius:6px">'
    + '<p style="margin:0 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#657485;font-weight:600">Your airport transfer</p>'
    + '<p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:#102a43;line-height:1.65"><strong style="font-weight:500">Meet &amp; greet included</strong> &mdash; your driver will meet you at arrivals and help with your luggage.</p>'
    + '<p style="margin:8px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:#657485;line-height:1.6">Airport parking is included in your fare &mdash; there is nothing extra to pay.</p>'
    + flightBlock
    + '</td></tr></table>';
}

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Derive a readable text/plain alternative from the HTML. A multipart email
// (HTML + text) is far better for deliverability than HTML-only (SpamAssassin
// MIME_HTML_ONLY). Links are surfaced as "text (url)" so they survive in text.
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')
       .replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<script[\s\S]*?<\/script>/gi, '')
       // Hidden preheader / mso-hide divs must not leak into the text body.
       .replace(/<div[^>]*(?:display:none|mso-hide:all)[^>]*>[\s\S]*?<\/div>/gi, '');
  // Links → "label (url)" (skip mailto:/tel: — the label already reads fine).
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => {
    const t = txt.replace(/<[^>]+>/g, '').trim();
    if (!href || /^(mailto:|tel:|#)/i.test(href)) return t;
    return (t && t !== href) ? `${t} (${href})` : href;
  });
  s = s.replace(/<\/(p|div|tr|h1|h2|h3|h4|li|td|table)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n')
       .replace(/<[^>]+>/g, ' ')
       .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—')
       .replace(/&ndash;/g, '–').replace(/&pound;/g, '£').replace(/&middot;/g, '·')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
       .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// A List-Unsubscribe header (mailto to our own monitored, from-domain-aligned
// mailbox) improves inbox placement even for transactional mail.
const UNSUB_MAILBOX = 'bookings@westmereprivatehire.co.uk';

// opts: { attachments: [{ filename, content }], text }
// content must be a base64 string for Resend's HTTP API.
async function sendEmail(to, subject, html, fromLabel, preheader, opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL] RESEND_API_KEY not set — email disabled');
    return false;
  }

  // Reply-To MUST live on the sending domain. A freemail (e.g. Gmail) Reply-To
  // that differs from the From domain trips SpamAssassin FREEMAIL_FORGED_REPLYTO
  // (~+2.5 spam points — the single biggest hit in the mail-tester run). Default
  // to bookings@westmereprivatehire.co.uk, which is BOTH the From address and the
  // contact advertised in every email footer (a real, monitored inbox). Override
  // with REPLY_TO only if it is another on-domain address.
  const replyTo = process.env.REPLY_TO || 'bookings@westmereprivatehire.co.uk';

  let finalHtml = html;
  if (preheader) {
    /* ESCAPED. The preheader is the one place in this file where caller text was
       being injected into markup raw, and several callers pass text a human
       typed — the owner's Send Message, and now the outreach letter. The BODY
       of those emails has always been escaped; this was the hole beside it.
       Found by server/tests/outreach.test.js. */
    const hidden = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FFFFFF;opacity:0">${escHtml(preheader)}</div>`;
    finalHtml = html.replace('<body', hidden + '<body').replace(/<body([^>]*)>/, '<body$1>' + hidden);
  }

  // Plain-text alternative part (preheader first, then the body text).
  const bodyText = (opts && opts.text) || htmlToText(html);
  const text = (preheader ? preheader + '\n\n' : '') + bodyText;

  const payload = {
    from: (fromLabel || 'Westmere Private Hire') + ' <bookings@westmereprivatehire.co.uk>',
    to,
    reply_to: replyTo || undefined,
    subject,
    html: finalHtml,
    text,
    headers: {
      'List-Unsubscribe': '<mailto:' + UNSUB_MAILBOX + '?subject=Unsubscribe>'
    }
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
    // Return the Resend message id on success (a non-empty string stays truthy,
    // so existing `if (ok)` callers are unaffected) — lets callers surface it.
    return data.id || true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
    return false;
  }
}

// ── Palette: navy on white, no gold, no cream ────────────────────────────
// The single source of truth is westmere-theme.css; these are its tokens
// transcribed for email, where CSS custom properties cannot be relied on.
// There is deliberately no gold: accent = navy, and emphasis comes from
// weight and scale. (Guardrail: button-style.test.js scans this file for any
// colour in the cream/gold hue band.)
const BG_OUTER    = '#EEF2F5';   // cool page tint behind the card
const BG_CARD     = '#FFFFFF';   // letter card
const INK         = '#102a43';   // --westmere-navy — primary type
const INK_SOFT    = '#3B5268';   // secondary type
const INK_MUTED   = '#657485';   // --westmere-muted — labels & footer
const ACCENT      = '#102a43';   // was gold; the accent is navy now
const HAIRLINE    = 'rgba(16,42,67,0.12)';
const HAIRLINE_S  = '#c8d1d9';   // --westmere-line-strong, solid: VML strokecolor
// Trustpilot's own green. The ONE third-party colour in this file, and only
// for the Trustpilot review button — see the EMAIL_BTN note below.
const TRUSTPILOT_GREEN = '#00B67A';
                                 // cannot take an rgba(), and neither can Outlook.

// The old imageless emailShell has been RETIRED — every email now renders
// through heroShell()/heroEmail() (defined below) so there is exactly ONE
// branded, hero-image email design system-wide. (Guardrail: payment-flow.test.js)

// ── Detail row: clean two-column, no boxes ───────────────────────────────
function detailRow(label, value, opts) {
  opts = opts || {};
  const valSize = opts.large ? 15 : 13;
  const valColor = opts.gold ? ACCENT : INK;
  const valWeight = opts.large ? 500 : 400;
  const valStyle = `font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:${valSize}px;color:${valColor};font-weight:${valWeight};line-height:1.45`;
  return `<tr>
  <td style="padding:9px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:96px;font-weight:600">${label}</td>
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

/* ── THE was → now ROW ───────────────────────────────────────────────────
   One shared renderer for every "this used to say X, it now says Y" line in
   the system: the owner's change-request alert and the customer's booking-
   updated email both draw their diff through this, so a customer and the
   owner are always looking at the SAME comparison in the same shape.

   The old value is struck through in the muted tone and the new one is bold
   navy. Nothing is coloured to rank it — a strike-through and a weight carry
   the whole message, which is also the only pair of signals every mail client
   renders. GUARDRAIL: server/tests/booking-updated.test.js */
function diffRow(label, wasHtml, nowHtml) {
  return `<tr>
  <td style="padding:10px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:96px;font-weight:600">${escHtml(label)}</td>
  <td style="padding:10px 0 10px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;line-height:1.5;color:${INK}">
    <span style="color:${INK_MUTED};text-decoration:line-through">${wasHtml}</span>
    <span style="color:${INK_MUTED};padding:0 6px">&rarr;</span>
    <strong style="color:${ACCENT};font-weight:600">${nowHtml}</strong>
  </td>
</tr>`;
}

/* ── The fields a CUSTOMER is emailed about when the operator edits ───────
   The journey, in the order a customer reads it. This list is the copy layer
   only — server/api.js owns the matching list of column names and decides
   what actually changed; keeping the labels here means api.js carries no
   presentation (DESIGN.md, the front/back boundary).

   Deliberately absent: the private note, the driver, the status and the
   payment method. Those are the operator's business, and re-saving them must
   never put an email in a customer's inbox. */
const UPDATE_FIELDS = [
  ['pickup',       'Pickup'],
  ['stop_address', 'Stop'],
  ['destination',  'Drop-off'],
  ['date',         'Date'],
  ['time',         'Time'],
  ['passengers',   'Passengers'],
  ['bags',         'Luggage'],
  ['flight',       'Flight'],
  ['fare',         'Fare']
];

// Render one field for the CUSTOMER's eye. Addresses, luggage and flight go
// through the same shorteners as every other surface (changeFieldValue); the
// three the owner's alert never has to show get their own treatment here.
// A date is spelled out in full — the customer is checking whether the day
// moved, and "2026-08-25" does not answer that at a glance.
function updateFieldValue(key, value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return '&mdash;';
  if (key === 'fare') {
    const n = Number(raw);
    // A literal £, not &pound; — every other price in this file is written that
    // way, and one entity in the middle of them is how a test starts looking
    // for a number that is really there and not finding it.
    return isNaN(n) ? escHtml(raw) : '£' + n.toFixed(2);
  }
  if (key === 'date') return escHtml(formatDate(raw));
  if (key === 'passengers') {
    const n = Number(raw);
    return isNaN(n) ? escHtml(raw) : (n + ' passenger' + (n === 1 ? '' : 's'));
  }
  return changeFieldValue(key, raw);
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
  const firstName = greetingName(name);

  // Acknowledgement now uses the SAME branded hero-image template
  // (variant:'ack'). No fare is locked in and there is no pay_token yet, so it
  // shows the estimate as a caption with no pay buttons.
  const estCaption = estStr
    ? `Estimated fare: <span style="color:#102a43">${estStr}</span> \u2014 we'll confirm your exact price shortly.`
    : "We'll confirm your exact fare shortly.";
  const html = confirmationEmailHtml({
    variant: 'ack',
    eyebrow: 'Booking received',
    intro: 'Thank you for booking with us \u2014 we will be in touch shortly to confirm your exact fare.',
    fareLabel: 'Estimated fare',
    showPaymentRow: false,
    caption: estCaption,
    ref, firstName, pickup, stop_address, destination, dateStr, flight, passengers,
    fareStr: estStr, alreadyPaid: false, pay_token: null, notes
  });
  const subject = 'Thank you for booking \u2014 ' + ref;
  const preheader = (estStr ? ('Estimated fare ' + estStr + ' \u2014 ') : '') + 'we\'ve received your booking and will be in touch shortly.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer acknowledgement sent (' + ref + ')');
  return ok;
}

// ── Customer booking CONFIRMED (sent when the CUSTOMER acts: card paid, or
// "pay driver" chosen — never by an assistant, never by "Send Estimate") ──
async function sendCustomerConfirmed(booking) {
  const { ref, name, email, pickup, destination, date, time, fare, payment, flight, passengers, bags, pay_token, paid, stop_address, notes,
          driver_name, driver_vehicle, driver_reg } = booking;
  if (!email) return;

  const dateStr = formatDate(date, time);
  const fareNum = typeof fare === 'number' ? fare : parseFloat(fare);
  const fareStr = (fareNum && !isNaN(fareNum)) ? ('£' + fareNum.toFixed(2)) : null;
  const firstName = greetingName(name);

  // This email is only ever sent in two genuine states, and it NEVER labels an
  // uncollected cash booking as "paid":
  //   • CARD — the Stripe charge succeeded → genuinely PAID (a receipt).
  //   • CASH — the customer chose "pay your driver on the day" → booking is
  //            CONFIRMED but payment is PENDING (nothing collected yet).
  const isCard = payment === 'card';
  const isCash = payment === 'cash';

  let paymentLabel, intro, subject, preheader;
  if (isCard) {
    paymentLabel = 'Paid by card ✓';
    intro = 'Thank you for booking with Westmere — your payment has been received and your journey is confirmed. Your full trip details are below, and we look forward to welcoming you on the day.';
    subject = 'Booking confirmed & paid — ' + ref;
    preheader = 'Payment received — your journey is booked. Trip details inside.';
  } else if (isCash) {
    paymentLabel = 'Pay your driver in cash on the day';
    intro = "Your booking is confirmed. You've chosen to pay your driver in cash on the day, so there's nothing further to pay now — your trip details are below and we look forward to welcoming you on the day.";
    subject = 'Booking confirmed — ' + ref;
    preheader = 'Your journey is booked — pay your driver in cash on the day.';
  } else {
    // Generic confirmation (e.g. operator confirmed with no method chosen yet).
    paymentLabel = paid ? 'Paid' : 'To be arranged';
    intro = 'Your journey is confirmed. A driver has been assigned and we look forward to welcoming you on the day.';
    subject = 'Booking confirmed — ' + ref;
    preheader = 'Your driver has been assigned. We look forward to seeing you.';
  }

  // A card charge OR a cash choice both mean the customer has settled HOW they
  // will pay, so the Pay Now / Cash action buttons are hidden (Cancel stays).
  const noPayButtons = isCard || isCash || !!paid;

  const html = confirmationEmailHtml({
    ref, firstName, pickup, stop_address, destination, dateStr, flight, passengers, bags,
    fareStr, alreadyPaid: noPayButtons, payment, paymentLabel, pay_token, notes,
    driver_name, driver_vehicle, driver_reg,
    eyebrow: 'Booking confirmed', intro
  });
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer confirmed sent (' + ref + ', ' + (isCard ? 'card-paid' : isCash ? 'cash-pending' : 'confirmed') + ')');
  return ok;   // Resend id (or true) so callers/previews can report the send.
}

// New Westmere confirmation template (approved design). Mail-safe (tables +
// inline styles, hosted PNG icons) so it renders in Gmail / Apple Mail /
// Outlook. Cream card, gold-hairline brand header, coastal banner, gold
// outline row icons, dark footer. Intended shared shell for system emails.
const HOST = 'https://westmereprivatehire.co.uk';
function confRow(icon, label, valueHtml, opts) {
  opts = opts || {};
  // Larger type throughout for phone readability (owner request).
  const valStyle = opts.fare
    ? "font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:28px;line-height:1.2;color:#102a43"
    : "font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:17px;line-height:1.5;color:#102a43";
  return `<tr>
    <td width="26" valign="top" style="padding:16px 0 0;border-bottom:1px solid #dfe5ea"><img src="${HOST}/assets/${icon}.png" width="20" height="20" alt="" style="display:block;border:0;outline:none;line-height:100%"></td>
    <td width="104" valign="top" style="padding:18px 10px 16px 8px;border-bottom:1px solid #dfe5ea;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#657485;font-weight:700">${label}</td>
    <td valign="top" style="padding:16px 0;border-bottom:1px solid #dfe5ea;${valStyle}">${valueHtml}</td>
  </tr>`;
}
/* ═══════════════════════════════════════════════════════════════════════
   THE EMAIL BUTTON — an outlined frame, everywhere, in every client
   ═══════════════════════════════════════════════════════════════════════
   Same language as the apps: navy border on white, navy ink, NO FILL at
   rest. Primary is louder by LABEL — bigger and bolder — exactly as the
   owner chose for the buttons on screen. There is no hover and no press in
   an inbox, so the label is the only signal available; it is also the one
   that survives a client stripping half the CSS.

   BULLETPROOF, because an inbox is not a browser:
     · The BORDER lives on the <td>, not only on the <a>. Outlook drops many
       <a> box properties but honours a table cell's border, so the frame
       survives even where the anchor's own styling does not.
     · An mso-only VML <v:roundrect> carries the rounded frame in Outlook
       2007–2019, which has no border-radius: fillcolor is the page white and
       strokecolor the navy, so the shape is a frame there too rather than a
       filled slab or a bare word.
     · Every declaration is inline. No class, no <style> dependency, nothing
       that Gmail's clipper can strip.
     · mso-padding-alt restores the padding Outlook takes off the anchor, so
       the tap target does not collapse to the height of the text.
     · bgcolor="#ffffff" is set as an ATTRIBUTE as well as CSS — a handful of
       older clients ignore background declarations but honour the attribute,
       and without it a dark-mode client can invert the cell behind navy ink.

   COLOUR IS NOT USED TO RANK THESE. All three are navy on white; primary is
   16px/700 and the others 14px/600. Cancel is quieter still, in the muted
   tone, which measures 4.8:1 on white — clear AA.
   GUARDRAIL: server/tests/button-style.test.js */
const EMAIL_BTN = {
  primary:   { size: 16, weight: 700, ink: INK,       border: INK,       width: 2, track: '1.4px' },
  secondary: { size: 14, weight: 600, ink: INK,       border: INK,       width: 1, track: '1.2px' },
  danger:    { size: 14, weight: 600, ink: INK_MUTED, border: HAIRLINE_S, width: 1, track: '1.2px' },
  /* OWNER-APPROVED EXCEPTION — Trustpilot keeps its brand green.
     The rule everywhere else in this system is that nothing carries another
     company's colour (§20, no-fills.test.js). Trustpilot and Instagram are the
     deliberate exceptions the owner asked for: they are recognised BY their
     colour, and a customer scanning an email finds the green Trustpilot star
     faster than a navy one. Scoped to this one row and the social glyphs on
     the site — nothing else may use it.
     Still a FRAME, not a slab: white cell, green hairline, green label. The
     green measures 3.1:1 on white, so it stays on the 14px/600 secondary
     tier where it is a large-text AA pass rather than body copy.
     GUARDRAIL: server/tests/review-links.test.js */
  trustpilot: { size: 14, weight: 600, ink: TRUSTPILOT_GREEN, border: TRUSTPILOT_GREEN, width: 1, track: '1.2px' }
};

// `block` = full-width stacked button (the payment actions); otherwise the
// button hugs its label and is centred (the one-CTA emails).
function emailBtn(href, text, kind, block) {
  const b = EMAIL_BTN[kind] || EMAIL_BTN.secondary;
  const padV = block ? 17 : 15, padH = block ? 16 : 34;
  const radius = 10;
  const font = 'Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif';
  const label =
    `font-family:${font};font-size:${b.size}px;font-weight:${b.weight};` +
    `letter-spacing:${b.track};text-transform:uppercase;color:${b.ink};text-decoration:none`;
  // Outlook: a VML frame at the same radius, white fill, navy stroke.
  const vml =
    `<!--[if mso]>` +
    `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" ` +
    `href="${href}" style="height:52px;v-text-anchor:middle;width:${block ? '100%' : '260px'};" ` +
    `arcsize="19%" strokecolor="${b.border}" strokeweight="${b.width}px" fillcolor="#ffffff">` +
    `<w:anchorlock/><center style="${label}">${text}</center></v:roundrect>` +
    `<![endif]-->`;
  const cell =
    `background-color:#ffffff;border:${b.width}px solid ${b.border};border-radius:${radius}px;` +
    `mso-padding-alt:${padV}px ${padH}px`;
  const anchor =
    `display:${block ? 'block' : 'inline-block'};box-sizing:border-box;` +
    `${block ? 'width:100%;' : ''}padding:${padV}px ${padH}px;text-align:center;${label}`;
  return `${vml}<!--[if !mso]><!-->` +
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" ` +
    `style="border-collapse:separate;${block ? 'width:100%' : ''}"><tr>` +
    `<td align="center" bgcolor="#ffffff" style="${cell}">` +
    `<a href="${href}" style="${anchor}">${text}</a>` +
    `</td></tr></table><!--<![endif]-->`;
}

// One uniform action button — IDENTICAL shape for all three (full-width, same
// padding/radius). `kind` no longer changes a FILL: it changes the label, which
// is how the apps rank a primary action too.
function actionBtn(href, text, kind) {
  return `<tr><td style="padding-bottom:12px">${emailBtn(href, text, kind, true)}</td></tr>`;
}
// Returns a REAL owner note or '' — the Notes row is for the owner's own
// message only. Blank notes, and the rider app's auto "Vehicle: <type>" dump,
// are treated as no-note so no spurious/placeholder Notes row is shown.
function cleanOwnerNote(notes) {
  const s = String(notes == null ? '' : notes).trim();
  if (!s) return '';
  if (/^vehicle\s*:/i.test(s)) return '';
  return s;
}

// (The luggage label now comes from wm-lifecycle.js — see the require at the
// top of this file. It was duplicated here and printed the raw column value on
// some rows, which is how "0.0 bags" reached customers' inboxes.)

// Payment-row text for a booking email. Only a genuinely settled booking shows
// the method it was paid by — card (Stripe) vs cash (owner marked paid) vs
// account. An unpaid estimate/confirmation says "Choose below".
function paymentText(d) {
  if (!d.alreadyPaid) return 'Choose below';
  if (d.payment === 'cash') return 'Paid — cash to your driver';
  if (d.payment === 'account') return 'On account';
  return 'Paid by card';
}

// ── THE single branded shell used by EVERY Westmere email ────────────────
// Hero header (wordmark + coastal image) + "Westmere Private Hire" sign-off
// footer. `innerHtml` is the sequence of <tr> rows dropped between the hero
// image and the footer. There is exactly ONE email design system-wide — the
// old imageless emailShell has been retired (guardrail: payment-flow.test.js).
function heroShell(innerHtml, opts) {
  opts = opts || {};
  const title = opts.title || 'Westmere Private Hire';
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escHtml(title)}</title>
<!--[if mso]><style>table,td,a{font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif}</style><![endif]-->
<style>:root{color-scheme:light only;supported-color-schemes:light only}
@media(max-width:600px){.wm-pad{padding-left:22px!important;padding-right:22px!important}.wm-copy{display:block!important;width:100%!important}.wm-badge{display:block!important;width:100%!important;max-width:100%!important;text-align:left!important;padding:14px 0 0 0!important}.wm-badge p{letter-spacing:1.2px!important}}</style>
</head>
<body style="margin:0;padding:0;background:#EEF2F5;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF2F5" style="background:#EEF2F5">
<tr><td align="center" style="padding:26px 14px">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid #dfe5ea;border-radius:16px;overflow:hidden">

<tr><td align="center" style="padding:28px 20px 18px;background:#FFFFFF">
  <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:22px;color:#102a43;letter-spacing:1px;line-height:1">W</div>
  <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:29px;letter-spacing:11px;color:#102a43;font-weight:400;margin-top:6px">WESTMERE</div>
  <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:10px;letter-spacing:5px;color:#102a43;text-transform:uppercase;margin-top:9px">Private Hire &middot; Sussex</div>
  <div style="width:60px;height:1px;background:#c8d1d9;line-height:1px;font-size:0;margin:14px auto 0">&nbsp;</div>
</td></tr>

${opts.hero === false ? '' : `<tr><td style="font-size:0;line-height:0;background:#FFFFFF"><img src="${HOST}/assets/westmere-email-hero.jpg" width="600" alt="Westmere car on the Sussex coast" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none"></td></tr>`}

${innerHtml}

<tr><td style="padding:22px 40px;background:#FFFFFF;border-top:1px solid #dfe5ea">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="60" valign="middle"><img src="${HOST}/assets/westmere-email-thumb.jpg" width="60" height="60" alt="Westmere Private Hire" style="display:block;width:60px;height:60px;border-radius:50%;border:1px solid #c8d1d9"></td>
    <td valign="middle" style="padding-left:16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:16px;line-height:1.55;color:#102a43">With kind regards,<br><strong style="font-size:18px;color:#102a43">Westmere Private Hire</strong></td>
  </tr></table>
</td></tr>

<tr><td style="padding:24px 30px;background:#FFFFFF;border-top:1px solid #dfe5ea;text-align:center">
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;line-height:1.7;color:#657485"><a href="tel:+447930342593" style="color:#102a43;text-decoration:none">07930 342593</a> &middot; <a href="mailto:bookings@westmereprivatehire.co.uk" style="color:#102a43;text-decoration:none">bookings@westmereprivatehire.co.uk</a> &middot; <a href="${HOST}" style="color:#102a43;text-decoration:none">westmereprivatehire.co.uk</a></p>
  <p style="margin:0 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;line-height:1.7;color:#657485">${escHtml(opts.footerNote || 'Reply to this email or call us if anything needs adjusting.')}</p>
  <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;line-height:1.7;color:#657485">Westmere Private Hire &middot; Licensed Private Hire Operator</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// Generic branded email — arbitrary body content wrapped in the ONE hero shell.
// Used by every non-booking email (invoices, admin, password, outreach, driver…)
// so they all share the exact hero header/footer design, just without the
// booking pay-buttons.
function heroEmail(bodyHtml, opts) {
  return heroShell(`<tr><td class="wm-pad" style="padding:30px 40px 14px;background:#FFFFFF">${bodyHtml}</td></tr>`, opts);
}

/* ── A LETTER, NOT A BOOKING ──────────────────────────────────────────────
   The same shell every Westmere email uses — the typographic wordmark, the
   gold rule, the signature block, the footer — with the coastal hero photo
   left OFF.

   The photo is right on a booking email: the customer has bought that car and
   that road. On a letter to a hotel or another operator it is advertising in
   the middle of an introduction, and it is what makes a first approach read as
   a mailshot. The wordmark is already type rather than an image (see
   heroShell), so removing the photo leaves a proper letterhead rather than a
   gap where a logo should be.

   The footer's "anything needs adjusting" line is booking language too, so it
   is replaced with something a stranger can read.
   GUARDRAIL: server/tests/outreach.test.js */
function letterEmail(bodyHtml, opts) {
  const o = opts || {};
  return heroShell(
    `<tr><td class="wm-pad" style="padding:34px 40px 18px;background:#FFFFFF">${bodyHtml}</td></tr>`,
    { title: o.title, hero: false,
      footerNote: 'Westmere Private Hire — chauffeur and airport transfers across Surrey & Sussex.' }
  );
}

/**
 * THE JOB OFFER, TO A DRIVER.
 *
 * The letterhead, not the customer hero — this is a colleague being offered
 * work, not a passenger being sold a journey.
 *
 * THE MONEY IS THE POINT. A driver reads one number, and it must be the number
 * that reaches his bank: the fare with the 10% already taken off. The split is
 * computed by offer-routes.computeSplit() and passed in; this function does no
 * arithmetic on it whatsoever. If it ever recomputed the fee itself there would
 * be two commission rates in the system, and the one in the email is the one a
 * driver would hold us to.
 *
 * Accept and Decline are tokenised links to a CONFIRM PAGE, never to an action
 * — the same rule as the customer's cancel. A driver's mail client fetching
 * every URL in the message must not accept a job on his behalf at 3am.
 * GUARDRAIL: server/tests/dispatch-offer.test.js
 */
async function sendDriverJobOffer(d) {
  const to = d && d.driver_email;
  if (!to || !d.ref) return false;
  const first = greetingName(d.driver_name) || 'there';
  const dateStr = formatDate(d.date, d.time);
  const pay = (d.driver_pay === null || d.driver_pay === undefined) ? null : Number(d.driver_pay);
  const payStr = pay === null ? null : '£' + pay.toFixed(2);

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:' + INK + '">' + escHtml(d.ref) + '</span>');
  rows += detailRow('Date & Time', escHtml(dateStr), { gold: true });
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(d.pickup));
  if (d.stop_address) rows += detailRow('Stop', dispAddr(d.stop_address));
  rows += detailRow('Drop-off', dispAddr(d.destination));
  const flt = dispFlight(d);
  if (flt) rows += detailRow('Flight', escHtml(flt));
  rows += rowDivider();
  rows += detailRow('Passengers', String(d.passengers || 1));
  const bagsTxt = bagsText(d.bags);
  rows += detailRow('Luggage', escHtml(bagsTxt || 'None stated'));
  const note = cleanOwnerNote(d.notes);
  if (note) rows += detailRow('Notes', escHtml(note));
  if (d.customer_note) rows += detailRow('Passenger asked for', escHtml(String(d.customer_note)));

  /* The pay, on its own, larger than anything else on the page. */
  const payBlock = payStr ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${ACCENT};margin:20px 0 4px">
    <tr><td style="padding:16px 18px;text-align:center">
      <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${INK_MUTED}">Your pay for this job</div>
      <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:34px;line-height:1.15;color:${INK};margin-top:4px">${escHtml(payStr)} to you</div>
      <div style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK_MUTED};margin-top:4px">Fare £${Number(d.fare || 0).toFixed(2)} &middot; 10% commission already deducted</div>
    </td></tr>
  </table>` : `
  <p style="margin:20px 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK_MUTED};text-align:center">The fare for this job is not set yet &mdash; we will confirm your pay before it runs.</p>`;

  let actions = '';
  if (d.offer_token) {
    const base = `${HOST}/api/public/offer/${encodeURIComponent(d.ref)}`;
    const t = `?t=${encodeURIComponent(d.offer_token)}`;
    actions = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px">
    ${actionBtn(base + '/accept' + t, 'Accept This Job', 'primary')}
    ${actionBtn(base + '/decline' + t, 'Decline', 'secondary')}
  </table>`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">A job for you</p>
  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:18px;color:${INK};font-weight:400;line-height:1.4">${escHtml(first)}, there is a job going if you want it.</p>
  <p style="margin:0 0 20px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Please check the passengers, the luggage and any special requests below before you accept &mdash; once you take it, it is yours.</p>
  ${buildDetailsTable(rows)}
  ${payBlock}
  ${actions}
  <p style="margin:22px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">You can also accept or decline in the driver app. Any questions, call 07930&nbsp;342593.</p>`;

  const html = letterEmail(body, { title: 'A job for you — ' + d.ref });
  const subject = 'Job offer' + (payStr ? ' — ' + payStr + ' to you' : '') + ' · ' + d.ref;
  const preheader = dateStr + ' · ' + shortDisplay(d.pickup) + ' → ' + shortDisplay(d.destination) + (payStr ? ' · ' + payStr + ' to you' : '');
  const ok = await sendEmail(to, subject, html, 'Westmere Dispatch', preheader);
  if (ok) console.log('[EMAIL] Driver job offer sent (' + d.ref + ' → ' + to + ', ' + (payStr || 'fare TBC') + ')');
  return ok;
}

/**
 * A message from the owner to one driver. Same letterhead, same escaping rules
 * as the customer and outreach messages — the owner's words, wrapped.
 */
async function sendDriverMessage(driver, message, opts) {
  const o = opts || {};
  const to = driver && driver.email;
  const body = String(message == null ? '' : message).trim();
  if (!to || !body) return false;
  const first = greetingName(driver.full_name) || 'there';
  const paras = escHtml(body).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.75">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  const html = letterEmail(`
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">A message from Westmere</p>
  <p style="margin:0 0 16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.55">${escHtml(first)},</p>
  ${paras}
  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Reply to this email or call 07930&nbsp;342593.</p>`,
    { title: o.subject || 'A message from Westmere' });
  const subject = o.subject || 'A message from Westmere Private Hire';
  const ok = await sendEmail(to, subject, html, 'Westmere Private Hire', body.replace(/\s+/g, ' ').slice(0, 90));
  if (ok) console.log('[EMAIL] Driver message sent to ' + to);
  return ok;
}

/**
 * A one-off branded email to anybody at all — a hotel, another operator, a
 * supplier. No booking, no customer record, no template beyond the letterhead.
 *
 * The owner's typed message is the body, escaped and with its line breaks kept.
 * It is NEVER treated as HTML: this is a field on a form that sends mail out
 * under the company's own domain, and the one thing it must not become is a way
 * to put arbitrary markup in front of somebody.
 */
async function sendOutreachMessage(to, subject, message, opts) {
  const o = opts || {};
  const addr = String(to == null ? '' : to).trim();
  const subj = String(subject == null ? '' : subject).trim();
  const body = String(message == null ? '' : message).trim();
  if (!addr || !subj || !body) return false;

  const paras = escHtml(body).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.75">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');

  const html = letterEmail(`
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">${escHtml(o.eyebrow || 'A note from Westmere')}</p>
  ${paras}`, { title: subj });

  // Replies come back to Westmere, not to the void — sendEmail sets Reply-To
  // from REPLY_TO (bookings@westmereprivatehire.co.uk).
  const preheader = body.replace(/\s+/g, ' ').slice(0, 90);
  const ok = await sendEmail(addr, subj, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Outreach sent to ' + addr + ' — "' + subj.slice(0, 60) + '"');
  return ok;
}

function confirmationEmailHtml(d) {
  // Shared branded hero template for ALL customer booking emails. `variant`
  // selects the copy/actions: 'confirmed' (default), 'estimate', or 'ack'
  // (acknowledgement). There is intentionally NO imageless fallback — every
  // one of these emails renders the hosted hero image (guardrail in
  // payment-flow.test.js / booking-ack.test.js).
  const variant = d.variant || 'confirmed';
  const fareLabel = d.fareLabel || 'Fare';
  // Owner note ONLY — the rider app used to stuff the chosen vehicle into
  // `notes` (e.g. "Vehicle: Standard Saloon"); that is NOT an owner note, so it
  // (and any blank) is dropped and the Notes row is omitted entirely.
  const ownerNote = cleanOwnerNote(d.notes);

  let rows = '';
  rows += confRow('ic-reference', 'Reference', `<span style="font-family:Menlo,Consolas,monospace;font-size:15px;letter-spacing:.5px;color:#102a43">${escHtml(d.ref)}</span>`);
  rows += confRow('ic-pickup', 'Pickup', dispAddr(d.pickup));
  if (d.stop_address) rows += confRow('ic-stop', 'Stop', dispAddr(d.stop_address));
  rows += confRow('ic-dropoff', 'Drop-off', dispAddr(d.destination));
  rows += confRow('ic-datetime', 'Date &amp; Time', escHtml(d.dateStr));
  // Airport runs only — a flight number on a town-to-town job is noise.
  const flt = dispFlight(d);
  if (flt) rows += confRow('ic-flight', 'Flight', escHtml(flt));
  if (d.passengers) rows += confRow('ic-travellers', 'Travellers', Number(d.passengers) + ' passenger' + (Number(d.passengers) === 1 ? '' : 's'));
  const bagsTxt = bagsText(d.bags);
  if (bagsTxt) rows += confRow('ic-travellers', 'Luggage', escHtml(bagsTxt));
  if (d.fareStr) rows += confRow('ic-fare', fareLabel, escHtml(d.fareStr), { fare: true });
  // A re-priced prepaid trip. What they already paid, then ONLY the difference —
  // never the whole new fare, which is the number that would take their money
  // twice for one journey.
  if (d.paidStr)   rows += confRow('ic-payment', 'Already paid', escHtml(d.paidStr));
  if (d.dueStr)    rows += confRow('ic-fare', 'Now due', escHtml(d.dueStr), { fare: true });
  if (d.refundStr) rows += confRow('ic-fare', 'Refund to you', escHtml(d.refundStr), { fare: true });
  if (d.showPaymentRow !== false) rows += confRow('ic-payment', 'Payment', escHtml(d.paymentLabel || paymentText(d)));

  // ── WHAT CHANGED (the 'updated' variant only) ──────────────────────────
  // Sits between "Dear X" and the details table, because the first question a
  // customer has when a booking email arrives unprompted is "what moved?" —
  // and the second is "so what does it say now?". The details table below
  // answers the second, in the same shape as their original confirmation.
  let changesBlock = '';
  if (Array.isArray(d.changes) && d.changes.length) {
    let diffRows = '';
    for (const [key, label] of UPDATE_FIELDS) {
      const c = d.changes.find(x => x && x.key === key);
      if (!c) continue;
      diffRows += diffRow(label, updateFieldValue(key, c.from), updateFieldValue(key, c.to));
    }
    if (diffRows) {
      const eyebrow = 'font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#102a43;font-weight:700';
      changesBlock = `<tr><td class="wm-pad" style="padding:22px 40px 0;background:#FFFFFF">
  <p style="margin:0 0 2px;${eyebrow}">What changed</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">${diffRows}</table>
  <p style="margin:0;${eyebrow}">Your booking as it now stands</p>
</td></tr>`;
    }
  }

  // For the ACKNOWLEDGEMENT (no fare/token yet) show a reassurance caption
  // instead of pay buttons.
  // The airport promises. Not on the acknowledgement: that goes out before a
  // fare exists, and promising what a fare includes before quoting one is
  // premature.
  // The car itself — on a CONFIRMED booking and on the "your booking has been
  // updated" restatement of one. Deliberately NOT on the acknowledgement or the
  // estimate: both go out before the customer has said yes, and naming the
  // driver there would promise a car for a journey nobody has agreed to run.
  let driverBlock = '';
  if (variant === 'confirmed' || variant === 'updated') {
    driverBlock = '<tr><td class="wm-pad" style="padding:6px 40px 0;background:#FFFFFF">' + driverBlockHtml(d) + '</td></tr>';
  }

  let meetGreetBlock = '';
  if (variant !== 'ack') {
    const ab = airportBlockHtml(d);
    if (ab) meetGreetBlock = '<tr><td class="wm-pad" style="padding:16px 40px 0;background:#FFFFFF">' + ab + '</td></tr>';
  }

  let captionBlock = '';
  if (variant === 'ack' && d.caption) {
    captionBlock = `<tr><td class="wm-pad" style="padding:10px 40px 2px;background:#FFFFFF">
      <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:#657485;line-height:1.65;text-align:center">${d.caption}</p>
    </td></tr>`;
  }

  // THREE uniform, full-width, stacked action buttons (owner request), all
  // gated by the per-booking pay_token (payment invariants in CLAUDE.md):
  //   a) Pay Now  b) Pay Your Driver On The Day  c) Cancel Request
  // Same size/shape via actionBtn(); only the colour emphasis differs. Shown
  // whenever there's an unpaid fare + token (estimate AND confirmation). A
  // settled/paid confirmation keeps just the Cancel button.
  // A refund email offers NOTHING to pay. The customer has already paid and is
  // owed money back — a Pay Now button on that email is the single most
  // alarming thing we could put in front of them.
  let payBlock = '';
  if (d.pay_token && !d.noActions) {
    const payUrl    = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(d.ref)}&t=${encodeURIComponent(d.pay_token)}`;
    const cashUrl   = `${HOST}/api/public/pay/${encodeURIComponent(d.ref)}/cash?t=${encodeURIComponent(d.pay_token)}`;
    const cancelUrl = `${HOST}/api/public/cancel/${encodeURIComponent(d.ref)}?t=${encodeURIComponent(d.pay_token)}`;
    // The amount the buttons are for. On a re-priced prepaid trip that is the
    // BALANCE, not the fare — the pay page charges the same figure.
    const owedStr = d.dueStr || d.fareStr;
    const payable = !d.alreadyPaid && owedStr;
    if (payable) {
      const leadIn = variant === 'estimate'
        ? `<p style="margin:0 0 16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:16px;color:#102a43;line-height:1.6;text-align:center">To confirm your journey, choose how you'd like to pay:</p>`
        : d.dueStr
        ? `<p style="margin:0 0 16px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:16px;color:#102a43;line-height:1.6;text-align:center">Only the difference is outstanding &mdash; choose how you'd like to settle it:</p>`
        : '';
      const caption = variant === 'estimate'
        ? `Nothing is confirmed until you choose &mdash; or call <a href="tel:+447930342593" style="color:#102a43;text-decoration:none">07930&nbsp;342593</a>.`
        : d.dueStr
        ? `You have already paid <strong style="color:#102a43">${escHtml(d.paidStr || '')}</strong>. Only <strong style="color:#102a43">${escHtml(d.dueStr)}</strong> is outstanding &mdash; you will not be charged the full fare again.`
        : `Pay <strong style="color:#102a43">${escHtml(d.fareStr)}</strong> securely now, or settle with your driver on the day.`;
      payBlock = `<tr><td class="wm-pad" style="padding:24px 40px 6px;background:#FFFFFF">
        ${leadIn}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${actionBtn(payUrl, d.dueStr ? ('Pay ' + escHtml(d.dueStr) + ' Now &mdash; Card, Apple Pay or Google Pay') : 'Pay Now &mdash; Card, Apple Pay or Google Pay', 'primary')}
          ${actionBtn(cashUrl, d.dueStr ? 'Pay The Difference To Your Driver' : 'Pay Your Driver On The Day', 'secondary')}
          ${actionBtn(cancelUrl, 'Cancel Request', 'danger')}
        </table>
        <p style="margin:14px 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:#657485;line-height:1.6;text-align:center">${caption}</p>
      </td></tr>`;
    } else {
      // Already paid (confirmation) — no payment needed, keep a Cancel option.
      payBlock = `<tr><td class="wm-pad" style="padding:24px 40px 6px;background:#FFFFFF">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${actionBtn(cancelUrl, 'Cancel Request', 'danger')}
        </table>
      </td></tr>`;
    }
  }
  const actionsBlock = '';

  // The refund promise, set apart in the same quoted frame the owner's own
  // messages use — so the one sentence about their money is not lost in a list
  // of journey details.
  const adjustBlock = d.adjustNote ? `<tr><td class="wm-pad" style="padding:22px 40px 4px;background:#FFFFFF">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px 18px;background:#F0F4F7;border-left:2px solid #102a43">
        <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:16px;color:#102a43;line-height:1.6">${d.adjustNote}</p>
      </td></tr></table>
    </td></tr>` : '';

  const notesBlock = ownerNote ? `<tr><td class="wm-pad" style="padding:4px 40px 8px;background:#FFFFFF">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px 18px;background:#F0F4F7;border-left:2px solid #102a43">
        <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#102a43;font-weight:700">A message from Westmere</p>
        <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:16px;color:#102a43;line-height:1.6">${escHtml(ownerNote).replace(/\n/g, '<br>')}</p>
      </td></tr></table>
    </td></tr>` : '';

  const inner = `

<tr><td class="wm-pad" style="padding:30px 40px 6px;background:#FFFFFF">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="wm-copy" valign="top">
      <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;letter-spacing:2.4px;text-transform:uppercase;color:#102a43;font-weight:700">${d.eyebrow || 'Confirmed'}</p>
      <h1 style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:30px;font-weight:400;color:#102a43;line-height:1.15">Dear ${escHtml(d.firstName)},</h1>
      <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:17px;line-height:1.65;color:#3B5268">${d.intro || 'Your journey is confirmed. A driver has been assigned and we look forward to welcoming you on the day.'}</p>
    </td>
    <td class="wm-badge" valign="top" width="118" align="center" style="width:118px;padding-left:10px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td width="58" height="58" align="center" valign="middle" style="width:58px;height:58px;border:1px solid #c8d1d9;border-radius:50%;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:22px;color:#102a43;text-align:center">W</td></tr></table>
      <p style="margin:8px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#657485;line-height:1.5">Thank you for travelling with us</p>
    </td>
  </tr></table>
</td></tr>

${changesBlock}

<tr><td class="wm-pad" style="padding:14px 40px 6px;background:#FFFFFF">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #dfe5ea">
    ${rows}
  </table>
</td></tr>

${driverBlock}
${meetGreetBlock}
${captionBlock}
${adjustBlock}
${payBlock}
${notesBlock}
${actionsBlock}`;
  return heroShell(inner, { title: 'Westmere — Booking' });
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
  const firstName = greetingName(name);

  // Estimate now renders with the SAME branded hero-image template as the
  // confirmation (variant:'estimate'). The tokenised Pay Now / Pay-driver /
  // Cancel actions are built inside the template from pay_token — the booking
  // stays PENDING until the customer acts (estimate-first invariant).
  const html = confirmationEmailHtml({
    variant: 'estimate',
    eyebrow: 'Your estimate',
    intro: 'Thank you for your enquiry. Below is the estimated fare for your journey — this is a quote, not yet a confirmed booking.',
    fareLabel: 'Estimated fare',
    showPaymentRow: false,
    ref, firstName, pickup, stop_address, destination, dateStr, flight, passengers,
    fareStr, alreadyPaid: false, pay_token, notes
  });
  const subject = 'Your estimate — ' + ref;
  const preheader = 'Estimated fare ' + fareStr + ' — pay by card, pay your driver, or reply to confirm.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer estimate sent (' + ref + ')');
  return ok;
}

/* ── Customer: THE OPERATOR EDITED YOUR BOOKING ──────────────────────────
   Sent automatically when a save in the owner or admin app moves something
   the customer travels on — the addresses, the day, the time, how many of
   them there are, the bags, the flight or the price. Nothing else emails
   them: the private note, the driver and the internal status are the
   operator's own record.

   The customer gets both halves of the answer, in that order: the was → now
   diff first, then the full journey as it now reads, in the same branded
   template as the confirmation they already have. Where the fare is still
   outstanding the usual tokenised actions come with it, so an edit that
   changes the price does not leave them with a number and no way to settle it.

   WHEN THE TRIP WAS ALREADY PAID FOR, `adjust` says what happened to the money:
     { kind:'refund', amount, method } — we owe them the difference back. The
       email promises the refund and shows NO payment options; they have paid.
     { kind:'topup',  amount, paid }   — they owe us the difference. The email
       shows what they already paid beside what is now due, and the pay options
       are for the DIFFERENCE ONLY. It never quotes the full new fare as the
       amount to pay, which would take their money twice for one journey.
   Nothing is charged or refunded by this function; it only reports.

   `changes` is [{ key, from, to }], computed server-side in the PATCH route —
   never taken from the browser.
   GUARDRAILS: server/tests/booking-updated.test.js, server/tests/fare-adjust.test.js */
async function sendCustomerBookingUpdated(booking, changes, adjust) {
  const ref   = booking.ref;
  const name  = booking.name  || booking.customer_name || booking.passenger_name;
  const email = booking.email || booking.customer_email || booking.passenger_email;
  if (!email) return false;

  const known = UPDATE_FIELDS.map(([k]) => k);
  const list = (changes || []).filter(c => c && known.includes(c.key));
  if (!list.length) return false;   // nothing customer-facing moved — say nothing

  const firstName = greetingName(name);
  const fareNum = typeof booking.fare === 'number' ? booking.fare : parseFloat(booking.fare);
  const fareStr = (!fareNum || isNaN(fareNum)) ? '' : '£' + fareNum.toFixed(2);
  const fareMoved = list.some(c => c.key === 'fare');
  // Settled = a real card payment or a stamped paid_at. A booking still owing
  // money keeps its Pay Now / Pay-driver / Cancel actions (same rule, same
  // tokens, as the estimate and the confirmation).
  const alreadyPaid = !!booking.paid_at || booking.payment === 'card';

  // ── What the money did ──
  const kind = adjust && adjust.amount > 0 ? String(adjust.kind || '') : '';
  const money = kind ? '£' + Number(adjust.amount).toFixed(2) : '';
  const paidStr = (kind && adjust.paid != null) ? '£' + Number(adjust.paid).toFixed(2) : '';
  const isRefund = kind === 'refund';
  const isTopUp  = kind === 'topup';

  let adjustNote = '';
  if (isRefund) {
    adjustNote = adjust.method === 'stripe'
      ? `Your new fare is lower than the amount you paid, so a refund of <strong>${money}</strong> will be issued to the card you paid with. Refunds usually appear within 5&ndash;10 days.`
      : `Your new fare is lower than the amount you paid, so <strong>${money}</strong> is due back to you. We will return it to you directly &mdash; call us on <a href="tel:+447930342593" style="color:#102a43;text-decoration:none">07930&nbsp;342593</a> if you would like to arrange that now.`;
  } else if (isTopUp) {
    adjustNote = `Your new fare is higher than the amount you have already paid. <strong>Only the difference of ${money} is outstanding</strong> &mdash; you will not be charged the full fare a second time.`;
  }

  const html = confirmationEmailHtml({
    variant: 'updated',
    eyebrow: 'Booking updated',
    intro: 'We have made a change to your booking. Everything not listed below stays exactly as it was.',
    fareLabel: fareMoved ? 'Updated fare' : 'Fare',
    changes: list,
    ref, firstName,
    pickup: booking.pickup, stop_address: booking.stop_address, destination: booking.destination,
    dateStr: formatDate(booking.date, booking.time),
    flight: booking.flight, passengers: booking.passengers, bags: booking.bags,
    fareStr,
    // A refund email shows no actions at all. A top-up email is payable for the
    // DIFFERENCE, so it must not be treated as settled even though paid_at is
    // set — otherwise the customer is owed a balance with no way to pay it.
    alreadyPaid: isTopUp ? false : alreadyPaid,
    noActions: isRefund,
    paidStr: isTopUp ? paidStr : '',
    dueStr:  isTopUp ? money : '',
    refundStr: isRefund ? money : '',
    adjustNote,
    pay_token: booking.pay_token,
    payment: booking.payment, paid_at: booking.paid_at,
    paymentLabel: isTopUp ? 'Difference outstanding' : (isRefund ? 'Paid — refund due to you' : null),
    showPaymentRow: true
    // `notes` is deliberately NOT passed. The confirmation email renders it as
    // "A message from Westmere", but the owner app labels that same box
    // "Private notes about this trip" — so on a NEW email we take the field at
    // the name the owner types it under and keep it out. This email is about
    // what changed; the note is not part of that.
  });

  const labels = UPDATE_FIELDS.filter(([k]) => list.some(c => c.key === k)).map(([, l]) => l.toLowerCase());
  const subject = 'Your booking has been updated — ' + ref;
  const preheader = isRefund
    ? 'We have updated ' + ref + ' — a refund of ' + money + ' is due back to you.'
    : isTopUp
    ? 'We have updated ' + ref + ' — only the difference of ' + money + ' is outstanding.'
    : 'We have updated ' + ref + ' — ' + labels.join(', ') +
      (labels.length === 1 ? ' has changed.' : ' have changed.');
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer booking-updated sent (' + ref + ') — ' + labels.join(', '));
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
  rows += detailRow('Phone', '<a href="tel:' + escAttr(phone) + '" style="color:' + INK + ';text-decoration:none;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px">' + escHtml(phone) + '</a>');
  if (email) rows += detailRow('Email', '<a href="mailto:' + escAttr(email) + '" style="color:' + INK_SOFT + ';text-decoration:none;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px">' + escHtml(email) + '</a>');
  rows += rowDivider();
  // Pickup + destination with Waze navigation links for quick tap-to-navigate.
  const puQ = encodeURIComponent(pickup || '');
  const deQ = encodeURIComponent(destination || '');
  const puWaze    = 'https://waze.com/ul?q=' + puQ + '&navigate=yes';
  const routeWaze = 'https://waze.com/ul?q=' + deQ + '&navigate=yes';
  const navLink = (url) =>
    ' <a href="' + url + '" style="color:' + ACCENT + ';font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:10px;letter-spacing:.5px;text-decoration:none;margin-left:8px">Waze</a>';
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
  const alertFlight = dispFlight(booking);
  if (alertFlight) rows += detailRow('Flight', escHtml(alertFlight));
  if (passengers) rows += detailRow('Passengers', String(passengers));
  const alertBags = bagsText(bags);
  if (alertBags) rows += detailRow('Luggage', escHtml(alertBags));
  rows += rowDivider();
  rows += detailRow('Fare', fareStr, { gold: true, large: true });
  rows += detailRow('Payment', payment === 'card' ? 'Paid online' : (payment === 'cash' ? 'Cash on the day' : 'To be decided'));
  if (notes) { rows += rowDivider(); rows += detailRow('Notes', escHtml(notes)); }

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">New booking</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">A new booking has just landed. Full details below.</p>
  ${buildDetailsTable(rows)}`;

  const html = heroEmail(body);
  const subject = ref + ' \u00b7 ' + (name || 'Guest') + ' \u00b7 ' + shortDisplay(pickup) + ' \u2192 ' + shortDisplay(destination);
  const preheader = (name || 'Guest') + ' \u2014 ' + dateStr;
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Admin alert sent (' + ref + ')');
}

/* ── JOURNEY REMINDER → THE CUSTOMER ──────────────────────────────────────
   The owner has had a 12-hour reminder for a while; the customer never did.
   This is the same sweep, the same window, a SEPARATE latch
   (bookings.customer_reminder_sent_at) so the two fire independently and each
   exactly once.

   What it carries: who is coming, when, from where to where, what is owed and
   how to settle it, and — on an airport run — the same meet & greet and flight
   tracking the confirmation promised. The remaining time is the REAL gap, from
   the same time-gap module the owner's reminder uses, so the two never disagree
   about how long is left.

   PAYMENT. The caller passes a `pay` object derived from paymentLock, because
   this module must not touch the database. When the booking is genuinely
   payable it gets BOTH doors — card and pay-the-driver — exactly as the
   estimate email does. When the customer has already chosen, or has paid, it
   gets a plain status line and no buttons: a card button pointing into a
   cash-locked booking is the dead end this codebase already fixed once.

   GUARDRAIL: server/tests/rider-reminder.test.js */
async function sendCustomerJourneyReminder(booking, opts) {
  const o = opts || {};
  const { ref, name, email, pickup, destination, stop_address, date, time,
          fare, payment, paid_at, flight, passengers, bags, pay_token } = booking;
  if (!email) return false;

  const firstName = greetingName(name);
  const dateStr = formatDate(date, time);
  const { gapPhrase } = require('./time-gap');
  // The real remaining time, from the same module the owner's reminder uses.
  const gapWords = o.gapMs == null ? 'shortly' : gapPhrase(o.gapMs);

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:' + INK + '">' + escHtml(ref) + '</span>');
  rows += detailRow('Date & Time', escHtml(dateStr), { gold: true });
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  if (stop_address) rows += detailRow('Stop', dispAddr(stop_address));
  rows += detailRow('Drop-off', dispAddr(destination));
  const remFlight = dispFlight(booking);
  if (remFlight) rows += detailRow('Flight', escHtml(remFlight));
  if (passengers) rows += detailRow('Passengers', String(passengers));
  const remBags = bagsText(bags);
  if (remBags) rows += detailRow('Luggage', escHtml(remBags));
  rows += rowDivider();
  const fareStr = (fare || fare === 0) ? ('£' + Number(fare).toFixed(2)) : null;
  if (fareStr) rows += detailRow('Fare', fareStr);
  // Never "paid" unless it genuinely is — see the payment invariants.
  const payLabel = paid_at || payment === 'card' ? 'Paid ✓'
    : payment === 'cash' ? 'Pay your driver on the day'
    : payment === 'account' || payment === 'invoice' ? 'On account'
    : 'To be arranged';
  rows += detailRow('Payment', payLabel);

  // The airport promises, identical to the confirmation's.
  const airportBlock = airportBlockHtml(booking);

  /* BOTH DOORS, or none. o.pay is { payable, amountDue } straight from
     paymentLock — the module that every other channel asks. */
  let payBlock = '';
  if (o.pay && o.pay.payable && pay_token && o.pay.amountDue > 0) {
    const dueStr = '£' + Number(o.pay.amountDue).toFixed(2);
    const payUrl  = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(pay_token)}`;
    const cashUrl = `${HOST}/api/public/pay/${encodeURIComponent(ref)}/cash?t=${encodeURIComponent(pay_token)}`;
    payBlock = `
  <p style="margin:20px 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.6;text-align:center">There is still ${escHtml(dueStr)} to settle &mdash; choose whichever suits you:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${actionBtn(payUrl, 'Pay ' + escHtml(dueStr) + ' Now &mdash; Card, Apple Pay or Google Pay', 'primary')}
    ${actionBtn(cashUrl, 'Pay Your Driver On The Day', 'secondary')}
  </table>
  ${cancelLinkHtml(ref, pay_token)}`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Your journey</p>
  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:18px;color:${INK};font-weight:400;line-height:1.4">Dear ${escHtml(firstName)}, your car is booked for ${escHtml(gapWords)}.</p>
  <p style="margin:0 0 20px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Everything is arranged and we are looking forward to taking you. Your details are below &mdash; do check them over.</p>
  ${buildDetailsTable(rows)}
  ${driverBlockHtml(booking)}
  ${airportBlock ? '<div style="margin-top:18px">' + airportBlock + '</div>' : ''}
  ${payBlock}
  <p style="margin:22px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If anything has changed, reply to this email or call us on <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930&nbsp;342593</a>.</p>`;

  const html = heroEmail(body);
  const subject = 'Your journey ' + gapWords + ' — ' + ref;
  const preheader = 'Your Westmere car is booked for ' + gapWords + ' — ' + shortDisplay(pickup) + ' → ' + shortDisplay(destination);
  const to = o.testTo || email;
  const ok = await sendEmail(to, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer journey reminder sent (' + ref + ', ' + gapWords + ') to', to);
  return ok;
}

// ── Pickup reminder → the OWNER (fires anywhere inside the next 12h) ─────
// Fired by the server-side reminder sweeper ~12h before pickup so the owner is
// never late again. Goes to the owner's own inbox (never the customer).
async function sendOwnerBookingReminder(booking, ownerEmail, nowMs) {
  const to = ownerEmail || process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!to) return false;
  // The REAL remaining time, worked out when the email is built rather than
  // assumed. The sweeper fires for anything inside the next 12 hours, so this is
  // just as often five hours or forty minutes. It passes its own sweep clock in
  // so the window decision and this sentence come from one instant; called
  // without it (a manual resend), we read the clock ourselves.
  const { ukNowMs, pickupMs, gapPhrase, urgencyLine } = require('./time-gap');
  const _now = typeof nowMs === 'number' ? nowMs : ukNowMs();
  const _pickupAt = pickupMs(booking.date, booking.time);
  const gapMs = _pickupAt == null ? null : _pickupAt - _now;
  const gapWords = gapPhrase(gapMs);
  const { ref, date, time, pickup, destination, stop_address, fare, payment,
          passengers, bags, flight, customer_name, customer_phone } = booking;
  const name  = customer_name  || booking.passenger_name  || 'Guest';
  const phone = customer_phone || booking.passenger_phone || '';
  const dateStr = formatDate(date, time);
  const fareStr = fare ? ('£' + (typeof fare === 'number' ? fare.toFixed(2) : fare)) : 'TBC';

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:' + INK + '">' + escHtml(ref) + '</span>');
  rows += detailRow('Passenger', escHtml(name));
  if (phone) rows += detailRow('Phone', '<a href="tel:' + escAttr(phone) + '" style="color:' + INK + ';text-decoration:none">' + escHtml(phone) + '</a>');
  rows += rowDivider();
  const puWaze = 'https://waze.com/ul?q=' + encodeURIComponent(pickup || '') + '&navigate=yes';
  const deWaze = 'https://waze.com/ul?q=' + encodeURIComponent(destination || '') + '&navigate=yes';
  const nav = (u) => ' <a href="' + u + '" style="color:' + ACCENT + ';font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:10px;letter-spacing:.5px;text-decoration:none;margin-left:8px">Waze</a>';
  rows += detailRow('Pickup', dispAddr(pickup) + nav(puWaze));
  if (stop_address) rows += detailRow('Stop', dispAddr(stop_address));
  rows += detailRow('Drop-off', dispAddr(destination) + nav(deWaze));
  rows += rowDivider();
  rows += detailRow('Date & Time', escHtml(dateStr), { gold: true });
  const remFlight = dispFlight(booking);
  if (remFlight) rows += detailRow('Flight', escHtml(remFlight));
  if (passengers) rows += detailRow('Passengers', String(passengers));
  const remBags = bagsText(bags);
  if (remBags) rows += detailRow('Luggage', escHtml(remBags));
  rows += rowDivider();
  rows += detailRow('Fare', fareStr);
  rows += detailRow('Payment', payment === 'card' ? 'Paid by card' : (payment === 'cash' ? 'Cash on the day' : 'To be decided'));

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Pickup reminder</p>
  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:18px;color:${INK};font-weight:400;line-height:1.4">A booking is coming up ${escHtml(gapWords)}.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">${escHtml(urgencyLine(gapMs))}</p>
  ${buildDetailsTable(rows)}`;

  const html = heroEmail(body);
  const subject = 'Reminder — ' + name + ' pickup ' + (time && time !== 'ASAP' ? 'at ' + time : '') + ' · ' + ref;
  const preheader = 'Pickup ' + gapWords + ': ' + name + ' — ' + shortDisplay(pickup) + ' → ' + shortDisplay(destination);
  const ok = await sendEmail(to, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Owner pickup reminder sent (' + ref + ', ' + gapWords + ') to', to);
  return ok;
}

// ── Helpers ──────────────────────────────────────────────────────────────
// Render a booking's date + time for a customer/owner-facing email.
//
// TIMEZONE INVARIANT \u2014 bookings.date ('YYYY-MM-DD') and bookings.time ('HH:MM')
// are UK wall-clock strings, NOT instants. The correct rendering is therefore a
// pure calendar-date rendering: no timezone conversion may happen at all.
//
// We build the date at UTC midnight and format it with timeZone:'UTC', so the
// weekday is always the literal calendar date's weekday regardless of the host
// timezone (Railway runs UTC, dev machines do not).
//
// DO NOT "fix" this by adding timeZone:'Europe/London' to the formatter while
// parsing the string as a local instant \u2014 that combination genuinely shifts the
// day. `new Date('2026-08-16T21:00')` formatted in Europe/London renders
// "Monday 17 August 2026" on any host west of London. Guarded by
// server/tests/timezone-dayofweek.test.js.
function formatDate(date, time) {
  if (!date) return 'Not specified';
  try {
    let str;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      str = d.toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
    } else {
      // Non ISO-date input (legacy/free-text) \u2014 fall back to a local parse, which
      // is self-consistent because the formatter is local too.
      str = new Date(date + 'T' + (time || '00:00')).toLocaleDateString('en-GB', opts);
    }
    if (time && time !== 'ASAP') str += ' \u00b7 ' + time;
    else if (time === 'ASAP') str += ' \u00b7 ASAP';
    return str;
  } catch (e) {
    return date + (time ? ' \u00b7 ' + time : '');
  }
}

/* ── HOW WE ADDRESS SOMEBODY ──────────────────────────────────────────────
   Fifteen emails each did `(name || '').split(' ')[0]`, which is right only
   when the customer typed a bare first name. Most do not: this database is
   full of "Mr J Whitfield", and every acknowledgement, estimate, confirmation,
   cancellation, reminder, invoice and review request opened "Dear Mr,".

   The rule, in the register a private-hire firm actually writes in:
     · a title is present  → Title + surname   "Mr J Whitfield" → "Mr Whitfield"
     · no title            → first name        "Eleanor Whitfield" → "Eleanor"
     · only an initial     → the name as given "J Whitfield" → "J Whitfield"
     · nothing usable      → the fallback      "" → "there"

   Formal where they were formal, familiar where they were familiar — and never
   a title on its own. GUARDRAIL: server/tests/greeting.test.js */
const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|lord|lady|rev|reverend|capt|captain)\.?$/i;

function greetingName(full, fallback) {
  const parts = String(full == null ? '' : full).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback || 'there';
  const title = TITLES.test(parts[0]) ? parts[0].replace(/\.$/, '') : null;
  const rest = title ? parts.slice(1) : parts;
  if (!rest.length) return fallback || 'there';        // a title and nothing else
  if (title) {
    // Title + the last name they gave. "Dr A Patel" → "Dr Patel".
    return title + ' ' + rest[rest.length - 1];
  }
  // No title. A leading initial ("J Whitfield") reads oddly as a first name,
  // so use what they wrote rather than inventing familiarity.
  if (/^[A-Za-z]\.?$/.test(rest[0])) return rest.join(' ');
  return rest[0];
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
  const firstName = greetingName(full_name);

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Account opened</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for choosing Westmere Private Hire. Your account has been opened and is ready to use.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding:9px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:120px;font-weight:600">Account holder</td>
      <td style="padding:9px 0 9px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.45">${escHtml(full_name || '')}</td>
    </tr>
  </table>

  <p style="margin:24px 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">How it works:</p>
  <ul style="margin:0 0 18px;padding:0 0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">
    <li>Book any journey by phone, email, or WhatsApp &mdash; just mention your name</li>
    <li>You'll receive a confirmation for every booking, with driver details</li>
    <li>We will send you an itemised invoice for your journeys &mdash; pay by bank transfer at your convenience</li>
  </ul>
`;

  const html = heroEmail(body);
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
  const firstName = greetingName(full_name);
  settings = settings || {};

  const rows = (bookings || []).map(b => {
    const fare = +b.fare || 0;
    const dateStr = formatDate(b.date, b.time);
    const routeStr = dispAddr(b.pickup) + ' &rarr; ' + dispAddr(b.destination);
    const refStr = '<span style="font-family:Menlo,Consolas,monospace;font-size:11px;color:' + INK_MUTED + '">' + escHtml(b.ref || '') + '</span>';
    const rowFlight = dispFlight(b);   // airport runs only
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK};vertical-align:top">
        <div>${escHtml(dateStr)}</div>
        <div style="margin-top:3px">${refStr}</div>
      </td>
      <td style="padding:10px 10px;border-bottom:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK};line-height:1.45;vertical-align:top">${routeStr}${rowFlight ? '<div style="color:' + INK_MUTED + ';font-size:11px;margin-top:3px">Flight ' + escHtml(rowFlight) + '</div>' : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};text-align:right;vertical-align:top;white-space:nowrap">&pound;${fare.toFixed(2)}</td>
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
      <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Payment details</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${settings.bank_name ? `<tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Bank</td><td style="padding:3px 0 3px 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.bank_name)}</td></tr>` : ''}
        ${settings.account_name ? `<tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Name</td><td style="padding:3px 0 3px 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.account_name)}</td></tr>` : ''}
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Sort code</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.sort_code)}</td></tr>
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Account no.</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.account_no)}</td></tr>
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Reference</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(invoiceNo)}</td></tr>
      </table>
    </td></tr>
  </table>` : `<p style="margin:22px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Payment is appreciated within 14 days by bank transfer. Please contact us for account details.</p>`;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Invoice &middot; ${escHtml(period.label || '')}</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please find attached your invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo)}</span> for ${escHtml(period.label || 'this period')}.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">The total amount is <strong style="color:${INK}">&pound;${total.toFixed(2)}</strong>. Payment details are included below for your convenience.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">Invoice no.</td>
      <td style="padding:6px 0 6px 14px;font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK}">${escHtml(invoiceNo || '')}</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">From</td>
      <td style="padding:6px 0 6px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK};line-height:1.6">${fromAddr}</td>
    </tr>
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">Bill to</td>
      <td style="padding:6px 0 6px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(full_name || '')}${customer.phone ? '<br><span style="font-size:12px;color:' + INK_SOFT + '">' + escHtml(customer.phone) + '</span>' : ''}${customer.email ? '<br><span style="font-size:12px;color:' + INK_SOFT + '">' + escHtml(customer.email) + '</span>' : ''}</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px">
    <thead>
      <tr>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:600">Date &amp; Ref</th>
        <th style="padding:0 10px 8px;border-bottom:2px solid ${INK};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:600">Journey</th>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:600">Fare</th>
      </tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="3" style="padding:22px 0;text-align:center;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_MUTED};font-style:italic">No journeys in this period.</td></tr>`}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="padding:14px 10px 6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:600">Subtotal (${summaryCount} journey${summaryCount === 1 ? '' : 's'})</td>
        <td style="padding:14px 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};text-align:right">&pound;${subtotal.toFixed(2)}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding:6px 10px 6px 0;border-top:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total</td>
        <td style="padding:6px 0;border-top:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:18px;color:${ACCENT};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${bankSection}

  <div style="text-align:center;margin:28px 0 10px">
    ${emailBtn(`https://westmereprivatehire.co.uk/api/public/invoice/${escHtml(invoiceNo)}/pdf`, `Download Invoice PDF`, `secondary`, false)}
  </div>

  <p style="margin:18px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">We hope this is all in order. If you have any questions or would like to discuss anything, please don't hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>
  <p style="margin:12px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Thank you as always for choosing Westmere Private Hire. We look forward to welcoming you on your next journey.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(recipient.name);

  const rows = (items || []).map(it => {
    const amount = +it.amount || 0;
    let datePrefix = '';
    if (it.date && String(it.date).trim()) {
      try {
        datePrefix = new Date(it.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' \u2014 ';
      } catch (_) {}
    }
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.5;vertical-align:top">${datePrefix ? `<span style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;color:${INK_MUTED}">${escHtml(datePrefix)}</span>` : ''}${escHtml(it.description || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};text-align:right;vertical-align:top;white-space:nowrap">&pound;${amount.toFixed(2)}</td>
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
      <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Payment details</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${settings.bank_name ? `<tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Bank</td><td style="padding:3px 0 3px 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.bank_name)}</td></tr>` : ''}
        ${settings.account_name ? `<tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Name</td><td style="padding:3px 0 3px 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(settings.account_name)}</td></tr>` : ''}
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Sort code</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.sort_code)}</td></tr>
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Account no.</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(settings.account_no)}</td></tr>
        <tr><td style="padding:3px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};width:100px;font-weight:600">Reference</td><td style="padding:3px 0 3px 10px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${INK}">${escHtml(invoiceNo)}</td></tr>
      </table>
    </td></tr>
  </table>` : `<p style="margin:22px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Payment is appreciated within 14 days by bank transfer. Please contact us for account details.</p>`;

  const notesSection = period && period.notes ? `
  <p style="margin:20px 0 0;padding:12px 14px;background:rgba(16,42,67,.08);border-left:2px solid ${ACCENT};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.6">${escHtml(period.notes).replace(/\n/g, '<br>')}</p>` : '';

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Invoice</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please find attached invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo)}</span> from Westmere Private Hire.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">The total amount is <strong style="color:${INK}">&pound;${total.toFixed(2)}</strong>. Payment details are included below for your convenience.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">Invoice no.</td>
      <td style="padding:6px 0 6px 14px;font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK}">${escHtml(invoiceNo || '')}</td>
    </tr>
    ${issuedStr ? `<tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">Issued</td>
      <td style="padding:6px 0 6px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK}">${escHtml(issuedStr)}</td>
    </tr>` : ''}
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">From</td>
      <td style="padding:6px 0 6px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK};line-height:1.6">${fromAddr}</td>
    </tr>
    <tr><td colspan="2" style="padding:2px 0"><div style="border-top:1px solid ${HAIRLINE}"></div></td></tr>
    <tr>
      <td style="padding:6px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};vertical-align:top;width:110px;font-weight:600">Bill to</td>
      <td style="padding:6px 0 6px 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.6">${toAddr}</td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px">
    <thead>
      <tr>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:left;font-weight:600">Description</th>
        <th style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${INK_MUTED};text-align:right;font-weight:600">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:${INK};text-align:right;font-weight:600">Total</td>
        <td style="padding:14px 0 6px;border-top:1px solid ${HAIRLINE};font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:18px;color:${ACCENT};text-align:right;font-weight:500">&pound;${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  ${notesSection}
  ${bankSection}

  <div style="text-align:center;margin:28px 0 10px">
    ${emailBtn(`https://westmereprivatehire.co.uk/api/public/invoice/${escHtml(invoiceNo)}/pdf`, `Download Invoice PDF`, `secondary`, false)}
  </div>

  <p style="margin:18px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions about this invoice, please don&rsquo;t hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>
  <p style="margin:12px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Thank you for choosing Westmere Private Hire.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(recipient.name);
  const totalStr = (Number(total) || 0).toFixed(2);
  const pdfUrl = `https://westmereprivatehire.co.uk/api/public/invoice/${encodeURIComponent(invoiceNo || '')}/pdf`;

  const payBtn = payUrl ? `
  <div style="text-align:center;margin:26px 0 8px">
    ${emailBtn(`${escHtml(payUrl)}`, `Pay Now`, `primary`, false)}
  </div>` : '';

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Payment reminder</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">This is a gentle reminder that invoice <span style="font-family:Menlo,Consolas,monospace;font-size:13px">${escHtml(invoiceNo || '')}</span> for <strong style="color:${INK}">&pound;${totalStr}</strong> remains outstanding.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you&rsquo;ve already made payment, please disregard this message &mdash; and thank you.</p>
  ${payBtn}
  <div style="text-align:center;margin:${payUrl ? '14px' : '26px'} 0 8px">
    ${emailBtn(`${pdfUrl}`, `View Invoice`, `secondary`, false)}
  </div>
  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions about this invoice, please don&rsquo;t hesitate to get in touch &mdash; we&rsquo;re always happy to help.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(full_name);
  // Must land on the customer account app — westmere-rider.html is the ONLY page
  // that reads `reset_token` from the query and shows the reset form. The old
  // `/?skip=1&reset_token=` pointed at index.html (the marketing homepage), which
  // has no reset handling at all, so every reset link was dead on arrival.
  const resetUrl = `https://westmereprivatehire.co.uk/westmere-rider.html?reset_token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Password reset</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">We received a request to reset the password on your Westmere account. Click the button below to choose a new one.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        ${emailBtn(`${resetUrl}`, `Reset Password`, `primary`, false)}
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">This link will expire in one hour. If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(full_name);
  const resetUrl = `https://westmereprivatehire.co.uk/westmere-admin.html?reset_token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Admin password reset</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">We received a request to reset the password for your Westmere admin account. Click the button below to choose a new one.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        ${emailBtn(`${resetUrl}`, `Reset Password`, `primary`, false)}
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">This link will expire in one hour. If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(name);

  let rows = '';
  rows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:'+INK+'">' + ref + '</span>');
  rows += rowDivider();
  rows += detailRow('Pickup', dispAddr(pickup));
  rows += detailRow('Drop-off', dispAddr(destination));
  rows += detailRow('Date', dateStr);
  const cxFlight = dispFlight(booking);
  if (cxFlight) rows += detailRow('Flight', escHtml(cxFlight));
  if (fareStr) { rows += rowDivider(); rows += detailRow('Original fare', fareStr); }

  const reasonBlock = cancellation_reason
    ? `<p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Reason: ${escHtml(cancellation_reason)}</p>`
    : '';

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Cancellation</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Unfortunately we\u2019re unable to accommodate your booking. We apologise for the inconvenience.</p>
  ${reasonBlock}
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you have already paid by card we will refund you in full within two working days. Please reply to this email or call us if you would like us to arrange an alternative \u2014 we will do our best to help.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">With our sincere apologies,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = heroEmail(body);
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
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#102a43;text-align:right;font-family:Menlo,Consolas,monospace;font-weight:600">£${(+it.net||0).toFixed(2)}</td>
    </tr>`).join('');
  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#102a43;font-weight:700">Driver Statement</p>
  <h2 style="font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:22px;font-weight:400;color:#102a43;margin:0 0 8px">Hi ${escHtml(driver.name || 'driver')},</h2>
  <p style="font-size:15px;color:#3B5268;line-height:1.6;margin:0 0 16px">Here is your earnings summary for <strong>${period.from}</strong> to <strong>${period.to}</strong>.</p>
  <div style="display:flex;gap:12px;margin:16px 0 10px;flex-wrap:wrap">
    <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Jobs</div><div style="font-size:18px;color:#111D2C;margin-top:2px">${totals.jobs}</div></div>
    <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Gross</div><div style="font-size:18px;color:#111D2C;margin-top:2px">£${(+totals.gross||0).toFixed(2)}</div></div>
    <div style="flex:1;min-width:110px;padding:10px 12px;background:#fafafa;border:1px solid #eee"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888">Commission (10%)</div><div style="font-size:18px;color:#9C2828;margin-top:2px">£${(+totals.commission||0).toFixed(2)}</div></div>
    <div style="flex:1;min-width:110px;padding:10px 12px;background:rgba(16,42,67,.08);border:1px solid rgba(16,42,67,.25)"><div style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43">Net due to you</div><div style="font-size:18px;color:#102a43;margin-top:2px;font-weight:600">£${(+totals.net||0).toFixed(2)}</div></div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-top:12px">
    <thead><tr>
      <th style="padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43;border-bottom:2px solid #102a43">Date</th>
      <th style="padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43;border-bottom:2px solid #102a43">Journey</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43;border-bottom:2px solid #102a43">Fare</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43;border-bottom:2px solid #102a43">Fee</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#102a43;border-bottom:2px solid #102a43">Net</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#999;font-size:12px">No jobs this period.</td></tr>'}</tbody>
  </table>`;
  const html = heroEmail(body, { title: 'Westmere — Driver Statement' });
  return sendEmail(driver.email, `Westmere — Weekly statement (${period.from} to ${period.to})`, html, 'Westmere Payroll', `Your earnings summary: £${(+totals.net||0).toFixed(2)} net`);
}

// ── Driver welcome email (sent when admin creates a driver account) ─────────
async function sendDriverWelcome(driver) {
  const { email, full_name, username, temp_password } = driver;
  if (!email) return false;

  const firstName = greetingName(full_name, 'Driver');
  const appUrl = 'https://westmereprivatehire.co.uk/westmere-driver.html';

  const body = `
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Welcome to Westmere Private Hire. Your driver account is ready — please log in at your earliest convenience to complete your profile and upload your documents.</p>
  ${buildDetailsTable(
    detailRow('Username', `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:${INK}">${escHtml(username)}</span>`) +
    rowDivider() +
    detailRow('Password', `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:${ACCENT}">${escHtml(temp_password || '(use the password you were given)')}</span>`) +
    rowDivider() +
    detailRow('Driver App', `<a href="${appUrl}" style="color:${ACCENT};text-decoration:none">westmereprivatehire.co.uk/westmere-driver.html</a>`)
  )}
  <p style="margin:22px 0 10px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${INK_MUTED};font-weight:600">Getting started</p>
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">1. Open the driver app on your phone and log in with the credentials above.</p>
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">2. Go to <em>Profile</em> and complete your personal details.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.7">3. Upload your required documents — DBS, licence, PHV badge, insurance, and MOT — so they can be reviewed and approved before you start accepting jobs.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:11px;color:${INK_MUTED};line-height:1.6">For security, please change your password once you have logged in. If you have any questions, reply to this email or contact us directly.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(full_name);
  const verifyUrl = `https://westmereprivatehire.co.uk/api/auth/customer/verify?token=${token}`;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Verify your email</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for creating a Westmere account. Please verify your email address to activate it.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0">
    <tr>
      <td align="center">
        ${emailBtn(`${verifyUrl}`, `Verify Email Address`, `primary`, false)}
      </td>
    </tr>
  </table>

  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">If the button above does not work, copy and paste this link into your browser:</p>
  <p style="margin:0 0 22px;font-family:Menlo,Consolas,monospace;font-size:11px;color:${ACCENT};word-break:break-all;line-height:1.6">${escHtml(verifyUrl)}</p>

  <p style="margin:0 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK_MUTED};line-height:1.6">This link will remain valid until your account is verified. If you did not create a Westmere account, you can safely ignore this email.</p>`;

  const html = heroEmail(body);
  const subject = 'Verify your Westmere account';
  const preheader = 'One click to activate your account — then you can book and manage journeys online.';
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Verification email sent to', email);
  return ok;
}

// ── Recommendation email ─────────────────────────────────────────────────
// Branded invitation using the same hero template as all other Westmere emails.
async function sendRecommendation(recipientEmail) {
  if (!recipientEmail) return false;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">You've been recommended</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Hello,</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Someone you know thought you&rsquo;d appreciate our private hire service. We provide premium private-hire transfers across Sussex &mdash; airport runs to Gatwick and Heathrow, corporate travel, special occasions, and reliable local journeys.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">Licensed by Lewes District Council. Professional, punctual, and always at your service.</p>
  <div style="text-align:center;margin:26px 0 8px">
    ${emailBtn(`https://westmereprivatehire.co.uk`, `Book Your Journey`, `secondary`, false)}
  </div>
  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">We look forward to welcoming you.</p>`;

  const html = heroEmail(body);
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
  const firstName = greetingName(name);
  // What the pay page will actually take. Normally the fare; on a re-priced
  // prepaid trip the caller passes the balance, and naming the fare here would
  // promise a bigger charge than the button makes.
  const due = booking.amountDue == null ? fare : booking.amountDue;
  const fareStr = due ? '\u00a3' + Number(due).toFixed(2) : '';
  const dateStr = formatDate(date, time);

  /* BOTH DOORS, NOT ONE.
     This email used to carry a single "Pay Now" button. That was wrong twice
     over: it hid the cash option the pay page has always offered, and when the
     booking was locked to cash it sent a card button to someone who could not
     use it. The route now refuses to send into a cash-locked booking at all
     (server/api.js), and what goes out shows the same two choices the estimate
     email does, pointing at the same tokenised endpoints.
     GUARDRAIL: server/tests/payment-option.test.js */
  let payBlock = '';
  if (pay_token && fareStr) {
    const payUrl  = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(pay_token)}`;
    const cashUrl = `${HOST}/api/public/pay/${encodeURIComponent(ref)}/cash?t=${encodeURIComponent(pay_token)}`;
    payBlock = `
  <p style="margin:22px 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.6;text-align:center">Choose how you&rsquo;d like to settle it:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${actionBtn(payUrl, 'Pay ' + escHtml(fareStr) + ' Now &mdash; Card, Apple Pay or Google Pay', 'primary')}
    ${actionBtn(cashUrl, 'Pay Your Driver On The Day', 'secondary')}
  </table>
  <p style="margin:12px 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.6;text-align:center">Either is fine &mdash; cash or card with the driver on the day, or online now. Prefer to talk? Call <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930&nbsp;342593</a>.</p>`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Payment reminder</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Thank you for travelling with us. We noticed that payment for your recent journey has not yet been completed.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Your trip from <strong>${dispAddr(pickup)}</strong> to <strong>${dispAddr(destination)}</strong> on ${dateStr}${fareStr ? ' for <strong style="color:' + ACCENT + '">' + fareStr + '</strong>' : ''} is still outstanding.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">If you&rsquo;ve already made payment, please disregard this message. Otherwise, you can pay online now or simply settle with your driver on the day &mdash; whichever suits you.</p>
  ${payBlock}
  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have any questions, please don&rsquo;t hesitate to get in touch.</p>`;

  const html = heroEmail(body);
  const subject = 'Payment reminder \u2014 ' + (ref || 'your journey') + ' \u00b7 Westmere Private Hire';
  const preheader = fareStr ? fareStr + ' outstanding — pay by card or settle with your driver' : 'Payment outstanding for your recent journey';
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
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Introduction</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(contactName)},</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I hope this message finds you well. My name is Nikodem Krajnyk and I am the owner and operator of <strong style="color:${INK}">Westmere Private Hire</strong>, a licensed driver service based in Sussex.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;m reaching out to introduce myself and to offer my services should you ever find yourself in need of additional driver support during busy periods, overflow work, or when covering a wider area. I understand the demands of running a private hire business and I&rsquo;m always happy to help fellow operators.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">What I offer</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Premium saloon vehicle (Tesla Model S)</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Fully licensed by Lewes District Council</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Professional, reliable, well-presented</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Airport transfers (Gatwick, Heathrow, Stansted, Luton, Southampton, London City)</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Corporate &amp; long-distance journeys across Sussex, Surrey &amp; London</td></tr>
    <tr><td style="padding:4px 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Available for subcontract work at competitive rates</td></tr>
  </table>

  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;d welcome the opportunity to discuss how we might work together. Whether it&rsquo;s a one-off job or ongoing support, I&rsquo;m flexible and dependable.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Please feel free to get in touch at any time &mdash; I&rsquo;d be delighted to hear from you.</p>

  <div style="text-align:center;margin:22px 0 8px">
    ${emailBtn(`https://westmereprivatehire.co.uk`, `Visit Our Website`, `secondary`, false)}
  </div>

  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With warm regards,</p>
  <p style="margin:4px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65"><strong>Nikodem Krajnyk</strong><br>
  <span style="color:${INK_SOFT}">Owner &amp; Operator</span><br>
  <span style="color:${INK_SOFT}">Westmere Private Hire</span></p>
  <p style="margin:8px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK_MUTED};line-height:1.6">
  <a href="tel:+447930342593" style="color:${ACCENT};text-decoration:none">07930 342 593</a> &nbsp;&middot;&nbsp;
  <a href="mailto:westmereprivatehire@gmail.com" style="color:${ACCENT};text-decoration:none">westmereprivatehire@gmail.com</a><br>
  66 High Street, Lewes, BN7 1XG &nbsp;&middot;&nbsp; Licensed by Lewes District Council</p>`;

  const html = heroEmail(body);
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
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Introduction</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">${greeting},</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">My name is Nikodem Krajnyk and I am the owner of <strong style="color:${INK}">Westmere Private Hire</strong>, a licensed driver service based locally in Sussex.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;m writing to introduce our services, which are ideally suited for businesses in the Horsham and Crawley area. Whether your team needs reliable airport transfers, client pickups, or comfortable transport for meetings and events, we provide a discreet, professional service at competitive corporate rates.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}">
    <tr><td style="padding:14px 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Our services</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Airport transfers &mdash; Gatwick, Heathrow, Stansted, Luton, Southampton &amp; London City</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Premium saloon vehicle (Tesla Model S) &mdash; comfortable, quiet, zero-emission</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Corporate account with monthly invoicing &mdash; no upfront payments needed</td></tr>
    <tr><td style="padding:4px 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Client pickups, meetings &amp; events across Sussex, Surrey &amp; London</td></tr>
    <tr><td style="padding:4px 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK};line-height:1.7">&bull; Fully licensed by Lewes District Council &mdash; professional, reliable, well-presented</td></tr>
  </table>

  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">Many local businesses trust us for their regular travel needs. We offer a simple booking system, flight tracking for airport pickups, and the flexibility to handle last-minute requests.</p>
  <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">I&rsquo;d welcome the opportunity to discuss how we could support your team. Please don&rsquo;t hesitate to get in touch.</p>

  <div style="text-align:center;margin:22px 0 8px">
    ${emailBtn(`https://westmereprivatehire.co.uk`, `Visit Our Website`, `secondary`, false)}
  </div>

  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With kind regards,</p>
  <p style="margin:4px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65"><strong>Nikodem Krajnyk</strong><br>
  <span style="color:${INK_SOFT}">Owner &amp; Operator</span><br>
  <span style="color:${INK_SOFT}">Westmere Private Hire</span></p>
  <p style="margin:8px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:12px;color:${INK_MUTED};line-height:1.6">
  <a href="tel:+447930342593" style="color:${ACCENT};text-decoration:none">07930 342 593</a> &nbsp;&middot;&nbsp;
  <a href="mailto:westmereprivatehire@gmail.com" style="color:${ACCENT};text-decoration:none">westmereprivatehire@gmail.com</a><br>
  66 High Street, Lewes, BN7 1XG &nbsp;&middot;&nbsp; Licensed by Lewes District Council</p>`;

  const html = heroEmail(body);
  const subject = 'Premium Driver Services for ' + (companyName || 'Your Business') + ' — Westmere Private Hire';
  const preheader = 'Local licensed driver service offering corporate accounts, airport transfers and premium travel';
  const ok = await sendEmail(recipientEmail, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Corporate intro sent to', recipientEmail, companyName || '');
  return ok;
}

// ── Review request (sent once per customer after their first completed job) ──
/* ── WHERE WE ASK FOR REVIEWS ─────────────────────────────────────────────
   Two links, declared once. Google is the business's own profile, keyed by the
   CID that reviews.js and the homepage widget already use — payment-flow's
   guard asserts the email and the site never drift apart on it. Trustpilot is
   the /evaluate/ path, which opens the write-a-review form directly rather
   than the profile page a customer would then have to find the button on. */
const GOOGLE_REVIEW_LINK     = 'https://g.page/r/Ce764VxFTR4VEAE/review';
const TRUSTPILOT_REVIEW_LINK = 'https://uk.trustpilot.com/evaluate/westmereprivatehire.co.uk';

async function sendReviewRequest(email, firstName, ref) {
  if (!email) return;
  /* This one takes the name as a PARAMETER, which is exactly why it escaped the
     sweep that fixed the other fifteen: there was no `(name||'').split(' ')[0]`
     in this file to find. The caller had it instead, so a booking for
     "Mr Ben" arrived here as "Mr" and the email opened "Dear Mr,".
     greetingName is applied here as well as at the call site — it is
     idempotent ("Ben" stays "Ben"), so a caller that already passes a clean
     first name loses nothing, and one that passes a full name is handled.
     GUARDRAIL: server/tests/review-links.test.js */
  firstName = greetingName(firstName);
  const body = `
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};font-style:italic;line-height:1.65">Thank you for travelling with us today${ref ? ' (booking ' + escHtml(ref) + ')' : ''}. We truly hope your journey was comfortable and that we met your expectations.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">If you have a spare moment, we would be deeply grateful if you could share a few words about your experience &mdash; on Google or on Trustpilot, whichever you already use. Reviews help other travellers find us and allow us to keep doing what we love.</p>
  <!-- BOTH platforms, because a customer already has an account on one of them
       and will not create one on the other. Google first: it is the business's
       own profile (CID Ce764VxFTR4VEAE — the same link reviews.js puts on the
       site, pinned by payment-flow.test.js so the two can never drift), and it
       is where a search for "Westmere Private Hire" lands. Trustpilot second,
       on the UK domain so a British customer is not bounced through the
       "go to the British site" interstitial on the way to writing a review.
       Both are the framed navy emailBtn — no fill, no gold, and emphatically
       no Trustpilot green. GUARDRAIL: server/tests/review-links.test.js -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 22px">
    <tr><td style="padding-bottom:12px">${emailBtn(`${GOOGLE_REVIEW_LINK}`, `Review us on Google`, `primary`, true)}</td></tr>
    <tr><td>${emailBtn(`${TRUSTPILOT_REVIEW_LINK}`, `Review us on Trustpilot`, `trustpilot`, true)}</td></tr>
  </table>
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">It takes less than a minute and means a great deal to a small, independent business like ours.</p>
  <p style="margin:20px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.65">With warm thanks,<br><span style="color:${INK}">Westmere Private Hire</span></p>`;

  const html = heroEmail(body);
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
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Request cancelled</p>
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">The customer has cancelled the request.</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">They clicked <strong>Cancel Request</strong> in their email — the booking has been marked cancelled. No further action is needed unless you wish to follow up.</p>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Westmere Private Hire</p>`;

  const html = heroEmail(body);
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
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Special requirement</p>
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">The customer has left a note for their journey.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr><td style="padding:14px 16px;background:#F0F4F7;border-left:2px solid ${ACCENT}">
    <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.6">${escHtml(note).replace(/\n/g, '<br>')}</p>
  </td></tr></table>
  ${buildDetailsTable(rows)}
  <p style="margin:26px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Westmere Private Hire</p>`;

  const html = heroEmail(body);
  const subject = 'Customer note — ' + ref;
  const preheader = (name || 'The customer') + ' left a special requirement for ' + ref;
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Owner customer-note alert sent (' + ref + ')');
  return ok;
}

// ── Owner alert: customer asked to CHANGE an existing booking ────────────
//
// NOTHING HAS BEEN CHANGED when this email goes out. The customer filled in
// what they would like instead; the booking itself is untouched and stays in
// whatever state it was in. This email exists so the owner can decide and
// apply the amendment by hand — so it has to make two things obvious at a
// glance: WHICH booking, and EXACTLY what is different. Every field the
// customer edited is rendered as `was → now` with the new value in gold;
// fields they left alone are listed once, plainly, as context.
//
// `cr` is the record written to change_requests: { current, requested,
// changed, note, contact }. `changed` is the diff — the keys the customer
// actually altered — computed server-side, never trusted from the browser.
// GUARDRAIL: server/tests/change-request.test.js.
const CHANGE_FIELDS = [
  ['pickup',       'Pickup'],
  ['stop_address', 'Stop'],
  ['destination',  'Drop-off'],
  ['date',         'Date'],
  ['time',         'Time'],
  ['passengers',   'Passengers'],
  ['bags',         'Luggage'],
  ['flight',       'Flight']
];

// Render one field's value for the owner's eye. Addresses go through the
// shared shortener (same as every other surface); luggage through the shared
// bag label; everything else is printed as given. '—' for genuinely empty.
function changeFieldValue(key, value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return '—';
  if (key === 'pickup' || key === 'stop_address' || key === 'destination') return escHtml(shortDisplay(raw));
  if (key === 'bags') return escHtml(bagsLabel(raw) || bagsText(raw) || raw);
  if (key === 'flight') return escHtml(raw.toUpperCase());
  return escHtml(raw);
}

async function sendOwnerChangeRequest(booking, cr) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return false;
  cr = cr || {};
  const current   = cr.current   || {};
  const requested = cr.requested || {};
  const changed   = cr.changed   || {};
  const contact   = cr.contact   || {};
  const ref = booking.ref || '';

  // ── What actually differs ──
  let diffRows = '';
  for (const [key, label] of CHANGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(changed, key)) continue;
    diffRows += diffRow(label, changeFieldValue(key, current[key]), changeFieldValue(key, requested[key]));
  }

  // ── The booking as it stands (unchanged), so the owner can find it ──
  let ctxRows = '';
  ctxRows += detailRow('Reference', '<span style="font-family:Menlo,Consolas,monospace;font-size:13px;letter-spacing:.5px;color:' + INK + '">' + escHtml(ref) + '</span>');
  if (contact.name)  ctxRows += detailRow('Customer', escHtml(contact.name));
  if (contact.email) ctxRows += detailRow('Email', '<a href="mailto:' + escAttr(contact.email) + '" style="color:' + INK + ';text-decoration:none">' + escHtml(contact.email) + '</a>');
  if (contact.phone) ctxRows += detailRow('Phone', '<a href="tel:' + escAttr(contact.phone) + '" style="color:' + INK + ';text-decoration:none">' + escHtml(contact.phone) + '</a>');
  ctxRows += rowDivider();
  ctxRows += detailRow('Pickup', changeFieldValue('pickup', current.pickup));
  if (current.stop_address) ctxRows += detailRow('Stop', changeFieldValue('stop_address', current.stop_address));
  ctxRows += detailRow('Drop-off', changeFieldValue('destination', current.destination));
  ctxRows += detailRow('Booked for', formatDate(current.date, current.time));
  if (booking.fare && !isNaN(Number(booking.fare))) {
    ctxRows += rowDivider();
    ctxRows += detailRow('Current fare', '£' + Number(booking.fare).toFixed(2));
  }

  const noteBlock = cr.note ? `
  <p style="margin:0 0 8px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};font-weight:600">In their words</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px"><tr><td style="padding:14px 16px;background:#F0F4F7;border-left:2px solid ${ACCENT}">
    <p style="margin:0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.6">${escHtml(cr.note).replace(/\n/g, '<br>')}</p>
  </td></tr></table>` : '';

  const diffBlock = diffRows ? `
  <p style="margin:0 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};font-weight:600">Requested changes</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px">${diffRows}</table>`
    : `
  <p style="margin:0 0 26px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65">They did not edit any of the journey fields — see their note above.</p>`;

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">Change requested &middot; ${escHtml(ref)}</p>
  <p style="margin:0 0 18px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">The customer has asked to change this booking.</p>
  <p style="margin:0 0 24px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK_SOFT};line-height:1.65"><strong style="color:${INK}">Nothing has been altered.</strong> Booking ${escHtml(ref)} is exactly as it was &mdash; same journey, same fare, same status. Apply the amendment by hand in the owner app if you are happy with it, then let them know.</p>
  ${noteBlock}
  ${diffBlock}
  <p style="margin:0 0 4px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:${INK_MUTED};font-weight:600">The booking as it stands</p>
  ${buildDetailsTable(ctxRows)}
  <p style="margin:26px 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">Westmere Private Hire</p>`;

  const html = heroEmail(body, { title: 'Change requested — ' + ref });
  const subject = 'Change requested — ' + ref;
  const changedLabels = CHANGE_FIELDS
    .filter(([k]) => Object.prototype.hasOwnProperty.call(changed, k))
    .map(([, label]) => label.toLowerCase());
  const preheader = (contact.name || 'The customer') + ' asked to change ' + ref +
    (changedLabels.length ? ' — ' + changedLabels.join(', ') : ' — see their note');
  const ok = await sendEmail(adminEmail, subject, html, 'Westmere Bookings', preheader);
  if (ok) console.log('[EMAIL] Owner change-request alert sent (' + ref + ')');
  return ok;
}

// ── Free-text message from operator to customer ──────────────────────────
// A lighter version of the brand template — the owner types a message (e.g. a
// question) and it is delivered to the customer from Westmere.
/* A message the owner typed, plus — ONLY when it is useful — the two payment
   doors underneath it.

   The owner's ask: "when they haven't chosen a payment option yet, include the
   payment links; once they've chosen, send it without them." So the block is
   conditional on paymentLock, asked by the CALLER (this module must not touch
   the database) and handed in as `opts.pay`.

   Never a card button into a cash-locked booking: that dead end has been fixed
   once already and must not be reintroduced through a different email. */
async function sendCustomerMessage(booking, message, opts) {
  const o = opts || {};
  const { ref, name, email, pay_token } = booking;
  if (!email || !message) return false;
  const firstName = greetingName(name);

  let payBlock = '';
  if (o.pay && o.pay.payable && pay_token && o.pay.amountDue > 0) {
    const dueStr = '£' + Number(o.pay.amountDue).toFixed(2);
    const payUrl  = `${HOST}/westmere-pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(pay_token)}`;
    const cashUrl = `${HOST}/api/public/pay/${encodeURIComponent(ref)}/cash?t=${encodeURIComponent(pay_token)}`;
    payBlock = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;border-top:1px solid #dfe5ea">
    <tr><td style="padding-top:18px">
      <p style="margin:0 0 12px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};line-height:1.6;text-align:center">Whenever you are ready, here are your payment options for ${escHtml(dueStr)}:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${actionBtn(payUrl, 'Pay ' + escHtml(dueStr) + ' Now &mdash; Card, Apple Pay or Google Pay', 'primary')}
        ${actionBtn(cashUrl, 'Pay Your Driver On The Day', 'secondary')}
      </table>
      ${cancelLinkHtml(ref, pay_token)}
    </td></tr>
  </table>`;
  }

  const body = `
  <p style="margin:0 0 6px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};font-weight:600">A message from Westmere${ref ? ' · ' + escHtml(ref) : ''}</p>
  <p style="margin:0 0 14px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:15px;color:${INK};font-weight:400;line-height:1.55">Dear ${escHtml(firstName)},</p>
  <p style="margin:0 0 22px;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:14px;color:${INK};line-height:1.7">${escHtml(message).replace(/\n/g, '<br>')}</p>
  <p style="margin:0 0 0;font-family:Cormorant,Cormorant Garamond,Didot,Bodoni MT,Georgia,serif;font-size:13px;color:${INK_SOFT};line-height:1.6">You can simply reply to this email or call us on <a href="tel:+447930342593" style="color:${INK};text-decoration:none">07930 342593</a>.</p>
  ${payBlock}`;

  const html = heroEmail(body);
  const subject = ref ? ('Regarding your booking — ' + ref) : 'A message from Westmere Private Hire';
  const preheader = String(message).replace(/\s+/g, ' ').slice(0, 90);
  const ok = await sendEmail(email, subject, html, 'Westmere Private Hire', preheader);
  if (ok) console.log('[EMAIL] Customer message sent (' + (ref || email) + ')');
  return ok;
}

module.exports = {
  sendCustomerAcknowledgement, sendCustomerConfirmed, sendCustomerEstimate, sendAdminAlert,
  sendOwnerCancelledRequest, sendOwnerCustomerNote, sendOwnerChangeRequest, sendCustomerMessage,
  sendOutreachMessage, letterEmail, sendDriverJobOffer, sendDriverMessage,
  sendCustomerJourneyReminder, airportBlockHtml, flightTrackUrl, driverBlockHtml, driverDetails, cancelLinkHtml,
  sendCustomerBookingUpdated,
  sendCustomerWelcome, sendCustomerInvoice, sendBespokeInvoice, sendInvoiceReminder,
  sendCustomerCancellation, sendDriverStatement, sendDriverWelcome,
  sendVerificationEmail, sendPasswordResetEmail, sendAdminPasswordResetEmail,
  sendRecommendation, sendPartnershipOutreach, sendCorporateIntro, sendReviewRequest, sendPaymentReminder, sendEmail, isConfigured,
  sendOwnerBookingReminder,
  // Exposed for local template previews / potential reuse.
  confirmationEmailHtml,
  // Exposed for the timezone/day-of-week guardrail test.
  formatDate
};
