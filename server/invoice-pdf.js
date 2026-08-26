'use strict';
/**
 * invoice-pdf.js — Server-side PDF generation for Westmere invoices.
 *
 * Uses pdfkit (pure Node.js, no browser/Chromium required).
 * Generates branded A4 PDF with navy/gold Westmere design.
 *
 * buildInvoicePdf(data) → Promise<Buffer>
 *
 * data shape:
 *   invoiceNo    String
 *   kind         'account' | 'bespoke'
 *   total        Number
 *   notes        String (optional)
 *   settings     { business_name, owner_name, address_line1, address_line2, postcode,
 *                  phone, email, bank_name, sort_code, account_no, account_name }
 *   period       { issuedDate, dueDate, label }
 *   // Account invoices:
 *   customer     { full_name, email, phone }
 *   bookings     [{ ref, date, time, pickup, destination, fare, flight }]
 *   // Bespoke invoices:
 *   recipient    { name, email, phone, address }
 *   items        [{ description, amount }]
 */

const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');

// ── Typeface ───────────────────────────────────────────────────────────────
// Cormorant is the brand face everywhere else (westmere-theme.css), so the
// invoice embeds it rather than falling back to a PDF base-14 serif. Two
// weights: Regular for text, SemiBold for the small tracked uppercase labels
// and totals — Cormorant is delicate, and small text set at Regular in a
// serif goes weak on paper.
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REG = path.join(FONT_DIR, 'Cormorant-Regular.ttf');
const FONT_SB  = path.join(FONT_DIR, 'Cormorant-SemiBold.ttf');
const BODY = 'Cormorant';
const BOLD = 'Cormorant-SemiBold';
// Reference numbers, sort codes and account numbers stay monospaced so digits
// line up and cannot be misread — the emails do the same with Menlo.
const MONO = 'Courier';

function registerFonts(doc) {
  doc.registerFont(BODY, FONT_REG);
  doc.registerFont(BOLD, FONT_SB);
}

// The PDF is a DISPLAY surface like any other: journeys print in the shared
// short-address form, and a flight number is printed only on an airport run.
const { shortDisplay, flightFor } = require('../address-normalize');

// ── Palette ────────────────────────────────────────────────────────────────
// The same tokens as westmere-theme.css and server/email.js, so the invoice,
// the emails and the site are one design. No gold and no cream: the accent is
// navy, and emphasis comes from weight and scale.
// (Guardrail: server/tests/button-style.test.js scans this file for any colour
// in the cream/gold hue band.)
const NAVY   = '#102a43';   // --westmere-navy
const ACCENT = '#102a43';   // was gold; the accent is navy now
const SOFT   = '#3B5268';   // secondary type
const MUTED  = '#657485';   // --westmere-muted
const HAIR   = '#dfe5ea';   // --westmere-line
const TINT   = '#F2F5F8';   // cool zebra tint (was ivory)

// ── Page geometry ──────────────────────────────────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M      = 52;           // margin
const CW     = PAGE_W - M * 2;  // content width = 491.28

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch (_) { return String(d); }
}

/* THE TEMPLATE VERSION, and why a number in this file matters elsewhere.
   Generated invoices are CACHED to disk, and the download route served whatever
   it found there. So the redesign shipped and every invoice already on the
   volume kept downloading in the old design — the template changed and the
   cache had no way to know. The cache key carries this number, so a template
   change orphans the old files instead of serving them. Bump it whenever the
   VISIBLE design changes; nothing else needs to be cleared, and the owner's
   existing files are left alone rather than deleted.
   GUARDRAIL: server/tests/invoice-paths.test.js */
const TEMPLATE_VERSION = 3;

/* "Mon 3 Aug 2026" — the form every other Westmere surface uses.
   The table used to print the raw ISO string, which is the one date format
   nobody reads aloud. Built from the components: never `new Date('2026-08-03')`,
   which parses as UTC midnight and reads back a day early west of London
   (the timezone invariant in CLAUDE.md). */
const _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtShortDate(d) {
  const p = String(d == null ? '' : d).trim().split('-');
  if (p.length !== 3) return String(d || '');
  const y = +p[0], m = +p[1], day = +p[2];
  if (!(y && m >= 1 && m <= 12 && day)) return String(d || '');
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (isNaN(dt.getTime())) return String(d || '');
  return _DOW[dt.getUTCDay()] + ' ' + day + ' ' + _MON[m - 1] + ' ' + y;
}

function hline(doc, y, color, width) {
  doc.save()
     .moveTo(M, y).lineTo(PAGE_W - M, y)
     .lineWidth(width || 0.4).strokeColor(color || HAIR)
     .stroke()
     .restore();
}

function vbox(doc, x, y, w, h, fillColor, strokeColor) {
  doc.save();
  if (fillColor) doc.rect(x, y, w, h).fill(fillColor);
  if (strokeColor) doc.rect(x, y, w, h).lineWidth(0.4).stroke(strokeColor);
  doc.restore();
}

/**
 * Generate a PDF for an invoice and return it as a Buffer.
 */
function buildInvoicePdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: M, bottom: M, left: M, right: M },
      info: {
        Title: (data.invoiceNo || 'Invoice') + ' — Westmere Private Hire',
        Author: 'Westmere Private Hire',
        Creator: 'Westmere Admin System'
      },
      autoFirstPage: true
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      registerFonts(doc);
      drawInvoice(doc, data, measureSlack(data));
    } catch (err) {
      doc.end();
      return reject(err);
    }
    doc.end();
  });
}

/* The footer rule and line, drawn on EVERY page. It used to be written once at
   the end of the draw, which was fine while an invoice was always one page. */
function drawFooter(doc) {
  const footerY = PAGE_H - M - 18;
  hline(doc, footerY, HAIR, 0.3);
  doc.font(BOLD).fontSize(8).fillColor(MUTED)
     .text(
       'Westmere Private Hire  ·  Licensed by Lewes District Council  ·  westmereprivatehire.co.uk',
       M, footerY + 6, { width: CW, align: 'center', lineBreak: false }
     );
}

/* WHERE THE SPARE INCH GOES.
   A three-journey account invoice and a one-line bespoke one are the same page
   with very different amounts of content, and the leftover has to go SOMEWHERE.
   Two earlier attempts put it in one place and both looked wrong: pooled at the
   bottom it reads as an unfinished page, and pooled above the payment details —
   once those were pinned to the foot — it opened a hole in the middle.

   So it is measured and then SPREAD. The document is drawn once into a
   throwaway to find out where the total actually lands, the shortfall to the
   pinned foot group is divided between the table rows and the three breathing
   gaps, and the real page is drawn with those. A one-item invoice gets a taller
   row and wider margins between its blocks rather than a void; a seven-journey
   one gets nothing, because it has no spare inch to give.

   Both shares are capped — slack is for air, not for stretching one row to the
   height of a paragraph — and the whole thing is inside a try, because a
   spacing refinement must never be the reason an invoice fails to generate. */
const NO_SLACK = { row: 0, gap: 0 };

function measureSlack(data) {
  try {
    const probe = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M, left: M, right: M } });
    probe.on('data', () => {});     // measured, never written anywhere
    probe.on('error', () => {});
    registerFonts(probe);
    const m = drawInvoice(probe, data, NO_SLACK);
    probe.end();
    if (!m) return NO_SLACK;

    /* A TABLE that broke over two pages has no spare inch to spend: its
       `yAfterTotal` is a position on the last page, and reading that as room to
       breathe would push the first page half-empty. A foot group that broke is
       a different case — the total is still on page one, the measurement still
       describes it, and suppressing slack there leaves a void above a footer
       for no reason. */
    if (m.tablePages > 1) return NO_SLACK;

    const n = Math.max(1, ((data.bookings || data.items || []).length) || 1);
    /* What tightening could claw back at most: four points off each row, and
       ten off each of the three gaps. Worth knowing BEFORE trying, because the
       answer decides which page the foot group lands on. */
    const MAX_SQUEEZE = n * 4 + 30;
    const over = m.yAfterTotal - m.groupMax;

    /* TOO MUCH CONTENT, not too little. A seven-journey month plus terms plus
       bank details does not fit A4 at a comfortable row height, so the same
       measurement runs the other way: rows tighten first, down to a floor that
       still holds two lines of type, then the gaps give up some air. */
    if (over > 0 && over <= MAX_SQUEEZE) {
      const row  = -Math.min(4, Math.ceil(over / n));
      const rest = over + row * n;
      const gap  = rest > 0 ? -Math.min(10, Math.ceil(rest / 3)) : 0;
      return { row, gap };
    }

    /* THE FOOT GROUP IS GOING TO THE NEXT PAGE WHATEVER WE DO — a fourteen-line
       note is taller than the space any amount of tightening could free. So
       this page is measured as if the group were not on it: squeezing here
       would only end the page higher up and make the void larger, which is
       what it did. */
    const bottom = (over > MAX_SQUEEZE) ? (m.footY - 24) : m.groupPin;

    const spare = bottom - m.yAfterTotal;
    if (!(spare > 12)) return NO_SLACK;

    /* Rows first, up to a limit — a taller row is the least conspicuous place
       to put height. What the rows cannot absorb goes to the three gaps: under
       the paperwork row, under FROM/BILL TO, and above the total. */
    const rows = Math.max(1, ((data.bookings || data.items || []).length) || 1);
    const row  = Math.min(14, Math.floor((spare * 0.55) / rows));
    const gap  = Math.min(46, Math.floor((spare - row * rows) / 3));
    return { row: Math.max(0, row), gap: Math.max(0, gap) };
  } catch (_) {
    return NO_SLACK;                // never block an invoice over spacing
  }
}

function drawInvoice(doc, data, slack) {
  const SLACK = slack || { row: 0, gap: 0 };
  let pages = 1;                     // so the measuring pass can tell it broke
  /* Breaks inside the TABLE are the ones that invalidate the measurement: they
     move the total onto a later page, so `yAfterTotal` stops describing page
     one. A foot-group break does not — the total is still where it was, and
     page one still has room worth spreading. Counted separately so a long note
     does not cost the first page its spacing. */
  let tablePages = 1;
  const isBespoke = data.kind === 'bespoke' || !!data.bespoke;
  const s    = data.settings || {};
  const p    = data.period   || {};
  const invoiceNo   = data.invoiceNo || data.invoice_no || '';
  const issuedDate  = p.issuedDate || data.issued_date  || '';
  const dueDate     = p.dueDate    || data.due_date     || '';
  const periodLabel = p.label      || data.period_label || '';
  const notes       = p.notes      || data.notes        || '';
  const total       = +data.total  || 0;

  // Recipient details
  const recName    = isBespoke ? ((data.recipient || {}).name    || '') : ((data.customer || {}).full_name || '');
  const recEmail   = isBespoke ? ((data.recipient || {}).email   || '') : ((data.customer || {}).email     || '');
  const recPhone   = isBespoke ? ((data.recipient || {}).phone   || '') : ((data.customer || {}).phone     || '');
  const recAddress = isBespoke ? ((data.recipient || {}).address || '') : '';

  // Business address lines
  const bizLines = [
    s.business_name || 'Westmere Private Hire',
    s.owner_name,
    s.address_line1,
    [s.address_line2, s.postcode].filter(Boolean).join(' '),
    s.phone,
    s.email
  ].filter(Boolean);

  // ── HEADER ─────────────────────────────────────────────────────────────
  let y = M;

  /* THE MASTHEAD — the confirmation email's header, on paper.
     A centred W, the wordmark stretched the full width of the page, the
     strapline beneath it and a short centred rule: the same five elements, in
     the same order, as heroShell() in server/email.js. A customer who has just
     read the confirmation should recognise the invoice as the same company
     without being told.

     SET IN TYPE, NOT PLACED AS AN IMAGE. The obvious reading of "stretched
     logo" is a raster scaled to 491pt wide, and it is the wrong one here: the
     only wordmark artwork in the repo is a 512px square crest, and blowing a
     bitmap up to full page width would land soft on paper — the one surface
     that gets printed and photocopied. Cormorant is already embedded, so the
     wordmark draws as vector outlines: crisp at any size, selectable, and
     searchable in a PDF reader.

     The tracking is COMPUTED rather than guessed. widthOfString measures the
     letters at the chosen size, and the leftover space is divided between the
     gaps, so the word spans the measure exactly whatever the font metrics turn
     out to be. */
  /* Tracked to a FIXED PROPORTION of the type size and centred — not justified
     to the margins. Spanning the full measure was the first reading of "a
     stretched logo" and it overdid it: at 42pt of tracking the wordmark stopped
     being a word and became eight letters sharing a line. The email sets it at
     29px with 11px of letter-spacing, so the ratio below IS that proportion,
     written as the fraction it came from rather than as a number somebody would
     later have to reverse-engineer. Change the size and the tracking follows.

     Placed by hand rather than with { width, align: 'center' }: pdfkit decides
     whether a line fits using the advance INCLUDING the spacing it adds after
     the final glyph, so a centred, tracked line can measure one gap too wide
     and wrap — which is what put the last E of WESTMERE on a line of its own. */
  const EMAIL_TRACK = 11 / 29;      // heroShell() in server/email.js

  function centredWide(str, size, font, ratio, atY, color) {
    doc.font(font).fontSize(size);
    const track   = size * ratio;
    // Between the GAPS, one fewer than the letters — pdfkit does not track
    // after the last glyph, and its own widthOfString agrees.
    const gaps    = Math.max(1, str.length - 1);
    const width   = doc.widthOfString(str, { characterSpacing: 0 }) + gaps * track;
    doc.fillColor(color).text(str, M + (CW - width) / 2, atY, {
      characterSpacing: track, lineBreak: false
    });
    return width;
  }

  // The small W above the wordmark, exactly as the email opens.
  doc.font(BODY).fontSize(15).fillColor(NAVY)
     .text('W', M, y, { width: CW, align: 'center', characterSpacing: 1, lineBreak: false });
  y += 20;

  // The wordmark, at the email's proportions.
  centredWide('WESTMERE', 30, BODY, EMAIL_TRACK, y, NAVY);
  y += 34;

  // The strapline beneath it — the email tracks this one harder, 5px on 10px.
  centredWide('PRIVATE HIRE · SUSSEX', 8, BOLD, 5 / 10, y, ACCENT);
  y += 16;

  // The short centred hairline the email closes its header with.
  doc.save()
     .moveTo(M + CW / 2 - 30, y).lineTo(M + CW / 2 + 30, y)
     .lineWidth(0.6).strokeColor(HAIR).stroke().restore();
  y += 26;

  /* THE PAPERWORK ROW, BELOW THE BAND.
     Number, issue date, due date and period, as four labelled cells across the
     measure — the email's label-above-value detail row, on paper. It replaces
     two separate things: a reference crammed into the top right corner, and a
     free-standing ISSUED block halfway down that printed the same date a second
     time. `dueDate` was read from the data and then never drawn at all, which
     on an invoice carrying "payment within 14 days" is the one date the reader
     is looking for. */
  const cells = [
    { label: 'INVOICE',  value: invoiceNo || '—', mono: true },
    { label: 'ISSUED',   value: fmtDate(issuedDate) || '—' },
    { label: 'DUE',      value: fmtDate(dueDate) || '—' },
    { label: 'PERIOD',   value: periodLabel || '' }
  ].filter(c => c.value);

  hline(doc, y, HAIR, 0.4);
  y += 13;
  const CELL_W = CW / cells.length;
  cells.forEach((c, i) => {
    const cx = M + i * CELL_W;
    doc.font(BOLD).fontSize(7).fillColor(MUTED)
       .text(c.label, cx, y, { characterSpacing: 1.4, lineBreak: false });
    doc.font(c.mono ? MONO : BODY).fontSize(c.mono ? 11 : 10.5).fillColor(NAVY)
       .text(c.value, cx, y + 13, { width: CELL_W - 8, lineBreak: false });
  });
  y += 32;
  hline(doc, y, HAIR, 0.4);
  y += 26 + SLACK.gap;

  // ── FROM / BILL TO ──────────────────────────────────────────────────────
  const MID  = M + CW / 2;
  const COLW = CW / 2 - 10;

  doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
     .text('FROM', M, y, { lineBreak: false });
  doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
     .text('BILL TO', MID, y, { lineBreak: false });

  y += 13;
  let leftY  = y;
  let rightY = y;

  // FROM column
  doc.font(BOLD).fontSize(11).fillColor(NAVY)
     .text(bizLines[0] || '', M, leftY, { width: COLW, lineBreak: false });
  leftY += 16;
  doc.font(BODY).fontSize(10).fillColor(SOFT);
  for (let i = 1; i < bizLines.length; i++) {
    doc.text(bizLines[i], M, leftY, { width: COLW, lineBreak: false });
    leftY += 14;
  }

  // BILL TO column
  doc.font(BOLD).fontSize(11).fillColor(NAVY)
     .text(recName || '—', MID, rightY, { width: COLW, lineBreak: false });
  rightY += 16;
  doc.font(BODY).fontSize(10).fillColor(SOFT);
  if (recAddress) {
    for (const al of recAddress.split('\n')) {
      if (al.trim()) {
        doc.text(al.trim(), MID, rightY, { width: COLW, lineBreak: false });
        rightY += 14;
      }
    }
  }
  if (recPhone) { doc.text(recPhone, MID, rightY, { width: COLW, lineBreak: false }); rightY += 14; }
  if (recEmail) { doc.text(recEmail, MID, rightY, { width: COLW, lineBreak: false }); rightY += 14; }

  y = Math.max(leftY, rightY) + 20 + SLACK.gap;

  // ── TABLE ────────────────────────────────────────────────────────────────
  const ROW_H = 24;

  if (isBespoke) {
    vbox(doc, M, y, CW, 22, '#EEF2F5');
    // --- Bespoke: Description | Amount ---
    doc.font(BOLD).fontSize(8).fillColor(MUTED)
       .text('DESCRIPTION', M + 6, y + 7, { lineBreak: false });
    doc.font(BOLD).fontSize(8).fillColor(MUTED)
       .text('AMOUNT', M, y + 7, { width: CW - 6, align: 'right', lineBreak: false });
    y += 22;

    hline(doc, y, ACCENT, 1.2);
    y += 1;

    const items = data.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const hasDate = !!(it.date && String(it.date).trim());
      const rowH = (hasDate ? ROW_H + 12 : ROW_H) + SLACK.row;
      if (i % 2 === 1) vbox(doc, M, y, CW, rowH, TINT);
      if (hasDate) {
        doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
           .text(fmtDate(it.date), M + 6, y + 5, { lineBreak: false });
        doc.font(BODY).fontSize(11).fillColor(NAVY)
           .text(String(it.description || ''), M + 6, y + 16, { width: CW - 90, lineBreak: false });
      } else {
        doc.font(BODY).fontSize(11).fillColor(NAVY)
           .text(String(it.description || ''), M + 6, y + 7, { width: CW - 90, lineBreak: false });
      }
      doc.font(BODY).fontSize(11).fillColor(NAVY)
         .text('£' + (+it.amount || 0).toFixed(2), M, y + (hasDate ? 16 : 7), { width: CW - 6, align: 'right', lineBreak: false });
      y += rowH;
    }
    if (!items.length) {
      doc.font(BODY).fontSize(11).fillColor(MUTED)
         .text('No items on this invoice.', M, y + 7, { width: CW, align: 'center', lineBreak: false });
      y += ROW_H;
    }

  } else {
    // --- Account: Date/Ref | Journey | Fare ---
    const DW = 132;   // date column — wider, the date is now words not digits
    const FW = 66;    // fare column
    const JW = CW - DW - FW - 14;
    const JX = M + DW + 7;
    const FX = PAGE_W - M - FW;

    /* A month long enough to run past the bottom of the page continues on the
       next one, under a repeated column header. Rows used to simply keep
       drawing downwards, off the paper. */
    const BK_LIMIT = PAGE_H - M - 18 - 34;
    const bkHead = () => {
      vbox(doc, M, y, CW, 22, '#EEF2F5');
      doc.font(BOLD).fontSize(8).fillColor(MUTED)
         .text('DATE / REF', M + 8, y + 7, { characterSpacing: 0.8, lineBreak: false });
      doc.font(BOLD).fontSize(8).fillColor(MUTED)
         .text('JOURNEY', JX, y + 7, { characterSpacing: 0.8, lineBreak: false });
      doc.font(BOLD).fontSize(8).fillColor(MUTED)
         .text('FARE', FX, y + 7, { width: FW - 6, align: 'right', characterSpacing: 0.8, lineBreak: false });
      y += 22;
    };
    bkHead();

    hline(doc, y, ACCENT, 1.2);
    y += 1;

    /* Rows given room. Two lines of information were being squeezed into 28pt
       with a third — the flight — jammed underneath at 8pt, which is where this
       table stopped being readable. The date is now the human form, the flight
       rides INLINE after the route as a quiet tag, and the reference keeps its
       monospace so a customer can quote it back accurately. */
    const bookings = data.bookings || [];
    /* Rows breathe when there is room and tighten when there is not. A busy
       month of journeys plus the terms plus the bank block genuinely does not
       fit an A4 page at 34pt a row — and the alternative to tightening is
       either a second page for one line of overflow, or the foot matter
       printing over the total. Both are worse than three points of leading. */
    const BK_ROW_H = (bookings.length > 5 ? 30 : 34) + SLACK.row;
    /* Slack makes the band taller; without this the two lines stay pinned to
       the top of it and every other row looks like it has slipped. */
    const BK_PAD = Math.round(SLACK.row / 2);
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      if (y + BK_ROW_H > BK_LIMIT) {
        drawFooter(doc);
        doc.addPage();
        pages++;
        tablePages++;
        y = M;
        bkHead();
      }
      if (i % 2 === 1) vbox(doc, M, y, CW, BK_ROW_H, TINT);

      doc.font(BODY).fontSize(10).fillColor(NAVY)
         .text(fmtShortDate(b.date), M + 8, y + 8 + BK_PAD, { width: DW - 10, lineBreak: false });
      const timeStr = (b.time && b.time !== 'ASAP') ? b.time : '';
      doc.font(MONO).fontSize(7.5).fillColor(MUTED)
         .text((b.ref || '') + (timeStr ? '  ·  ' + timeStr : ''), M + 8, y + 21 + BK_PAD, { width: DW - 10, lineBreak: false });

      const journey = (shortDisplay(b.pickup) || b.pickup || '') + ' → ' + (shortDisplay(b.destination) || b.destination || '');
      doc.font(BODY).fontSize(10).fillColor(NAVY)
         .text(journey, JX, y + 8 + BK_PAD, { width: JW, lineBreak: false });
      const flt = flightFor(b);   // airport runs only
      if (flt) {
        // A quiet tag on its own line, tracked and muted so it reads as a note
        // about the journey rather than a second journey.
        doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
           .text('FLIGHT ' + flt, JX, y + 21 + BK_PAD, { width: JW, characterSpacing: 0.8, lineBreak: false });
      }

      doc.font(BODY).fontSize(11.5).fillColor(NAVY)
         .text('£' + (+b.fare || 0).toFixed(2), FX, y + 11 + BK_PAD, { width: FW - 6, align: 'right', lineBreak: false });

      y += BK_ROW_H;
    }
    if (!bookings.length) {
      doc.font(BODY).fontSize(11).fillColor(MUTED)
         .text('No journeys in this period.', M, y + 7, { width: CW, align: 'center', lineBreak: false });
      y += ROW_H;
    }
  }

  // Bottom table border
  hline(doc, y, HAIR, 0.4);
  y += 14 + SLACK.gap;

  // ── TOTALS ───────────────────────────────────────────────────────────────
  const TX   = PAGE_W - M - 220;     // label column start
  const LW   = 140;                   // label column width
  const VX   = TX + LW + 6;
  const VW   = PAGE_W - M - VX;

  /* VAT ONLY WHEN THERE IS VAT.
     "VAT (0%) — £0.00" was hardcoded on every invoice. The business is not
     registered, so the line was not a zero — it was a statement about tax
     status that nothing in the system had authority to make, printed on a
     document that goes to other people's accountants.

     It now appears only when a VAT number AND a rate are configured in the
     invoice settings, and when it does it computes properly: the stored total
     is treated as VAT-INCLUSIVE, because that is what the fares are. */
  const vatNo   = String((s.vat_number || '')).trim();
  const vatRate = Number(s.vat_rate);
  const showVat = !!vatNo && isFinite(vatRate) && vatRate > 0;
  const net     = showVat ? total / (1 + vatRate / 100) : total;
  const vatAmt  = showVat ? total - net : 0;

  if (showVat) {
    doc.font(BOLD).fontSize(9).fillColor(SOFT)
       .text('Subtotal', TX, y, { width: LW, align: 'right', characterSpacing: 0.8, lineBreak: false });
    doc.font(BODY).fontSize(11).fillColor(SOFT)
       .text('£' + net.toFixed(2), VX, y, { width: VW, align: 'right', lineBreak: false });
    y += 17;
    doc.font(BOLD).fontSize(9).fillColor(SOFT)
       .text('VAT (' + vatRate + '%)', TX, y, { width: LW, align: 'right', characterSpacing: 0.8, lineBreak: false });
    doc.font(BODY).fontSize(11).fillColor(SOFT)
       .text('£' + vatAmt.toFixed(2), VX, y, { width: VW, align: 'right', lineBreak: false });
    y += 20;
  } else {
    /* No VAT line at all. A single "Subtotal" identical to the total is noise,
       so on an unregistered invoice the total simply IS the figure. */
    y += 2;
  }

  /* THE TOTAL IS THE ANCHOR.
     It used to be a right-aligned number in the same column as everything else,
     with "VAT (0%)" drawing equal attention immediately above it. It is now
     framed, on its own, at a size nothing else on the page competes with —
     because it is the one number the recipient is looking for. */
  const TOT_H = 42;
  const TOT_X = PAGE_W - M - 236;
  const TOT_W = 236;
  vbox(doc, TOT_X, y, TOT_W, TOT_H, null, NAVY);
  doc.font(BOLD).fontSize(9).fillColor(SOFT)
     .text('TOTAL DUE', TOT_X + 14, y + 16, { characterSpacing: 1.6, lineBreak: false });
  doc.font(BOLD).fontSize(20).fillColor(NAVY)
     .text('£' + total.toFixed(2), TOT_X, y + 11, { width: TOT_W - 14, align: 'right', lineBreak: false });
  y += TOT_H + 8;

  if (showVat) {
    doc.font(BODY).fontSize(7.5).fillColor(MUTED)
       .text('VAT registration ' + vatNo, TOT_X, y, { width: TOT_W - 14, align: 'right', lineBreak: false });
    y += 12;
  }
  y += 6;

  // ── NOTES ────────────────────────────────────────────────────────────────
  /* THE FOOT GROUP — notes and payment details travel together.
     Pinning the payment block alone just moved the empty band up the page and
     stranded the notes bar in the middle of it. Both are foot matter, so both
     are measured as one group and placed as one: they flow naturally on a long
     invoice, and on a short one they sit together above the footer with a
     single, deliberate gap after the total. */
  const FOOT_Y  = PAGE_H - M - 18;                       // the footer line

  /* THE NOTES BLOCK IS AS TALL AS THE NOTES.
     This was `notes ? 44 : 0` — a constant, sized for one line — while the
     block below it was placed 44pt down whatever the note actually said. An
     invoice carrying a passenger name, a finance contact and a department ran
     to five lines, and the payment-details box was painted straight over the
     last two: the notes were on the page and unreadable.

     MEASURED, with the same font, size and width the block draws with, because
     heightOfString answers for the font that is currently set. Explicit
     newlines count — pdfkit honours a \n even with lineBreak off, which is
     exactly how a "single line" note became five.

     And it WRAPS now. A long note with no newlines in it used to run off the
     right-hand edge instead; a measured height is no use if the text ignores
     the width it was measured against. */
  const NOTES_PAD_X = 12, NOTES_PAD_Y = 9;
  const NOTES_W = CW - NOTES_PAD_X - 10;
  let NOTES_BOX_H = 0;
  if (notes) {
    doc.font(BODY).fontSize(11);
    const h = doc.heightOfString(String(notes), { width: NOTES_W });
    NOTES_BOX_H = Math.max(36, Math.ceil(h) + NOTES_PAD_Y * 2);
  }
  const NOTES_GAP = 8;                                   // air below the block
  const NOTES_H = NOTES_BOX_H ? NOTES_BOX_H + NOTES_GAP : 0;
  /* The block's height, computed the SAME way the block itself computes it —
     an estimate here is how the account invoice ran off the bottom of the page
     the first time. Rows: Bank, Name, Sort code, Account, Reference. */
  const payRowCount = (s.sort_code && s.account_no)
    ? [s.bank_name, s.account_name, 1, 1, 1].filter(Boolean).length : 0;
  const PAY_H   = payRowCount ? (14 + payRowCount * 14 + 10) : 0;
  const GROUP_H = NOTES_H + (NOTES_H && PAY_H ? 10 : 0) + PAY_H;

  /* Pin to the foot on a SHORT page; flow on a long one — but never past the
     bottom. A seven-journey invoice plus notes plus the bank block genuinely
     does not fit with the old spacing, so when it will not, the gap above the
     foot group closes to nothing rather than the block printing off the paper. */
  const GROUP_PIN = FOOT_Y - 24 - GROUP_H;
  const GROUP_MAX = FOOT_Y - 10 - GROUP_H;               // the last position that still fits
  const measured  = { yAfterTotal: y, groupPin: GROUP_PIN, groupMax: GROUP_MAX,
                      footY: FOOT_Y, pages: pages, tablePages: tablePages };
  /* Never above where the total finished — a clamp that could pull the foot
     group upward would print the terms across the one number the recipient is
     looking for. `y` is the floor; the pin can only push it down. */
  /* If the squeeze could not claw back enough — a very long month, or long
     terms — the notes and the bank details go over the page rather than over
     the footer. Overlapping type on the one document that gets filed by
     somebody else's accounts department is not an acceptable failure. */
  if (y > GROUP_MAX) {
    drawFooter(doc);
    doc.addPage();
    pages++;
    y = M;
    doc.font(BOLD).fontSize(7).fillColor(MUTED)
       .text('INVOICE ' + (invoiceNo || ''), M, y, { characterSpacing: 1.4, lineBreak: false });
    y += 26;
  } else {
    y = Math.max(y, Math.min(Math.max(y, GROUP_PIN), GROUP_MAX));
  }

  // ── NOTES ────────────────────────────────────────────────────────────────
  if (notes) {
    // Drawn at the height it was MEASURED at, and y advances by the same
    // amount — the two numbers disagreeing is the whole of this bug.
    doc.save()
       .rect(M, y, 3, NOTES_BOX_H).fill(ACCENT)
       .rect(M + 3, y, CW - 3, NOTES_BOX_H).fill('#F7F9FA')
       .restore();
    doc.font(BODY).fontSize(11).fillColor(SOFT)
       .text(String(notes), M + NOTES_PAD_X, y + NOTES_PAD_Y, { width: NOTES_W });
    y += NOTES_H;
  }

  // ── PAYMENT DETAILS ──────────────────────────────────────────────────────
  if (s.sort_code && s.account_no) {
    y += 10;

    const bankRows = [
      s.bank_name    ? ['Bank',       s.bank_name]    : null,
      s.account_name ? ['Name',       s.account_name] : null,
                       ['Sort code',  s.sort_code],
                       ['Account',    s.account_no],
                       ['Reference',  invoiceNo]
    ].filter(Boolean);

    const BH = 14 + bankRows.length * 14 + 10;

    vbox(doc, M, y, CW, BH, TINT, HAIR);
    // Gold left accent bar
    doc.save().rect(M, y, 3, BH).fill(ACCENT).restore();

    let by = y + 10;
    doc.font(BOLD).fontSize(7.5).fillColor(ACCENT)
       .text('PAYMENT DETAILS', M + 10, by, { lineBreak: false });
    by += 14;

    const LBW = 76;
    for (const [lbl, val] of bankRows) {
      const isMono = lbl === 'Sort code' || lbl === 'Account' || lbl === 'Reference';
      doc.font(BOLD).fontSize(8).fillColor(MUTED)
         .text(lbl.toUpperCase(), M + 10, by, { width: LBW, lineBreak: false });
      doc.font(isMono ? MONO : BODY).fontSize(10).fillColor(NAVY)
         .text(String(val), M + 10 + LBW + 4, by, { lineBreak: false });
      by += 14;
    }

    y += BH + 10;
  }

  // ── FOOTER ───────────────────────────────────────────────────────────────
  drawFooter(doc);

  return measured;
}

/* THE PER-INVOICE SECRET, and the URL built from it.
   Minted once and NEVER re-minted: re-minting invalidates the link in an
   invoice email that has already gone out, which is the same rule pay_token
   lives by. Callers hand it a row; it returns the token, creating one only if
   the row somehow has none (a race with the boot-time backfill, or a row
   inserted by an older build).

   The number stays in the path because a customer looking at the URL should
   still see which invoice it is; the token is what actually authorises. */
function ensureInvoiceToken(db, row) {
  if (row && row.access_token) return row.access_token;
  if (!row || !row.id) return null;
  try {
    const token = require('crypto').randomBytes(16).toString('hex');
    db.prepare('UPDATE invoices SET access_token = ? WHERE id = ?').run(token, row.id);
    row.access_token = token;
    return token;
  } catch (e) {
    console.error('[INVOICE] access_token minting failed:', e.message);
    return null;
  }
}

/** The link that goes in an email. Never build one of these by hand. */
function invoicePublicUrl(invoiceNo, token, opts) {
  const host = (opts && opts.host) || 'https://westmereprivatehire.co.uk';
  return host + '/api/public/invoice/' + encodeURIComponent(invoiceNo || '') +
         '/pdf?t=' + encodeURIComponent(token || '');
}

/* ONE WAY TO GET AN INVOICE'S PDF, used by every route that serves one.
   There were three: the public download, the owner/admin download, and the
   customer's own download. Each rebuilt the same data shape by hand and each
   cached to `<invoiceNo>.pdf` — so the redesign shipped and all three carried on
   serving files drawn by the old template, and the third did not regenerate at
   all: if the file was missing it told the customer to ring the office.

   THE CACHE KEY CARRIES THE TEMPLATE VERSION. A bare invoice number is not a
   key for a document whose appearance can change. Old files are orphaned rather
   than deleted — nothing of the owner's is destroyed by a redesign.

   A failed cache WRITE never costs the caller their document; the buffer is
   returned either way. `row` is a row of the invoices table. */
function invoiceDataFromRow(row, settings) {
  const lineItems = (() => {
    try { return JSON.parse(row.line_items_json || '[]'); } catch (_) { return []; }
  })();
  const data = {
    invoiceNo: row.invoice_no,
    kind: row.kind,
    total: row.total,
    notes: row.notes || '',
    settings: settings || {},
    period: { issuedDate: row.issued_date, dueDate: row.due_date || '', label: row.period_label || '' }
  };
  if (row.kind === 'bespoke') {
    data.recipient = {
      name: row.recipient_name, email: row.recipient_email || '',
      phone: row.recipient_phone || '', address: row.recipient_addr || ''
    };
    data.items = lineItems;
  } else {
    data.customer = {
      full_name: row.recipient_name, email: row.recipient_email || '', phone: row.recipient_phone || ''
    };
    data.bookings = lineItems;
  }
  return data;
}

/* WHERE INVOICES LIVE — one answer.
   api.js derived this from the database's directory and index.js from an
   environment variable. On the deploy box they happen to agree; anywhere else
   they do not, which is the shape of a bug that only appears in production. */
function invoiceCacheDir() {
  return process.env.INVOICES_DIR || '/data/invoices';
}

function invoiceSafeNo(invoiceNo) {
  return String(invoiceNo || '').replace(/[^A-Za-z0-9\-_]/g, '');
}

function invoiceCachePath(invoiceNo) {
  return path.join(invoiceCacheDir(), invoiceSafeNo(invoiceNo) + '.v' + TEMPLATE_VERSION + '.pdf');
}

/* Every cached rendering of one invoice, whatever template drew it — the
   current version, older versions, and the unversioned files written before
   the cache knew about versions at all. Deleting an invoice has to take all of
   them; leaving one behind leaves the document downloadable. */
function invoiceCachePaths(invoiceNo) {
  const safeNo = invoiceSafeNo(invoiceNo);
  if (!safeNo) return [];
  const dir = invoiceCacheDir();
  const out = [path.join(dir, safeNo + '.pdf')];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (new RegExp('^' + safeNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.v\\d+\\.pdf$').test(f)) {
        out.push(path.join(dir, f));
      }
    }
  } catch (_) { /* no directory yet */ }
  return out;
}

/** → Promise<Buffer>. Throws only if the document genuinely cannot be built. */
async function resolveInvoicePdf(db, row) {
  const pdfPath = invoiceCachePath(row.invoice_no);
  try {
    if (fs.existsSync(pdfPath)) {
      const cached = fs.readFileSync(pdfPath);
      // A truncated or empty cache file is worse than none: it downloads as a
      // broken document rather than failing loudly. Rebuild instead.
      if (cached && cached.length > 1000 && cached.slice(0, 5).toString() === '%PDF-') return cached;
    }
  } catch (e) {
    console.error('[INVOICE PDF] cache read failed, rebuilding:', e.message);
  }

  let settings = {};
  try {
    const sr = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
    if (sr) settings = JSON.parse(sr.value);
  } catch (_) {}

  const buf = await buildInvoicePdf(invoiceDataFromRow(row, settings));
  if (!buf || !buf.length) throw new Error('the invoice generator returned an empty buffer');

  try {
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, buf);
  } catch (e) {
    console.error('[INVOICE PDF] cache write failed (serving anyway):', e.message);
  }
  return buf;
}

module.exports = {
  buildInvoicePdf, TEMPLATE_VERSION, resolveInvoicePdf,
  invoiceDataFromRow, invoiceCacheDir, invoiceCachePath, invoiceCachePaths,
  ensureInvoiceToken, invoicePublicUrl
};
