/**
 * CORRECTING A SAVED INVOICE — run with:
 *   node server/tests/invoice-edit.test.js   (also gated by `npm test`)
 *
 * WHAT WAS TRUE BEFORE
 *   An invoice was immutable. There were routes to create, list, read,
 *   download, send, mark paid and delete — and no route to change one. A wrong
 *   figure meant deleting the invoice and issuing a new number, which is
 *   exactly what an accounts department that has already filed the first one
 *   should never receive.
 *
 * THE TWO THINGS MOST LIKELY TO GO WRONG
 *   1. A CORRECTED INVOICE SERVING A STALE PDF. The cache was keyed on the
 *      invoice number and template version — both unchanged by an edit — so the
 *      corrected document would have downloaded as the old one. This repo has
 *      shipped that failure twice already by forgetting a version bump; the key
 *      is a content hash now so there is nothing to forget.
 *   2. THE AUTO-SUM EATING A MANUAL TOTAL. The owner sets a figure by hand,
 *      then corrects a typo in an address, and the total silently reverts to
 *      the sum of the lines. The override is a stored flag, not a coincidence.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-invoice-edit-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-inv-cache-'));
process.env.INVOICES_DIR = CACHE;   // the name the module actually reads

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
const invoicePdf = require('../invoice-pdf');

let SENT = [];
global.fetch = async (u, o) => { SENT.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

// ── The route, driven directly ───────────────────────────────────────────
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
const api = require('../api');
function layerFor(method, routePath) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  return l;
}
async function call(method, routePath, { params, body, role }) {
  const handlers = layerFor(method, routePath).route.stack.map((s) => s.handle);
  const req = { params: params || {}, body: body || {}, query: {},
                auth: { role: role || 'owner', id: 1, type: 'user' }, ip: '::1' };
  const r = res();
  let i = 0;
  const next = async () => { if (i < handlers.length) await handlers[i++](req, r, next); };
  await next();
  return r;
}

let n = 0;
function seed(kind, items, extra) {
  const no = 'INV-202608-' + String(++n).padStart(4, '0');
  const total = items.reduce((s, it) => s + (kind === 'bespoke' ? +it.amount : +it.fare), 0);
  db.prepare(`INSERT INTO invoices (invoice_no, kind, recipient_name, recipient_email, recipient_phone,
              recipient_addr, issued_date, due_date, period_label, notes, line_items_json, total, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    no, kind, 'APD Private Hire', 'accounts@apd.example.com', '07700 900000',
    '1 High Street\nSteyning\nBN44 3AA', '2026-08-28', '2026-09-11', 'August 2026',
    (extra && extra.notes) || 'Thank you.', JSON.stringify(items), total);
  return db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(no);
}
const BESPOKE_ITEMS = [
  { date: '2026-08-03', description: 'Brighton to Gatwick', amount: 95 },
  { date: '2026-08-07', description: 'Hove to Heathrow T5', amount: 120 }
];
const ACCOUNT_ITEMS = [
  { date: '2026-08-03', ref: 'WPH-1001', time: '09:30', pickup: 'Brighton Station', destination: 'Gatwick Airport', fare: 95 },
  { date: '2026-08-07', ref: 'WPH-1002', time: '06:15', pickup: 'Hove Town Hall', destination: 'Heathrow T5', fare: 120 }
];
const rowOf = (id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
/* A real month: five journeys, the longest route this business actually runs. */
const BUSY_MONTH = [
  { date: '2026-08-03', ref: 'WPH-4001', time: '09:30', pickup: 'Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN', destination: 'London Gatwick Airport, South Terminal', flight: 'BA2751', fare: 95 },
  { date: '2026-08-07', ref: 'WPH-4002', time: '06:15', pickup: 'Brighton Station', destination: 'Heathrow Airport, Terminal 5', fare: 120 },
  { date: '2026-08-14', ref: 'WPH-4003', time: '14:00', pickup: 'Hove Town Hall', destination: 'London City Airport', fare: 180 },
  { date: '2026-08-21', ref: 'WPH-4004', time: '11:45', pickup: 'Lewes, East Sussex', destination: 'Southampton Cruise Terminal', fare: 165 },
  { date: '2026-08-27', ref: 'WPH-4005', time: '05:00', pickup: 'Steyning', destination: 'Stansted Airport', flight: 'FR1042', fare: 210 }
];
const itemsOf = (id) => JSON.parse(rowOf(id).line_items_json || '[]');

// ── 1. THE EDIT ITSELF ───────────────────────────────────────────────────
console.log('\nAn invoice can be corrected, and keeps its number');

test('the route exists at all — it did not before', () => {
  assert.doesNotThrow(() => layerFor('patch', '/invoices/:id'),
    'PATCH /invoices/:id is the whole feature');
});

test('editing updates the stored fields and keeps the same number', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    recipient_name: 'APD Private Hire Ltd', recipient_email: 'billing@apd.example.com',
    recipient_addr: '2 Church Street\nSteyning', issued_date: '2026-08-29', due_date: '2026-09-12',
    notes: 'Corrected: August parking added.',
    line_items: [{ date: '2026-08-03', description: 'Brighton to Gatwick (incl. parking)', amount: 101 },
                 { date: '2026-08-07', description: 'Hove to Heathrow T5', amount: 120 }]
  }});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(inv.id);
  assert.strictEqual(after.invoice_no, inv.invoice_no, 'the number must not move — it is a correction');
  assert.strictEqual(after.recipient_name, 'APD Private Hire Ltd');
  assert.strictEqual(after.recipient_email, 'billing@apd.example.com');
  assert.strictEqual(after.issued_date, '2026-08-29');
  assert.strictEqual(after.due_date, '2026-09-12');
  assert.ok(/parking added/.test(after.notes));
  assert.strictEqual(itemsOf(inv.id)[0].description, 'Brighton to Gatwick (incl. parking)');
  assert.strictEqual(after.total, 221, 'and the total follows the lines: 101 + 120');
  assert.ok(after.revised_at, 'the correction is dated');
});

test('lines can be added and removed', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [{ description: 'One line only', amount: 50 },
                 { description: 'And a new one', amount: 25 },
                 { description: 'And another', amount: 25 }] }});
  assert.strictEqual(itemsOf(inv.id).length, 3);
  assert.strictEqual(rowOf(inv.id).total, 100);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [{ description: 'One line only', amount: 50 }] }});
  assert.strictEqual(itemsOf(inv.id).length, 1);
  assert.strictEqual(rowOf(inv.id).total, 50, 'removing a line takes its money with it');
});

test('an ACCOUNT line keeps its journey shape', async () => {
  /* Flattening a journey to a description would empty the JOURNEY column on
     the PDF — the row would still be there, with nothing in it. */
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: ACCOUNT_ITEMS.map((it, i) => Object.assign({}, it, { amount: i === 0 ? 111 : it.fare })) }});
  const items = itemsOf(inv.id);
  assert.strictEqual(items[0].pickup, 'Brighton Station', 'the route survives the edit');
  assert.strictEqual(items[0].destination, 'Gatwick Airport');
  assert.strictEqual(items[0].ref, 'WPH-1001');
  assert.strictEqual(items[0].fare, 111, 'and the amount is written back to fare, which is what the PDF reads');
  assert.strictEqual(rowOf(inv.id).total, 231);
});

test('identity cannot be edited — number, kind, customer', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    invoice_no: 'INV-HACKED-0001', kind: 'account', customer_id: 999, id: 12345 }});
  const after = rowOf(inv.id);
  assert.strictEqual(after.invoice_no, inv.invoice_no, 'the number is the document');
  assert.strictEqual(after.kind, 'bespoke', 'and so is the kind');
  assert.strictEqual(after.customer_id, inv.customer_id, 'an edit must not re-point it at another customer');
});

// ── 2. THE MANUAL TOTAL ──────────────────────────────────────────────────
console.log('\nThe total can be taken over by hand, and stays taken over');

test('a manual total is stored, flagged, and shown', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);       // lines sum to 215
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { total_override: 200 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the figure he typed');
  assert.strictEqual(after.total_manual, 1, 'and the fact that he typed it');
  assert.strictEqual(r.body.autoSum, 215, 'the response still reports what the lines say');
});

test('THE ONE THAT MATTERS: a later edit does not put the auto-sum back', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  // an ordinary correction that says nothing about the total
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { recipient_phone: '07700 900999', notes: 'Address corrected.' } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the override survives an unrelated edit');
  assert.strictEqual(after.total_manual, 1);
  // and editing the LINES does not disturb it either
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'Just the one now', amount: 10 }] } });
  assert.strictEqual(rowOf(inv.id).total, 200, 'nor does changing the lines under it');
});

test('the override can be handed back to the lines', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: null } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total_manual, 0, 'the flag comes down');
  assert.strictEqual(after.total, 215, 'and the sum takes over again');
});

test('without an override the total tracks the lines', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'a', amount: 12.5 }, { description: 'b', amount: 7.25 }] } });
  assert.strictEqual(rowOf(inv.id).total, 19.75);
  assert.strictEqual(rowOf(inv.id).total_manual, 0);
});

test('a nonsense total is refused, and changes nothing', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  for (const bad of ['abc', -5, 99999999]) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: bad } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad) + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).total, 215, 'the invoice is untouched by a refused edit');
});

test('the manual total reaches the PDF', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  const data = invoicePdf.invoiceDataFromRow(rowOf(inv.id), {});
  assert.strictEqual(data.total, 200, 'the document shows the figure he set, not the sum of its lines');
});

test('the EMAIL quotes the same total as the PDF it carries', async () => {
  /* Found by rendering it, not by reading it. The email built its own total by
     adding the line items up, so a manually corrected invoice went out quoting
     £401 with a £375 document attached — one invoice disagreeing with itself
     inside one message. */
  const inv = seed('bespoke', BESPOKE_ITEMS);                 // lines sum to 215
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  const row = rowOf(inv.id);
  const email = require('../email');
  const items = JSON.parse(row.line_items_json);
  SENT = [];
  await email.sendBespokeInvoice(
    { name: row.recipient_name, email: row.recipient_email, phone: '', address: '' },
    items, { label: row.period_label, dueDate: row.due_date, issuedDate: row.issued_date,
             notes: row.notes, total: row.total },
    row.invoice_no, { company_name: 'Westmere Private Hire' }, Buffer.from('%PDF-1.3 x'));
  const m = SENT[0];
  assert.ok(m, 'nothing was sent');
  assert.ok(/£200\.00/.test(m.subject), 'the subject must quote the corrected total: ' + m.subject);
  assert.ok(!/£215\.00/.test(m.subject), 'and never the superseded sum: ' + m.subject);
  assert.ok(/£200\.00/.test(m.html), 'the body too');
  const bodyTotals = (m.html.match(/£215\.00/g) || []);
  assert.deepStrictEqual(bodyTotals, [], 'the auto-sum must not appear as a total in the body');
});

test('the send ROUTE hands the stored total to the email', () => {
  /* The guard above proves the email honours a total when given one; this
     proves the caller gives it. Both halves, or the fix is only half wired. */
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const route = src.slice(src.indexOf("router.post('/invoices/:id/send'"));
  const period = route.slice(route.indexOf('const period = {'), route.indexOf('};', route.indexOf('const period = {')));
  assert.ok(/total: row\.total/.test(period),
    'the send route must pass the stored total, or the email falls back to summing the lines');
});

// ── 2b. FEES ─────────────────────────────────────────────────────────────
console.log('\nFees — parking, tolls, waiting time');

/* Read the totals block back out of the drawing. The fees row is a label and a
   figure above the total, and "the number is somewhere in the PDF" is not the
   claim being made — the claim is that it is rendered, labelled, and added up. */
async function drawn(row) {
  const PDFDocument = require('pdfkit');
  const texts = [];
  const T = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str, x, y) {
    if (typeof x === 'number' && typeof y === 'number' && String(str).trim()) texts.push({ s: String(str), x, y });
    return T.apply(this, arguments);
  };
  try { await invoicePdf.buildInvoicePdf(invoicePdf.invoiceDataFromRow(row, {})); }
  finally { PDFDocument.prototype.text = T; }
  return texts;
}

/* The same recording, plus the page count and each text's real height — for
   the questions that are about the SHAPE of the table rather than its words. */
async function drawnOps(row) {
  const PDFDocument = require('pdfkit');
  const ops = { texts: [], page: 1, docs: [] };
  const seen = (d) => { let i = ops.docs.indexOf(d); if (i < 0) { i = ops.docs.push(d) - 1; ops.page = 1; } return i; };
  const T = PDFDocument.prototype.text, A = PDFDocument.prototype.addPage;
  PDFDocument.prototype.text = function (str, x, y, o) {
    o = o || {};
    const d = seen(this);
    if (typeof x === 'number' && typeof y === 'number' && String(str).trim()) {
      let h = 0;
      try { h = this.heightOfString(String(str), { width: o.width || 300 }); } catch (_) {}
      ops.texts.push({ s: String(str), x, y, h, page: ops.page, doc: d });
    }
    return T.apply(this, arguments);
  };
  PDFDocument.prototype.addPage = function () { ops.page++; return A.apply(this, arguments); };
  try { await invoicePdf.buildInvoicePdf(invoicePdf.invoiceDataFromRow(row, {})); }
  finally { PDFDocument.prototype.text = T; PDFDocument.prototype.addPage = A; }
  // buildInvoicePdf draws twice — a measuring probe, then the real document.
  const last = ops.docs.length - 1;
  ops.texts = ops.texts.filter((t) => t.doc === last);
  ops.page = ops.texts.reduce((m, t) => Math.max(m, t.page), 1);
  return ops;
}
const labelFor = (texts, label) => {
  const l = texts.filter((t) => t.s === label).sort((a, b) => b.y - a.y)[0];
  if (!l) return null;
  // the money sits on the same baseline, to the right
  const v = texts.filter((t) => Math.abs(t.y - l.y) < 2 && t.x > l.x && /^£/.test(t.s))[0];
  return v ? v.s : null;
};

/* TWO WAYS IN, ONE NUMBER OUT.
   A BESPOKE invoice has one fee for the whole document, typed once. An ACCOUNT
   invoice's fee is the sum of what was paid out on each trip, typed beside each
   journey's fare — the owner wanted each trip to show what it carried. They are
   not two mechanisms that both add to the total: on an account invoice the
   stored `fees` is DERIVED from the rows and a directly-supplied figure is
   ignored, so no arrangement of the two can bill the same parking twice. */
test('BESPOKE: one fee for the document, typed once', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);            // lines sum to 215
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 18.5, fees_label: 'Parking & tolls' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 18.5);
  assert.strictEqual(after.fees_label, 'Parking & tolls');
  assert.strictEqual(after.total, 233.5, '215 + 18.50');
  const texts = await drawn(after);
  assert.strictEqual(labelFor(texts, 'Parking & tolls'), '£18.50', 'the fees row is not on the page');
  assert.strictEqual(labelFor(texts, 'Subtotal'), null, 'and still no subtotal lead-in');
  assert.ok(texts.some((t) => t.s === '£233.50'), 'the total is the sum of the two');
});

test('ACCOUNT: each trip shows the fee paid on it', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);            // two journeys, 95 + 120
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }),
                 Object.assign({}, ACCOUNT_ITEMS[1], { fee: 8.5 })] }});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const items = itemsOf(inv.id);
  assert.strictEqual(items[0].fee, 10, "the fee rides on the trip it was paid on");
  assert.strictEqual(items[1].fee, 8.5);
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 18.5, 'and the invoice fee is the sum of them');
  assert.strictEqual(after.total, 233.5, '215 of fares + 18.50 of fees');
  assert.strictEqual(r.body.perTripFees, 18.5);
  assert.strictEqual(r.body.feesDerived, true, 'the response says where the figure came from');

  /* On the page: a FEE column, each row carrying its own figure. */
  const texts = await drawn(after);
  assert.ok(texts.some((t) => t.s === 'FEE'), 'the table needs a FEE heading');
  assert.ok(texts.some((t) => t.s === '£10.00'), "the first trip's fee");
  assert.ok(texts.some((t) => t.s === '£8.50'), "the second trip's fee");
  assert.ok(texts.some((t) => t.s === '£233.50'), 'and the total includes them');
});

test('ACCOUNT: NO DOUBLE COUNTING — a directly-set fee is ignored', async () => {
  /* The failure this design exists to make impossible. If both the per-trip
     fees and a typed invoice fee could reach the total, a month with £18.50 of
     parking on its rows and £18.50 in the box would bill £37. */
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }),
                 Object.assign({}, ACCOUNT_ITEMS[1], { fee: 8.5 })],
    fees: 18.5, fees_label: 'Typed as well' }});
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 18.5, 'the rows decide, and they say 18.50 — not 37');
  assert.strictEqual(after.total, 233.5, 'the parking must be charged once');
});

test('ACCOUNT: the fee LABEL is derived too, not the caller\'s to set', async () => {
  /* Found by posting a hostile request during the deploy check: the fee AMOUNT
     was correctly ignored on an account invoice while a posted LABEL went
     straight onto the customer's document. Both halves are derived now. */
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }), ACCOUNT_ITEMS[1]],
    fees: 999, fees_label: 'ANYTHING I LIKE' }});
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 10, 'the amount comes from the rows');
  assert.strictEqual(after.fees_label, 'Fees (parking & tolls)',
    'and so does the label: ' + after.fees_label);
  const texts = await drawn(after);
  assert.ok(!texts.some((t) => /ANYTHING I LIKE/.test(t.s)),
    'nothing a caller posts may appear on the customer\'s invoice');
});

test('BESPOKE: the label IS the owner\'s to set', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 12, fees_label: 'Waiting time' } });
  assert.strictEqual(rowOf(inv.id).fees_label, 'Waiting time');
});

test('ACCOUNT: a trip with no fee shows none', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }),
                 Object.assign({}, ACCOUNT_ITEMS[1], { fee: 0 })] }});
  const texts = await drawn(rowOf(inv.id));
  assert.ok(texts.some((t) => t.s === '£10.00'), 'the trip that carried one still shows it');
  const zeros = texts.filter((t) => t.s === '£0.00');
  assert.deepStrictEqual(zeros, [], 'a fee-free trip must print nothing, not £0.00');
  assert.strictEqual(rowOf(inv.id).fees, 10);
});

test('ACCOUNT: no fees anywhere and the column is empty, the row absent', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  const texts = await drawn(rowOf(inv.id));
  assert.ok(texts.some((t) => t.s === 'FEE'), 'the heading stays — the column is part of the table');
  assert.strictEqual(labelFor(texts, 'Fees (parking & tolls)'), null, 'but no totals row');
  assert.strictEqual(labelFor(texts, 'Subtotal'), null);
  assert.ok(texts.some((t) => t.s === '£215.00'), 'just the total');
});

test('the per-trip fee survives an unrelated edit', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }), ACCOUNT_ITEMS[1]] }});
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { notes: 'Address corrected.' } });
  assert.strictEqual(itemsOf(inv.id)[0].fee, 10, 'an edit that says nothing about fees must not drop them');
  assert.strictEqual(rowOf(inv.id).fees, 10);
});

test('a manual total still wins over the per-trip fees', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }),
                 Object.assign({}, ACCOUNT_ITEMS[1], { fee: 8.5 })],
    total_override: 200 }});
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the figure he set');
  assert.strictEqual(after.fees, 18.5, 'and the rows still show what was paid out');
  const texts = await drawn(after);
  assert.ok(texts.some((t) => t.s === '£200.00'), 'the invoice shows the override');
  assert.ok(texts.some((t) => t.s === '£10.00'), 'with the per-trip fees still on their rows');
});

test('a corrected per-trip fee does not serve a stale PDF', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  const before = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [Object.assign({}, ACCOUNT_ITEMS[0], { fee: 10 }), ACCOUNT_ITEMS[1]] }});
  assert.notStrictEqual(before, invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)),
    'the fee is part of the line items, which are part of the content hash');
});

test('an unlabelled fee still says what it is', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { fees: 9 } });
  const texts = await drawn(rowOf(inv.id));
  assert.strictEqual(labelFor(texts, 'Fees'), '£9.00', 'with no label it falls back to "Fees"');
});

test('clearing the fees takes the row away and the money with it', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 18.5, fees_label: 'Parking & tolls' } });
  assert.strictEqual(rowOf(inv.id).total, 233.5);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { fees: 0 } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 0);
  assert.strictEqual(after.fees_label, null, 'a label with no fee to explain is dropped');
  assert.strictEqual(after.total, 215, 'and the total comes back down');
  assert.strictEqual(labelFor(await drawn(after), 'Parking & tolls'), null);
});

test('A MANUAL TOTAL STILL WINS, fees or no fees', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 18.5, fees_label: 'Parking & tolls', total_override: 200 } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the override beats lines + fees (which come to 233.50)');
  assert.strictEqual(after.total_manual, 1);
  assert.strictEqual(after.fees, 18.5, 'and the fees are still recorded and still shown');
  const texts = await drawn(after);
  assert.strictEqual(labelFor(texts, 'Parking & tolls'), '£18.50');
  assert.ok(texts.some((t) => t.s === '£200.00'), 'the total is the figure he set');
  // and a later fee change must not quietly reinstate the sum
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { fees: 40 } });
  assert.strictEqual(rowOf(inv.id).total, 200, 'changing the fees under an override does not lift it');
});

test('fees survive an unrelated edit, and reach a re-send', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 18.5, fees_label: 'Parking & tolls' } });
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { recipient_phone: '07700 900999' } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 18.5, 'an address correction must not drop the fees');
  assert.strictEqual(after.total, 233.5);

  const email = require('../email');
  SENT = [];
  await email.sendBespokeInvoice(
    { name: after.recipient_name, email: after.recipient_email, phone: '', address: '' },
    JSON.parse(after.line_items_json),
    { label: after.period_label, dueDate: after.due_date, issuedDate: after.issued_date,
      notes: after.notes, total: after.total },
    after.invoice_no, { company_name: 'Westmere Private Hire' }, Buffer.from('%PDF-1.3 x'));
  assert.ok(/£233\.50/.test(SENT[0].subject), 'the re-sent email quotes the total INCLUDING fees: ' + SENT[0].subject);
});

test('a nonsense fee is refused and changes nothing', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  for (const bad of ['abc', -1, 99999999]) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { fees: bad } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad) + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).fees, 0);
  assert.strictEqual(rowOf(inv.id).total, 215);
});

test('adding fees changes the cache key — even when the TOTAL does not move', async () => {
  /* The obvious version of this test passes for the wrong reason: adding fees
     also changes the total, and the total was already in the hash. Pinning the
     total by hand first isolates the fees as the only field that differs, so
     this actually tests what it claims to. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 500 } });
  const before = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 18.5, fees_label: 'Parking & tolls' } });
  const mid = rowOf(inv.id);
  assert.strictEqual(mid.total, 500, 'the total is deliberately unchanged for this test');
  const after = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.notStrictEqual(before, after,
    'the fees row changed the page but not the total — the cache key must still have moved');

  // and the label alone must count too
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { fees_label: 'Waiting time' } });
  assert.notStrictEqual(after, invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)),
    'renaming the fees row changes what is printed, so it must change the key');
});

test('the edit sheet has a fees field that feeds the total', () => {
  const H = read('westmere-owner.html');
  assert.ok(/id="inv-edit-fees"/.test(H) && /id="inv-edit-fees-label"/.test(H), 'no fees field');
  const sum = /function invEditAutoSum\(\)\{[\s\S]*?\n\}/.exec(H)[0].replace(/\s/g, '');
  /* fares − commission + fees, the same arithmetic the invoice does. The fees
     half is what this test was written for; the commission joined it when the
     rate became adjustable, and the screen has to agree with the document on
     both or the owner is looking at a number nobody will be billed. */
  assert.ok(/invEditLineSum\(\)-invEditCommission\(\)\+invEditFees\(\)/.test(sum),
    'the on-screen total must be fares − commission + fees: ' + sum);
  const save = /async function invEditSave\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/fees: invEditFees\(\)/.test(save) && /fees_label:/.test(save), 'the save must send them');
});

// ── 3. NO STALE PDF ──────────────────────────────────────────────────────
console.log('\nA corrected invoice does not serve the old document');

test('the cache key changes when the content does', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const before = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'Corrected line', amount: 999 }] } });
  const after = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.notStrictEqual(before, after, 'an edited invoice must not resolve to the same cached file');
  assert.ok(after.includes(invoicePdf.invoiceSafeNo ? '' : ''), '');
  assert.ok(/INV-202608-\d{4}\.v\d+\.[0-9a-f]{10}\.pdf$/.test(after),
    'the name carries the template version AND a content hash: ' + path.basename(after));
});

test('and the same content resolves to the same file', () => {
  /* A key that changed on every call would rebuild the PDF for every download
     — correct output, and a cache that does nothing. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const a = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  const b = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.strictEqual(a, b);
});

test('the REBUILT pdf really contains the correction', async () => {
  /* The end of the chain, rendered rather than assumed: edit, resolve, and
     read the total back out of the drawing. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const first = await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.ok(first && first.length > 1000, 'no first PDF');
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 12345.67 } });
  const second = await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.notStrictEqual(first.length + ':' + first.slice(0, 400).toString('latin1'),
                        second.length + ':' + second.slice(0, 400).toString('latin1'),
                        'the corrected invoice came back byte-identical to the old one');
  const data = invoicePdf.invoiceDataFromRow(rowOf(inv.id), {});
  assert.strictEqual(data.total, 12345.67);
});

test('a cached file written before the edit is never reused', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  const stale = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.ok(fs.existsSync(stale), 'the first render should have been cached');
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 777 } });
  const fresh = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.notStrictEqual(stale, fresh);
  await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.ok(fs.existsSync(fresh), 'the corrected render is cached under its own name');
  /* Both files exist; what matters is which one the resolver asks for. */
  assert.strictEqual(invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)), fresh);
});

test('deleting an invoice still takes every cached rendering with it', () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const paths = invoicePdf.invoiceCachePaths(inv.invoice_no);
  const dir = path.dirname(invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)));
  const safe = inv.invoice_no.replace(/[^A-Za-z0-9\-_]/g, '');
  for (const name of [safe + '.pdf', safe + '.v4.pdf', safe + '.v6.abc1234567.pdf']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
  const again = invoicePdf.invoiceCachePaths(inv.invoice_no).map((p) => path.basename(p));
  for (const name of [safe + '.pdf', safe + '.v4.pdf', safe + '.v6.abc1234567.pdf']) {
    assert.ok(again.includes(name), 'deletion would leave ' + name + ' downloadable');
  }
  void paths;
});

// ── 4. WHO MAY DO IT ─────────────────────────────────────────────────────
console.log('\nOwner and admin only');

test('a driver and a customer are refused', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  for (const role of ['driver', 'customer']) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { total_override: 1 }, role });
    assert.strictEqual(r.statusCode, 403, role + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).total, 215, 'and nothing was changed by the attempt');
});

test('owner and admin may', async () => {
  for (const role of ['owner', 'admin']) {
    const inv = seed('bespoke', BESPOKE_ITEMS);
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { total_override: 5 }, role });
    assert.strictEqual(r.statusCode, 200, role + ' → ' + JSON.stringify(r.body));
  }
});

test('a missing invoice is a 404, not a crash', async () => {
  const r = await call('patch', '/invoices/:id', { params: { id: '999999' }, body: { total_override: 1 } });
  assert.strictEqual(r.statusCode, 404);
});

test('the correction is written to the audit log', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 250 } });
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'invoice_edited' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log, 'nothing was logged');
  assert.ok(log.detail.includes(inv.invoice_no), 'the log must name the invoice: ' + log.detail);
  assert.ok(/£215\.00 → £250\.00/.test(log.detail), 'and what changed: ' + log.detail);
  assert.ok(/set by hand/.test(log.detail), 'and that it was set by hand: ' + log.detail);
});

// ── 5. THE OWNER APP ─────────────────────────────────────────────────────
console.log('\nThe screen the owner uses');

test('there is an Edit control, and it opens the sheet', () => {
  const H = read('westmere-owner.html');
  assert.ok(/onclick="invEditOpen\(\)"/.test(H), 'no Edit button');
  assert.ok(/id="inv-edit-sheet"/.test(H), 'no edit sheet');
  for (const id of ['inv-edit-name', 'inv-edit-email', 'inv-edit-addr', 'inv-edit-issued',
                    'inv-edit-due', 'inv-edit-notes', 'inv-edit-lines', 'inv-edit-total', 'inv-edit-manual']) {
    assert.ok(new RegExp('id="' + id + '"').test(H), 'the sheet has no ' + id);
  }
});

test('it PATCHes the same invoice rather than creating one', () => {
  const H = read('westmere-owner.html');
  const fn = /async function invEditSave\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/method:'PATCH'/.test(fn), 'a correction must not POST a new invoice');
  assert.ok(/\/api\/invoices\/'\+st\.inv\.id/.test(fn), 'and it must address the invoice by id');
  assert.ok(/total_override: manual \? typed : null/.test(fn),
    'the override is sent as a number or an explicit null — never omitted, or it could not be cleared');
});

test('the number is shown and not editable', () => {
  const H = read('westmere-owner.html');
  const sheet = H.slice(H.indexOf('id="inv-edit-sheet"'), H.indexOf('New Booking Form Sheet'));
  assert.ok(/id="inv-edit-no"/.test(sheet), 'the number should be visible — it is how it is matched');
  assert.ok(!/<input[^>]*id="inv-edit-no"/.test(sheet), 'but not an input');
});

test('the owner is told when a total was set by hand', () => {
  const H = read('westmere-owner.html');
  assert.ok(/id="inv-det-manual"/.test(H), 'the detail sheet has no override note');
  assert.ok(/the lines may not sum to it/i.test(H), 'and it must say why that matters');
  const sync = /function invEditSyncTotal\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  /* The wording moved when fees arrived — it now names the split (lines, then
     fees) rather than just "the lines". What must hold is that the figure he
     is overriding is stated, whatever it is made of. */
  assert.ok(/The invoice adds up to/.test(sync), 'the edit screen names the sum he is overriding');
  assert.ok(/fees £/.test(sync), 'and says how much of it is fees');
  assert.ok(/f\.disabled=!manual/.test(sync), 'and the field is locked while the lines own it');
});

test('the fee field sits BESIDE the total, not in a section of its own', () => {
  /* The owner asked for it "next to fare". They are the two money figures on
     the sheet and they are read together — the fee is the reason the total is
     not what the lines add up to. A guard on the arrangement, because a later
     tidy-up that moves the fee back into its own box undoes the thing he
     asked for and nothing else would notice. */
  const H = read('westmere-owner.html');
  /* The two AMOUNTS are what must sit together — those are the money. The
     fee's LABEL is words and gets its own full-width line below them; it was
     squeezed between the two number fields at first and rendered as "Park" on
     a phone, which is no use to somebody checking what he typed. */
  const start = H.indexOf('id="inv-edit-fees"');
  const end = H.indexOf('id="inv-edit-total"');
  assert.ok(start > 0 && end > 0, 'both amount fields must exist');
  assert.ok(end > start, 'the fee amount comes first, then the total');
  assert.ok(H.indexOf('id="inv-edit-fees-label"') > end,
    'the label belongs below the amounts, with room to read it');
  const between = H.slice(start, end);
  /* Same box. A bordered <div> between them is a new panel — a bordered
     <input> is just a field, which is why this looks for the tag and not for
     the word "border". The first version of this assertion did the latter and
     failed on the fee input's own outline. */
  assert.ok(!/<div[^>]*border:\s*1px solid/.test(between),
    'a panel opens between the fee and the total — they are in separate boxes again');
  assert.ok(between.length < 1400,
    'the two fields have drifted apart (' + between.length + ' chars between them)');
  assert.ok(/id="inv-edit-fees"/.test(between), 'the fee amount belongs with its label');
});

test('the fee is a field on the invoice, never a line item', () => {
  /* A line prints inside the journey table, and "Parking & tolls" is not a
     journey. It is stored on the invoice row and drawn in the totals area. */
  const H = read('westmere-owner.html');
  const save = /async function invEditSave\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/fees:/.test(save) && /fees_label:/.test(save), 'the save must send both');
  assert.ok(!/line_items[\s\S]{0,200}Parking/.test(save), 'and never smuggle it into the lines');
});

test('adding the FEE column did not push the foot matter onto a second page', async () => {
  /* It did, the first time. A fee column has to come out of somewhere, and
     taking it all from the journey made the longest routes wrap; with rows
     sized to their contents that grew the table enough to send the notes and
     the bank details to page two. Caught by rendering it and counting pages,
     not by any assertion that existed. */
  const inv = seed('account', BUSY_MONTH);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: BUSY_MONTH.map((b, i) => Object.assign({}, b, { fee: [10, 7, 14.2, 0, 13.5][i] })) } });
  const ops = await drawnOps(rowOf(inv.id));
  assert.strictEqual(ops.page, 1,
    'a five-journey month with fees must still fit one page — it went to ' + ops.page);
  const journeys = ops.texts.filter((t) => /→/.test(t.s));
  const wrapped = journeys.filter((t) => t.h > 14).map((t) => t.s);
  assert.deepStrictEqual(wrapped, [],
    'the journey column is too narrow — these wrapped: ' + wrapped.join(' | '));
});

// ── THE OPERATOR COMMISSION ──────────────────────────────────────────────
console.log('\nAn invoice to another operator, with commission deducted');

/* THE ARRANGEMENT: fares − commission + fees, and the commission is ten per
   cent of the FARES only. The owner pays the parking and the tolls at the
   barrier; taking a tenth of those would be charging commission on his own
   outlay. Same rule as the driver side, other end of the deal. */
const OP_TRIPS = [
  { date: '2026-08-04', ref: 'WPH-3001', time: '05:30', pickup: 'Weppons Farm, Wiston BN44 3DN', destination: 'Gatwick Airport', fare: 95, fee: 7 },
  { date: '2026-08-09', ref: 'WPH-3002', time: '11:00', pickup: 'Steyning', destination: 'Heathrow Airport, Terminal 5', fare: 120, fee: 7 },
  { date: '2026-08-15', ref: 'WPH-3003', time: '06:45', pickup: 'Lewes', destination: 'Gatwick Airport', fare: 98.50, fee: 13 }
];   // fares 313.50, fees 27.00, commission 31.35, total 309.15

test('commission is 10% of the FARES and never of the fees', async () => {
  const inv = seed('account', OP_TRIPS);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lineSum, 313.50, 'the fares');
  assert.strictEqual(r.body.fees, 27, 'the fees, from the rows');
  assert.strictEqual(r.body.commission, 31.35, '10% of 313.50 — NOT of 340.50');
  assert.notStrictEqual(r.body.commission, 34.05, 'that would be a tenth of the fees as well');
});

test('total = fares − commission + fees', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10 } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 309.15, '313.50 − 31.35 + 27.00');
  assert.strictEqual(after.commission_pct, 10);
  // the fees really are passed through whole
  assert.strictEqual(Math.round((after.total - (313.50 - 31.35)) * 100) / 100, 27,
    'the fees reach the operator undiminished');
});

test('THE AMOUNT RENDERS — it is never blank', async () => {
  /* The complaint that started this: a "Less 10% commission" line with nothing
     beside it. That one was the invoice's NOTES text, which has no amount by
     definition. This is a real line with a real figure, computed from the
     fares on the page. */
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10 } });
  const texts = await drawn(rowOf(inv.id));
  const label = texts.find((t) => /^Less 10% commission$/.test(t.s));
  assert.ok(label, 'the commission line is missing entirely');
  const amount = texts.find((t) => Math.abs(t.y - label.y) < 2 && /\d/.test(t.s) && t !== label);
  assert.ok(amount, 'the commission line has NO amount beside it — the original bug');
  assert.strictEqual(amount.s, '\u2212\u00a331.35', 'and it reads as a deduction: ' + amount.s);
});

test('all four steps are named, in order', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10 } });
  const texts = await drawn(rowOf(inv.id));
  const at = (re) => { const t = texts.find((x) => re.test(x.s)); return t ? t.y : null; };
  const fares = at(/^Fares \(jobs\)$/), fees = at(/^Fees \(parking & tolls\)$/),
        comm = at(/^Less 10% commission$/), total = at(/^TOTAL DUE$/);
  for (const [n, v] of [['Fares (jobs)', fares], ['Fees', fees], ['Less 10% commission', comm], ['TOTAL DUE', total]]) {
    assert.ok(v !== null, n + ' is not on the page');
  }
  assert.ok(fares < fees && fees < comm && comm < total,
    'an accounts team reads down: fares, fees, commission, total — got ' +
    [fares, fees, comm, total].map((v) => v && v.toFixed(0)).join(' → '));
  assert.ok(texts.some((t) => t.s === '£313.50'), 'the fares figure');
  assert.ok(texts.some((t) => t.s === '£27.00'), 'the fees figure');
  assert.ok(texts.some((t) => t.s === '£309.15'), 'and the total');
});

test('no commission set and the invoice looks exactly as it did', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { line_items: OP_TRIPS } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.commission_pct, 0);
  assert.strictEqual(after.total, 340.50, 'fares + fees, as before');
  const texts = await drawn(after);
  assert.strictEqual(texts.filter((t) => /commission/i.test(t.s)).length, 0, 'no commission line');
  assert.strictEqual(texts.filter((t) => /^Fares \(jobs\)$/.test(t.s)).length, 0,
    'and no Fares lead-in either — with nothing deducted it says nothing new');
});

test('a manual total still wins over the whole arrangement', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10, total_override: 250 } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 250, 'the figure he set');
  assert.strictEqual(after.commission_pct, 10, 'and the breakdown still shows');
  const texts = await drawn(after);
  assert.ok(texts.some((t) => t.s === '£250.00'), 'the invoice shows the override');
  assert.ok(texts.some((t) => t.s === '\u2212\u00a331.35'), 'with the commission line still on it');
});

test('the commission comes from the ROWS, never from a hand-set total', async () => {
  /* A percentage of whatever the owner happened to type is not a commission. */
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: OP_TRIPS, commission_pct: 10, total_override: 9999 } });
  const texts = await drawn(rowOf(inv.id));
  assert.ok(texts.some((t) => t.s === '\u2212\u00a331.35'),
    'still a tenth of the fares, not of the 9999');
});

test('a nonsense rate is refused and nothing changes', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: 10 } });
  for (const bad of ['abc', -1, 100, 250]) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: bad } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad) + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).commission_pct, 10, 'the invoice is untouched by a refused edit');
});

test('a corrected commission does not serve a stale PDF', async () => {
  const inv = seed('account', OP_TRIPS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: 10 } });
  const before = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: 12.5 } });
  assert.notStrictEqual(before, invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)));
});

// ── THE FORM: OPERATOR OR ORDINARY CUSTOMER ──────────────────────────────
console.log('\nOne form, two kinds of invoice');

test('commission OFF is the default, and leaves no trace anywhere', async () => {
  /* Most invoices go to a customer, and a customer is not owed a commission.
     Off must mean genuinely absent — not a zero line, not a Fares lead-in. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 12, fees_label: 'Parking' } });
  assert.strictEqual(r.statusCode, 200);
  const after = rowOf(inv.id);
  assert.strictEqual(after.commission_pct, 0, 'nothing is set unless it is asked for');
  assert.strictEqual(after.total, 227, '215 fares + 12 fees — no deduction');
  const texts = await drawn(after);
  assert.strictEqual(texts.filter((t) => /commission/i.test(t.s)).length, 0,
    'the word must not appear at all on a customer invoice');
  assert.strictEqual(texts.filter((t) => /^Fares \(jobs\)$/.test(t.s)).length, 0,
    'nor the Fares lead-in, which only earns its place above a deduction');
  assert.ok(texts.some((t) => t.s === '£227.00'), 'just fares + fees');
});

test('the form defaults the toggle to OFF and posts the choice', () => {
  const H = read('westmere-owner.html');
  const box = /<input id="ni-commission"[^>]*>/.exec(H);
  assert.ok(box, 'the toggle is missing from the create form');
  assert.ok(!/\bchecked\b/.test(box[0]), 'it must not be ticked by default: ' + box[0]);
  assert.ok(/Leave off for a normal customer or business invoice/.test(H),
    'and it must say plainly what off means');
  const build = H.slice(H.indexOf("return{url:'/api/invoices/bespoke'") - 400, H.indexOf("return{url:'/api/invoices/bespoke'") + 400);
  assert.ok(/commissionPct=\(cb&&cb\.checked\)\?invCommissionPct\(\):0/.test(build.replace(/\s/g, '')),
    'the choice — and the RATE he typed — must reach the request');
  assert.ok(/commission_pct:commissionPct/.test(build.replace(/\s/g, '')), 'as commission_pct');
});

test('A CREATED INVOICE IS ACTUALLY SAVED', async () => {
  /* SHIPPED BROKEN ONCE. The persist is wrapped in a try/catch that logs and
     carries on, so when the INSERT's column list and its values fell out of
     step the invoice still rendered, still emailed, and simply never appeared
     in the list — "[INVOICE] persist bespoke failed: Too many parameter values
     were provided" in a log nobody was reading. Every source-shape guard in
     this file was green. Only creating one and looking for it afterwards
     catches that. */
  const before = db.prepare("SELECT COUNT(*) c FROM invoices").get().c;
  const r = await call('post', '/invoices/bespoke', { body: {
    recipient: { name: 'Harbourside Events Ltd', email: 'accounts@harbourside.example.com', phone: '07700 900321', address: '12 Marine Parade' },
    items: [{ date: '2026-08-05', description: 'Weppons Farm → Gatwick', amount: 95, fee: 10,
              pickup: 'Weppons Farm, Wiston, BN44 3DN, United Kingdom',
              destination: 'Gatwick Airport, South Terminal, RH6 0NP, United Kingdom' },
            { date: '2026-08-12', description: 'Lewes → Brighton', amount: 38 }],
    notes: 'Thank you.', commission_pct: 0 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.prepare("SELECT COUNT(*) c FROM invoices").get().c;
  assert.strictEqual(after, before + 1, 'the invoice was rendered but never stored');

  const row = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(row.total, 143, '133 of fares + 10 of fees, no commission');
  assert.strictEqual(row.fees, 10, 'the per-trip fee reached the row');
  assert.strictEqual(row.commission_pct, 0, 'and no commission was set');
  const items = JSON.parse(row.line_items_json);
  assert.strictEqual(items[0].fee, 10);
  assert.strictEqual(items[1].fee, 0, 'the trip with no fee kept none');
  assert.ok(/BN44 3DN/.test(items[0].pickup || ''), 'the RESOLVED from-address was stored');
  assert.ok(/RH6 0NP/.test(items[0].destination || ''), 'and the resolved to-address');
});

test('an OPERATOR invoice created on the form carries its rate', async () => {
  const r = await call('post', '/invoices/bespoke', { body: {
    recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: [{ date: '2026-08-05', description: 'A → B', amount: 200, fee: 15 }],
    commission_pct: 12.5 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(row.commission_pct, 12.5, 'the rate he typed');
  assert.strictEqual(row.total, 190, '200 − 25 + 15');
});

test('every INSERT INTO invoices balances its columns and placeholders', () => {
  /* The cheap half of the same lesson: a mismatch here is a silent data loss,
     not an error anybody sees. */
  const src = read('server/api.js');
  const starts = [...src.matchAll(/INSERT INTO invoices/g)].map((m) => m.index);
  assert.ok(starts.length >= 2, 'expected the account and bespoke inserts');
  starts.forEach((i, n) => {
    /* Bounded by the end of the statement, not by a character count — the
       suite's own hygiene guard rejects the latter, and rightly: a window that
       stops reaching its subject goes on reporting green. */
    const end = src.indexOf('`).run(', i);
    assert.ok(end > i, 'insert #' + (n + 1) + ' has no .run() — re-anchor this guard');
    const seg = src.slice(i, end);
    const cols = /\(([^)]*)\)\s*\n\s*VALUES/.exec(seg);
    const qs = /VALUES \(([^)]*)\)/.exec(seg);
    assert.ok(cols && qs, 'insert #' + (n + 1) + ' could not be parsed');
    assert.strictEqual(cols[1].split(',').length, qs[1].split(',').length,
      'insert #' + (n + 1) + ': ' + cols[1].split(',').length + ' columns but ' +
      qs[1].split(',').length + ' placeholders');
  });
});

test('a trip created on the form keeps its RESOLVED addresses', () => {
  /* The account edit path spreads the whole line item, so pickup/destination
     survive there whatever happens — which is why removing them from the
     CREATE path went unnoticed. This is the create path. */
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const create = src.slice(src.indexOf("router.post('/invoices/bespoke'"));
  const map = create.slice(create.indexOf('.map(it => ({'), create.indexOf('.filter', create.indexOf('.map(it => ({')) + 200);
  assert.ok(/pickup: it\.pickup/.test(map), 'the resolved FROM must be stored: ' + map.slice(0, 200));
  assert.ok(/destination: it\.destination/.test(map), 'and the resolved TO');
  assert.ok(/fee:/.test(map), 'and the optional fee');
});

test('a FEE is optional per trip — blank is not zero', () => {
  const H = read('westmere-owner.html');
  const row = /function invAddItem\([\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/class="fi ni-fee"/.test(row), 'every trip row needs a fee box');
  assert.ok(/placeholder=""/.test(row) || /placeholder=\x27\x27/.test(row),
    'and it must start empty, not at 0.00');
  const get = /function invGetItems\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/feeRaw===''\?0:/.test(get.replace(/\s/g, '')),
    'a blank box must not be read as a typed zero');
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/fee: \(Number\(it\.fee\) > 0\) \? Math\.round/.test(src),
    'and the server must store 0 only when there genuinely is none');
});

test('FROM and TO go through the address lookup, and the RESOLVED address is stored', () => {
  const H = read('westmere-owner.html');
  assert.ok(/src="\/wm-address-lookup\.js"/.test(H), 'the owner app must load the lookup');
  const row = /function invAddItem\([\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/class="fi ni-from"/.test(row) && /class="fi ni-to"/.test(row), 'the row needs From and To');
  assert.ok(/WMLookup\.attach\(row\.querySelector\('\.ni-from'\)\)/.test(row),
    'and both must be wired to it');
  assert.ok(/WMLookup\.attach\(row\.querySelector\('\.ni-to'\)\)/.test(row));
  const get = /function invGetItems\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/WMLookup\.full\(fromEl\)/.test(get) && /WMLookup\.full\(toEl\)/.test(get),
    'the PRECISE address is what the invoice carries — the box only shows the short form');
});

test('the lookup component behaves like the booking form\'s', () => {
  const L = read('wm-address-lookup.js');
  assert.ok(/nominatim\.openstreetmap\.org/.test(L), 'same geocoder as the booking page');
  assert.ok(/countrycodes=gb/.test(L), 'same country restriction');
  assert.ok(/delete input\.dataset\.fullAddress/.test(L),
    'typing over a picked suggestion must forget it, or the old address is sent with the new text');
  assert.ok(/if \(seen\[key\]\) return;/.test(L),
    'the de-duplicator must SKIP a repeat, not merely record it — /seen\[key\]/ alone still ' +
    'matched the line that assigns the key, so removing the early return went unnoticed');
  assert.ok(/WMAddr && window\.WMAddr\.briefDisplay/.test(L),
    'display goes through the shared normalizer, so it reads the same as everywhere else');
});

test('an operator invoice built on the form gets the breakdown', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { fees: 12, fees_label: 'Parking', commission_pct: 10 } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 205.50, '215 − 21.50 + 12');
  const texts = await drawn(after);
  assert.ok(texts.some((t) => /^Less 10% commission$/.test(t.s)), 'the line');
  assert.ok(texts.some((t) => t.s === '\u2212\u00a321.50'), 'with its amount');
});

test('THE RATE IS ADJUSTABLE — 10 is a default, not a constant', async () => {
  for (const [pct, comm, total] of [[10, 21.50, 205.50], [12.5, 26.88, 200.12], [15, 32.25, 194.75], [7.5, 16.13, 210.87]]) {
    const inv = seed('bespoke', BESPOKE_ITEMS);                      // fares 215
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { fees: 12, commission_pct: pct } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.commissionPct, pct);
    assert.strictEqual(r.body.commission, comm, pct + '% of 215 should be ' + comm);
    assert.strictEqual(rowOf(inv.id).total, total, pct + '%: 215 − ' + comm + ' + 12');
  }
});

test('the line NAMES the rate that was used', async () => {
  for (const [pct, label, amount] of [[10, 'Less 10% commission', '\u2212\u00a321.50'],
                                      [12.5, 'Less 12.5% commission', '\u2212\u00a326.88'],
                                      [15, 'Less 15% commission', '\u2212\u00a332.25']]) {
    const inv = seed('bespoke', BESPOKE_ITEMS);
    await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { fees: 12, commission_pct: pct } });
    const texts = await drawn(rowOf(inv.id));
    assert.ok(texts.some((t) => t.s === label), 'expected "' + label + '" on the page');
    assert.ok(texts.some((t) => t.s === amount), 'with ' + amount);
    assert.ok(!texts.some((t) => t.s === 'Less 10% commission' && pct !== 10),
      'a hard-coded 10% must not survive: ' + label);
  }
});

test('both forms expose the rate, and neither hard-codes it', () => {
  const H = read('westmere-owner.html');
  for (const id of ['ni-commission-pct', 'inv-edit-commission-pct']) {
    assert.ok(new RegExp('id="' + id + '"').test(H), id + ' is missing — the rate is not editable there');
  }
  const create = /function invCommissionPct\(\)\{[\s\S]*?\n\}/.exec(H)[0].replace(/\s/g, '');
  const edit = /function invEditCommissionPct\(\)\{[\s\S]*?\n\}/.exec(H)[0].replace(/\s/g, '');
  for (const [name, fn, field] of [['create', create, 'ni-commission-pct'],
                                   ['edit', edit, 'inv-edit-commission-pct']]) {
    /* It must READ the field. Checking only for the "return 10" fallback let a
       version through that ignored the input and always returned ten. */
    assert.ok(fn.includes(field), name + ' does not read ' + field);
    assert.ok(/parseFloat/.test(fn), name + ' must parse what was typed');
    assert.ok(/Math\.round\(v\*100\)\/100/.test(fn), name + ' must return the typed value');
    assert.ok(/v<0\|\|v>=100/.test(fn), name + ' must bound the rate');
    assert.ok(/return10;/.test(fn), name + ' falls back to 10 rather than to nothing');
  }
  /* THE RATE IS NAMED WHERE IT IS SHOWN. On the edit sheet that is the one-line
     breakdown; on the create form it moved into the job sheet's totals row when
     the table replaced the summary line. Either way it is interpolated from
     what was typed — a printed "10%" beside a 12.5% deduction is the whole
     failure this guards. */
  const flat = H.replace(/\s/g, '');
  assert.ok(/−'\+pct\+'%commission/.test(flat),
    'the edit sheet\'s breakdown must name the rate');
  /* The job sheet's pay-out line moved into wm-invoice-maths.js when the admin
     app started sharing it. Same fact, one file along: the rate is written from
     what was typed, never printed as a literal ten per cent. */
  const maths = read('wm-invoice-maths.js').replace(/\s/g, '');
  assert.ok(/\+m\.pct\+'%commission/.test(maths),
    'the shared pay-out line must name the rate, not print a fixed 10%');
  assert.ok(!/'10%commission/.test(maths), 'the rate has been hard-coded in the module');
});

test('a rate outside 0–100 is refused, and the invoice is untouched', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: 12.5 } });
  for (const bad of [-1, 100, 150, 'abc']) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { commission_pct: bad } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad) + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).commission_pct, 12.5, 'a refused edit changes nothing');
});

test('EVERY variable on an invoice can be corrected', async () => {
  /* The owner's words: all variables can be adjusted. Asserted as one list so
     a field that quietly stops being editable is noticed here rather than by
     him, at the point he needs to change it. */
  const inv = seed('account', ACCOUNT_ITEMS);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    recipient_name: 'Harbourside Events Ltd', recipient_email: 'accounts@harbourside.example.com',
    recipient_phone: '07700 900321', recipient_addr: '12 Marine Parade\nBrighton',
    issued_date: '2026-08-29', due_date: '2026-09-19', period_label: 'August 2026',
    notes: 'Corrected.', commission_pct: 12.5,
    line_items: [{ date: '2026-08-05', ref: 'WPH-1001', time: '09:30',
                   pickup: 'Weppons Farm, Wiston BN44 3DN', destination: 'Gatwick Airport',
                   fare: 111, fee: 9 }],
    total_override: 123.45 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const a = rowOf(inv.id), it = itemsOf(inv.id)[0];
  const checks = {
    'bill-to name': [a.recipient_name, 'Harbourside Events Ltd'],
    'bill-to email': [a.recipient_email, 'accounts@harbourside.example.com'],
    'bill-to phone': [a.recipient_phone, '07700 900321'],
    'bill-to address': [a.recipient_addr, '12 Marine Parade\nBrighton'],
    'issued date': [a.issued_date, '2026-08-29'],
    'due date': [a.due_date, '2026-09-19'],
    'period label': [a.period_label, 'August 2026'],
    'notes': [a.notes, 'Corrected.'],
    'commission rate': [a.commission_pct, 12.5],
    'trip FROM': [it.pickup, 'Weppons Farm, Wiston BN44 3DN'],
    'trip TO': [it.destination, 'Gatwick Airport'],
    'trip date': [it.date, '2026-08-05'],
    'trip fare': [it.fare, 111],
    'trip fee': [it.fee, 9],
    'manual total': [a.total, 123.45],
    'manual flag': [a.total_manual, 1]
  };
  for (const [what, [got, want]] of Object.entries(checks)) {
    assert.strictEqual(got, want, what + ' is not adjustable: got ' + JSON.stringify(got));
  }
  // and the invoice number is still the one thing that cannot move
  assert.strictEqual(a.invoice_no, inv.invoice_no);
});

// ── THE APD MONTH ────────────────────────────────────────────────────────
console.log('\nThe operator invoice reconciles to the operator\'s own sheet');

/* GROUND TRUTH, from APD's job sheet for August 2026. Seven jobs; the 28/08
   was paid by card at the kerb, so the driver already has that £50.

     account fares 625 · all fares 675 · tolls 59
     commission 10% of 675 = 67.50
     payout 625 − 67.50 + 59 = £616.50

   Our invoice made it £655.60 — £39.10 over — three ways at once: the tolls
   were inside the line fares AND on a separate "Airport charges £49" line, the
   commission was taken on fares+tolls, and the card job was missing. This is
   the number that fails if any of them comes back. */
const APD_AUGUST = [
  { date: '2026-08-03', ref: 'WPH-9001', time: '05:00', pickup: 'Billingshurst', destination: 'Heathrow Terminal 2', fare: 115, fee: 7 },
  { date: '2026-08-05', ref: 'WPH-9002', time: '14:00', pickup: 'Heathrow Terminal 2', destination: 'Billingshurst', fare: 115, fee: 8 },
  { date: '2026-08-13', ref: 'WPH-9003', time: '06:30', pickup: 'Wiston', destination: 'Gatwick Airport', fare: 75, fee: 10 },
  { date: '2026-08-19', ref: 'WPH-9004', time: '11:15', pickup: 'Gatwick Airport North', destination: 'Wiston', fare: 75, fee: 10 },
  { date: '2026-08-21', ref: 'WPH-9005', time: '04:45', pickup: 'Pulborough', destination: 'Heathrow', fare: 130, fee: 7 },
  { date: '2026-08-28', ref: 'WPH-9006', time: '16:00', pickup: 'Gatwick Airport North', destination: 'Horsham', fare: 50, fee: 10, collected_direct: 1 },
  { date: '2026-08-29', ref: 'WPH-9007', time: '07:30', pickup: 'Ashington', destination: 'Heathrow Terminal 4', fare: 115, fee: 7 }
];

test('THE APD AUGUST INVOICE COMES TO £616.50', async () => {
  const inv = seed('account', APD_AUGUST);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: APD_AUGUST, commission_pct: 10 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lineSum, 675, 'fares, all seven, EXCLUDING tolls');
  assert.strictEqual(r.body.fees, 59, 'tolls, from the rows');
  assert.strictEqual(r.body.commission, 67.50, '10% of 675 — not of 734, and not of 625');
  assert.strictEqual(r.body.collectedDirect, 50, 'the card job the driver was paid for');
  assert.strictEqual(rowOf(inv.id).total, 616.50,
    '625 − 67.50 + 59. Got ' + rowOf(inv.id).total);
});

test('and the page shows the four steps that get there', async () => {
  const inv = seed('account', APD_AUGUST);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: APD_AUGUST, commission_pct: 10 } });
  const texts = await drawn(rowOf(inv.id));
  const want = [['Fares (jobs)', '£675.00'], ['Fees (parking & tolls)', '£59.00'],
                ['Less 10% commission', '\u2212\u00a367.50'], ['Less collected by driver', '\u2212\u00a350.00']];
  for (const [label, amount] of want) {
    assert.ok(texts.some((t) => t.s === label), 'missing line: ' + label);
    assert.ok(texts.some((t) => t.s === amount), label + ' has no ' + amount);
  }
  assert.ok(texts.some((t) => t.s === '£616.50'), 'and the total');
  assert.strictEqual(texts.filter((t) => /Airport charges/.test(t.s)).length, 0,
    'the lump line is gone — the per-trip fees replace it');
  assert.strictEqual(texts.filter((t) => t.s === '£734.00').length, 0,
    'fares+tolls must appear nowhere');
});

test('commission counts the collected fare, the payout does not', async () => {
  /* The netting rule on its own. Drop the flag and the total is £50 too high;
     leave the fare out of the commission base and it is £5 too high. */
  const inv = seed('account', APD_AUGUST);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: APD_AUGUST, commission_pct: 10 } });
  assert.strictEqual(r.body.commission, 67.50, 'the £50 fare IS in the base (10% of 675)');
  assert.notStrictEqual(r.body.commission, 62.50, 'not 10% of 625 — that excludes it');
  assert.strictEqual(rowOf(inv.id).total, 616.50, 'and the £50 is OUT of the payout');
  assert.notStrictEqual(rowOf(inv.id).total, 666.50, 'which it would be if it were paid over');
});

test('an ALL-IN fare from a real booking is split, not billed whole', async () => {
  /* The root cause. The engine returns base + terminal charge + toll as one
     number; a £122 Heathrow run is £115 of driving and £7 of Dartford. The
     invoice must show £115. */
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const map = src.slice(src.indexOf('const lineItems = bookings.map'), src.indexOf('db.prepare(', src.indexOf('const lineItems = bookings.map')));
  assert.ok(/fare: split \? Math\.round\(Number\(b\.base_fare\)/.test(map),
    'the line fare must be the BASE fare when the split was kept');
  assert.ok(/airport_fee \|\| 0\) \+ \(\+b\.toll_fee/.test(map),
    'and the fee must be the terminal charge plus the toll');
  /* …and that value must actually be USED. Checking only that passThrough is
     computed let a version through where the fee was hard-wired to 0 and the
     toll silently disappeared off the invoice. */
  assert.ok(/fee: split \? passThrough : 0/.test(map),
    'the computed pass-through must be what lands in the fee column');
  assert.ok(/b\.base_fare != null/.test(map),
    'with a fallback for bookings taken before the parts were stored');

  // and end to end: a booking that WAS split bills at 115, not 122
  const items = [{ date: '2026-08-03', ref: 'WPH-9001', pickup: 'Billingshurst',
                   destination: 'Heathrow Terminal 2', fare: 115, fee: 7 }];
  const inv = seed('account', items);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: items, commission_pct: 10 } });
  assert.strictEqual(r.body.lineSum, 115, 'the fare column is the ride: £115, not £122');
  assert.strictEqual(r.body.fees, 7, 'the toll is the fee');
  assert.strictEqual(r.body.commission, 11.50, '10% of 115 — never of 122');
});

test('the engine\'s split is STORED, on both booking paths', () => {
  const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  for (const c of ['base_fare', 'airport_fee', 'toll_fee']) {
    assert.ok(cols.includes(c), c + ' is not a column — the split cannot be kept');
  }
  const pub = read('server/public-api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/baseFare\s*=/.test(pub) && /tollFee\s*=/.test(pub), 'the public /book path must keep them');
  assert.ok(/base_fare, airport_fee, toll_fee/.test(pub), 'and write them');
  /* And the STAFF path. The owner types his own fare, so what is kept there is
     the engine's pass-throughs with the ride as the remainder — the test asserts
     the subtraction, because storing the engine's own base against a hand-typed
     fare would put a figure in the fare column the customer was never charged. */
  const staff = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/SET base_fare = \?, airport_fee = \?, toll_fee = \?/.test(staff),
    'a staff-created booking must keep the split too');
  assert.ok(/const base = r2\(total - af - tl\)/.test(staff),
    'the ride is the charged fare less the pass-throughs, not the engine\'s own base');
  assert.ok(/base < 0\) return/.test(staff),
    'a fare too small to cover its tolls must store no split at all');
  /* The fare engine is READ. FARE_CF is pinned elsewhere; this changes who the
     money belongs to, never what the customer is charged. */
  const engine = read('server/fare-engine.js');
  assert.ok(!/collected_direct|commission_pct/.test(engine), 'the split has leaked into the engine');
});

// ── PAGINATION ───────────────────────────────────────────────────────────
console.log('\nThe foot group stays on page one when it fits');

/* REALISTIC SETTINGS. With an empty settings object the FROM block is one line
   and everything fits with room to spare, so the squeeze is never called on and
   a guard built on that fixture proves nothing — removing the squeeze entirely
   left these tests green. The owner's real invoice settings carry a five-line
   address and bank details, which is what makes the page tight. */
const REAL_SETTINGS = {
  business_name: 'Westmere Private Hire', owner_name: 'Nikodem Krajnyk',
  address_line1: '4 Fisher Street', address_line2: 'Lewes, East Sussex', postcode: 'BN7 2DG',
  phone: '07930 342593', email: 'bookings@westmereprivatehire.co.uk',
  bank_name: 'Lloyds Bank', account_name: 'Westmere Private Hire',
  sort_code: '00-00-00', account_no: '00000000'
};
async function pagesOf(row) {
  const buf = await invoicePdf.buildInvoicePdf(invoicePdf.invoiceDataFromRow(row, REAL_SETTINGS));
  const t = buf.toString('latin1');
  return (t.split('/Type /Page').length - 1) - (t.split('/Type /Pages').length - 1);
}

test('a normal month with the full breakdown is ONE page', async () => {
  /* Five journeys, per-trip fees, the four-line commission breakdown, a note
     and the bank details — on the owner's real settings, which carry a
     five-line FROM address and are what make the page tight. */
  /* BUSY_MONTH carries two flight tags; the boundary test below records that
     two is one too many at five journeys. This is the ordinary month: one
     airport run with a flight number, four without. */
  const items = BUSY_MONTH.slice(0, 5).map((b, i) => Object.assign({}, b,
    { fee: [7, 7, 13, 11, 11][i], flight: i === 0 ? b.flight : null }));
  const inv = seed('account', items);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: items, commission_pct: 10, notes: 'Thank you.' } });
  const pages = await pagesOf(rowOf(inv.id));
  assert.strictEqual(pages, 1,
    'five journeys with the full breakdown must fit one page — went to ' + pages);
});

test('WHERE THE PAGE ACTUALLY ENDS, measured rather than hoped for', async () => {
  /* The honest boundary. Flight tags are the thing that costs: a row carrying
     one is taller than the constant, so the squeeze cannot reclaim it. Two of
     them on a five-journey month is enough to need a second page, and no
     amount of tightening changes that — the alternative would be shaving the
     margins until one fixture passed, which is how a layout stops being
     trustworthy. Recorded here so the limit is a known number rather than a
     surprise. */
  const mk = (n, flights) => Array.from({ length: n }, (_, i) => Object.assign({},
    BUSY_MONTH[i % BUSY_MONTH.length],
    { ref: 'WPH-8' + i, date: '2026-08-' + String(i + 1).padStart(2, '0'),
      fee: [7, 7, 13, 11, 11][i % 5], flight: i < flights ? 'BA275' + i : null }));
  const pagesFor = async (n, flights) => {
    const items = mk(n, flights);
    const inv = seed('account', items);
    await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { line_items: items, commission_pct: 10, notes: 'Thank you.' } });
    return pagesOf(rowOf(inv.id));
  };
  assert.strictEqual(await pagesFor(5, 1), 1, 'five journeys, one flight tag → one page');
  assert.strictEqual(await pagesFor(5, 2), 2, 'five journeys, TWO flight tags → two, and that is expected');
});

test('the break is MONOTONIC — more journeys never fit where fewer did not', async () => {
  /* The symptom of a squeeze measured against a promise the drawing could not
     keep: six journeys broke to a second page where seven did not. */
  const seen = [];
  for (let n = 3; n <= 8; n++) {
    const items = Array.from({ length: n }, (_, i) => Object.assign({}, BUSY_MONTH[i % BUSY_MONTH.length],
      { ref: 'WPH-7' + i, date: '2026-08-' + String(i + 1).padStart(2, '0'), fee: [7, 7, 13, 11, 11][i % 5] }));
    const inv = seed('account', items);
    await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { line_items: items, commission_pct: 10, notes: 'Thank you.' } });
    seen.push({ n, pages: await pagesOf(rowOf(inv.id)) });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].pages >= seen[i - 1].pages,
      seen[i].n + ' journeys fit in ' + seen[i].pages + ' page(s) but ' + seen[i - 1].n +
      ' needed ' + seen[i - 1].pages + ' — the pagination is not monotonic: ' +
      seen.map((x) => x.n + ':' + x.pages).join(' '));
  }
});

test('a squeeze is only used when it actually works', () => {
  const src = read('server/invoice-pdf.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/CANDIDATES/.test(src), 'the squeeze must be searched, not computed once');
  assert.ok(/m2\.yAfterTotal <= m2\.groupMax/.test(src),
    'and each candidate re-measured before it is trusted');
  assert.ok(/return NO_SLACK;\s*\}\s*$/m.test(src) || /return NO_SLACK;/.test(src),
    'with nothing tightened when none of them fits');
});

// ── THE MIGRATION ────────────────────────────────────────────────────────
console.log('\nCarrying an old lump fee onto the first trip');

/* Run the boot migration against a throwaway database seeded to look like the
   live one did before this change: account invoices with a lump fee and no
   per-trip fees anywhere. */
function runFeeMigration() {
  const rows = db.prepare("SELECT id, invoice_no, fees, total, line_items_json FROM invoices WHERE kind = 'account' AND fees > 0").all();
  let moved = 0;
  const set = db.prepare('UPDATE invoices SET line_items_json = ? WHERE id = ?');
  for (const r of rows) {
    let items; try { items = JSON.parse(r.line_items_json || '[]'); } catch (_) { continue; }
    if (!Array.isArray(items) || !items.length) continue;
    if (items.some((it) => Number(it && it.fee) > 0)) continue;
    items[0] = Object.assign({}, items[0], { fee: Math.round(Number(r.fees) * 100) / 100 });
    const feeSum = Math.round(items.reduce((t, it) => t + (Number(it && it.fee) || 0), 0) * 100) / 100;
    const fareSum = Math.round(items.reduce((t, it) => t + (Number(it && it.fare) || 0), 0) * 100) / 100;
    if (Math.round((fareSum + feeSum) * 100) / 100 !== Math.round(Number(r.total) * 100) / 100) continue;
    set.run(JSON.stringify(items), r.id);
    moved++;
  }
  return moved;
}

test('the shipped migration and this one are the same code', () => {
  /* A copy of a migration in a test proves the copy works. This pins the two
     together on the parts that decide what happens: which rows are chosen, the
     skip when a fee is already there, and the equality check before writing. */
  const src = read('server/db.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/kind = 'account' AND fees > 0/.test(src), 'it must select only account invoices with a fee');
  assert.ok(/items\.some\(\(it\) => Number\(it && it\.fee\) > 0\)\) continue/.test(src),
    'and skip any invoice whose rows already carry one — that is what makes it idempotent');
  assert.ok(/if \(derived !== Math\.round\(Number\(r\.total\) \* 100\) \/ 100\)/.test(src),
    'and refuse to write unless the derived total matches the one already stored');
  assert.ok(!/UPDATE invoices SET .*total/.test(src.slice(src.indexOf('THE LUMP FEE MOVES') > 0 ? 0 : 0)) ||
            !/SET line_items_json = \?, total/.test(src),
    'the migration must never write a total');
});

test('an old lump fee lands on the first trip, and the total does not move', () => {
  const inv = seed('account', ACCOUNT_ITEMS);                       // fares 215
  db.prepare("UPDATE invoices SET fees = 24.20, fees_label = 'Parking', total = 239.20 WHERE id = ?").run(inv.id);
  const before = rowOf(inv.id);
  assert.strictEqual(before.total, 239.2);

  assert.strictEqual(runFeeMigration(), 1, 'one invoice should have been carried across');
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 239.2, 'THE TOTAL MUST NOT MOVE');
  assert.strictEqual(after.fees, 24.2, 'nor the stored fee');
  const items = itemsOf(inv.id);
  assert.strictEqual(items[0].fee, 24.2, 'the lump now sits on the first trip');
  assert.strictEqual(Number(items[1].fee) || 0, 0, 'and only the first');
});

test('re-saving a migrated invoice keeps the fee and the total', async () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  db.prepare("UPDATE invoices SET fees = 24.20, total = 239.20 WHERE id = ?").run(inv.id);
  runFeeMigration();
  // the ordinary edit that would have dropped it to zero before the migration
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { notes: 'Corrected address.' } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.fees, 24.2, 'the derived figure reproduces the lump');
  assert.strictEqual(after.total, 239.2, 'and the total is what it always was');
});

test('running it twice changes nothing', () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  db.prepare("UPDATE invoices SET fees = 24.20, total = 239.20 WHERE id = ?").run(inv.id);
  assert.strictEqual(runFeeMigration(), 1);
  const once = rowOf(inv.id).line_items_json;
  assert.strictEqual(runFeeMigration(), 0, 'the second pass must find nothing to do');
  assert.strictEqual(rowOf(inv.id).line_items_json, once, 'and touch nothing');
  assert.strictEqual(itemsOf(inv.id)[0].fee, 24.2, 'not 48.40 — that is the double-apply this guards');
});

test('an invoice whose figures do not add up is left alone', async () => {
  /* The catch that stops a bill quietly changing value. This invoice's stored
     total does not equal its fares plus its fee — an old row, or one with a
     manual total. Moving the fee would make the next save derive a different
     number, so it is not moved. */
  const inv = seed('account', ACCOUNT_ITEMS);                     // fares 215
  db.prepare("UPDATE invoices SET fees = 24.20, total = 300 WHERE id = ?").run(inv.id);
  const moved = runFeeMigration();
  assert.strictEqual(moved, 0, 'it must refuse: 215 + 24.20 is not 300');
  assert.strictEqual(Number(itemsOf(inv.id)[0].fee) || 0, 0, 'the rows are untouched');
  assert.strictEqual(rowOf(inv.id).total, 300, 'and the total is exactly what it was');
});

test('it leaves alone what it should', () => {
  // bespoke — its fee is a single figure for the document and stays one
  const b = seed('bespoke', BESPOKE_ITEMS);
  db.prepare("UPDATE invoices SET fees = 18.50, total = 233.50 WHERE id = ?").run(b.id);
  // an account invoice with no fee at all
  const none = seed('account', ACCOUNT_ITEMS);
  // an account invoice whose rows already carry fees
  const already = seed('account', ACCOUNT_ITEMS.map((it, i) => Object.assign({}, it, { fee: i === 0 ? 5 : 0 })));
  db.prepare("UPDATE invoices SET fees = 5 WHERE id = ?").run(already.id);

  runFeeMigration();
  assert.strictEqual(Number(itemsOf(b.id)[0].fee) || 0, 0, 'a bespoke invoice must not be touched');
  assert.strictEqual(rowOf(b.id).fees, 18.5, 'and keeps its single figure');
  assert.strictEqual(Number(itemsOf(none.id)[0].fee) || 0, 0, 'a fee-free invoice gains nothing');
  assert.strictEqual(itemsOf(already.id)[0].fee, 5, 'and one already carried across is left as it is');
});

test('an invoice with no line items is skipped, not crashed on', () => {
  const inv = seed('account', ACCOUNT_ITEMS);
  db.prepare("UPDATE invoices SET fees = 10, line_items_json = '[]' WHERE id = ?").run(inv.id);
  assert.doesNotThrow(() => runFeeMigration());
  assert.strictEqual(rowOf(inv.id).line_items_json, '[]', 'nothing invented for it');
  db.prepare("UPDATE invoices SET line_items_json = 'not json' WHERE id = ?").run(inv.id);
  assert.doesNotThrow(() => runFeeMigration(), 'malformed JSON must not stop the boot');
});

test('the edit form has a fee field on every journey, beside its fare', () => {
  const H = read('westmere-owner.html');
  const fn = /function invEditRenderLines\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/data-f="fee"/.test(fn), 'no per-journey fee input');
  assert.ok(/data-f="amount"/.test(fn), 'and the fare is still there');
  assert.ok(fn.indexOf('data-f="fee"') < fn.indexOf('data-f="amount"'),
    'the fee sits beside the fare, before it in the row');
  assert.ok(/st\.bespoke\?''/.test(fn.replace(/\s/g, '')),
    'and only on an account invoice — a bespoke one has a single fee for the document');
  const sync = /function invEditSyncTotal\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/fbox\.disabled=true/.test(sync.replace(/\s/g, '')),
    'the single fee box must be read-only on an account invoice, or the two figures can disagree');
});

test('the client adds the fees up the same way the server does', () => {
  /* Two independent sums of the same money is how a screen and a document end
     up disagreeing about what is owed. */
  const H = read('westmere-owner.html');
  assert.ok(/function invEditPerTripFees\(\)/.test(H), 'the client needs the per-trip sum');
  const fees = /function invEditFees\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/!st\.bespoke\)\s*return invEditPerTripFees\(\)/.test(fees.replace(/\s+/g, ' ')),
    'an account invoice must take its fees from the trips, not the box');
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(/const perTripFees = /.test(src) && /if \(isAccount\) \{\s*fees = perTripFees;/.test(src),
    'and the server must derive it the same way');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-edit\.test\.js/.test(read('package.json')), 'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e.message || e).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
