/**
 * INVOICE ROWS FIT WHAT IS IN THEM — run with:
 *   node server/tests/invoice-row-height.test.js   (also gated by `npm test`)
 *
 * THE BUG THIS EXISTS FOR
 *   Row heights were constants — ROW_H for a bespoke line, BK_ROW_H for a
 *   journey. A description is drawn into a fixed column width, so PDFKit wraps
 *   it, and the wrapped second line was drawn BELOW the bottom of its own row.
 *   The next row's tinted band was then painted straight over the top of it.
 *   On INV-202608-0003 (APD Private Hire) that hid half a journey behind the
 *   following row's shading.
 *
 * WHY IT IS MEASURED RATHER THAN READ
 *   "The text is in the PDF" was already true when the bug was live — the
 *   glyphs were there, with a filled rectangle painted over them. Only geometry
 *   can tell the difference, so this file records what the code asks PDFKit to
 *   draw (every text box with the height it will really occupy, every filled
 *   band) and checks the boxes against each other. Parsing the finished PDF
 *   would not do: the fonts are subsetted, so the strings in the content stream
 *   are glyph ids.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const PDFDocument = require('pdfkit');

/* Record the drawing calls. heightOfString is asked with the font and width in
   force at that moment, which is the same question the fix asks. */
/* buildInvoicePdf draws the document TWICE — once into a throwaway probe to
   measure the slack, then again for real. Both land in the same recording, so
   every op is tagged with its document and only the LAST one is analysed.
   Without this the probe's pages are read as continuation pages of the real
   document and the letterhead appears to sit on top of a table row. */
function recorder() {
  const ops = { texts: [], rects: [], page: 1, docs: [] };
  const seen = (d) => { let i = ops.docs.indexOf(d); if (i < 0) { i = ops.docs.push(d) - 1; ops.page = 1; } return i; };
  const T = PDFDocument.prototype.text, R = PDFDocument.prototype.rect, A = PDFDocument.prototype.addPage;
  PDFDocument.prototype.text = function (str, x, y, o) {
    o = o || {};
    const d = seen(this);
    if (typeof x === 'number' && typeof y === 'number') {
      let h = 0;
      try { h = this.heightOfString(String(str), { width: o.width || (this.page.width - x - 20) }); } catch (_) {}
      ops.texts.push({ s: String(str), x, y, w: o.width || 0, h, page: ops.page, doc: d, top: y, bottom: y + h });
    }
    return T.apply(this, arguments);
  };
  /* The fill colour matters: only the TABLE's tint bands are "the next row's
     background". The letterhead and the totals box are full-width boxes too,
     and text is meant to sit on them. */
  const F = PDFDocument.prototype.fill;
  PDFDocument.prototype.fill = function (c) {
    if (typeof c === 'string' && ops.rects.length) ops.rects[ops.rects.length - 1].fill = c.toUpperCase();
    return F.apply(this, arguments);
  };
  PDFDocument.prototype.rect = function (x, y, w, h) {
    ops.rects.push({ x, y, w, h, page: ops.page, doc: seen(this), top: y, bottom: y + h, fill: null });
    return R.apply(this, arguments);
  };
  ops._F = F;
  PDFDocument.prototype.addPage = function () { ops.page++; return A.apply(this, arguments); };
  ops.restore = () => {
    PDFDocument.prototype.text = T; PDFDocument.prototype.rect = R; PDFDocument.prototype.addPage = A;
    PDFDocument.prototype.fill = ops._F;
  };
  return ops;
}

const M = 52, CW = 595.28 - 2 * M;
const TINT = '#F2F5F8';          // the zebra tint, from invoice-pdf.js §1
/** The zebra bands: full-column-width boxes filled with the row tint. */
const bandsOf = (ops, page) => ops.rects
  .filter((r) => r.page === page && Math.abs(r.x - M) < 2 && Math.abs(r.w - CW) < 2 &&
                 r.h > 12 && r.fill === TINT)
  .sort((a, b) => a.top - b.top);

async function draw(data) {
  const ops = recorder();
  try {
    delete require.cache[require.resolve('../invoice-pdf')];
    const { buildInvoicePdf } = require('../invoice-pdf');
    await buildInvoicePdf(data);
  } finally { ops.restore(); }
  // Keep only the real document — the last one drawn.
  const last = ops.docs.length - 1;
  ops.texts = ops.texts.filter((t) => t.doc === last);
  ops.rects = ops.rects.filter((r) => r.doc === last);
  ops.page = ops.texts.reduce((m, t) => Math.max(m, t.page), 1);
  return ops;
}

const LONG = 'Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN - Gatwick Airport (parking £6.00)';
const LONGER = 'Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN - London City Airport (parking £11.50) including meet and greet and one hour of waiting time';
const SETTINGS = { company_name: 'Westmere Private Hire' };
const PERIOD = { issuedDate: '2026-08-28', dueDate: '2026-09-11', label: 'August 2026' };

const bespoke = (items) => ({
  invoiceNo: 'INV-202608-0003', kind: 'bespoke', total: items.reduce((s, i) => s + i.amount, 0),
  notes: '', settings: SETTINGS,
  recipient: { name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000', address: '1 High Street\nSteyning\nBN44 3AA' },
  period: PERIOD, items
});
const account = (bookings) => ({
  invoiceNo: 'INV-202608-0004', kind: 'account', total: bookings.reduce((s, b) => s + b.fare, 0),
  notes: '', settings: SETTINGS,
  customer: { full_name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000' },
  period: PERIOD, bookings
});
// A pickup with no comma to cut at: shortDisplay cannot shorten it, so it wraps.
const UNSHORTENABLE = 'Weppons Farm Chanctonbury Ring Road Wiston near Steyning West Sussex BN44 3DN';

/* THE CHECK. No text may be crossed by a band that begins after it starts —
   that is exactly what "hidden behind the next row" is. */
function overlaps(ops, page) {
  const bands = bandsOf(ops, page);
  const bad = [];
  for (const t of ops.texts.filter((x) => x.page === page && x.h > 0 && x.s.trim())) {
    for (const b of bands) {
      if (b.top > t.top + 0.5 && b.top < t.bottom - 0.5) {
        bad.push(t.s.slice(0, 44) + '  [text ' + t.top.toFixed(1) + '..' + t.bottom.toFixed(1) +
                 ' / band starts ' + b.top.toFixed(1) + ']');
      }
    }
  }
  return bad;
}

// ── 1. THE REPORTED BUG ──────────────────────────────────────────────────
console.log('\nA wrapped description is not covered by the next row');

/* ENOUGH ROWS THAT THERE IS NO SLACK LEFT.
   A three-line invoice is given up to 14pt of extra height per row to fill the
   page — which is enough to swallow a wrapped second line and hide the very bug
   this file is about. The first version of this test used three rows and stayed
   green with the fix reverted. A fuller invoice gets no slack, so the row height
   is the only thing holding the layout up. */
const FILLER = (n, desc) => Array.from({ length: n }, (_, i) => ({
  date: '2026-08-' + String(i + 1).padStart(2, '0'),
  description: i % 3 === 0 ? desc : 'Brighton Station - Heathrow Terminal 5',
  amount: 90 + i
}));

test('BESPOKE: a two-line description is clear of the next band', async () => {
  for (const items of [FILLER(9, LONG), FILLER(9, LONGER),
                       [{ date: '2026-08-03', description: LONG, amount: 95 },
                        { date: '2026-08-07', description: 'Brighton - Heathrow T5', amount: 120 },
                        { description: LONGER, amount: 180 }]]) {
    const ops = await draw(bespoke(items));
    for (let p = 1; p <= ops.page; p++) {
      const bad = overlaps(ops, p);
      assert.deepStrictEqual(bad, [], items.length + ' items, page ' + p +
        ' — text runs under a later band:\n      ' + bad.join('\n      '));
    }
  }
});

test('BESPOKE: the row that wraps is TALLER than the rows that do not', async () => {
  /* The direct statement of the fix, and the one that fails the moment the row
     height goes back to a constant — whether or not slack happens to be
     covering the overlap that day. */
  const ops = await draw(bespoke(FILLER(9, LONGER)));
  const tall = ops.texts.filter((t) => t.s === LONGER);
  const short = ops.texts.filter((t) => /^Brighton Station/.test(t.s));
  assert.ok(tall.length && short.length, 'fixture is wrong');
  assert.ok(tall[0].h > short[0].h + 8, 'the long description must measure taller: ' +
    tall[0].h.toFixed(1) + ' vs ' + short[0].h.toFixed(1));
  const bands = bandsOf(ops, tall[0].page);
  const own = bands.find((b) => b.top <= tall[0].top + 0.5 && b.bottom >= tall[0].top);
  if (own) assert.ok(own.bottom >= tall[0].bottom - 0.5,
    'its band must reach the bottom of it: band ends ' + own.bottom.toFixed(1) +
    ', text ends ' + tall[0].bottom.toFixed(1));
  // and the NEXT thing drawn in the description column must start below it
  const below = ops.texts.filter((t) => t.page === tall[0].page && Math.abs(t.x - tall[0].x) < 1 &&
                                        t.top > tall[0].top + 0.5)
                         .sort((a, b) => a.top - b.top)[0];
  if (below) assert.ok(below.top >= tall[0].bottom - 0.5,
    'the next row starts inside the wrapped text: next at ' + below.top.toFixed(1) +
    ', this ends ' + tall[0].bottom.toFixed(1));
});

const JOURNEYS = (n) => Array.from({ length: n }, (_, i) => ({
  date: '2026-08-' + String(i + 1).padStart(2, '0'), ref: 'WPH-30' + i, time: '09:30',
  pickup: i % 2 === 0 ? UNSHORTENABLE : 'Brighton Station',
  destination: i % 3 === 0 ? UNSHORTENABLE : 'Heathrow T5',
  flight: i % 4 === 0 ? 'BA2751' : null, fare: 90 + i
}));

/* FOURTEEN, not three. shortDisplay caps an address at about fifty characters,
   so an account journey reaches two lines and no more — it overruns a 30pt row
   by barely a point. A short invoice is handed up to 14pt of slack per row,
   which swallows that entirely and leaves this test passing against the bug.
   A fourteen-journey month gets no slack, and the point shows. */
test('ACCOUNT: a journey too long to shorten is clear of the next band', async () => {
  for (const n of [3, 9, 14]) {
    const ops = await draw(account(JOURNEYS(n)));
    for (let p = 1; p <= ops.page; p++) {
      const bad = overlaps(ops, p);
      assert.deepStrictEqual(bad, [], n + ' journeys, page ' + p +
        ' — text runs under a later band:\n      ' + bad.join('\n      '));
    }
  }
});

test('ACCOUNT: a wrapping journey makes its own row taller', async () => {
  const ops = await draw(account(JOURNEYS(14)));
  const cells = ops.texts.filter((t) => /→/.test(t.s));
  const wrapped = cells.filter((t) => t.h > 14);
  const single = cells.filter((t) => t.h <= 14);
  assert.ok(wrapped.length && single.length, 'the fixture needs both kinds: ' +
    wrapped.length + ' wrapped, ' + single.length + ' single');
  for (const w of wrapped) {
    const next = ops.texts.filter((t) => t.page === w.page && Math.abs(t.x - w.x) < 1 && t.top > w.top + 0.5)
                          .sort((a, b) => a.top - b.top)[0];
    if (next) assert.ok(next.top >= w.bottom - 0.5,
      'the next journey starts inside the wrapped one: ' + next.top.toFixed(1) + ' vs ' + w.bottom.toFixed(1));
  }
});

test('ACCOUNT: the FLIGHT tag sits under the journey, not through it', async () => {
  /* It used to be drawn at a fixed 21pt from the row top, which on a two-line
     journey printed it straight across the second line. */
  const ops = await draw(account(JOURNEYS(9)));
  const flights = ops.texts.filter((t) => /^FLIGHT /.test(t.s));
  assert.ok(flights.length, 'the fixture has no flight tags');
  for (const f of flights) {
    const journey = ops.texts.filter((t) => /→/.test(t.s) && t.page === f.page &&
                                            Math.abs(t.x - f.x) < 1 && t.top < f.top)
                             .sort((a, b) => b.top - a.top)[0];
    assert.ok(journey, 'a flight tag with no journey above it');
    assert.ok(f.top >= journey.bottom - 0.5,
      'the flight tag is drawn through the journey it belongs to: tag at ' +
      f.top.toFixed(1) + ', journey ends ' + journey.bottom.toFixed(1));
  }
});

test('the wrapping is real — the fixture would not test anything otherwise', async () => {
  /* A guard against the guard. If shortDisplay ever collapses these to one
     line, the two tests above still pass and stop meaning anything. */
  const ops = await draw(account([
    { date: '2026-08-03', ref: 'WPH-1001', time: '09:30', pickup: UNSHORTENABLE, destination: UNSHORTENABLE, fare: 95 }
  ]));
  const wrapped = ops.texts.filter((t) => t.h > 14 && /→/.test(t.s));
  assert.ok(wrapped.length >= 1, 'the account fixture must actually wrap, or it proves nothing');
  const ops2 = await draw(bespoke([{ date: '2026-08-03', description: LONG, amount: 95 }]));
  assert.ok(ops2.texts.some((t) => t.h > 14 && t.s.startsWith('Weppons')),
    'the bespoke fixture must actually wrap too');
});

// ── 2. THE BAND MATCHES THE ROW ──────────────────────────────────────────
console.log('\nThe zebra band is the height of its own row');

test('a tall row gets a tall band, a short row stays compact', async () => {
  const ops = await draw(bespoke([
    { date: '2026-08-03', description: 'Short one', amount: 10 },
    { date: '2026-08-07', description: LONGER, amount: 20 },      // banded (odd index), and tall
    { date: '2026-08-09', description: 'Short again', amount: 30 }
  ]));
  const bands = bandsOf(ops, 1);
  const tall = bands.filter((b) => b.h > 40);
  assert.ok(tall.length >= 1, 'the wrapped row must have a band taller than a one-line row: ' +
    bands.map((b) => b.h.toFixed(1)).join(', '));
  // and the band must cover the text it belongs to, not stop short of it
  const desc = ops.texts.find((t) => t.s === LONGER);
  const own = bands.find((b) => b.top <= desc.top + 0.5 && b.bottom >= desc.top);
  assert.ok(own, 'the wrapped description has no band around it');
  assert.ok(own.bottom >= desc.bottom - 0.5,
    'the band stops above the text it should be behind: band ends ' + own.bottom.toFixed(1) +
    ', text ends ' + desc.bottom.toFixed(1));
});

test('the amount and the date sit inside their own row', async () => {
  const ops = await draw(bespoke([
    { date: '2026-08-03', description: 'Short one', amount: 10 },
    { date: '2026-08-07', description: LONGER, amount: 20 }
  ]));
  const bands = bandsOf(ops, 1);
  const desc = ops.texts.find((t) => t.s === LONGER);
  const band = bands.find((b) => b.top <= desc.top + 0.5 && b.bottom >= desc.bottom - 0.5);
  assert.ok(band, 'the tall row has no band');
  const amount = ops.texts.find((t) => t.s === '£20.00');
  const date = ops.texts.find((t) => /7 August 2026/.test(t.s));
  for (const [what, t] of [['amount', amount], ['date', date]]) {
    assert.ok(t, what + ' is missing');
    assert.ok(t.top >= band.top - 0.5 && t.bottom <= band.bottom + 0.5,
      what + ' is outside its row: ' + t.top.toFixed(1) + '..' + t.bottom.toFixed(1) +
      ' vs band ' + band.top.toFixed(1) + '..' + band.bottom.toFixed(1));
  }
});

test('a one-line invoice is not made taller by the fix', async () => {
  const ops = await draw(bespoke([
    { date: '2026-08-03', description: 'Airport transfer', amount: 95 },
    { date: '2026-08-07', description: 'Airport transfer', amount: 95 }
  ]));
  const banded = bandsOf(ops, 1).filter((b) => b.h > 12 && b.h < 200);
  // header band is 22; the row band should stay near its natural height
  const rows = banded.filter((b) => Math.abs(b.h - 22) > 0.5);
  assert.ok(rows.length >= 1, 'no row band found');
  assert.ok(rows.every((b) => b.h < 60), 'short rows must stay compact: ' + rows.map((b) => b.h.toFixed(1)).join(', '));
});

// ── 3. IT STILL BREAKS PAGES CLEANLY ─────────────────────────────────────
console.log('\nLong invoices still break cleanly');

test('a long month of WRAPPING journeys breaks without colliding with the foot', async () => {
  const ops = await draw(account(JOURNEYS(22).map((b) => Object.assign(b, {
    pickup: UNSHORTENABLE, destination: UNSHORTENABLE }))));
  /* The break must fire on the row's REAL height. Checking a constant against
     the limit lets the last row on a page run past it — not off the paper, so
     the "past the foot" check below stays quiet, but into the space the footer
     is drawn in. */
  const BK_LIMIT = 841.89 - 52 - 18 - 34;
  const past = ops.texts.filter((t) => /→/.test(t.s) && t.bottom > BK_LIMIT + 2)
                        .map((t) => t.s.slice(0, 26) + ' ends ' + t.bottom.toFixed(1));
  assert.deepStrictEqual(past, [], 'a row was drawn past the table limit (' + BK_LIMIT.toFixed(1) +
    '): ' + past.join(' | '));
  assert.ok(ops.page > 1, 'twenty-two wrapping journeys must run to a second page');
  for (let p = 1; p <= ops.page; p++) {
    const bad = overlaps(ops, p);
    assert.deepStrictEqual(bad, [], 'page ' + p + ' has covered text:\n      ' + bad.join('\n      '));
  }
  /* Nothing may be drawn past the bottom margin — that is the "off the paper"
     failure the page break exists to prevent. */
  const PAGE_H = 841.89;
  const over = ops.texts.filter((t) => t.bottom > PAGE_H - 20)
                        .map((t) => t.s.slice(0, 30) + ' @' + t.bottom.toFixed(1));
  assert.deepStrictEqual(over, [], 'drawn past the foot of the page: ' + over.join(' | '));
});

test('ACCOUNT: every band is the full height of its own row', async () => {
  /* The band can be drawn short while the row still advances correctly — the
     text is not covered, but the shading stops half way down the row and the
     zebra stops lining up with anything. Checked separately because the
     overlap test cannot see it. */
  const ops = await draw(account(JOURNEYS(14)));
  for (let p = 1; p <= ops.page; p++) {
    for (const band of bandsOf(ops, p)) {
      const inside = ops.texts.filter((t) => t.page === p && t.top >= band.top - 0.5 && t.top < band.bottom - 0.5);
      for (const t of inside) {
        assert.ok(t.bottom <= band.bottom + 0.5,
          'the band is shorter than its own row: ' + t.s.slice(0, 34) + ' ends ' +
          t.bottom.toFixed(1) + ', band ends ' + band.bottom.toFixed(1));
      }
    }
  }
});

test('the page break is decided on the height the row is DRAWN at', async () => {
  /* Testing one row count proves nothing: a break decided on a constant fires
     late by exactly the difference, and whether that lands past the limit
     depends on where the rows happen to fall. Sweeping the counts means one of
     them lands badly, whichever way the arithmetic drifts. */
  const BK_LIMIT = 841.89 - 52 - 18 - 34;
  for (let n = 16; n <= 30; n++) {
    const ops = await draw(account(JOURNEYS(n).map((b) => Object.assign(b, {
      pickup: UNSHORTENABLE, destination: UNSHORTENABLE }))));
    const past = ops.texts.filter((t) => /→/.test(t.s) && t.bottom > BK_LIMIT + 2);
    assert.strictEqual(past.length, 0, n + ' journeys: a row runs past the table limit (' +
      BK_LIMIT.toFixed(1) + ') — deepest ' +
      Math.max(...ops.texts.filter((t) => /→/.test(t.s)).map((t) => t.bottom)).toFixed(1));
  }
});

/* Long enough that the row is FAR taller than its natural height — six lines
   against a natural thirty-six points. A break decided on the constant fires
   forty points late, which is the difference between "near the bottom" and
   "through the footer". A three-line description is only two points taller than
   the constant and proves nothing. */
const HUGE = 'Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN to London City Airport including ' +
  'parking at £11.50, one hour of waiting time at the terminal, a return leg the following morning ' +
  'from the same address, meet and greet at arrivals, and a child seat fitted for the outbound run ' +
  'as agreed with the account holder by telephone on the fourteenth of August.';

test('a bespoke invoice with many tall rows breaks too', async () => {
  const BSP_LIMIT = 841.89 - 52 - 18 - 34;
  /* Swept, not sampled — where a row lands depends on how tall the address
     block above the table is, so one row count proves very little.

     HONEST LIMIT: this sweep asserts the invariant (nothing is drawn past the
     table limit) but it does NOT currently distinguish a break decided on the
     row's real height from one decided on the constant. With rows this tall the
     row starts step in ~90pt jumps and never land in the window where the two
     answers differ. The invariant is the thing worth holding, and it will catch
     that mutation the day the row heights make it reachable. */
  const CASES = [[16, LONGER]];
  for (let n = 4; n <= 14; n++) CASES.push([n, HUGE]);
  for (const [n, desc] of CASES) {
    const items = Array.from({ length: n }, (_, i) => ({
      date: '2026-08-0' + (i % 9 + 1), description: desc, amount: 100 + i }));
    const ops = await draw(bespoke(items));
    // Four tall rows still fit one page; only the fuller invoices must break.
    if (n >= 9) assert.ok(ops.page > 1, n + ' tall descriptions must break to a second page');
    for (let p = 1; p <= ops.page; p++) {
      assert.deepStrictEqual(overlaps(ops, p), [], n + ' rows, page ' + p + ' has covered text');
    }
    const rows = ops.texts.filter((t) => t.s === desc);
    const past = rows.filter((t) => t.bottom > BSP_LIMIT + 2)
                     .map((t) => 'ends ' + t.bottom.toFixed(1));
    assert.deepStrictEqual(past, [], n + ' rows: drawn past the table limit (' +
      BSP_LIMIT.toFixed(1) + '): ' + past.join(', '));
    const off = ops.texts.filter((t) => t.bottom > 841.89 - 20);
    assert.strictEqual(off.length, 0, n + ' rows: drawn past the foot of the page');
  }
});

test('the totals block is still clear of the last row', async () => {
  const ops = await draw(bespoke([
    { date: '2026-08-03', description: LONGER, amount: 95 },
    { date: '2026-08-07', description: LONGER, amount: 120 }
  ]));
  const total = ops.texts.find((t) => /TOTAL DUE/i.test(t.s));
  assert.ok(total, 'the total is missing');
  // Same page only — a row on page one says nothing about a total on page two.
  const last = ops.texts.filter((t) => t.s === LONGER && t.page === total.page)
                        .sort((a, b) => b.bottom - a.bottom)[0];
  assert.ok(last, 'no table row on the total\'s page to compare against');
  assert.ok(total.top > last.bottom,
    'the total block overlaps the last row: total at ' + total.top.toFixed(1) +
    ', last row ends ' + last.bottom.toFixed(1));
});

// ── 4. IT IS MEASURED, NOT GUESSED ───────────────────────────────────────
console.log('\nThe height comes from the font, not a constant');

test('both tables measure the text before sizing the row', () => {
  const src = read('server/invoice-pdf.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/heightOfString/.test(src), 'nothing is measured at all');
  assert.strictEqual((src.match(/const measuredH =/g) || []).length, 1, 'one measurer');
  // the bespoke row and the account row must both use it
  const bespokeBlock = src.slice(src.indexOf('const items = data.items'), src.indexOf('} else {'));
  const accountBlock = src.slice(src.indexOf('const bookings = data.bookings'));
  assert.ok(/measuredH\(/.test(bespokeBlock), 'the bespoke row still uses a constant height');
  assert.ok(/measuredH\(/.test(accountBlock), 'the account row still uses a constant height');
  assert.ok(/Math\.max\(natural, needed\)/.test(bespokeBlock), 'bespoke: the row takes the larger of the two');
  assert.ok(/Math\.max\(BK_ROW_H, needed\)/.test(accountBlock), 'account: the row takes the larger of the two');
});

test('the template version moves when the layout does', () => {
  /* A cached PDF is keyed by the template version. Without a bump the fix ships
     and every invoice already on disk keeps serving the broken layout — which
     has happened here before. */
  const src = read('server/invoice-pdf.js');
  const m = /TEMPLATE_VERSION\s*=\s*(\d+)/.exec(src);
  assert.ok(m, 'TEMPLATE_VERSION is missing');
  assert.ok(+m[1] >= 5, 'the version must move when the layout does — got ' + m[1]);
  assert.ok(/row-fit/.test(src), 'and say what changed, so the next person can date a cached file');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-row-height\.test\.js/.test(read('package.json')), 'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e.message || e).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
