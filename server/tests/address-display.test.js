/**
 * Address-display regression guard — run with:
 *   node server/tests/address-display.test.js
 *
 * The owner asked for SHORT addresses everywhere they are shown, and for a
 * guardrail because the change had regressed before. Root cause: the raw
 * geocoder string (Nominatim `display_name`) was rendered verbatim, and the
 * ad-hoc shorteners were duplicated + inconsistent (the emails used none). The
 * fix routes every DISPLAY through the ONE shared normalizer, address-normalize.js.
 *
 * This test fails loudly (exit 1) if:
 *   (a) the normalizer stops producing the owner's short form,
 *   (b) an airport stops collapsing to name(+terminal),
 *   (c) a long raw address leaks back into any of the three key emails, OR a
 *       display template stops delegating to the shared normalizer,
 *   (d) the full precise address stops being used for navigation (Waze).
 *
 * Pure Node, no framework, Resend stubbed via global.fetch.
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

// The two real long strings from the WM-OKAMDV owner-alert (the reported bug).
const LONG_PICKUP = 'Brighton, Brighton and Hove, England, BN1 1HJ, United Kingdom';
const LONG_DROPOFF = 'Gatwick Airport, Station Approach Road, Lowfield Heath, Tinsley Green, Crawley, West Sussex, England, RH6 0RD, United Kingdom';
// Fragments that must NEVER appear as display text once shortened.
const LONG_FRAGMENTS = [', United Kingdom', ', England', 'Brighton and Hove', 'Station Approach Road', 'Tinsley Green', 'West Sussex', 'Lowfield Heath'];

// ── (a) + (b) Normalizer unit tests ──────────────────────────────────────
console.log('\nAddress normalizer (shared source of truth)');
const addr = require('../../address-normalize');

test('collapses the two reported long strings to the owner short form', () => {
  assert.strictEqual(addr.shortDisplay(LONG_PICKUP), 'Brighton, BN1 1HJ');
  assert.strictEqual(addr.shortDisplay(LONG_DROPOFF), 'Gatwick Airport');
});
test('house number + street + town + postcode is preserved', () => {
  assert.strictEqual(
    addr.shortDisplay('12, High Street, Horsham, Mid Sussex, West Sussex, England, RH12 1AB, United Kingdom'),
    '12 High Street, Horsham, RH12 1AB');
});
test('airport collapses to name, with terminal when specified', () => {
  assert.strictEqual(addr.shortDisplay('London Gatwick Airport, North Terminal, Crawley, West Sussex, RH6 0NP, United Kingdom'), 'Gatwick Airport, North Terminal');
  assert.strictEqual(addr.shortDisplay('Heathrow Airport Terminal 5, Longford, TW6 2GA, United Kingdom'), 'Heathrow Airport, Terminal 5');
  assert.strictEqual(addr.shortDisplay('Gatwick Airport, Crawley, RH6 0RD, United Kingdom'), 'Gatwick Airport');
});
test('a town whose name starts "St" is not mistaken for a street', () => {
  assert.strictEqual(addr.shortDisplay('St Albans, Hertfordshire, England, AL1 1AA, United Kingdom'), 'St Albans, AL1 1AA');
});
test('short output never contains a stripped region/country fragment', () => {
  for (const raw of [LONG_PICKUP, LONG_DROPOFF]) {
    const out = addr.shortDisplay(raw);
    for (const frag of LONG_FRAGMENTS) assert.ok(!out.includes(frag), 'short form leaked "' + frag + '": ' + out);
  }
});

// ── (c) The real email templates must use the normalizer (no leak) ───────
console.log('\nEmails render the SHORT address, keep FULL for nav');

// Render an email by stubbing Resend's HTTP call and capturing the payload.
async function renderEmail(fnName, booking) {
  process.env.RESEND_API_KEY = 'test_fake_key';
  process.env.ADMIN_EMAIL = 'owner@example.com';
  let captured = { html: '', subject: '' };
  global.fetch = async (url, opts) => {
    const p = JSON.parse(opts.body);
    captured = { html: p.html || '', subject: p.subject || '' };
    return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email[fnName](booking);
  return captured;
}

const BASE = {
  ref: 'WM-OKAMDV', name: 'Test Customer', email: 'cust@example.com', phone: '07000000000',
  pickup: LONG_PICKUP, destination: LONG_DROPOFF, date: '2026-08-20', time: '10:00',
  fare: 99, pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
};

for (const fnName of ['sendAdminAlert', 'sendCustomerEstimate', 'sendCustomerConfirmed']) {
  test(fnName + ': shows short address, never the long raw form', async () => {
    const { html, subject } = await renderEmail(fnName, BASE);
    assert.ok(html.length > 0, 'no html captured');
    // Short forms are present…
    assert.ok(html.includes('Brighton, BN1 1HJ'), 'short pickup missing from ' + fnName);
    assert.ok(html.includes('Gatwick Airport'), 'short drop-off missing from ' + fnName);
    // …and the long fragments are gone from the visible body + subject.
    for (const frag of LONG_FRAGMENTS) {
      assert.ok(!html.includes(frag), fnName + ' leaked long fragment "' + frag + '" into the email body');
      assert.ok(!subject.includes(frag), fnName + ' leaked long fragment "' + frag + '" into the subject');
    }
  });
}

test('owner-alert keeps the FULL address in the Waze nav link (routing intact)', async () => {
  const { html } = await renderEmail('sendAdminAlert', BASE);
  const fullPu = 'waze.com/ul?q=' + encodeURIComponent(LONG_PICKUP);
  const fullDe = 'waze.com/ul?q=' + encodeURIComponent(LONG_DROPOFF);
  assert.ok(html.includes(fullPu), 'Waze pickup link lost the full precise address');
  assert.ok(html.includes(fullDe), 'Waze drop-off link lost the full precise address');
});

// ── (c) Static check: every display template delegates to the normalizer ──
console.log('\nDisplay templates delegate to the single source of truth');

test('email.js imports the shared normalizer and never renders a raw address', () => {
  const src = read('server/email.js');
  assert.ok(/require\('\.\.\/address-normalize'\)/.test(src), 'email.js must require ../address-normalize');
  assert.ok(/function dispAddr/.test(src), 'email.js must define the dispAddr display helper');
  // No template may print a raw pickup/destination again.
  for (const bad of [/escHtml\(pickup\)/, /escHtml\(destination\)/, /escHtml\(d\.pickup\)/, /escHtml\(d\.destination\)/, /escHtml\(b\.pickup/, /escHtml\(b\.destination/, /detailRow\('Pickup', pickup\)/]) {
    assert.ok(!bad.test(src), 'email.js still renders a raw address: ' + bad);
  }
});

test('owner + admin + account apps load the normalizer and delegate to it', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html', 'westmere-account.html']) {
    const src = read(f);
    assert.ok(/<script src="\/address-normalize\.js">/.test(src), f + ' must load /address-normalize.js');
    assert.ok(/WMAddr\.shortDisplay/.test(src), f + ' must delegate its short-address helper to WMAddr.shortDisplay');
  }
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
