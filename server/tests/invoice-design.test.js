/**
 * THE INVOICE, AS A DOCUMENT —
 *   node server/tests/invoice-design.test.js   (also gated by `npm test`)
 *
 * This is the one thing Westmere produces that lands on somebody else's desk
 * and gets filed. Two of its faults were not cosmetic:
 *
 *   THE VAT LINE. Every invoice printed "VAT (0%) — £0.00", hardcoded. The
 *   business is not registered, so that was not a zero; it was a statement
 *   about tax status that nothing in the system had the authority to make,
 *   printed on a document going to other people's accountants. It now appears
 *   only when a VAT number AND a rate are configured, and when it does the
 *   arithmetic has to be right — the stored total is VAT-INCLUSIVE, because
 *   that is what the fares are.
 *
 *   THE DATES. The journey table printed the raw ISO string, the one date
 *   format nobody reads aloud, while every other Westmere surface says
 *   "Mon 3 Aug 2026".
 *
 * The rest pins the layout decisions that stop it looking thin: a masthead that
 * matches the confirmation email, a total that is the largest thing on the
 * page, and a foot that does not print over itself.
 *
 * Renders REAL PDFs and reads the text back out of them. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('server/invoice-pdf.js');
const { buildInvoicePdf } = require('../invoice-pdf');
const PDF_VERSION = require('../invoice-pdf').TEMPLATE_VERSION;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const SETTINGS = {
  business_name: 'Westmere Private Hire', owner_name: 'Nikodem Krajnyk',
  address_line1: '4 Fisher Street', address_line2: 'Lewes, East Sussex', postcode: 'BN7 2DG',
  phone: '07930 342593', email: 'bookings@westmereprivatehire.co.uk',
  bank_name: 'Barclays', sort_code: '20-49-17', account_no: '40318822',
  account_name: 'N Krajnyk t/a Westmere Private Hire'
};
const BOOKINGS = [
  { ref: 'WPH-4871', date: '2026-08-03', time: '05:30', pickup: 'The Grand Hotel, Brighton', destination: 'London Gatwick Airport', fare: 75, flight: 'BA2751' },
  { ref: 'WPH-4903', date: '2026-08-18', time: '19:10', pickup: 'The Grand Hotel, Brighton', destination: 'Lewes, BN7 2AN', fare: 40, flight: '' }
];

/* WHAT THE PAGE ACTUALLY SAYS.
   Reading the words back out of the finished PDF is not possible cheaply: the
   brand face is embedded as a SUBSET, so the content stream holds glyph indices
   rather than letters. My first two attempts at an extractor both returned an
   empty string, which meant every assertion about the page passed while proving
   nothing — so this records the strings as they are DRAWN instead, by wrapping
   pdfkit's own text method. It is the same question asked one layer earlier,
   and it cannot silently answer "yes". */
const PDFDocument = require('pdfkit');
async function drawnText(data) {
  /* Bucketed BY DOCUMENT, because an invoice is now drawn twice: once into a
     throwaway to measure where the total lands, and once for real. Collecting
     both into one list would double every string on the page, and quietly
     defeat any assertion that something appears exactly once. */
  const byDoc = new Map();
  const order = [];
  const orig = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str) {
    if (!byDoc.has(this)) { byDoc.set(this, []); order.push(this); }
    byDoc.get(this).push(String(str));
    return orig.apply(this, arguments);
  };
  try { await buildInvoicePdf(data); }
  finally { PDFDocument.prototype.text = orig; }
  const last = order[order.length - 1];
  return (byDoc.get(last) || []).join(' \u241F ');
}

const account = (over) => Object.assign({
  invoiceNo: 'WPH-INV-0042', kind: 'account', total: 115, settings: SETTINGS,
  period: { issuedDate: '2026-08-25', dueDate: '2026-09-08', label: 'August 2026' },
  customer: { full_name: 'The Grand Hotel Brighton', email: 'accounts@example.com', phone: '01273 224300' },
  bookings: BOOKINGS, notes: 'Account terms: 14 days.'
}, over || {});

const bespoke = (over) => Object.assign({
  invoiceNo: 'WPH-INV-0043', kind: 'bespoke', total: 195, settings: SETTINGS,
  period: { issuedDate: '2026-08-25', dueDate: '2026-09-08' },
  recipient: { name: 'Mr Ben Chan', email: 'ben@example.com', phone: '07700 900123' },
  items: [{ description: 'Caterham to Stansted', amount: 195 }], notes: 'Bank transfer, please.'
}, over || {});

console.log('\nVAT');

test('NO VAT line when the business is not registered', async () => {
  const t = await drawnText(account());
  /* Matched on the LINE forms, not the bare word — "PRIVATE HIRE" contains
     "VAT", and the first version of this assertion failed on the strapline. */
  assert.ok(!/VAT \(/.test(t), 'no VAT line on an unregistered invoice');
  assert.ok(!/VAT registration/.test(t), 'and no registration number');
  assert.ok(!/Subtotal/.test(t),
    'and with no VAT there is nothing for a subtotal to be a subtotal OF — it would just repeat the total');
});

test('nothing hardcodes a zero-rate line any more', () => {
  // Comments stripped: the file NAMES the old line in order to explain why it
  // went, and a guard that cannot tell prose from code fails on the apology.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/VAT \(0%\)/.test(code), 'the hardcoded "VAT (0%)" must be gone');
  assert.ok(/vat_number/.test(SRC) && /vat_rate/.test(SRC), 'VAT must come from settings');
});

test('a VAT line appears ONLY when a number AND a rate are configured', async () => {
  const half = await drawnText(bespoke({
    settings: Object.assign({}, SETTINGS, { vat_number: 'GB 412 7789 03' }) }));
  assert.ok(!/VAT \(/.test(half), 'a number with no rate is not enough');
  const other = await drawnText(bespoke({
    settings: Object.assign({}, SETTINGS, { vat_rate: 20 }) }));
  assert.ok(!/VAT \(/.test(other), 'and a rate with no number is not enough either');
});

test('when it does appear, the maths treats the total as VAT-INCLUSIVE', async () => {
  const t = await drawnText(bespoke({
    total: 234,
    settings: Object.assign({}, SETTINGS, { vat_number: 'GB 412 7789 03', vat_rate: 20 }) }));
  assert.ok(/VAT \(20%\)/.test(t), 'the rate must be named');
  assert.ok(/195\.00/.test(t), 'net of £234 at 20% is £195.00');
  assert.ok(/39\.00/.test(t), 'and the VAT is £39.00');
  assert.ok(/234\.00/.test(t), 'the total is unchanged — the fare already included it');
  assert.ok(/GB 412 7789 03/.test(t), 'and the registration number must be printed');
});

console.log('\nDates');

test('journeys read as words, never as an ISO string', async () => {
  const t = await drawnText(account());
  assert.ok(/Mon 3 Aug 2026/.test(t), 'expected "Mon 3 Aug 2026"');
  assert.ok(/Tue 18 Aug 2026/.test(t));
  assert.ok(!/2026-08-03/.test(t), 'the raw ISO date must not reach the page');
});

test('the date is built from components, never parsed as an instant', () => {
  const fn = /function fmtShortDate\(d\)[\s\S]*?\n\}/.exec(SRC);
  assert.ok(fn, 'fmtShortDate is missing');
  assert.ok(/Date\.UTC\(/.test(fn[0]),
    "never new Date('YYYY-MM-DD') — it reads back a day early west of London");
  assert.ok(!/new Date\(\s*d\s*\)/.test(fn[0]));
});

test('a missing or odd date degrades rather than printing "Invalid Date"', async () => {
  const t = await drawnText(account({
    bookings: [{ ref: 'WPH-1', date: '', time: 'ASAP', pickup: 'A', destination: 'B', fare: 40 }] }));
  assert.ok(!/Invalid Date|NaN/.test(t), 'never print a broken date to a customer');
});

console.log('\nThe page');

test('the masthead is the confirmation email, on paper', async () => {
  /* The owner asked for the email's header — a stretched wordmark across a
     full-width band — rather than the crest-in-a-square this file used to
     open with. The five elements and their order are what makes the two
     surfaces read as the same company. */
  const t = await drawnText(account());
  assert.ok(/WESTMERE/.test(t), 'the wordmark must be the masthead');
  assert.ok(/PRIVATE HIRE · SUSSEX/.test(t),
    'and the strapline beneath it, exactly as heroShell() sets it in the email');
  const email = read('server/email.js');
  // The email sets it in mixed case and uppercases it in CSS; the PDF has no
  // text-transform, so it carries the same words already uppercased.
  assert.ok(/Private Hire &middot; Sussex/.test(email),
    'if the email ever changes its strapline, this invoice must be changed with it');
  assert.ok(/text-transform:uppercase/.test(email), 'and it is uppercased on screen');
});

test('the wordmark is SET, not placed as a bitmap', () => {
  /* The literal reading of "stretched logo" is a raster blown up to the width
     of the page, and it would land soft on the one document that gets printed.
     Cormorant is already embedded, so the wordmark draws as outlines. */
  assert.ok(!/doc\.image\(/.test(SRC),
    'no raster in the header — a 512px crest stretched to 491pt would be visibly soft');
  assert.ok(/function centredWide\(/.test(SRC), 'the wordmark must be drawn as type');
});

test('the wordmark is CENTRED at a moderate width, not justified to the margins', async () => {
  /* The first attempt at "a stretched logo" tracked it to the full measure, and
     at 42pt of letter-spacing it stopped reading as a word. What is pinned now
     is the opposite: a wordmark that occupies roughly half the page and sits on
     the centre line, with real margin either side.

     MEASURED, not read out of the source — a source-shape assertion here passed
     happily while the tracking was wrong, which is how the over-stretch got as
     far as a rendered preview in the first place. */
  const PAGE_W = 595.28, MARGIN = 52, CONTENT_W = PAGE_W - MARGIN * 2;
  let seen = null;
  const orig = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str, x, yy, opts) {
    if (String(str) === 'WESTMERE') {
      const cs = (opts && opts.characterSpacing) || 0;
      seen = { x: x, w: this.widthOfString('WESTMERE', { characterSpacing: cs }), track: cs };
    }
    return orig.apply(this, arguments);
  };
  try { await buildInvoicePdf(account()); }
  finally { PDFDocument.prototype.text = orig; }

  assert.ok(seen, 'the wordmark was never drawn');
  const pct = seen.w / CONTENT_W;
  assert.ok(pct > 0.35 && pct < 0.65,
    'the wordmark must sit between a third and two thirds of the measure — it drew at ' +
    (pct * 100).toFixed(0) + '%');
  assert.ok(seen.w < CONTENT_W - 60,
    'and must NOT reach the margins: ' + seen.w.toFixed(1) + 'pt of a ' + CONTENT_W.toFixed(1) + 'pt page');
  const centre = seen.x + seen.w / 2;
  assert.ok(Math.abs(centre - PAGE_W / 2) < 2,
    'it must sit on the centre line, found its middle at ' + centre.toFixed(1));
});

test('the tracking is the EMAIL\'s proportion, tied to the type size', () => {
  const fn = /function centredWide\([\s\S]*?\n  \}/.exec(SRC);
  assert.ok(fn, 'centredWide is missing');
  assert.ok(/const EMAIL_TRACK = 11 \/ 29;/.test(SRC),
    'the ratio must be written as the fraction it came from — 11px on 29px in heroShell()');
  assert.ok(/const track   = size \* ratio;/.test(fn[0]),
    'tracking must follow the size, not be a number typed in beside it');
  const email = read('server/email.js');
  assert.ok(/font-size:29px;letter-spacing:11px/.test(email),
    'if the email changes its wordmark proportions, this invoice must be changed with it');
  assert.ok(/const gaps    = Math\.max\(1, str\.length - 1\)/.test(fn[0]),
    'width counts the GAPS, not the letters — pdfkit does not track after the last glyph');
});

test('the paperwork sits BELOW the band, and says the same date once', async () => {
  const t = await drawnText(account());
  assert.ok(/INVOICE \u241F WPH-INV-0042|INVOICE/.test(t), 'the number must be labelled');
  assert.ok(/DUE/.test(t) && /8 September 2026/.test(t),
    'the DUE date must be printed — it was read from the data and then never drawn at all');
  const issued = (t.match(/25 August 2026/g) || []).length;
  assert.strictEqual(issued, 1,
    'the issue date must appear ONCE; it used to print in the corner and again halfway down');
});

test('the TOTAL is the biggest thing on the page', () => {
  const tot = /TOTAL DUE[\s\S]{0,400}/.exec(SRC)[0];
  const size = /fontSize\((\d+)\)[\s\S]{0,120}total\.toFixed/.exec(tot);
  assert.ok(size, 'the total must state its size');
  assert.ok(Number(size[1]) >= 20, 'the total must be at least 20pt, found ' + size[1]);
  assert.ok(/vbox\(doc, TOT_X/.test(SRC), 'and framed, so it reads as the answer');
});

test('the flight is a tag on the journey, not a cramped fourth line', async () => {
  const t = await drawnText(account());
  assert.ok(/FLIGHT BA2751/.test(t), 'the flight must be labelled');
  assert.ok(!/Flt /.test(t), 'the old abbreviated form is gone');
});

test('notes and bank details survive a BUSY invoice', async () => {
  /* The first attempt lost the terms entirely on a seven-journey invoice, then
     printed the bank block off the bottom of the page. Both are the kind of
     failure nobody notices until a customer does. */
  const many = [];
  for (let i = 0; i < 7; i++) {
    many.push({ ref: 'WPH-49' + i, date: '2026-08-0' + (i + 1), time: '09:00',
      pickup: 'The Grand Hotel, Brighton', destination: 'London Gatwick Airport', fare: 75, flight: 'BA275' + i });
  }
  const t = await drawnText(account({ bookings: many, total: 525 }));
  assert.ok(/Account terms/.test(t), 'the terms must still be on the page');
  assert.ok(/PAYMENT DETAILS/.test(t), 'and so must the bank block');
  assert.ok(/40318822/.test(t), 'including the account number, which was running off the paper');
  assert.ok(/Licensed by/.test(t), 'and the footer must not be pushed off');
});

test('the spare inch is measured and spread, not pooled', async () => {
  /* Two earlier attempts pooled it: at the bottom it reads as an unfinished
     page, and above the pinned payment details it opened a hole in the middle
     of the one-item bespoke invoice. */
  assert.ok(/function measureSlack\(/.test(SRC), 'the page must be measured before it is drawn');
  assert.ok(/drawInvoice\(doc, data, measureSlack\(data\)\)/.test(SRC), 'and the measurement used');
  assert.ok(/catch \(_\) \{\s*\n?\s*return NO_SLACK;/.test(SRC),
    'a spacing refinement must never be the reason an invoice fails to generate');
  const one = await buildInvoicePdf(bespoke());
  const three = await buildInvoicePdf(account());
  assert.ok(one.length > 0 && three.length > 0, 'both shapes still build');
});

test('a long month breaks over pages instead of printing off the paper', async () => {
  const many = [];
  for (let i = 0; i < 18; i++) {
    many.push({ ref: 'WPH-52' + i, date: '2026-08-' + String((i % 28) + 1).padStart(2, '0'),
      time: '07:00', pickup: 'Brighton', destination: 'Gatwick Airport', fare: 60 + i, flight: '' });
  }
  const buf = await buildInvoicePdf(account({ bookings: many, total: 1200 }));
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.strictEqual(pages, 2, 'eighteen journeys must not be crammed onto one A4 page');
  const t = await drawnText(account({ bookings: many, total: 1200 }));
  assert.ok(/PAYMENT DETAILS/.test(t) && /Account terms/.test(t),
    'and the foot matter must survive the break');
  assert.ok((t.match(/Licensed by/g) || []).length >= 2,
    'every page carries the footer — it used to be written once, at the very end');
});

test('a TABLE that broke over pages is never given slack', () => {
  /* Narrowed deliberately. A broken TABLE moves the total onto a later page, so
     yAfterTotal stops describing page one and reading it as slack half-empties
     it. A broken FOOT GROUP does not move the total — suppressing slack there
     was leaving a void above the footer for no reason. */
  assert.ok(/if \(m\.tablePages > 1\) return NO_SLACK/.test(SRC),
    'the suppression must be keyed on a table break, not on any page break');
  assert.ok(/let tablePages = 1;/.test(SRC) && /tablePages\+\+;/.test(SRC),
    'and the two kinds of break must be counted apart');
});

test('the foot group can never be pulled up over the total', () => {
  assert.ok(/y = Math\.max\(y, Math\.min\(Math\.max\(y, GROUP_PIN\), GROUP_MAX\)\)/.test(SRC),
    'y must be a floor: the pin may push the foot group down, never up');
});

test('the payment block height is COMPUTED, not estimated', () => {
  // An estimate here is what printed the bank details off the bottom.
  assert.ok(/payRowCount/.test(SRC) && /14 \+ payRowCount \* 14 \+ 10/.test(SRC),
    'the reserved height must match the height the block actually draws');
});

console.log('\nThe notes block, and what sits under it');

/* WHERE THINGS ACTUALLY LAND ON THE PAGE.
   The notes/payment collision could not be caught by asking what text was
   drawn — every word WAS drawn, one block simply painted over another. So this
   records the y of each drawn string, and of the filled rectangles, and checks
   they do not occupy the same band. */
async function geometry(data) {
  const texts = [];
  const rects = [];
  const origText = PDFDocument.prototype.text;
  const origRect = PDFDocument.prototype.rect;
  let page = 0;
  const origAdd = PDFDocument.prototype.addPage;
  PDFDocument.prototype.addPage = function () { page++; return origAdd.apply(this, arguments); };
  PDFDocument.prototype.text = function (str, x, y, opts) {
    if (typeof x === 'number' && typeof y === 'number') {
      /* The note is drawn as ONE call carrying newlines, so its height has to
         be asked for rather than counted in call records — which is how the
         first version of this check saw "2 lines" for a five-line note and
         proved nothing. */
      let h = 0;
      try { h = this.heightOfString(String(str), opts && opts.width ? { width: opts.width } : undefined); }
      catch (_) {}
      texts.push({ s: String(str), x, y, h, page });
    }
    return origText.apply(this, arguments);
  };
  PDFDocument.prototype.rect = function (x, y, w, h) {
    rects.push({ x, y, w, h, page });
    return origRect.apply(this, arguments);
  };
  try { await buildInvoicePdf(data); }
  finally {
    PDFDocument.prototype.text = origText;
    PDFDocument.prototype.rect = origRect;
    PDFDocument.prototype.addPage = origAdd;
  }
  return { texts, rects };
}

const LONG_NOTES = "Passenger\nGavin O'Shea\nFinance department\nPriscilla Hancock\npri@echopointmedical.com";
const BANK = Object.assign({}, SETTINGS, {
  bank_name: 'monzo', account_name: 'Nikodem Krajnyk', sort_code: '040006', account_no: '11513694'
});

test('the PAYMENT DETAILS box never overlaps the notes', async () => {
  /* THE LIVE BUG. The notes block reserved a flat 44pt however long the note
     was, so a five-line note — passenger, finance contact, department — was
     painted over by the bank block. Every line was on the page and two of them
     were unreadable. */
  const g = await geometry(bespoke({ settings: BANK, notes: LONG_NOTES, total: 250 }));
  const note = g.texts.find(t => t.s === LONG_NOTES);
  assert.ok(note, 'the note must be drawn');
  assert.ok(note.h > 50, 'a five-line note is taller than one line: measured ' + note.h.toFixed(1) + 'pt');
  const payLabel = g.texts.find(t => t.s === 'PAYMENT DETAILS');
  assert.ok(payLabel, 'the payment block must be on the page');
  assert.strictEqual(note.page, payLabel.page, 'both are foot matter and travel together');
  assert.ok(payLabel.y >= note.y + note.h,
    'the payment block must start BELOW the last line of the notes — the note runs ' +
    note.y.toFixed(1) + '→' + (note.y + note.h).toFixed(1) + ' and the block began at ' + payLabel.y.toFixed(1));
});

test('the notes PANEL is as tall as the notes it holds', async () => {
  const g = await geometry(bespoke({ settings: BANK, notes: LONG_NOTES, total: 250 }));
  const note = g.texts.find(t => t.s === LONG_NOTES);
  // The tinted panel behind it: the full-width fill that must contain the text.
  const panel = g.rects.filter(r => r.w > 400 && r.y <= note.y && r.y + r.h >= note.y + note.h);
  assert.ok(panel.length,
    'no panel encloses the note — it was a fixed 36pt box with ' + note.h.toFixed(0) + 'pt of text in it');
});

test('every line of a long note is drawn, and none is clipped away', async () => {
  const g = await geometry(bespoke({ settings: BANK, notes: LONG_NOTES, total: 250 }));
  const note = g.texts.find(t => t.s === LONG_NOTES);
  assert.ok(note, 'the note must reach the page');
  for (const line of ['Passenger', "Gavin O'Shea", 'Finance department', 'Priscilla Hancock']) {
    assert.ok(note.s.indexOf(line) !== -1, 'missing from the note: ' + line);
  }
  assert.ok(note.y + note.h < 842 - 52, 'and the whole of it must fall above the bottom margin');
});

test('the note WRAPS instead of running off the edge', () => {
  const src = SRC.slice(SRC.lastIndexOf('// ── NOTES'), SRC.indexOf('// ── PAYMENT DETAILS'));
  assert.ok(!/lineBreak: false/.test(src),
    'a long note with no newlines used to run past the right margin and vanish');
  assert.ok(/NOTES_W/.test(src), 'and it must be given the width it was measured against');
});

test('the reserved height is MEASURED, never a constant', () => {
  assert.ok(!/const NOTES_H = notes \? 44 : 0/.test(SRC), 'the flat 44pt is what caused the overlap');
  assert.ok(/doc\.heightOfString\(String\(notes\)/.test(SRC), 'it must ask pdfkit how tall the note is');
  assert.ok(/NOTES_BOX_H = Math\.max\(36/.test(SRC), 'with a floor so a one-word note still looks deliberate');
});

test('a note too tall for the page breaks rather than colliding', async () => {
  /* Genuinely taller than the space any tightening could free — the earlier
     fourteen-line version turned out to FIT once the height was measured
     properly, so it was asserting a page break that need not happen. */
  const huge = Array.from({ length: 30 }, (_, i) =>
    'Note line ' + (i + 1) + ' — a reasonably long line of explanatory text that will need to wrap.').join('\n');
  const g = await geometry(bespoke({ settings: BANK, notes: huge, total: 250 }));
  const note = g.texts.find(t => /^Note line 1 /.test(t.s));
  assert.ok(note, 'the note must be drawn');
  assert.strictEqual((note.s.match(/Note line /g) || []).length, 30, 'all thirty lines');
  const payLabel = g.texts.find(t => t.s === 'PAYMENT DETAILS');
  assert.ok(payLabel.page > note.page || payLabel.y >= note.y + note.h,
    'the bank block must be on a later page or below the note');
  /* Counting PAGES proves nothing here: pdfkit paginates overflowing text by
     itself, so the count rises even with the fallback removed. What matters is
     that no foot matter is placed BELOW the footer line — that is the failure
     the fallback exists to prevent. */
  const FOOTER_Y = 842 - 52 - 18;
  assert.ok(payLabel.y < FOOTER_Y - 20,
    'the payment block was placed at ' + payLabel.y.toFixed(1) + ', at or below the footer line ' + FOOTER_Y);
  assert.ok(note.y < FOOTER_Y,
    'and the note must start above it, not run off the bottom of the page');
});

test('a busy ACCOUNT invoice with notes does not collide either', async () => {
  const many = [];
  for (let i = 0; i < 7; i++) {
    many.push({ ref: 'WPH-49' + i, date: '2026-08-0' + (i + 1), time: '09:00',
      pickup: 'Brighton', destination: 'London Gatwick Airport', fare: 75, flight: 'BA275' + i });
  }
  const g = await geometry(account({ settings: BANK, bookings: many, total: 525, notes: LONG_NOTES }));
  const note = g.texts.find(t => t.s === LONG_NOTES);
  const payLabel = g.texts.find(t => t.s === 'PAYMENT DETAILS');
  assert.ok(note && payLabel, 'both blocks must be present');
  assert.ok(payLabel.page > note.page || payLabel.y >= note.y + note.h, 'and must not overlap');
});

test('an invoice with NO notes is unaffected', async () => {
  const g = await geometry(bespoke({ settings: BANK, notes: '', total: 250 }));
  const payLabel = g.texts.find(t => t.s === 'PAYMENT DETAILS');
  assert.ok(payLabel, 'the payment block must still be drawn');
  const buf = await buildInvoicePdf(bespoke({ settings: BANK, notes: '', total: 250 }));
  assert.strictEqual((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1,
    'and it must still be one page');
});

console.log('\nThe cache cannot outlive the template — again');

/* A REDESIGN THAT DOES NOT BUMP TEMPLATE_VERSION SHIPS INVISIBLY.
   Generated invoices are cached to disk under a filename carrying the template
   version. Fix the layout, deploy, and every existing invoice keeps serving the
   file drawn by the old code — which is what happened the first time the
   invoice was redesigned, and happened AGAIN with the notes-overlap fix: the
   corrected build went live and the reported invoice came back byte-identical.

   So the layout is content-hashed. Change how the page is drawn and this fails,
   with the two things to do written in the message. It cannot tell a
   good change from a bad one; it can only refuse to let one through quietly. */
const LAYOUT_HASH = '2ee233eb9397';
const LAYOUT_VERSION = 6;   // 6: the two greys darkened for contrast
                            // 5: rows and their zebra bands grow to the wrapped text

test('the drawing code and TEMPLATE_VERSION move together', () => {
  /* THE PALETTE COUNTS AS LAYOUT. It was not in this hash, and it should have
     been: darkening the two greys changed every rendered page while the hash
     sat still, so cached PDFs would have kept serving the pale text under an
     unchanged version number — the exact failure this guard exists to stop,
     walking straight past it. The colour block is hashed with the drawing
     code now. */
  const palette = SRC.slice(SRC.indexOf('const NAVY'), SRC.indexOf('// ── Page geometry'));
  /* BOUNDED AT THE END OF THE DRAWING, not at the end of the file. Everything
     below drawInvoice is plumbing — tokens, public URLs, where the cache lives
     and what it is keyed on — and none of it puts a mark on the page. Hashing
     it too made this guard demand a TEMPLATE_VERSION bump for a change to a
     filename, which is not what the version means and would have orphaned a
     cache for nothing. The region ends at the first function past the
     drawing. */
  const drawStart = SRC.indexOf('function drawInvoice(');
  const drawEnd = SRC.indexOf('function ensureInvoiceToken(', drawStart);
  assert.ok(drawEnd > drawStart, 'the end of the drawing could not be found — re-anchor this guard');
  const layout = palette + SRC.slice(drawStart, drawEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')          // comments are prose, not layout
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = require('crypto').createHash('sha256').update(layout).digest('hex').slice(0, 12);
  assert.strictEqual(PDF_VERSION, LAYOUT_VERSION,
    'TEMPLATE_VERSION is ' + PDF_VERSION + ' but this guard expects ' + LAYOUT_VERSION);
  assert.strictEqual(hash, LAYOUT_HASH,
    'THE INVOICE LAYOUT CHANGED.\n' +
    '      Two things must happen together or the fix will not reach anybody:\n' +
    '        1. bump TEMPLATE_VERSION in server/invoice-pdf.js (cached PDFs are keyed on it,\n' +
    '           so without this every existing invoice keeps serving the OLD drawing);\n' +
    '        2. update LAYOUT_HASH and LAYOUT_VERSION in this file to ' + hash + ' / ' + PDF_VERSION + '.\n' +
    '      Comments and whitespace are ignored, so prose-only edits will not trip this.');
});

console.log('\nThe brand');

test('still navy, still Cormorant, still no gold and no cream', () => {
  assert.ok(/#102a43/.test(SRC), 'the navy must be the house navy');
  assert.ok(/Cormorant-Regular\.ttf/.test(SRC) && /Cormorant-SemiBold\.ttf/.test(SRC),
    'the brand face must still be embedded');
  // The dedicated hue guard lives in button-style.test.js; this is the cheap
  // local check that nobody has reintroduced a literal.
  assert.ok(!/#[cC]{1}[a-fA-F0-9]{5}|goldenrod|#[dD][aA]?[aA]520/.test(SRC), 'no gold literals');
});

test('both shapes still build, and the maths is untouched', async () => {
  const a = await drawnText(account());
  assert.ok(/115\.00/.test(a), 'the account total must print');
  assert.ok(/WPH-INV-0042/.test(a), 'and the invoice number');
  assert.ok(/The Grand Hotel Brighton/.test(a), 'and who it is for');
  const b = await drawnText(bespoke());
  assert.ok(/195\.00/.test(b) && /WPH-INV-0043/.test(b) && /Mr Ben Chan/.test(b));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-design\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
