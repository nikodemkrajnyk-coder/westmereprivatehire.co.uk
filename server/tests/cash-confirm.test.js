/**
 * A MACHINE CANNOT CHOOSE CASH FOR THE CUSTOMER — run with:
 *   node server/tests/cash-confirm.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   A live booking flipped itself to "pay the driver" twice in one day —
 *   07:55:07 and 17:24:49 — each time recorded as payment_cash_chosen from the
 *   tokenised email link with user_id 0. Each flip undid the card option the
 *   owner had restored minutes earlier, so the customer's card payment "still
 *   didn't work": it kept being un-selected underneath him.
 *
 *   The GET was innocent — it only ever rendered a page. The page was not. It
 *   carried <form method="POST"> with no action, so it posted back to the same
 *   URL with the pay_token already in it, and the POST asked for nothing the
 *   URL had not already supplied. Anything that fetched the page and submitted
 *   its form chose cash on the customer's behalf, which is precisely what
 *   corporate mail-security scanners do to links they are sent.
 *
 * WHAT IS GUARDED
 *   1. A GET changes nothing — no payment write, no audit row.
 *   2. There is no form on the page for anything to submit.
 *   3. A POST without the signed click token changes nothing and audits nothing.
 *   4. Neither does a replayed, tampered, expired, or other-booking token.
 *   5. A real click still works — the customer can genuinely choose cash.
 *   6. The page offers the card route as well, so opening the wrong link is
 *      not a decision.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-cash-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });

const confirmToken = require('../confirm-token');
const publicApi = require('../public-api');

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader() { return this; }, type() { return this; }, set() { return this; }
  };
}
async function call(method, routePath, opts) {
  const l = publicApi.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  const req = Object.assign({ params: {}, query: {}, body: {}, ip: '203.0.113.9' }, opts || {});
  const r = res();
  const hs = l.route.stack.map((x) => x.handle);
  let i = 0;
  const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
  await next();
  return r;
}

let seq = 0;
const TOKEN = 'tok_secret_value';
function seed(over) {
  const o = Object.assign({ payment: 'pending', status: 'pending', paid_at: null }, over || {});
  const ref = 'WM-CASH' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,pay_token,paid_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Worthing', 'Gatwick', '2026-12-01', '09:00', 1, 96, o.payment, o.status, TOKEN, o.paid_at);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (ref) => db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
const cashAudits = (ref) => db.prepare(
  "SELECT COUNT(*) c FROM audit_log WHERE action = 'payment_cash_chosen' AND detail LIKE ?").get(ref + '%').c;

const getCash  = (ref) => call('get',  '/pay/:ref/cash', { params: { ref }, query: { t: TOKEN } });
const postCash = (ref, body) => call('post', '/pay/:ref/cash', { params: { ref }, query: { t: TOKEN }, body: body || {} });

// ── 1. OPENING THE LINK IS NOT CHOOSING. ─────────────────────────────────
console.log('\nOpening the link decides nothing');

test('a GET leaves the booking exactly as it was', async () => {
  const b = seed({});
  const before = rowOf(b.ref);
  await getCash(b.ref);
  const after = rowOf(b.ref);
  assert.strictEqual(after.payment, before.payment,
    'merely opening the cash link changed the payment method to ' + after.payment);
  assert.strictEqual(after.status, before.status, 'opening the link changed the status');
  assert.strictEqual(cashAudits(b.ref), 0, 'opening the link recorded a cash choice');
});

test('and there is no form on the page for a scanner to submit', async () => {
  const b = seed({});
  const r = await getCash(b.ref);
  const html = String(r.body || '');
  assert.ok(!/<form/i.test(html),
    'the page still carries a form — a mail scanner that submits forms will choose cash again, '
    + 'which is exactly what flipped the live booking twice in one day');
  assert.ok(/id="cash-confirm"/.test(html), 'the cash option is missing from the page altogether');
});

test('the page offers the card route too, so opening it is not a decision', async () => {
  const b = seed({});
  const html = String((await getCash(b.ref)).body || '');
  assert.ok(/westmere-pay\.html\?ref=/.test(html),
    'the choice page does not offer paying by card — a customer who opened the wrong link '
    + 'from the email has no way back to the card form');
  assert.ok(/by card now/i.test(html), 'the card option has no label');
});

// ── 2. A POST WITHOUT A CLICK IS NOT A CHOICE. ───────────────────────────
console.log('\nOnly a real click writes anything');

test('a bare POST — what submitting the old form did — changes nothing', async () => {
  const b = seed({});
  const r = await postCash(b.ref, {});
  assert.strictEqual(rowOf(b.ref).payment, 'pending',
    'a POST with no click token still chose cash — the hole is open');
  assert.strictEqual(cashAudits(b.ref), 0, 'it was even audited as the customer choosing');
  assert.strictEqual(r.statusCode, 400, 'expected a refusal, got ' + r.statusCode);
});

test('nor does a token minted for a different booking', async () => {
  const mine = seed({});
  const other = seed({});
  await postCash(mine.ref, { confirm: confirmToken.mint(other.ref) });
  assert.strictEqual(rowOf(mine.ref).payment, 'pending',
    "another booking's click token chose cash on this one");
});

test('nor a tampered one, nor an expired one', async () => {
  const b = seed({});
  const good = confirmToken.mint(b.ref);
  await postCash(b.ref, { confirm: good.replace(/.$/, good.slice(-1) === '0' ? '1' : '0') });
  assert.strictEqual(rowOf(b.ref).payment, 'pending', 'a tampered click token was accepted');

  const stale = confirmToken.mint(b.ref, Date.now() - 2 * confirmToken.TTL_MS);
  await postCash(b.ref, { confirm: stale });
  assert.strictEqual(rowOf(b.ref).payment, 'pending',
    'an expired click token was accepted — a token lifted from an old page would still work');
  assert.strictEqual(cashAudits(b.ref), 0, 'a refused attempt was audited as a real choice');
});

test('the token cannot be derived from what the email contains', async () => {
  /* The pay_token is in the email and in the URL. If it were enough to mint or
     pass as a click token, everything above would be theatre. */
  const b = seed({});
  for (const guess of [TOKEN, b.ref, b.ref + '.' + TOKEN, 'true', '1']) {
    await postCash(b.ref, { confirm: guess });
    assert.strictEqual(rowOf(b.ref).payment, 'pending',
      'the click token was guessable from the email: ' + guess);
  }
});

// ── 3. THE CUSTOMER CAN STILL CHOOSE. ────────────────────────────────────
console.log('\nAnd the customer can still genuinely choose to pay the driver');

test('the token the page was rendered with is accepted', async () => {
  const b = seed({});
  const html = String((await getCash(b.ref)).body || '');
  const m = /confirm:\s*"([^"]+)"/.exec(html);
  assert.ok(m, 'the page does not carry a click token for its own button to send');
  await postCash(b.ref, { confirm: m[1] });
  const after = rowOf(b.ref);
  assert.strictEqual(after.payment, 'cash',
    'a real click no longer records the choice — the customer cannot pay the driver');
  assert.strictEqual(after.status, 'awaiting_payment', 'the booking did not move on the choice');
  assert.strictEqual(cashAudits(b.ref), 1, 'the genuine choice was not audited');
});

test('a second click does not double-audit', async () => {
  const b = seed({});
  const html = String((await getCash(b.ref)).body || '');
  const tok = /confirm:\s*"([^"]+)"/.exec(html)[1];
  await postCash(b.ref, { confirm: tok });
  await postCash(b.ref, { confirm: tok });
  assert.strictEqual(cashAudits(b.ref), 1,
    'clicking twice recorded the choice twice');
});

// ── 4. THE LINK IN THE EMAIL IS STILL A PLAIN GET. ───────────────────────
console.log('\nThe email link is a GET, and must stay harmless');

test('the emails send the cash URL as an ordinary link', () => {
  const email = fs.readFileSync(path.join(__dirname, '..', 'email.js'), 'utf8');
  const urls = email.match(/\/api\/public\/pay\/\$\{[^}]+\}\/cash\?t=/g) || [];
  assert.ok(urls.length >= 1, 'the cash link is no longer in the emails at all');
  /* Which is fine — and must stay fine. Anything that follows it gets a page.
     That is the whole contract, and test 1 is what holds the server to it. */
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('cash-confirm.test.js'),
    'add it to npm test or it will not run again');
});

test('the page never says the choice is already made', async () => {
  /* WHAT BEN SAW. The page he landed on was headed "Pay on the day" and read
     "You have chosen to settle the fare of £96.00 with your driver" — above a
     single button to agree with it, and no card option anywhere. He had chosen
     nothing; he had opened a link. Reporting a decision back to somebody who
     has not made one is how he ended up on the cash path over and over. */
  const b = seed({});
  const html = String((await getCash(b.ref)).body || '');
  assert.ok(!/You have chosen/i.test(html),
    'the page still tells the customer he has chosen something merely for opening a link');
  assert.ok(!/>Pay on the day</i.test(html),
    'the heading still announces the cash outcome before he has picked anything');
  assert.ok(/how would you like/i.test(html), 'the page does not actually ask him');
});

test('card is the primary action on the page, cash the alternative', async () => {
  const b = seed({});
  const html = String((await getCash(b.ref)).body || '');
  const card = html.indexOf('westmere-pay.html');
  const cash = html.indexOf('id="cash-confirm"');
  assert.ok(card > -1 && cash > -1, 'both options must be present');
  assert.ok(card < cash, 'the cash option comes before the card one — card is the primary route');
  /* Filled navy for card, outlined for cash: the same primary/secondary pairing
     the emails use, so the two surfaces do not disagree about which is which. */
  const cardBtn = html.slice(card - 400, card + 400);
  assert.ok(/background:var\(--navy\)/.test(cardBtn), 'the card action is not styled as the primary one');
});

test("the emails' primary button goes to the CARD page, not the cash link", () => {
  /* Including the payment reminder — the one being re-sent to unblock him. If
     the main call to action ever pointed at the cash link, every reminder would
     walk the customer back onto the path we are trying to get him off. */
  const email = fs.readFileSync(path.join(__dirname, '..', 'email.js'), 'utf8');
  const primaries = email.match(/actionBtn\(([a-zA-Z]+),[^\n]*'primary'\)/g) || [];
  assert.ok(primaries.length >= 4,
    'expected a primary payment button in each customer email, found ' + primaries.length);
  primaries.forEach((p) => {
    const url = /actionBtn\(([a-zA-Z]+),/.exec(p)[1];
    assert.strictEqual(url, 'payUrl',
      'a customer email leads with ' + url + ' instead of the card/choice page');
  });
  const secondaries = email.match(/actionBtn\(([a-zA-Z]+),[^\n]*'secondary'\)/g) || [];
  secondaries.forEach((p) => {
    const url = /actionBtn\(([a-zA-Z]+),/.exec(p)[1];
    assert.ok(url !== 'payUrl', 'the card page has been demoted to the secondary button');
  });
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
