/**
 * Booking acknowledgement guardrail — run with:  node server/tests/booking-ack.test.js
 *
 * Task A (funnel review): the instant a customer submits a booking they must get
 * an automated, branded acknowledgement email — a receipt separate from the
 * owner's manual Send Estimate step. This test locks in:
 *   1) email.js exports sendCustomerAcknowledgement and it renders a branded
 *      email carrying the reference + the ESTIMATED FARE, framed as an estimate,
 *      signed "Westmere Private Hire", using the SHORT address format;
 *   2) the book route (public-api.js) actually fires it alongside the owner alert;
 *   3) the on-screen success wording is the new "Thank you for booking with us"
 *      copy on both submit paths (booking-app.js + frontend.js).
 *
 * Pure Node, no network (Resend is stubbed). Exit 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// Render an email by stubbing Resend's HTTP call and capturing the payload.
async function renderAck(booking) {
  process.env.RESEND_API_KEY = 'test_fake_key';
  let captured = { html: '', subject: '', to: '' };
  global.fetch = async (url, opts) => {
    const p = JSON.parse(opts.body);
    const to = Array.isArray(p.to) ? (p.to[0] || '') : (p.to || '');
    captured = { html: p.html || '', subject: p.subject || '', to };
    return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  const ok = await email.sendCustomerAcknowledgement(booking);
  return { ok, ...captured };
}

const BOOKING = {
  ref: 'WM-ACK123', name: 'Jane Traveller', email: 'jane@example.com', phone: '07000000000',
  pickup: 'Brighton, BN1 1AA, United Kingdom', destination: 'Gatwick Airport, RH6 0NP, United Kingdom',
  date: '2026-08-20', time: '10:00', passengers: 2, estimated_fare: 65,
};

// ── 1. The acknowledgement email content ──────────────────────────────────
console.log('\nCustomer acknowledgement email');

test('sends and captures a branded HTML email to the customer', async () => {
  const r = await renderAck(BOOKING);
  assert.strictEqual(r.ok, true, 'sendCustomerAcknowledgement did not report success');
  assert.strictEqual(r.to, 'jane@example.com', 'not addressed to the customer');
  assert.ok(r.html.length > 500, 'no/short html captured');
  assert.ok(/WESTMERE/.test(r.html), 'missing Westmere branding/wordmark');
  assert.ok(/Westmere Private Hire/.test(r.html), 'not signed Westmere Private Hire');
});

test('contains the booking reference', async () => {
  const r = await renderAck(BOOKING);
  assert.ok(r.html.includes('WM-ACK123'), 'reference missing from email body');
  assert.ok(r.subject.includes('WM-ACK123'), 'reference missing from subject');
});

test('shows the ESTIMATED FARE, clearly framed as an estimate', async () => {
  const r = await renderAck(BOOKING);
  assert.ok(r.html.includes('~£65'), 'estimated fare "~£65" missing');
  assert.ok(/Estimated fare/i.test(r.html), 'no "Estimated fare" label');
  assert.ok(/confirm your exact price shortly/i.test(r.html), 'missing the estimate caveat wording');
  // Must NOT imply a confirmed/booked price.
  assert.ok(!/confirmed|Booking confirmed/i.test(r.html), 'acknowledgement must not claim confirmation');
});

test('says thank you for booking + will be in touch shortly', async () => {
  const r = await renderAck(BOOKING);
  assert.ok(/Thank you for booking with us/i.test(r.html), 'missing thank-you line');
  assert.ok(/in touch shortly/i.test(r.html), 'missing "in touch shortly"');
});

test('uses the SHORT address format (no raw region/country fragment)', async () => {
  const r = await renderAck(BOOKING);
  assert.ok(r.html.includes('Brighton, BN1 1AA'), 'short pickup missing');
  for (const frag of ['United Kingdom']) {
    assert.ok(!r.html.includes(frag), 'leaked long address fragment: ' + frag);
  }
});

test('gracefully omits the number when no estimate is available', async () => {
  const r = await renderAck({ ...BOOKING, estimated_fare: null, suggested_fare: null, fare: null });
  assert.strictEqual(r.ok, true);
  assert.ok(!/~£/.test(r.html), 'should not print a fake ~£ figure when unpriced');
  assert.ok(/confirm your exact fare shortly/i.test(r.html), 'missing graceful no-estimate caveat');
});

test('no email address → no send (returns false)', async () => {
  const r = await renderAck({ ...BOOKING, email: '' });
  assert.strictEqual(r.ok, false, 'must not attempt send without a customer email');
});

// ── 2. The book route fires the acknowledgement ───────────────────────────
console.log('\nBook route wiring');

test('public-api.js imports + fires sendCustomerAcknowledgement on booking', () => {
  const src = read('server/public-api.js');
  assert.ok(/const\s*\{[^}]*sendCustomerAcknowledgement[^}]*\}\s*=\s*require\('\.\/email'\)/.test(src),
    'public-api.js must import sendCustomerAcknowledgement from ./email');
  assert.ok(/Promise\.allSettled\([\s\S]*sendAdminAlert\(booking\)[\s\S]*sendCustomerAcknowledgement\(booking\)[\s\S]*\]\)/.test(src),
    'book route must fire BOTH the owner alert and the customer acknowledgement together');
  assert.ok(/estimated_fare:\s*suggestedFare/.test(src),
    'the acknowledgement payload must carry the server-side estimated fare');
});

// ── 3. On-screen success wording ──────────────────────────────────────────
console.log('\nSuccess-screen wording');

test('booking-app.js shows the new "Thank you for booking" message + reference', () => {
  const src = read('booking-app.js');
  assert.ok(/Thank you for booking with us — we will be in touch shortly\./.test(src),
    'booking-app.js missing the new success wording');
  assert.ok(/Reference '\s*\+\s*\(res\.d\.ref/.test(src), 'booking-app.js must still show the reference');
  assert.ok(!/Request received/.test(src), 'old "Request received" wording still present in booking-app.js');
});

test('frontend.js shows the new "Thank you for booking" message', () => {
  const src = read('frontend.js');
  assert.ok(/Thank you for booking with us — we will be in touch shortly\./.test(src),
    'frontend.js missing the new success wording');
  assert.ok(!/Request received/.test(src), 'old "Request received" wording still present in frontend.js');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
