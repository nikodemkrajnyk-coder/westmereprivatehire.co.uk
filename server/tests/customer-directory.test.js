/**
 * THE OWNER'S CUSTOMER DIRECTORY — run with:
 *   node server/tests/customer-directory.test.js   (also gated by `npm test`)
 *
 * WHAT THIS IS FOR
 *   The owner retypes the same phone number and email every time a regular
 *   rings up. Anyone who has ridden MORE THAN TWICE is now saved automatically
 *   and can be picked on a new booking.
 *
 *   Two things make that dangerous rather than merely useful. It is a store of
 *   customer PII, so it must never reach an unauthenticated endpoint. And it is
 *   built by matching people across bookings, so a sloppy key either splits one
 *   person into three rows or — far worse — merges two strangers into one.
 *
 * WHAT IS PINNED
 *   1. The threshold is exactly "more than two": 2 bookings → not listed,
 *      3 → listed. Cancelled trips do not count.
 *   2. Dedup by normalised phone: +44 / 0044 / 44 / leading-0 / spaces are one
 *      person. Dedup by email, case-insensitively.
 *   3. Rebuilding is idempotent — running it twice changes nothing.
 *   4. Two different people never merge, and a customer with no phone AND no
 *      email is skipped rather than pooled with every other anonymous booking.
 *   5. Home address = most frequent pickup, ties to the most recent; once the
 *      owner edits it, the recompute stops overwriting it.
 *   6. The picker fills the REAL booking-form field ids.
 *   7. NO public router exposes the directory or its table.
 *
 * Runs the shipped module and the shipped route handlers against a throwaway
 * database. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const dir = require('../customer-directory');
const apiSrc = read('server/api.js');
const OWNER = read('westmere-owner.html');

function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces');
}
function handler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  return braceBody(apiSrc, apiSrc.indexOf('=>', start));
}
const runList = new Function('req', 'res', 'getDb', 'require', 'console',
  'return (async()=>{' + handler('get', '/customer-directory') + '})();');
const runEdit = new Function('req', 'res', 'getDb', 'require', 'console',
  'return (async()=>{' + handler('patch', '/customer-directory/:id') + '})();');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, full_name TEXT, phone TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, customer_id INTEGER,
      pickup TEXT, destination TEXT, date TEXT, time TEXT, status TEXT DEFAULT 'confirmed',
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_id INTEGER,
      action TEXT, detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  return db;
}
let refN = 0;
function book(db, o) {
  db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, status,
              passenger_name, passenger_phone, passenger_email)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'R' + (++refN), o.customer_id || null, o.pickup || 'Somewhere', o.destination || 'Gatwick',
    o.date || '2026-01-0' + ((refN % 9) + 1), '09:00', o.status || 'confirmed',
    o.name || null, o.phone || null, o.email || null);
}
const names = (db) => dir.list(db).map((r) => r.name).sort();

function mkRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const OWNER_AUTH = { role: 'owner', id: 1, type: 'user' };
const REQ = (m) => require(m.replace(/^\.\//, '../'));

console.log('\nCustomer directory — who gets saved');

// ── 1. THE THRESHOLD ─────────────────────────────────────────────────────
test('two bookings is NOT enough; the third saves them', () => {
  const db = makeDb();
  book(db, { name: 'Twice Only', phone: '07700900111' });
  book(db, { name: 'Twice Only', phone: '07700900111' });
  dir.rebuild(db);
  assert.deepStrictEqual(names(db), [], 'two bookings must not be listed');

  book(db, { name: 'Twice Only', phone: '07700900111' });
  dir.rebuild(db);
  assert.deepStrictEqual(names(db), ['Twice Only'], 'the third booking must save them');
  assert.strictEqual(dir.list(db)[0].booking_count, 3);
});

test('cancelled trips do not count towards the threshold', () => {
  const db = makeDb();
  book(db, { name: 'Flaky', phone: '07700900222' });
  book(db, { name: 'Flaky', phone: '07700900222' });
  book(db, { name: 'Flaky', phone: '07700900222', status: 'cancelled' });
  dir.rebuild(db);
  assert.deepStrictEqual(names(db), [], 'two real + one cancelled is still only two');
});

// ── 2. DEDUP ─────────────────────────────────────────────────────────────
test('every written form of one phone number is ONE customer', () => {
  const db = makeDb();
  for (const p of ['+44 7700 900333', '07700 900333', '07700900333', '00447700900333', '447700900333']) {
    book(db, { name: 'Many Formats', phone: p });
  }
  dir.rebuild(db);
  const rows = dir.list(db);
  assert.strictEqual(rows.length, 1, 'five spellings must be one row, got ' + rows.length);
  assert.strictEqual(rows[0].booking_count, 5, 'and all five bookings must count');
});

test('email matching is case-insensitive when there is no phone', () => {
  const db = makeDb();
  book(db, { name: 'Ben Chan', email: 'Ben@Example.com' });
  book(db, { name: 'Ben Chan', email: 'ben@example.com' });
  book(db, { name: 'Ben Chan', email: '  BEN@EXAMPLE.COM ' });
  dir.rebuild(db);
  const rows = dir.list(db);
  assert.strictEqual(rows.length, 1, 'three cases of one address must be one row');
  assert.strictEqual(rows[0].booking_count, 3);
});

test('a phone-less booking joins the person already known by that email', () => {
  const db = makeDb();
  book(db, { name: 'Mixed', phone: '07700900444', email: 'mixed@example.com' });
  book(db, { name: 'Mixed', phone: '07700900444', email: 'mixed@example.com' });
  book(db, { name: 'Mixed', email: 'mixed@example.com' });   // no phone this time
  dir.rebuild(db);
  const rows = dir.list(db);
  assert.strictEqual(rows.length, 1, 'must not split into two rows');
  assert.strictEqual(rows[0].booking_count, 3);
});

test('two different people NEVER merge', () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'Alice', phone: '07700900555', email: 'alice@example.com' });
  for (let i = 0; i < 3; i++) book(db, { name: 'Bob',   phone: '07700900666', email: 'bob@example.com' });
  dir.rebuild(db);
  assert.deepStrictEqual(names(db), ['Alice', 'Bob']);
});

test('bookings with NO phone and NO email are skipped, not pooled', () => {
  // The dangerous case: three anonymous bookings must not become one "customer"
  // stitched together out of unrelated strangers.
  const db = makeDb();
  book(db, { name: 'Walk-in' }); book(db, { name: 'Another' }); book(db, { name: 'Third' });
  dir.rebuild(db);
  assert.deepStrictEqual(names(db), [], 'anonymous bookings cannot identify anybody');
});

// ── 3. IDEMPOTENCE ───────────────────────────────────────────────────────
test('rebuilding twice changes nothing', () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'Repeat', phone: '07700900777' });
  dir.rebuild(db);
  const first = JSON.stringify(dir.list(db));
  dir.rebuild(db); dir.rebuild(db);
  assert.strictEqual(JSON.stringify(dir.list(db)), first, 'the directory must be stable');
  assert.strictEqual(dir.list(db).length, 1, 'and must not grow a duplicate row');
});

// ── 5. HOME ADDRESS ──────────────────────────────────────────────────────
test('an airport is never somebody\'s home address', () => {
  // The first version of pickHomeAddress filed a regular as living at Gatwick,
  // because their return legs outnumbered their house pickups. A transport hub
  // is where a customer is COLLECTED, not where they live.
  const db = makeDb();
  book(db, { name: 'Flyer', phone: '07700901234', pickup: 'Gatwick Airport, South Terminal', date: '2026-01-01' });
  book(db, { name: 'Flyer', phone: '07700901234', pickup: 'Gatwick Airport, South Terminal', date: '2026-02-01' });
  book(db, { name: 'Flyer', phone: '07700901234', pickup: '9 Hill Road, Lewes',              date: '2026-03-01' });
  dir.rebuild(db);
  assert.strictEqual(dir.list(db)[0].home_address, '9 Hill Road, Lewes',
    'the house must win even though the airport appears twice as often');

  // Nothing but airports → no guess at all, rather than a wrong one.
  const db2 = makeDb();
  for (let i = 0; i < 3; i++) book(db2, { name: 'Airside', phone: '07700905678', pickup: 'Heathrow Terminal 5' });
  dir.rebuild(db2);
  assert.strictEqual(dir.list(db2)[0].home_address, null,
    'with no residential pickup the address must stay empty for the owner to fill');
});

test('home address is the most frequent pickup, ties going to the most recent', () => {
  const db = makeDb();
  book(db, { name: 'Homer', phone: '07700900888', pickup: '12 Elm Road, Lewes', date: '2026-01-01' });
  book(db, { name: 'Homer', phone: '07700900888', pickup: '12 Elm Road, Lewes', date: '2026-02-01' });
  book(db, { name: 'Homer', phone: '07700900888', pickup: 'Gatwick Airport',    date: '2026-03-01' });
  dir.rebuild(db);
  assert.strictEqual(dir.list(db)[0].home_address, '12 Elm Road, Lewes',
    'twice-used home beats a one-off airport pickup');

  // Tie on frequency → the newer address wins, because people move.
  const db2 = makeDb();
  book(db2, { name: 'Mover', phone: '07700900999', pickup: 'Old Street, Hove', date: '2026-01-01' });
  book(db2, { name: 'Mover', phone: '07700900999', pickup: 'New Lane, Lewes',  date: '2026-05-01' });
  book(db2, { name: 'Mover', phone: '07700900999', pickup: 'Gatwick Airport',  date: '2026-06-01' });
  dir.rebuild(db2);
  assert.strictEqual(dir.list(db2)[0].home_address, 'New Lane, Lewes');
});

test("an owner-edited address survives every later rebuild", async () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'Fixer', phone: '07700901000', pickup: 'Wrong Guess, Hove' });
  dir.rebuild(db);
  const id = dir.list(db)[0].id;

  const res = mkRes();
  await runEdit({ params: { id: String(id) }, body: { home_address: '4 Correct Way, Lewes BN7' },
                  auth: OWNER_AUTH, ip: '1.1.1.1' }, res, () => db, REQ, console);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

  book(db, { name: 'Fixer', phone: '07700901000', pickup: 'Wrong Guess, Hove' });
  dir.rebuild(db);
  assert.strictEqual(dir.list(db)[0].home_address, '4 Correct Way, Lewes BN7',
    "the owner's own address must outrank the guess, for ever");
  assert.strictEqual(dir.list(db)[0].booking_count, 4, 'but the count still updates');
});

test('editing to a phone that belongs to somebody else is refused', async () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'One', phone: '07700901111' });
  for (let i = 0; i < 3; i++) book(db, { name: 'Two', phone: '07700902222' });
  dir.rebuild(db);
  const two = dir.list(db).filter((r) => r.name === 'Two')[0];
  const res = mkRes();
  await runEdit({ params: { id: String(two.id) }, body: { phone: '07700 901111' },
                  auth: OWNER_AUTH, ip: '1.1.1.1' }, res, () => db, REQ, console);
  assert.strictEqual(res.statusCode, 409, 'a clash must be refused, not silently merged');
  assert.deepStrictEqual(names(db), ['One', 'Two'], 'both people must survive');
});

test('a junk email or phone is rejected on edit', async () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'Valid', phone: '07700903333' });
  dir.rebuild(db);
  const id = dir.list(db)[0].id;
  for (const body of [{ email: 'not-an-email' }, { phone: '123' }]) {
    const res = mkRes();
    await runEdit({ params: { id: String(id) }, body, auth: OWNER_AUTH, ip: '1' }, res, () => db, REQ, console);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body) + ' must be rejected');
  }
});

// ── SEARCH + AUTH ────────────────────────────────────────────────────────
console.log('\nCustomer directory — the routes');

test('the list route searches by name, phone and email — and needs owner/admin', async () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) book(db, { name: 'Ada Lovelace', phone: '07700904444', email: 'ada@example.com' });
  for (let i = 0; i < 3; i++) book(db, { name: 'Bob Brown',    phone: '07700905555', email: 'bob@example.com' });
  dir.rebuild(db);

  const call = async (q, auth) => {
    const res = mkRes();
    await runList({ query: q ? { q } : {}, auth: auth || OWNER_AUTH }, res, () => db, REQ, console);
    return res;
  };
  assert.strictEqual((await call()).body.customers.length, 2);
  assert.strictEqual((await call('ada')).body.customers[0].name, 'Ada Lovelace');
  assert.strictEqual((await call('+44 7700 905555')).body.customers[0].name, 'Bob Brown',
    'searching an international-format number must find the national-format record');
  assert.strictEqual((await call('BOB@EXAMPLE.COM')).body.customers[0].name, 'Bob Brown');

  for (const role of ['driver', 'customer', undefined]) {
    const res = await call(null, { role, id: 9, type: 'user' });
    assert.strictEqual(res.statusCode, 403, 'role ' + role + ' must be refused');
  }
});

// ── 7. PII IS NOT PUBLIC ─────────────────────────────────────────────────
test('NO public router exposes the directory', () => {
  // server/index.js mounts apiRouter behind requireAuth; the public router is not
  // gated at all, so the directory must never appear there.
  const pub = read('server/public-api.js');
  assert.ok(!/customer-directory'/.test(pub) || !/router\.(get|post|patch|delete)\([^)]*customer-directory/.test(pub),
    'server/public-api.js must not route the customer directory');
  assert.ok(!/FROM customer_directory/i.test(pub),
    'server/public-api.js must not read the customer_directory table');

  const idx = read('server/index.js');
  assert.ok(/app\.use\('\/api', apiLimiter, requireAuth, apiRouter\)/.test(idx),
    'the router carrying the directory must stay behind requireAuth');

  // And the table is not reachable as a file either.
  const { isPrivatePath } = require('../private-paths');
  assert.ok(isPrivatePath('/server/customer-directory.js'), 'the module must not be served');
});

test('both directory routes check the role before touching the database', () => {
  for (const route of ["router.get('/customer-directory'", "router.patch('/customer-directory/:id'"]) {
    const start = apiSrc.indexOf(route);
    assert.ok(start !== -1, route + ' is missing');
    const body = braceBody(apiSrc, apiSrc.indexOf('=>', start));
    const gate = body.indexOf("['admin', 'owner'].includes(req.auth.role)");
    const db = body.indexOf('getDb()');
    assert.ok(gate !== -1, route + ' has no role gate');
    assert.ok(db === -1 || gate < db, route + ' touches the database before checking the role');
  }
});

test('the directory route does not collide with the existing /customers CRUD', () => {
  // /api/customers is already the ACCOUNTS table admin CRUD. A second
  // router.get on that path would simply never fire.
  assert.strictEqual((apiSrc.match(/router\.get\('\/customers'/g) || []).length, 1,
    'exactly one GET /customers must exist (the accounts one)');
  assert.ok(/router\.get\('\/customer-directory'/.test(apiSrc),
    'the directory must live on its own path');
});

// ── 6. THE OWNER APP ─────────────────────────────────────────────────────
console.log('\nCustomer directory — the owner app');

test('there is a Customers tab wired to the pane', () => {
  assert.ok(/id="bn-customers"[^>]*onclick="goPage\('customers',this\)"/.test(OWNER), 'nav button');
  assert.ok(/id="pg-customers"/.test(OWNER), 'the pane');
  assert.ok(/if\(id==='customers'\)custLoad\(\);/.test(OWNER), 'goPage must load it');
  assert.ok(/id="cust-search"/.test(OWNER), 'and it must be searchable');
});

test('the picker fills the REAL booking-form fields', () => {
  // The whole point is that name/phone/email/pickup stop being retyped, so the
  // ids it writes to must be the ids the form actually submits.
  const fn = OWNER.slice(OWNER.indexOf('function nbCustPick('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const id of ['nb-name', 'nb-phone', 'nb-email', 'nb-pickup']) {
    assert.ok(new RegExp("set\\('" + id + "'").test(body), 'the picker must fill #' + id);
  }
  // Those ids must exist as inputs on the new-booking form.
  for (const id of ['nb-name', 'nb-phone', 'nb-email', 'nb-pickup', 'nb-cust']) {
    assert.ok(new RegExp('<input id="' + id + '"').test(OWNER), '#' + id + ' must be a real input');
  }
});

test('the picker is optional — a brand-new customer can still be typed', () => {
  assert.ok(/id="nb-cust"[^>]*type="search"/.test(OWNER), 'the picker is a separate search box');
  // It must NOT be marked required, and must not gate the submit.
  const submit = OWNER.slice(OWNER.indexOf('function ownerNewBookingSubmit'));
  const body = submit.slice(0, submit.indexOf('\n}'));
  assert.ok(!/nb-cust/.test(body), 'submit must not depend on the picker at all');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/customer-directory\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
