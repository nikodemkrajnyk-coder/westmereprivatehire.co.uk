/**
 * THE OWNER'S CUSTOMER LIST — run with:
 *   node server/tests/customer-directory.test.js   (also gated by `npm test`)
 *
 * WHAT THIS IS FOR
 *   The owner retypes the same phone number and email every time a regular
 *   rings up. He can now tap "Add to list" on a booking and pick that person on
 *   the next one.
 *
 * MANUAL, NOT AUTOMATIC — AND THAT IS THE FIRST THING PINNED
 *   This list used to add anyone with more than two bookings, on a rebuild.
 *   The owner asked for that gone: he would rather choose. So the very first
 *   assertion below is that a customer with plenty of bookings does NOT appear
 *   unless somebody added them — that rule coming back by accident is the
 *   regression this file exists to catch.
 *
 *   Because nothing repopulates the list, removal is a plain DELETE and needs no
 *   suppression flag.
 *
 * THE OTHER RISKS
 *   It is a store of customer PII, so it must never reach an unauthenticated
 *   endpoint. And it matches people across bookings, so a sloppy key either
 *   splits one person into three rows or — worse — merges two strangers.
 *
 * WHAT IS PINNED
 *   1. NO auto-add: bookings alone never put anybody on the list.
 *   2. Add works from a booking, is idempotent on the normalised identity, and
 *      copies name / phone / email / pickup-as-home.
 *   3. Remove deletes from the list only; bookings are untouched by both.
 *   4. Dedup by normalised phone (+44 / 0044 / 44 / leading-0 / spaces) and by
 *      email, case-insensitively. Two people never merge.
 *   5. An owner-edited address is never overwritten by a later Add.
 *   6. Trip counts are computed live from bookings, so they cannot go stale.
 *   7. Add and remove are owner/admin only; no public router exposes any of it.
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
const runAdd = new Function('req', 'res', 'getDb', 'require', 'console',
  'return (async()=>{' + handler('post', '/bookings/:id/add-customer') + '})();');
const runDelete = new Function('req', 'res', 'getDb', 'require', 'console',
  'return (async()=>{' + handler('delete', '/customer-directory/:id') + '})();');

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
  o = o || {};
  const info = db.prepare(`INSERT INTO bookings (ref, customer_id, pickup, destination, date, time, status,
              passenger_name, passenger_phone, passenger_email)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'R' + (++refN), o.customer_id || null, o.pickup || 'Somewhere', o.destination || 'Gatwick',
    o.date || '2026-01-0' + ((refN % 9) + 1), '09:00', o.status || 'confirmed',
    o.name || null, o.phone || null, o.email || null);
  return info.lastInsertRowid;
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
const call = async (fn, db, id, auth) => {
  const res = mkRes();
  await fn({ params: { id: String(id) }, body: {}, query: {}, auth: auth || OWNER_AUTH, ip: '1.1.1.1' },
    res, () => db, REQ, console);
  return res;
};

console.log('\nCustomer list — manual only');

// ── 1. THE RULE THAT WAS REMOVED ─────────────────────────────────────────
test('bookings alone NEVER put anybody on the list', () => {
  const db = makeDb();
  for (let i = 0; i < 12; i++) book(db, { name: 'Very Frequent', phone: '07700900111' });
  assert.deepStrictEqual(names(db), [],
    'twelve bookings must not add anybody — the auto rule is gone and must stay gone');
});

test('nothing in the codebase still auto-populates the list', () => {
  // The old rule lived in a rebuild() called from three places. All three go, or
  // the list quietly refills behind the owner's back.
  const mod = read('server/customer-directory.js');
  assert.ok(!/MIN_BOOKINGS/.test(mod), 'the booking threshold must be gone');
  assert.ok(!/function rebuild\(/.test(mod), 'rebuild() must be gone');
  assert.ok(!/syncAfterBooking/.test(mod), 'syncAfterBooking() must be gone');
  for (const f of ['server/api.js', 'server/public-api.js', 'server/index.js']) {
    assert.ok(!/syncAfterBooking|customer-directory'\)\.rebuild/.test(read(f)),
      f + ' still calls into the old automatic population');
  }
  // And no UI copy promising it.
  assert.ok(!/more than \d+ bookings each|on their \d+rd booking|appear automatically/i.test(OWNER),
    'the owner app must not still say customers are recorded automatically');
});

// ── 2. ADDING ────────────────────────────────────────────────────────────
test('Add puts the booking\'s customer on the list with their details', async () => {
  const db = makeDb();
  const id = book(db, { name: 'Mr Ben Chan', phone: '07700 900123', email: 'Ben@Example.com',
                        pickup: '14 Greenhill Avenue, Caterham, CR3 6PQ' });
  const res = await call(runAdd, db, id);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.already, false);
  const c = dir.list(db)[0];
  assert.strictEqual(c.name, 'Mr Ben Chan');
  assert.strictEqual(c.phone, '07700 900123');
  assert.strictEqual(c.email, 'Ben@Example.com');
  assert.strictEqual(c.home_address, '14 Greenhill Avenue, Caterham, CR3 6PQ',
    'the pickup on that booking becomes their home address');
  assert.strictEqual(c.added_by, 'manual');
});

test('Add is idempotent — a second tap does not create a twin', async () => {
  const db = makeDb();
  const a = book(db, { name: 'Twice', phone: '07700900222', email: 'twice@example.com' });
  const b = book(db, { name: 'Twice', phone: '+44 7700 900222', email: 'TWICE@example.com' });
  await call(runAdd, db, a);
  const second = await call(runAdd, db, b);
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.already, true, 'the second Add must report "already"');
  assert.strictEqual(dir.list(db).length, 1, 'and must not add a second row');
});

test('every written form of one number is the same person', async () => {
  const db = makeDb();
  for (const p of ['+44 7700 900333', '07700 900333', '07700900333', '00447700900333', '447700900333']) {
    await call(runAdd, db, book(db, { name: 'Many Formats', phone: p }));
  }
  assert.strictEqual(dir.list(db).length, 1, 'five spellings must be one row');
});

test('email matches case-insensitively when there is no phone', async () => {
  const db = makeDb();
  await call(runAdd, db, book(db, { name: 'Ben', email: 'Ben@Example.com' }));
  await call(runAdd, db, book(db, { name: 'Ben', email: '  ben@example.com ' }));
  assert.strictEqual(dir.list(db).length, 1);
});

test('two different people never merge', async () => {
  const db = makeDb();
  await call(runAdd, db, book(db, { name: 'Alice', phone: '07700900555', email: 'alice@example.com' }));
  await call(runAdd, db, book(db, { name: 'Bob', phone: '07700900666', email: 'bob@example.com' }));
  assert.deepStrictEqual(names(db), ['Alice', 'Bob']);
});

test('a booking with no phone AND no email cannot be added', async () => {
  // There would be nothing to match them by later — not even a second Add.
  const db = makeDb();
  const res = await call(runAdd, db, book(db, { name: 'Anonymous Walk-in' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.reason, 'no_contact');
  assert.deepStrictEqual(names(db), []);
});

test('an owner-edited address survives a later Add', async () => {
  const db = makeDb();
  const first = book(db, { name: 'Mover', phone: '07700900777', pickup: 'Old Street, Hove' });
  await call(runAdd, db, first);
  const id = dir.list(db)[0].id;
  const edit = mkRes();
  await runEdit({ params: { id: String(id) }, body: { home_address: '4 Correct Way, Lewes BN7' },
                  auth: OWNER_AUTH, ip: '1' }, edit, () => db, REQ, console);
  assert.strictEqual(edit.statusCode, 200, JSON.stringify(edit.body));
  await call(runAdd, db, book(db, { name: 'Mover', phone: '07700900777', pickup: 'Gatwick Airport' }));
  assert.strictEqual(dir.list(db)[0].home_address, '4 Correct Way, Lewes BN7',
    'a later Add must not overwrite the address the owner typed');
});

// ── 3. REMOVING ──────────────────────────────────────────────────────────
test('Remove takes them off the list and nothing puts them back', async () => {
  const db = makeDb();
  const id = book(db, { name: 'Gone', phone: '07700900888' });
  await call(runAdd, db, id);
  const res = await call(runDelete, db, dir.list(db)[0].id);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(names(db), []);
  // More bookings must not resurrect them — there is no rule left to do it.
  for (let i = 0; i < 5; i++) book(db, { name: 'Gone', phone: '07700900888' });
  assert.deepStrictEqual(names(db), [], 'nothing repopulates the list');
});

test('neither Add nor Remove touches booking history', async () => {
  const db = makeDb();
  const id = book(db, { name: 'Untouched', phone: '07700900999' });
  book(db, { name: 'Untouched', phone: '07700900999' });
  const before = db.prepare('SELECT id, ref, status, pickup, date, passenger_name FROM bookings ORDER BY id').all();
  await call(runAdd, db, id);
  assert.deepStrictEqual(db.prepare('SELECT id, ref, status, pickup, date, passenger_name FROM bookings ORDER BY id').all(),
    before, 'Add must not change a booking');
  await call(runDelete, db, dir.list(db)[0].id);
  assert.deepStrictEqual(db.prepare('SELECT id, ref, status, pickup, date, passenger_name FROM bookings ORDER BY id').all(),
    before, 'Remove must not change a booking');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0,
    'and neither may touch the accounts table');
});

// ── 4. TRIP COUNTS ARE LIVE ──────────────────────────────────────────────
test('trip counts are computed from bookings, so they cannot go stale', async () => {
  const db = makeDb();
  const id = book(db, { name: 'Counter', phone: '07700901000', date: '2026-01-01' });
  await call(runAdd, db, id);
  assert.strictEqual(dir.list(db)[0].booking_count, 1);
  book(db, { name: 'Counter', phone: '07700901000', date: '2026-05-05' });
  book(db, { name: 'Counter', phone: '07700901000', date: '2026-06-06', status: 'cancelled' });
  const c = dir.list(db)[0];
  assert.strictEqual(c.booking_count, 2, 'the new booking counts, the cancelled one does not');
  assert.strictEqual(c.last_booking, '2026-05-05');
});

// ── 5. THE EXISTING AUTO-ADDED ROWS ──────────────────────────────────────
test('rows left by the old rule are marked auto and can be cleared on their own', () => {
  const db = makeDb();
  dir.ensureSchema(db);
  // Simulate what the live table looks like after the previous deploy.
  db.prepare("INSERT INTO customer_directory (phone_key, name, phone, added_by) VALUES ('7700901111','Auto One','07700901111','auto')").run();
  db.prepare("INSERT INTO customer_directory (phone_key, name, phone, added_by) VALUES ('7700902222','Auto Two','07700902222','auto')").run();
  db.prepare("INSERT INTO customer_directory (phone_key, name, phone, added_by) VALUES ('7700903333','Chosen','07700903333','manual')").run();
  assert.strictEqual(dir.list(db).length, 3, 'by default the existing rows are KEPT');
  const cleared = dir.clearAutoAdded(db);
  assert.strictEqual(cleared, 2, 'exactly the auto rows go');
  assert.deepStrictEqual(names(db), ['Chosen'], "the owner's own choices are never touched");
});

// ── 6. AUTH ──────────────────────────────────────────────────────────────
console.log('\nCustomer list — the routes');

test('Add and Remove are owner/admin only', async () => {
  const db = makeDb();
  const bId = book(db, { name: 'Protected', phone: '07700904444' });
  await call(runAdd, db, bId);
  const cId = dir.list(db)[0].id;
  for (const role of ['driver', 'customer', undefined]) {
    const a = await call(runAdd, db, bId, { role, id: 9, type: 'user' });
    assert.strictEqual(a.statusCode, 403, 'Add: role ' + role + ' must be refused');
    const d = await call(runDelete, db, cId, { role, id: 9, type: 'user' });
    assert.strictEqual(d.statusCode, 403, 'Remove: role ' + role + ' must be refused');
  }
  assert.deepStrictEqual(names(db), ['Protected'], 'and nothing may have changed');
});

test('the list route searches by name, phone and email, and needs owner/admin', async () => {
  const db = makeDb();
  await call(runAdd, db, book(db, { name: 'Ada Lovelace', phone: '07700905555', email: 'ada@example.com' }));
  await call(runAdd, db, book(db, { name: 'Bob Brown', phone: '07700906666', email: 'bob@example.com' }));
  const q = async (term, auth) => {
    const res = mkRes();
    await runList({ query: term ? { q: term } : {}, auth: auth || OWNER_AUTH }, res, () => db, REQ, console);
    return res;
  };
  assert.strictEqual((await q()).body.customers.length, 2);
  assert.strictEqual((await q('ada')).body.customers[0].name, 'Ada Lovelace');
  assert.strictEqual((await q('+44 7700 906666')).body.customers[0].name, 'Bob Brown',
    'an international-format search must find the national-format record');
  assert.strictEqual((await q('BOB@EXAMPLE.COM')).body.customers[0].name, 'Bob Brown');
  for (const role of ['driver', 'customer', undefined]) {
    assert.strictEqual((await q(null, { role, id: 9, type: 'user' })).statusCode, 403);
  }
});

test('every directory route checks the role before touching the database', () => {
  const routes = ["router.get('/customer-directory'", "router.patch('/customer-directory/:id'",
                  "router.delete('/customer-directory/:id'", "router.post('/bookings/:id/add-customer'"];
  for (const route of routes) {
    const start = apiSrc.indexOf(route);
    assert.ok(start !== -1, route + ' is missing');
    const body = braceBody(apiSrc, apiSrc.indexOf('=>', start));
    const gate = body.indexOf("['admin', 'owner'].includes(req.auth.role)");
    const db = body.indexOf('getDb()');
    assert.ok(gate !== -1, route + ' has no role gate');
    assert.ok(db === -1 || gate < db, route + ' touches the database before checking the role');
  }
});

test('NO public router exposes the list or its table', () => {
  const pub = read('server/public-api.js');
  assert.ok(!/router\.(get|post|patch|delete|put)\([^)]{0,60}(customer-directory|add-customer)/.test(pub),
    'server/public-api.js must not route any of this');
  assert.ok(!/FROM\s+customer_directory/i.test(pub),
    'server/public-api.js must not read the customer_directory table');
  const idx = read('server/index.js');
  assert.ok(/app\.use\('\/api', apiLimiter, requireAuth, apiRouter\)/.test(idx),
    'the router carrying it must stay behind requireAuth');
  const { isPrivatePath } = require('../private-paths');
  assert.ok(isPrivatePath('/server/customer-directory.js'), 'the module must not be served');
});

// ── 7. THE OWNER APP ─────────────────────────────────────────────────────
console.log('\nCustomer list — the owner app');

test('every job card offers Add, and shows a settled state once added', () => {
  assert.ok(/onclick="ownerAddCustomer\('\+j\.id\+',this\)"/.test(OWNER), 'the Add button must be on the job card');
  assert.ok(/On your list/.test(OWNER), 'and must become a settled "On your list" state');
  assert.ok(/function custOnList\(phone,email\)/.test(OWNER), 'decided by the same normalised identity the server uses');
  assert.ok(/\/add-customer'/.test(OWNER), 'and must call the add route');
});

test('the customer list is loaded before the job cards render', () => {
  // Otherwise every card offers "Add to list", including for saved customers.
  assert.ok(/await custLoad\(\{quiet:true\}\)/.test(OWNER),
    'loadOwnerBookings must warm the list first');
});

test('Remove is behind a confirm and says the history is safe', () => {
  assert.ok(/function custRemove\(id\)\{[\s\S]{0,400}?confirm\(/.test(OWNER), 'removing must ask first');
  assert.ok(/method:'DELETE'/.test(OWNER), 'and must call the DELETE route');
  assert.ok(/bookings, invoices and earnings are NOT deleted/i.test(OWNER),
    'the confirm must state that booking history is untouched');
});

test('the picker draws from the manual list', () => {
  const fn = OWNER.slice(OWNER.indexOf('function nbCustSearch('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/CUSTOMERS\.filter/.test(body), 'the picker must read the saved list');
  const pick = OWNER.slice(OWNER.indexOf('function nbCustPick('));
  const pbody = pick.slice(0, pick.indexOf('\n}'));
  for (const id of ['nb-name', 'nb-phone', 'nb-email', 'nb-pickup']) {
    assert.ok(new RegExp("set\\('" + id + "'").test(pbody), 'the picker must fill #' + id);
  }
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
