/**
 * ONE SET OF PAYMENT DETAILS, WHICHEVER APP HE OPENS — run with:
 *   node server/tests/invoice-settings-owner.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   The bank details print at the foot of every invoice, and the fields to
 *   enter them existed only in the ADMIN app. He runs the owner app on his
 *   phone, so they stayed blank and invoices went out with no way to pay them.
 *
 * WHAT IS GUARDED
 *   1. The owner app has all four fields.
 *   2. It reads and writes the SAME store the admin app uses and the invoice
 *      reads — one authority, so the two screens cannot drift apart.
 *   3. Saving from either app lands in invoice_settings and reaches the PDF.
 *   4. The account number is masked once stored, and leaving the mask alone
 *      does not blank the stored number.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-isett-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });

const { getDb } = require('../db');
const db = getDb();
const api = require('../api');

const ROOT = path.join(__dirname, '..', '..');
const OWNER = fs.readFileSync(path.join(ROOT, 'westmere-owner.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'westmere-admin.html'), 'utf8');
const FIELDS = ['is-bank-name', 'is-account-name', 'is-sort-code', 'is-account-no'];

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
function call(method, routePath, body) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  const req = { params: {}, query: {}, body: body || {}, ip: '::1',
                auth: { role: 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of l.route.stack.map((x) => x.handle)) h(req, r, () => {});
  return r;
}
const stored = () => {
  const row = db.prepare("SELECT value FROM integrations WHERE key = 'invoice_settings'").get();
  return row ? JSON.parse(row.value) : {};
};

// ── 1. THE FIELDS ARE THERE, IN BOTH APPS ────────────────────────────────
console.log('\nHe can enter them from the app he actually uses');

test('the owner app has all four payment fields', () => {
  for (const id of FIELDS) {
    assert.ok(OWNER.indexOf('id="' + id + '"') !== -1,
      'the owner app has no ' + id + ' — he would have to open the admin app to enter it');
  }
});

test('the admin app still has them too', () => {
  for (const id of FIELDS) {
    assert.ok(ADMIN.indexOf('id="' + id + '"') !== -1, 'the admin app lost ' + id);
  }
});

test('both apps write to the SAME route — one authority, no divergence', () => {
  for (const [src, label] of [[OWNER, 'the owner app'], [ADMIN, 'the admin app']]) {
    assert.ok(/settings\/invoice['"],\s*\{\s*method:\s*'PUT'|settings\/invoice['"],\{method:'PUT'/.test(src.replace(/\s+/g, ' ')),
      label + ' does not PUT to /api/settings/invoice — a second store would drift from the invoice');
  }
  /* And the owner app must not have invented its own endpoint. */
  const ownerFns = OWNER.slice(OWNER.indexOf('function ownerSaveInvoiceSettings'));
  const body = ownerFns.slice(0, ownerFns.indexOf('\n}'));
  assert.ok(/\/api\/settings\/invoice/.test(body), 'the owner save posts somewhere else');
});

test('the owner sheet pre-fills from what is stored', () => {
  assert.ok(/function ownerLoadInvoiceSettings/.test(OWNER), 'nothing loads the stored values');
  const open = OWNER.slice(OWNER.indexOf('function openSettings('));
  assert.ok(/ownerLoadInvoiceSettings\(\)/.test(open.slice(0, open.indexOf('\n}'))),
    'opening Settings does not pre-fill them — he would retype from memory or overwrite with blanks');
});

// ── 2. WHAT IS SAVED IS WHAT THE INVOICE READS ───────────────────────────
console.log('\nAnd what he saves is what the invoice prints');

test('saving lands in invoice_settings', () => {
  const r = call('put', '/settings/invoice', {
    bank_name: 'EXAMPLE BANK', account_name: 'WESTMERE PRIVATE HIRE LTD',
    sort_code: '00-00-00', account_no: '00000000'
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const s = stored();
  assert.strictEqual(s.sort_code, '00-00-00', 'the sort code did not reach the store');
  assert.strictEqual(s.account_no, '00000000', 'the account number did not reach the store');
  assert.strictEqual(s.account_name, 'WESTMERE PRIVATE HIRE LTD');
});

test('and the invoice prints exactly those stored values', async () => {
  const { buildInvoicePdf } = require('../invoice-pdf');
  const PDFDocument = require('pdfkit');
  const seen = [];
  const T = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str, x, y, o) { seen.push(String(str)); return T.apply(this, arguments); };
  try {
    await buildInvoicePdf({
      invoiceNo: 'INV-SETT-1', kind: 'bespoke', settings: stored(),
      recipient: { name: 'APD Private Hire' },
      period: { issuedDate: '2026-08-31', dueDate: '2026-09-14' },
      items: [{ date: '2026-08-03', description: 'A → B', amount: 100 }],
      notes: '', commissionPct: 10, total: 90
    });
  } finally { PDFDocument.prototype.text = T; }
  const all = seen.join(' | ');
  assert.ok(/Pay by transfer/.test(all), 'the payment line is missing from the invoice');
  assert.ok(all.indexOf('00-00-00') !== -1, 'the stored sort code is not the one printed');
  assert.ok(all.indexOf('00000000') !== -1, 'the stored account number is not the one printed');
  assert.ok(/Reference INV-SETT-1/.test(all), 'the invoice number is not the payment reference');
});

// ── 3. THE NUMBER ON A PHONE SCREEN ──────────────────────────────────────
console.log('\nThe account number is not left sitting on his screen');

test('the owner sheet masks the stored account number', () => {
  const fn = OWNER.slice(OWNER.indexOf('function ownerLoadInvoiceSettings'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/slice\(-4\)/.test(body),
    'the full account number is put back on screen — a phone gets handed across a desk');
  assert.ok(/••••|\\u2022/.test(body), 'nothing masks the leading digits');
});

test('leaving the mask alone does not blank the stored number', () => {
  const fn = OWNER.slice(OWNER.indexOf('async function ownerSaveInvoiceSettings'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/acc\s*!==\s*_IS_ACC_MASK/.test(body),
    'an untouched mask would be sent back as the account number, replacing it with bullets');
  assert.ok(/if\s*\(acc\s*&&\s*acc\s*!==\s*_IS_ACC_MASK\)\s*body\.account_no\s*=\s*acc;/.test(body),
    'the field must be OMITTED when untouched, not sent empty — an empty string would erase it');
});

test('a save that omits the account number leaves it standing', () => {
  call('put', '/settings/invoice', { sort_code: '11-11-11' });
  const s = stored();
  assert.strictEqual(s.sort_code, '11-11-11', 'the sort code did not update');
  assert.strictEqual(s.account_no, '00000000',
    'omitting the account number wiped it — a partial save must not erase what it does not mention');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('invoice-settings-owner.test.js'),
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
