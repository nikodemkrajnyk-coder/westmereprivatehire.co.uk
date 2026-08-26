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
const { regionFrom, routeBlock } = require('./_source');
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
// The WHOLE webhook route, not a fixed-size window off the front of it. A
// character budget silently stops testing the code it was pointed at the moment
// somebody adds a branch above the assertion — which is exactly what happened
// when the balance-payment branch landed.
function webhookBlock() {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("router.post('/stripe-webhook'");
  assert.ok(start !== -1, 'stripe webhook route not found');
  const rest = pub.slice(start + 10);
  const next = rest.search(/\nrouter\.(post|get)\(/);
  return pub.slice(start, start + 10 + (next === -1 ? rest.length : next));
}
test('cash route records cash + moves pending → awaiting_payment (never confirmed)', () => {
  const block = cashPostBlock();
  // The cash WRITE now lives in server/pay-lock.js, shared with the My Account
  // channel so the two cannot drift (see double-payment.test.js). The invariant
  // is unchanged and still pinned — it just moved one call deep: the route
  // delegates, and the shared writer is the thing that validates and that
  // refuses to auto-confirm.
  assert.ok(/applyCashChoice\(/.test(block),
    'cash route must go through the shared applyCashChoice, so both payment channels behave identically');
  const lock = read('server/pay-lock.js');
  assert.ok(/assertPaymentMethod\('cash'/.test(lock), 'the shared cash write must validate the method (never a silent default)');
  assert.ok(/THEN 'awaiting_payment'/.test(lock), "the shared cash write must move an unsettled booking to 'awaiting_payment'");
  assert.ok(!/THEN 'confirmed'/.test(lock), 'the shared cash write must NOT auto-confirm (spec: awaiting payment first)');
  assert.ok(!/THEN 'confirmed'/.test(block), 'cash route must NOT auto-confirm (spec: awaiting payment first)');
});
test('cash route sends the booking-confirmed email when the customer chooses cash', () => {
  const block = cashPostBlock();
  // Choosing cash confirms the JOURNEY (payment pending) → the customer gets the
  // CASH confirmation ("pay your driver on the day"), never a "paid" receipt.
  assert.ok(/notifyCustomerConfirmed/.test(block), 'cash choice must send the (cash) booking-confirmed email');
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
  const block = webhookBlock();
  // Confirms unless cancelled — so awaiting_payment → confirmed is covered.
  assert.ok(/WHEN status = 'cancelled' THEN status ELSE 'confirmed'/.test(block), 'webhook must confirm non-cancelled bookings on payment');
  assert.ok(/row\.status === 'awaiting_payment'/.test(block), 'webhook must fire the confirmed email off the awaiting_payment edge too');
});

// Mark-as-paid: the owner/driver settlement of a cash job. It promotes the
// booking to confirmed internally but must NOT email the customer again — they
// already got the "pay your driver on the day" confirmation when they chose cash.
test('mark-paid route settles awaiting_payment → confirmed + stamps paid_at, without emailing the customer', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/mark-paid'[\s\S]*?\n\}\);/);
  assert.ok(m, 'mark-paid route not found');
  const block = m[0];
  assert.ok(/paid_at = COALESCE\(paid_at, datetime\('now'\)\)/.test(block), 'mark-paid must stamp paid_at once');
  assert.ok(/THEN 'confirmed'/.test(block), 'mark-paid must confirm an unsettled booking');
  assert.ok(/awaiting_payment/.test(block), 'mark-paid must handle awaiting_payment bookings');
  assert.ok(!/notifyCustomerConfirmed/.test(block), 'mark-paid must NOT send the customer another email (no "paid" spam)');
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
  // The ISO-week grouping + per-week takings live in the shared lifecycle
  // module, so the admin app groups Completed identically.
  assert.ok(/WMLifecycle\.groupByMonth\(jobs\)/.test(fn[0]),
    'buildCompleted must bucket jobs by month — never a flat list, which is what this has always guarded');
  assert.ok(/g\.label/.test(fn[0]), 'buildCompleted must render a per-week header');
  assert.ok(/g\.takings/.test(fn[0]), 'buildCompleted must show the week\'s takings');
  assert.ok(!/renderJobList/.test(fn[0]), 'buildCompleted must no longer defer to the flat renderJobList');
  // Behavioural check on the shared grouping itself.
  const LC = require('../../wm-lifecycle');
  const weeks = LC.groupByWeek([
    { date: '2026-08-10', fare: 50 },   // Mon
    { date: '2026-08-12', fare: 25 },   // Wed, same week
    { date: '2026-08-03', fare: 40 }    // previous week
  ]);
  assert.strictEqual(weeks.length, 2, 'two ISO weeks');
  assert.strictEqual(weeks[0].items.length, 2, 'newest week first, holding both of its jobs');
  assert.strictEqual(weeks[0].takings, 75, "a week's takings is the sum of its fares");
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
  const LC = require('../../wm-lifecycle');
  // The label + the action gating now come from the shared lifecycle module,
  // so assert the RULE there and that the card actually delegates to it.
  assert.strictEqual(LC.statusLabel({ apiStatus: 'cancelled' }).label, 'Cancelled',
    'cancelled jobs must render a "Cancelled" status label');
  assert.ok(/WMLifecycle\.statusLabel\(j\)/.test(jc), 'the card must take its status label from the shared module');
  assert.strictEqual(LC.actionsFor({ apiStatus: 'cancelled' }).edit, false, 'Edit must be suppressed on cancelled bookings');
  assert.ok(/if\(ACT\.edit\)\{[\s\S]*?upcomingEdit/.test(jc), 'Edit must be gated on the shared actionsFor()');
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
  // Read to the NEXT route rather than a fixed byte count — the route grows
  // (it now also asks Stripe whether the booking is already settled), and a
  // fixed slice silently stops covering the end of it.
  const rest = pub.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  const block = pub.slice(start, start + 10 + (next === -1 ? rest.length : next));
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
    // letterEmail is the SAME shell with the hero photo suppressed — the
    // letterhead used for outreach to people who have not booked anything. It
    // is allowed here precisely because it is not a second design; the
    // assertion below holds it to that.
    assert.ok(/heroEmail\(|confirmationEmailHtml\(|letterEmail\(/.test(a),
      'every email html must be built by heroEmail()/confirmationEmailHtml()/letterEmail(), found: ' + a);
  }
  const letter = src.match(/function letterEmail[\s\S]*?\n\}/);
  assert.ok(letter, 'letterEmail not found');
  assert.ok(/heroShell\(/.test(letter[0]),
    'letterEmail must build on heroShell — a separate shell is the thing this test exists to prevent');
  assert.ok(/hero: false/.test(letter[0]), 'and it must suppress the photo by parameter, not by copying the markup');
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
// The three payment actions are still one uniform stacked set — same width,
// same padding, same radius. What changed is that they are FRAMES now, built
// by emailBtn(): the fill is gone and the ranking is carried by the label. So
// the shape is matched on the anchor's geometry, which is what "equal size"
// actually means, rather than on the old filled-button string.
const UNIFORM_BTN = /display:block;box-sizing:border-box;width:100%;padding:17px 16px/g;
test('estimate email has THREE equal-size stacked buttons (Pay Now / Pay Driver / Cancel)', async () => {
  const html = await renderEmail('sendCustomerEstimate', { ...emailFixture });
  assert.ok(/Pay Now &mdash; Card, Apple Pay or Google Pay/.test(html), 'missing Pay Now button');
  assert.ok(/Pay Your Driver On The Day/.test(html), 'missing Pay Your Driver button');
  assert.ok(/Cancel Request/.test(html), 'missing Cancel Request button');
  const btns = html.match(UNIFORM_BTN);
  assert.ok(btns && btns.length === 3, 'expected exactly 3 identically-styled buttons, got ' + (btns ? btns.length : 0));
  // ...and none of them may be a filled slab: an inbox has no hover or press,
  // so the one state these have is the one the customer sees.
  const filled = html.match(/<a\b[^>]*background(?:-color)?:\s*(?!#ffffff|transparent)[^;"]+/g);
  assert.strictEqual(filled, null, 'an estimate-email button is filled again: ' + (filled || []).join(' | '));
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
  // This pins the SIZES only. It used to pin the colours alongside them
  // (#1d1d1d and the gold #b78635), which meant the readability guard doubled
  // as a guard that the gold stayed — so the palette could not be changed
  // without appearing to break readability. Colour is button-style.test.js's
  // job; this test is about whether a customer can read it on a phone.
  assert.ok(/font-size:17px;line-height:1\.5/.test(src), 'detail value font must be bumped to 17px');
  assert.ok(/font-size:28px;line-height:1\.2/.test(src), 'fare font must be bumped to 28px');
});
test('rider app no longer dumps the vehicle type into notes', () => {
  const src = read('westmere-rider.html');
  assert.ok(!/notes:_selectedVehName\?'Vehicle: '\+_selectedVehName/.test(src),
    'rider app must NOT put "Vehicle: <type>" into the booking notes field');
});

// ── 12. Payment-system hardening audit (locks the recurring regressions) ──
console.log('\nPayment-system hardening audit');
test('(c) pay-info route reports stripeReady and is token-gated', () => {
  // The whole route, not a 1500-character window off the front of it: a longer
  // SELECT above the assertion would otherwise silently stop testing it.
  const pub = read('server/public-api.js');
  const i = pub.indexOf("router.get('/pay/:ref',");
  assert.ok(i !== -1, 'pay-info route not found');
  const after = pub.slice(i + 10);
  const nxt = after.search(/router\.(post|get)\(/);
  const block = pub.slice(i, i + 10 + (nxt === -1 ? after.length : nxt));
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
    const block = routeBlock(pub, decl);
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
  // The rule now lives in the shared lifecycle module that BOTH staff apps
  // delegate to, so test it directly — that covers owner and admin at once.
  const wmPayStatus = require('../../wm-lifecycle').payStatus;
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

// ── Manual (owner-created) booking → Send Estimate must email reliably ────
// Root cause of the owner's bug: the manual create-booking form left the
// customer email OPTIONAL/unvalidated (the web form requires + validates it).
// A manual booking created without an email had no recipient, so
// sendCustomerEstimate returned false and the route reported "Email send
// failed". Fix: manual creation now requires + validates an email like web,
// so Send Estimate always has a deliverable address.
console.log('\nManual booking → Send Estimate (owner spec)');
test('Send Estimate on a manual booking (no linked customer) sends the email', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let sentTo = null, sentHtml = '';
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); sentTo = b.to; sentHtml = b.html || '';
    return { ok: true, status: 200, json: async () => ({ id: 'resend-manual-id' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  // Exactly what the send-estimate route passes for a MANUAL booking: no linked
  // customer, so name/email come from passenger_*, and flight/stop/notes are null.
  const result = await email.sendCustomerEstimate({
    ref: 'WPH-MANUAL1', name: 'Martin Shuttle', email: 'martin@example.com',
    pickup: 'Greenhill Avenue, Caterham, CR3 6PQ', destination: 'Bolney, West Sussex, England',
    stop_address: null, date: '2026-12-01', time: '09:00', flight: null, passengers: 1,
    fare: 75, notes: null, pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
  });
  assert.ok(result, 'manual Send Estimate must return a truthy Resend id, not false/throw');
  assert.strictEqual(sentTo, 'martin@example.com', 'estimate must be addressed to the manual booking email');
  assert.ok(/westmere-pay\.html\?ref=WPH-MANUAL1&t=deadbeef/.test(sentHtml), 'the Pay link must build from the pay_token');
  assert.ok(/\/api\/public\/pay\/WPH-MANUAL1\/cash\?t=deadbeef/.test(sentHtml), 'the cash link must build from the pay_token');
});
test('a blank email is exactly why manual Send Estimate used to fail (now blocked at creation)', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  const r = await email.sendCustomerEstimate({
    ref: 'WPH-NOEMAIL', name: 'Martin', email: null, passenger_email: null,
    pickup: 'A', destination: 'B', date: '2026-12-01', time: '09:00', fare: 75, pay_token: 'x'
  });
  assert.strictEqual(r, false, 'no email → estimate cannot send: the root cause the fix prevents');
});
test('owner manual create-booking requires + validates a customer email (like web /book)', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/async function ownerNewBookingSubmit[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerNewBookingSubmit not found');
  assert.ok(/email is required/i.test(fn[0]), 'manual create must require a customer email');
  assert.ok(/valid email/i.test(fn[0]) && /@/.test(fn[0]), 'manual create must validate the email format');
  // Server mirrors the web /book format check.
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings'[\s\S]*?res\.status\(201\)/);
  assert.ok(m, 'owner POST /bookings route not found');
  assert.ok(/Invalid email format/.test(m[0]), 'owner POST /bookings must validate email format like web /book');
});
test('the Email field is marked required in the owner new-booking form', () => {
  const src = read('westmere-owner.html');
  const form = src.match(/id="new-booking-sheet"[\s\S]*?id="nb-submit-btn"/);
  assert.ok(form, 'new-booking form not found');
  assert.ok(/Email \*/.test(form[0]), 'the Email label must be marked required (*)');
});

// ── Manual booking: the passenger NAME reaches every email ───────────────
// Root cause of the "Guest" bug: the owner POST /bookings route built the
// owner-alert (and calendar) name from the LINKED customer only
// (customerName.full_name || 'Guest'). A manual booking has no linked customer,
// so the name — stored in passenger_name — was ignored and the email said
// "Guest". Fix: fall back to passenger_name/email/phone (like COALESCE(
// c.full_name, b.passenger_name) elsewhere) before defaulting.
console.log('\nManual booking: name flows to every email (owner spec)');
test('owner-alert email renders the provided passenger name, not "Guest"', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  process.env.ADMIN_EMAIL = 'owner@westmere.co.uk';
  let cap = {};
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); cap = { subject: b.subject, html: b.html || '' };
    return { ok: true, status: 200, json: async () => ({ id: 'id1' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email.sendAdminAlert({
    ref: 'WPH-MANUAL2', name: 'Martin Shuttle', email: 'martin@example.com',
    phone: '07700900123', pickup: 'Greenhill Avenue, Caterham, CR3 6PQ',
    destination: 'Bolney', date: '2026-12-01', time: '09:00', fare: 75, payment: 'pending', passengers: 1
  });
  assert.ok(/Martin Shuttle/.test(cap.html), 'owner-alert body must show the passenger name');
  assert.ok(/Martin Shuttle/.test(cap.subject), 'owner-alert subject must show the passenger name');
  assert.ok(!/Guest/.test(cap.html), 'owner-alert must NOT fall back to "Guest" when a name was given');
});
test('customer estimate email greets the passenger by name, not "Guest"', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let html = '';
  global.fetch = async (url, opts) => { html = JSON.parse(opts.body).html || ''; return { ok: true, status: 200, json: async () => ({ id: 'id2' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email.sendCustomerEstimate({
    ref: 'WPH-MANUAL2', name: 'Martin Shuttle', email: 'martin@example.com',
    pickup: 'A', destination: 'B', date: '2026-12-01', time: '09:00', fare: 75, pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
  });
  assert.ok(/Martin/.test(html), 'estimate email must greet the customer by name');
  assert.ok(!/Guest/.test(html), 'estimate email must NOT say "Guest" when a name was given');
});
test('owner POST /bookings feeds passenger_name into the alert/calendar (not just the linked customer)', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings'[\s\S]*?res\.status\(201\)/);
  assert.ok(m, 'owner POST /bookings route not found');
  const block = m[0];
  // The name passed to sendAdminAlert / the calendar must fall back to
  // passenger_name — otherwise a manual booking (no customer_id) shows "Guest".
  assert.ok(/customerName\.full_name\s*\|\|\s*passenger_name/.test(block),
    'contact name must fall back to passenger_name before "Guest"');
  assert.ok(!/name:\s*customerName\.full_name\s*\|\|\s*'Guest'/.test(block),
    'the old customerName.full_name || "Guest" mapping (ignoring passenger_name) must be gone');
});

// ── Owner app shows luggage + passenger count ────────────────────────────
// Owner couldn't see how much luggage a customer selected. The value is stored
// (bookings.bags, captured by both web + manual forms) but the owner list card
// never rendered it, and passengers only showed when > 1. Fix: render pax
// (always) + luggage in the card summary AND the detail view, and let the
// manual create-booking form set luggage too.
console.log('\nOwner app: luggage + passenger count (owner spec)');
test('_bagsText renders the stored bags value as a luggage label', () => {
  const src = read('westmere-owner.html');
  // Shared rule — the owner app delegates to it, so test the module itself.
  assert.ok(/function _bagsText\(bags\)\{ return WMLifecycle\.bagsText\(bags\); \}/.test(src),
    'owner _bagsText must delegate to the shared lifecycle module');
  const _bagsText = require('../../wm-lifecycle').bagsText;
  assert.strictEqual(_bagsText('3'), '3 bags', 'a count renders as "N bags"');
  assert.strictEqual(_bagsText('1'), '1 bag', 'one bag is singular');
  assert.strictEqual(_bagsText('4+'), '4+ bags', 'the "4+" option renders');
  assert.strictEqual(_bagsText('0'), '', 'no luggage renders empty (omitted from compact summary)');
  assert.strictEqual(_bagsText(''), '', 'blank renders empty');
});
test('booking card renders passenger count + luggage in summary AND detail', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/function jobCardHtml[\s\S]*?\n\}/);
  assert.ok(fn, 'jobCardHtml not found');
  const jc = fn[0];
  // Summary line: passengers shown (not gated on >1) + luggage via _bagsText.
  assert.ok(/\(j\.pax\|\|1\)\+' pax'/.test(jc), 'summary must always show the passenger count');
  assert.ok(/_bagsText\(j\.bags\)\?' · '\+_bagsText\(j\.bags\)/.test(jc), 'summary must append luggage when present');
  // Detail rows: explicit Passengers + Luggage rows.
  assert.ok(/>Passengers<\/td><td>'\+\(j\.pax\|\|1\)/.test(jc), 'detail must show a Passengers row');
  // An explicitly-labelled Luggage row always shows the INTEGER label ("0 bags"),
  // never a raw column value and never the old "None" placeholder. The compact
  // summary above is the one that omits bags entirely. See bags-flight.test.js.
  assert.ok(/>Luggage<\/td><td>'\+escH\(_bagsLabel\(j\.bags\)\)/.test(jc), 'detail must show a Luggage row via the shared integer label');
});
test('manual create-booking form captures luggage (nb-bags) and sends it', () => {
  const src = read('westmere-owner.html');
  assert.ok(/id="nb-bags"/.test(src), 'the manual form must have a luggage selector');
  const fn = src.match(/async function ownerNewBookingSubmit[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerNewBookingSubmit not found');
  assert.ok(/bags:\s*\(document\.getElementById\('nb-bags'\)/.test(fn[0]), 'submit must send the luggage value');
  // Server stores bags for owner-created bookings.
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings'[\s\S]*?res\.status\(201\)/);
  assert.ok(/INSERT INTO bookings \([^)]*\bbags\b/.test(m[0]), 'owner POST /bookings must persist bags');
});

// ── Paid confirmation + review-on-completion emails ──────────────────────
console.log('\nPaid confirmation + review-request emails (owner spec)');
test('confirmation email: CASH is confirmed-but-pending (never "Paid"); CARD is paid', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let cap = {};
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'id' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');

  // CASH: customer chose "pay your driver on the day" — booking confirmed,
  // payment PENDING. The email must NEVER say "Paid" (subject or body).
  await email.sendCustomerConfirmed({
    ref: 'WPH-CASH', name: 'Martin Shuttle', email: 'm@e.com',
    pickup: 'Greenhill Avenue, Caterham, CR3 6PQ', destination: 'Bolney, West Sussex, England',
    date: '2026-12-01', time: '09:00', fare: 75, payment: 'cash', paid: false,
    passengers: 2, bags: '3', pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
  });
  const cash = cap.html, cashSubj = cap.subject;
  assert.ok(/WESTMERE/.test(cash) && /wm-pad/.test(cash), 'hero template');
  assert.ok(/WPH-CASH/.test(cash) && /2 passenger/.test(cash) && /3 bag/.test(cash), 'trip details incl. passengers + luggage');
  assert.ok(!/Paid/.test(cash), 'a CASH booking must NEVER say "Paid" anywhere in the body');
  assert.ok(!/paid/i.test(cashSubj), 'a CASH booking subject must not say "paid"');
  assert.ok(/Pay your driver in cash on the day/.test(cash), 'payment row must read "pay your driver in cash on the day"');
  assert.ok(/pay your driver in cash on the day/i.test(cash), 'body must frame it as pay-driver-on-the-day, not a receipt');
  assert.ok(/booking is confirmed/i.test(cash), 'must read as a confirmed booking');
  assert.ok(!/Pay Now/.test(cash), 'no Pay Now button (method already chosen)');

  // CARD: Stripe charge succeeded → genuinely paid.
  cap = {};
  await email.sendCustomerConfirmed({ ref: 'WPH-CARD', name: 'Jane', email: 'j@e.com', pickup: 'A', destination: 'B', date: '2026-12-02', time: '10:00', fare: 90, payment: 'card', paid: true, passengers: 1, pay_token: null });
  assert.ok(/Paid by card/.test(cap.html), 'card-paid confirmation must show "Paid by card"');
  assert.ok(/payment has been received/i.test(cap.html), 'card confirmation must say the payment was received');
  assert.ok(/paid/i.test(cap.subject), 'card confirmation subject may say paid');
  assert.ok(!/Pay Now/.test(cap.html), 'card-paid confirmation must carry no pay buttons');
});
test('confirmation fires on card-webhook and cash-CHOICE; NOT on cash mark-paid', () => {
  const pub = read('server/public-api.js');
  // Card: the Stripe webhook fires the (card, paid) confirmation.
  assert.ok(/notifyCustomerConfirmed/.test(webhookBlock()), 'stripe webhook must fire the confirmation');
  // Cash: choosing cash (pay/:ref/cash) fires the (cash, pending) confirmation.
  assert.ok(/notifyCustomerConfirmed/.test(cashPostBlock()), 'cash choice must fire the confirmation');
  // Mark-as-paid is internal only — it must NOT email the customer again.
  const api = read('server/api.js');
  const mp = api.match(/router\.post\('\/bookings\/:id\/mark-paid'[\s\S]*?\n\}\);/);
  assert.ok(mp && !/notifyCustomerConfirmed/.test(mp[0]), 'cash mark-paid must NOT fire another customer email');
  assert.ok(/bags:\s*row\.bags/.test(read('server/intake.js')), 'notifyCustomerConfirmed must pass luggage (bags) to the email');
});
test('review-request email: hero template + the same Google review link as the site', async () => {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let cap = {};
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'id' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email.sendReviewRequest('m@e.com', 'Martin', 'WPH-REV');
  const h = cap.html;
  assert.ok(/WESTMERE/.test(h) && /wm-pad/.test(h), 'review email must use the hero template');
  assert.ok(/g\.page\/r\/Ce764VxFTR4VEAE\/review/.test(h), 'must use the canonical Google review link');
  assert.ok(read('reviews.js').includes('g.page/r/Ce764VxFTR4VEAE/review'), 'the email link must match the site review button');
  assert.ok(/travelling with us/i.test(h), 'must thank the customer for travelling');
});
test('review request is sent only ONCE PER CUSTOMER EMAIL, across multiple completed trips', () => {
  const api = read('server/api.js');
  // Fires on the completion edge…
  assert.ok(/const becameCompleted = req\.body\.status === 'completed' && booking\.status !== 'completed'/.test(api),
    'the review must fire on the completion EDGE');
  assert.ok(/if \(becameCompleted\)/.test(api), 'the review send is gated on becameCompleted');
  // …but skipped if this email was ever asked before (lifetime, per-email dedup).
  assert.ok(/SELECT 1 FROM review_emails_sent WHERE email = \?/.test(api),
    'must look up a prior review request by email');
  assert.ok(/if \(!alreadyAsked\)/.test(api), 'must skip the send when the email was already asked');
  assert.ok(/INSERT OR IGNORE INTO review_emails_sent \(email\) VALUES \(\?\)/.test(api),
    'must record the email on a successful send so it is never re-asked');

  // Functional: TWO different completed bookings for the SAME customer email →
  // exactly ONE review email total (the crux of the correction). Mirrors the
  // route's dedup (skip if seen; record on send) and counts real sends.
  const Database = require('better-sqlite3');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'wm-review-' + process.pid + '.db');
  try { fs.unlinkSync(tmp); } catch (_) {}
  const d = new Database(tmp);
  d.exec("CREATE TABLE review_emails_sent (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')))");
  d.exec("CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, passenger_email TEXT, status TEXT)");
  // Same customer, two separate completed trips.
  const b1 = d.prepare("INSERT INTO bookings(ref,passenger_email,status) VALUES('WPH-1','Martin@Example.com','completed')").run().lastInsertRowid;
  const b2 = d.prepare("INSERT INTO bookings(ref,passenger_email,status) VALUES('WPH-2','martin@example.com','completed')").run().lastInsertRowid;
  const b3 = d.prepare("INSERT INTO bookings(ref,passenger_email,status) VALUES('WPH-3','someone-else@example.com','completed')").run().lastInsertRowid;
  let sends = 0;
  // Exactly the route logic: lookup by lowercased email, skip if seen, else send + record.
  function onCompleted(id) {
    const bk = d.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    const key = (bk.passenger_email || '').trim().toLowerCase();
    if (!key) return;
    if (d.prepare('SELECT 1 FROM review_emails_sent WHERE email = ?').get(key)) return; // already asked, ever
    sends++;                                                       // ← the review email would send here
    d.prepare('INSERT OR IGNORE INTO review_emails_sent (email) VALUES (?)').run(key);
  }
  onCompleted(b1);              // Martin's first trip → sends
  onCompleted(b2);              // Martin's second trip, same email (diff case) → skipped
  assert.strictEqual(sends, 1, 'two completed bookings for the SAME email must send only ONE review email');
  onCompleted(b3);             // a different customer → sends
  assert.strictEqual(sends, 2, 'a different customer still gets exactly one invite');
  d.close();
  try { fs.unlinkSync(tmp); } catch (_) {}
});
test('cancelling a booking deletes its Google Calendar event on both cancel paths', () => {
  const pub = read('server/public-api.js');
  const api = read('server/api.js');
  const gcalSrc = read('server/google-calendar.js');

  // 1) Customer cancel-request link (POST /api/public/cancel/:ref).
  const custStart = pub.indexOf("router.post('/cancel/:ref'");
  assert.ok(custStart !== -1, 'customer cancel route not found');
  const custEnd = pub.indexOf('router.', custStart + 10);
  const custBlock = pub.slice(custStart, custEnd === -1 ? custStart + 2500 : custEnd);
  assert.ok(/deleteEvent\(b\.calendar_event_id\)/.test(custBlock),
    'the customer cancel link must delete the calendar event');

  // 2) Owner cancel — PATCH status:cancelled deletes on the cancelled edge…
  assert.ok(/updated\.status === 'cancelled' && updated\.calendar_event_id\)[\s\S]{0,120}gcal\.deleteEvent\(updated\.calendar_event_id\)/.test(api),
    'owner PATCH cancel must delete the calendar event');
  // …the owner /bookings/:id/cancel route…
  const ocStart = api.indexOf("router.post('/bookings/:id/cancel'");
  const ocEnd = api.indexOf('\nrouter.', ocStart + 10);
  assert.ok(ocStart !== -1 && /gcal\.deleteEvent\(booking\.calendar_event_id\)/.test(api.slice(ocStart, ocEnd === -1 ? ocStart + 1200 : ocEnd)),
    'owner cancel route must delete the calendar event');
  // …a refund (paid → cancelled) — the path that was previously missing it…
  const rfIdx = api.indexOf('booking_refunded');
  assert.ok(rfIdx !== -1 && /gcal\.deleteEvent\(booking\.calendar_event_id\)/.test(api.slice(rfIdx - 900, rfIdx)),
    'a refund/cancel must delete the calendar event too');
  // …and the owner DELETE /bookings/:id (hard-delete) removes the event as well.
  const delStart = api.indexOf("router.delete('/bookings/:id'");
  const delEnd = api.indexOf('\nrouter.', delStart + 10);
  assert.ok(delStart !== -1 && /gcal\.deleteEvent\(booking\.calendar_event_id\)/.test(api.slice(delStart, delEnd === -1 ? delStart + 1500 : delEnd)),
    'owner DELETE /bookings/:id must delete the calendar event');
  // Customer self-cancel (My Account) also removes the event.
  const csStart = api.indexOf("router.post('/customer/bookings/:id/cancel'");
  const csEnd = api.indexOf('\nrouter.', csStart + 10);
  assert.ok(csStart !== -1 && /deleteEvent\(booking\.calendar_event_id\)/.test(api.slice(csStart, csEnd === -1 ? csStart + 1800 : csEnd)),
    'customer self-cancel must delete the calendar event');

  // Graceful when there's no synced event / calendar not connected.
  assert.ok(/if \(!isConfigured\(\) \|\| !loadTokens\(\) \|\| !eventId\) return false/.test(gcalSrc),
    'deleteEvent must no-op safely when there is no event id / no calendar connection');
});

// ── Manual vs Web booking PARITY (owner audit) ───────────────────────────
// A manually-created (owner) booking must behave identically to a customer web
// booking across field capture, customer-linking, pay_token, status lifecycle
// and every downstream email.
console.log('\nManual vs Web booking parity (owner audit)');
test('both create routes capture the SAME core fields (name/phone/email/pax/bags/flight/stop)', () => {
  const api = read('server/api.js');
  const pub = read('server/public-api.js');
  const ownerIns = (api.match(/INSERT INTO bookings \(([^)]*)\)[\s\S]*?res\.status\(201\)/) || [])[1] ||
                   (api.match(/router\.post\('\/bookings'[\s\S]*?INSERT INTO bookings \(([^)]*)\)/) || [])[1] || '';
  for (const col of ['pickup', 'destination', 'stop_address', 'date', 'time', 'passengers', 'bags', 'flight', 'fare', 'payment', 'notes', 'passenger_name', 'passenger_phone', 'passenger_email']) {
    assert.ok(new RegExp('\\b' + col + '\\b').test(ownerIns), 'owner create must persist ' + col + ' (parity with web)');
  }
  // Web /book persists the same passenger_* + trip columns.
  const webIns = (pub.match(/INSERT INTO bookings \(([^)]*)\)/) || [])[1] || '';
  for (const col of ['passenger_name', 'passenger_phone', 'passenger_email', 'stop_address', 'flight', 'bags', 'passengers']) {
    assert.ok(new RegExp('\\b' + col + '\\b').test(webIns), 'web /book must persist ' + col);
  }
});
test('manual booking links to an existing customer by email, like web /book', () => {
  const api = read('server/api.js');
  const web = read('server/public-api.js');
  // Web links by email…
  assert.ok(/SELECT id FROM customers WHERE email = \? AND active = 1/.test(web), 'web /book links customer by email');
  // …and the owner route now mirrors it.
  const m = api.match(/router\.post\('\/bookings'[\s\S]*?res\.status\(201\)/);
  assert.ok(m && /SELECT id FROM customers WHERE email = \? AND active = 1/.test(m[0]),
    'owner create must link to an existing customer by email (parity)');
});
test('manual create-booking form captures a flight number (parity with the web form)', () => {
  const src = read('westmere-owner.html');
  assert.ok(/id="nb-flight"/.test(src), 'the manual form must have a flight field');
  const fn = src.match(/async function ownerNewBookingSubmit[\s\S]*?\n\}/);
  assert.ok(fn && /flight:\s*\(document\.getElementById\('nb-flight'\)/.test(fn[0]), 'submit must send the flight value');
});
test('both create routes default status to pending (identical initial lifecycle)', () => {
  const api = read('server/api.js');
  const web = read('server/public-api.js');
  // Web forces finalStatus 'pending'; owner sets no status (DB default pending).
  assert.ok(/finalStatus\s*=\s*'pending'/.test(web), 'web /book must start pending');
  const ownerIns = (api.match(/router\.post\('\/bookings'[\s\S]*?INSERT INTO bookings \(([^)]*)\)/) || [])[1] || '';
  assert.ok(!/\bstatus\b/.test(ownerIns), 'owner create must not set status (DB default pending) — same initial state as web');
});

// ── Email deliverability: text/plain part + List-Unsubscribe ─────────────
// HTML-only mail hurts inbox placement (SpamAssassin MIME_HTML_ONLY). Every
// send must carry a text/plain alternative AND a List-Unsubscribe header.
console.log('\nEmail deliverability (text part + List-Unsubscribe)');
test('every send includes a text/plain alternative + a List-Unsubscribe header', async () => {
  process.env.RESEND_API_KEY = 'test_fake';
  process.env.GMAIL_USER = 'bookings@westmereprivatehire.co.uk';
  let payload = null;
  global.fetch = async (u, o) => { payload = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email.sendCustomerConfirmed({
    ref: 'WPH-DELIV', name: 'Martin Shuttle', email: 'm@e.com',
    pickup: 'Greenhill Avenue, Caterham, CR3 6PQ', destination: 'Bolney, West Sussex, England',
    date: '2026-12-18', time: '09:30', fare: 75, payment: 'card', paid: true, passengers: 2, bags: '3', pay_token: null
  });
  assert.ok(typeof payload.text === 'string' && payload.text.length > 50, 'must send a text/plain part (not HTML-only)');
  assert.ok(!/<[a-z][^>]*>/i.test(payload.text), 'the text part must be plain (no HTML tags)');
  assert.ok(!/display:none|mso-hide/.test(payload.text), 'hidden preheader/mso-hide markup must not leak into the text part');
  assert.ok(/WPH-DELIV/.test(payload.text) && /Bolney/.test(payload.text) && /Paid by card/.test(payload.text), 'the text part must carry the real content');
  assert.ok(payload.headers && /^<mailto:[^>]*westmereprivatehire\.co\.uk[^>]*>$/.test(payload.headers['List-Unsubscribe'] || ''),
    'must set a List-Unsubscribe header (mailto, from-domain aligned)');
  // Links survive into text as "label (url)".
  assert.ok(/westmereprivatehire\.co\.uk/.test(payload.text), 'links must be preserved in the text part');
  // Reply-To must be ON the sending domain — a freemail Reply-To trips
  // SpamAssassin FREEMAIL_FORGED_REPLYTO (~+2.5 spam points).
  assert.ok(/@westmereprivatehire\.co\.uk$/.test(payload.reply_to || ''),
    'Reply-To must be an on-domain address, never a freemail (gmail/…) address');
  assert.ok(!/@(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol)\./i.test(payload.reply_to || ''),
    'Reply-To must not be a freemail address (FREEMAIL_FORGED_REPLYTO)');
});
test('sendEmail Reply-To defaults to the on-domain address, not GMAIL_USER (freemail)', () => {
  const src = read('server/email.js');
  const m = src.match(/const replyTo = [^;]+;/);
  assert.ok(m, 'replyTo assignment not found');
  assert.ok(/westmereprivatehire\.co\.uk/.test(m[0]), 'replyTo must default to an on-domain address');
  assert.ok(!/GMAIL_USER/.test(m[0]), 'replyTo must NOT use the freemail GMAIL_USER (FREEMAIL_FORGED_REPLYTO)');
});
test('sendEmail wires text + List-Unsubscribe into the Resend payload', () => {
  const src = read('server/email.js');
  const m = src.match(/const payload = \{[\s\S]*?\n  \};/);
  assert.ok(m, 'Resend payload literal not found');
  assert.ok(/\btext\b/.test(m[0]), 'payload must include a text (plain-text) part');
  assert.ok(/List-Unsubscribe/.test(m[0]), 'payload headers must include List-Unsubscribe');
});

// ── Send Estimate: real success/failure + recipient visibility (Mr Ben) ──
// The Mr Ben incident: the app reported the estimate "sent" but it never
// arrived. Root fix: the route must (a) run entirely server-side via Resend with
// NO Claude dependency, (b) never report success on a rejected send, and (c)
// return the RECIPIENT so the owner can spot a wrong/typo address.
console.log('\nSend Estimate: honest result + recipient (Mr Ben)');
test('send-estimate is server-side via Resend with NO Claude/assistant dependency', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/send-estimate'[\s\S]*?\n\}\);/);
  assert.ok(m, 'send-estimate route not found');
  assert.ok(/sendCustomerEstimate/.test(m[0]), 'must send via sendCustomerEstimate (Resend)');
  assert.ok(!/anthropic|claude|assistant/i.test(m[0]), 'the send-estimate route must not touch Claude/any assistant');
  // A pointer to the CLAUDE.md engineering notes in a comment is fine; an actual
  // runtime dependency on an assistant is not. Check for real wiring only.
  const emailSrc = read('server/email.js').replace(/CLAUDE\.md/g, '');
  assert.ok(!/require\([^)]*(anthropic|claude)[^)]*\)|api\.anthropic\.com/i.test(emailSrc),
    'the email send path must not depend on Claude');
});
test('send-estimate never false-reports success and returns the recipient', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/send-estimate'[\s\S]*?\n\}\);/);
  const block = m[0];
  // Only ok:true when the Resend send is truthy; a rejected send is surfaced.
  assert.ok(/if \(!sendResult\)/.test(block), 'must branch on the real send result');
  assert.ok(/could NOT be emailed/i.test(block) && /status\(50\d\)/.test(block), 'a failed send must return a real error naming the address');
  assert.ok(/sent_to:\s*b\.contact_email/.test(block), 'a successful send must return sent_to (the recipient) so a wrong address is visible');
  // A booking with no email still cannot reach the send (email required).
  assert.ok(/No email address on this booking/.test(block), 'no-email bookings are rejected before send');
});
test('owner Send Estimate shows the recipient address in its confirmation', () => {
  const src = read('westmere-owner.html');
  const fn = src.match(/async function ownerSendEstimate[\s\S]*?\n\}/);
  assert.ok(fn && /d\.sent_to/.test(fn[0]) && /emailed to/i.test(fn[0]),
    'the toast must show the address the estimate was emailed to (catch a wrong email)');
});

// ── Feature 1: To Confirm badge = count of AWAITING-PAYMENT bookings ──────
console.log('\nTo Confirm badge = awaiting-payment count (owner spec)');
test('the To Confirm badge shows the COUNT of awaiting-payment bookings, hidden at zero', () => {
  const src = read('westmere-owner.html');
  const flat = src.replace(/\s+/g, ' ');
  assert.ok(/awaitingCount\s*=\s*WMLifecycle\.toConfirmCount\(OFFERED_JOBS\|\|\[\]\)/.test(flat),
    'the badge count must come from the shared toConfirmCount()');
  // And the shared counter must actually count awaiting-payment bookings only.
  const LC = require('../../wm-lifecycle');
  assert.strictEqual(
    LC.toConfirmCount([{ status: 'awaiting_payment' }, { status: 'pending' }, { status: 'confirmed' }, { status: 'awaiting_payment' }]), 2,
    'toConfirmCount must count awaiting_payment bookings only (a new request is not "to confirm")');
  assert.strictEqual(LC.toConfirmCount([{ status: 'pending' }]), 0, 'no awaiting-payment bookings → zero');
  // The number goes through wmCountLabel now (blank at zero, capped at 99+), so
  // that the To Confirm and Drivers badges cannot write a count two ways.
  assert.ok(/dot\.textContent\s*=\s*wmCountLabel\(awaitingCount\)/.test(flat), 'must render the number');
  assert.ok(/dot\.style\.display\s*=\s*awaitingCount\?'flex':'none'/.test(flat), 'must hide the badge at zero');
  // Viewing the To Confirm tab must NOT clear the badge any more.
  const fn = src.match(/function buildToConfirm\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn && !/toconfirm-dot/.test(fn[0]), 'buildToConfirm must not clear the badge (it reflects awaiting-payment, not tab focus)');
});
test('the badge is live-updating — SSE events refresh the bookings', () => {
  const src = read('westmere-owner.html');
  const m = src.match(/addEventListener\('wm:event'[\s\S]{0,220}?\}\);/);
  assert.ok(m && /loadOwnerBookings\(\)/.test(m[0]), 'a wm:event must refresh bookings so the badge stays live');
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
