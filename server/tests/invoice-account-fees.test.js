/**
 * THE ACCOUNT INVOICE SHOWS THE TOLL IT CHARGED — run with:
 *   node server/tests/invoice-account-fees.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   POST /customers/:id/invoice built the same bookings TWICE. One mapping
 *   split the all-in fare into the ride and the pass-throughs — £122 becomes
 *   £115 + £7 — and that one was stored. The other, `lineItemsForPdf`, was
 *   `{date, time, ref, pickup, destination, flight, fare}` and nothing else,
 *   and THAT is what was handed to the renderer.
 *
 *   So the PDF made at creation — the one cached, the one emailed to the
 *   account customer, the one filed — printed an empty FEE column and the
 *   all-in £122 in the FARE column. Only a later re-render, which reads the
 *   stored lines, was right. The document on file and the document the customer
 *   received disagreed with the one the owner downloaded.
 *
 * WHAT IS GUARDED
 *   The PDF is RENDERED and its draw calls recorded with their coordinates.
 *   Asserting that a "£7.00" appears somewhere in the file would pass on a
 *   toll printed in the fare column, which is the very mistake this invoice
 *   exists to stop — so each figure is checked against the column it lands in.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-acct-fees-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-acct-fees-'));
process.env.INVOICES_DIR = CACHE;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });
const api = require('../api');
const invoicePdf = require('../invoice-pdf');

/* ── THE DRAWING, RECORDED ────────────────────────────────────────────────
   PDFKit compresses its content streams, so a finished file cannot be grepped
   for "£7.00" — and the interesting question is not whether the string exists
   but WHICH COLUMN it was put in. */
function recorder() {
  const PDFDocument = require('pdfkit');
  const ops = { texts: [], docs: [] };
  const seen = (d) => { let i = ops.docs.indexOf(d); if (i === -1) { ops.docs.push(d); i = ops.docs.length - 1; } return i; };
  const T = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str, x, y, o) {
    const d = seen(this);
    if (typeof x === 'number' && typeof y === 'number') {
      ops.texts.push({ s: String(str), x, y, doc: d });
    }
    return T.apply(this, arguments);
  };
  ops.restore = () => { PDFDocument.prototype.text = T; };
  ops.lastDoc = () => {
    const last = ops.docs.length - 1;
    return ops.texts.filter((t) => t.doc === last);
  };
  return ops;
}
/** The x of a column, found by where its heading was drawn. */
function colX(texts, heading) {
  const h = texts.find((t) => t.s === heading);
  assert.ok(h, 'the ' + heading + ' heading was never drawn — the table has changed shape');
  return h.x;
}
const inCol = (texts, x, s) => texts.some((t) => Math.abs(t.x - x) < 1 && t.s === s);

// ── a customer on account, and two months of work ────────────────────────
db.prepare("INSERT INTO customers (full_name, email, password, active) VALUES (?,?,?,1)")
  .run('APD Private Hire', 'accounts@apd.example.com', 'x');
const CID = db.prepare('SELECT id FROM customers ORDER BY id DESC LIMIT 1').get().id;
const insert = db.prepare(`INSERT INTO bookings
  (ref, customer_id, pickup, destination, date, time, passengers, fare, payment, status,
   base_fare, airport_fee, toll_fee, flight)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/* SEPTEMBER — booked after the split shipped, so the parts were kept.
   £122 all-in is £115 of driving and £7 of Dartford; £85 is £75 and a £10
   terminal charge. */
insert.run('WPH-9A01', CID, 'Billingshurst', 'London Heathrow Airport, Terminal 2',
           '2026-09-03', '09:00', 2, 122, 'account', 'completed', 115, 0, 7, 'BA2751');
insert.run('WPH-9A02', CID, 'Wiston', 'London Gatwick Airport, South Terminal',
           '2026-09-13', '06:15', 2, 85, 'account', 'completed', 75, 10, 0, null);
/* AUGUST — booked before it, so there is nothing to split and never will be. */
insert.run('WPH-8A01', CID, 'Billingshurst', 'London Heathrow Airport, Terminal 2',
           '2026-08-03', '09:00', 2, 122, 'account', 'completed', null, null, null, null);

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
/** Raise a real invoice through the real route, recording what it draws. */
async function raise(from, to) {
  const l = api.stack.find((x) => x.route && x.route.path === '/customers/:id/invoice' && x.route.methods.post);
  assert.ok(l, 'POST /customers/:id/invoice is gone');
  const ops = recorder();
  const r = res();
  try {
    const req = { params: { id: String(CID) }, query: {}, ip: '::1',
                  auth: { role: 'owner', id: 1, type: 'user' },
                  body: { from, to, send_email: false } };
    const hs = l.route.stack.map((s) => s.handle);
    let i = 0;
    const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
    await next();
  } finally { ops.restore(); }
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const no = r.body.invoiceNo;
  return { no, row: db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(no),
           texts: ops.lastDoc() };
}

// ── 1. THE COLUMN THE OWNER ASKED FOR ────────────────────────────────────
console.log('\nEach journey prints its own toll, beside its ride');

let SEPT = null;
test('the created PDF puts the toll in FEE and the ride in FARE', async () => {
  SEPT = await raise('2026-09-01', '2026-09-30');
  const t = SEPT.texts;
  const feeX = colX(t, 'FEE'), fareX = colX(t, 'FARE');
  assert.ok(feeX < fareX, 'the fee column must sit to the LEFT of the fare');

  assert.ok(inCol(t, feeX, '£7.00'), 'the 3 Sep Dartford toll is not in the FEE column');
  assert.ok(inCol(t, feeX, '£10.00'), 'the 13 Sep terminal charge is not in the FEE column');
  assert.ok(inCol(t, fareX, '£115.00'), 'the 3 Sep RIDE is not in the FARE column');
  assert.ok(inCol(t, fareX, '£75.00'), 'the 13 Sep RIDE is not in the FARE column');

  /* THE ALL-IN FARE MUST BE GONE FROM THE LINE. £122 in the fare column is the
     toll folded back in — the whole fault this invoice was rebuilt to end. */
  assert.ok(!inCol(t, fareX, '£122.00'), 'the all-in £122 is still being billed as the fare');
  assert.ok(!inCol(t, fareX, '£85.00'), 'the all-in £85 is still being billed as the fare');
  /* And a toll must never be drawn in the fare column. */
  assert.ok(!inCol(t, fareX, '£7.00') && !inCol(t, fareX, '£10.00'),
    'a toll was drawn in the FARE column');
});

test('the document names the fees above the total', () => {
  const said = SEPT.texts.map((x) => x.s);
  assert.ok(said.some((s) => /^Fees/.test(s)),
    'no fees line: ' + JSON.stringify(said.filter((s) => /£/.test(s))));
  assert.ok(said.indexOf('£17.00') !== -1, 'the £17 of pass-throughs is never totalled');
  assert.ok(said.indexOf('£207.00') !== -1, 'the total is missing');
});

// ── 2. THE MONEY DID NOT MOVE ────────────────────────────────────────────
console.log('\nSplitting the fare re-labels it; it does not re-price it');

test('fares + fees is exactly what the customer was always billed', () => {
  const items = JSON.parse(SEPT.row.line_items_json);
  const fares = items.reduce((t, i) => t + (+i.fare || 0), 0);
  const fees = items.reduce((t, i) => t + (+i.fee || 0), 0);
  assert.strictEqual(fares, 190, 'the rides');
  assert.strictEqual(fees, 17, 'the pass-throughs');
  assert.strictEqual(SEPT.row.total, 207, 'and the total is the all-in sum, unchanged');
  assert.strictEqual(Math.round((fares + fees) * 100) / 100, SEPT.row.total,
    'fares + fees must reconcile to the total, or the split re-priced the invoice');
});

test('the fees are STORED, so every later render says the same thing', () => {
  assert.strictEqual(SEPT.row.fees, 17,
    '`fees` was never written on an account invoice, so the fees line could not '
    + 'print on any re-render however many tolls the trips carried');
});

// ── 3. ONE DOCUMENT, NOT TWO ─────────────────────────────────────────────
console.log('\nThe emailed copy and the downloaded copy are the same document');

test('the created PDF and the re-render from the stored row agree', async () => {
  /* The download rebuilds from `line_items_json`. It was always right; the
     created one was not, which is how the customer's copy and the owner's copy
     came to disagree. Both are rendered here and compared figure by figure. */
  const ops = recorder();
  try {
    await invoicePdf.buildInvoicePdf(invoicePdf.invoiceDataFromRow(SEPT.row, {}));
  } finally { ops.restore(); }
  const download = ops.lastDoc();
  const money = (ts) => ts.map((x) => x.s).filter((s) => /^£[\d,]+\.\d\d$/.test(s)).sort();
  assert.deepStrictEqual(money(download), money(SEPT.texts),
    'the document created and the document downloaded show different figures');
});

// ── 4. THE OLD BOOKINGS STILL WORK ───────────────────────────────────────
console.log('\nA journey booked before the split still invoices cleanly');

test('a pre-split booking bills its all-in fare and shows no fee', async () => {
  /* Nothing can recover a toll that was never stored. Such a line must bill the
     whole figure with an empty fee — not a £0.00, and not a crash. */
  const aug = await raise('2026-08-01', '2026-08-31');
  const items = JSON.parse(aug.row.line_items_json);
  assert.deepStrictEqual(items.map((i) => i.fee), [0], 'a pre-split line has no fee to show');
  assert.deepStrictEqual(items.map((i) => i.fare), [122], 'and bills the all-in fare');
  assert.strictEqual(aug.row.total, 122);
  assert.strictEqual(aug.row.fees, 0);
  const fareX = colX(aug.texts, 'FARE'), feeX = colX(aug.texts, 'FEE');
  assert.ok(inCol(aug.texts, fareX, '£122.00'), 'the all-in fare must still be billed');
  assert.ok(!aug.texts.some((t) => Math.abs(t.x - feeX) < 1 && /^£/.test(t.s)),
    'a trip that carried nothing must print nothing in the fee column, not £0.00');
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
