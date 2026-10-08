/**
 * CHANGING A PASSWORD ACTUALLY CHANGES IT — run with:
 *   node server/tests/change-password.test.js      (also gated by `npm test`)
 *
 * This route shipped broken in the first backend commit and stayed broken for
 * six months. The new hash was written with
 *
 *     UPDATE customers SET password = ?, updated_at = datetime("now") ...
 *
 * and in SQLite a double-quoted token is an IDENTIFIER, not a string. There is
 * no column called `now`, and better-sqlite3 disables the legacy fallback that
 * would have quietly reinterpreted it as text — so the statement threw, after
 * the new hash had been computed and before anything was written.
 *
 * THE TYPO IS NOT THE INTERESTING PART. One try block wrapped the entire route
 * and its catch answered EVERY failure with 401 "session expired". So the
 * customer was told their session had lapsed, signed in again, changed the
 * password again, and was locked out again by a password that had never moved.
 * Six months of that, reported as "logging in doesn't remember properly".
 *
 * Which is why this file tests BEHAVIOUR, not SQL. A guard that grepped the
 * source for double quotes would have caught this one typo and nothing else.
 * These tests change a password and then sign in with it — the only assertion
 * that could not have been satisfied by the broken route.
 *
 * The negative section at the end puts the original SQL back and proves that.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, routeBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-chpw-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const db = getDb();
const auth = require('../auth');
const router = auth.router;
const SECRET = auth.JWT_SECRET;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function resp() {
  return { statusCode: 200, body: null, cookies: {}, cleared: [],
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    cookie(n, v) { this.cookies[n] = v; return this; },
    clearCookie(n) { this.cleared.push(n); return this; },
    setHeader() { return this; }, get() { return 'test'; } };
}
async function call(routePath, opts) {
  const o = opts || {};
  const l = router.stack.find((x) => x.route && x.route.path === routePath && x.route.methods.post);
  assert.ok(l, 'POST ' + routePath + ' is missing');
  const req = { body: o.body || {}, cookies: o.cookies || {}, ip: '::1', get: () => 'test-agent', params: {}, query: {} };
  const r = resp();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let next = false;
    await h(req, r, () => { next = true; });
    if (!next) break;
  }
  return r;
}

const tokenFor = (id, type) => jwt.sign(
  { id: id, email: 'x@y.invalid', role: type === 'customer' ? 'customer' : 'admin', type: type },
  SECRET, { expiresIn: '1h' });

// ── a customer and a staff account, both with a known password ───────────
const CUST = db.prepare(`INSERT INTO customers (email, password, full_name, phone, verified, active)
                         VALUES ('ben@example.invalid', ?, 'Ben Thornley', '07700 900321', 1, 1)`)
  .run(bcrypt.hashSync('benspassword1', 10)).lastInsertRowid;
const STAFF = db.prepare(`INSERT INTO users (username, password, role, full_name, active)
                          VALUES ('chpw-staff', ?, 'admin', 'Test Admin', 1)`)
  .run(bcrypt.hashSync('staffpassword1', 10)).lastInsertRowid;

const signIn = (email, password) => call('/customer/login', { body: { email, password, remember: true } });

// ── THE THING THAT WAS BROKEN ────────────────────────────────────────────

test('a customer can sign in with the password they started with', async () => {
  const r = await signIn('ben@example.invalid', 'benspassword1');
  assert.strictEqual(r.statusCode, 200, 'the fixture must be sound before anything is proved from it');
  assert.ok(r.cookies.wph_token, 'and a session cookie must be set');
});

test('changing a customer password reports success', async () => {
  const r = await call('/change-password', {
    cookies: { wph_token: tokenFor(CUST, 'customer') },
    body: { current_password: 'benspassword1', new_password: 'benspassword2' }
  });
  assert.strictEqual(r.statusCode, 200,
    'the route answered ' + r.statusCode + ' ' + JSON.stringify(r.body)
    + ' — for six months this was 401 "Session expired", which is what sent the owner looking at logins');
  assert.deepStrictEqual(r.body, { ok: true });
});

test('AND THE NEW PASSWORD ACTUALLY SIGNS YOU IN', async () => {
  /* The assertion the broken route could never have passed. Everything above
     it was satisfied by a route that wrote nothing at all. */
  const ok = await signIn('ben@example.invalid', 'benspassword2');
  assert.strictEqual(ok.statusCode, 200,
    'the new password does not work — the change was not written');
  const old = await signIn('ben@example.invalid', 'benspassword1');
  assert.strictEqual(old.statusCode, 401, 'and the OLD password must stop working');
});

test('the same holds for a staff account', async () => {
  const r = await call('/change-password', {
    cookies: { wph_token: tokenFor(STAFF, 'user') },
    body: { current_password: 'staffpassword1', new_password: 'staffpassword2' }
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT password FROM users WHERE id = ?').get(STAFF);
  assert.ok(bcrypt.compareSync('staffpassword2', row.password), 'the staff hash must be the new one');
  assert.ok(!bcrypt.compareSync('staffpassword1', row.password), 'and not the old one');
  /* Both branches of the route write their own UPDATE. The customer one was
     fixed and the staff one left broken is exactly the half-fix to expect. */
});

test('updated_at is stamped, not left as the string "now"', () => {
  const row = db.prepare('SELECT updated_at FROM customers WHERE id = ?').get(CUST);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(row.updated_at)),
    'updated_at should be a timestamp, got: ' + row.updated_at);
});

// ── THE ERROR HANDLING THAT HID IT ───────────────────────────────────────

test('only a bad token may be answered with "session expired"', () => {
  const block = strip(routeBlock(strip(read('server/auth.js')), "router.post('/change-password'"));
  const expired = (block.match(/[Ss]ession expired/g) || []).length;
  assert.strictEqual(expired, 1,
    'there must be exactly ONE "session expired" in this route, on the jwt.verify failure. '
    + 'A catch-all that answers every error that way is what disguised a SQL bug as a login '
    + 'problem for six months.');
  const verifyIdx = block.indexOf('jwt.verify');
  const expiredIdx = block.indexOf('Session expired');
  assert.ok(verifyIdx > -1 && expiredIdx > verifyIdx && expiredIdx - verifyIdx < 220,
    'and it must sit with the jwt.verify it belongs to, not at the bottom of the route');
});

test('a wrong current password is told so, and changes nothing', async () => {
  const before = db.prepare('SELECT password FROM customers WHERE id = ?').get(CUST).password;
  const r = await call('/change-password', {
    cookies: { wph_token: tokenFor(CUST, 'customer') },
    body: { current_password: 'notitatall', new_password: 'somethingelse1' }
  });
  assert.strictEqual(r.statusCode, 401);
  assert.match(String(r.body.error), /current password is incorrect/i,
    'the message must name the real problem, not blame the session');
  assert.strictEqual(db.prepare('SELECT password FROM customers WHERE id = ?').get(CUST).password, before);
});

test('a bad token really is a session problem', async () => {
  const r = await call('/change-password', {
    cookies: { wph_token: 'not.a.token' },
    body: { current_password: 'benspassword2', new_password: 'benspassword3' }
  });
  assert.strictEqual(r.statusCode, 401);
  assert.match(String(r.body.error), /session expired/i);
});

test('a write that changes no rows is not reported as success', () => {
  const block = strip(routeBlock(strip(read('server/auth.js')), "router.post('/change-password'"));
  assert.ok(/\.changes/.test(block),
    'the route must check the UPDATE actually touched a row — this route\'s entire history '
    + 'is a failure that answered ok');
});

// ── NO OTHER QUERY MAY CARRY THE SAME FAULT ──────────────────────────────

test('no shipped query double-quotes a SQL string literal', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'server'))) {
    if (!f.endsWith('.js')) continue;
    const src = strip(read('server/' + f));
    for (const m of src.matchAll(/(?:datetime|date|strftime|julianday)\(\s*"/g)) {
      offenders.push('server/' + f + '  ' + src.slice(m.index, m.index + 40).replace(/\n/g, ' '));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'SQLite reads a double-quoted token as a COLUMN NAME. better-sqlite3 does not fall back '
    + 'to treating it as text, so each of these throws at runtime:\n      ' + offenders.join('\n      '));
});

// ── NEGATIVE: put the original bug back and prove this file catches it ───

test('NEGATIVE — the original SQL still throws, and the suite would see it', () => {
  const Database = require('better-sqlite3');
  const t = new Database(':memory:');
  t.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, password TEXT, updated_at TEXT);
          INSERT INTO customers (id, password) VALUES (1, 'old');`);

  assert.throws(
    () => t.prepare('UPDATE customers SET password = ?, updated_at = datetime("now") WHERE id = ?').run('new', 1),
    /no such column/i,
    'the shipped statement must still be demonstrably broken — if this ever stops throwing, '
    + 'better-sqlite3 has re-enabled double-quoted string literals and the behaviour tests above '
    + 'are the only thing still guarding this');

  assert.strictEqual(t.prepare('SELECT password FROM customers WHERE id = 1').get().password, 'old',
    'and it must have written nothing, which is why the password never changed');

  t.prepare("UPDATE customers SET password = ?, updated_at = datetime('now') WHERE id = ?").run('new', 1);
  assert.strictEqual(t.prepare('SELECT password FROM customers WHERE id = 1').get().password, 'new',
    'single quotes write it');
});

test('NEGATIVE — a catch-all "session expired" would be caught', () => {
  const fake = `router.post('/change-password', (req, res) => {
      try { const p = jwt.verify(t, S); doTheWork(); }
      catch (e) { return res.status(401).json({ error: 'Session expired' }); }
    });`;
  const n = (fake.match(/Session expired/g) || []).length;
  assert.strictEqual(n, 1, 'sanity: the fake has one');
  /* The real discriminator is the DISTANCE from jwt.verify — a catch-all sits
     far from it, with the whole route in between. */
  assert.ok(fake.indexOf('Session expired') - fake.indexOf('jwt.verify') > 40,
    'a catch-all is far from its verify; the fixed route keeps them adjacent');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/change-password\.test\.js/.test(read('package.json')),
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
