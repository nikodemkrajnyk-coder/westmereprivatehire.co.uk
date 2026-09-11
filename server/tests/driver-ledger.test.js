/**
 * THE DRIVER LEDGER — run with:
 *   node server/tests/driver-ledger.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   Three things, all the same thing.
 *
 *   1. TURNOVER COUNTED THE WHOLE FARE. A job passed to another driver has its
 *      fare collected on his behalf and paid straight back out; only the ten per
 *      cent is Westmere's. Six SUM(fare) sites counted the lot, overstating
 *      turnover by every payout ever made — which matters at the point somebody
 *      files a return.
 *   2. THE ARITHMETIC WAS WRITTEN OUT FIVE TIMES. `(admin_fee ?? fare * 0.10)`
 *      appeared in offer-routes.js, three times in api.js, and again in the
 *      ledger. A rate change had to find all five.
 *   3. THE BALANCE ONLY EVER GREW. The driver's job email promises that his
 *      commission on a cash job "carries to your next payout". Nothing recorded
 *      a payout, so nothing ever carried.
 *
 * WHAT IS GUARDED
 *   1. driver-ledger.js is the SOLE definition of the split and the rate.
 *   2. The JS and the SQL halves of westmereIncome agree, to the penny.
 *   3. A passed job contributes its commission only, at EVERY revenue site.
 *   4. A settlement reduces the balance, and can be undone.
 *   5. The statement PDF renders, on the invoice's letterhead, with the
 *      ledger's figures and not its own.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-ledger-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/* The mail stub intercepts RESEND ONLY. Several tests below drive the real
   routes over a real socket, and a stub that swallowed every fetch answered
   those with {id:'x'} — two tests failed for want of a response that had never
   been asked for. */
const SENT = [];
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (!/resend\.com/.test(url)) return realFetch(u, o);
  try { SENT.push(JSON.parse(o.body)); } catch (e) {}
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const ROOT = path.join(__dirname, '..', '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* Comments are stripped before searching a source file: a guard that reads its
   own explanation of what must not be there passes while the thing IS there. */
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── a driver, and a set of jobs with known answers ──────────────────────────
function mkDriver(name) {
  return db.prepare(
    "INSERT INTO users (username, password, full_name, email, role, active) VALUES (?,?,?,?,'driver',1)"
  ).run(name.toLowerCase().replace(/\W/g, '') + Math.random().toString(36).slice(2, 7),
        'x', name, name.toLowerCase().replace(/\W/g, '') + '@example.com').lastInsertRowid;
}
let refN = 0;
function mkJob(o) {
  refN++;
  const cols = Object.assign({
    ref: 'WPH-T' + String(refN).padStart(3, '0'), status: 'completed', time: '07:15',
    pickup: 'A Street, Lewes', destination: 'Gatwick Airport',
    paid_at: null, passed_at: null, driver_id: null, driver_pay: null, admin_fee: null
  }, o);
  const keys = Object.keys(cols);
  const info = db.prepare(
    `INSERT INTO bookings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...keys.map((k) => cols[k]));
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
}

console.log('\nOne authority for the arithmetic');

test('the ledger defines the rate and the split — nobody else does', () => {
  assert.strictEqual(ledger.ADMIN_FEE_PCT, 0.10, 'the commission is 10%');
  assert.deepStrictEqual(ledger.computeSplit(96), { driver_pay: 86.4, admin_fee: 9.6 });
  assert.deepStrictEqual(ledger.computeSplit(150), { driver_pay: 135, admin_fee: 15 });
  assert.deepStrictEqual(ledger.computeSplit(null), { driver_pay: null, admin_fee: null },
    'an unpriced job has no split, not a split of zero');

  /* THE POINT OF THE WHOLE EXERCISE. If the expression is written out anywhere
     else, there are two definitions again and a rate change reaches one. */
  for (const f of ['server/api.js', 'server/offer-routes.js', 'server/email.js',
                   'server/driver-statement-pdf.js']) {
    const c = code(f);
    assert.ok(!/fare\s*\*\s*0\.1\b|fare\s*\*\s*0\.10\b/.test(c),
      f + ' works out the commission itself — it must ask the ledger');
    assert.ok(!/\*\s*0\.9\b/.test(c),
      f + ' works out the payout itself — it must ask the ledger');
  }
  const ledgerCode = code('server/driver-ledger.js');
  assert.ok(/ADMIN_FEE_PCT\s*=\s*0\.10/.test(ledgerCode),
    'the rate must be DEFINED in the ledger, not imported into it');
});

test('offer-routes re-exports rather than redefining', () => {
  const offers = require('../offer-routes');
  assert.strictEqual(offers.ADMIN_FEE_PCT, ledger.ADMIN_FEE_PCT, 'the same rate object');
  assert.deepStrictEqual(offers.computeSplit(95), ledger.computeSplit(95), 'the same function');
  assert.ok(!/function computeSplit/.test(code('server/offer-routes.js')),
    'offer-routes has grown its own computeSplit again');
});

test('api.js asks the ledger instead of keeping its own copy', () => {
  const c = code('server/api.js');
  assert.ok(/require\('\.\/driver-ledger'\)/.test(c), 'api.js does not use the ledger at all');
  assert.ok(!/COMMISSION_RATE\s*=\s*0\.10/.test(c),
    'api.js has its own commission rate again');
  const uses = (c.match(/ledger\.jobSplit\(/g) || []).length;
  assert.ok(uses >= 3, 'expected the three hand-rolled splits to be ledger.jobSplit calls, found ' + uses);
});

console.log('\nWhat a job is worth');

test('the stored figures win over the derived ones', () => {
  const b = { fare: 100, admin_fee: 4, driver_pay: 96, payment: 'card' };
  assert.deepStrictEqual(ledger.jobSplit(b), { fare: 100, commission: 4, payout: 96 },
    'a hand-adjusted payout must never be silently recomputed out from under the driver');
  assert.deepStrictEqual(ledger.jobSplit({ fare: 100, payment: 'card' }),
    { fare: 100, commission: 10, payout: 90 }, 'and the fallback is the ledger rate');
});

test('prepaid moves the balance to the driver, cash moves it to Westmere', () => {
  assert.strictEqual(ledger.balanceDelta({ fare: 100, payment: 'card' }), 90,
    'we hold the fare, so we owe him his share');
  assert.strictEqual(ledger.balanceDelta({ fare: 100, payment: 'cash' }), -10,
    'he holds the fare, so he owes us ours');
  assert.strictEqual(ledger.balanceDelta({ fare: 100, payment: 'account' }), 90,
    'an account job is settled to Westmere — it is prepaid');
});

test('only the commission is turnover on a PASSED job', () => {
  assert.strictEqual(ledger.westmereIncome({ fare: 100, passed_at: '2026-09-01', payment: 'card' }), 10);
  assert.strictEqual(ledger.westmereIncome({ fare: 100, payment: 'card' }), 100,
    "a job nobody was passed is Westmere's own work — the whole fare is income");
  assert.strictEqual(ledger.westmereIncome({ fare: 100, passed_at: '2026-09-01', admin_fee: 7, payment: 'cash' }), 7,
    'and a hand-set commission is the income, derived or not');
});

console.log('\nThe SQL half must agree with the JavaScript half');

test('summed in SQL and summed in JS, the same figure to the penny', () => {
  const drv = mkDriver('Agree Driver');
  const rows = [
    { date: '2026-03-01', fare: 96,   payment: 'card',    paid_at: '2026-03-01 09:00', passed_at: '2026-03-01 06:00', driver_id: drv, admin_fee: 9.6, driver_pay: 86.4 },
    { date: '2026-03-02', fare: 150,  payment: 'cash',    passed_at: '2026-03-02 06:00', driver_id: drv },
    { date: '2026-03-03', fare: 75.5, payment: 'account', paid_at: '2026-03-04 09:00', passed_at: '2026-03-03 06:00', driver_id: drv },
    { date: '2026-03-04', fare: 70,   payment: 'card',    paid_at: '2026-03-04 09:00' },   // own work
    { date: '2026-03-05', fare: 33.33, payment: 'cash' },                                  // own work, odd pence
    { date: '2026-03-06', fare: 40,   payment: 'card',    paid_at: '2026-03-06 09:00', passed_at: '2026-03-06 06:00', driver_id: drv, admin_fee: 12 } // hand-set
  ];
  rows.forEach(mkJob);

  const sqlTotal = db.prepare(
    `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) AS t FROM bookings WHERE date >= '2026-03-01' AND date <= '2026-03-06'`
  ).get().t;
  const jsTotal = db.prepare(
    "SELECT * FROM bookings WHERE date >= '2026-03-01' AND date <= '2026-03-06'"
  ).all().reduce((t, b) => t + ledger.westmereIncome(b), 0);

  assert.strictEqual(Math.round(sqlTotal * 100) / 100, Math.round(jsTotal * 100) / 100,
    'the two halves of the authority disagree: SQL ' + sqlTotal + ' vs JS ' + jsTotal);
  /* Not vacuously equal at zero, and not equal because both count the fare. */
  assert.ok(sqlTotal > 0, 'the fixture summed to nothing — the comparison proved nothing');
  const fareTotal = db.prepare(
    "SELECT SUM(fare) t FROM bookings WHERE date >= '2026-03-01' AND date <= '2026-03-06'"
  ).get().t;
  assert.ok(Math.abs(sqlTotal - fareTotal) > 1,
    'income equals the sum of the fares — the passed jobs are not being discounted at all');
});

test('the SQL takes a table alias, and the rate comes from the ledger', () => {
  assert.ok(/b\.passed_at/.test(ledger.incomeSql('b.')), 'the prefix must reach every column');
  assert.ok(ledger.incomeSql().indexOf(String(ledger.ADMIN_FEE_PCT)) !== -1,
    'the SQL hardcodes a rate instead of using ADMIN_FEE_PCT');
  const aliased = db.prepare(
    `SELECT COALESCE(SUM(${ledger.incomeSql('b.')}),0) AS t FROM bookings b WHERE b.date = '2026-03-01'`
  ).get().t;
  assert.strictEqual(aliased, 9.6, 'the aliased form must give the same answer');
});

console.log('\nTurnover, at every revenue site');

test('no revenue site sums the raw fare any more', () => {
  const c = code('server/api.js');
  assert.ok(!/SUM\(fare\)/.test(c), 'a SUM(fare) has come back — that is turnover overstated');
  assert.ok(!/SUM\(b\.fare\)/.test(c), 'an aliased SUM(b.fare) has come back');
});

test('a passed job contributes its commission only, through the API', async () => {
  const express = require('express');
  const drv = mkDriver('Api Driver');
  /* A clean window nothing else in this file uses, so the expected figures are
     arithmetic rather than a running total of the fixture. */
  mkJob({ date: '2026-05-01', fare: 200, payment: 'card', paid_at: '2026-05-01 09:00',
          passed_at: '2026-05-01 06:00', driver_id: drv, admin_fee: 20, driver_pay: 180 });
  mkJob({ date: '2026-05-02', fare: 100, payment: 'card', paid_at: '2026-05-02 09:00' });

  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { req.auth = { id: 1, role: 'owner', type: 'user' }; n(); });
  app.use('/api', require('../api'));
  const srv = app.listen(0);
  const port = srv.address().port;
  const get = async (u) => (await (await fetch('http://127.0.0.1:' + port + u)).json());
  try {
    const before = db.prepare(
      "SELECT SUM(fare) t FROM bookings WHERE date >= '2026-05-01' AND date <= '2026-05-02'"
    ).get().t;
    assert.strictEqual(before, 300, 'fixture: the fares are £300');

    const an = await get('/api/analytics');
    const week = (an.weeklyTrend || []).reduce((t, w) => t + w.total, 0);
    assert.ok(an.revenue, 'no revenue block came back');

    /* The £200 job was passed: £20 of income, not £200. With the £100 of own
       work that is £120 from this window, not £300. */
    const inWindow = db.prepare(
      `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE date >= '2026-05-01' AND date <= '2026-05-02'`
    ).get().t;
    assert.strictEqual(inWindow, 120, 'the window should yield £120 of income, got ' + inWindow);

    const stats = await get('/api/stats');
    const allIncome = db.prepare(
      `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings
        WHERE ((LOWER(payment)='cash' AND status='completed') OR paid_at IS NOT NULL)`
    ).get().t;
    assert.strictEqual(Math.round(stats.stats.totalRevenue * 100) / 100,
                       Math.round(allIncome * 100) / 100,
      '/stats does not report the ledger income');
    const allFares = db.prepare(
      "SELECT COALESCE(SUM(fare),0) t FROM bookings WHERE ((LOWER(payment)='cash' AND status='completed') OR paid_at IS NOT NULL)"
    ).get().t;
    assert.ok(stats.stats.totalRevenue < allFares - 100,
      '/stats is still reporting something very close to the sum of the fares');

    assert.strictEqual(Math.round(an.revenue.allTime * 100) / 100,
                       Math.round(allIncome * 100) / 100,
      '/analytics all-time does not report the ledger income');
    assert.ok(week <= allFares, 'the weekly trend cannot exceed the fares');
  } finally { srv.close(); }
});

console.log('\nWhat has actually been paid');

test('a settlement reduces the balance, and undoing it puts it back', () => {
  const drv = mkDriver('Settle Driver');
  mkJob({ date: '2026-06-01', fare: 100, payment: 'card', paid_at: '2026-06-01 09:00',
          passed_at: '2026-06-01 06:00', driver_id: drv });
  assert.strictEqual(ledger.driverBalance(drv), 90, 'a £100 prepaid job owes him £90');

  const s = ledger.recordSettlement(drv, 50, { method: 'Bank transfer', paid_on: '2026-06-02' });
  assert.strictEqual(ledger.driverBalance(drv), 40, 'paying him £50 must leave £40 owing');

  ledger.recordSettlement(drv, 40, { method: 'Cash', paid_on: '2026-06-03' });
  assert.strictEqual(ledger.driverBalance(drv), 0, 'paying the rest must clear it');

  getDb().prepare('DELETE FROM driver_settlements WHERE id = ?').run(s.id);
  assert.strictEqual(ledger.driverBalance(drv), 50,
    'removing a £50 payment must put £50 back — a mistyped payment has to be reversible');
});

test('the cash commission really is netted off a later payout', () => {
  /* This is the email's promise, in figures: "your £9.60 fee carries to your
     next payout". A cash job first, a prepaid job after it, and the payout he
     is owed is the £90 less the £10 he already owes. */
  const drv = mkDriver('Netting Driver');
  mkJob({ date: '2026-07-01', fare: 100, payment: 'cash', passed_at: '2026-07-01 06:00', driver_id: drv });
  assert.strictEqual(ledger.driverBalance(drv), -10, 'after the cash job he owes us £10');
  mkJob({ date: '2026-07-02', fare: 100, payment: 'card', paid_at: '2026-07-02 09:00',
          passed_at: '2026-07-02 06:00', driver_id: drv });
  assert.strictEqual(ledger.driverBalance(drv), 80,
    'the £90 payout must arrive already netted of the £10 — not £90 with an invoice to follow');

  const h = ledger.driverHistory(drv);
  assert.deepStrictEqual(h.items.map((i) => i.balanceAfter), [-10, 80],
    'the running balance must be carried on each row, in order');
  assert.strictEqual(h.totals.cashCommission, 10, 'the cash commission is reported separately');
});

test('a settlement of nothing, or of nonsense, is refused', () => {
  const drv = mkDriver('Refuse Driver');
  for (const bad of [0, NaN, undefined, null, 'abc']) {
    assert.throws(() => ledger.recordSettlement(drv, bad),
      'a settlement of ' + JSON.stringify(bad) + ' was accepted — it would move the balance by nothing or by NaN');
  }
});

test('the settlement endpoints exist, are staff-only, and validate', async () => {
  const express = require('express');
  const drv = mkDriver('Route Driver');
  mkJob({ date: '2026-08-01', fare: 100, payment: 'card', paid_at: '2026-08-01 09:00',
          passed_at: '2026-08-01 06:00', driver_id: drv });

  const mk = (auth) => {
    const app = express();
    app.use(express.json());
    app.use((req, _r, n) => { req.auth = auth; n(); });
    app.use('/api', require('../api'));
    return app.listen(0);
  };
  const owner = mk({ id: 1, role: 'owner', type: 'user' });
  const stranger = mk({ id: 999, role: 'driver', type: 'user' });
  const call = (srv, m, u, body) => fetch('http://127.0.0.1:' + srv.address().port + u, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  try {
    let r = await call(owner, 'GET', '/api/drivers/' + drv + '/ledger');
    let j = await r.json();
    assert.strictEqual(r.status, 200, 'the ledger endpoint is missing');
    assert.strictEqual(j.balance, 90, 'the endpoint must report the ledger balance');
    assert.strictEqual(j.items.length, 1, 'and the history');

    /* /drivers/balances must not be swallowed by /drivers/:id — Express matches
       in order, and the parameterised route is declared in this same file. */
    /* /drivers/balances must not be swallowed by /drivers/:id. Read defensively:
       with the route missing, Express answers with its HTML 404 page and a bare
       .json() throws a parse error that says nothing about the cause. */
    r = await call(owner, 'GET', '/api/drivers/balances');
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    assert.ok(parsed, '/drivers/balances did not answer with JSON (' + r.status + ') — '
      + 'the route is missing, so the request fell through to /drivers/:id');
    assert.strictEqual(r.status, 200, '/drivers/balances answered ' + r.status);
    assert.ok(Array.isArray(parsed.drivers),
      'it answered, but as a single driver — the route is shadowed by /drivers/:id');
    j = parsed;
    const mine = j.drivers.filter((d) => d.id === drv)[0];
    assert.ok(mine && mine.balance === 90, 'the list must carry each balance');

    for (const bad of [{ amount: 0 }, { amount: 'x' }, {}, { amount: 5, paid_on: '01/09/2026' }]) {
      r = await call(owner, 'POST', '/api/drivers/' + drv + '/settlements', bad);
      assert.strictEqual(r.status, 400, 'accepted a bad settlement: ' + JSON.stringify(bad));
    }

    r = await call(owner, 'POST', '/api/drivers/' + drv + '/settlements', { amount: 90, method: 'Bank transfer' });
    j = await r.json();
    assert.strictEqual(r.status, 200, 'a good settlement was refused');
    assert.strictEqual(j.balance, 0, 'the response must carry the new balance');
    assert.strictEqual(ledger.driverBalance(drv), 0, 'and it must actually be recorded');

    r = await call(stranger, 'POST', '/api/drivers/' + drv + '/settlements', { amount: 10 });
    assert.strictEqual(r.status, 403, 'a driver was allowed to record a payment to himself');
    r = await call(stranger, 'GET', '/api/drivers/' + drv + '/ledger');
    assert.strictEqual(r.status, 403, "a driver was allowed to read another driver's ledger");

    r = await call(owner, 'DELETE', '/api/drivers/' + drv + '/settlements/' + j.settlement.id);
    j = await r.json();
    assert.strictEqual(r.status, 200, 'a settlement could not be undone');
    assert.strictEqual(j.balance, 90, 'undoing it must put the balance back');
  } finally { owner.close(); stranger.close(); }
});

console.log('\nThe statement');

test('the PDF renders, and its figures are the ledger\'s', async () => {
  const stmt = require('../driver-statement-pdf');
  const drv = mkDriver('Statement Driver');
  mkJob({ date: '2026-04-01', fare: 96, payment: 'card', paid_at: '2026-04-01 09:00',
          passed_at: '2026-04-01 06:00', driver_id: drv, admin_fee: 9.6, driver_pay: 86.4 });
  mkJob({ date: '2026-04-02', fare: 150, payment: 'cash', passed_at: '2026-04-02 06:00', driver_id: drv });
  ledger.recordSettlement(drv, 20, { method: 'Cash', paid_on: '2026-04-03' });

  const data = stmt.statementData(drv, {});
  assert.strictEqual(data.totals.jobs, 2);
  assert.strictEqual(data.totals.fares, 246);
  assert.strictEqual(data.totals.commission, 24.6);
  assert.strictEqual(data.balance, ledger.driverBalance(drv), 'the statement must show the ledger balance');
  assert.strictEqual(data.balance, 51.4, '£86.40 owed, less £15 cash commission, less £20 paid');

  const { text: drawn, buf } = await drawnText(drv, {});
  assert.ok(Buffer.isBuffer(buf) && buf.length > 3000, 'the PDF did not render');
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'that is not a PDF');

  // The figures must be ON THE PAGE, not merely in the data.
  for (const want of ['£96.00', '£86.40', '£150.00', '−£15.00', '£51.40', 'WESTMERE OWES YOU']) {
    assert.ok(drawn.indexOf(want) !== -1,
      'the statement does not print ' + want + ' — got: ' + drawn.slice(0, 500));
  }
  assert.ok(drawn.indexOf('WESTMERE') !== -1 && drawn.indexOf('PRIVATE HIRE') !== -1,
    'the statement is not on the letterhead');
  /* The cash job pays him nothing FROM US, and the page has to say so rather
     than leave a blank cell the reader has to interpret. */
  assert.ok(/Cash/.test(drawn) && /Prepaid/.test(drawn),
    'the statement does not say which jobs were cash and which were prepaid');
  // And it must NOT print the fare as though we owed it to him.
  assert.ok(drawn.indexOf('£135.00') === -1,
    'the payout column is showing a figure for the cash job — he already has that money');
});

test('a driver who owes money is told so, in words', async () => {
  const stmt = require('../driver-statement-pdf');
  const drv = mkDriver('Owing Driver');
  mkJob({ date: '2026-04-10', fare: 100, payment: 'cash', passed_at: '2026-04-10 06:00', driver_id: drv });
  const data = stmt.statementData(drv, {});
  assert.strictEqual(data.balance, -10, 'a cash job leaves him owing the commission');
  const { text: drawn } = await drawnText(drv, {});
  assert.ok(drawn.indexOf('YOU OWE WESTMERE') !== -1,
    'a negative balance must say who owes whom — a minus sign in a column of pounds is missable');
  assert.ok(drawn.indexOf('£10.00') !== -1, 'and name the amount');
  assert.ok(drawn.indexOf('WESTMERE OWES YOU') === -1,
    'it says both — the box must state one direction, not offer a choice');
});

test('the statement is bounded by the period, but the balance is not', async () => {
  const stmt = require('../driver-statement-pdf');
  const drv = mkDriver('Period Driver');
  mkJob({ date: '2026-01-05', fare: 100, payment: 'card', paid_at: '2026-01-05 09:00',
          passed_at: '2026-01-05 06:00', driver_id: drv });   // outside
  mkJob({ date: '2026-02-05', fare: 200, payment: 'card', paid_at: '2026-02-05 09:00',
          passed_at: '2026-02-05 06:00', driver_id: drv });   // inside
  const data = stmt.statementData(drv, { from: '2026-02-01', to: '2026-02-28' });
  assert.strictEqual(data.items.length, 1, 'the period must bound the rows');
  assert.strictEqual(data.totals.fares, 200, 'and the totals');
  assert.strictEqual(data.balance, 270,
    'the balance must be everything outstanding (£90 + £180), not the period alone — '
    + 'a week that closed at "we owe you £180" while £90 was outstanding is a misleading document');
});

test('an unknown driver gets a 404, not a crash', async () => {
  const stmt = require('../driver-statement-pdf');
  assert.strictEqual(stmt.statementData(999999, {}), null);
  assert.strictEqual(await stmt.buildDriverStatementPdf(999999, {}), null);
});

test('the statement PDF prints on the invoice letterhead, not a copy of it', () => {
  const inv = require('../invoice-pdf');
  assert.ok(inv.sheet && typeof inv.sheet.drawMasthead === 'function',
    'invoice-pdf no longer exports the shared letterhead');
  const c = code('server/driver-statement-pdf.js');
  assert.ok(/require\('\.\/invoice-pdf'\)/.test(c), 'the statement does not use the shared sheet');
  assert.ok(/drawMasthead\(/.test(c), 'the statement does not draw the shared masthead');
  /* Not "does the file contain the word WESTMERE" — it prints "YOU OWE
     WESTMERE" on the balance box, and the first version of this guard failed on
     its own correct output. What must not be here is a SECOND masthead: the
     tracked-wordmark machinery, or the strapline set as type. */
  assert.ok(!/centredWide\s*\(/.test(c),
    'the statement has its own tracked-wordmark routine — that is a second letterhead');
  assert.ok(!/PRIVATE HIRE\s*(·|&middot;)\s*SUSSEX/.test(c),
    'the statement sets the strapline itself instead of using the shared masthead');
});

test('the two documents draw the SAME letterhead, not two like ones', async () => {
  /* The point of sharing drawMasthead. Both documents are rendered and their
     masthead strings compared: a copy that merely looks the same today would
     pass a source-level check and drift on the first change to the wordmark. */
  const drv = mkDriver('Letterhead Driver');
  mkJob({ date: '2026-12-01', fare: 90, payment: 'card', paid_at: '2026-12-01 09:00',
          passed_at: '2026-12-01 06:00', driver_id: drv });
  const { text: statement } = await drawnText(drv, {});

  const { buildInvoicePdf } = require('../invoice-pdf');
  const byDoc = new Map(); const order = [];
  const orig = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str) {
    if (!byDoc.has(this)) { byDoc.set(this, []); order.push(this); }
    byDoc.get(this).push(String(str));
    return orig.apply(this, arguments);
  };
  try {
    await buildInvoicePdf({
      invoiceNo: 'WPH-INV-9001', kind: 'bespoke', total: 90,
      period: { issuedDate: '2026-12-01', dueDate: '2026-12-15' },
      recipient: { name: 'A Customer', email: 'a@b.co' },
      settings: { business_name: 'Westmere Private Hire' },
      bookings: [{ date: '2026-12-01', description: 'Lewes → Gatwick', fare: 90, amount: 90 }]
    });
  } finally { PDFDocument.prototype.text = orig; }
  const invoice = (byDoc.get(order[order.length - 1]) || []).join(' \u241F ');

  for (const part of ['W', 'WESTMERE', 'PRIVATE HIRE · SUSSEX']) {
    assert.ok(statement.indexOf(part) !== -1, 'the statement is missing "' + part + '"');
    assert.ok(invoice.indexOf(part) !== -1, 'the invoice is missing "' + part + '"');
  }
});

test('the emailed statement carries the PDF', async () => {
  const express = require('express');
  const drv = mkDriver('Emailed Driver');
  mkJob({ date: '2026-10-01', fare: 96, payment: 'card', paid_at: '2026-10-01 09:00',
          passed_at: '2026-10-01 06:00', driver_id: drv, admin_fee: 9.6, driver_pay: 86.4 });
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { req.auth = { id: 1, role: 'owner', type: 'user' }; n(); });
  app.use('/api', require('../api'));
  const srv = app.listen(0);
  SENT.length = 0;
  try {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/drivers/' + drv + '/statement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-10-01', to: '2026-10-07' })
    });
    assert.strictEqual(r.status, 200, 'the statement did not send: ' + JSON.stringify(await r.json()));
    const mail = SENT.filter((m) => /statement/i.test(m.subject || ''))[0];
    assert.ok(mail, 'no statement email was sent');
    const att = mail.attachments || [];
    assert.strictEqual(att.length, 1, 'the PDF was not attached');
    assert.strictEqual(att[0].content_type, 'application/pdf');
    assert.strictEqual(Buffer.from(att[0].content, 'base64').slice(0, 5).toString(), '%PDF-',
      'the attachment is not a PDF');
  } finally { srv.close(); }
});

test('the statement PDF endpoint serves it inline', async () => {
  const express = require('express');
  const drv = mkDriver('Download Driver');
  mkJob({ date: '2026-11-01', fare: 96, payment: 'card', paid_at: '2026-11-01 09:00',
          passed_at: '2026-11-01 06:00', driver_id: drv });
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { req.auth = { id: 1, role: 'owner', type: 'user' }; n(); });
  app.use('/api', require('../api'));
  const srv = app.listen(0);
  try {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/drivers/' + drv + '/statement.pdf');
    assert.strictEqual(r.status, 200, 'no PDF endpoint');
    assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
    assert.ok(/inline/.test(r.headers.get('content-disposition') || ''), 'it must preview, not force a download');
    assert.ok(/\.pdf"/.test(r.headers.get('content-disposition') || ''), 'and be named');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  } finally { srv.close(); }
});

console.log('\nThe screens');

const APPS = [['westmere-owner.html', 'the owner app'], ['westmere-admin.html', 'the admin app']];

for (const [file, label] of APPS) {
  test(label + ': shows each driver\'s balance and history from the ledger', () => {
    const c = code(file);
    assert.ok(/api\/drivers\/balances/.test(c),
      label + ' does not read the balances endpoint — it cannot be showing the ledger figure');
    assert.ok(/\/ledger/.test(c), label + ' never opens a driver ledger');
    assert.ok(/statement\.pdf/.test(c), label + ' offers no statement PDF');
  });

  test(label + ': can record a settlement, and does not do the arithmetic itself', () => {
    const c = code(file);
    /* The POST, specifically. An earlier version of this guard accepted the
       WORD "settlements" anywhere, and passed on `(d.settlements||[])` — the
       code that DISPLAYS them — while the form that records one was gone. An
       `||` between a strong check and a weak one is only ever the weak one. */
    assert.ok(/\/settlements'[\s\S]{0,200}?method\s*:\s*'POST'/.test(c)
           || /method\s*:\s*'POST'[\s\S]{0,200}?\/settlements/.test(c),
      label + ' has no way to RECORD a payment — the balance can only ever grow');
    assert.ok(/\/settlements\/'\s*\+[\s\S]{0,200}?'DELETE'/.test(c)
           || /'DELETE'[\s\S]{0,200}?\/settlements/.test(c),
      label + ' cannot undo a payment — a mistyped amount would silently clear a balance still owed');
    assert.ok(!/\*\s*0\.9\b/.test(c) && !/\*\s*0\.1\b/.test(c),
      label + ' works out a payout in the browser — the screen and the statement would be free to disagree');
  });
}

test('the owner ledger sheet does not depend on a string match to stay visible', () => {
  /* WHAT THE THEME ACTUALLY DOES. The owner app's white-surfaces restyle sets
     --navy to #ffffff !important, then rescues text with attribute selectors —
     [style*="color:var(--navy)"] { color:#111 !important } — which match the
     inline style STRING, not the colour. So `color:var(--navy)` is visible and
     `color:var(--navy,#102a43)` is white on white. That second spelling is what
     hid the dispatch sheet's save-tick label, and nothing about it looks wrong.

     This sheet was first built with four `color:var(--navy)` lines. They were
     VISIBLE — the exact string was rescued; an earlier note here said otherwise
     and was wrong. They were moved to --westmere-navy anyway, which the theme
     does not whiten, so the sheet's legibility no longer rests on nobody ever
     adding a fallback or a space inside a colour declaration.

     Hence the guard: no whitened variable is used for colour in the sheet at
     all. The admin app is not held to this — its theme forces `body *` black,
     which reaches its modal whatever the spelling. */
  const raw = src('westmere-owner.html');
  const whitened = [];
  const re = /--([a-z0-9-]+)\s*:\s*#(fff|ffffff)\s*!important/gi;
  let m;
  while ((m = re.exec(raw)) !== null) whitened.push('--' + m[1]);
  assert.ok(whitened.indexOf('--navy') !== -1,
    'the white theme no longer whitens --navy — re-read this guard before trusting it');

  const a = raw.indexOf('THE BALANCE, ON THE CARD');
  const b = raw.indexOf('var _drvDocsOpen={};', a);
  assert.ok(a > -1 && b > a, 'the owner ledger block could not be found');
  const block = raw.slice(a, b);
  assert.ok(/document\.body\.appendChild\(ov\)/.test(block),
    'the sheet is no longer appended to body — the premise of this guard changed');

  const used = [];
  const cre = /color:\s*var\((--[a-z0-9-]+)/gi;
  while ((m = cre.exec(block)) !== null) used.push(m[1]);
  assert.ok(used.length, 'no colour variables found — the extraction proved nothing');
  const bad = used.filter((v) => whitened.indexOf(v) !== -1);
  assert.deepStrictEqual(bad, [],
    'the ledger sheet colours text with ' + bad.join(', ') + ', which the white theme sets to '
    + '#ffffff. It is only visible while the inline string exactly matches one of the '
    + "theme's [style*=...] rescue selectors — add a fallback or a space and it goes white "
    + 'on white, which is how the dispatch label vanished');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(src('package.json'));
  assert.ok(/driver-ledger\.test\.js/.test(pkg.scripts.test),
    'a guard nobody runs is not a guard');
});

// ── what the statement actually drew ───────────────────────────────────────
/* "The totals are right" and "the totals are PRINTED" have been two different
   things in this repo before, so the assertions read the document, not the data
   that went into it.

   Read by RECORDING doc.text, the same seam server/tests/invoice-design.test.js
   uses. Reading the finished bytes back was the first attempt and it does not
   work here: pdfkit embeds Cormorant as a subset, so the content stream carries
   glyph ids rather than characters, and the two subsets both number their
   glyphs from 1 — a single ToUnicode map decodes one font's text as the other's.
   The recorder sees the strings as the page asked for them.

   The rendered buffer is still asserted separately, so a statement that records
   the right words and then fails to render is not a pass. */
const PDFDocument = require('pdfkit');
async function drawnText(driverId, opts) {
  const stmt = require('../driver-statement-pdf');
  const byDoc = new Map();
  const order = [];
  const orig = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (str) {
    if (!byDoc.has(this)) { byDoc.set(this, []); order.push(this); }
    byDoc.get(this).push(String(str));
    return orig.apply(this, arguments);
  };
  let buf;
  try { buf = await stmt.buildDriverStatementPdf(driverId, opts || {}); }
  finally { PDFDocument.prototype.text = orig; }
  const last = order[order.length - 1];
  return { text: (byDoc.get(last) || []).join(' \u241F '), buf };
}

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name); console.log('      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
