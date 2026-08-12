/**
 * Password-reset link + admin site-link guardrail — run with:
 *   node server/tests/reset-link.test.js   (also gated by `npm test`)
 *
 * Two live customer-facing regressions this pins down:
 *
 * 1. The customer password-reset email built its URL as
 *      https://westmereprivatehire.co.uk/?skip=1&reset_token=<token>
 *    which lands on index.html — the marketing homepage, which has NO
 *    `reset_token` handling whatsoever. Every reset link was dead: customers
 *    clicked through, saw the booking homepage and could never set a password.
 *    The ONLY page that reads `reset_token` and renders the reset form is
 *    westmere-rider.html, so the customer reset URL must point there.
 *
 * 2. The admin console's "Booking Site" / "Account Portal" links pointed at an
 *    old GitHub Pages mirror (nikodemkrajnyk-coder.github.io/...), a different
 *    origin serving stale code. They must be same-origin relative links so they
 *    always hit the live app.
 *
 * Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nPassword-reset link + admin site-link guardrail');

const email = read('server/email.js');
const riderHtml = read('westmere-rider.html');
const adminHtml = read('westmere-admin.html');

// Isolate the CUSTOMER reset builder — sendAdminPasswordResetEmail deliberately
// points at westmere-admin.html and must not satisfy these assertions by accident.
function fnBody(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  assert.ok(start !== -1, name + '() not found in server/email.js');
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\nasync function ');
  return next === -1 ? rest : rest.slice(0, next);
}

const customerReset = fnBody(email, 'sendPasswordResetEmail');
const adminReset = fnBody(email, 'sendAdminPasswordResetEmail');

// ── 1. Customer reset email ──────────────────────────────────────────────
test('customer reset URL points at westmere-rider.html (not the homepage)', () => {
  const m = customerReset.match(/const resetUrl = `([^`]+)`/);
  assert.ok(m, 'sendPasswordResetEmail must build a `resetUrl` template literal');
  const url = m[1];
  assert.ok(url.includes('/westmere-rider.html'),
    'customer reset URL must land on westmere-rider.html (the only page that handles ' +
    'reset_token). Got: ' + url);
  assert.ok(!/co\.uk\/\?/.test(url),
    'customer reset URL must NOT point at the site root / index.html — the marketing ' +
    'homepage has no reset_token handling, so the link is dead. Got: ' + url);
});

test('customer reset URL carries the reset_token', () => {
  const url = customerReset.match(/const resetUrl = `([^`]+)`/)[1];
  assert.ok(/[?&]reset_token=\$\{token\}/.test(url),
    'customer reset URL must include `reset_token=${token}` or the reset form has ' +
    'nothing to submit. Got: ' + url);
});

test('customer reset URL is absolute against the live host', () => {
  const url = customerReset.match(/const resetUrl = `([^`]+)`/)[1];
  assert.ok(url.startsWith('https://westmereprivatehire.co.uk/'),
    'email links must be absolute against the live host. Got: ' + url);
});

test('admin reset URL still points at westmere-admin.html', () => {
  const url = adminReset.match(/const resetUrl = `([^`]+)`/)[1];
  assert.ok(url.includes('/westmere-admin.html') && /reset_token=\$\{token\}/.test(url),
    'the admin reset link is separate and must keep landing on the admin console. Got: ' + url);
});

// ── 2. The landing page actually handles the token ───────────────────────
test('westmere-rider.html reads reset_token from the query string', () => {
  assert.ok(/URLSearchParams\(window\.location\.search\)/.test(riderHtml) &&
            /get\(['"]reset_token['"]\)/.test(riderHtml),
    'westmere-rider.html must read `reset_token` from the query string, or the ' +
    'emailed link cannot open the reset form');
});

test('westmere-rider.html shows the reset form and posts to the reset endpoint', () => {
  assert.ok(/swFrm\(['"]reset['"]\)/.test(riderHtml),
    'westmere-rider.html must switch to the reset form when reset_token is present');
  assert.ok(/['"]\/api\/auth\/customer\/reset-password['"]/.test(riderHtml),
    'the reset form must POST to /api/auth/customer/reset-password');
});

// ── 3. Admin console site links are same-origin ──────────────────────────
test('westmere-admin.html has no github.io links (stale cross-origin mirror)', () => {
  assert.ok(!/github\.io/.test(adminHtml),
    'westmere-admin.html must not link to the old GitHub Pages mirror — it is a ' +
    'different origin serving stale code. Use same-origin relative links.');
});

test('admin "Your Sites" links are same-origin and current', () => {
  const m = adminHtml.match(/<span class="sb-label">Your Sites<\/span>([\s\S]*?)<\/div>/);
  assert.ok(m, 'admin sidebar must still have a "Your Sites" section');
  const hrefs = [...m[1].matchAll(/href="([^"]+)"/g)].map(h => h[1]);
  assert.ok(hrefs.includes('/'), 'Booking Site link must be the same-origin root "/". Got: ' + hrefs.join(', '));
  assert.ok(hrefs.includes('/westmere-rider.html'),
    'Account Portal link must point at /westmere-rider.html (the live account app). Got: ' + hrefs.join(', '));
  for (const h of hrefs) {
    assert.ok(h.startsWith('/'), 'every "Your Sites" link must be same-origin relative. Got: ' + h);
    assert.ok(!/westmere-account\.html/.test(h),
      'westmere-account.html is the retired mirror page — the live account app is westmere-rider.html');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
