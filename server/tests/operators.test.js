/**
 * OPERATORS — run with:
 *   node server/tests/operators.test.js   (also gated by `npm test`)
 *
 * WHAT AN OPERATOR IS
 *   Another firm the owner passes work to — APD and the like. They were already
 *   in this system as ACCOUNT CUSTOMERS, because that is who an invoice is
 *   addressed to and what the account invoices hang off.
 *
 * WHY A FLAG AND NOT A TABLE
 *   A separate operators table would hold a second copy of the name, the
 *   address and the invoice linkage, and would then have to be kept in step with
 *   the customer record that already has them. The day they disagree, the
 *   invoice is addressed to one and the owner is looking at the other.
 *
 * WHY THERE IS NO BALANCE
 *   A driver carries a running balance because the money moves job by job. An
 *   operator is settled BY INVOICE — which this system already raises and
 *   already marks paid. So "what they owe" is derived: the total of their
 *   invoices that are not paid. Nothing to reconcile, and marking an invoice
 *   paid is the single action that changes it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-op-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const realFetch = global.fetch;
global.fetch = async (u, o) => (/resend\.com/.test(String(u))
  ? { ok: true, status: 200, json: async () => ({ id: 'x' }) }
  : realFetch(u, o));

const express = require('express');
const { getDb } = require('../db');
const db = getDb();
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
                      .replace(/(^|[^:])\/\/.*$/gm, '$1');

function app(role) {
  const a = express();
  a.use(express.json());
  a.use((q, _r, n) => { q.auth = { id: 1, role: role || 'owner', type: 'user' }; n(); });
  a.use('/api', require('../api'));
  return a.listen(0);
}
const call = (srv, m, u, body) => fetch('http://127.0.0.1:' + srv.address().port + u, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

let seq = 0;
function mkCustomer(name, operator) {
  seq++;
  const info = db.prepare(
    "INSERT INTO customers (full_name, company, email, phone, password, active, is_operator) VALUES (?,?,?,?,'x',1,?)"
  ).run(name, name + ' Ltd', 'op' + seq + '@example.com', '0770090' + (1000 + seq), operator ? 1 : 0);
  return info.lastInsertRowid;
}
function mkInvoice(customerId, total, paid, no) {
  /* line_items_json is NOT NULL on this table — an invoice without lines is not
     an invoice. The fixture supplies an empty list rather than the column being
     made optional for the sake of a test. */
  db.prepare(
    `INSERT INTO invoices (invoice_no, kind, customer_id, recipient_name, issued_date, total, paid,
                           line_items_json, created_at)
     VALUES (?,'account',?,?,?,?,?,?,datetime('now'))`
  ).run(no, customerId, 'Acme', '2026-09-01', total, paid ? 1 : 0, '[]');
}

console.log('\nAn operator is a customer we also send work to');

test('it is a flag on the customer, not a second table', () => {
  const schema = strip(read('server/db.js'));
  assert.ok(!/CREATE TABLE IF NOT EXISTS operators\b/i.test(schema),
    'an operators table has appeared — the customer record already holds the name, the address '
    + 'and the invoices, and two copies of those is one too many');
  assert.ok(/ALTER TABLE customers ADD COLUMN is_operator/.test(schema),
    'the is_operator flag is gone');
  const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  assert.ok(cols.indexOf('is_operator') !== -1, 'the column was never created');
});

test('the list carries only flagged customers, and what each one owes', async () => {
  const op = mkCustomer('Airport Direct', true);
  const plain = mkCustomer('Mrs Whitfield', false);
  mkInvoice(op, 412, false, 'INV-OP-1');
  mkInvoice(op, 88.5, true, 'INV-OP-2');
  mkInvoice(plain, 500, false, 'INV-C-1');

  const srv = app();
  try {
    const j = await (await call(srv, 'GET', '/api/operators')).json();
    const names = (j.operators || []).map((o) => o.full_name);
    assert.ok(names.indexOf('Airport Direct') !== -1, 'the operator is missing from the list');
    assert.strictEqual(names.indexOf('Mrs Whitfield'), -1,
      'an ordinary customer is being listed as an operator');
    const mine = j.operators.filter((o) => o.id === op)[0];
    assert.strictEqual(mine.owed, 412,
      'owed must be the UNPAID invoices only — the paid £88.50 is counted, so it is a running total '
      + 'of everything instead');
    assert.strictEqual(mine.unpaid, 1);
    assert.strictEqual(mine.invoices, 2, 'the count is every invoice, paid or not');
  } finally { srv.close(); }
});

test('marking an invoice paid is what clears the debt — there is nothing else to update', async () => {
  const op = mkCustomer('Sussex Executive', true);
  mkInvoice(op, 120, false, 'INV-OP-3');
  const inv = db.prepare("SELECT id FROM invoices WHERE invoice_no = 'INV-OP-3'").get().id;
  const srv = app();
  try {
    let j = await (await call(srv, 'GET', '/api/operators/' + op)).json();
    assert.strictEqual(j.owed, 120, 'the invoice is not counted against them');

    const r = await call(srv, 'PATCH', '/api/invoices/' + inv + '/mark-paid', {});
    assert.strictEqual(r.status, 200, 'the existing mark-paid route no longer works: ' + (await r.text()).slice(0, 80));

    j = await (await call(srv, 'GET', '/api/operators/' + op)).json();
    assert.strictEqual(j.owed, 0,
      'paying the invoice did not clear what they owe — the figure is being kept somewhere of its '
      + 'own instead of derived from the invoices');
    assert.strictEqual(j.unpaid, 0);
  } finally { srv.close(); }
});

test('their page lists every invoice with its paid state', async () => {
  const op = mkCustomer('Coastal Cars', true);
  mkInvoice(op, 60, true, 'INV-OP-4');
  mkInvoice(op, 40, false, 'INV-OP-5');
  const srv = app();
  try {
    const j = await (await call(srv, 'GET', '/api/operators/' + op)).json();
    assert.strictEqual((j.invoices || []).length, 2);
    const byNo = {};
    j.invoices.forEach((i) => { byNo[i.invoice_no] = i; });
    assert.ok(Number(byNo['INV-OP-4'].paid) === 1, 'a paid invoice must say so');
    assert.ok(!Number(byNo['INV-OP-5'].paid), 'an unpaid one must not');
    assert.strictEqual(j.owed, 40);
  } finally { srv.close(); }
});

test('an unknown operator is a 404, and the endpoints are staff-only', async () => {
  const owner = app('owner');
  const stranger = app('driver');
  try {
    assert.strictEqual((await call(owner, 'GET', '/api/operators/999999')).status, 404);
    assert.strictEqual((await call(stranger, 'GET', '/api/operators')).status, 403,
      'a driver can read the operator list');
    assert.strictEqual((await call(stranger, 'GET', '/api/operators/1')).status, 403);
  } finally { owner.close(); stranger.close(); }
});

test('flagging one is a change to the customer, and a string "false" does not set it', async () => {
  const c = mkCustomer('Brighton Line', false);
  const srv = app();
  const flag = () => db.prepare('SELECT is_operator FROM customers WHERE id = ?').get(c).is_operator;
  try {
    assert.strictEqual((await call(srv, 'PATCH', '/api/customers/' + c, { is_operator: true })).status, 200);
    assert.strictEqual(flag(), 1, 'the customer was not flagged');
    await call(srv, 'PATCH', '/api/customers/' + c, { is_operator: 'false' });
    assert.strictEqual(flag(), 0,
      'the string "false" was treated as true — a flag arriving from a form must be coerced, not trusted');
  } finally { srv.close(); }
});

console.log('\nThe screen says what the relationship is');

test('the owner app reads the operators endpoint and shows paid/unpaid', () => {
  const s = strip(read('westmere-owner.html'));
  assert.ok(/\/api\/operators/.test(s), 'the owner app never asks for the operators');
  assert.ok(/Unpaid/.test(s) && /Paid/.test(s), 'the invoice list does not show whether each one is paid');
  assert.ok(/Create invoice/i.test(s) && /Send a job/i.test(s),
    'the operator page offers neither of the two things he does with an operator');
});

test('operators are NOT given a running balance', () => {
  /* The distinction that keeps the two relationships honest: a driver is netted
     job by job, an operator is settled by invoice. If the operator page ever
     starts recording settlements, there are two places a debt lives. */
  const s = strip(read('westmere-owner.html'));
  const i = s.indexOf('async function owOperatorLoad');
  const j = s.indexOf('async function owOperatorSendJob');
  const block = i > -1 && j > i ? s.slice(i, j) : s.slice(Math.max(0, i), i + 6000);
  assert.ok(i > -1, 'the operator page is gone');
  assert.ok(!/\/settlements/.test(block),
    'the operator page records settlements — operators are settled by invoice, and a second '
    + 'place for the money to live is how two figures start disagreeing');
  assert.ok(!/driverBalance|\/ledger/.test(block),
    'the operator page reads the driver ledger — that is the other relationship');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(/operators\.test\.js/.test(pkg.scripts.test), 'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name); console.log('      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
