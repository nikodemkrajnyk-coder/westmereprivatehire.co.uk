/**
 * THE DRIVER'S STATEMENT.
 *
 * What one subcontracted driver did in a period, and what it comes to. It is the
 * document that settles an argument: he has his own note of the jobs, we have
 * ours, and the two are reconciled by putting every line on one page with the
 * running balance carried down the side.
 *
 * IT PRINTS ON THE INVOICE'S PAPER. The masthead, the palette, the hairlines and
 * the footer band are imported from server/invoice-pdf.js rather than rebuilt —
 * see `sheet` there. Two letterheads is how a company ends up with two logos.
 *
 * IT DOES NOT DO ITS OWN ARITHMETIC. Every figure comes from
 * server/driver-ledger.js. This file decides where a number goes on the page and
 * nothing else; if it ever computes a total, the total on the statement and the
 * total on the screen are free to disagree, and the driver is holding the one
 * that says he is owed more.
 *
 * GUARDRAIL: server/tests/driver-ledger.test.js
 */
'use strict';

const PDFDocument = require('pdfkit');
const { sheet } = require('./invoice-pdf');
const ledger = require('./driver-ledger');
const { getDb } = require('./db');

const {
  PAGE_W, PAGE_H, M, CW,
  NAVY, SOFT, MUTED, HAIR, TINT,
  BODY, BOLD, MONO,
  registerFonts, drawMasthead, hline, fmtShortDate
} = sheet;

const money = (n) => '£' + (Math.round(Number(n) * 100) / 100).toFixed(2);
/* A negative balance is money the DRIVER owes, and a minus sign in a column of
   pounds is easy to miss when it decides which way the money goes. It is said in
   words underneath; here the figure keeps its sign so the column still adds up. */
const signed = (n) => (n < 0 ? '−' : '') + money(Math.abs(n));

/* ── COLUMNS ──────────────────────────────────────────────────────────────────
   Date, journey, fare, commission, payout, balance. The journey takes whatever
   the five amount columns leave, because it is the only one whose width is not
   decided by the widest number it can hold. */
/* Wide enough for the longest date it can hold — "Wed 12 Sep 2026" measures
   54.1pt at 8.5pt Cormorant, and at 52 the column wrapped and the second line
   was cut off by the row below. Measured, not guessed. */
const CW_DATE = 64;
const CW_AMT  = 62;                       // fare, commission, payout
const CW_BAL  = 68;                       // carries a minus sign and a wider total
const CW_ROUTE = CW - CW_DATE - CW_AMT * 3 - CW_BAL;
const X_DATE  = M;
const X_ROUTE = X_DATE + CW_DATE;
const X_FARE  = X_ROUTE + CW_ROUTE;
const X_COMM  = X_FARE + CW_AMT;
const X_PAY   = X_COMM + CW_AMT;
const X_BAL   = X_PAY + CW_AMT;

const ROW_MIN = 20;
const FOOT_RESERVE = 96;                  // the footer band plus air above it

/**
 * Everything the statement shows, from the ledger and nowhere else.
 * `driver` is a users row; `from`/`to` bound the period (optional).
 */
function statementData(driverId, opts) {
  const o = opts || {};
  const db = getDb();
  const driver = db.prepare(
    "SELECT id, full_name, email, phone FROM users WHERE id = ?"
  ).get(driverId);
  if (!driver) return null;

  const { items, totals } = ledger.driverHistory(driverId, { from: o.from, to: o.to });
  const settlements = ledger.driverSettlements(driverId, { from: o.from, to: o.to });
  /* THE BALANCE IS THE WHOLE BALANCE, not the period's. A statement for one week
     that closed at "we owe you £86.40" while £400 was outstanding from March
     would be a true number and a misleading document. The period totals
     describe the period; the balance describes the relationship. */
  const balance = ledger.driverBalance(driverId);

  return {
    driver,
    period: { from: o.from || null, to: o.to || null },
    items,
    settlements,
    totals,
    balance,
    issued: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' })
  };
}

function periodLabel(p) {
  if (p.from && p.to) return fmtShortDate(p.from) + ' — ' + fmtShortDate(p.to);
  if (p.from) return 'From ' + fmtShortDate(p.from);
  if (p.to) return 'To ' + fmtShortDate(p.to);
  return 'All time';
}

/** Label above value, as the invoice sets its paperwork row. */
function cell(doc, x, w, y, label, value, opts) {
  const o = opts || {};
  doc.font(BOLD).fontSize(7).fillColor(MUTED)
     .text(String(label).toUpperCase(), x, y, { width: w, characterSpacing: 1.2, lineBreak: false });
  doc.font(o.mono ? MONO : BODY).fontSize(o.size || 10.5).fillColor(o.color || NAVY)
     .text(String(value), x, y + 11, { width: w, lineBreak: false });
}

function drawHead(doc, y) {
  doc.save().rect(M, y, CW, 20).fill(TINT).restore();
  const h = (text, x, w, align) =>
    doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
       .text(text, x + (align === 'right' ? 0 : 5), y + 6,
             { width: w - 5, align: align || 'left', characterSpacing: 0.8, lineBreak: false });
  h('DATE', X_DATE, CW_DATE);
  h('JOURNEY', X_ROUTE, CW_ROUTE);
  h('FARE', X_FARE, CW_AMT, 'right');
  h('COMMISSION', X_COMM, CW_AMT, 'right');
  h('PAYOUT', X_PAY, CW_AMT, 'right');
  h('BALANCE', X_BAL, CW_BAL, 'right');
  y += 20;
  hline(doc, y, NAVY, 1.2);
  return y + 1;
}

function drawStatement(doc, d) {
  let y = drawMasthead(doc, M);

  doc.font(BOLD).fontSize(8).fillColor(MUTED)
     .text('DRIVER STATEMENT', M, y, { width: CW, align: 'center', characterSpacing: 2, lineBreak: false });
  y += 22;

  // Who, when, and what it comes to — the invoice's four-cell paperwork row.
  const colW = CW / 3;
  cell(doc, M, colW, y, 'Driver', d.driver.full_name || ('Driver ' + d.driver.id));
  cell(doc, M + colW, colW, y, 'Period', periodLabel(d.period));
  cell(doc, M + colW * 2, colW, y, 'Issued', fmtShortDate(d.issued));
  y += 34;
  hline(doc, y, HAIR, 0.6);
  y += 18;

  if (!d.items.length) {
    doc.font(BODY).fontSize(11).fillColor(SOFT)
       .text('No jobs were passed to this driver in this period.', M, y, { width: CW });
    y += 26;
  } else {
    y = drawHead(doc, y);
    let zebra = false;
    for (const it of d.items) {
      /* The journey drives the row height: measured in the font it will be drawn
         in, then the row is whichever is taller — its natural height or the text
         plus the air above and below. Same rule as the invoice table. */
      doc.font(BODY).fontSize(9.5);
      const routeH = doc.heightOfString(it.route || '—', { width: CW_ROUTE - 10 });
      /* AND THE LINE UNDER IT. Measured too — the row used to be sized on the
         journey alone, so on a two-line address the "Prepaid · WPH-L001"
         beneath it was drawn into the next row and clipped by its tint. */
      const kind = it.paymentType === 'cash' ? 'Cash — collected by driver' : 'Prepaid';
      const kindText = kind + '  ·  ' + (it.ref || '');
      doc.font(BODY).fontSize(7.5);
      const kindH = doc.heightOfString(kindText, { width: CW_ROUTE - 10 });
      const rowH = Math.max(ROW_MIN, routeH + kindH + 10);

      if (y + rowH > PAGE_H - M - FOOT_RESERVE) {
        drawFoot(doc, d);
        doc.addPage();
        y = drawHead(doc, M);
      }

      if (zebra) doc.save().rect(M, y, CW, rowH).fill(TINT).restore();
      zebra = !zebra;

      doc.font(BODY).fontSize(8.5).fillColor(MUTED)
         .text(fmtShortDate(it.date), X_DATE + 5, y + 6, { width: CW_DATE - 8, lineBreak: false });
      doc.font(BODY).fontSize(9.5).fillColor(NAVY)
         .text(it.route || '—', X_ROUTE + 5, y + 5.5, { width: CW_ROUTE - 10 });
      /* PREPAID or CASH sits under the journey rather than in a column of its
         own: it is the reason the payout column is blank on half the rows, and a
         reader looking at a blank cell should find the answer beside it. */
      doc.font(BODY).fontSize(7.5).fillColor(MUTED)
         .text(kindText, X_ROUTE + 5, y + 5.5 + routeH, { width: CW_ROUTE - 10, lineBreak: false });

      const amt = (text, x, w, color) =>
        doc.font(BODY).fontSize(9.5).fillColor(color || SOFT)
           .text(text, x, y + 6, { width: w - 5, align: 'right', lineBreak: false });
      amt(money(it.fare), X_FARE, CW_AMT);
      amt('−' + money(it.commission), X_COMM, CW_AMT);
      /* A cash job pays the driver nothing FROM US — he already has the fare. */
      amt(it.paymentType === 'cash' ? '—' : money(it.payout), X_PAY, CW_AMT);
      doc.font(BOLD).fontSize(9.5).fillColor(NAVY)
         .text(signed(it.balanceAfter), X_BAL, y + 6, { width: CW_BAL, align: 'right', lineBreak: false });

      y += rowH;
      hline(doc, y, HAIR, 0.3);
    }

    // ── PERIOD SUBTOTALS ─────────────────────────────────────────────────────
    y += 6;
    const sub = (label, value, strong) => {
      doc.font(strong ? BOLD : BODY).fontSize(strong ? 10 : 9.5).fillColor(strong ? NAVY : SOFT)
         .text(label, X_ROUTE, y, { width: CW_ROUTE + CW_AMT * 2 - 5, align: 'right', lineBreak: false });
      doc.font(strong ? BOLD : BODY).fontSize(strong ? 10 : 9.5).fillColor(strong ? NAVY : SOFT)
         .text(value, X_PAY, y, { width: CW_AMT + CW_BAL, align: 'right', lineBreak: false });
      y += 15;
    };
    sub(d.totals.jobs + (d.totals.jobs === 1 ? ' job' : ' jobs') + ' · fares', money(d.totals.fares));
    sub('Commission (' + (ledger.ADMIN_FEE_PCT * 100) + '%)', '−' + money(d.totals.commission));
    sub('Payouts on prepaid jobs', money(d.totals.payout));
    if (d.totals.cashCommission) {
      sub('Commission owed on cash jobs', '−' + money(d.totals.cashCommission));
    }
    y += 4;
  }

  // ── SETTLEMENTS ────────────────────────────────────────────────────────────
  if (d.settlements.length) {
    hline(doc, y, HAIR, 0.6);
    y += 12;
    doc.font(BOLD).fontSize(7.5).fillColor(MUTED)
       .text('ALREADY SETTLED', M, y, { characterSpacing: 1.2, lineBreak: false });
    y += 14;
    for (const s of d.settlements) {
      doc.font(BODY).fontSize(9).fillColor(SOFT)
         .text(fmtShortDate(s.paid_on) + (s.method ? '  ·  ' + s.method : '') + (s.note ? '  ·  ' + s.note : ''),
               M, y, { width: CW - CW_BAL - 10, lineBreak: false });
      doc.font(BODY).fontSize(9).fillColor(SOFT)
         .text(signed(-s.amount), X_BAL, y, { width: CW_BAL, align: 'right', lineBreak: false });
      y += 14;
    }
    y += 4;
  }

  // ── THE BALANCE ────────────────────────────────────────────────────────────
  if (y + 58 > PAGE_H - M - FOOT_RESERVE) { drawFoot(doc, d); doc.addPage(); y = M; }
  doc.save().rect(M, y, CW, 44).lineWidth(1).strokeColor(NAVY).stroke().restore();
  const owed = d.balance >= 0;
  doc.font(BOLD).fontSize(8).fillColor(MUTED)
     .text(owed ? 'WESTMERE OWES YOU' : 'YOU OWE WESTMERE', M + 14, y + 11,
           { characterSpacing: 1.4, lineBreak: false });
  doc.font(BOLD).fontSize(18).fillColor(NAVY)
     .text(money(Math.abs(d.balance)), M + 14, y + 22, { width: CW - 28, align: 'right', lineBreak: false });
  y += 54;

  /* WHY THE FIGURE MOVES THE WAY IT DOES. Commission on a cash job is not handed
     over at the kerb — it is carried and netted off the next payout, which is
     what the driver's job email promised him. Saying so on the statement is the
     difference between a running balance and an unexplained deduction. */
  doc.font(BODY).fontSize(8.5).fillColor(MUTED)
     .text('Commission on a cash job is not collected at the time — it is carried and set against your next payout. '
         + 'This balance is everything to date, not only the period above.',
           M, y, { width: CW });

  drawFoot(doc, d);
}

/* The footer band, drawn on every page — the licence line the invoice closes
   with, and the driver's name so a loose second page can be put back. */
function drawFoot(doc, d) {
  const footerY = PAGE_H - M - 18;
  hline(doc, footerY, HAIR, 0.3);
  doc.font(BOLD).fontSize(8).fillColor(MUTED)
     .text('Westmere Private Hire  ·  Licensed by Lewes District Council  ·  '
           + (d.driver.full_name || ('Driver ' + d.driver.id)) + ' statement',
           M, footerY + 6, { width: CW, align: 'center', lineBreak: false });
}

/** Render one driver's statement. Resolves to a Buffer, or null for no such driver. */
function buildDriverStatementPdf(driverId, opts) {
  const d = statementData(driverId, opts);
  if (!d) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: M, bottom: M, left: M, right: M },
      info: {
        Title: 'Driver statement — ' + (d.driver.full_name || d.driver.id),
        Author: 'Westmere Private Hire',
        Creator: 'Westmere Admin System'
      },
      autoFirstPage: true
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      registerFonts(doc);
      drawStatement(doc, d);
    } catch (err) {
      doc.end();
      return reject(err);
    }
    doc.end();
  });
}

/** The filename a browser should save it as. */
function statementFilename(d) {
  const name = String((d && d.driver && d.driver.full_name) || 'driver')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const p = d.period || {};
  const span = (p.from && p.to) ? p.from + '_' + p.to : (p.from || p.to || 'all');
  return 'westmere-statement-' + name + '-' + span + '.pdf';
}

module.exports = { buildDriverStatementPdf, statementData, statementFilename };
