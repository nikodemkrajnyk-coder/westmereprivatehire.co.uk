/**
 * EVERY WAY AN INVOICE REACHES SOMEBODY —
 *   node server/tests/invoice-paths.test.js   (also gated by `npm test`)
 *
 * The invoice was redesigned and the owner still saw the old one. Two reasons,
 * both of which this file exists to keep fixed:
 *
 *   THERE WAS MORE THAN ONE TEMPLATE. "Print" and "Review" never rendered the
 *   PDF at all — the owner app and the admin app each carried a COMPLETE second
 *   invoice, written in HTML, built from the same data. Redesigning the PDF did
 *   nothing to either. Two templates for one document will always drift; these
 *   had drifted by an entire redesign. Both are deleted, and every path now
 *   opens the generated PDF.
 *
 *   THE CACHE OUTLIVED THE TEMPLATE. Generated PDFs are written to the volume
 *   and served back on request, keyed by invoice number alone — which is not a
 *   key for a document whose appearance can change. Every invoice made before
 *   the redesign kept downloading in the old design. The key now carries
 *   TEMPLATE_VERSION, so a redesign orphans old files instead of serving them.
 *
 * And the white screen: window.open() on a URL that answers with
 * Content-Disposition: attachment leaves an empty tab behind. That is the whole
 * bug. Download is a link click now; Print asks for the same bytes inline.
 *
 * Builds REAL PDFs from REAL row shapes — account and bespoke, with bank
 * details and without. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const INDEX = read('server/index.js');
const API   = read('server/api.js');
const PDFSRC = read('server/invoice-pdf.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/* A scratch invoices directory, so the cache behaviour can be exercised for
   real without touching the deploy volume or the developer's data/. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-inv-'));
process.env.INVOICES_DIR = TMP;
const PDF = require('../invoice-pdf');

const SETTINGS_NO_BANK = {
  business_name: 'Westmere Private Hire', owner_name: 'Nikodem Krajnyk',
  address_line1: '4 Fisher Street', address_line2: 'Lewes, East Sussex', postcode: 'BN7 2DG',
  phone: '07930 342593', email: 'bookings@westmereprivatehire.co.uk'
};
const SETTINGS_BANK = Object.assign({}, SETTINGS_NO_BANK, {
  bank_name: 'Monzo', account_name: 'N Krajnyk', sort_code: '00-00-00', account_no: '00000000'
});

/* Rows in the shape the invoices TABLE actually stores them — line_items_json
   as a string, nullable columns really null. Hand-built `data` objects were
   what let three routes each get this subtly different. */
const ACCOUNT_ROW = {
  invoice_no: 'INV-202608-0101', kind: 'account', total: 115,
  notes: null, issued_date: '2026-08-26', due_date: '2026-09-09', period_label: 'August 2026',
  recipient_name: 'The Grand Hotel Brighton', recipient_email: 'a@b.co', recipient_phone: '01273 224300',
  line_items_json: JSON.stringify([
    { ref: 'WPH-4871', date: '2026-08-03', time: '05:30', pickup: 'Brighton', destination: 'Gatwick Airport', fare: 75, flight: 'BA2751' },
    { ref: 'WPH-4903', date: '2026-08-18', time: '19:10', pickup: 'Brighton', destination: 'Lewes', fare: 40, flight: '' }
  ])
};
const BESPOKE_ROW = {
  invoice_no: 'INV-202608-0102', kind: 'bespoke', total: 250,
  notes: 'Payment due within 14 days.', issued_date: '2026-08-26', due_date: '2026-09-09', period_label: null,
  recipient_name: 'Echopoint Medical Ltd', recipient_email: 'p@e.co', recipient_phone: '+44 7545 700837',
  recipient_addr: '65-69 East Road\nHackney, London N1 6AH',
  line_items_json: JSON.stringify([{ description: 'Private hire journey — Pulborough to Hackney', amount: 250 }])
};

/** A stand-in for the settings lookup the resolver does. */
const fakeDb = (settings) => ({
  prepare: () => ({ get: () => (settings ? { value: JSON.stringify(settings) } : null) })
});

const PDFDocument = require('pdfkit');
async function textOf(buf, data) {
  const seen = [];
  const orig = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (s) { seen.push(String(s)); return orig.apply(this, arguments); };
  try { await PDF.buildInvoicePdf(data); } finally { PDFDocument.prototype.text = orig; }
  return seen.join(' | ');
}

console.log('\nOne template, not three');

test('the owner app no longer draws its own invoice', () => {
  assert.ok(OWNER.indexOf('function openInvoicePreview(') === -1,
    'the duplicate HTML invoice must be gone from westmere-owner.html');
  /* The tells of that template, checked individually: it is the thing that kept
     showing after the PDF was redesigned. */
  assert.ok(OWNER.indexOf('Est. Sussex') === -1, 'the old corner mark is gone');
  assert.ok(OWNER.indexOf('class="inv-badge"') === -1, 'and the old invoice badge');
  assert.ok(OWNER.indexOf('Print / Save as PDF') === -1, 'and its print toolbar');
});

test('the admin app no longer draws its own invoice either', () => {
  assert.ok(ADMIN.indexOf('function openInvoicePreview(') === -1,
    'admin-parity: the second staff app carried the same duplicate');
  assert.ok(ADMIN.indexOf('Est. Sussex') === -1);
  assert.ok(ADMIN.indexOf('class="inv-badge"') === -1);
});

test('Print / Preview opens the PDF, asked for inline', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/function invOpenPdf\(invoiceId\)/.test(src), name + ': invOpenPdf is missing');
    assert.ok(/_invPdfUrl\(invoiceId,\s*true\)/.test(src),
      name + ': preview must request inline, or the browser downloads it instead of showing it');
    assert.ok(/inline=1/.test(src), name + ': the inline flag must be on the URL');
  }
});

test('the server honours inline vs attachment', () => {
  assert.ok(/req\.query\.inline === '1'/.test(INDEX), 'the route must read the flag');
  assert.ok(/\(inline \? 'inline' : 'attachment'\)/.test(INDEX),
    'and switch Content-Disposition on it — same bytes, shown or saved');
});

console.log('\nThe blank tab');

test('the only window.open asks for the document INLINE', () => {
  /* This is the whole white-screen bug: window.open on a URL that answers with
     Content-Disposition: attachment leaves an empty tab behind. Downloading is
     the anchor's job (below); window.open is for viewing, and a viewable
     response must be inline. */
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const opens = src.match(/window\.open\(_invPdfUrl\([^)]*\)/g) || [];
    assert.ok(opens.length >= 1, name + ': invOpenPdf must open the PDF');
    for (const o of opens) {
      assert.ok(/,\s*true\)/.test(o), name + ': opened without inline — ' + o);
    }
  }
});

test('the detail sheet\'s Download PDF is a real download, not a new tab', () => {
  const anchor = /<a id="inv-det-pdf-btn"[^>]*>/.exec(OWNER);
  assert.ok(anchor, 'the button is missing');
  assert.ok(/\bdownload\b/.test(anchor[0]), 'it must carry the download attribute');
  assert.ok(!/target="_blank"/.test(anchor[0]),
    'target=_blank on an attachment is the same blank tab by another route');
});

console.log('\nThe cache cannot outlive the template');

test('the template declares a version, and the cache key carries it', () => {
  assert.ok(/const TEMPLATE_VERSION = \d+;/.test(PDFSRC), 'TEMPLATE_VERSION must exist');
  assert.ok(PDF.TEMPLATE_VERSION >= 3, 'the redesign is version 3 or later');
  const p = PDF.invoiceCachePath('INV-202608-0101');
  assert.ok(p.indexOf('.v' + PDF.TEMPLATE_VERSION + '.pdf') !== -1,
    'the cached filename must name the template that drew it: ' + p);
});

test('a file written by an OLDER template is never served', async () => {
  const stale = path.join(TMP, 'INV-202608-0101.pdf');            // the old, unversioned name
  fs.writeFileSync(stale, Buffer.from('%PDF-1.3\nOLD DESIGN\n%%EOF\n'));
  const buf = await PDF.resolveInvoicePdf(fakeDb(SETTINGS_BANK), ACCOUNT_ROW);
  assert.ok(buf.length > 5000, 'a real invoice, not the 26-byte stale file: ' + buf.length);
  assert.ok(buf.toString('latin1').indexOf('OLD DESIGN') === -1, 'the stale file must not be served');
  assert.ok(fs.existsSync(PDF.invoiceCachePath('INV-202608-0101')), 'and the new one is cached');
});

test('a truncated or empty cache file is rebuilt, not served', async () => {
  const p = PDF.invoiceCachePath('INV-202608-0102');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(0));
  const buf = await PDF.resolveInvoicePdf(fakeDb(SETTINGS_BANK), BESPOKE_ROW);
  assert.ok(buf.length > 5000, 'an empty cache file downloads as a broken document: ' + buf.length);
});

test('deleting an invoice removes EVERY rendering of it', () => {
  const no = 'INV-202608-0199';
  const files = [
    path.join(TMP, no + '.pdf'),
    path.join(TMP, no + '.v2.pdf'),
    PDF.invoiceCachePath(no)
  ];
  files.forEach(f => fs.writeFileSync(f, 'x'));
  const found = PDF.invoiceCachePaths(no);
  for (const f of files) {
    assert.ok(found.indexOf(f) !== -1, 'delete would have left this behind: ' + path.basename(f));
  }
  assert.ok(/invoiceCachePaths\(row\.invoice_no\)/.test(API) && /invoiceCachePaths\(invoiceNo\)/.test(API),
    'both delete routes must use it');
});

test('invoices live in ONE place, agreed by every file', () => {
  assert.ok(/function invoiceCacheDir\(\)/.test(PDFSRC), 'one definition');
  assert.ok(/const \{ invoiceCacheDir \} = require\('\.\/invoice-pdf'\)/.test(API),
    'api.js must not derive its own — it used to compute a different directory from the DB path, ' +
    'which agreed with the other one only on the deploy box');
  assert.ok(!/const INVOICES_DIR = path\.join\(DATA_DIR/.test(API), 'the second definition is gone');
});

console.log('\nEvery route serves the real thing');

test('all three download routes go through the one resolver', () => {
  assert.ok(/resolveInvoicePdf\(db, row\)/.test(INDEX), 'the public download');
  const staff = API.slice(API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/resolveInvoicePdf\(db, row\)/.test(staff), 'the staff download');
  const cust = API.slice(API.indexOf("router.get('/customer/invoices/:id/pdf'"), API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/resolveInvoicePdf\(db, row\)/.test(cust), "the customer's own download");
  assert.ok(!/That invoice PDF is not available yet/.test(API),
    'the customer route used to 404 and tell them to ring the office when the cache was cold');
});

test('the response is a PDF, with headers that do not lie', () => {
  assert.ok(/setHeader\('Content-Type', 'application\/pdf'\)/.test(INDEX),
    "application/octet-stream made every browser download it, even the preview");
  assert.ok(/Cache-Control', 'private, no-cache, must-revalidate'/.test(INDEX),
    'a document whose template can change must not be held by a proxy');
});

test('a generation failure never returns a blank page', () => {
  assert.ok(/function page\(status, heading, detail\)/.test(INDEX), 'the error page helper must exist');
  assert.ok(/We could not produce that invoice/.test(INDEX), 'and say so in words');
  assert.ok(/07930/.test(INDEX), 'with a way to reach a human');
  assert.ok(!/res\.status\(500\)\.send\('Failed to generate PDF'\)/.test(INDEX),
    'a bare 500 string in a new tab is the white screen by another name');
  assert.ok(/if \(!buf \|\| !buf\.length\) throw/.test(PDFSRC),
    'an empty buffer must be an error, not a zero-byte download');
});

console.log('\nThe real thing, on real data');

for (const [label, row, settings] of [
  ['account, with bank details',   ACCOUNT_ROW, SETTINGS_BANK],
  ['account, no bank details',     ACCOUNT_ROW, SETTINGS_NO_BANK],
  ['bespoke, with bank details',   BESPOKE_ROW, SETTINGS_BANK],
  ['bespoke, no bank details',     BESPOKE_ROW, SETTINGS_NO_BANK]
]) {
  test('renders the NEW design — ' + label, async () => {
    const data = PDF.invoiceDataFromRow(row, settings);
    const buf = await PDF.buildInvoicePdf(data);
    assert.ok(buf.length > 5000, 'a real document: ' + buf.length + ' bytes');
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
    const t = await textOf(buf, data);
    assert.ok(/WESTMERE/.test(t) && /PRIVATE HIRE · SUSSEX/.test(t), 'the new masthead');
    assert.ok(/TOTAL DUE/.test(t), 'the framed total');
    assert.ok(!/VAT \(/.test(t), 'no VAT line');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(t), 'no raw ISO date reaches the page');
    if (row.kind === 'account') assert.ok(/Mon 3 Aug 2026/.test(t), 'human dates');
    const wantsBank = !!(settings.sort_code && settings.account_no);
    assert.strictEqual(/PAYMENT DETAILS/.test(t), wantsBank,
      wantsBank ? 'the bank block must appear when configured' : 'and must not when it is not');
  });
}

test('the fields a production row really can be missing do not throw', async () => {
  const thin = {
    invoice_no: 'INV-202608-0103', kind: 'bespoke', total: 55,
    notes: null, issued_date: '2026-08-02', due_date: null, period_label: null,
    recipient_name: 'APD Private Hire', recipient_email: null, recipient_phone: null, recipient_addr: null,
    line_items_json: null                                   // nullable, and it happens
  };
  const buf = await PDF.buildInvoicePdf(PDF.invoiceDataFromRow(thin, SETTINGS_BANK));
  assert.ok(buf.length > 5000, 'must still produce a document');
  const t = await textOf(buf, PDF.invoiceDataFromRow(thin, SETTINGS_BANK));
  assert.ok(!/Invalid Date|NaN|undefined|null/.test(t), 'and nothing broken on the page');
});

test('a corrupt line_items_json degrades instead of throwing', async () => {
  const bad = Object.assign({}, BESPOKE_ROW, { line_items_json: '{not json' });
  const buf = await PDF.buildInvoicePdf(PDF.invoiceDataFromRow(bad, SETTINGS_BANK));
  assert.ok(buf.length > 5000, 'one bad column must not cost the whole invoice');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-paths\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
