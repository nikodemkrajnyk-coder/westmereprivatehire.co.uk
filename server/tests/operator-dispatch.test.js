/**
 * PASSING A JOB TO ANOTHER OPERATOR — run with:
 *   node server/tests/operator-dispatch.test.js   (also gated by `npm test`)
 *
 * WHAT WAS TRUE BEFORE
 *   A job could be sent to a driver. An operator could be invoiced. Nothing
 *   joined the two: the owner page's "Send a job" was a message telling him to
 *   go and find the job himself, and the send sheet only knew about drivers.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *   An operator job is NOT a driver job with the rate set to zero. The two are
 *   settled by different mechanisms:
 *     a DRIVER keeps the fare less our commission, and the commission is
 *       netted against the balance the ledger derives from his jobs;
 *     an OPERATOR has no balance at all — the work is billed on an invoice,
 *       and what they owe is simply the invoices they have not paid.
 *   So nothing about an operator job may reach the driver ledger: driver_id
 *   stays empty, admin_fee is nought, and the turnover does not move until the
 *   invoice does. Asking for a commission on one is refused rather than
 *   quietly ignored, because a caller that meant it needs to find out.
 *
 * THE THING MOST LIKELY TO GO WRONG
 *   Billing the same journey twice. The job is stamped with the invoice that
 *   billed it, and "Create invoice" only offers what is unstamped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-opdisp-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-opdisp-cache-'));
process.env.INVOICES_DIR = CACHE;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/* RESEND ONLY, so the emails can be read back; anything else goes to the real
   fetch rather than being answered with a stub that has no .text(). */
const SENT = [];
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  try { SENT.push(JSON.parse(o.body)); } catch (e) {}
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const offers = require('../offer-routes');
const api = require('../api');

/* `to` is whatever the mailer passed — a string for one recipient, a list for
   several. Asked for only one way, these guards failed on the stub rather than
   on the code. */
const mailTo = (addr) => SENT.filter((m) => []
  .concat(m && m.to ? m.to : [])
  .some((t) => String(t).toLowerCase() === addr.toLowerCase()))[0];

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments are prose, not behaviour. */
const { stripComments: strip } = require('./_source');
function fnBody(code, name) {
  const i = code.indexOf('function ' + name + '(');
  assert.ok(i > -1, name + ' is gone');
  const end = code.indexOf('\n}', i);
  assert.ok(end > i, name + ' has no closing brace');
  return code.slice(i, end);
}

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(router, method, routePath, opts) {
  const o = opts || {};
  const l = router.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const handlers = l.route.stack.map((x) => x.handle);
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: o.role || 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of handlers) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced && h !== handlers[handlers.length - 1]) break;
  }
  return r;
}
const dispatch = (id, body) => call(offers, 'post', '/bookings/:id/dispatch', { params: { id: String(id) }, body });

let seq = 0;
function seedBooking(over) {
  const o = Object.assign({ fare: 96, payment: 'account', status: 'confirmed', date: '2026-10-02' }, over || {});
  const ref = 'WPH-O' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,passenger_email,passenger_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick South Terminal', o.date, '07:00', 2, o.fare, o.payment, o.status,
         'ben@example.com', 'Ben Chan');
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

function seedOperator(over) {
  const o = Object.assign({ name: 'Airport Direct Private Hire', email: 'ops@apd.example.com',
                            flag: 1, active: 1 }, over || {});
  const info = db.prepare(`INSERT INTO customers (full_name, company, email, phone, password, active, is_operator,
                                                  address_line1, postcode)
                           VALUES (?,?,?,?,'x',?,?,?,?)`)
    .run(o.name, o.company || null, o.email, '07700 900111', o.active, o.flag, '1 High Street', 'BN44 3AA');
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
}
function seedDriver() {
  const info = db.prepare(`INSERT INTO users (username,password,role,full_name,email,active,has_login)
                           VALUES (?, '', 'driver', 'Gary Lane', ?, 1, 0)`)
    .run('drv' + Date.now().toString(36), 'gary' + (++seq) + '@example.com');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// ── 1. THE JOB GOES, AND IT GOES AS AN OPERATOR JOB ──────────────────────
console.log('\nA job can be passed to another operator');

test('the operator is sent the job, and the booking records who has it', async () => {
  const op = seedOperator();
  const b = seedBooking();
  const r = await dispatch(b.id, { operator_id: op.id });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.operator, 'the answer must say it went to an operator');
  assert.strictEqual(r.body.operator.id, op.id);
  const row = rowOf(b.id);
  assert.strictEqual(row.operator_id, op.id, 'the booking does not know which operator has it');
  assert.strictEqual(row.assigned_to_name, op.full_name, 'the name the customer is told');
  assert.strictEqual(row.assigned_to_email, op.email);
  assert.ok(row.passed_at, 'the job must be stamped as passed on');
  /* NOT A DRIVER. driver_id is what every ledger query keys on; an operator in
     it would appear in the drivers list, with a balance and a commission rate. */
  assert.strictEqual(row.driver_id, null, 'an operator must never land in driver_id');
});

test('a company name is what the customer is told, when there is one', async () => {
  const op = seedOperator({ name: 'Jane Harding', company: 'Harding Executive Travel',
                            email: 'ops@harding.example.com' });
  const b = seedBooking();
  await dispatch(b.id, { operator_id: op.id });
  assert.strictEqual(rowOf(b.id).assigned_to_name, 'Harding Executive Travel',
    'the firm is picking them up, not the person who answers its phone');
});

test('the job carries the road and the calendar, exactly as a driver job does', async () => {
  const op = seedOperator({ email: 'road@apd.example.com' });
  const b = seedBooking();
  SENT.length = 0;
  await dispatch(b.id, { operator_id: op.id });
  const m = mailTo('road@apd.example.com');
  assert.ok(m, 'the operator was not emailed the job at all');
  assert.ok(/Steyning/.test(m.html) && /Gatwick/.test(m.html), 'the trip is missing from the email');
  assert.ok(/waze\.com/i.test(m.html), 'no Waze link — the whole point of the job email');
  assert.ok((m.attachments || []).some((a) => /\.ics$/.test(a.filename || '')),
    'no calendar invitation');
  assert.ok(/Ben Chan/.test(m.html), 'the passenger’s name is missing');
});

// ── 2. NO COMMISSION, AND NO LEDGER ─────────────────────────────────────
console.log('\nNo commission, and nothing in any ledger');

test('nothing is taken off an operator job', async () => {
  const op = seedOperator({ email: 'money@apd.example.com' });
  const b = seedBooking({ fare: 96 });
  await dispatch(b.id, { operator_id: op.id });
  const row = rowOf(b.id);
  assert.strictEqual(row.admin_fee, 0, 'a commission was taken on an operator job');
  assert.strictEqual(row.driver_pay, 96, 'and the fare must be recorded whole');
});

test('the turnover does not move until the invoice does', async () => {
  const op = seedOperator({ email: 'books@apd.example.com' });
  const before = ledger.westmereIncome();
  const b = seedBooking({ fare: 250 });
  await dispatch(b.id, { operator_id: op.id });
  const after = ledger.westmereIncome();
  /* The shapes differ between versions of this function; whatever it reports,
     an operator job must not add commission income to it. */
  const total = (x) => (x && typeof x === 'object')
    ? (Number(x.total) || Number(x.income) || Number(x.commission) || 0) : (Number(x) || 0);
  assert.strictEqual(total(after), total(before),
    'passing a job to another firm earned us commission income out of nowhere');
});

test('and the job appears in no driver’s history', async () => {
  const op = seedOperator({ email: 'hist@apd.example.com' });
  const drv = seedDriver();
  const before = ledger.driverHistory(drv.id).totals.jobs;
  const b = seedBooking();
  await dispatch(b.id, { operator_id: op.id });
  assert.strictEqual(ledger.driverHistory(drv.id).totals.jobs, before,
    'an operator job turned up in a driver’s history');
  assert.strictEqual(ledger.driverBalance(drv.id), ledger.driverBalance(drv.id), 'sanity');
});

test('asking for a commission on an operator job is REFUSED, not ignored', async () => {
  const op = seedOperator({ email: 'refuse@apd.example.com' });
  const b = seedBooking();
  for (const body of [{ operator_id: 0, commission_pct: 10 }, { operator_id: 0, charge_commission: true }]) {
    const r = await dispatch(b.id, Object.assign({}, body, { operator_id: op.id }));
    assert.strictEqual(r.statusCode, 400, 'accepted: ' + JSON.stringify(body));
    assert.ok(/invoice/i.test(r.body.error), 'and it must say why: ' + r.body.error);
  }
  assert.strictEqual(rowOf(b.id).operator_id, null, 'and the booking must be untouched');
  assert.strictEqual(rowOf(b.id).passed_at, null, 'nothing was sent, so nothing is stamped');
});

test('a job goes to a driver or to an operator, never both', async () => {
  const op = seedOperator({ email: 'both@apd.example.com' });
  const drv = seedDriver();
  const b = seedBooking();
  const r = await dispatch(b.id, { operator_id: op.id, driver_id: drv.id });
  assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).operator_id, null);
  assert.strictEqual(rowOf(b.id).driver_id, null);
});

test('only a flagged, active operator can be sent one', async () => {
  const plain = seedOperator({ flag: 0, email: 'plain@example.com' });
  const gone  = seedOperator({ active: 0, email: 'gone@example.com' });
  const b = seedBooking();
  for (const [id, who] of [[plain.id, 'an ordinary customer'], [gone.id, 'a closed account'],
                           [999999, 'nobody at all']]) {
    const r = await dispatch(b.id, { operator_id: id });
    assert.strictEqual(r.statusCode, 404, 'a job was passed to ' + who);
  }
});

test('"save this driver" cannot smuggle an operator into the drivers list', async () => {
  const op = seedOperator({ email: 'nosave@apd.example.com' });
  const b = seedBooking();
  await dispatch(b.id, { operator_id: op.id, save_driver: true });
  const u = db.prepare('SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = ?').get('nosave@apd.example.com');
  assert.strictEqual(u.n, 0, 'the operator was saved as a driver — it would get a commission rate');
});

test('the audit log says it was an operator job', async () => {
  const op = seedOperator({ email: 'audit@apd.example.com' });
  const b = seedBooking();
  await dispatch(b.id, { operator_id: op.id });
  const log = db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'job_dispatched%' ORDER BY id DESC").get();
  assert.strictEqual(log.action, 'job_dispatched_operator',
    'it is logged as an ordinary dispatch — the two settle differently and the log should say which');
  assert.ok(/no commission/i.test(log.detail), 'and the detail should say so: ' + log.detail);
});

// ── 3. THE EMAIL SAYS WHAT IT IS ─────────────────────────────────────────
console.log('\nThe email an operator gets');

test('it is a job REQUEST, with the fare and no payout', async () => {
  const op = seedOperator({ email: 'mail@apd.example.com' });
  const b = seedBooking({ fare: 96 });
  SENT.length = 0;
  await dispatch(b.id, { operator_id: op.id });
  const m = mailTo('mail@apd.example.com');
  assert.ok(m, 'no email');
  assert.ok(/Job request/i.test(m.subject), 'the subject should not promise a payout: ' + m.subject);
  assert.ok(!/to you/i.test(m.subject), 'nobody is paying them £96: ' + m.subject);
  assert.ok(/£96\.00/.test(m.html), 'the fare belongs on it');
  /* NO DEDUCTION — the ROW, not the word. The block must not take anything off
     the fare; saying "no commission is taken on this job" is the opposite of
     the failure, so it is the sentence this looks for. */
  assert.ok(!/−£/.test(m.html), 'something was deducted from an operator job: ' + m.html.match(/−£[0-9.]+/));
  assert.ok(!/>Commission[^<]*\(/.test(m.html), 'a commission row appeared on an operator job');
  assert.ok(!/Total<\/td>/.test(m.html), 'and there is no "total to you" on a job that settles by invoice');
  assert.ok(/no commission is taken/i.test(m.html) && /settled by invoice/i.test(m.html),
    'and it must say how this one settles');
});

test('a CASH operator job says who collects it', async () => {
  const op = seedOperator({ email: 'cash@apd.example.com' });
  const b = seedBooking({ fare: 80, payment: 'cash' });
  SENT.length = 0;
  await dispatch(b.id, { operator_id: op.id });
  const m = mailTo('cash@apd.example.com');
  assert.ok(/collect £80\.00/i.test(m.html), 'the amount to collect is missing: cash is collected at the kerb');
  assert.ok(!/next payout/i.test(m.html), 'an operator has no payout to carry a fee to');
});

test('a DRIVER’s email still names the rate that was actually charged', async () => {
  /* It said "Commission (10%)" whatever had been deducted — so a driver on a
     different rate, or a cover job at nothing, read a percentage that was not
     his. */
  const drv = seedDriver();
  const b = seedBooking({ fare: 200 });
  SENT.length = 0;
  await dispatch(b.id, { driver_id: drv.id, commission_pct: 12.5 });
  const m = mailTo(drv.email);
  assert.ok(m, 'the driver was not emailed');
  assert.ok(/Commission \(12\.5%\)/.test(m.html), 'the email names a rate that was not charged');
  assert.ok(/£25\.00/.test(m.html), 'and the figure beside it: 12.5% of £200');

  const b2 = seedBooking({ fare: 200 });
  SENT.length = 0;
  await dispatch(b2.id, { driver_id: drv.id, charge_commission: false });
  const m2 = mailTo(drv.email);
  assert.ok(!/Commission/.test(m2.html),
    'a cover job printed a commission row — "Commission (10%) −£0.00" is a contradiction');
  assert.ok(/£200\.00/.test(m2.html), 'the whole fare reaches him');
});

// ── 4. AND THEN IT IS INVOICED ───────────────────────────────────────────
console.log('\nAnd then it is invoiced');

test('the operator’s page lists what we have passed them', async () => {
  const op = seedOperator({ email: 'page@apd.example.com' });
  const b = seedBooking({ fare: 140 });
  await dispatch(b.id, { operator_id: op.id });
  const r = await call(api, 'get', '/operators/:id', { params: { id: String(op.id) } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const job = (r.body.jobs || []).filter((j) => j.id === b.id)[0];
  assert.ok(job, 'the job we just passed them is not on their page');
  assert.strictEqual(job.invoiced, false, 'and it has not been billed yet');
  assert.strictEqual(r.body.uninvoiced, 1, 'the count of what is waiting to be billed');
  /* The money on that page is still the invoices, not a balance. */
  assert.strictEqual(r.body.owed, 0, 'passing a job must not make an operator owe anything');
});

test('the invoice raised from it STAMPS the jobs, so none is billed twice', async () => {
  const op = seedOperator({ email: 'bill@apd.example.com' });
  const b1 = seedBooking({ fare: 95 });
  const b2 = seedBooking({ fare: 120 });
  await dispatch(b1.id, { operator_id: op.id });
  await dispatch(b2.id, { operator_id: op.id });

  const r = await call(api, 'post', '/invoices/bespoke', { body: {
    recipient: { name: 'Airport Direct', email: 'bill@apd.example.com' },
    items: [{ date: '2026-10-02', description: 'Steyning → Gatwick', amount: 95 },
            { date: '2026-10-02', description: 'Steyning → Gatwick', amount: 120 }],
    booking_ids: [b1.id, b2.id], send_email: false
  }});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const inv = db.prepare('SELECT id FROM invoices WHERE invoice_no = ?').get(r.body.invoiceNo);
  assert.strictEqual(rowOf(b1.id).operator_invoice_id, inv.id, 'the job was not marked as billed');
  assert.strictEqual(rowOf(b2.id).operator_invoice_id, inv.id);

  const after = await call(api, 'get', '/operators/:id', { params: { id: String(op.id) } });
  assert.strictEqual(after.body.uninvoiced, 0, 'the page still offers them for invoicing');
  assert.ok((after.body.jobs || []).every((j) => j.invoiced), 'both should read as invoiced');

  /* AND A SECOND INVOICE CANNOT CLAIM THEM. The stamp is only written where
     there is none, so a later invoice does not quietly re-point a job that has
     already gone out on one. */
  const r2 = await call(api, 'post', '/invoices/bespoke', { body: {
    recipient: { name: 'Airport Direct', email: 'bill@apd.example.com' },
    items: [{ date: '2026-10-02', description: 'Steyning → Gatwick', amount: 95 }],
    booking_ids: [b1.id], send_email: false
  }});
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(rowOf(b1.id).operator_invoice_id, inv.id,
    'the second invoice took a job the first one had already billed');
});

test('a cancelled job is not offered for invoicing', async () => {
  const op = seedOperator({ email: 'cancel@apd.example.com' });
  const b = seedBooking({ fare: 70 });
  await dispatch(b.id, { operator_id: op.id });
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  const r = await call(api, 'get', '/operators/:id', { params: { id: String(op.id) } });
  assert.ok(!(r.body.jobs || []).some((j) => j.id === b.id), 'a cancelled job is still on the list');
  assert.strictEqual(r.body.uninvoiced, 0, 'and it must not be counted as work to bill');
});

// ── 5. THE SCREENS ───────────────────────────────────────────────────────
console.log('\nThe screens the owner uses');

test('the send sheet asks who the job is going to', () => {
  const H = read('westmere-owner.html');
  /* The two buttons are built by one function, so the ids are assembled rather
     than written out — assert the thing that is actually in the file. */
  assert.ok(/kindBtn\('driver', 'A driver'\)/.test(H) && /kindBtn\('operator', 'An operator'\)/.test(H),
    'there is no choice between a driver and an operator');
  assert.ok(/id="disp-kind-' \+ kind \+ '"/.test(H), 'and the buttons must be addressable');
  assert.ok(/id="disp-operator"/.test(H), 'and no way to pick which operator');
  const open = fnBody(strip(H), 'dispOpen');
  assert.ok(/\/api\/operators/.test(open), 'the sheet must load the operators to offer');
  const kind = fnBody(strip(H), 'dispSetKind');
  assert.ok(/disp-save-wrap/.test(kind),
    'the "save this driver" tick must go away for an operator — it would give another firm a commission rate');
});

test('the confirm step does not offer a commission on an operator job', () => {
  const H = read('westmere-owner.html');
  const review = fnBody(strip(H), 'dispReview');
  assert.ok(/dispOperatorMoneyHtml\(\)/.test(review), 'the operator has no money block of its own');
  assert.ok(/if \(!operator\) dispBindComm\(\)/.test(review),
    'the commission chooser must not be wired up for an operator');
  const payload = review.slice(review.indexOf('_DISPATCH.payload'));
  assert.ok(/operator_id: operator\.id/.test(payload), 'the payload must name the operator');
  /* AND NOT THE OTHER THING. A commission field in the operator branch would
     be refused by the server, which is the right answer to the wrong request. */
  const opBranch = payload.slice(0, payload.indexOf('} : {'));
  assert.ok(!/commission/.test(opBranch), 'the operator payload asks for a commission: ' + opBranch);
  const money = fnBody(strip(H), 'dispOperatorMoneyHtml');
  assert.ok(/settled by invoice/i.test(money), 'it must say how the job settles');
  assert.ok(!/toFixed|\* *0\.1|\/ *10\b/.test(money),
    'the sheet is doing its own arithmetic — every figure here comes from the server');
});

test('a sent operator job offers the invoice there and then', () => {
  const H = read('westmere-owner.html');
  const send = fnBody(strip(H), 'dispSend');
  assert.ok(/if \(d\.operator\) \{ dispOperatorSent\(d\); return; \}/.test(send.replace(/\s+/g, ' ')),
    'after passing a job on, the one thing left to do is bill it');
  const done = fnBody(strip(H), 'dispOperatorSent');
  assert.ok(/owOperatorInvoiceFor\(op\.id\)/.test(done), 'and "Create invoice" must actually go there');
  assert.ok(/Later/.test(done), 'with a real way to say not now');
});

test('the operator page passes a job itself, instead of explaining how to', () => {
  const H = read('westmere-owner.html');
  const fn = fnBody(strip(H), 'owOperatorSendJob');
  assert.ok(!/showToast\('Open the job/.test(fn), 'it still tells him to go and do it himself');
  assert.ok(/\/api\/bookings/.test(fn), 'it must offer the jobs that could be passed on');
  assert.ok(/dispOpen\(/.test(fn) && /dispSetKind\('operator'\)/.test(fn),
    'and open the send sheet with this operator already chosen');
  assert.ok(/!b\.driver_id && !b\.operator_id/.test(fn),
    'a job that has already been sent must not be offered again');
  /* "TODAY" IS A UK DATE. toISOString() is UTC, which is yesterday between
     midnight and one in the morning British summer time — the hour the airport
     runs are booked for. */
  assert.ok(/sv-SE/.test(fn) && /Europe\/London/.test(fn),
    'the diary cut-off must be the UK date, not the UTC one');
  assert.ok(!/toISOString\(\)\.split/.test(fn), 'and never toISOString for a date');
});

test('Create invoice fills the form with the work that has not been billed', () => {
  const H = read('westmere-owner.html');
  const fn = fnBody(strip(H), 'owOperatorInvoiceFor');
  assert.ok(/filter\(function \(j\) \{ return !j\.invoiced; \}\)/.test(fn),
    'it must offer only the jobs that have not been invoiced');
  assert.ok(/invAddItem\(/.test(fn), 'and put them on the form as lines');
  assert.ok(/_INV_BOOKING_IDS = jobs\.map/.test(fn),
    'and remember which jobs they were, so the invoice can stamp them');
  assert.ok(/inv-rec-name/.test(fn), 'with the operator as the recipient');
  const build = /function invBuildRequest\(sendEmail\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/body\.booking_ids=_INV_BOOKING_IDS/.test(build.replace(/\s/g, '')),
    'and the request must carry them');
});

test('an operator still has no commission balance anywhere on the page', () => {
  /* The whole point of the arrangement: operators settle by invoice. A balance
     on this page would be a second, disagreeing account of the same money. */
  const H = strip(read('westmere-owner.html'));
  const i = H.indexOf('async function owOperatorLoad');
  const page = H.slice(i, H.indexOf('\n}', i));
  assert.ok(!/\/settlements|\/ledger|driverBalance/.test(page),
    'the operator page is reading a driver ledger');
  assert.ok(/What they owe/.test(page) && /invoices they have not paid/i.test(page),
    'and it must still say what the figure is');
});

test('the new lists do not fall over when the address module has not loaded', () => {
  /* `WMAddr && WMAddr.briefDisplay` does not test for the module — it THROWS
     when the module was never declared, which is the cold-start case the app
     has a local fallback for. The operator page rendered "Loading…" and
     nothing else. Every other caller in this app asks `window.WMAddr`. */
  /* Per LINE, because the safe form tests and then uses it in one expression:
     `window.WMAddr ? WMAddr.shortDisplay(a) : _localShort(a)`. Counting the two
     spellings against each other passed or failed on that ratio instead. */
  const H = strip(read('westmere-owner.html'));
  const offenders = H.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(^|[^.\w])WMAddr\b/.test(l) && !/window\.WMAddr/.test(l));
  assert.strictEqual(offenders.length, 0,
    'WMAddr is read without checking window.WMAddr on the same line — it throws on a cold start, line '
    + offenders.map(([n]) => n).join(', '));
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('operator-dispatch.test.js'),
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
