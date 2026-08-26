/**
 * WHO MAY FETCH AN INVOICE —
 *   node server/tests/invoice-access.test.js   (also gated by `npm test`)
 *
 * The public PDF route took the invoice NUMBER as its only credential, and
 * invoice numbers are sequential: INV-202608-0001, 0002, 0003. Anyone who
 * guessed one was handed a PDF carrying the business's bank details and a
 * customer's name and address. A number printed on a document the customer
 * keeps is an identifier; it was being used as a secret.
 *
 * The fix is bookings.pay_token's, applied to invoices: a per-row secret minted
 * once, never re-minted (re-minting invalidates the link in an invoice email
 * already sent), and backfilled so existing invoices keep working.
 *
 * WHAT THIS FILE ACTUALLY GUARDS
 *   · no token, wrong token, ANOTHER invoice's token, and a number that does
 *     not exist must all produce the SAME refusal — a distinct message, or a
 *     403 where a 404 belongs, tells a stranger which numbers are real, which
 *     is the thing being closed;
 *   · the lookup is BY TOKEN, so a guessed number never reaches a row at all;
 *   · walking the sequence gets nothing;
 *   · emailed links carry the token, and a link that cannot work is not drawn;
 *   · staff and the customer's own My Account copy stay on AUTH, not tokens —
 *     an owner's screen has no business showing a customer's access secret.
 *
 * Runs the REAL shipped handler against throwaway databases. Exit 1.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX = read('server/index.js');
const API   = read('server/api.js');
const DB    = read('server/db.js');
const EMAIL = read('server/email.js');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-acc-'));
process.env.INVOICES_DIR = TMP;

/* THE REAL HANDLER, lifted out of index.js by brace matching — never a
   character count, and never a re-implementation. A copy of the route written
   here would pass this file while the shipped one stayed open. */
function publicPdfHandler() {
  const marker = "app.get('/api/public/invoice/:invoiceNo/pdf'";
  const start = INDEX.indexOf(marker);
  assert.ok(start !== -1, 'the public invoice route is gone from server/index.js');
  const arrow = INDEX.indexOf('=>', INDEX.indexOf('async (req, res)', start));
  let depth = 0;
  for (let j = INDEX.indexOf('{', arrow); j < INDEX.length; j++) {
    if (INDEX[j] === '{') depth++;
    else if (INDEX[j] === '}') { depth--; if (depth === 0) return INDEX.slice(INDEX.indexOf('{', arrow) + 1, j); }
  }
  throw new Error('unbalanced braces extracting the public invoice route');
}
const HANDLER = publicPdfHandler();

const Database = require('better-sqlite3');
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL UNIQUE, kind TEXT, total REAL,
      recipient_name TEXT, recipient_email TEXT, recipient_phone TEXT, recipient_addr TEXT,
      issued_date TEXT, due_date TEXT, period_label TEXT, notes TEXT,
      line_items_json TEXT, access_token TEXT
    );
    CREATE TABLE integrations (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare("INSERT INTO integrations (key,value) VALUES ('invoice_settings',?)").run(JSON.stringify({
    business_name: 'Westmere Private Hire', phone: '07930 342593',
    bank_name: 'Monzo', account_name: 'N Krajnyk', sort_code: '00-00-00', account_no: '00000000'
  }));
  const ins = db.prepare(`INSERT INTO invoices
    (invoice_no,kind,total,recipient_name,recipient_email,issued_date,due_date,line_items_json,access_token)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // Sequential numbers, deliberately — that is the shape being defended.
  ins.run('INV-202608-0001', 'bespoke', 55, 'APD Private Hire', 'a@b.co', '2026-08-02', '2026-08-16',
    JSON.stringify([{ description: 'A journey', amount: 55 }]), 'a'.repeat(32));
  ins.run('INV-202608-0002', 'bespoke', 90, 'Someone Else Ltd', 'c@d.co', '2026-08-03', '2026-08-17',
    JSON.stringify([{ description: 'Another journey', amount: 90 }]), 'b'.repeat(32));
  return db;
}

function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, type_: null,
    status(c) { this.statusCode = c; return this; },
    type(t) { this.type_ = t; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; }
  };
  return res;
}

async function callRoute(db, invoiceNo, query) {
  const res = makeRes();
  const req = { params: { invoiceNo }, query: query || {} };
  const sandbox = {
    getDb: () => db, req, res,
    /* The handler does require('./invoice-pdf') — a path relative to server/,
       not to this file. Resolved against the SHIPPED module, so this exercises
       the real generator rather than a stand-in. */
    require: (m) => require(m.charAt(0) === '.' ? path.join(ROOT, 'server', m) : m),
    console: { error: () => {}, log: () => {}, warn: () => {} },
    Buffer, String, Number, Object, JSON, Date
  };
  vm.createContext(sandbox);
  await vm.runInContext('(async function(req,res){' + HANDLER + '})(req,res)', sandbox);
  return res;
}

const GOOD = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

console.log('\nThe number alone is not a credential');

test('a guessed sequential number with NO token returns nothing', async () => {
  const db = makeDb();
  const res = await callRoute(db, 'INV-202608-0001', {});
  assert.strictEqual(res.statusCode, 404, 'expected 404, got ' + res.statusCode);
  assert.ok(!Buffer.isBuffer(res.body), 'no PDF may be returned');
  assert.ok(!/Monzo|00000000|APD Private Hire/.test(String(res.body || '')),
    'and nothing about the invoice may leak into the refusal');
});

test('a WRONG token returns nothing', async () => {
  const db = makeDb();
  const res = await callRoute(db, 'INV-202608-0001', { t: 'f'.repeat(32) });
  assert.strictEqual(res.statusCode, 404);
  assert.ok(!Buffer.isBuffer(res.body));
});

test("ANOTHER invoice's token does not open this one", async () => {
  const db = makeDb();
  const res = await callRoute(db, 'INV-202608-0001', { t: OTHER });
  assert.strictEqual(res.statusCode, 404,
    'a valid token must only open the invoice it belongs to');
  assert.ok(!Buffer.isBuffer(res.body));
});

test('the CORRECT token returns the PDF', async () => {
  const db = makeDb();
  const res = await callRoute(db, 'INV-202608-0001', { t: GOOD });
  assert.strictEqual(res.statusCode, 200, 'the legitimate recipient must still get their invoice');
  assert.ok(Buffer.isBuffer(res.body) && res.body.slice(0, 5).toString() === '%PDF-',
    'and it must be a real PDF');
  assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
  assert.ok(/attachment/.test(res.headers['Content-Disposition']));
});

test('?inline=1 still works for the tokenised link', async () => {
  const db = makeDb();
  const res = await callRoute(db, 'INV-202608-0001', { t: GOOD, inline: '1' });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(/^inline/.test(res.headers['Content-Disposition']));
});

test('walking the whole sequence gets nothing', async () => {
  const db = makeDb();
  for (let i = 1; i <= 12; i++) {
    const no = 'INV-202608-' + String(i).padStart(4, '0');
    const res = await callRoute(db, no, {});
    assert.strictEqual(res.statusCode, 404, no + ' answered ' + res.statusCode);
    assert.ok(!Buffer.isBuffer(res.body), no + ' returned a document');
  }
});

console.log('\nThe refusal tells a stranger nothing');

test('every refusal is byte-for-byte identical', async () => {
  /* An invoice that EXISTS must not be distinguishable from one that does not.
     Different wording, a different length, or a 403 beside a 404 is an
     enumeration oracle even when no document is served. */
  const db = makeDb();
  const cases = [
    ['real number, no token',        'INV-202608-0001', {}],
    ['real number, wrong token',     'INV-202608-0001', { t: 'f'.repeat(32) }],
    ["real number, other's token",   'INV-202608-0001', { t: OTHER }],
    ['number that does not exist',   'INV-202608-9999', {}],
    ['nonexistent + a real token',   'INV-202608-9999', { t: GOOD }],
    ['junk number',                  'not-an-invoice',  { t: GOOD }]
  ];
  const seen = [];
  for (const [label, no, q] of cases) {
    const res = await callRoute(db, no, q);
    seen.push({ label, status: res.statusCode, body: String(res.body || '') });
  }
  const first = seen[0];
  for (const s of seen) {
    assert.strictEqual(s.status, first.status, s.label + ' answered ' + s.status + ', not ' + first.status);
    assert.strictEqual(s.body, first.body, s.label + ' produced a different page — that is an oracle');
  }
  assert.ok(!/INV-202608/.test(first.body), 'the refusal must not echo the number back');
});

test('the lookup is BY TOKEN, so a guessed number never reaches a row', () => {
  assert.ok(/SELECT \* FROM invoices WHERE access_token = \?/.test(INDEX),
    'the query must be keyed on the token — keying on the number and then checking ' +
    'the token still answers "this invoice exists"');
  assert.ok(!/WHERE invoice_no = \?'\)\.get\(safeNo\)/.test(INDEX),
    'the old number-keyed lookup must be gone');
  assert.ok(/timingSafeEqual/.test(INDEX),
    'and the number check itself must not be usable to narrow a guess');
});

test('a short or absent token is refused before any query runs', () => {
  assert.ok(/if \(!safeNo \|\| !token \|\| token\.length < 16\) return refuse\(\)/.test(INDEX),
    'a blank t= must not be allowed to match a row whose token is NULL');
});

test('a NULL-token row can never be opened by a blank token', async () => {
  /* The failure this prevents: `WHERE access_token = ''` matching a row the
     backfill missed. */
  const db = makeDb();
  db.prepare("UPDATE invoices SET access_token = NULL WHERE invoice_no = 'INV-202608-0001'").run();
  for (const q of [{}, { t: '' }, { t: 'null' }, { t: '                ' }]) {
    const res = await callRoute(db, 'INV-202608-0001', q);
    assert.strictEqual(res.statusCode, 404, 'a tokenless row must not be reachable');
  }
});

console.log('\nThe token itself');

test('the column exists, is unique, and is backfilled on boot', () => {
  assert.ok(/ALTER TABLE invoices ADD COLUMN access_token TEXT/.test(DB), 'the column must be added');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_access_token/.test(DB),
    'unique, or two invoices could collide on one token');
  assert.ok(/SELECT id FROM invoices WHERE access_token IS NULL OR access_token = ''/.test(DB),
    'existing invoices must be backfilled or their links stop working');
  assert.ok(/randomBytes\(16\)\.toString\('hex'\)/.test(DB), 'from a real CSPRNG');
});

test('the backfill is idempotent — it only touches rows without one', () => {
  const mig = /const invInfo = db\.prepare\('PRAGMA table_info\(invoices\)'\)[\s\S]*?\n  \} catch/.exec(DB);
  assert.ok(mig, 'the migration block is missing');
  assert.ok(/WHERE access_token IS NULL OR access_token = ''/.test(mig[0]),
    'a blanket UPDATE would re-mint on every boot and break every link already emailed');
  assert.ok(/IF NOT EXISTS/.test(mig[0]) && /!invInfo\.find/.test(mig[0]),
    'and it must be safe to run on a database that already has the column');
});

test('a token is never re-minted', () => {
  const fn = /function ensureInvoiceToken\(db, row\)[\s\S]*?\n\}/.exec(read('server/invoice-pdf.js'));
  assert.ok(fn, 'ensureInvoiceToken is missing');
  assert.ok(/if \(row && row\.access_token\) return row\.access_token;/.test(fn[0]),
    'an existing token must be returned as-is — re-minting invalidates the link in an ' +
    'invoice email that has already been sent');
});

console.log('\nLegitimate recipients still get in');

test('the emailed reminder link carries a token', () => {
  const r = EMAIL.slice(EMAIL.indexOf('async function sendInvoiceReminder'));
  assert.ok(/invoicePublicUrl\(invoiceNo, accessToken\)/.test(r),
    'the link must be built by the one helper, with the token');
  assert.ok(!/api\/public\/invoice\/\$\{encodeURIComponent\(invoiceNo/.test(r),
    'the untokenised URL must be gone');
  assert.ok(/accessToken \? invoicePublicUrl/.test(r) && /\$\{pdfUrl \? `/.test(r),
    'and with no token there must be NO button — one that cannot work is worse than none');
});

test('the route that sends the reminder mints the token first', () => {
  const r = API.slice(API.indexOf("router.post('/invoices/:id/remind'"));
  assert.ok(/ensureInvoiceToken\(db, row\)/.test(r.slice(0, 1600)), 'the token must be ensured');
  assert.ok(/row\.invoice_no, row\.total, null, token/.test(r.slice(0, 1600)), 'and passed to the email');
});

test('nothing anywhere builds an untokenised public invoice URL', () => {
  /* Comments stripped first. These files EXPLAIN the tokenised route in prose,
     and a rule that cannot tell prose from code fails on its own explanation —
     which has now happened four times in this codebase. */
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [name, src] of [['email.js', EMAIL], ['api.js', API], ['owner', OWNER], ['admin', ADMIN]]) {
    const hits = (code(src).match(/\/api\/public\/invoice\/[^\n]*/g) || [])
      .filter(h => h.indexOf('t=') === -1 && h.indexOf('invoicePublicUrl') === -1);
    assert.deepStrictEqual(hits, [], name + ' still builds an untokenised invoice link');
  }
});

console.log('\nStaff and the customer stay on AUTH');

test('the staff apps use the AUTHENTICATED route, not a token', () => {
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const fn = /function _invPdfUrl\(invoiceId, inline\)\{[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, name + ': _invPdfUrl is missing');
    assert.ok(/\/api\/invoices\/'\+encodeURIComponent\(invoiceId\)\+'\/pdf/.test(fn[0]),
      name + ': staff must go through the session-gated route');
    assert.ok(!/public\/invoice/.test(fn[0]),
      name + ": an owner's screen has no business carrying a customer's access secret");
  }
});

test('the staff download route is still gated by role', () => {
  const r = API.slice(API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/\['admin', 'owner'\]\.includes\(req\.auth\.role\)/.test(r.slice(0, 400)),
    'owner/admin only');
  assert.ok(!/access_token/.test(r.slice(0, 1200)), 'and it needs no token — auth is the gate');
});

test("the customer's own copy is still scoped to the caller", () => {
  const r = API.slice(API.indexOf("router.get('/customer/invoices/:id/pdf'"), API.indexOf("router.get('/invoices/:id/pdf'"));
  assert.ok(/You can only download your own invoices/.test(r),
    'the ownership check must remain');
  assert.ok(!/access_token/.test(r), 'My Account is authenticated; it needs no token');
});

test('the create routes hand the staff app an id, not a token', () => {
  assert.ok(/invoiceId: invRow \? invRow\.id : null/.test(API), 'the account invoice');
  assert.ok(/invoiceId: bespInvRow \? bespInvRow\.id : null/.test(API), 'and the bespoke one');
  assert.ok(!/access_token/.test(API.slice(API.indexOf('ok: true, invoiceNo, invoiceId'), API.indexOf('ok: true, invoiceNo, invoiceId') + 500)),
    'the access token must not be handed to the browser with the invoice');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-access\.test\.js/.test(read('package.json')));
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
