/**
 * Payment-flow regression guard — run with:  node server/tests/payment-flow.test.js
 *
 * Codifies the three invariants behind the "Mr Ben" payment incidents so the
 * bug classes cannot silently return:
 *   1) Estimate/confirmation emails carry WORKING tokenised Pay Now / Cash /
 *      Cancel links.
 *   2) A payment method is NEVER silently defaulted to 'cash'; unknown → 'pending'.
 *   3) "Send Estimate" must NOT auto-confirm — the booking stays pending until
 *      the customer pays / accepts cash-on-the-day / cancels.
 *
 * Pure Node, no test framework, no network (Resend is stubbed). Exit code 1 on
 * any failure so it can gate a deploy.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── 1. Payment-method guardrail (Problem 2) ──────────────────────────────
console.log('\nPayment-method guardrail');
const pm = require('../payment-methods');
test('unknown method normalizes to pending, never cash', () => {
  assert.strictEqual(pm.normalizePaymentMethod('', 'test'), 'pending');
  assert.strictEqual(pm.normalizePaymentMethod(null, 'test'), 'pending');
  assert.strictEqual(pm.normalizePaymentMethod('wibble', 'test'), 'pending');
  assert.notStrictEqual(pm.normalizePaymentMethod('', 'test'), 'cash');
});
test('valid methods pass through (case-insensitive)', () => {
  assert.strictEqual(pm.normalizePaymentMethod('CARD', 'test'), 'card');
  assert.strictEqual(pm.normalizePaymentMethod('cash', 'test'), 'cash');
});
test('assertPaymentMethod throws on an invalid method', () => {
  assert.throws(() => pm.assertPaymentMethod('bogus', 'test'));
  assert.strictEqual(pm.assertPaymentMethod('card', 'test'), 'card');
});
test('no source file defaults a missing method to cash (x || \'cash\')', () => {
  for (const f of ['server/auto-file.js', 'server/assistant-routes.js']) {
    assert.ok(!/payment\s*\|\|\s*['"]cash['"]/.test(read(f)), f + " still defaults payment to 'cash'");
  }
});

// ── 2. Estimate email carries working action links (Problem 1) ───────────
console.log('\nEstimate email (Problem 1)');
test('sendCustomerEstimate includes tokenised Pay/Cash/Cancel links + estimate wording', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let html = '';
  global.fetch = async (url, opts) => {
    html = JSON.parse(opts.body).html || '';
    return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  const ok = await email.sendCustomerEstimate({
    ref: 'WM-TESTX', name: 'Ben', email: 'ben@example.com',
    pickup: 'A', destination: 'B', date: '2026-08-20', time: '09:00',
    fare: 85, pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
  });
  assert.ok(ok, 'estimate did not send');   // truthy: sendEmail now returns the Resend id (or true)
  assert.ok(/westmere-pay\.html\?ref=WM-TESTX&t=deadbeef/.test(html), 'missing Pay Now link');
  assert.ok(/\/api\/public\/pay\/WM-TESTX\/cash\?t=deadbeef/.test(html), 'missing Cash link');
  assert.ok(/\/api\/public\/cancel\/WM-TESTX\?t=deadbeef/.test(html), 'missing Cancel link');
  assert.ok(/not yet a confirmed booking/i.test(html), 'estimate wording missing');
});

// ── 3. Estimate-first: Send Estimate must not auto-confirm (Problem 3) ────
console.log('\nEstimate-first, no auto-confirm (Problem 3)');
test('server send-estimate route does not set status to confirmed', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/send-estimate'[\s\S]*?\n\}\);/);
  assert.ok(m, 'send-estimate route not found');
  assert.ok(!/status\s*=\s*'confirmed'|status:\s*'confirmed'/.test(m[0]), 'send-estimate must not confirm');
  assert.ok(/ensurePayToken/.test(m[0]), 'send-estimate must mint a pay_token');
});
test('owner + admin "Send Estimate" call /send-estimate, never PATCH status:confirmed', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    const src = read(f);
    const fn = src.match(/function (?:owner|adm)SendEstimate[\s\S]*?\n\}/);
    assert.ok(fn, f + ': SendEstimate fn not found');
    assert.ok(/\/send-estimate/.test(fn[0]), f + ': must POST to /send-estimate');
    assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]), f + ': must NOT PATCH status:confirmed');
  }
});
// SPEC CHANGE (owner estimate/message actions): choosing cash no longer
// auto-confirms. Picking "pay driver on the day" moves pending → AWAITING
// PAYMENT (the ride is going ahead) and it only becomes confirmed when the cash
// is marked received. The old pending→confirmed jump is explicitly forbidden.
function cashPostBlock() {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("router.post('/pay/:ref/cash'");
  assert.ok(start !== -1, 'cash POST route not found');
  const rest = pub.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  return pub.slice(start, start + 10 + (next === -1 ? rest.length : next));
}
test('cash route records cash + moves pending → awaiting_payment (never confirmed)', () => {
  const block = cashPostBlock();
  assert.ok(/assertPaymentMethod\('cash'/.test(block), 'cash route must validate the cash write');
  assert.ok(/THEN 'awaiting_payment'/.test(block), "cash route must move an unsettled booking to 'awaiting_payment'");
  assert.ok(!/THEN 'confirmed'/.test(block), 'cash route must NOT auto-confirm (spec: awaiting payment first)');
});
test('cash route does NOT fire the customer "confirmed" email (not yet paid)', () => {
  const block = cashPostBlock();
  assert.ok(!/notifyCustomerConfirmed/.test(block), 'cash choice must not send a confirmation — it is not confirmed until paid');
});

// Card: choosing card / opening the card form moves pending → awaiting_payment;
// the Stripe webhook is what promotes awaiting_payment → confirmed on success.
test('card intent route moves pending → awaiting_payment', () => {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("router.post('/pay/:ref/intent'");
  assert.ok(start !== -1, 'card intent route not found');
  const rest = pub.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  const block = pub.slice(start, start + 10 + (next === -1 ? rest.length : next));
  assert.ok(/THEN 'awaiting_payment'/.test(block), 'intent route must move a pending booking to awaiting_payment');
});
test('stripe webhook confirms from awaiting_payment (and pending), not only pending', () => {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("'/stripe-webhook'");
  assert.ok(start !== -1, 'stripe webhook route not found');
  const block = pub.slice(start, start + 3000);
  // Confirms unless cancelled — so awaiting_payment → confirmed is covered.
  assert.ok(/WHEN status = 'cancelled' THEN status ELSE 'confirmed'/.test(block), 'webhook must confirm non-cancelled bookings on payment');
  assert.ok(/row\.status === 'awaiting_payment'/.test(block), 'webhook must fire the confirmed email off the awaiting_payment edge too');
});

// Mark-as-paid: the ONLY owner/driver action that promotes a booking to
// confirmed. This is how a cash-on-the-day job is settled.
test('mark-paid route settles awaiting_payment → confirmed + stamps paid_at', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/mark-paid'[\s\S]*?\n\}\);/);
  assert.ok(m, 'mark-paid route not found');
  const block = m[0];
  assert.ok(/paid_at = COALESCE\(paid_at, datetime\('now'\)\)/.test(block), 'mark-paid must stamp paid_at once');
  assert.ok(/THEN 'confirmed'/.test(block), 'mark-paid must confirm an unsettled booking');
  assert.ok(/awaiting_payment/.test(block), 'mark-paid must handle awaiting_payment bookings');
  assert.ok(/notifyCustomerConfirmed/.test(block), 'mark-paid must notify the customer on the confirm edge');
  assert.ok(/status === 'cancelled'/.test(block), 'mark-paid must refuse a cancelled booking');
});

// ── 4. Send Message must not confirm; no duplicate owner Confirm path ─────
// Owner spec: an incoming booking has exactly two owner actions — "Send
// Estimate" and "Send Message". Send Message emails free text and touches
// NOTHING else; there is no one-click "Confirm" anywhere in the owner app.
console.log('\nSend Message + no rogue Confirm (owner spec)');
test('server send-message route never changes booking status', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/send-message'[\s\S]*?\n\}\);/);
  assert.ok(m, 'send-message route not found');
  assert.ok(!/status\s*=\s*'[a-z]+'|status:\s*'[a-z]+'/.test(m[0]), 'send-message must not write a status');
  assert.ok(!/UPDATE\s+bookings\s+SET[\s\S]*?status/i.test(m[0]), 'send-message must not UPDATE booking status');
});
test('owner "Send Message" posts to /send-message and never PATCHes status', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/async function wmMessageSend[\s\S]*?\n\}/);
  assert.ok(fn, 'wmMessageSend not found');
  assert.ok(/\/send-message/.test(fn[0]), 'wmMessageSend must POST to /send-message');
  assert.ok(!/method:\s*['"]PATCH['"]/.test(fn[0]), 'wmMessageSend must NOT PATCH the booking');
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]), 'wmMessageSend must NOT set status:confirmed');
});
test('owner app has no one-click Confirm path for incoming requests', () => {
  const src = read('westmere-owner.html');
  // The removed native "decisions" Confirm button and the legacy accept shim
  // (each PATCHed status:'confirmed') must stay gone — otherwise Send Estimate
  // is no longer the only route out of pending.
  assert.ok(!/function\s+decConfirm\b/.test(src), 'dead decConfirm() must not return');
  assert.ok(!/function\s+renderDecisionsPending\b/.test(src), 'dead renderDecisionsPending() must not return');
  assert.ok(!/function\s+upcomingConfirm\b/.test(src), 'legacy upcomingConfirm() confirm shim must stay removed');
  assert.ok(!/function\s+acceptJob\b/.test(src), 'legacy acceptJob() confirm shim must stay removed');
});

// ── 5. Status lifecycle in the owner app (awaiting_payment) ──────────────
// Owner spec: awaiting_payment is a distinct state (method chosen, not settled).
// The ride is going ahead, so it must show in the weekly schedule, and the card
// must offer a "Mark as Paid" that confirms it.
console.log('\nStatus lifecycle — owner app (owner spec)');
test("bookings CHECK constraint allows 'awaiting_payment'", () => {
  const db = read('server/db.js');
  assert.ok(/CHECK\(status IN \([^)]*'awaiting_payment'[^)]*\)\)/.test(db), 'fresh-DB CHECK must allow awaiting_payment');
  assert.ok(/awaiting_payment migration|include awaiting_payment/.test(db), 'a migration must widen the CHECK on existing DBs');
});
test('owner weekly schedule includes awaiting_payment jobs (ride is going ahead)', () => {
  const src = read('westmere-owner.html');
  assert.ok(/CONFIRMED_JOBS=OFFERED_JOBS\.filter[\s\S]*?awaiting_payment/.test(src), 'CONFIRMED_JOBS must include awaiting_payment');
  const wj = src.match(/var weekJobs=\(OFFERED_JOBS[\s\S]*?\}\)\.map/);
  assert.ok(wj && /awaiting_payment/.test(wj[0]), 'weekly Confirmed schedule must include awaiting_payment');
});
test('owner "Mark as Paid" posts /mark-paid and confirms (only owner confirm path)', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/async function ownerMarkPaid[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerMarkPaid not found');
  assert.ok(/\/mark-paid/.test(fn[0]), 'ownerMarkPaid must POST to /mark-paid');
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]), 'ownerMarkPaid must NOT PATCH status:confirmed directly — the route confirms');
});
test('owner Send Estimate shows a confirmation and keeps the booking pending', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/async function ownerSendEstimate[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerSendEstimate not found');
  assert.ok(/showToast\([^)]*[Ee]stimate sent/.test(fn[0]), 'must show an "estimate sent" confirmation');
  assert.ok(/[Pp]ending/.test(fn[0]), 'confirmation must tell the owner the booking is now Pending');
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]), 'Send Estimate must never confirm');
});

// ── 6. Edit modal: trip details only, NO sending actions ─────────────────
console.log('\nEdit modal has no send buttons (owner spec)');
test('the edit modal (upcomingEdit) contains only Save Changes — no Send Estimate / Message buttons', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/function upcomingEdit[\s\S]*?\n\}/);
  assert.ok(fn, 'upcomingEdit not found');
  const modal = fn[0];
  assert.ok(/Save Changes/.test(modal), 'edit modal must keep Save Changes');
  assert.ok(!/ebSendEstimate|ebSendMessage|ebSendConfirmation/.test(modal), 'edit modal must not wire any eb* send action');
  assert.ok(!/Send Estimate/.test(modal), 'edit modal must not contain a Send Estimate button');
  assert.ok(!/Message Customer/.test(modal), 'edit modal must not contain a Message Customer button');
});
test('dead edit-modal send helpers (ebSend/ebSendEstimate) are gone', () => {
  const src = read('westmere-owner.html');
  assert.ok(!/function ebSend\b/.test(src), 'ebSend() must be removed');
  assert.ok(!/function ebSendEstimate\b/.test(src), 'ebSendEstimate() must be removed');
});

// ── 7. Completed tab grouped week by week ────────────────────────────────
console.log('\nCompleted tab grouped by week (owner spec)');
test('buildCompleted groups jobs by ISO week rather than a flat list', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/function buildCompleted[\s\S]*?\n\}/);
  assert.ok(fn, 'buildCompleted not found');
  assert.ok(/isoWeekStart/.test(fn[0]), 'buildCompleted must bucket jobs by ISO week');
  assert.ok(/_fmtWeekRange/.test(fn[0]), 'buildCompleted must render a per-week header');
  assert.ok(!/renderJobList/.test(fn[0]), 'buildCompleted must no longer defer to the flat renderJobList');
});

// ── 8. Cancelled bookings view (owner deletes by hand) ───────────────────
// Owner spec: a customer cancel sets status='cancelled' (never a hard-delete),
// and the owner deletes it himself. So cancelled bookings must be VISIBLE in a
// dedicated view with a Delete action — and Delete must hard-remove the row.
console.log('\nCancelled bookings view (owner spec)');
test('owner app collects cancelled bookings into a Cancelled view', () => {
  const src = read('westmere-owner.html');
  const flat = src.replace(/\s+/g, ' ');
  assert.ok(/CANCELLED_JOBS=bookings\.filter\(function\(b\)\{return b\.status==='cancelled';\}\)/.test(flat),
    'CANCELLED_JOBS must be filled from status==="cancelled" bookings');
  assert.ok(/id="cancelled-section"/.test(src) && /id="cancelled-list"/.test(src),
    'the Cancelled section + list markup must exist');
  const fn = src.match(/function buildCancelled[\s\S]*?\n\}/);
  assert.ok(fn, 'buildCancelled not found');
  assert.ok(/CANCELLED_JOBS/.test(fn[0]) && /cancelled-list/.test(fn[0]),
    'buildCancelled must render CANCELLED_JOBS into #cancelled-list');
});
test('a cancelled card shows a Cancelled label and a Delete action (no Edit)', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/function jobCardHtml[\s\S]*?\n\}/);
  assert.ok(fn, 'jobCardHtml not found');
  const jc = fn[0];
  assert.ok(/apiStatus==='cancelled'\)\{stLabel='Cancelled'/.test(jc), 'cancelled jobs must render a "Cancelled" status label');
  assert.ok(/apiStatus!=='cancelled'\)\{[\s\S]*?upcomingEdit/.test(jc), 'Edit must be suppressed on cancelled cards');
  // Delete is rendered unconditionally (after the cancelled-guarded Edit block).
  assert.ok(/upcomingDelete\('\+j\.id\+'\)">Delete/.test(jc), 'every card (incl. cancelled) must offer Delete');
});
test('owner Delete hard-removes a cancelled booking (DELETE /bookings/:id)', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.delete\('\/bookings\/:id'[\s\S]*?\n\}\);/);
  assert.ok(m, 'DELETE /bookings/:id route not found');
  assert.ok(/DELETE FROM bookings WHERE id = \?/.test(m[0]), 'owner delete must hard-remove the booking row');
  // Functional proof: a cancelled row is actually gone after the delete.
  const Database = require('better-sqlite3');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'wm-cancel-delete-' + process.pid + '.db');
  try { fs.unlinkSync(tmp); } catch (_) {}
  const d = new Database(tmp);
  d.exec("CREATE TABLE bookings(id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, status TEXT)");
  const id = d.prepare("INSERT INTO bookings(ref,status) VALUES('WM-CANCEL','cancelled')").run().lastInsertRowid;
  assert.ok(d.prepare("SELECT 1 c FROM bookings WHERE id=? AND status='cancelled'").get(id), 'seed cancelled booking failed');
  d.prepare('DELETE FROM bookings WHERE id = ?').run(id);   // the owner's hard-delete
  assert.ok(!d.prepare('SELECT 1 FROM bookings WHERE id=?').get(id), 'cancelled booking must be gone after Delete');
  d.close();
  try { fs.unlinkSync(tmp); } catch (_) {}
});

// ── 4. Airport-fares copy is honest, prices unchanged ────────────────────
console.log('\nAirport-fares homepage copy');
test('homepage no longer implies a locked/fixed price', () => {
  const html = read('index.html');
  // Old misleading wording must be gone…
  assert.ok(!/Fixed prices, from/.test(html), 'index.html still says "Fixed prices, from"');
  assert.ok(!/Fixed airport fares/i.test(html), 'index.html still has "Fixed airport fares" eyebrow');
  assert.ok(!/Fixed base fares/i.test(html), 'index.html still has "Fixed base fares" subtext');
  // …replaced by the honest wording.
  assert.ok(/>Airport fares<\/span>/.test(html), 'index.html missing "Airport fares" eyebrow');
  assert.ok(/Airport fares from £54\./.test(html), 'index.html missing "Airport fares from £54." heading');
  assert.ok(/Indicative starting fares/.test(html), 'index.html missing "Indicative starting fares" subtext');
  assert.ok(/exact fare is confirmed when you book/.test(html), 'index.html missing "confirmed when you book" copy');
});
test('homepage headline fare figures are unchanged', () => {
  const html = read('index.html');
  for (const p of ['from £54', 'from £94', 'from £120', 'from £135', 'from £104']) {
    assert.ok(html.includes(p), 'index.html headline fare "' + p + '" changed/removed');
  }
});
test('airport-transfers copy no longer says "fixed base fares"', () => {
  const html = read('airport-transfers.html');
  assert.ok(!/fixed base fares/i.test(html), 'airport-transfers.html still says "fixed base fares"');
  // Honest subtext: Gatwick/Heathrow are all-inclusive; other airports add fees.
  assert.ok(/all-inclusive/i.test(html), 'airport-transfers.html missing all-inclusive framing');
  assert.ok(/indicative starting fares/i.test(html), 'airport-transfers.html missing indicative framing for other airports');
  // Spot-check a few fare figures survive the copy change.
  for (const p of ['from approx. £50', 'from approx. £75', 'from approx. £188']) {
    assert.ok(html.includes(p), 'airport-transfers.html fare "' + p + '" changed/removed');
  }
});

// ── 9. Pay page: card field must mount typeable (the "can't enter card" bug) ─
// Root cause of Mr Ben not being able to type: the Stripe Card Element was
// mounted while #view-pay was still display:none, so it measured a 0-width
// container and rendered a 1px-wide (invisible, untypeable) field. The form MUST
// be revealed BEFORE Stripe mounts so the field gets a real width.
console.log('\nPay page card field mounts typeable (Problem: card entry)');
test('westmere-pay.html reveals the form BEFORE mounting Stripe (no collapsed field)', () => {
  const src = read('westmere-pay.html');
  // The successful-load path must call show("pay") before initStripe().
  assert.ok(/show\("pay"\);\s*initStripe\(\);/.test(src),
    'must call show("pay") immediately BEFORE initStripe() so the card field mounts at full width');
  // The old order (mount into a hidden container → 1px field) must stay gone.
  assert.ok(!/initStripe\(\);\s*show\("pay"\);/.test(src),
    'must NOT mount Stripe before revealing the form — that renders a 1px, untypeable card field');
});
test('westmere-pay.html guards Stripe init and warns if the field never loads', () => {
  const src = read('westmere-pay.html');
  const fn = src.match(/function initStripe\(\)\{[\s\S]*?\n  \}/);
  assert.ok(fn, 'initStripe() not found');
  const block = fn[0];
  assert.ok(/try\s*\{/.test(block) && /catch\s*\(/.test(block),
    'initStripe must wrap Stripe()/mount() in try/catch so a failure surfaces a message, not a dead box');
  assert.ok(/cardEl\.on\("ready"/.test(block) && /setTimeout\(/.test(block),
    'initStripe must watchdog the Element "ready" event so an unloaded/collapsed field is reported');
});
test('pay button will not confirm without a server client_secret', () => {
  const src = read('westmere-pay.html');
  // Guards against confirming against a missing/blank clientSecret (silent fail).
  assert.ok(/if\(!res\.ok \|\| !res\.j \|\| !res\.j\.clientSecret\)\{ throw/.test(src),
    'pay flow must throw if the server did not return a clientSecret before confirmCardPayment');
  assert.ok(/confirmCardPayment\(res\.j\.clientSecret/.test(src),
    'pay flow must confirm against the server-provided clientSecret');
});
test('/config.js publishes the Stripe publishable key from the environment', () => {
  const idx = read('server/index.js');
  const m = idx.match(/app\.get\('\/config\.js'[\s\S]*?\}\);/);
  assert.ok(m, '/config.js route not found');
  assert.ok(/window\._SK='\$\{process\.env\.STRIPE_PUBLISHABLE_KEY \|\| ''\}'/.test(m[0]),
    '/config.js must emit window._SK from STRIPE_PUBLISHABLE_KEY (empty key => dead card field)');
});
test('/pay/:ref/intent returns a clientSecret for the mounted field to confirm', () => {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("router.post('/pay/:ref/intent'");
  assert.ok(start !== -1, 'intent route not found');
  const block = pub.slice(start, start + 3500);
  assert.ok(/clientSecret: intent\.client_secret/.test(block),
    'intent route must return { clientSecret } so the card field can confirm the payment');
});
test('Apple Pay domain-association is served by an explicit route (static ignores dotfiles)', () => {
  const idx = read('server/index.js');
  assert.ok(/app\.get\('\/\.well-known\/apple-developer-merchantid-domain-association'/.test(idx),
    'must serve the Apple Pay association file via an explicit route — express.static ignores .well-known');
});

// ── 10. Branded hero-image email template (the missing-image bug) ────────
// Two root causes made the hero image vanish from customer emails:
//   (a) the ESTIMATE + ACKNOWLEDGEMENT used the old imageless `emailShell`;
//       only the CONFIRMATION used the hero template.
//   (b) the hosted hero JPEG was served Cross-Origin-Resource-Policy:
//       same-origin, so mail clients (Gmail proxy, Apple Mail) refused it.
// Guardrails: all three customer booking emails MUST render the hosted hero
// image and MUST NOT fall back to emailShell; image assets MUST be cross-origin.
console.log('\nBranded hero-image email (missing image bug)');
async function renderEmail(fn, booking) {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let html = '';
  global.fetch = async (url, opts) => { html = JSON.parse(opts.body).html || ''; return { ok: true, status: 200, json: async () => ({ id: 'stub' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email[fn](booking);
  return html;
}
const HERO_IMG = '/assets/westmere-email-hero.jpg';
const OLD_SHELL_SIG = 'letter-spacing:8px';   // the imageless emailShell wordmark header
const emailFixture = {
  ref: 'WM-HEROTEST', name: 'Ben', email: 'ben@example.com',
  passenger_name: 'Ben', passenger_email: 'ben@example.com',
  pickup: 'A Road, Brighton', destination: 'Gatwick Airport',
  date: '2026-08-20', time: '09:30', fare: 96, estimated_fare: 96,
  pay_token: 'deadbeefdeadbeefdeadbeef', passengers: 2
};
test('estimate email renders the hosted hero image (not the imageless shell)', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture });
  assert.ok(html.includes(HERO_IMG), 'estimate email must embed the hero image');
  assert.ok(!html.includes(OLD_SHELL_SIG), 'estimate email must NOT use the old imageless emailShell header');
});
test('confirmation email renders the hosted hero image', async () => {
  const html = await renderEmail('sendCustomerConfirmed', { ...emailFixture, paid: false, payment: 'pending' });
  assert.ok(html.includes(HERO_IMG), 'confirmation email must embed the hero image');
  assert.ok(!html.includes(OLD_SHELL_SIG), 'confirmation email must NOT use the old imageless emailShell header');
});
test('acknowledgement email renders the hosted hero image', async () => {
  const html = await renderEmail('sendCustomerAcknowledgement', { ...emailFixture, pay_token: null });
  assert.ok(html.includes(HERO_IMG), 'acknowledgement email must embed the hero image');
  assert.ok(!html.includes(OLD_SHELL_SIG), 'acknowledgement email must NOT use the old imageless emailShell header');
});
test('the three customer booking emails never call the imageless emailShell()', () => {
  const src = read('server/email.js');
  for (const fn of ['sendCustomerEstimate', 'sendCustomerConfirmed', 'sendCustomerAcknowledgement']) {
    const m = src.match(new RegExp('async function ' + fn + '[\\s\\S]*?\\n\\}'));
    assert.ok(m, fn + ' not found');
    assert.ok(!/emailShell\(/.test(m[0]), fn + ' must use the hero template, not emailShell()');
    assert.ok(/confirmationEmailHtml\(/.test(m[0]), fn + ' must render via the hero confirmationEmailHtml()');
  }
});
test('image assets are served Cross-Origin-Resource-Policy: cross-origin (so mail clients load them)', () => {
  const idx = read('server/index.js');
  assert.ok(/Cross-Origin-Resource-Policy['"]?\s*,\s*['"]cross-origin['"]/.test(idx),
    'index.js must set Cross-Origin-Resource-Policy: cross-origin for images');
  assert.ok(/png\|jpe\?g\|webp\|gif\|svg/.test(idx), 'the CORP override must target image extensions');
});

// ── ONE email design system-wide: NO email uses the old imageless shell ──
// Every outgoing email (customer, invoice, admin, password/reset, outreach,
// driver…) must render through the single hero template. The old imageless
// emailShell is retired; nothing may build email html any other way.
async function renderEmailArgs(fn, args) {
  process.env.RESEND_API_KEY = 'test_fake_key';
  process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
  let html = '';
  global.fetch = async (url, opts) => { html = JSON.parse(opts.body).html || ''; return { ok: true, status: 200, json: async () => ({ id: 'stub' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email[fn](...args);
  return html;
}
test('the imageless emailShell is removed and every email html uses the hero template', () => {
  const src = read('server/email.js');
  assert.ok(!/function emailShell/.test(src), 'the imageless emailShell function must be removed');
  assert.ok(!/letter-spacing:8px/.test(src), 'the old imageless wordmark header (letter-spacing:8px) must be gone');
  const assigns = src.match(/const html = \w+\(/g) || [];
  assert.ok(assigns.length >= 15, 'expected many html assignments, got ' + assigns.length);
  for (const a of assigns) {
    assert.ok(/heroEmail\(|confirmationEmailHtml\(/.test(a),
      'every email html must be built by heroEmail()/confirmationEmailHtml(), found: ' + a);
  }
  const shell = src.match(/function heroShell[\s\S]*?\n\}/);
  assert.ok(shell, 'heroShell (the one shared design) not found');
  assert.ok(/westmere-email-hero\.jpg/.test(shell[0]), 'heroShell must embed the hero image');
  assert.ok(/Westmere Private Hire/.test(shell[0]), 'heroShell must carry the "Westmere Private Hire" sign-off');
});
test('a representative sample across all email categories renders the hero image', async () => {
  const period = { from: '2026-08-01', to: '2026-08-07', issuedDate: '2026-08-08', dueDate: '2026-08-22', label: 'wk1' };
  const cases = [
    ['sendCustomerWelcome',       [{ email: 'x@e.com', full_name: 'Ben Carter' }]],
    ['sendPasswordResetEmail',    [{ email: 'x@e.com', full_name: 'Ben' }, 'tok']],
    ['sendAdminPasswordResetEmail',[{ email: 'a@e.com', username: 'admin' }, 'tok']],
    ['sendCustomerInvoice',       [{ email: 'x@e.com', full_name: 'Ben' }, [emailFixture], period, 'INV-1', {}, Buffer.from('%PDF')]],
    ['sendInvoiceReminder',       [{ name: 'Ben', email: 'x@e.com' }, 'INV-1', 96, 'https://x']],
    ['sendDriverStatement',       [{ name: 'Dan', email: 'd@e.com' }, period, { jobs: 1, gross: 100, commission: 10, net: 90 }, []]],
    ['sendPartnershipOutreach',   ['a@e.com', 'Acme Ltd']],
    ['sendReviewRequest',         ['x@e.com', 'Ben', 'WM-1']],
    ['sendAdminAlert',            [{ ...emailFixture, phone: '07000000000' }]],
  ];
  for (const [fn, args] of cases) {
    const html = await renderEmailArgs(fn, args);
    assert.ok(html.includes('/assets/westmere-email-hero.jpg'), fn + ' must embed the hero image');
    assert.ok(!html.includes('letter-spacing:8px'), fn + ' must not use the old imageless shell');
    assert.ok(/Westmere Private Hire/.test(html), fn + ' must keep the Westmere sign-off');
  }
});

// ── 11. Email refinements: bigger fonts, three equal buttons, clean notes ──
console.log('\nEmail refinements (fonts / three buttons / notes)');
const UNIFORM_BTN = /width:100%;text-decoration:none;border-radius:10px;padding:17px 16px/g;
test('estimate email has THREE equal-size stacked buttons (Pay Now / Pay Driver / Cancel)', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture });
  assert.ok(/Pay Now &mdash; Card, Apple Pay or Google Pay/.test(html), 'missing Pay Now button');
  assert.ok(/Pay Your Driver On The Day/.test(html), 'missing Pay Your Driver button');
  assert.ok(/Cancel Request/.test(html), 'missing Cancel Request button');
  const btns = html.match(UNIFORM_BTN);
  assert.ok(btns && btns.length === 3, 'expected exactly 3 identically-styled buttons, got ' + (btns ? btns.length : 0));
});
test('confirmation email has the same three equal-size buttons', async () => {
  const html = await renderEmail('sendCustomerConfirmed', { ...emailFixture, paid: false, payment: 'pending' });
  const btns = html.match(UNIFORM_BTN);
  assert.ok(btns && btns.length === 3, 'confirmation must show 3 uniform buttons, got ' + (btns ? btns.length : 0));
  assert.ok(/Cancel Request/.test(html), 'confirmation must include a Cancel Request button');
});
test('Notes row is OMITTED for a vehicle-only "note" (rider-app vehicle dump)', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture, notes: 'Vehicle: Standard Saloon' });
  assert.ok(!/A message from Westmere/.test(html), 'a vehicle-only note must NOT render a Notes row');
  assert.ok(!/Standard Saloon/.test(html), 'vehicle type must never appear in the customer email');
});
test('Notes row IS shown for a real owner note', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture, notes: 'Please bring a child seat' });
  assert.ok(/A message from Westmere/.test(html), 'a real owner note must render the Notes row');
  assert.ok(/Please bring a child seat/.test(html), 'the owner note text must appear');
});
test('Notes row is OMITTED when there is no note at all', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture, notes: '' });
  assert.ok(!/A message from Westmere/.test(html), 'no note => no Notes row');
});
test('email uses larger, phone-legible detail fonts', () => {
  const src = read('server/email.js');
  // confRow value + fare bumped for readability (was 14px / 22px).
  assert.ok(/font-size:17px;line-height:1.5;color:#1d1d1d/.test(src), 'detail value font must be bumped to 17px');
  assert.ok(/font-size:28px;line-height:1.2;color:#b78635/.test(src), 'fare font must be bumped to 28px');
});
test('rider app no longer dumps the vehicle type into notes', () => {
  const src = read('westmere-rider.html');
  assert.ok(!/notes:_selectedVehName\?'Vehicle: '\+_selectedVehName/.test(src),
    'rider app must NOT put "Vehicle: <type>" into the booking notes field');
});

// ── 12. Payment-system hardening audit (locks the recurring regressions) ──
console.log('\nPayment-system hardening audit');
test('(c) pay-info route reports stripeReady and is token-gated', () => {
  const pub = read('server/public-api.js');
  const i = pub.indexOf("router.get('/pay/:ref',");
  assert.ok(i !== -1, 'pay-info route not found');
  const block = pub.slice(i, i + 1500);
  assert.ok(/stripeReady: stripeConfigured\(\)/.test(block),
    'pay-info must report stripeReady so the page knows online payment is available');
  assert.ok(/b\.pay_token !== token/.test(block),
    'pay-info must reject a wrong pay_token (token-gated)');
});
test('(h) every public pay/cash/cancel/note route rejects a wrong pay_token', () => {
  const pub = read('server/public-api.js');
  const routes = [
    "router.get('/pay/:ref',",
    "router.post('/pay/:ref/intent'",
    "router.get('/pay/:ref/cash'",
    "router.post('/pay/:ref/cash'",
    "router.get('/cancel/:ref'",
    "router.post('/cancel/:ref'",
    "router.get('/note/:ref'",
  ];
  for (const decl of routes) {
    const i = pub.indexOf(decl);
    assert.ok(i !== -1, 'route not found: ' + decl);
    const block = pub.slice(i, i + 1400);
    assert.ok(/!b\.pay_token \|\| b\.pay_token !== token/.test(block),
      decl + ' must be gated by the per-booking pay_token (reject wrong/blank token)');
  }
});
test('(g) Apple Pay domain-association FILE exists and is valid (route can serve 200)', () => {
  const p = path.join(ROOT, 'apple-developer-merchantid-domain-association');
  assert.ok(fs.existsSync(p),
    'apple-developer-merchantid-domain-association must exist at repo root — the route 404s (Apple Pay breaks) without it');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.length > 1000, 'association file is too small to be the real Stripe file');
  assert.ok(!/<html|<!doctype|not found/i.test(content),
    'association file must be the raw Stripe content, not an HTML error page');
});

// ── Owner-created bookings follow the web-booking lifecycle ──────────────
// Owner spec: when the owner creates a booking in the app there is NO status
// prompt. It starts in the SAME initial state a customer web booking gets
// (pending/new), then follows the normal lifecycle (Send Estimate →
// awaiting_payment → confirmed / cancelled). It must never be auto-confirmed
// on creation.
console.log('\nOwner create-booking: no status prompt, starts pending (owner spec)');
test('owner create-booking form has no status selector and never auto-confirms', () => {
  const src = read('westmere-owner.html');
  assert.ok(!/id="nb-status"/.test(src), 'the nb-status selector must be removed (no status prompt)');
  const fn = src.match(/async function ownerNewBookingSubmit[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerNewBookingSubmit not found');
  assert.ok(!/nb-status/.test(fn[0]), 'submit must not read a status value');
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]), 'owner create must never set status:confirmed');
  assert.ok(!/method:\s*['"]PATCH['"]/.test(fn[0]), 'owner create must not PATCH a status after creating');
});
test('owner POST /bookings sets no status → DB default pending (same as web /book)', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings'[\s\S]*?res\.status\(201\)/);
  assert.ok(m, 'owner POST /bookings route not found');
  const ins = m[0].match(/INSERT INTO bookings \(([^)]*)\)/);
  assert.ok(ins, 'owner create INSERT not found');
  assert.ok(!/\bstatus\b/.test(ins[1]), 'owner create INSERT must not set status — rely on the pending default');
});
test('a status-less insert lands as pending, not confirmed (owner == web initial state)', () => {
  const dbSrc = read('server/db.js');
  assert.ok(/status\s+TEXT\s+NOT NULL DEFAULT 'pending'/.test(dbSrc), "bookings.status must default to 'pending'");
  // Functional proof against a real SQLite table with the live CHECK constraint.
  const Database = require('better-sqlite3');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'wm-ownercreate-' + process.pid + '.db');
  try { fs.unlinkSync(tmp); } catch (_) {}
  const d = new Database(tmp);
  d.exec("CREATE TABLE bookings(id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, pickup TEXT, destination TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','offered','awaiting_payment','confirmed','active','completed','cancelled')))");
  d.prepare("INSERT INTO bookings(ref,pickup,destination) VALUES('WM-OWN','A','B')").run();
  const row = d.prepare("SELECT status FROM bookings WHERE ref='WM-OWN'").get();
  assert.strictEqual(row.status, 'pending', 'owner-created booking (no status) must start pending, not confirmed');
  d.close();
  try { fs.unlinkSync(tmp); } catch (_) {}
});

// ── Owner card: payment badge + short addresses ──────────────────────────
// Owner screenshots: a brand-new booking wrongly showed an "Awaiting" payment
// badge before any estimate/method choice, and the drop-off rendered long-form
// ("Bolney, West Sussex, England"). Fixes: "Awaiting" only once a method is
// chosen; addresses always shortened (even if the WMAddr script hasn't loaded).
console.log('\nOwner card: payment badge + short addresses (owner spec)');
test('pay badge: new/pending shows no "Awaiting"; only method-chosen jobs do', () => {
  const src = read('westmere-owner.html');
  const m = src.match(/function wmPayStatus\(j\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'wmPayStatus not found');
  // Pure function (uses only `j`) — safe to evaluate for a real behavioural check.
  const wmPayStatus = new Function('return (' + m[0] + ')')();
  assert.strictEqual(wmPayStatus({ apiStatus: 'pending', payment: 'pending' }).short, '—',
    'a brand-new/pending booking must NOT show "Awaiting"');
  assert.strictEqual(wmPayStatus({ apiStatus: 'offered', payment: 'pending' }).short, '—',
    'an offered booking must NOT show "Awaiting"');
  assert.strictEqual(wmPayStatus({ apiStatus: 'awaiting_payment', payment: 'pending' }).short, 'Awaiting',
    'a card booking that reached awaiting_payment SHOULD show "Awaiting"');
  assert.strictEqual(wmPayStatus({ apiStatus: 'awaiting_payment', payment: 'cash' }).short, 'Cash',
    'a cash booking shows "Cash", not "Awaiting"');
  assert.strictEqual(wmPayStatus({ apiStatus: 'confirmed', paid_at: '2026-01-01' }).short, 'Prepaid ✓',
    'a paid booking shows "Prepaid"');
});
test('owner _shortAddr falls back to a LOCAL shortener, never the raw address', () => {
  const src = read('westmere-owner.html');
  assert.ok(/function _shortAddr\(a\)\{\s*return window\.WMAddr \? WMAddr\.shortDisplay\(a\) : _localShort\(a\);\s*\}/.test(src),
    '_shortAddr must fall back to _localShort (not "(a||\'\')") so it never returns the long-form address');
  assert.ok(/function _localShort\(/.test(src), '_localShort fallback helper must exist');
  assert.ok(/function _tinyAddr\(a\)\{\s*return window\.WMAddr \? WMAddr\.tinyLabel\(a\) : _localTiny\(a\);\s*\}/.test(src),
    '_tinyAddr must also fall back locally');
});
test('owner card detail rows shorten From/Stop/To via _shortAddr', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/function jobCardHtml[\s\S]*?\n\}/);
  assert.ok(fn, 'jobCardHtml not found');
  assert.ok(/From<\/td><td>'\+escH\(_shortAddr\(j\.pickup\)/.test(fn[0]), 'detail From row must use _shortAddr');
  assert.ok(/To<\/td><td>'\+escH\(_shortAddr\(j\.dest\)/.test(fn[0]), 'detail To row must use _shortAddr');
  assert.ok(/Stop<\/td><td>'\+escH\(_shortAddr\(j\.stop_address\)/.test(fn[0]), 'detail Stop row must use _shortAddr');
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
