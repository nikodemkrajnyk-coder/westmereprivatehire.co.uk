/**
 * SENDING AN INVOICE THAT ALREADY EXISTS —
 *   node server/tests/invoice-send.test.js   (also gated by `npm test`)
 *
 * An invoice could only be emailed at the MOMENT it was created, by passing
 * send_email on the create route. There was no way to send one afterwards — so
 * the owner app, wanting to send an invoice it had just made, DELETED the
 * invoice and created it again with the flag set. That was in the file, comment
 * and all: it destroyed the row, its id and its created_at to change one
 * boolean, and if the second call failed the invoice was simply gone.
 *
 * POST /invoices/:id/send sends the invoice in front of it. What has to hold:
 *
 *   IT GOES TO THE BILL-TO ADDRESS AND NOWHERE ELSE. A "send it to this
 *   address instead" parameter would be a way to mail somebody else's invoice
 *   out of the owner app, so the route takes no recipient at all.
 *
 *   THE PDF IS ATTACHED, and it is the SAME document Download and Print
 *   produce — resolveInvoicePdf, not a second rendering that could differ.
 *
 *   OWNER/ADMIN ONLY, and a driver or a customer token is refused.
 *
 *   NOTHING IS RECREATED. The row keeps its id.
 *
 * Runs the REAL shipped handler against throwaway databases, with the mailer
 * intercepted. Nothing is sent. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const API = read('server/api.js');
const OWNER = read('westmere-owner.html');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-send-'));
process.env.INVOICES_DIR = TMP;

/** The shipped handler, brace-matched out of api.js — never re-implemented. */
function handlerFor(marker) {
  const start = API.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + marker);
  const brace = API.indexOf('{', API.indexOf('=>', start));
  let depth = 0;
  for (let j = brace; j < API.length; j++) {
    if (API[j] === '{') depth++;
    else if (API[j] === '}') { depth--; if (depth === 0) return API.slice(brace + 1, j); }
  }
  throw new Error('unbalanced braces');
}
const SEND = handlerFor("router.post('/invoices/:id/send'");

const Database = require('better-sqlite3');
function makeDb(over) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL UNIQUE, kind TEXT, total REAL,
      recipient_name TEXT, recipient_email TEXT, recipient_phone TEXT, recipient_addr TEXT,
      issued_date TEXT, due_date TEXT, period_label TEXT, notes TEXT,
      line_items_json TEXT, access_token TEXT, emailed INTEGER DEFAULT 0
    );
    CREATE TABLE integrations (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT, user_id INTEGER, action TEXT, detail TEXT, ip TEXT);
  `);
  db.prepare("INSERT INTO integrations (key,value) VALUES ('invoice_settings',?)").run(JSON.stringify({
    business_name: 'Westmere Private Hire', phone: '07930 342593',
    bank_name: 'Monzo', account_name: 'N Krajnyk', sort_code: '00-00-00', account_no: '00000000'
  }));
  const r = Object.assign({
    invoice_no: 'INV-202608-0001', kind: 'bespoke', total: 250,
    recipient_name: 'Echopoint Medical Ltd', recipient_email: 'pri@example.com',
    recipient_phone: '+44 7545 700837', recipient_addr: '65-69 East Road\nHackney N1 6AH',
    issued_date: '2026-08-26', due_date: '2026-09-09', period_label: null, notes: null,
    line_items_json: JSON.stringify([{ description: 'Private hire journey — Pulborough to Hackney', amount: 250 }]),
    access_token: 'a'.repeat(32)
  }, over || {});
  db.prepare(`INSERT INTO invoices
    (invoice_no,kind,total,recipient_name,recipient_email,recipient_phone,recipient_addr,
     issued_date,due_date,period_label,notes,line_items_json,access_token)
    VALUES (@invoice_no,@kind,@total,@recipient_name,@recipient_email,@recipient_phone,@recipient_addr,
            @issued_date,@due_date,@period_label,@notes,@line_items_json,@access_token)`).run(r);
  return db;
}

/* THE MAILER, INTERCEPTED at compile time — the senders call sendEmail by name,
   so a stub on the module object would never be reached and every assertion
   here would pass while the real one ran. */
function emailModule() {
  const p = path.join(ROOT, 'server', 'email.js');
  const src = fs.readFileSync(p, 'utf8').replace('async function sendEmail(',
    'async function sendEmail(a,b,c,d,e,f){global.__SENT.push({to:a,subject:b,html:c,opts:f});return "captured";}\nasync function __real(');
  assert.ok(src.indexOf('__real') !== -1, 'mailer interception failed — refusing to run');
  global.__SENT = [];
  const Module = require('module');
  const m = new Module(p, null);
  m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  return m.exports;
}

function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader() { return this; }
  };
}

async function send(db, opts) {
  const o = opts || {};
  const res = makeRes();
  const req = {
    params: { id: String(o.id || 1) },
    auth: o.auth || { role: 'owner', type: 'user', id: 1 },
    body: o.body || {}, ip: '::1'
  };
  const mailer = emailModule();
  const sandbox = {
    getDb: () => db, req, res,
    require: (m) => (m === './email' ? mailer
      : require(m.charAt(0) === '.' ? path.join(ROOT, 'server', m) : m)),
    console: { error: () => {}, log: () => {}, warn: () => {} },
    parseInt, isNaN, String, Number, Object, JSON, Date, Buffer
  };
  vm.createContext(sandbox);
  await vm.runInContext('(async function(req,res){' + SEND + '})(req,res)', sandbox);
  return { res, sent: global.__SENT };
}

console.log('\nWhat it sends, and to whom');

test('it emails the invoice, with the PDF attached', async () => {
  const db = makeDb();
  const { res, sent } = await send(db);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(sent.length, 1, 'exactly one email');
  assert.strictEqual(sent[0].to, 'pri@example.com', 'to the bill-to address');
  const att = (sent[0].opts && sent[0].opts.attachments) || [];
  assert.strictEqual(att.length, 1, 'the PDF must be attached');
  assert.strictEqual(Buffer.from(att[0].content, 'base64').slice(0, 5).toString(), '%PDF-',
    'and BE a PDF — a filename check alone passes on base64 of anything');
  assert.strictEqual(res.body.attached, true);
});

test('it is the branded invoice email we built, not a bare note', async () => {
  const db = makeDb();
  const { sent } = await send(db);
  const html = sent[0].html;
  assert.ok(/westmere-email-hero\.jpg/.test(html), 'the branded shell');
  assert.ok(/Payment method<\/td>[\s\S]{0,400}?>Invoice</.test(html), '"Payment method — Invoice"');
  assert.ok(!/westmere-pay\.html|\/api\/public\/pay\/|Pay Now/i.test(html), 'and no pay buttons');
  assert.ok(/Your Westmere Private Hire invoice/.test(sent[0].subject),
    'the professional subject: ' + sent[0].subject);
  assert.ok(/INV-202608-0001/.test(sent[0].subject), 'naming the invoice');
});

test('an ACCOUNT invoice sends its own shape', async () => {
  const db = makeDb({
    invoice_no: 'INV-202608-0002', kind: 'account', total: 115, period_label: 'August 2026',
    recipient_name: 'The Grand Hotel Brighton', recipient_email: 'accounts@example.com',
    line_items_json: JSON.stringify([
      { ref: 'WPH-4871', date: '2026-08-03', time: '05:30', pickup: 'Brighton', destination: 'Gatwick Airport', fare: 75, flight: 'BA2751' },
      { ref: 'WPH-4903', date: '2026-08-18', time: '19:10', pickup: 'Brighton', destination: 'Lewes', fare: 40, flight: '' }
    ])
  });
  const { res, sent } = await send(db);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(/2 journeys/.test(sent[0].html), 'the account summary');
  assert.ok(/August 2026/.test(sent[0].html), 'and the period');
});

test('the recipient CANNOT be overridden by the request', async () => {
  /* A "send it to this address instead" parameter would be a way to mail one
     customer's invoice — bank details and all — to any address, from a screen
     the owner uses every day. */
  const db = makeDb();
  const { sent } = await send(db, { body: { to: 'attacker@example.com', email: 'attacker@example.com', recipient: { email: 'attacker@example.com' } } });
  assert.strictEqual(sent[0].to, 'pri@example.com', 'the bill-to address, whatever the body said');
  assert.ok(!/req\.body\.(to|email|recipient)/.test(API.slice(API.indexOf("router.post('/invoices/:id/send'"), API.indexOf("router.post('/invoices/:id/send'") + 3000)),
    'the route must not read a recipient from the request at all');
});

test('an invoice with no email address is refused, and nothing is sent', async () => {
  const db = makeDb({ recipient_email: null });
  const { res, sent } = await send(db);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(sent.length, 0, 'nothing may go out');
  assert.ok(/No email address/.test(res.body.error));
});

test('a malformed address is refused rather than handed to the mailer', async () => {
  const db = makeDb({ recipient_email: 'not-an-email' });
  const { res, sent } = await send(db);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(sent.length, 0);
});

console.log('\nWho may press it');

test('owner and admin may; a driver and a customer may not', async () => {
  for (const role of ['owner', 'admin']) {
    const { res } = await send(makeDb(), { auth: { role, type: 'user', id: 1 } });
    assert.strictEqual(res.statusCode, 200, role + ' must be allowed');
  }
  for (const auth of [{ role: 'driver', type: 'user', id: 2 }, { role: 'customer', type: 'customer', id: 3 }]) {
    const { res, sent } = await send(makeDb(), { auth });
    assert.strictEqual(res.statusCode, 403, auth.role + ' must be refused');
    assert.strictEqual(sent.length, 0);
  }
});

test('a missing invoice is a 404, not a crash', async () => {
  const { res, sent } = await send(makeDb(), { id: 999 });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(sent.length, 0);
});

console.log('\nWhat it does NOT do');

test('nothing is deleted or recreated — the row keeps its id', async () => {
  const db = makeDb();
  const before = db.prepare('SELECT id, invoice_no FROM invoices').all();
  await send(db);
  const after = db.prepare('SELECT id, invoice_no FROM invoices').all();
  assert.deepStrictEqual(after, before, 'the invoice must survive being sent, unchanged in identity');
});

test('the owner app no longer deletes an invoice to send it', () => {
  assert.ok(!/delete and recreate/i.test(OWNER), 'the hack comment is gone');
  const fn = /async function ownerQuickInvoice\([\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'ownerQuickInvoice is missing');
  assert.ok(!/method:'DELETE'/.test(fn[0]),
    'sending an invoice must not delete it — a failed recreate lost the invoice entirely');
  assert.ok(/\/send'/.test(fn[0]) || /\/send',/.test(fn[0]), 'it must use the send route');
});

test('it marks the invoice as emailed, and records who sent it', async () => {
  const db = makeDb();
  await send(db);
  assert.strictEqual(db.prepare('SELECT emailed FROM invoices WHERE id = 1').get().emailed, 1);
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'invoice_sent'").all();
  assert.strictEqual(log.length, 1, 'the send must be recorded');
  assert.ok(/INV-202608-0001 to pri@example\.com/.test(log[0].detail));
});

test('the PDF is the SAME document Download and Print produce', () => {
  const r = API.slice(API.indexOf("router.post('/invoices/:id/send'"));
  assert.ok(/resolveInvoicePdf\(db, row\)/.test(r.slice(0, 3000)),
    'a second rendering could differ from the one the owner just previewed');
});

console.log('\nThe button');

test('there is a Send Invoice control on the invoice view', () => {
  assert.ok(/id="inv-det-send-btn"/.test(OWNER), 'the button must exist');
  assert.ok(/>Send Invoice</.test(OWNER), 'and say what it does');
  assert.ok(/onclick="invDetailSend\(\)"/.test(OWNER), 'and be wired');
});

test('it confirms, naming the address, before anything leaves', () => {
  const fn = /async function invDetailSend\(\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'invDetailSend is missing');
  assert.ok(/confirm\(/.test(fn[0]), 'this is the one control here that reaches a customer');
  assert.ok(/\+to\+/.test(fn[0]), 'and the address must be in the confirmation, not left to be guessed');
  assert.ok(/method:'POST'/.test(fn[0]) && /\/send'/.test(fn[0]), 'it must POST to the send route');
  assert.ok(/credentials:'include'/.test(fn[0]), 'with the session');
});

test('the button is disabled when there is no address to send to', () => {
  assert.ok(/sendBtn\.disabled=!data\.recipientEmail/.test(OWNER),
    'an invoice with no email must not offer a Send that cannot work');
  assert.ok(/No email address on this invoice/.test(OWNER), 'and must say why');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-send\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
