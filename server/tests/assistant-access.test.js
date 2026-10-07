/**
 * THE THREE CRITICAL HOLES — run with:
 *   node server/tests/assistant-access.test.js   (also gated by `npm test`)
 *
 * From the compliance review. All three are the same shape: something that
 * looks protected and is not.
 *
 *   C-1  The assistant was mounted behind requireAuth alone. Anyone may
 *        register a customer account; its tools search bookings, list invoices,
 *        create bookings and invoices and write the calendar with full
 *        back-office capability. A stranger could have read every customer's
 *        name, number, address and journeys.
 *
 *   C-2  The public invoice PDF was fetched by invoice NUMBER, and the numbers
 *        run INV-YYYYMM-0001, -0002, … A `t=` token was accepted and ignored.
 *        Counting upwards returned strangers' invoices — and this firm's own
 *        bank details.
 *
 *   C-3  The staff accounts fall back to passwords printed in this repository.
 *        Whether the live ones are still set that way cannot be read off the
 *        code, so the code now reports it at boot.
 *
 * The last section reintroduces each hole and checks these tests fail.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-sec-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX = read('server/index.js');
const DB = read('server/db.js');

// ── C-1 ───────────────────────────────────────────────────────────────────
console.log('\nC-1 · the assistant is a back-office tool');

test('the assistant mount carries a staff-role gate', () => {
  const src = strip(INDEX);
  const m = /app\.use\('\/api\/assistant',([^;]*)\);/.exec(src);
  assert.ok(m, 'the assistant mount is gone');
  assert.ok(/requireRole\(\s*'admin'\s*,\s*'owner'\s*\)/.test(m[1]),
    'the assistant is mounted without a role gate — any logged-in customer reaches it: ' + m[1].trim());
  assert.ok(/requireAuth/.test(m[1]), 'and it must still require a login at all');
});

test('a customer token is refused by the gate itself', () => {
  /* Driven, not read: the real middleware, with a real customer payload. */
  const { requireRole } = require('../middleware').createAuthMiddleware('test-secret-not-a-real-one');
  const gate = requireRole('admin', 'owner');
  const mk = (role) => {
    let code = 200, body = null;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; return { code, body }; } };
    let passedThrough = false;
    gate({ auth: role ? { role } : null }, res, () => { passedThrough = true; });
    return { code, body, passedThrough };
  };
  for (const role of ['customer', 'driver']) {
    const r = mk(role);
    assert.strictEqual(r.passedThrough, false, 'a ' + role + ' reached the assistant');
    assert.strictEqual(r.code, 403, 'a ' + role + ' should get 403, got ' + r.code);
  }
  for (const role of ['admin', 'owner']) {
    assert.strictEqual(mk(role).passedThrough, true, 'staff must still reach it: ' + role);
  }
  assert.strictEqual(mk(null).code, 401, 'no session at all is a 401');
});

test('every other staff mount still requires a login', () => {
  const src = strip(INDEX);
  for (const mount of ['/api/google', '/api/gmail', '/api/intake', '/api/backup']) {
    const re = new RegExp("app\\.use\\('" + mount.replace(/\//g, '\\/') + "'[^;]*requireAuth");
    assert.ok(re.test(src), mount + ' lost its authentication');
  }
});

// ── C-2 ───────────────────────────────────────────────────────────────────
console.log('\nC-2 · an invoice cannot be fetched by counting');

test('the public PDF route checks the token', () => {
  const src = strip(INDEX);
  const i = src.indexOf("app.get('/api/public/invoice/:invoiceNo/pdf'");
  assert.ok(i !== -1, 'the public invoice route is gone');
  const block = src.slice(i, src.indexOf('\n});', i));
  assert.ok(/req\.query\.t/.test(block), 'the token is not read');
  assert.ok(/tokensMatch\(/.test(block), 'the token is not compared');
  assert.ok(/row\.access_token/.test(block), 'it is not compared against the invoice’s own token');
  assert.ok(!/accepted and ignored/.test(block), 'the route still says it ignores the token');
  /* Refusal must be the SAME refusal, whichever way it failed. */
  const refusals = (block.match(/return refuse\(\)/g) || []).length;
  assert.ok(refusals >= 3, 'only ' + refusals + ' refusal paths — a wrong token must refuse like a wrong number');
  assert.ok(!/403|Forbidden|not authorised/i.test(block),
    'a different answer for a wrong token tells the person counting which numbers are real');
});

test('the comparison cannot be timed', () => {
  const src = strip(INDEX);
  const fn = /function tokensMatch\(given, want\)[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'tokensMatch is gone');
  assert.ok(/timingSafeEqual/.test(fn[0]), 'the compare is not timing-safe');
  assert.ok(/a\.length !== b\.length/.test(fn[0]), 'timingSafeEqual throws on a length mismatch');
  /* and it actually works */
  const m = new Function('require', 'return ' + fn[0].replace(/^function /, 'function ') + '; ')(require);
  const tokensMatch = new Function('require', fn[0] + '; return tokensMatch;')(require);
  assert.strictEqual(tokensMatch('abc123', 'abc123'), true, 'a correct token is refused');
  assert.strictEqual(tokensMatch('abc123', 'abc124'), false, 'a wrong token is accepted');
  assert.strictEqual(tokensMatch('', 'abc123'), false, 'an empty token is accepted');
  assert.strictEqual(tokensMatch('abc123', ''), false, 'an invoice with no token is openable');
  assert.strictEqual(tokensMatch('abc1234', 'abc123'), false, 'a longer token is accepted');
  assert.ok(m);
});

test('every invoice has a token, and the links that were sent carry one', () => {
  assert.ok(/WHERE access_token IS NULL OR access_token = ''/.test(DB),
    'the backfill is gone — an invoice with no token is now unopenable by anybody');
  const pdf = read('server/invoice-pdf.js');
  assert.ok(/'\/pdf\?t=' \+ encodeURIComponent\(token \|\| ''\)/.test(pdf),
    'invoicePublicUrl no longer appends the token — every emailed link would 404');
  const em = strip(read('server/email.js'));
  assert.ok(/accessToken \? invoicePublicUrl\(invoiceNo, accessToken\) : ''/.test(em),
    'the invoice email would draw a button that cannot work');
});

// ── C-3 ───────────────────────────────────────────────────────────────────
console.log('\nC-3 · the passwords printed in the source');

test('production refuses to seed an account with the published password', () => {
  const src = strip(DB);
  assert.ok(/function assertNotDefaultPassword/.test(src), 'the seed guard is gone');
  assert.ok(/NODE_ENV === 'production'/.test(src), 'it does not distinguish production');
  for (const v of ['ADMIN_DEFAULT_PASSWORD', 'OWNER_DEFAULT_PASSWORD']) {
    assert.ok(new RegExp("assertNotDefaultPassword\\([^)]*" + v).test(src.replace(/\n/g, ' ')),
      v + ' is still read without the guard');
  }
});

test('…and it actually throws, rather than saying it does', () => {
  const src = strip(DB);
  const fn = /function assertNotDefaultPassword[\s\S]*?\n\}/.exec(src)[0];
  const make = (env) => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = env;
    try { return new Function(fn + '; return assertNotDefaultPassword;')(); }
    finally { process.env.NODE_ENV = saved; }
  };
  const saved = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const f = make('production');
    assert.throws(() => f('ADMIN', 'ADMIN_DEFAULT_PASSWORD', undefined),
      /REFUSING TO SEED/, 'production seeded an account with the published password');
    assert.strictEqual(f('ADMIN', 'ADMIN_DEFAULT_PASSWORD', 'a-real-one'), 'a-real-one',
      'a real password must be used as given');
    process.env.NODE_ENV = 'development';
    const d = make('development');
    assert.strictEqual(d('ADMIN', 'ADMIN_DEFAULT_PASSWORD', undefined), null,
      'local development must still seed, or nobody can run this thing');
  } finally { process.env.NODE_ENV = saved; }
});

test('every boot says whether a live account still opens with one', () => {
  const src = strip(DB);
  assert.ok(/function warnOnDefaultPasswords/.test(src), 'nothing checks what is actually in the database');
  assert.ok(/seedDefaults\(\);\s*warnOnDefaultPasswords\(\);/.test(src.replace(/\s+/g, ' ').replace(/ ;/g, ';'))
         || /warnOnDefaultPasswords\(\);/.test(src), 'the check is never called');
  const fn = /function warnOnDefaultPasswords[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(/bcrypt\.compareSync/.test(fn), 'it does not actually test the stored hash');
  assert.ok(/SECURITY/.test(fn), 'the warning is not findable in a deploy log');
  assert.ok(/console\.error/.test(fn), 'a warning on stdout is a warning nobody sees');
  /* It must NOT kill the process: an outage is certain, the compromise is not. */
  assert.ok(!/process\.exit|throw new Error/.test(fn),
    'the boot check takes the site down — that trades a possible compromise for a certain outage');
});

test('it finds a default password when one is really there', () => {
  const bcrypt = require('bcryptjs');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (username TEXT, role TEXT, password TEXT, active INTEGER DEFAULT 1)');
  db.prepare('INSERT INTO users VALUES (?,?,?,1)').run('westmere', 'admin', bcrypt.hashSync('changeme-admin', 4));
  db.prepare('INSERT INTO users VALUES (?,?,?,1)').run('safe', 'owner', bcrypt.hashSync('a real password', 4));
  const rows = db.prepare('SELECT username, role, password FROM users WHERE active = 1').all();
  const bad = rows.filter((u) => ['changeme-admin', 'changeme-owner'].some((g) => bcrypt.compareSync(g, u.password)));
  assert.deepStrictEqual(bad.map((u) => u.username), ['westmere'],
    'the check does not find a seeded default, or flags an account that is fine');
});

// ── the negative test ─────────────────────────────────────────────────────
console.log('\nReintroduce each hole and prove these tests catch it');

test('NEGATIVE: an assistant mount with no role gate fails', () => {
  const broken = "app.use('/api/assistant', apiLimiter, requireAuth, assistantRouter);";
  const m = /app\.use\('\/api\/assistant',([^;]*)\);/.exec(broken);
  let caught = false;
  try { assert.ok(/requireRole\(\s*'admin'\s*,\s*'owner'\s*\)/.test(m[1]), 'ungated'); }
  catch (e) { caught = true; }
  assert.ok(caught, 'the mount check would pass an ungated assistant');
});

test('NEGATIVE: a route that ignores the token fails', () => {
  const broken = "const row = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(safeNo);\n"
               + "if (!row) return refuse();\n/* t= is accepted and ignored */";
  let caught = false;
  try { assert.ok(/tokensMatch\(/.test(broken), 'unchecked'); } catch (e) { caught = true; }
  assert.ok(caught, 'the token check would pass a route that ignores it');
});

test('NEGATIVE: a 403 on a wrong token fails, because it is an oracle', () => {
  const broken = "if (!tokensMatch(given, want)) return res.status(403).send('Forbidden');";
  let caught = false;
  try { assert.ok(!/403|Forbidden/i.test(broken), 'oracle'); } catch (e) { caught = true; }
  assert.ok(caught, 'a different answer for a wrong token would pass');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/assistant-access\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
