/**
 * WHO MAY BE INVOICED —
 *   node server/tests/invoice-customer-picker.test.js   (also gated by `npm test`)
 *
 * The New Invoice screen listed the OWNER as a selectable customer, between the
 * real ones. The cause was not a leak from the drivers table and not a join
 * gone wrong: he has a genuine row in `customers`, registered through the rider
 * app under his own email — password hash and all — because that is how he
 * tested it. A driver who books a ride for himself ends up in exactly the same
 * place.
 *
 * THE RULE IS ROLE AND FLAG, NEVER A NAME. "and not Nikodem Krajnyk" fails the
 * day a real customer shares a name with a driver, and fails silently the day
 * the owner's name changes. Email is the only key `customers` and `users`
 * share, so it is matched case- and whitespace-insensitively: one was typed
 * into a signup form, the other into a staff record.
 *
 * A FLAG, NOT A DELETION AND NOT A FILTER ON THE ENDPOINT. The row is still
 * returned by /api/customers, so the Customers tab, the directory, spend and
 * customer detail are all unchanged. Only the invoice picker drops them.
 *
 * Runs the REAL query against throwaway databases. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const API = read('server/api.js');
const OWNER = read('westmere-owner.html');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

/** The SELECT the shipped route runs — lifted out, never re-typed. */
function customersQuery() {
  const start = API.indexOf("router.get('/customers'");
  assert.ok(start !== -1, "server/api.js no longer defines GET /customers");
  const a = API.indexOf('db.prepare(`', start);
  const b = API.indexOf('`).all()', a);
  assert.ok(a !== -1 && b !== -1, 'could not extract the customers query');
  return API.slice(a + 'db.prepare(`'.length, b);
}
const SQL = customersQuery();

const Database = require('better-sqlite3');
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, full_name TEXT, phone TEXT,
      account_type TEXT, active INTEGER DEFAULT 1, verified INTEGER DEFAULT 1,
      created_at TEXT, address_line1 TEXT, address_line2 TEXT, postcode TEXT,
      bank_name TEXT, bank_sort_code TEXT, bank_account_no TEXT, bank_account_name TEXT
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, email TEXT, full_name TEXT,
      role TEXT, active INTEGER DEFAULT 1, is_default_driver INTEGER DEFAULT 0
    );
  `);
  const c = db.prepare("INSERT INTO customers (email,full_name,account_type,created_at) VALUES (?,?,?,?)");
  const u = db.prepare("INSERT INTO users (username,email,full_name,role,active,is_default_driver) VALUES (?,?,?,?,?,?)");
  // The real shape: staff who also hold customer accounts, and genuine clients.
  u.run('nikodem', 'nikodem.krajnyk@gmail.com', 'Nikodem Krajnyk', 'owner', 1, 1);
  u.run('westmere', 'admin@westmereprivatehire.co.uk', 'Westmere Admin', 'admin', 1, 0);
  u.run('dave',    'dave.driver@example.com',       'Dave Driver',    'driver', 1, 0);
  u.run('gone',    'former.driver@example.com',     'Former Driver',  'driver', 0, 0);

  c.run('nikodem.krajnyk@gmail.com',      'Nikodem Krajnyk',  'personal', '2026-06-01');
  c.run('Nikodem.Krajnyk@Gmail.com  ',    'N Krajnyk (dup)',  'personal', '2026-06-02');
  c.run('admin@westmereprivatehire.co.uk','Westmere Admin',   'personal', '2026-06-03');
  c.run('dave.driver@example.com',        'Dave Driver',      'personal', '2026-06-04');
  c.run('lap.shing.chan@example.com',     'Lap Shing Chan',   'personal', '2026-06-05');
  c.run('accounts@grandbrighton.co.uk',   'The Grand Hotel Brighton', 'business', '2026-06-06');
  c.run('former.driver@example.com',      'Former Driver',    'personal', '2026-06-07');
  return db;
}

const run = (db) => db.prepare(SQL).all();
const byName = (rows, n) => rows.find(r => r.full_name === n);

console.log('\nThe owner is not an invoice customer');

test('the OWNER\'s own customer account is marked staff', () => {
  const rows = run(makeDb());
  const me = byName(rows, 'Nikodem Krajnyk');
  assert.ok(me, 'the row must still be RETURNED — nothing is deleted or hidden from the directory');
  assert.strictEqual(me.is_staff, 1, 'and marked as staff so the invoice picker drops it');
});

test('the match survives different casing and stray whitespace', () => {
  /* One address was typed into a signup form and the other into a staff
     record; an exact-string join would have missed this row. */
  const dup = byName(run(makeDb()), 'N Krajnyk (dup)');
  assert.strictEqual(dup.is_staff, 1, '"Nikodem.Krajnyk@Gmail.com  " must match "nikodem.krajnyk@gmail.com"');
});

test('admin and drivers are staff too', () => {
  const rows = run(makeDb());
  assert.strictEqual(byName(rows, 'Westmere Admin').is_staff, 1, 'admin');
  assert.strictEqual(byName(rows, 'Dave Driver').is_staff, 1, 'a driver who books his own ride');
});

console.log('\nGenuine customers are untouched');

test('real customers are NOT marked staff', () => {
  const rows = run(makeDb());
  assert.strictEqual(byName(rows, 'Lap Shing Chan').is_staff, 0, 'a real client must still be invoiceable');
  assert.strictEqual(byName(rows, 'The Grand Hotel Brighton').is_staff, 0, 'and so must an account customer');
});

test('a DEACTIVATED staff account no longer taints its customer row', () => {
  /* Someone who has left is a customer like any other. */
  const gone = byName(run(makeDb()), 'Former Driver');
  assert.strictEqual(gone.is_staff, 0, 'u.active = 1 must be part of the match');
});

test('a customer with no email is never matched by accident', () => {
  const db = makeDb();
  db.prepare("INSERT INTO customers (email,full_name,created_at) VALUES (NULL,'No Email Given','2026-06-08')").run();
  db.prepare("INSERT INTO customers (email,full_name,created_at) VALUES ('','Blank Email','2026-06-09')").run();
  db.prepare("INSERT INTO users (username,email,role,active) VALUES ('ghost',NULL,'driver',1)").run();
  db.prepare("INSERT INTO users (username,email,role,active) VALUES ('ghost2','','driver',1)").run();
  const rows = run(db);
  assert.strictEqual(byName(rows, 'No Email Given').is_staff, 0, 'NULL must not match NULL');
  assert.strictEqual(byName(rows, 'Blank Email').is_staff, 0, "and '' must not match ''");
});

console.log('\nBy role and flag, not by name');

test('nothing anywhere matches the owner by name', () => {
  const q = SQL.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Nikodem|Krajnyk/i.test(q),
    'the query must not name a person — that breaks the day a customer shares the name, ' +
    'and breaks silently the day the owner changes his');
  const app = OWNER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const near = app.match(/invoiceable[\s\S]{0,200}/g) || [];
  for (const n of near) {
    assert.ok(!/Nikodem|Krajnyk/i.test(n), 'the picker must not filter by name either');
  }
});

test('the rule is role OR the default-driver flag', () => {
  assert.ok(/u\.role IN \('owner','admin','driver'\)/.test(SQL), 'staff roles');
  assert.ok(/u\.is_default_driver = 1/.test(SQL),
    'and the default-driver flag, which is set on a row whose role could be anything');
  assert.ok(/u\.active = 1/.test(SQL), 'only CURRENT staff');
  assert.ok(/LOWER\(TRIM\(u\.email\)\) = LOWER\(TRIM\(c\.email\)\)/.test(SQL), 'matched forgivingly');
});

console.log('\nThe picker acts on it, and nothing else changes');

test('the invoice dropdown drops staff rows', () => {
  assert.ok(/var invoiceable=d\.customers\.filter\(function\(c\)\{return !c\.is_staff;\}\);/.test(OWNER),
    'the New Invoice picker must filter on the flag');
  assert.ok(/invoiceable\.forEach\(function\(c\)\{/.test(OWNER),
    'and build its options from the filtered list, not the raw one');
});

test('the endpoint still RETURNS every customer', () => {
  const rows = run(makeDb());
  assert.strictEqual(rows.length, 7,
    'no row may be filtered out server-side — the Customers tab, the directory and customer ' +
    'detail all read this endpoint, and the owner asked for a dropdown fix, not a purge');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-customer-picker\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
