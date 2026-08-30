/**
 * THE INVOICE IS READABLE — run with:
 *   node server/tests/invoice-contrast.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The owner said his invoices were hard to read. He was right, and it was
 *   measurable: MUTED (#657485) came out at 4.78:1 on white and 4.37:1 on the
 *   zebra tint — under the 4.5 floor on the very rows it was used for. It
 *   carried the column headings, the FROM / BILL TO lines, and the reference
 *   and time on every journey row, so most of the small type on the page was
 *   the palest thing on it.
 *
 * WHAT IS MEASURED
 *   Not the constants — the RENDERED page. Every text draw is recorded with the
 *   fill colour in force at the time, and paired with what is actually behind
 *   it at that position: a tinted band, the header wash, or white paper. Then
 *   the WCAG contrast ratio of the two. A pale grey introduced anywhere in the
 *   drawing code fails this, whether or not it came from one of the named
 *   constants.
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

// ── WCAG 2.1 relative luminance and contrast ─────────────────────────────
const hex = (h) => String(h).replace('#', '').match(/../g).map((x) => parseInt(x, 16));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* The two thresholds that matter. 4.5 is the AA floor for body text and the
   line the old palette fell under; 7.0 is AAA, and what the owner asked for.
   Held at AAA because an invoice is read by somebody else's accounts
   department, on a printout, under whatever light they have. */
const AA = 4.5, AAA = 7.0;

/* Record every text draw with the colour in force, and every filled box, so a
   text can be matched to what is behind it. PDFKit takes the fill colour from
   fillColor(); vbox() paints with rect().fill(). */
function recorder() {
  const ops = { texts: [], rects: [], page: 1, docs: [] };
  const seen = (d) => { let i = ops.docs.indexOf(d); if (i < 0) { i = ops.docs.push(d) - 1; ops.page = 1; } return i; };
  const T = PDFDocument.prototype.text, R = PDFDocument.prototype.rect,
        F = PDFDocument.prototype.fill, C = PDFDocument.prototype.fillColor,
        A = PDFDocument.prototype.addPage;
  const cur = new Map();
  PDFDocument.prototype.fillColor = function (c) { if (typeof c === 'string') cur.set(this, c.toUpperCase()); return C.apply(this, arguments); };
  PDFDocument.prototype.fill = function (c) { if (typeof c === 'string' && ops.rects.length) ops.rects[ops.rects.length - 1].fill = c.toUpperCase(); return F.apply(this, arguments); };
  PDFDocument.prototype.rect = function (x, y, w, h) {
    ops.rects.push({ x, y, w, h, page: ops.page, doc: seen(this), top: y, bottom: y + h, fill: null });
    return R.apply(this, arguments);
  };
  PDFDocument.prototype.text = function (str, x, y, o) {
    o = o || {};
    const d = seen(this);
    if (typeof x === 'number' && typeof y === 'number' && String(str).trim()) {
      ops.texts.push({ s: String(str), x, y, page: ops.page, doc: d,
                       colour: cur.get(this) || '#000000', size: this._fontSize });
    }
    return T.apply(this, arguments);
  };
  PDFDocument.prototype.addPage = function () { ops.page++; return A.apply(this, arguments); };
  ops.restore = () => {
    PDFDocument.prototype.text = T; PDFDocument.prototype.rect = R;
    PDFDocument.prototype.fill = F; PDFDocument.prototype.fillColor = C;
    PDFDocument.prototype.addPage = A;
  };
  return ops;
}

async function draw(data) {
  const ops = recorder();
  try {
    delete require.cache[require.resolve('../invoice-pdf')];
    const { buildInvoicePdf } = require('../invoice-pdf');
    await buildInvoicePdf(data);
  } finally { ops.restore(); }
  const last = ops.docs.length - 1;          // the real pass, not the measuring probe
  ops.texts = ops.texts.filter((t) => t.doc === last);
  ops.rects = ops.rects.filter((r) => r.doc === last);
  return ops;
}

/** What is behind this text: a filled box it sits inside, else white paper. */
function backgroundOf(ops, t) {
  const box = ops.rects.filter((r) => r.page === t.page && r.fill &&
      t.x >= r.x - 1 && t.x <= r.x + r.w + 1 && t.y >= r.top - 1 && t.y <= r.bottom + 1)
    .sort((a, b) => (a.w * a.h) - (b.w * b.h))[0];   // the tightest box wins
  return box ? box.fill : '#FFFFFF';
}

const LONG = 'Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN - Gatwick Airport (parking £6.00)';
const U = 'Weppons Farm Chanctonbury Ring Road Wiston Steyning West Sussex England BN44 3DN United Kingdom';
const SETTINGS = { company_name: 'Westmere Private Hire', company_address: '1 High Street\nSteyning\nBN44 3AA',
                   bank_name: 'Example Bank', bank_sort_code: '00-00-00', bank_account_no: '00000000',
                   invoice_terms: 'Payment due within 14 days of the invoice date.' };
const PERIOD = { issuedDate: '2026-08-28', dueDate: '2026-09-11', label: 'August 2026' };
const BESPOKE = {
  invoiceNo: 'INV-202608-0003', kind: 'bespoke', total: 395, notes: 'Thank you for your business this month.',
  settings: SETTINGS,
  recipient: { name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000', address: '1 High Street\nSteyning\nBN44 3AA' },
  period: PERIOD,
  items: [{ date: '2026-08-03', description: LONG, amount: 95 },
          { date: '2026-08-07', description: 'Brighton Station - Heathrow Terminal 5', amount: 120 },
          { date: '2026-08-09', description: LONG, amount: 180 }]
};
const ACCOUNT = {
  invoiceNo: 'INV-202608-0004', kind: 'account', total: 900, notes: 'Thank you for your business this month.',
  settings: SETTINGS, customer: { full_name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000' },
  period: PERIOD,
  bookings: Array.from({ length: 9 }, (_, i) => ({
    date: '2026-08-0' + (i + 1), ref: 'WPH-40' + i, time: '09:30',
    pickup: i % 2 === 0 ? U : 'Brighton Station',
    destination: i % 3 === 0 ? U : 'Gatwick Airport',
    flight: i % 4 === 0 ? 'BA2751' : null, fare: 90 + i
  }))
};

/** Every text on the page, with what is behind it and the ratio between them. */
async function measured(data) {
  const ops = await draw(data);
  return ops.texts.map((t) => {
    const bg = backgroundOf(ops, t);
    return { s: t.s, colour: t.colour, bg, size: t.size, ratio: contrast(t.colour, bg) };
  });
}

// ── 1. THE PAGE, AS RENDERED ─────────────────────────────────────────────
console.log('\nEvery word on the page is readable where it sits');

for (const [name, data] of [['bespoke', BESPOKE], ['account', ACCOUNT]]) {
  test('the ' + name + ' invoice clears AA everywhere', async () => {
    const rows = await measured(data);
    assert.ok(rows.length > 20, 'nothing was measured — the recorder is broken');
    const bad = rows.filter((r) => r.ratio < AA)
      .map((r) => r.colour + ' on ' + r.bg + ' = ' + r.ratio.toFixed(2) + ':1  "' + r.s.slice(0, 34) + '"');
    assert.deepStrictEqual([...new Set(bad)], [], 'below the 4.5 floor:\n      ' + [...new Set(bad)].join('\n      '));
  });

  test('the ' + name + ' invoice clears AAA everywhere', async () => {
    /* What the owner actually asked for. Kept separate from the AA test so a
       future failure says which line was crossed. */
    const rows = await measured(data);
    const bad = rows.filter((r) => r.ratio < AAA)
      .map((r) => r.colour + ' on ' + r.bg + ' = ' + r.ratio.toFixed(2) + ':1  "' + r.s.slice(0, 34) + '"');
    assert.deepStrictEqual([...new Set(bad)], [], 'below 7:1:\n      ' + [...new Set(bad)].join('\n      '));
  });
}

test('the text ON THE ZEBRA ROWS is measured against the TINT, not white', async () => {
  /* The failure the owner reported was specifically on the shaded rows, and a
     guard that compared everything to white would have missed it entirely. */
  const rows = await measured(ACCOUNT);
  const onTint = rows.filter((r) => r.bg !== '#FFFFFF');
  assert.ok(onTint.length >= 4, 'no text was found sitting on a band — the pairing is wrong');
  assert.ok(onTint.some((r) => /→/.test(r.s)), 'the journey text should be among it');
  for (const r of onTint) {
    assert.ok(r.ratio >= AAA, 'on the tint: ' + r.colour + ' on ' + r.bg + ' = ' + r.ratio.toFixed(2) + ':1');
  }
});

// ── 2. THE PALETTE ITSELF ────────────────────────────────────────────────
console.log('\nThe palette, and the house it belongs to');

test('every named text colour clears AAA on white AND on the tint', () => {
  const src = read('server/invoice-pdf.js');
  const grab = (n) => (new RegExp('const ' + n + "\\s*=\\s*'(#[0-9a-fA-F]{6})'").exec(src) || [])[1];
  const TINT = grab('TINT');
  for (const n of ['NAVY', 'ACCENT', 'SOFT', 'MUTED']) {
    const c = grab(n);
    assert.ok(c, n + ' is missing');
    for (const bg of ['#FFFFFF', TINT, '#EEF2F5']) {
      const r = contrast(c, bg);
      assert.ok(r >= AAA, n + ' (' + c + ') is only ' + r.toFixed(2) + ':1 on ' + bg);
    }
  }
});

test('the greys really are darker than they were', () => {
  /* Pins the fix rather than the threshold. Someone re-lightening SOFT or MUTED
     to a value that happens to scrape 7:1 would still be undoing this. */
  const src = read('server/invoice-pdf.js');
  const grab = (n) => (new RegExp('const ' + n + "\\s*=\\s*'(#[0-9a-fA-F]{6})'").exec(src) || [])[1];
  assert.ok(lum(grab('SOFT')) < lum('#3B5268'), 'SOFT must be darker than the old #3B5268');
  assert.ok(lum(grab('MUTED')) < lum('#657485'), 'MUTED must be darker than the old #657485');
  assert.ok(lum(grab('MUTED')) < lum('#5A6875'), 'and not merely nudged');
});

test('the tint was NOT lightened away', () => {
  /* The other way to pass a contrast test is to bleach the background until
     the zebra does nothing. The banding is what makes a long month readable. */
  const src = read('server/invoice-pdf.js');
  const TINT = (/const TINT\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(src) || [])[1];
  const vsWhite = contrast(TINT, '#FFFFFF');
  assert.ok(vsWhite > 1.03, 'the tint has been washed out to ' + vsWhite.toFixed(3) + ':1 against white — the rows no longer band');
  assert.ok(vsWhite < 1.20, 'and it must stay a wash, not a block');
});

test('still navy, still no gold and no cream', () => {
  /* The house rule from DESIGN.md, restated here because this file changes
     colours: a contrast fix must not become a re-skin. */
  const src = read('server/invoice-pdf.js');
  const hexes = (src.match(/'#[0-9a-fA-F]{6}'/g) || []).map((h) => h.replace(/'/g, ''));
  for (const h of hexes) {
    const [r, g, b] = hex(h);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const warm = r >= g && g > b && (max - min) > 24;   // the cream/gold hue band
    assert.ok(!warm, 'a warm colour crept into the invoice palette: ' + h);
  }
  assert.ok(/#102a43/i.test(src), 'the navy must still be the house navy');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-contrast\.test\.js/.test(read('package.json')), 'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e.message || e).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
