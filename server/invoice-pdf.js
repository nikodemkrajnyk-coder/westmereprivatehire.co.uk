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

// ── Palette ────────────────────────────────────────────────────────────────
const NAVY  = '#0E2540';
const GOLD  = '#B8985A';
const SOFT  = '#5A6B7F';
const MUTED = '#9AA3B2';
const HAIR  = '#E0E4EA';
const IVORY = '#F5F3EE';

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
      drawInvoice(doc, data);
    } catch (err) {
      doc.end();
      return reject(err);
    }
    doc.end();
  });
}

function drawInvoice(doc, data) {
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

  // Left: wordmark
  doc.font('Times-Roman').fontSize(22).fillColor(NAVY)
     .text('WESTMERE', M, y, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(GOLD)
     .text('PRIVATE HIRE  ·  SUSSEX', M, y + 29, { lineBreak: false });

  // Right: INVOICE label + number
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text('INVOICE', M, y, { width: CW, align: 'right', lineBreak: false });
  doc.font('Courier').fontSize(13).fillColor(NAVY)
     .text(invoiceNo, M, y + 14, { width: CW, align: 'right', lineBreak: false });

  y += 52;

  // ── GOLD RULE ────────────────────────────────────────────────────────────
  hline(doc, y, GOLD, 1);
  y += 20;

  // ── FROM / BILL TO ──────────────────────────────────────────────────────
  const MID  = M + CW / 2;
  const COLW = CW / 2 - 10;

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
     .text('FROM', M, y, { lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
     .text('BILL TO', MID, y, { lineBreak: false });

  y += 13;
  let leftY  = y;
  let rightY = y;

  // FROM column
  doc.font('Times-Bold').fontSize(11).fillColor(NAVY)
     .text(bizLines[0] || '', M, leftY, { width: COLW, lineBreak: false });
  leftY += 16;
  doc.font('Times-Roman').fontSize(10).fillColor(SOFT);
  for (let i = 1; i < bizLines.length; i++) {
    doc.text(bizLines[i], M, leftY, { width: COLW, lineBreak: false });
    leftY += 14;
  }

  // BILL TO column
  doc.font('Times-Bold').fontSize(11).fillColor(NAVY)
     .text(recName || '—', MID, rightY, { width: COLW, lineBreak: false });
  rightY += 16;
  doc.font('Times-Roman').fontSize(10).fillColor(SOFT);
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

  y = Math.max(leftY, rightY) + 20;

  // ── DATES ────────────────────────────────────────────────────────────────
  hline(doc, y, HAIR, 0.4);
  y += 12;

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('ISSUED', M, y, { lineBreak: false });
  y += 12;

  doc.font('Times-Roman').fontSize(11).fillColor(NAVY).text(fmtDate(issuedDate) || '—', M, y, { lineBreak: false });
  y += 16;

  if (periodLabel) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(SOFT)
       .text('Period: ' + periodLabel, M, y, { lineBreak: false });
    y += 16;
  }

  y += 14;

  // ── TABLE ────────────────────────────────────────────────────────────────
  const ROW_H = 24;

  // Header strip
  vbox(doc, M, y, CW, 22, '#EDE9E2');

  if (isBespoke) {
    // --- Bespoke: Description | Amount ---
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('DESCRIPTION', M + 6, y + 7, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('AMOUNT', M, y + 7, { width: CW - 6, align: 'right', lineBreak: false });
    y += 22;

    hline(doc, y, GOLD, 1.2);
    y += 1;

    const items = data.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i % 2 === 1) vbox(doc, M, y, CW, ROW_H, IVORY);
      doc.font('Times-Roman').fontSize(11).fillColor(NAVY)
         .text(String(it.description || ''), M + 6, y + 7, { width: CW - 90, lineBreak: false });
      doc.font('Times-Roman').fontSize(11).fillColor(NAVY)
         .text('£' + (+it.amount || 0).toFixed(2), M, y + 7, { width: CW - 6, align: 'right', lineBreak: false });
      y += ROW_H;
    }
    if (!items.length) {
      doc.font('Times-Roman').fontSize(11).fillColor(MUTED)
         .text('No items on this invoice.', M, y + 7, { width: CW, align: 'center', lineBreak: false });
      y += ROW_H;
    }

  } else {
    // --- Account: Date/Ref | Journey | Fare ---
    const DW = 124;   // date column
    const FW = 66;    // fare column
    const JW = CW - DW - FW - 14;
    const JX = M + DW + 7;
    const FX = PAGE_W - M - FW;

    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('DATE / REF', M + 6, y + 7, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('JOURNEY', JX, y + 7, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('FARE', FX, y + 7, { width: FW - 6, align: 'right', lineBreak: false });
    y += 22;

    hline(doc, y, GOLD, 1.2);
    y += 1;

    const BK_ROW_H = 28;
    const bookings = data.bookings || [];
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      if (i % 2 === 1) vbox(doc, M, y, CW, BK_ROW_H, IVORY);

      const dateStr = (b.date || '') + (b.time && b.time !== 'ASAP' ? '  ' + b.time : '');
      doc.font('Times-Roman').fontSize(10).fillColor(NAVY)
         .text(dateStr, M + 6, y + 5, { width: DW - 6, lineBreak: false });
      doc.font('Courier').fontSize(8).fillColor(MUTED)
         .text(b.ref || '', M + 6, y + 17, { width: DW - 6, lineBreak: false });

      const journey = (b.pickup || '') + ' → ' + (b.destination || '');
      doc.font('Times-Roman').fontSize(10).fillColor(NAVY)
         .text(journey, JX, y + 5, { width: JW, lineBreak: false });
      if (b.flight) {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED)
           .text('Flt ' + b.flight, JX, y + 17, { width: JW, lineBreak: false });
      }

      doc.font('Times-Roman').fontSize(11).fillColor(NAVY)
         .text('£' + (+b.fare || 0).toFixed(2), FX, y + 9, { width: FW - 6, align: 'right', lineBreak: false });

      y += BK_ROW_H;
    }
    if (!bookings.length) {
      doc.font('Times-Roman').fontSize(11).fillColor(MUTED)
         .text('No journeys in this period.', M, y + 7, { width: CW, align: 'center', lineBreak: false });
      y += ROW_H;
    }
  }

  // Bottom table border
  hline(doc, y, HAIR, 0.4);
  y += 14;

  // ── TOTALS ───────────────────────────────────────────────────────────────
  const TX   = PAGE_W - M - 220;     // label column start
  const LW   = 140;                   // label column width
  const VX   = TX + LW + 6;
  const VW   = PAGE_W - M - VX;

  // Subtotal
  doc.font('Helvetica').fontSize(9.5).fillColor(SOFT)
     .text('Subtotal', TX, y, { width: LW, align: 'right', lineBreak: false });
  doc.font('Times-Roman').fontSize(11).fillColor(NAVY)
     .text('£' + total.toFixed(2), VX, y, { width: VW, align: 'right', lineBreak: false });
  y += 17;

  // VAT
  doc.font('Helvetica').fontSize(9.5).fillColor(SOFT)
     .text('VAT (0%)', TX, y, { width: LW, align: 'right', lineBreak: false });
  doc.font('Times-Roman').fontSize(11).fillColor(NAVY)
     .text('£0.00', VX, y, { width: VW, align: 'right', lineBreak: false });
  y += 13;

  // Divider
  doc.save().moveTo(TX, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(NAVY).stroke().restore();
  y += 7;

  // TOTAL DUE
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY)
     .text('TOTAL DUE', TX, y + 3, { width: LW, align: 'right', lineBreak: false });
  doc.font('Times-Bold').fontSize(16).fillColor(GOLD)
     .text('£' + total.toFixed(2), VX, y, { width: VW, align: 'right', lineBreak: false });
  y += 30;

  // ── NOTES ────────────────────────────────────────────────────────────────
  if (notes && y < PAGE_H - M - 120) {
    y += 8;
    // Gold left bar + ivory background
    doc.save()
       .rect(M, y, 3, 36).fill(GOLD)
       .rect(M + 3, y, CW - 3, 36).fill('#FAF8F4')
       .restore();
    doc.font('Times-Roman').fontSize(11).fillColor(SOFT)
       .text(notes, M + 10, y + 8, { width: CW - 18, lineBreak: false });
    y += 44;
  }

  // ── PAYMENT DETAILS ──────────────────────────────────────────────────────
  if (s.sort_code && s.account_no && y < PAGE_H - M - 80) {
    y += 10;

    const bankRows = [
      s.bank_name    ? ['Bank',       s.bank_name]    : null,
      s.account_name ? ['Name',       s.account_name] : null,
                       ['Sort code',  s.sort_code],
                       ['Account',    s.account_no],
                       ['Reference',  invoiceNo]
    ].filter(Boolean);

    const BH = 14 + bankRows.length * 14 + 10;

    vbox(doc, M, y, CW, BH, IVORY, HAIR);
    // Gold left accent bar
    doc.save().rect(M, y, 3, BH).fill(GOLD).restore();

    let by = y + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor(GOLD)
       .text('PAYMENT DETAILS', M + 10, by, { lineBreak: false });
    by += 14;

    const LBW = 76;
    for (const [lbl, val] of bankRows) {
      const isMono = lbl === 'Sort code' || lbl === 'Account' || lbl === 'Reference';
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
         .text(lbl.toUpperCase(), M + 10, by, { width: LBW, lineBreak: false });
      doc.font(isMono ? 'Courier' : 'Times-Roman').fontSize(10).fillColor(NAVY)
         .text(String(val), M + 10 + LBW + 4, by, { lineBreak: false });
      by += 14;
    }

    y += BH + 10;
  }

  // ── FOOTER ───────────────────────────────────────────────────────────────
  const footerY = PAGE_H - M - 18;
  hline(doc, footerY, HAIR, 0.3);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text(
       'Westmere Private Hire  ·  Licensed by Lewes District Council  ·  westmereprivatehire.co.uk',
       M, footerY + 6, { width: CW, align: 'center', lineBreak: false }
     );
}

module.exports = { buildInvoicePdf };
