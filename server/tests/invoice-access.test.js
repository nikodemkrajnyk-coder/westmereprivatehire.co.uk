/**
 * WHO MAY FETCH AN INVOICE —
 *   node server/tests/invoice-access.test.js   (also gated by `npm test`)
 *
 * READ THIS BEFORE CHANGING THE PUBLIC INVOICE ROUTE.
 *
 * /api/public/invoice/:no/pdf is OPEN: the invoice number is the only thing
 * needed to fetch the document, and invoice numbers are sequential. Anyone who
 * counts can pull a PDF carrying the business's bank details and a customer's
 * name, address and journey.
 *
 * That is a DECISION, not an oversight. A per-invoice token was built, guarded,
 * deployed and verified in production; the owner asked for it to be taken off
 * because he wants invoice links to open without one. This file exists so the
 * next person to notice finds the history instead of re-deriving it, and so the
 * pieces needed to close it again are not tidied away in the meantime:
 *
 *   · every invoice still HAS an access_token, minted and backfilled in db.js;
 *   · the emailed reminder link still carries ?t=, so links already sent keep
 *     working whichever way the decision goes next;
 *   · re-enabling the lock is one line — look the row up by access_token
 *     instead of invoice_no, and refuse with ONE identical 404 for every
 *     failure (distinct wording, or a 403, is an enumeration oracle even when
 *     no document is served).
 *
 * This file deliberately does NOT assert that the route stays open. Pinning
 * that would turn a future security fix into a test failure. What it pins is
 * everything AROUND the decision — which is all still load-bearing.
 *
 * Pure Node plus one throwaway database. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX = read('server/index.js');
const API   = read('server/api.js');
const DB    = read('server/db.js');
const EMAIL = read('server/email.js');
const PDFSRC = read('server/invoice-pdf.js');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nThe decision is written down where it is made');

test('the open route says, in the file, that it is a decision', () => {
  const r = INDEX.slice(INDEX.indexOf('THE ONE PLACE AN INVOICE IS RENDERED'),
                        INDEX.indexOf("app.get('/api/public/invoice/:invoiceNo/pdf'"));
  assert.ok(/OPEN, BY THE OWNER'S DECISION/.test(r),
    'an open route that looks like an oversight gets "fixed" by the next person, or worse, ' +
    'left alone by someone who assumes it was considered');
  assert.ok(/sequential/.test(r) && /bank details/.test(r),
    'and it must state plainly what is exposed, not hint at it');
  assert.ok(/access_token/.test(r) && /one line/.test(r),
    'and how to close it again');
});

console.log('\nThe means to close it again are still here');

test('every invoice still has an access token', () => {
  assert.ok(/ALTER TABLE invoices ADD COLUMN access_token TEXT/.test(DB), 'the column');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_access_token/.test(DB), 'unique');
  assert.ok(/SELECT id FROM invoices WHERE access_token IS NULL OR access_token = ''/.test(DB),
    'backfilled, and only where missing');
  assert.ok(/randomBytes\(16\)\.toString\('hex'\)/.test(DB), 'from a real CSPRNG');
});

test('the backfill stays idempotent', () => {
  const mig = /const invInfo = db\.prepare\('PRAGMA table_info\(invoices\)'\)[\s\S]*?\n  \} catch/.exec(DB);
  assert.ok(mig, 'the migration block is missing');
  assert.ok(/WHERE access_token IS NULL OR access_token = ''/.test(mig[0]),
    'a blanket UPDATE would re-mint on every boot and break every link already emailed');
});

test('a token is never re-minted', () => {
  const fn = /function ensureInvoiceToken\(db, row\)[\s\S]*?\n\}/.exec(PDFSRC);
  assert.ok(fn, 'ensureInvoiceToken is missing');
  assert.ok(/if \(row && row\.access_token\) return row\.access_token;/.test(fn[0]),
    're-minting invalidates the link in an invoice email already sent');
});

test('the emailed reminder link still carries its token', () => {
  const r = EMAIL.slice(EMAIL.indexOf('async function sendInvoiceReminder'));
  assert.ok(/invoicePublicUrl\(invoiceNo, accessToken\)/.test(r),
    'links already in inboxes must keep working whichever way this decision goes next');
  const remind = API.slice(API.indexOf("router.post('/invoices/:id/remind'"));
  assert.ok(/ensureInvoiceToken\(db, row\)/.test(remind.slice(0, 1600)), 'and the route must mint it');
});

test('a `t=` on the URL is accepted and ignored, never a hard error', () => {
  const r = INDEX.slice(INDEX.indexOf("app.get('/api/public/invoice/:invoiceNo/pdf'"));
  const body = r.slice(0, r.indexOf('\n});'));
  assert.ok(!/req\.query\.t/.test(body) || /ignored/.test(body),
    'a tokenised link from an already-sent email must still open');
});

console.log('\nWhat the decision did NOT open');

test('the staff apps still use the AUTHENTICATED route', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const fn = /function _invPdfUrl\(invoiceId, inline\)\{[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, name + ': _invPdfUrl is missing');
    assert.ok(/\/api\/invoices\/'\+encodeURIComponent\(invoiceId\)\+'\/pdf/.test(fn[0]),
      name + ': staff go through the session-gated route');
  }
});

test('the staff download route is still gated by role', () => {
  const r = API.slice(API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/\['admin', 'owner'\]\.includes\(req\.auth\.role\)/.test(r.slice(0, 400)), 'owner/admin only');
});

test("the customer's own copy is still scoped to the caller", () => {
  const r = API.slice(API.indexOf("router.get('/customer/invoices/:id/pdf'"), API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/You can only download your own invoices/.test(r),
    'My Account must not become a way to read another customer\'s invoice');
});

test('the access token is never handed to the browser', () => {
  const win = API.slice(API.indexOf('ok: true, invoiceNo, invoiceId'), API.indexOf('ok: true, invoiceNo, invoiceId') + 500);
  assert.ok(!/access_token/.test(win),
    'the create response gives the staff app a row id, not a customer\'s secret');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-access\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
