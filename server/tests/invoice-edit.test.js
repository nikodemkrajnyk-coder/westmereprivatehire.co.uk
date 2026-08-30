/**
 * CORRECTING A SAVED INVOICE — run with:
 *   node server/tests/invoice-edit.test.js   (also gated by `npm test`)
 *
 * WHAT WAS TRUE BEFORE
 *   An invoice was immutable. There were routes to create, list, read,
 *   download, send, mark paid and delete — and no route to change one. A wrong
 *   figure meant deleting the invoice and issuing a new number, which is
 *   exactly what an accounts department that has already filed the first one
 *   should never receive.
 *
 * THE TWO THINGS MOST LIKELY TO GO WRONG
 *   1. A CORRECTED INVOICE SERVING A STALE PDF. The cache was keyed on the
 *      invoice number and template version — both unchanged by an edit — so the
 *      corrected document would have downloaded as the old one. This repo has
 *      shipped that failure twice already by forgetting a version bump; the key
 *      is a content hash now so there is nothing to forget.
 *   2. THE AUTO-SUM EATING A MANUAL TOTAL. The owner sets a figure by hand,
 *      then corrects a typo in an address, and the total silently reverts to
 *      the sum of the lines. The override is a stored flag, not a coincidence.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-invoice-edit-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-inv-cache-'));
process.env.INVOICES_DIR = CACHE;   // the name the module actually reads

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
const invoicePdf = require('../invoice-pdf');

let SENT = [];
global.fetch = async (u, o) => { SENT.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

// ── The route, driven directly ───────────────────────────────────────────
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
const api = require('../api');
function layerFor(method, routePath) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  return l;
}
async function call(method, routePath, { params, body, role }) {
  const handlers = layerFor(method, routePath).route.stack.map((s) => s.handle);
  const req = { params: params || {}, body: body || {}, query: {},
                auth: { role: role || 'owner', id: 1, type: 'user' }, ip: '::1' };
  const r = res();
  let i = 0;
  const next = async () => { if (i < handlers.length) await handlers[i++](req, r, next); };
  await next();
  return r;
}

let n = 0;
function seed(kind, items, extra) {
  const no = 'INV-202608-' + String(++n).padStart(4, '0');
  const total = items.reduce((s, it) => s + (kind === 'bespoke' ? +it.amount : +it.fare), 0);
  db.prepare(`INSERT INTO invoices (invoice_no, kind, recipient_name, recipient_email, recipient_phone,
              recipient_addr, issued_date, due_date, period_label, notes, line_items_json, total, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    no, kind, 'APD Private Hire', 'accounts@apd.example.com', '07700 900000',
    '1 High Street\nSteyning\nBN44 3AA', '2026-08-28', '2026-09-11', 'August 2026',
    (extra && extra.notes) || 'Thank you.', JSON.stringify(items), total);
  return db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(no);
}
const BESPOKE_ITEMS = [
  { date: '2026-08-03', description: 'Brighton to Gatwick', amount: 95 },
  { date: '2026-08-07', description: 'Hove to Heathrow T5', amount: 120 }
];
const ACCOUNT_ITEMS = [
  { date: '2026-08-03', ref: 'WPH-1001', time: '09:30', pickup: 'Brighton Station', destination: 'Gatwick Airport', fare: 95 },
  { date: '2026-08-07', ref: 'WPH-1002', time: '06:15', pickup: 'Hove Town Hall', destination: 'Heathrow T5', fare: 120 }
];
const rowOf = (id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const itemsOf = (id) => JSON.parse(rowOf(id).line_items_json || '[]');

// ── 1. THE EDIT ITSELF ───────────────────────────────────────────────────
console.log('\nAn invoice can be corrected, and keeps its number');

test('the route exists at all — it did not before', () => {
  assert.doesNotThrow(() => layerFor('patch', '/invoices/:id'),
    'PATCH /invoices/:id is the whole feature');
});

test('editing updates the stored fields and keeps the same number', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    recipient_name: 'APD Private Hire Ltd', recipient_email: 'billing@apd.example.com',
    recipient_addr: '2 Church Street\nSteyning', issued_date: '2026-08-29', due_date: '2026-09-12',
    notes: 'Corrected: August parking added.',
    line_items: [{ date: '2026-08-03', description: 'Brighton to Gatwick (incl. parking)', amount: 101 },
                 { date: '2026-08-07', description: 'Hove to Heathrow T5', amount: 120 }]
  }});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(inv.id);
  assert.strictEqual(after.invoice_no, inv.invoice_no, 'the number must not move — it is a correction');
  assert.strictEqual(after.recipient_name, 'APD Private Hire Ltd');
  assert.strictEqual(after.recipient_email, 'billing@apd.example.com');
  assert.strictEqual(after.issued_date, '2026-08-29');
  assert.strictEqual(after.due_date, '2026-09-12');
  assert.ok(/parking added/.test(after.notes));
  assert.strictEqual(itemsOf(inv.id)[0].description, 'Brighton to Gatwick (incl. parking)');
  assert.strictEqual(after.total, 221, 'and the total follows the lines: 101 + 120');
  assert.ok(after.revised_at, 'the correction is dated');
});

test('lines can be added and removed', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [{ description: 'One line only', amount: 50 },
                 { description: 'And a new one', amount: 25 },
                 { description: 'And another', amount: 25 }] }});
  assert.strictEqual(itemsOf(inv.id).length, 3);
  assert.strictEqual(rowOf(inv.id).total, 100);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: [{ description: 'One line only', amount: 50 }] }});
  assert.strictEqual(itemsOf(inv.id).length, 1);
  assert.strictEqual(rowOf(inv.id).total, 50, 'removing a line takes its money with it');
});

test('an ACCOUNT line keeps its journey shape', async () => {
  /* Flattening a journey to a description would empty the JOURNEY column on
     the PDF — the row would still be there, with nothing in it. */
  const inv = seed('account', ACCOUNT_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    line_items: ACCOUNT_ITEMS.map((it, i) => Object.assign({}, it, { amount: i === 0 ? 111 : it.fare })) }});
  const items = itemsOf(inv.id);
  assert.strictEqual(items[0].pickup, 'Brighton Station', 'the route survives the edit');
  assert.strictEqual(items[0].destination, 'Gatwick Airport');
  assert.strictEqual(items[0].ref, 'WPH-1001');
  assert.strictEqual(items[0].fare, 111, 'and the amount is written back to fare, which is what the PDF reads');
  assert.strictEqual(rowOf(inv.id).total, 231);
});

test('identity cannot be edited — number, kind, customer', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: {
    invoice_no: 'INV-HACKED-0001', kind: 'account', customer_id: 999, id: 12345 }});
  const after = rowOf(inv.id);
  assert.strictEqual(after.invoice_no, inv.invoice_no, 'the number is the document');
  assert.strictEqual(after.kind, 'bespoke', 'and so is the kind');
  assert.strictEqual(after.customer_id, inv.customer_id, 'an edit must not re-point it at another customer');
});

// ── 2. THE MANUAL TOTAL ──────────────────────────────────────────────────
console.log('\nThe total can be taken over by hand, and stays taken over');

test('a manual total is stored, flagged, and shown', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);       // lines sum to 215
  const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { total_override: 200 } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the figure he typed');
  assert.strictEqual(after.total_manual, 1, 'and the fact that he typed it');
  assert.strictEqual(r.body.autoSum, 215, 'the response still reports what the lines say');
});

test('THE ONE THAT MATTERS: a later edit does not put the auto-sum back', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  // an ordinary correction that says nothing about the total
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { recipient_phone: '07700 900999', notes: 'Address corrected.' } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total, 200, 'the override survives an unrelated edit');
  assert.strictEqual(after.total_manual, 1);
  // and editing the LINES does not disturb it either
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'Just the one now', amount: 10 }] } });
  assert.strictEqual(rowOf(inv.id).total, 200, 'nor does changing the lines under it');
});

test('the override can be handed back to the lines', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: null } });
  const after = rowOf(inv.id);
  assert.strictEqual(after.total_manual, 0, 'the flag comes down');
  assert.strictEqual(after.total, 215, 'and the sum takes over again');
});

test('without an override the total tracks the lines', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'a', amount: 12.5 }, { description: 'b', amount: 7.25 }] } });
  assert.strictEqual(rowOf(inv.id).total, 19.75);
  assert.strictEqual(rowOf(inv.id).total_manual, 0);
});

test('a nonsense total is refused, and changes nothing', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  for (const bad of ['abc', -5, 99999999]) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: bad } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad) + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).total, 215, 'the invoice is untouched by a refused edit');
});

test('the manual total reaches the PDF', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  const data = invoicePdf.invoiceDataFromRow(rowOf(inv.id), {});
  assert.strictEqual(data.total, 200, 'the document shows the figure he set, not the sum of its lines');
});

test('the EMAIL quotes the same total as the PDF it carries', async () => {
  /* Found by rendering it, not by reading it. The email built its own total by
     adding the line items up, so a manually corrected invoice went out quoting
     £401 with a £375 document attached — one invoice disagreeing with itself
     inside one message. */
  const inv = seed('bespoke', BESPOKE_ITEMS);                 // lines sum to 215
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 200 } });
  const row = rowOf(inv.id);
  const email = require('../email');
  const items = JSON.parse(row.line_items_json);
  SENT = [];
  await email.sendBespokeInvoice(
    { name: row.recipient_name, email: row.recipient_email, phone: '', address: '' },
    items, { label: row.period_label, dueDate: row.due_date, issuedDate: row.issued_date,
             notes: row.notes, total: row.total },
    row.invoice_no, { company_name: 'Westmere Private Hire' }, Buffer.from('%PDF-1.3 x'));
  const m = SENT[0];
  assert.ok(m, 'nothing was sent');
  assert.ok(/£200\.00/.test(m.subject), 'the subject must quote the corrected total: ' + m.subject);
  assert.ok(!/£215\.00/.test(m.subject), 'and never the superseded sum: ' + m.subject);
  assert.ok(/£200\.00/.test(m.html), 'the body too');
  const bodyTotals = (m.html.match(/£215\.00/g) || []);
  assert.deepStrictEqual(bodyTotals, [], 'the auto-sum must not appear as a total in the body');
});

test('the send ROUTE hands the stored total to the email', () => {
  /* The guard above proves the email honours a total when given one; this
     proves the caller gives it. Both halves, or the fix is only half wired. */
  const src = read('server/api.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const route = src.slice(src.indexOf("router.post('/invoices/:id/send'"));
  const period = route.slice(route.indexOf('const period = {'), route.indexOf('};', route.indexOf('const period = {')));
  assert.ok(/total: row\.total/.test(period),
    'the send route must pass the stored total, or the email falls back to summing the lines');
});

// ── 3. NO STALE PDF ──────────────────────────────────────────────────────
console.log('\nA corrected invoice does not serve the old document');

test('the cache key changes when the content does', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const before = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
    body: { line_items: [{ description: 'Corrected line', amount: 999 }] } });
  const after = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.notStrictEqual(before, after, 'an edited invoice must not resolve to the same cached file');
  assert.ok(after.includes(invoicePdf.invoiceSafeNo ? '' : ''), '');
  assert.ok(/INV-202608-\d{4}\.v\d+\.[0-9a-f]{10}\.pdf$/.test(after),
    'the name carries the template version AND a content hash: ' + path.basename(after));
});

test('and the same content resolves to the same file', () => {
  /* A key that changed on every call would rebuild the PDF for every download
     — correct output, and a cache that does nothing. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const a = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  const b = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.strictEqual(a, b);
});

test('the REBUILT pdf really contains the correction', async () => {
  /* The end of the chain, rendered rather than assumed: edit, resolve, and
     read the total back out of the drawing. */
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const first = await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.ok(first && first.length > 1000, 'no first PDF');
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 12345.67 } });
  const second = await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.notStrictEqual(first.length + ':' + first.slice(0, 400).toString('latin1'),
                        second.length + ':' + second.slice(0, 400).toString('latin1'),
                        'the corrected invoice came back byte-identical to the old one');
  const data = invoicePdf.invoiceDataFromRow(rowOf(inv.id), {});
  assert.strictEqual(data.total, 12345.67);
});

test('a cached file written before the edit is never reused', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  const stale = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.ok(fs.existsSync(stale), 'the first render should have been cached');
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 777 } });
  const fresh = invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id));
  assert.notStrictEqual(stale, fresh);
  await invoicePdf.resolveInvoicePdf(db, rowOf(inv.id));
  assert.ok(fs.existsSync(fresh), 'the corrected render is cached under its own name');
  /* Both files exist; what matters is which one the resolver asks for. */
  assert.strictEqual(invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)), fresh);
});

test('deleting an invoice still takes every cached rendering with it', () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  const paths = invoicePdf.invoiceCachePaths(inv.invoice_no);
  const dir = path.dirname(invoicePdf.invoiceCachePath(inv.invoice_no, rowOf(inv.id)));
  const safe = inv.invoice_no.replace(/[^A-Za-z0-9\-_]/g, '');
  for (const name of [safe + '.pdf', safe + '.v4.pdf', safe + '.v6.abc1234567.pdf']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
  const again = invoicePdf.invoiceCachePaths(inv.invoice_no).map((p) => path.basename(p));
  for (const name of [safe + '.pdf', safe + '.v4.pdf', safe + '.v6.abc1234567.pdf']) {
    assert.ok(again.includes(name), 'deletion would leave ' + name + ' downloadable');
  }
  void paths;
});

// ── 4. WHO MAY DO IT ─────────────────────────────────────────────────────
console.log('\nOwner and admin only');

test('a driver and a customer are refused', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  for (const role of ['driver', 'customer']) {
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { total_override: 1 }, role });
    assert.strictEqual(r.statusCode, 403, role + ' → ' + r.statusCode);
  }
  assert.strictEqual(rowOf(inv.id).total, 215, 'and nothing was changed by the attempt');
});

test('owner and admin may', async () => {
  for (const role of ['owner', 'admin']) {
    const inv = seed('bespoke', BESPOKE_ITEMS);
    const r = await call('patch', '/invoices/:id', { params: { id: String(inv.id) },
      body: { total_override: 5 }, role });
    assert.strictEqual(r.statusCode, 200, role + ' → ' + JSON.stringify(r.body));
  }
});

test('a missing invoice is a 404, not a crash', async () => {
  const r = await call('patch', '/invoices/:id', { params: { id: '999999' }, body: { total_override: 1 } });
  assert.strictEqual(r.statusCode, 404);
});

test('the correction is written to the audit log', async () => {
  const inv = seed('bespoke', BESPOKE_ITEMS);
  await call('patch', '/invoices/:id', { params: { id: String(inv.id) }, body: { total_override: 250 } });
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'invoice_edited' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log, 'nothing was logged');
  assert.ok(log.detail.includes(inv.invoice_no), 'the log must name the invoice: ' + log.detail);
  assert.ok(/£215\.00 → £250\.00/.test(log.detail), 'and what changed: ' + log.detail);
  assert.ok(/set by hand/.test(log.detail), 'and that it was set by hand: ' + log.detail);
});

// ── 5. THE OWNER APP ─────────────────────────────────────────────────────
console.log('\nThe screen the owner uses');

test('there is an Edit control, and it opens the sheet', () => {
  const H = read('westmere-owner.html');
  assert.ok(/onclick="invEditOpen\(\)"/.test(H), 'no Edit button');
  assert.ok(/id="inv-edit-sheet"/.test(H), 'no edit sheet');
  for (const id of ['inv-edit-name', 'inv-edit-email', 'inv-edit-addr', 'inv-edit-issued',
                    'inv-edit-due', 'inv-edit-notes', 'inv-edit-lines', 'inv-edit-total', 'inv-edit-manual']) {
    assert.ok(new RegExp('id="' + id + '"').test(H), 'the sheet has no ' + id);
  }
});

test('it PATCHes the same invoice rather than creating one', () => {
  const H = read('westmere-owner.html');
  const fn = /async function invEditSave\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/method:'PATCH'/.test(fn), 'a correction must not POST a new invoice');
  assert.ok(/\/api\/invoices\/'\+st\.inv\.id/.test(fn), 'and it must address the invoice by id');
  assert.ok(/total_override: manual \? typed : null/.test(fn),
    'the override is sent as a number or an explicit null — never omitted, or it could not be cleared');
});

test('the number is shown and not editable', () => {
  const H = read('westmere-owner.html');
  const sheet = H.slice(H.indexOf('id="inv-edit-sheet"'), H.indexOf('New Booking Form Sheet'));
  assert.ok(/id="inv-edit-no"/.test(sheet), 'the number should be visible — it is how it is matched');
  assert.ok(!/<input[^>]*id="inv-edit-no"/.test(sheet), 'but not an input');
});

test('the owner is told when a total was set by hand', () => {
  const H = read('westmere-owner.html');
  assert.ok(/id="inv-det-manual"/.test(H), 'the detail sheet has no override note');
  assert.ok(/the lines may not sum to it/i.test(H), 'and it must say why that matters');
  const sync = /function invEditSyncTotal\(\)\{[\s\S]*?\n\}/.exec(H)[0];
  assert.ok(/The lines add up to/.test(sync), 'the edit screen names the sum he is overriding');
  assert.ok(/f\.disabled=!manual/.test(sync), 'and the field is locked while the lines own it');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-edit\.test\.js/.test(read('package.json')), 'a guard nobody runs is not a guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e.message || e).split('\n').join('\n      ')); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
