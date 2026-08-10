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
  assert.strictEqual(ok, true, 'estimate did not send');
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

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
