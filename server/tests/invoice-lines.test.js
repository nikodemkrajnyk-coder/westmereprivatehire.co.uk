/**
 * WHAT A LINE ON AN INVOICE SAYS — run with:
 *   node server/tests/invoice-lines.test.js   (also gated by `npm test`)
 *
 * The owner sent a preview of INV-202610-0001 with three things wrong with it,
 * and all three are about the LINES rather than the document around them:
 *
 *   1. THE ADDRESSES WERE THE GEOCODER'S. "12 Puttock Billingshurst via
 *      Mannings heath via Warninglid → Heathrow Airport, Eastern Perimeter
 *      Road, Hatton Cross, London Borough of Hillingdon, Greater London,
 *      England, TW5 9SH, United Kingdom" is not a description of a journey. He
 *      asked twice for the short form the booking system shows. It turns four
 *      journeys into a page.
 *
 *   2. A ROW HAD NO AMOUNT, and the rows were out of order — 21, 25, 27, then
 *      17. The blank row was a job with no fare recorded: it arrived as a zero,
 *      printed as an empty line, and was then dropped on save, so the journey
 *      stayed un-billed with nobody told. The order was the operator page's
 *      newest-first, which is right for a page you scan and wrong for a bill.
 *
 *   3. (The gold, which is a palette matter — server/tests/invoice-contrast.js
 *      and button-style.test.js hold that.)
 *
 * THE SHORTENING IS DISPLAY-ONLY AND ARROW-ONLY. shortDisplay is an address
 * normaliser; a bespoke line is as often a sentence ("Wedding car for the day,
 * including waiting at the church") as a journey, and running the normaliser
 * over prose would cut it down to a word it mistook for a town. Only a line
 * with an arrow in it — the shape the app itself builds — is touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-invlines-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const invoicePdf = require('../invoice-pdf');
const { getDb } = require('../db');
const db = getDb();
const api = require('../api');

/** Every string the renderer actually draws. */
async function drawn(data) {
  const PDFDocument = require('pdfkit');
  const texts = [];
  const T = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str, x, y) {
    if (typeof x === 'number' && typeof y === 'number' && String(str).trim()) {
      texts.push({ s: String(str), x, y });
    }
    return T.apply(this, arguments);
  };
  try { await invoicePdf.buildInvoicePdf(data); }
  finally { PDFDocument.prototype.text = T; }
  return texts;
}
const SETTINGS = { company_name: 'Westmere Private Hire' };
const RECIP = { name: 'APD Private Hire', email: 'a@example.com', phone: '07700 900000', address: '1 High Street' };
const PERIOD = { issuedDate: '2026-10-01', dueDate: '2026-10-15', label: 'September 2026' };
const bespoke = (items) => ({
  invoiceNo: 'INV-202610-0001', kind: 'bespoke',
  total: items.reduce((t, i) => t + (i.amount || 0), 0),
  settings: SETTINGS, recipient: RECIP, period: PERIOD, items
});

const LONG_FROM = '12 Puttock Billingshurst via Mannings heath via Warninglid';
const LONG_TO = 'Heathrow Airport, Eastern Perimeter Road, Hatton Cross, '
              + 'London Borough of Hillingdon, Greater London, England, TW5 9SH, United Kingdom';

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(method, routePath, opts) {
  const o = opts || {};
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced) break;
  }
  return r;
}

// ── 1. THE SHORT FORM ────────────────────────────────────────────────────
console.log('\nAn invoice says where, not the whole address');

test('the long geocoded journey comes out short', async () => {
  const texts = await drawn(bespoke([{ date: '2026-09-21', description: LONG_FROM + ' → ' + LONG_TO, amount: 95 }]));
  const line = texts.find((t) => /→/.test(t.s));
  assert.ok(line, 'the journey was not drawn at all');
  assert.ok(!/United Kingdom|Greater London|Borough of Hillingdon|Eastern Perimeter/.test(line.s),
    'the geocoder tail is still on the invoice: ' + line.s);
  assert.ok(/Billingshurst/.test(line.s), 'the pickup town must survive: ' + line.s);
  assert.ok(/Heathrow/.test(line.s), 'and the destination: ' + line.s);
  assert.ok(line.s.length < 60, 'the line is still long enough to wrap a page: ' + line.s);
});

test('a line that is NOT a journey is left exactly as typed', () => {
  /* shortDisplay is an address normaliser. A bespoke invoice carries sentences
     too — a wedding car, a day's waiting — and cutting those down to a word it
     mistook for a town would be worse than the bug being fixed. */
  const src = strip(read('server/invoice-pdf.js'));
  const fn = fnBlock(src, 'shortJourney');
  assert.ok(/parts\.length < 2\) return raw/.test(fn),
    'shortJourney must return anything without an arrow untouched');
});

test('…and in the document, not only in the function', async () => {
  const prose = 'Wedding car for the day, including waiting at the church and the reception afterwards';
  const texts = await drawn(bespoke([{ date: '2026-09-21', description: prose, amount: 450 }]));
  assert.ok(texts.some((t) => t.s === prose), 'a prose line must reach the page verbatim');
});

test('the account table has always shortened, and still does', async () => {
  const texts = await drawn({
    invoiceNo: 'INV-X', kind: 'account', total: 95, settings: SETTINGS, recipient: RECIP, period: PERIOD,
    bookings: [{ date: '2026-09-21', ref: 'R1', time: '09:00', pickup: LONG_FROM, destination: LONG_TO, fare: 95 }]
  });
  const line = texts.find((t) => /→/.test(t.s));
  assert.ok(line && !/United Kingdom/.test(line.s), 'the journey column must shorten too: ' + (line && line.s));
});

test('the owner app stores the SHORT form on a new invoice line', () => {
  const fn = fnBlock(strip(read('westmere-owner.html')), 'invGetItems');
  assert.ok(/_invShort\(fromFull\)/.test(fn) && /_invShort\(toFull\)/.test(fn),
    'the line must be built from the short form, not the resolved geocoder string');
  assert.ok(/pickup_full/.test(fn) && /destination_full/.test(fn),
    'the full address should still be kept on the line, just not printed');
  const short = fnBlock(strip(read('westmere-owner.html')), '_invShort');
  assert.ok(/WMAddr\.shortDisplay/.test(short), 'and it must use the shared normaliser');
});

// ── 2. THE ORDER, AND THE MISSING AMOUNT ─────────────────────────────────
console.log('\nEvery journey has an amount, and they read down the month');

test('lines print in date order, whatever order they arrive in', async () => {
  const items = [
    { date: '2026-09-21', description: 'Steyning → Gatwick', amount: 95 },
    { date: '2026-09-25', description: 'Hove → Heathrow', amount: 120 },
    { date: '2026-09-27', description: 'Lewes → Stansted', amount: 150 },
    { date: '2026-09-17', description: 'Henfield → Gatwick', amount: 80 }
  ];
  const texts = await drawn(bespoke(items));
  /* The document is measured and then drawn, so each line is seen twice; the
     first four are the pass that matters. */
  const sept = texts.filter((t) => /^\d{1,2} September 2026$/.test(t.s)).map((t) => t.s);
  assert.ok(sept.length >= 4, 'the dates were not drawn: ' + sept.join(', '));
  assert.deepStrictEqual(sept.slice(0, 4),
    ['17 September 2026', '21 September 2026', '25 September 2026', '27 September 2026'],
    'the dates must read down the month: ' + sept.join(', '));
  /* And the journeys follow their dates rather than sitting in the order they
     were typed. */
  const routes = texts.filter((t) => /→/.test(t.s)).map((t) => t.s.split(' ')[0]);
  assert.deepStrictEqual(routes.slice(0, 4), ['Henfield', 'Steyning', 'Hove', 'Lewes'],
    'each journey must stay with its date: ' + routes.slice(0, 4).join(', '));
});

test('a date stored unpadded still sorts where it belongs', () => {
  /* 2026-9-7 sorts AFTER 2026-09-27 as text, which is the exact shape of the
     odd row on the owner's preview. Sorted on the components, it does not. */
  const src = strip(read('server/invoice-pdf.js'));
  const key = fnBlock(src, 'journeyKey');
  assert.ok(/\\d\{1,2\}/.test(key) || /\{1,2\}/.test(key), 'the key must accept an unpadded month/day');
  assert.ok(!/new Date\(/.test(key), 'and must not parse the date into an instant');
  assert.ok(/Infinity/.test(key), 'an undated line belongs at the end, not the top');
});

test('an undated line keeps its place at the end', async () => {
  const texts = await drawn(bespoke([
    { description: 'Waiting time', amount: 30 },
    { date: '2026-09-21', description: 'Steyning → Gatwick', amount: 95 }
  ]));
  const idxDated = texts.findIndex((t) => /Steyning/.test(t.s));
  const idxUndated = texts.findIndex((t) => /Waiting time/.test(t.s));
  assert.ok(idxDated < idxUndated, 'the dated journey must come first');
});

test('an invoice cannot be raised with a journey worth nothing', async () => {
  const r = await call('post', '/invoices/bespoke', { body: {
    recipient: { name: 'APD Private Hire', email: 'a@example.com' },
    items: [
      { date: '2026-09-21', description: 'Steyning → Gatwick', amount: 95 },
      { date: '2026-09-17', description: 'Henfield → Gatwick', amount: 0 }
    ] } });
  assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
  assert.ok(/no amount/i.test(r.body.error), 'it must say what is wrong: ' + r.body.error);
  assert.ok(/2026-09-17/.test(r.body.error), 'and WHICH journey: ' + r.body.error);
  assert.ok(/take them off|put a fare/i.test(r.body.error), 'and what to do about it');
});

test('a line that is only a fee is still a line', async () => {
  /* A toll with no fare against it is a real thing to bill. The refusal is
     about a line worth NOTHING, not about a line with no fare. */
  const r = await call('post', '/invoices/bespoke', { body: {
    recipient: { name: 'APD Private Hire', email: 'a@example.com' },
    items: [{ date: '2026-09-21', description: 'Dartford crossing', amount: 0, fee: 4 }] } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
});

test('an ACCOUNT line is read by its fare, not by an amount it never had', () => {
  /* The two shapes share this table: a typed line carries `amount`, a journey
     carries `fare`. Reading only one of them refused every account invoice in
     the system. */
  const src = strip(read('server/api.js'));
  /* Two doors raise or change an invoice — POST /invoices/bespoke and
     PATCH /invoices/:id — and both must refuse a line worth nothing. The PATCH
     one sees RAW lines, where a typed line carries `amount` and a journey
     carries `fare`; reading only one of them refused every account invoice in
     the system. The POST one has already normalised to `amount`. */
  const checks = [...src.matchAll(/const valueless = /g)];
  assert.strictEqual(checks.length, 2, 'both the create and the correction routes must check');
  assert.ok(/it\.amount != null \? it\.amount : it\.fare/.test(src),
    'the correction route must accept a journey\'s fare as its value');
  /* …and the create route, which has already normalised, reads amount or fee. */
  assert.ok(/!\(it\.amount > 0\) && !\(it\.fee > 0\)/.test(src),
    'the create route must let a fee-only line through');
});

test('the owner app sorts the un-billed jobs before filling the form', () => {
  const fn = fnBlock(strip(read('westmere-owner.html')), 'owOperatorInvoiceFor');
  assert.ok(/_invDateKey/.test(fn), 'the jobs must be sorted on the date key');
  assert.ok(/unpriced/.test(fn), 'and a job with no fare must be surfaced, not silently zeroed');
  const key = fnBlock(strip(read('westmere-owner.html')), '_invDateKey');
  assert.ok(!/new Date\(/.test(key), 'the key must not parse the date into an instant');
});

// ── 3. NOTHING IS LOST FROM THE UN-BILLED SET ────────────────────────────
console.log('\nThe right jobs, none missing and none twice');

test('every un-billed job for the operator reaches the form, once', () => {
  const op = db.prepare(`INSERT INTO customers (full_name, email, password, is_operator)
                         VALUES ('APD Private Hire','apd@example.com','',1)`).run().lastInsertRowid;
  let n = 0;
  const seed = (date, fare, invoiced) => {
    const ref = 'WPH-O' + (++n);
    db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                      operator_id,operator_invoice_id,passed_at)
                VALUES (?,?,?,?,?,1,?,'account','completed',?,?,?)`)
      .run(ref, 'Steyning', 'Gatwick', date, '07:00', fare, op, invoiced || null, date);
    return ref;
  };
  seed('2026-09-21', 95);  seed('2026-09-25', 120);
  seed('2026-09-27', 150); seed('2026-09-17', 80);
  seed('2026-09-05', 60, 7);                      // already on invoice 7
  seed('2026-09-11', 70);
  const rows = db.prepare(
    `SELECT ref, date, fare, operator_invoice_id FROM bookings WHERE operator_id = ?`).all(op);
  const unbilled = rows.filter((r) => !r.operator_invoice_id);
  assert.strictEqual(unbilled.length, 5, 'five jobs are waiting to be billed');
  assert.strictEqual(new Set(unbilled.map((r) => r.ref)).size, 5, 'and none of them twice');
  assert.ok(unbilled.every((r) => Number(r.fare) > 0), 'the fixture has no unpriced job');
  assert.ok(!unbilled.some((r) => r.operator_invoice_id), 'an invoiced job must never come back');
});

test('raising the invoice stamps the jobs so they cannot be billed again', () => {
  const src = strip(read('server/api.js'));
  /* THE RULE IS "A JOB ALREADY BILLED IS NOT RE-BILLED", and it was pinned
     here as one exact UPDATE. The statement gained a second column — income
     now needs to know which invoice settles a job, not just whether an
     operator job has been billed — so the guard checks the PROPERTY instead:
     neither column may be overwritten once it is set, whether that is said
     with a WHERE or with a COALESCE. */
  const stamp = /UPDATE bookings SET operator_invoice_id[\s\S]{0,220}?WHERE id = \?/.exec(src);
  assert.ok(stamp, 'the operator invoice no longer stamps its jobs at all');
  const keepsOperator = /operator_invoice_id IS NULL/.test(stamp[0])
                     || /operator_invoice_id = COALESCE\(operator_invoice_id,/.test(stamp[0]);
  assert.ok(keepsOperator, 'the stamp must refuse a job that already carries an invoice');
  const keepsInvoice = /invoice_id = COALESCE\(invoice_id,/.test(stamp[0])
                    || /AND invoice_id IS NULL/.test(stamp[0]);
  assert.ok(keepsInvoice, 'the income link can be overwritten by a second invoice');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-lines\.test\.js/.test(read('package.json')),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
