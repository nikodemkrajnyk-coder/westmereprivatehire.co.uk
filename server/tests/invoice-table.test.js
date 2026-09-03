/**
 * THE OPERATOR'S JOB SHEET, AS AN ENTRY SCREEN — run with:
 *   node server/tests/invoice-table.test.js   (also gated by `npm test`)
 *
 * WHAT THIS IS
 *   APD send a sheet with a row per job and a column for every figure that
 *   moves the money — Date, From, To, Card, Account/Fare, Com., Tolls — and a
 *   total line with a "pay out". The invoice is a reconciliation against that
 *   sheet, so the entry screen is now the same shape.
 *
 * WHY IT IS GUARDED THIS HARD
 *   August 2026 went out at £655.60 against a sheet that said £616.50. Every
 *   penny of the £39.10 came from the toll: it was inside the fare, so ten per
 *   cent was charged on it, and then it was typed into the fee box and counted
 *   again. A screen that folds the toll back into the fare would reintroduce
 *   exactly that, and it would look right while doing it.
 *
 * THE ARITHMETIC IS EXECUTED, NOT READ
 *   invOperatorMaths() is lifted out of the shipped page and RUN against real
 *   fixtures. A guard that only greps the source for the right-looking
 *   expression passes on a function nobody calls — this repo has shipped that
 *   twice. So the wiring is asserted separately: the totals must come from this
 *   function, and the server must land on the same number from the same rows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-invoice-table-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-inv-table-cache-'));
process.env.INVOICES_DIR = CACHE;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { fnBlock } = require('./_source');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();

let SENT = [];
global.fetch = async (u, o) => { SENT.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

/* ── THE ARITHMETIC, REQUIRED RATHER THAN LIFTED ──────────────────────────
   It used to be pulled out of the owner page with a regular expression,
   because that was the only copy. There are two screens now — the owner's and
   admin's — so the sum lives in wm-invoice-maths.js and both of them ask it.
   This file runs the module itself, and then checks that neither page has
   quietly grown a second copy. */
const WM = require('../../wm-invoice-maths.js');
const MATHS = WM.compute;

// ── The route, driven directly ───────────────────────────────────────────
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
const api = require('../api');
async function call(method, routePath, body) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  const handlers = l.route.stack.map((s) => s.handle);
  const req = { params: {}, body: body || {}, query: {},
                auth: { role: 'owner', id: 1, type: 'user' }, ip: '::1' };
  const r = res();
  let i = 0;
  const next = async () => { if (i < handlers.length) await handlers[i++](req, r, next); };
  await next();
  return r;
}

/* APD'S AUGUST, exactly as it arrived: seven jobs, the fare and the toll kept
   apart, and the 28th collected by the driver on a card at the kerb.
       fares 675 · tolls 59 · 10% of the fares 67.50 · collected 50
       675 − 67.50 + 59 − 50 = 616.50, which is what APD's own sheet says. */
const APD = [
  { date: '2026-08-03', from: 'Billinghurst',   to: 'Heathrow T2',  fare: 115, toll: 7,  collected: false },
  { date: '2026-08-05', from: 'Heathrow T2',    to: 'Billinghurst', fare: 115, toll: 8,  collected: false },
  { date: '2026-08-13', from: 'Wiston',         to: 'Gatwick',      fare: 75,  toll: 10, collected: false },
  { date: '2026-08-19', from: 'Gatwick',        to: 'Wiston',       fare: 75,  toll: 10, collected: false },
  { date: '2026-08-21', from: 'Pulborough',     to: 'Heathrow',     fare: 130, toll: 7,  collected: false },
  { date: '2026-08-28', from: 'Gatwick',        to: 'Horsham',      fare: 50,  toll: 10, collected: true  },
  { date: '2026-08-29', from: 'Ashington',      to: 'Heathrow T4',  fare: 115, toll: 7,  collected: false }
];
const toLineItems = (rows) => rows.map((r) => ({
  date: r.date, description: r.from + ' → ' + r.to,
  pickup: r.from, destination: r.to,
  amount: r.fare, fee: r.toll, collected_direct: r.collected ? 1 : 0
}));

// ── 1. THE ARITHMETIC ────────────────────────────────────────────────────
console.log('\nThe table adds up the way the operator\'s sheet does');

test('APD\'s August, entered row by row, comes to £616.50', () => {
  const m = MATHS(APD, 10);
  assert.strictEqual(m.fares, 675, 'total fares');
  assert.strictEqual(m.tolls, 59, 'total tolls');
  assert.strictEqual(m.commission, 67.50, '10% of the fares');
  assert.strictEqual(m.collected, 50, 'the fare the driver took at the kerb');
  assert.strictEqual(m.total, 616.50,
    'fares − commission + tolls − collected: ' + JSON.stringify(m));
});

test('each row shows its OWN commission — ten per cent of that row\'s fare', () => {
  const m = MATHS(APD, 10);
  const want = [11.50, 11.50, 7.50, 7.50, 13.00, 5.00, 11.50];
  m.rows.forEach((r, i) => {
    assert.strictEqual(r.commission, want[i],
      'row ' + (i + 1) + ' (£' + APD[i].fare + ') should show £' + want[i].toFixed(2));
  });
});

test('a rate the owner changed is the rate every row uses', () => {
  const m = MATHS(APD, 15);
  assert.strictEqual(m.commission, 101.25, '15% of £675');
  assert.strictEqual(m.rows[0].commission, 17.25, '15% of £115');
  assert.strictEqual(m.total, 675 - 101.25 + 59 - 50);
});

// ── 2. THE TOLL IS ITS OWN COLUMN ────────────────────────────────────────
console.log('\nThe toll is beside the fare, never inside it');

test('a toll earns no commission, however large it is', () => {
  const bare = MATHS([{ fare: 100, toll: 0 }], 10);
  const tolled = MATHS([{ fare: 100, toll: 90 }], 10);
  assert.strictEqual(bare.commission, 10, '10% of £100');
  assert.strictEqual(tolled.commission, 10,
    'the £90 toll must not move the commission — that is the August bug');
  assert.strictEqual(tolled.total, 100 - 10 + 90, 'and it is added back whole');
});

test('the toll is never counted twice', () => {
  /* The old sheet put the toll inside the fare AND in the fee box. £115 + £7
     billed as a £122 fare with a £7 fee came to £122 − 12.20 + 7 = £116.80;
     kept apart it is £115 − 11.50 + 7 = £110.50. */
  const right = MATHS([{ fare: 115, toll: 7 }], 10);
  assert.strictEqual(right.fares, 115, 'the fare column is the ride alone');
  assert.strictEqual(right.total, 110.50, 'not £116.80');
});

test('the screen has a Toll column of its own, beside Fare and Com.', () => {
  /* Both shapes, from the one definition: the owner's phone folds the row in
     two, admin's modal lays it flat — but the columns and their headings are
     the same decision, made once. */
  for (const opts of [{ mode: 'stacked', money: '1fr', trip: '90px' },
                      { mode: 'flat', grid: '1fr' }]) {
    const head = WM.headHtml(opts);
    for (const col of ['Date', 'From', 'To', 'Card', 'Fare', 'Com.', 'Toll']) {
      assert.ok(head.indexOf('>' + col + '<') !== -1,
        opts.mode + ' sheet has no ' + col + ' column');
    }
  }
  /* And a box to type it into, distinct from the fare box. */
  const row = fnBlock(OWNER, 'invAddItem');
  assert.ok(/class="fi ni-fee"/.test(row) && /class="fi ni-amt"/.test(row),
    'fare and toll must be two separate inputs');
  assert.ok(/class="ni-com"/.test(row), 'the per-row commission cell is missing');
  assert.ok(/class="ni-collected"/.test(row), 'the Card tick is missing');
});

// ── 3. WHAT THE DRIVER ALREADY TOOK ──────────────────────────────────────
console.log('\nA fare collected at the kerb is commissioned, not paid over');

test('the tick takes the fare off the payout and leaves the commission alone', () => {
  const off = MATHS(APD.map((r) => Object.assign({}, r, { collected: false })), 10);
  const on = MATHS(APD, 10);
  assert.strictEqual(off.total, 666.50, 'nothing collected: 675 − 67.50 + 59');
  assert.strictEqual(on.total, 616.50, 'the £50 comes off');
  assert.strictEqual(on.commission, off.commission,
    'the operator still earns his ten per cent on a fare the driver collected');
});

test('and the toll on a collected job is still owed', () => {
  const m = MATHS([{ fare: 50, toll: 10, collected: true }], 10);
  assert.strictEqual(m.commission, 5, '10% of the £50 fare');
  assert.strictEqual(m.total, 50 - 5 + 10 - 50, 'the driver is out of pocket for the barrier');
  assert.strictEqual(m.total, 5, 'which is £5: the toll less the commission');
});

// ── 4. THE SCREEN AGREES WITH THE DOCUMENT ───────────────────────────────
console.log('\nWhat the totals row says is what the invoice bills');

test('the commission total is ten per cent of the FARES, not the sum of the rows', () => {
  /* Two 5p fares at 10% are half a penny each. Rounded per row that is 1p + 1p
     = 2p; on the fare total it is 1p — and 1p is what the server writes. A
     screen that adds up its own rounded rows disagrees with the invoice it is
     about to raise. */
  const m = MATHS([{ fare: 0.05, toll: 0 }, { fare: 0.05, toll: 0 }], 10);
  const rowsAdded = Math.round((m.rows[0].commission + m.rows[1].commission) * 100) / 100;
  assert.strictEqual(rowsAdded, 0.02, 'the displayed rows do round up individually');
  assert.strictEqual(m.commission, 0.01,
    'but the total must be 10% of £0.10 — the figure the server bills');
});

test('the same seven rows through the CREATE route land on £616.50', async () => {
  const r = await call('post', '/invoices/bespoke', {
    kind: 'bespoke',
    recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: toLineItems(APD),
    commission_pct: 10,
    notes: 'August 2026 settlement.'
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(r.body.invoiceNo || r.body.invoice_no);
  assert.ok(row, 'the invoice was not saved: ' + JSON.stringify(r.body));
  assert.strictEqual(row.total, 616.50, 'the stored total must match the screen');
  assert.strictEqual(row.fees, 59, 'the tolls are the fees');
  assert.strictEqual(row.commission_pct, 10);
  const items = JSON.parse(row.line_items_json || '[]');
  assert.strictEqual(items.length, 7, 'a job was dropped');
  assert.strictEqual(items[5].collected_direct, 1, 'the Card tick must survive the save');
  assert.strictEqual(items[0].amount, 115, 'the fare is the ride');
  assert.strictEqual(items[0].fee, 7, 'and the toll is beside it, not inside it');
  /* The screen and the route from one set of rows. */
  assert.strictEqual(MATHS(APD, 10).total, row.total,
    'the table and the invoice must never differ');
});

test('the created PDF carries the working, not just the total', async () => {
  const r = await call('post', '/invoices/bespoke', {
    kind: 'bespoke',
    recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: toLineItems(APD), commission_pct: 10
  });
  const no = r.body.invoiceNo || r.body.invoice_no;
  const file = fs.readdirSync(CACHE).find((f) => f.indexOf(no) === 0);
  assert.ok(file, 'no PDF was cached for ' + no);
  const pdf = fs.readFileSync(path.join(CACHE, file));
  assert.ok(pdf.length > 1000, 'the PDF is empty');
  /* The lead-in lines are only printed when the page is TOLD the rate — the
     create route used to render the first PDF (the one that is emailed) with
     no fees and no commission at all, so it showed the right total above an
     empty explanation. */
  const src = require('./_source').routeBlock(read('server/api.js'), "router.post('/invoices/bespoke'");
  assert.ok(/fees:\s*newFees,\s*commissionPct:\s*newCommissionPct/.test(src),
    'the create-time PDF must be given the fees and the rate');
});

test('the email is told the total instead of adding the fares up itself', () => {
  const src = require('./_source').routeBlock(read('server/api.js'), "router.post('/invoices/bespoke'");
  const send = /sendBespokeInvoice\([^;]*\);/.exec(src);
  assert.ok(send, 'the send call is gone');
  assert.ok(/journey: journeyForEmail,\s*total\s*\}/.test(send[0]),
    'without the total the email announces the FARES: ' + send[0]);
});

// ── 4b. THE FEE ON THE LINE IT WAS PAID ON ───────────────────────────────
console.log('\nEach journey on the one-off invoice carries its own fee');

/* THE DRAWING, RECORDED. PDFKit compresses its content streams, so a finished
   file cannot be grepped for "£7.00" — and the interesting question is not
   whether the string exists but WHERE it was put: a fee printed in the amount
   column is the toll folded into the fare all over again. So every text call is
   captured with its coordinates, the way the row-height guard does it. */
function recorder() {
  const PDFDocument = require('pdfkit');
  const ops = { texts: [], docs: [], page: 1 };
  const seen = (d) => { let i = ops.docs.indexOf(d); if (i === -1) { ops.docs.push(d); i = ops.docs.length - 1; } return i; };
  const T = PDFDocument.prototype.text, A = PDFDocument.prototype.addPage;
  PDFDocument.prototype.text = function (str, x, y, o) {
    const d = seen(this);
    if (typeof x === 'number' && typeof y === 'number') {
      ops.texts.push({ s: String(str), x, y, w: (o && o.width) || 0, page: ops.page, doc: d });
    }
    return T.apply(this, arguments);
  };
  PDFDocument.prototype.addPage = function () { ops.page++; return A.apply(this, arguments); };
  ops.restore = () => { PDFDocument.prototype.text = T; PDFDocument.prototype.addPage = A; };
  return ops;
}
async function draw(data) {
  const ops = recorder();
  try {
    delete require.cache[require.resolve('../invoice-pdf')];
    await require('../invoice-pdf').buildInvoicePdf(data);
  } finally { ops.restore(); }
  const last = ops.docs.length - 1;
  ops.texts = ops.texts.filter((t) => t.doc === last);
  return ops;
}
const bespokeDoc = (items, extra) => Object.assign({
  invoiceNo: 'INV-202608-0099', kind: 'bespoke',
  settings: { company_name: 'Westmere Private Hire' },
  recipient: { name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000',
               address: '1 High Street\nSteyning\nBN44 3AA' },
  period: { issuedDate: '2026-08-31', dueDate: '2026-09-14', label: 'August 2026' },
  items, notes: ''
}, extra || {});
/* The right-hand money columns, found by where the headings were drawn rather
   than by repeating the numbers from the drawing code. */
const colX = (ops, heading) => {
  const h = ops.texts.find((t) => t.s === heading);
  assert.ok(h, 'the ' + heading + ' heading was never drawn on this table');
  return h.x;
};

test('every journey prints its own fee, in a column of its own', async () => {
  const fares = APD.map((r) => r.fare), tolls = APD.map((r) => r.toll);
  const ops = await draw(bespokeDoc(toLineItems(APD), {
    commissionPct: 10, fees: 59, total: 616.50
  }));
  const feeX = colX(ops, 'FEE'), amtX = colX(ops, 'AMOUNT');
  assert.ok(feeX < amtX, 'the fee column must sit to the LEFT of the amount, not inside it');

  for (let i = 0; i < APD.length; i++) {
    const fee = ops.texts.find((t) => Math.abs(t.x - feeX) < 1 && t.s === '£' + tolls[i].toFixed(2));
    assert.ok(fee, 'the ' + APD[i].date + ' job does not show its £' + tolls[i].toFixed(2) + ' toll on its own line');
    const amt = ops.texts.find((t) => Math.abs(t.x - amtX) < 1 && t.s === '£' + fares[i].toFixed(2));
    assert.ok(amt, 'the ' + APD[i].date + ' fare is missing from the amount column');
    /* THE POINT OF THE WHOLE CHANGE: two figures, two columns. The fee must
       not have been drawn in the amount column, and the amount must not be the
       two added together — which is the old all-in fare returning. */
    assert.ok(!ops.texts.some((t) => Math.abs(t.x - amtX) < 1 && t.s === '£' + tolls[i].toFixed(2) &&
                                     tolls[i] !== fares[i]),
      'the toll was drawn in the amount column');
    assert.notStrictEqual(amt.s, '£' + (fares[i] + tolls[i]).toFixed(2),
      'the amount is the fare plus the toll — they have been folded together again');
  }
  /* Seven fees drawn, not one lump. */
  const drawnFees = ops.texts.filter((t) => Math.abs(t.x - feeX) < 1 && /^£/.test(t.s));
  assert.strictEqual(drawnFees.length, 7, 'expected seven per-trip fees, got ' + drawnFees.length);
});

test('a journey that carried nothing shows a blank, never £0.00', async () => {
  const ops = await draw(bespokeDoc([
    { date: '2026-08-04', description: 'Lewes → Gatwick', amount: 80, fee: 12 },
    { date: '2026-08-06', description: 'Gatwick → Lewes', amount: 80, fee: 0 }
  ], { commissionPct: 10, fees: 12, total: 12 + 160 - 16 }));
  const feeX = colX(ops, 'FEE');
  const inFeeCol = ops.texts.filter((t) => Math.abs(t.x - feeX) < 1 && /^£/.test(t.s));
  assert.deepStrictEqual(inFeeCol.map((t) => t.s), ['£12.00'],
    'a fee-less journey must print nothing in the column: ' + JSON.stringify(inFeeCol.map((t) => t.s)));
});

test('an invoice where nothing was paid out keeps the two columns it had', async () => {
  /* A FEE heading over an empty column is a question the reader has to answer
     about a document that has nothing to say. A plain customer invoice — three
     journeys, no parking — must look exactly as it did. */
  const ops = await draw(bespokeDoc([
    { date: '2026-08-04', description: 'Lewes → Gatwick', amount: 95 },
    { date: '2026-08-06', description: 'Gatwick → Lewes', amount: 95 }
  ], { total: 190 }));
  assert.ok(!ops.texts.some((t) => t.s === 'FEE'), 'a fee-less invoice must not head a fee column');
  const amt = ops.texts.find((t) => t.s === 'AMOUNT');
  const fig = ops.texts.find((t) => t.s === '£95.00');
  assert.ok(amt && fig, 'the amount column is gone');
  /* Right-aligned across the full column, the way it was before the fee column
     existed — not shifted left to make room for one that is not there. */
  assert.ok(Math.abs(amt.x - fig.x) < 1, 'the heading and the figures must share a column');
  assert.ok(amt.x < 100, 'the amount is right-aligned across the table: x=' + amt.x);
});

test('the totals still walk from the fares to £616.50', async () => {
  const ops = await draw(bespokeDoc(toLineItems(APD), {
    commissionPct: 10, fees: 59, total: 616.50
  }));
  const said = ops.texts.map((t) => t.s);
  for (const line of ['Fares (jobs)', 'Fees (parking & tolls)',
                      'Less 10% commission', 'Less collected by driver', 'TOTAL DUE']) {
    assert.ok(said.indexOf(line) !== -1, 'the invoice never says "' + line + '"');
  }
  for (const fig of ['£675.00', '£59.00', '-£67.50', '-£50.00', '£616.50']) {
    assert.ok(said.some((x) => x === fig || x === fig.replace('-', '\u2212')),
      'the invoice never shows ' + fig + ' — ' + JSON.stringify(said.filter((x) => /^[-\u2212]?£/.test(x))));
  }
});

test('the changed table cannot serve a PDF drawn by the old one', () => {
  /* Cached invoices are keyed on TEMPLATE_VERSION. A new column with the old
     number means every existing invoice keeps serving the file without it —
     this repo has shipped that twice. */
  const pdf = require('../invoice-pdf');
  const src = read('server/invoice-pdf.js');
  const v = /const TEMPLATE_VERSION = (\d+)/.exec(src);
  assert.ok(v && +v[1] >= 12, 'TEMPLATE_VERSION must move with the fee column — got ' + (v && v[1]));
  const p = pdf.invoiceCachePath('INV-202608-0099');
  assert.ok(p.indexOf('.v' + v[1] + '.') !== -1,
    'the cache filename does not carry the template version: ' + p);
});

// ── ADMIN CAN CORRECT AN INVOICE ─────────────────────────────────────────
console.log('\nA wrong invoice is corrected in admin, not re-issued');

test('admin has a correction sheet, on the same route as the owner app', () => {
  assert.ok(/id="modal-edit-invoice"/.test(ADMIN), 'admin has no correction sheet');
  assert.ok(/id="mid-edit-btn"[^>]*onclick="ieOpen\(\)"/.test(ADMIN),
    'there is no way to reach it from an invoice');
  const save = fnBlock(ADMIN, 'ieSave').replace(/\s/g, '');
  assert.ok(/'\/api\/invoices\/'\+_IE\.id/.test(save), 'the correction must go to /invoices/:id');
  assert.ok(/method:'PATCH'/.test(save), 'a correction is a PATCH, not a new invoice');
  for (const f of ['line_items', 'commission_pct', 'fees', 'fees_label', 'total_override']) {
    assert.ok(save.indexOf(f) !== -1, 'the correction does not send ' + f);
  }
  /* THE NUMBER CANNOT MOVE. Somebody has already filed this document; a
     correction that renumbered it would arrive as a second, unrelated bill. */
  assert.ok(!/invoice_no/.test(save), 'a correction must never move the invoice number');
});

test('correcting a one-off invoice does not destroy its tolls and ticks', async () => {
  /* THE BUG THIS FOUND, and it was live. The PATCH route rebuilt a bespoke line
     as date/description/amount and threw the rest away — so every correction of
     a one-off operator invoice silently emptied the FEE column and un-ticked
     every job the driver had already been paid for. Correct the recipient's
     name and £50 walks back onto the bill. */
  const created = await call('post', '/invoices/bespoke', {
    kind: 'bespoke', recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: toLineItems(APD), commission_pct: 10
  });
  const no = created.body.invoiceNo || created.body.invoice_no;
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(no);
  /* The smallest possible correction: a typo in the name, nothing else. */
  const l = api.stack.find((x) => x.route && x.route.path === '/invoices/:id' && x.route.methods.patch);
  const r = res();
  const req = { params: { id: String(row.id) }, query: {}, ip: '::1',
                auth: { role: 'owner', id: 1, type: 'user' },
                body: { recipient_name: 'APD Private Hire Ltd',
                        line_items: JSON.parse(row.line_items_json) } };
  const hs = l.route.stack.map((x) => x.handle);
  let i = 0; const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
  await next();
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.id);
  const items = JSON.parse(after.line_items_json);
  assert.deepStrictEqual(items.map((x) => x.fee), [7, 8, 10, 10, 7, 10, 7],
    'the per-trip tolls did not survive the correction');
  assert.strictEqual(items.filter((x) => x.collected_direct === 1).length, 1,
    'the driver-collected tick did not survive the correction');
  assert.strictEqual(after.total, 616.50,
    'a correction that changed only the NAME must not change the money');
});

test('the correction sheet totals through the shared module, not its own sum', () => {
  const m = fnBlock(ADMIN, 'ieMaths').replace(/\s/g, '');
  assert.ok(/WMInvoiceMaths\.compute\(/.test(m), 'the correction sheet does its own arithmetic');
  const sync = fnBlock(ADMIN, 'ieSync').replace(/\s/g, '');
  assert.ok(/m\.fares-m\.commission\+fees-m\.collected/.test(sync),
    'the corrected total must be fares − commission + fees − collected');
  assert.ok(/WMInvoiceMaths\.totalsHtml\(/.test(sync) && /WMInvoiceMaths\.payoutHtml\(/.test(sync),
    'the correction sheet must draw the same totals and payout as the create form');
  assert.ok(/WMInvoiceMaths\.headHtml\(/.test(fnBlock(ADMIN, 'ieRender')),
    'and the same column headings');
});

test('a correction reaches the route and lands on the corrected figure', async () => {
  /* End to end: raise APD's month, then correct one fare, and the stored total
     must follow — through PATCH, the route the sheet posts to. */
  const created = await call('post', '/invoices/bespoke', {
    kind: 'bespoke', recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: toLineItems(APD), commission_pct: 10
  });
  const no = created.body.invoiceNo || created.body.invoice_no;
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(no);
  assert.strictEqual(row.total, 616.50, 'the invoice must start at £616.50');

  const items = JSON.parse(row.line_items_json);
  items[4].amount = 140;                      // the 21 August fare, £130 → £140
  const l = api.stack.find((x) => x.route && x.route.path === '/invoices/:id' && x.route.methods.patch);
  assert.ok(l, 'PATCH /invoices/:id is missing — admin cannot correct anything');
  const r = res();
  const req = { params: { id: String(row.id) }, query: {}, ip: '::1',
                auth: { role: 'owner', id: 1, type: 'user' },
                body: { line_items: items, commission_pct: 10, fees: 59 } };
  const hs = l.route.stack.map((x) => x.handle);
  let i = 0; const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
  await next();
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.id);
  /* fares 685 − 68.50 + 59 − 50 */
  assert.strictEqual(after.total, 625.50, 'the corrected total must follow the corrected fare');
  assert.strictEqual(after.invoice_no, no, 'and the number must not have moved');
  /* The screen must agree with it. */
  const onScreen = MATHS(APD.map((x, k) => k === 4 ? Object.assign({}, x, { fare: 140 }) : x), 10);
  assert.strictEqual(onScreen.total, after.total,
    'the correction sheet and the stored invoice must show the same figure');
});

// ── 5. THE WIRING ────────────────────────────────────────────────────────
console.log('\nThe figures on screen come from that arithmetic, and nowhere else');

test('invCalcTotal computes through the shared maths and shows what it returns', () => {
  const calc = fnBlock(OWNER, 'invCalcTotal');
  assert.ok(/invOperatorMaths\(rows\s*,\s*pct\)/.test(calc),
    'the totals must be computed by the same function this file tests');
  assert.ok(/ni-running-total/.test(calc) && /m\.total\.toFixed\(2\)/.test(calc),
    'the running total must show the payout figure');
  assert.ok(/invOpTotalsHtml\(m\)/.test(calc),
    'the totals row must be drawn from the result, not recomputed');
  /* Each row's Com. cell filled from the same result. */
  assert.ok(/ni-com/.test(calc) && /m\.rows\[k\]\.commission/.test(calc),
    'the per-row commission cells are not being filled');
});

test('the totals row names all four figures, and the pay-out line the fifth', () => {
  /* RENDERED, not read. The figures must reach the markup — a totals builder
     that computes them and prints the wrong ones would pass a source check. */
  const m = MATHS(APD, 10);
  for (const opts of [{ mode: 'stacked', money: '1fr' }, { mode: 'flat', grid: '1fr' }]) {
    const t = WM.totalsHtml(m, opts);
    for (const fig of ['£675.00', '£67.50', '£59.00', '£50.00']) {
      assert.ok(t.indexOf(fig) !== -1, opts.mode + ' totals row never shows ' + fig);
    }
    assert.ok(/&minus;£50\.00/.test(t), 'what the driver collected must read as a deduction');
  }
  const p = WM.payoutHtml(m);
  assert.ok(p.indexOf('£616.50') !== -1, 'the pay-out never shows the total');
  assert.ok(/Pay out/i.test(p), 'the sheet\'s "pay out" line is missing');
  /* And the four steps written out, so the figure explains itself where it is
     read — the column totals are off to the right on a phone. */
  for (const fig of ['£675.00', '10%', '£67.50', '£59.00', '£50.00']) {
    assert.ok(p.indexOf(fig) !== -1, 'the pay-out line does not show its working: ' + fig);
  }
});

/* ONE FIELD, SLICED OFF THE NEXT. A `>` inside a value expression — and there
   is one: `+toll>0?…` — ends a naive `[^>]*>` match early, and the handler that
   follows it falls outside the window. Bounded by the NEXT field instead. */
function fieldSrc(src, cls) {
  const i = src.indexOf('class="' + cls + '"');
  assert.ok(i !== -1, 'no field with class ' + cls);
  const rest = src.slice(i + 6);
  const j = rest.indexOf('class="');
  return rest.slice(0, j === -1 ? rest.length : j);
}

test('the tick, the fare and the toll all redraw the totals as he types', () => {
  const row = fnBlock(OWNER, 'invAddItem');
  const op = row.slice(0, row.indexOf('} else {'));
  assert.ok(/oninput="invCalcTotal\(\)"/.test(fieldSrc(op, 'fi ni-amt')), 'the fare box is not live');
  assert.ok(/oninput="invCalcTotal\(\)"/.test(fieldSrc(op, 'fi ni-fee')), 'the toll box is not live');
  /* The tick goes through invSetCollected — it records the flag on the row and
     then redraws. Straight to invCalcTotal it would total correctly and forget
     the tick the moment the layout changed. */
  assert.ok(/onchange="invSetCollected\(this\)"/.test(fieldSrc(op, 'ni-collected')), 'the Card tick is not live');
  assert.ok(/invCalcTotal\(\)/.test(fnBlock(OWNER, 'invSetCollected')), 'and it must redraw the totals');
  assert.ok(/id="ni-commission"[^>]*onchange="invRelayout\(\)"/.test(OWNER),
    'ticking "operator invoice" must redraw the sheet');
});

test('a tick survives a layout that has no Card column', () => {
  /* Toggling the operator switch off and on redraws every row. The simple
     layout has no Card box, so reading the tick back OFF THE BOX returned false
     for all of them — and a £50 fare the driver had already taken was paid over
     a second time, in silence. The flag lives on the row; the box is one way of
     setting it, not the only place it is kept. */
  const add = fnBlock(OWNER, 'invAddItem');
  assert.ok(/row\.dataset\.collected='1'/.test(add), 'the row does not remember the tick');
  assert.ok(/onchange="invSetCollected\(this\)"/.test(add), 'the box does not write to the row');
  const set = fnBlock(OWNER, 'invSetCollected');
  assert.ok(/delete row\.dataset\.collected/.test(set), 'unticking must clear it');
  /* All three readers must fall back to the row, or they disagree with each
     other the moment the layout has no box: the totals, the redraw and the save. */
  for (const fn of ['invRowsFromDom', 'invCalcTotal', 'invGetItems']) {
    const src = fnBlock(OWNER, fn);
    assert.ok(/dataset\.collected==='1'/.test(src),
      fn + ' reads only the checkbox — it will lose the tick in the simple layout');
  }
});

test('the entered rows reach the route with their tick', () => {
  const get = fnBlock(OWNER, 'invGetItems');
  assert.ok(/collected_direct:\s*collected/.test(get), 'the tick is dropped before sending');
  assert.ok(/fee:\s*fee>0/.test(get), 'the toll is dropped before sending');
});

// ── 5b. ONE SUM, TWO SCREENS ─────────────────────────────────────────────
console.log('\nThe owner app and the admin app cannot drift apart');

test('both pages load the shared arithmetic', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/<script src="\/wm-invoice-maths\.js"><\/script>/.test(src),
      name + ' does not load wm-invoice-maths.js');
  }
});

test('neither page keeps a second copy of the settlement', () => {
  /* THE TELL. The one line that decides what is owed:
         fares − commission + tolls − collected
     If it appears in a page as well as in the module, there are two answers to
     the same question and only one of them is being tested. This is exactly how
     admin came to bill £675 where the owner app billed £616.50 — the arithmetic
     was not shared, so only one screen was ever fixed. */
  const settlement = /fares\s*-\s*[\w.]*[cC]ommission\s*\+\s*[\w.]*[tT]olls?\s*-\s*[\w.]*[cC]ollected/;
  const commissionOnFares = /[\w.]*fares\s*\*\s*\(\s*rate\s*\/\s*100\s*\)/;
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const code = strip(src);
    assert.ok(!settlement.test(code),
      name + ' has its own copy of the payout sum — it must call WMInvoiceMaths.compute');
    assert.ok(!commissionOnFares.test(code),
      name + ' works the commission out for itself instead of asking the module');
  }
  const mod = strip(read('wm-invoice-maths.js'));
  assert.ok(settlement.test(mod), 'the module has stopped doing the sum');
  assert.ok(commissionOnFares.test(mod), 'the module has stopped taking the commission');
});

/* ONE HOP OUT. A page may call the module directly or through a one-line
   wrapper of its own — the owner app does the latter, because its widths differ
   from admin's. So the search follows every same-page function the calculator
   names, once. What it must NOT find is a page that renders totals it worked
   out itself. */
function reachable(src, fnName) {
  let body = fnBlock(src, fnName);
  const called = new Set((body.match(/\b([A-Za-z_$][\w$]*)\s*\(/g) || [])
    .map((m) => m.replace(/\s*\($/, '')));
  for (const name of called) {
    if (name === fnName) continue;
    try { body += '\n' + fnBlock(src, name); } catch (_) { /* not a page function */ }
  }
  return body;
}

test('both pages ask the module for their totals and their columns', () => {
  for (const [name, src, fn] of [['owner', OWNER, 'invCalcTotal'],
                                 ['admin', ADMIN, 'updateBespokeTotal']]) {
    const calc = reachable(src, fn);
    assert.ok(/WMInvoiceMaths\.compute\(/.test(calc),
      name + ': ' + fn + ' must compute through the shared module');
    assert.ok(/WMInvoiceMaths\.totalsHtml\(/.test(calc), name + ' draws its own totals row');
    assert.ok(/WMInvoiceMaths\.payoutHtml\(/.test(calc), name + ' draws its own pay-out line');
  }
  /* The owner's wrapper is one line and must stay one line. */
  const wrap = fnBlock(OWNER, 'invOperatorMaths');
  assert.ok(/return WMInvoiceMaths\.compute\(rows,pct\);/.test(wrap.replace(/\s+/g, ' ').replace(/ ,/g, ',')),
    'the owner wrapper must forward to the module and do nothing else: ' + wrap);
  for (const [name, src, fn] of [['owner', OWNER, 'invOpHeadHtml'], ['admin', ADMIN, 'admInvRelayout']]) {
    assert.ok(/WMInvoiceMaths\.headHtml\(/.test(reachable(src, fn)),
      name + ' builds its own column headings');
  }
});

// ── 5c. ADMIN RAISES THE SAME INVOICE ────────────────────────────────────
console.log('\nAdmin raises the operator invoice the same way the owner app does');

test('admin has the toggle, the rate and the seven columns', () => {
  assert.ok(/id="ni-commission"[^>]*onchange="admInvRelayout\(\)"/.test(ADMIN),
    'admin has no operator toggle, or it does not redraw the sheet');
  assert.ok(/id="ni-commission-pct"[^>]*oninput="updateBespokeTotal\(\)"/.test(ADMIN),
    'admin has no adjustable rate, or it is not live');
  const row = fnBlock(ADMIN, 'addBespokeItem');
  for (const cls of ['ni-date', 'ni-from', 'ni-to', 'ni-collected', 'ni-amt', 'ni-com', 'ni-fee']) {
    assert.ok(row.indexOf(cls) !== -1, 'admin\'s job-sheet row has no ' + cls);
  }
  /* Flat, not folded: this is a desktop modal and the sheet is landscape. */
  assert.ok(/ADM_GRID/.test(row) && /mode:'flat'/.test(ADMIN),
    'admin must lay the columns across one row per job');
  assert.ok(/WMLookup\.attach/.test(row), 'From and To must use the same address lookup');
});

test('a toll survives the toggle in admin too', () => {
  /* Switching the operator toggle off redraws every row in the plain layout.
     That layout had no fee box, so `admRowsFromDom` read every toll back as
     blank and £59 of barrier charges disappeared on the way — the payout came
     out £59 short with nothing on screen to say why. Both layouts carry the
     box, exactly as the owner app's two do. */
  const row = fnBlock(ADMIN, 'addBespokeItem');
  const simple = row.slice(row.indexOf('} else {'));
  assert.ok(/class="fi ni-fee"/.test(simple),
    'the plain admin row has nowhere to keep a toll — it will be lost on the toggle');
  assert.ok(/Fee £/.test(ADMIN), 'and the plain heading must name the column');
  const rows = fnBlock(ADMIN, 'admRowsFromDom');
  assert.ok(/\.ni-fee/.test(rows) && /toll:fe\?fe\.value/.test(rows),
    'the redraw must read the toll back off the row');
});

test('admin sends the rate, the toll and the tick — not just an amount', () => {
  const get = fnBlock(ADMIN, 'getBespokeItems');
  assert.ok(/fee:\s*fee>0/.test(get), 'admin drops the toll before sending');
  assert.ok(/collected_direct:\(op&&admRowCollected\(r\)\)\?1:0/.test(get),
    'admin drops the driver-collected tick before sending');
  const build = fnBlock(ADMIN, 'buildInvoiceRequest');
  assert.ok(/body\.commission_pct\s*=\s*admCommissionPct\(\)/.test(build),
    'admin never tells the server there is an arrangement — the invoice bills the fares');
  /* And the assistant's card, which posts the same route by another door. */
  const aa = fnBlock(ADMIN, 'aaCreateInvoice');
  for (const f of ['fee:', 'collected_direct:', 'commission_pct']) {
    assert.ok(aa.indexOf(f) !== -1, 'the assistant\'s Create Invoice drops ' + f);
  }
});

test('admin\'s seven rows land on £616.50, the same as the owner\'s', async () => {
  /* The page collects rows; the route bills them. This drives the route with
     exactly what admin's getBespokeItems produces from APD's month. */
  const r = await call('post', '/invoices/bespoke', {
    kind: 'bespoke',
    recipient: { name: 'APD Private Hire', email: 'accounts@apd.example.com' },
    items: toLineItems(APD),
    commission_pct: 10
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(r.body.invoiceNo || r.body.invoice_no);
  assert.strictEqual(row.total, 616.50, 'admin must arrive where the owner app arrives');
  assert.strictEqual(MATHS(APD, 10).total, row.total, 'and the screen must agree with it');
});

test('admin\'s preview shows the fee per trip and the four steps', () => {
  const modal = fnBlock(ADMIN, 'openInvoiceDetailModal');
  assert.ok(/anyFee/.test(modal) && /Fee<\/th>/.test(modal),
    'admin\'s preview has no FEE column — it disagrees with the PDF it is previewing');
  assert.ok(/admInvLeadIn\(/.test(modal), 'the preview never draws the lead-in lines');
  const lead = fnBlock(ADMIN, 'admInvLeadIn');
  for (const line of ['Fares (jobs)', 'Fees (parking', 'commission', 'Less collected by driver']) {
    assert.ok(lead.indexOf(line) !== -1, 'the preview never says "' + line + '"');
  }
  assert.ok(/WMInvoiceMaths\.compute\(rows,pct\)/.test(lead),
    'the preview must total the stored lines with the shared module, not its own sum');
  /* And the figures have to reach it: the route returns the whole row, so the
     rate and the fees must be carried into the preview's data. */
  const view = fnBlock(ADMIN, 'viewInvoice');
  for (const f of ['commissionPct:', 'fees:', 'feesLabel:']) {
    assert.ok(view.indexOf(f) !== -1, 'viewInvoice never passes ' + f + ' to the preview');
  }
});

// ── 6. THE PLAIN INVOICE IS UNTOUCHED ────────────────────────────────────
console.log('\nA customer invoice stays a simple list');

test('with the toggle off there is no commission and nothing is collected', () => {
  const m = MATHS([{ fare: 100, toll: 5 }, { fare: 60, toll: 0 }], 0);
  assert.strictEqual(m.commission, 0, 'a customer is not owed a commission');
  assert.strictEqual(m.total, 165, 'fares + fees, exactly as before');
  assert.strictEqual(m.rows[0].commission, 0, 'and no row shows one');
});

test('the pay-out cannot scroll off the edge of the phone', () => {
  /* The columns are wider than the app's own column, so the sheet slides
     sideways to reach the Toll. The per-column totals travel with their
     columns — the figure the owner reads out must not. */
  const wrapAt = OWNER.indexOf('id="ni-op-wrap"');
  const wrapEnd = OWNER.indexOf('id="ni-op-payout"');
  assert.ok(wrapAt !== -1 && wrapEnd !== -1, 'the sheet or its pay-out line is gone');
  assert.ok(wrapEnd > wrapAt, 'the pay-out must come after the scrolling wrapper');
  const inside = OWNER.slice(wrapAt, wrapEnd);
  assert.ok(!/id="ni-op-payout"/.test(inside.slice(0, -1)), 'the pay-out is inside the scroll');
  const closes = (inside.match(/<\/div>/g) || []).length;
  assert.ok(closes >= 3, 'the wrapper is not closed before the pay-out: ' + closes);
  const calc = fnBlock(OWNER, 'invCalcTotal');
  assert.ok(/invOpPayoutHtml\(m\)/.test(calc), 'the pay-out is not drawn from the totals');
});

test('the simple layout keeps its stacked row and gains no columns', () => {
  const row = fnBlock(OWNER, 'invAddItem');
  const i = row.indexOf('} else {');
  assert.ok(i !== -1, 'the two layouts are gone');
  const simple = row.slice(i);
  assert.ok(/Pickup — start typing/.test(simple), 'the simple row lost its labelled fields');
  assert.ok(!/ni-collected/.test(simple), 'a customer invoice must not ask who collected the fare');
  assert.ok(!/ni-com/.test(simple), 'a customer invoice must not show a commission column');
  assert.ok(/id="ni-head-simple"/.test(OWNER), 'the simple heading strip is gone');
});

test('a stray tick cannot take money off a customer invoice', async () => {
  /* The flag is remembered when the owner switches layouts, so it can arrive on
     a body with no rate. On a customer invoice there is no Card column and no
     line to explain a deduction — so it must not make one. */
  const r = await call('post', '/invoices/bespoke', {
    kind: 'bespoke',
    recipient: { name: 'Sussex Corporate Ltd', email: 'ap@sussexcorp.example.com' },
    items: [{ date: '2026-08-04', description: 'Lewes → Gatwick', amount: 80, fee: 5, collected_direct: 1 }]
  });
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(r.body.invoiceNo || r.body.invoice_no);
  assert.strictEqual(row.total, 85, '80 + 5 — the tick must be inert without a rate');
  /* And the screen agrees: the same row, commission off. */
  assert.strictEqual(MATHS([{ fare: 80, toll: 5, collected: true }], 0).total, 85,
    'the page must not deduct it either');
});

test('a plain invoice through the route is fares + fees, with no deduction', async () => {
  const r = await call('post', '/invoices/bespoke', {
    kind: 'bespoke',
    recipient: { name: 'Sussex Corporate Ltd', email: 'ap@sussexcorp.example.com' },
    items: [{ date: '2026-08-04', description: 'Lewes → Gatwick', amount: 80, fee: 5 },
            { date: '2026-08-06', description: 'Gatwick → Lewes', amount: 80, fee: 0 }]
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(r.body.invoiceNo || r.body.invoice_no);
  assert.strictEqual(row.total, 165, '80 + 80 + 5, no commission');
  assert.strictEqual(row.commission_pct, 0, 'a customer invoice carries no rate');
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
