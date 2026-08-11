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
test('cash route confirms pending + records cash from a genuine customer action', () => {
  const pub = read('server/public-api.js');
  const start = pub.indexOf("router.post('/pay/:ref/cash'");
  assert.ok(start !== -1, 'cash POST route not found');
  // Slice to the next route declaration so we only inspect this handler.
  const rest = pub.slice(start + 10);
  const next = rest.search(/router\.(post|get)\(/);
  const block = pub.slice(start, start + 10 + (next === -1 ? rest.length : next));
  assert.ok(/assertPaymentMethod\('cash'/.test(block), 'cash route must validate the cash write');
  assert.ok(/WHEN status = 'pending' THEN 'confirmed'/.test(block), 'cash route must confirm a pending booking');
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
  assert.ok(/Indicative starting fares shown/.test(html), 'airport-transfers.html missing honest subtext');
  // Spot-check a few fare figures survive the copy change.
  for (const p of ['from £45', '£65', 'from £188']) {
    assert.ok(html.includes(p), 'airport-transfers.html fare "' + p + '" changed/removed');
  }
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
