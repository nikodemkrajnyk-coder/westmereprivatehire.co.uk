/**
 * Customer-spend reporting guardrail — run with:
 *   node server/tests/customer-spend.test.js   (also gated by `npm test`)
 *
 * The owner wants to see who actually spends money with him, so he can give
 * price relief to his best customers. Two things have to be right or the answer
 * is worse than useless:
 *
 *   THE MATHS. "Spent" means money that changed hands — a paid or completed
 *   trip — not a quote. Counting an unpaid estimate, or a cancelled job, would
 *   inflate a customer up the leaderboard and earn them a discount they have
 *   not paid for. Deduping is by email, so the same person booking twice with
 *   a different spelling of their name is one customer.
 *
 *   THE EXPOSURE. It is a list of every customer's name, email and spend. It
 *   must never be reachable without staff auth, and never from a public path.
 *
 * Runs the SHIPPED handler against a throwaway database.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const apiSrc = read('server/api.js');

function extractHandler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  const arrow = apiSrc.indexOf('=>', start);
  let i = apiSrc.indexOf('{', arrow), depth = 0;
  for (let j = i; j < apiSrc.length; j++) {
    if (apiSrc[j] === '{') depth++;
    else if (apiSrc[j] === '}') { depth--; if (depth === 0) return apiSrc.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces extracting ' + route);
}
const spendHandler = extractHandler('get', '/customer-spend');

function makeDb(bookings) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT);
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY, customer_id INTEGER, fare REAL, status TEXT,
      payment TEXT, paid_at TEXT, date TEXT, passenger_email TEXT, passenger_name TEXT
    );`);
  db.prepare("INSERT INTO customers (id,email,full_name) VALUES (1,'ELEANOR@example.com','Eleanor Voss')").run();
  const ins = db.prepare(`INSERT INTO bookings
    (id,customer_id,fare,status,payment,paid_at,date,passenger_email,passenger_name)
    VALUES (@id,@customer_id,@fare,@status,@payment,@paid_at,@date,@passenger_email,@passenger_name)`);
  bookings.forEach((b, i) => ins.run(Object.assign({
    id: i + 1, customer_id: null, fare: null, status: 'confirmed', payment: 'pending',
    paid_at: null, date: '2026-01-01', passenger_email: null, passenger_name: null
  }, b)));
  return db;
}

function run(db, role) {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
  const sandbox = {
    getDb: () => db, res,
    req: { auth: { role: role, id: 1, type: role === 'customer' ? 'customer' : 'staff' }, params: {}, body: {}, ip: '::1' },
    Number, String, Math, isFinite, Map, Array, Object, JSON, console: { log() {}, error() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext('(function(req,res){' + spendHandler + '})(req,res)', sandbox);
  return res;
}
const spendOf = (body, email) => body.customers.find(c => c.email === email);

console.log('\nCustomer spend — the maths');

test('spend counts PAID and COMPLETED trips, and nothing else', () => {
  const db = makeDb([
    { fare: 100, status: 'confirmed', paid_at: '2026-01-02T10:00:00Z', passenger_email: 'a@x.com', passenger_name: 'A' }, // paid by card
    { fare: 50,  status: 'completed', paid_at: null,                   passenger_email: 'a@x.com', passenger_name: 'A' }, // cash, done
    { fare: 40,  status: 'confirmed', paid_at: null,                   passenger_email: 'a@x.com', passenger_name: 'A' }, // quoted only
    { fare: 999, status: 'cancelled', paid_at: '2026-01-02T10:00:00Z', passenger_email: 'a@x.com', passenger_name: 'A' }  // cancelled
  ]);
  const b = run(db, 'admin').body;
  const a = spendOf(b, 'a@x.com');
  assert.strictEqual(a.totalSpent, 150, 'only the paid + completed trips count (100 + 50)');
  assert.strictEqual(a.trips, 2, 'trip count must match the money counted');
  assert.strictEqual(a.quotedUnpaid, 40, 'the unpaid estimate is reported separately');
  assert.strictEqual(a.unpaidTrips, 1);
});

test('a CANCELLED trip is never revenue, even when it was paid', () => {
  const db = makeDb([
    { fare: 500, status: 'cancelled', paid_at: '2026-01-02T10:00:00Z', passenger_email: 'c@x.com', passenger_name: 'C' }
  ]);
  const b = run(db, 'admin').body;
  assert.strictEqual(b.customers.length, 0, 'a cancelled trip must not create a spender');
  assert.strictEqual(b.totals.revenue, 0);
});

test('customers are deduped by email, whatever case or name was used', () => {
  const db = makeDb([
    { fare: 60, status: 'completed', passenger_email: 'Sam@Example.com', passenger_name: 'Sam Reed' },
    { fare: 40, status: 'completed', passenger_email: 'sam@example.com', passenger_name: 'S. Reed' },
    { fare: 30, status: 'completed', passenger_email: '  SAM@EXAMPLE.COM ', passenger_name: 'Samuel Reed' }
  ]);
  const b = run(db, 'admin').body;
  assert.strictEqual(b.customers.length, 1, 'three spellings of one email must be ONE customer');
  assert.strictEqual(b.customers[0].totalSpent, 130);
  assert.strictEqual(b.customers[0].trips, 3);
});

test('the registered account email wins over the one typed on the booking', () => {
  const db = makeDb([
    { fare: 80, status: 'completed', customer_id: 1, passenger_email: 'typo@example.com', passenger_name: 'Eleanor' },
    { fare: 20, status: 'completed', passenger_email: 'eleanor@example.com', passenger_name: 'Eleanor Voss' }
  ]);
  const b = run(db, 'admin').body;
  assert.strictEqual(b.customers.length, 1, 'the account holder and their booking must aggregate');
  assert.strictEqual(b.customers[0].totalSpent, 100);
});

test('a booking with no email at all still aggregates, by name', () => {
  // Manual / phone bookings have no email; dropping them would under-report.
  const db = makeDb([
    { fare: 70, status: 'completed', passenger_name: 'Walk In' },
    { fare: 30, status: 'completed', passenger_name: 'walk in' }
  ]);
  const b = run(db, 'admin').body;
  assert.strictEqual(b.customers.length, 1, 'the same name must group when there is no email');
  assert.strictEqual(b.customers[0].totalSpent, 100);
});

test('the leaderboard is sorted by spend, highest first', () => {
  const db = makeDb([
    { fare: 50,  status: 'completed', passenger_email: 'low@x.com',  passenger_name: 'Low' },
    { fare: 500, status: 'completed', passenger_email: 'high@x.com', passenger_name: 'High' },
    { fare: 150, status: 'completed', passenger_email: 'mid@x.com',  passenger_name: 'Mid' }
  ]);
  const b = run(db, 'admin').body;
  // join() rather than deepStrictEqual: the handler runs in a vm sandbox, so its
  // Array has a different prototype and a structural compare fails on identity.
  assert.strictEqual(b.customers.map(c => c.email).join(','), 'high@x.com,mid@x.com,low@x.com');
});

test('average per trip and last trip date are right', () => {
  const db = makeDb([
    { fare: 100, status: 'completed', date: '2026-03-01', passenger_email: 'z@x.com', passenger_name: 'Z' },
    { fare: 50,  status: 'completed', date: '2026-05-09', passenger_email: 'z@x.com', passenger_name: 'Z' },
    { fare: 30,  status: 'completed', date: '2026-04-02', passenger_email: 'z@x.com', passenger_name: 'Z' }
  ]);
  const z = spendOf(run(db, 'admin').body, 'z@x.com');
  assert.strictEqual(z.totalSpent, 180);
  assert.strictEqual(z.avgPerTrip, 60);
  assert.strictEqual(z.lastTrip, '2026-05-09', 'the latest DATE, not the latest row');
});

test('a booking with no fare never invents revenue', () => {
  const db = makeDb([
    { fare: null, status: 'completed', passenger_email: 'n@x.com', passenger_name: 'N' },
    { fare: 0,    status: 'completed', passenger_email: 'n@x.com', passenger_name: 'N' }
  ]);
  assert.strictEqual(run(db, 'admin').body.customers.length, 0);
});

test('the totals match the rows', () => {
  const db = makeDb([
    { fare: 100, status: 'completed', passenger_email: 'a@x.com', passenger_name: 'A' },
    { fare: 25,  status: 'confirmed', passenger_email: 'b@x.com', passenger_name: 'B' }
  ]);
  const b = run(db, 'admin').body;
  assert.strictEqual(b.totals.revenue, 100, 'revenue is the paid money only');
  assert.strictEqual(b.totals.outstanding, 25, 'outstanding is the quoted-but-unpaid money');
  assert.strictEqual(b.totals.customers, 2);
});

// ── Exposure ─────────────────────────────────────────────────────────────
console.log('\nIt is staff-only, and not on a public path');

test('a customer token is refused', () => {
  const r = run(makeDb([]), 'customer');
  assert.strictEqual(r.statusCode, 403, 'a customer must not read everyone else\'s spend');
});

test('admin and owner may read it', () => {
  for (const role of ['admin', 'owner']) {
    assert.strictEqual(run(makeDb([]), role).statusCode, 200, role + ' should be allowed');
  }
});

test('it lives on the AUTHENTICATED router, never the public one', () => {
  assert.ok(!/customer-spend/.test(read('server/public-api.js')),
    'the spend report must never appear on /api/public — it is a list of names, emails and money');
  assert.ok(/router\.get\('\/customer-spend'/.test(apiSrc),
    'the route must be defined on the authenticated api router');
  // /api is mounted behind requireAuth, so no token is a 401 before the handler runs.
  const index = read('server/index.js');
  assert.ok(/app\.use\('\/api', apiLimiter, requireAuth, apiRouter\)/.test(index),
    'the api router must stay behind requireAuth, or the report would be reachable unauthenticated');
});

test('the report is read-only — it cannot write to the database', () => {
  for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'db.prepare(`UPDATE']) {
    assert.ok(!spendHandler.includes(forbidden),
      'the spend report performs a ' + forbidden + ' — it must only read');
  }
});

// ── The admin UI ─────────────────────────────────────────────────────────
console.log('\nThe admin section is wired up');

test('the admin app has a Customer Spend section behind the normal nav', () => {
  const ADMIN = read('westmere-admin.html');
  assert.ok(/id="view-spend"/.test(ADMIN), 'the spend view is missing');
  assert.ok(/nav\('spend',this\)/.test(ADMIN), 'there must be a sidebar entry for it');
  assert.ok(/spend:'Customer Spend'/.test(ADMIN), 'it needs a page title');
  assert.ok(/id==='spend'&&typeof loadSpend==='function'/.test(ADMIN),
    'opening the section must load the data');
});

test('the view reads the staff endpoint with credentials, and only that', () => {
  const ADMIN = read('westmere-admin.html');
  assert.ok(/fetch\('\/api\/customer-spend',\{credentials:'include'\}\)/.test(ADMIN),
    'it must call the authenticated endpoint with credentials');
  assert.ok(!/\/api\/public\/customer-spend/.test(ADMIN),
    'it must never read spend from a public path');
});

test('it shows the ranked table AND a chart', () => {
  const ADMIN = read('westmere-admin.html');
  assert.ok(/id="sp-table"/.test(ADMIN) && /id="sp-chart"/.test(ADMIN), 'both the table and the chart must exist');
  assert.ok(/sp-bar-fill/.test(ADMIN), 'the chart needs bars');
  assert.ok(/cs\.slice\(0,\s*10\)/.test(ADMIN), 'the chart should show the top 10');
  // Money is escaped like everything else in this app.
  assert.ok(/escTo\(c\.name/.test(ADMIN) && /escTo\(c\.email/.test(ADMIN),
    'customer names and emails must be escaped before rendering');
});

test('the section explains what "spent" means', () => {
  const ADMIN = read('westmere-admin.html');
  assert.ok(/completed/i.test(ADMIN) && /Cancelled trips/i.test(ADMIN),
    'the definition of a counted trip must be on screen, not just in the code');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
