/**
 * INVOICED WORK IS INCOME TOO — run with:
 *   node server/tests/invoiced-income.test.js   (also gated by `npm test`)
 *
 * WHAT WAS MISSING. Turnover counted a job only once the money had arrived,
 * and "arrived" meant cash collected on a completed job, or paid_at set. Work
 * settled by INVOICE could satisfy neither: marking an invoice paid updates
 * the invoice row and nothing else. So every account job and every job sent to
 * another firm was worth nothing to the books, for ever — an under-count, on
 * the figure a tax return is built from.
 *
 * AND A JOB SENT TO ANOTHER FIRM WAS WORTH NOTHING TWICE OVER. Income read any
 * job with passed_at as "somebody else was paid out of this, so only the
 * commission is ours" — and an operator job carries no commission by design.
 * But nothing is paid out to an operator through this system: they drive it
 * and WE INVOICE THEM. The whole of what is billed is ours.
 *
 * THE MECHANISM, and why it cannot double-count. Two questions, each answered
 * in exactly one place:
 *
 *      WHEN did the money arrive?   →  the booking, or the invoice that
 *                                      settles it (ledger.receivedSql)
 *      HOW MUCH of it is ours?      →  the job itself (ledger.incomeSql)
 *
 * Invoice TOTALS are never summed into revenue. If they were, an account job
 * whose booking also had paid_at set would count twice and the two mechanisms
 * would have to be kept in step for ever. Here every job contributes exactly
 * once, through its own row, and the invoice only unlocks it — so a job passed
 * to a driver and billed on an account invoice still contributes the
 * commission and not the fare.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-invinc-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── THE DATASET THE OWNER ASKED TO SEE ───────────────────────────────────
   One of each kind of job, with figures chosen so every total below is
   distinguishable from every other — if two rules collide the sum changes. */
let seq = 0;
function driver() {
  return db.prepare(`INSERT INTO users (username,password,role,full_name,email,active,has_login)
                     VALUES (?, '', 'driver', 'Gary', ?, 1, 0)`)
    .run('ii' + (++seq) + Date.now().toString(36), 'ii' + seq + '@x.com').lastInsertRowid;
}
function customer(isOp) {
  return db.prepare(`INSERT INTO customers (full_name,email,password,is_operator,active)
                     VALUES (?,?, '', ?, 1)`)
    .run(isOp ? 'Harding Exec' : 'Sussex Corporate', 'c' + (++seq) + '@x.com', isOp ? 1 : 0).lastInsertRowid;
}
function invoice(custId, total, paid) {
  return db.prepare(`INSERT INTO invoices (invoice_no, kind, customer_id, recipient_name,
                                           issued_date, line_items_json, total, paid, paid_at)
                     VALUES (?, 'account', ?, 'X', '2026-10-01', '[]', ?, ?, ?)`)
    .run('INV-' + (++seq) + '-' + Date.now().toString(36), custId, total, paid ? 1 : 0,
         paid ? '2026-10-20' : null).lastInsertRowid;
}
function job(o) {
  const ref = 'WPH-I' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                    driver_id,operator_id,driver_pay,admin_fee,passed_at,paid_at,invoice_id)
              VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick', o.date || '2026-10-12', '07:00', o.fare, o.payment,
         o.status || 'completed', o.driver_id || null, o.operator_id || null,
         o.driver_pay == null ? null : o.driver_pay, o.admin_fee == null ? null : o.admin_fee,
         o.passed_at || null, o.paid_at || null, o.invoice_id || null);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}

const INCOME = () => db.prepare(
  `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) AS t FROM bookings WHERE ${ledger.receivedSql()}`).get().t;
/* The rule exactly as it stood before this change, so "before" is a
   measurement rather than a memory. */
const OLD_INCOME = () => db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN passed_at IS NOT NULL THEN ROUND(COALESCE(admin_fee, fare * 0.1),2)
                            ELSE COALESCE(fare,0) END),0) AS t
     FROM bookings
    WHERE ((LOWER(payment)='cash' AND status='completed') OR paid_at IS NOT NULL)`).get().t;

let D, OP, ACC, J;
function seedAll() {
  D = driver(); OP = customer(true); ACC = customer(false);
  const paidOpInv   = invoice(OP, 165, true);
  const unpaidOpInv = invoice(OP, 120, false);
  const paidAccInv  = invoice(ACC, 80, true);
  J = {
    cash:      job({ fare: 60,  payment: 'cash', status: 'completed' }),
    card:      job({ fare: 100, payment: 'card', paid_at: '2026-10-12 09:00' }),
    toDriver:  job({ fare: 200, payment: 'card', paid_at: '2026-10-12 09:00',
                     driver_id: D, driver_pay: 180, admin_fee: 20, passed_at: '2026-10-11' }),
    opPaid:    job({ fare: 165, payment: 'account', operator_id: OP, driver_pay: 165,
                     admin_fee: 0, passed_at: '2026-10-11', invoice_id: paidOpInv }),
    opUnpaid:  job({ fare: 120, payment: 'account', operator_id: OP, driver_pay: 120,
                     admin_fee: 0, passed_at: '2026-10-11', invoice_id: unpaidOpInv }),
    account:   job({ fare: 80,  payment: 'account', invoice_id: paidAccInv })
  };
}

// ── 1. THE NUMBERS ────────────────────────────────────────────────────────
console.log('\nSix jobs, one of each kind');

test('BEFORE: every invoiced job was worth nothing', () => {
  seedAll();
  // 60 cash + 100 card + 20 commission = 180. The three invoiced jobs: nothing.
  assert.strictEqual(OLD_INCOME(), 180,
    'the old rule is not what this test thinks it was — the comparison below is meaningless');
});

test('AFTER: the paid invoices count, the unpaid one does not', () => {
  // 60 + 100 + 20 commission + 165 operator (paid) + 80 account (paid) = 425.
  // The £120 operator job is invoiced but UNPAID, so it is still not income.
  assert.strictEqual(INCOME(), 425, 'the new total is wrong');
});

test('a job passed to a DRIVER still counts only the share, never the fare', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(J.toDriver.id);
  assert.strictEqual(ledger.westmereIncome(row), 20, 'the driver job is contributing more than the commission');
  const alone = db.prepare(
    `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE id = ?`).get(J.toDriver.id).t;
  assert.strictEqual(alone, 20, 'and the SQL half disagrees with the JS half');
});

test('a job passed to a FIRM counts what was billed, not the commission it has none of', () => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(J.opPaid.id);
  assert.strictEqual(ledger.westmereIncome(row), 165,
    'an operator job is being read as a driver job — nothing is paid out to an operator');
  assert.strictEqual(ledger.paysSomebodyOut(row), false);
  assert.strictEqual(ledger.paysSomebodyOut(
    db.prepare('SELECT * FROM bookings WHERE id = ?').get(J.toDriver.id)), true);
});

test('NOTHING IS COUNTED TWICE — the whole table, job by job', () => {
  /* The real protection is structural: income is a sum over BOOKINGS and
     invoice totals are never added to it. Prove both halves — that the total
     is exactly the sum of the per-job figures, and that no revenue query
     anywhere sums an invoice. */
  const rows = db.prepare('SELECT * FROM bookings').all();
  let byHand = 0;
  for (const b of rows) {
    const arrived = db.prepare(`SELECT ${ledger.receivedSql()} AS ok FROM bookings WHERE id = ?`).get(b.id).ok;
    if (arrived) byHand = Math.round((byHand + ledger.westmereIncome(b)) * 100) / 100;
  }
  assert.strictEqual(byHand, INCOME(), 'the total is not the sum of its jobs');

  const api = read('server/api.js');
  assert.ok(!/SUM\([^)]*i?\.?total[^)]*\)[\s\S]{0,80}FROM invoices/i.test(api)
            || !/revenue|turnover|income/i.test(api.slice(Math.max(0, api.search(/SUM\([^)]*total[^)]*\)[\s\S]{0,80}FROM invoices/i) - 400))),
    'a revenue figure is summing invoice totals as well as bookings — that is the double count');
});

test('…and marking the last invoice paid adds exactly its own job, once', () => {
  const before = INCOME();
  const inv = db.prepare('SELECT invoice_id FROM bookings WHERE id = ?').get(J.opUnpaid.id).invoice_id;
  db.prepare("UPDATE invoices SET paid = 1, paid_at = '2026-10-21' WHERE id = ?").run(inv);
  assert.strictEqual(INCOME(), Math.round((before + 120) * 100) / 100,
    'paying one invoice moved turnover by something other than that job');
  db.prepare('UPDATE invoices SET paid = 0, paid_at = NULL WHERE id = ?').run(inv);
  assert.strictEqual(INCOME(), before, 'and unpaying it did not put the figure back');
});

test('an account job that is ALSO marked paid on the booking counts once, not twice', () => {
  const b = J.account;
  db.prepare("UPDATE bookings SET paid_at = '2026-10-20 10:00' WHERE id = ?").run(b.id);
  assert.strictEqual(INCOME(), 425,
    'the same job satisfied both halves of the gate and was counted twice');
  db.prepare('UPDATE bookings SET paid_at = NULL WHERE id = ?').run(b.id);
});

// ── 2. THE RULES THEMSELVES ───────────────────────────────────────────────
console.log('\nOne definition of each question, in one place');

test('the "money arrived" rule lives in the ledger, and the API uses it', () => {
  const api = read('server/api.js');
  assert.ok(/ledger\.receivedSql\(\)/.test(api), 'the API no longer asks the ledger when money arrived');
  assert.ok(!/LOWER\(payment\)='cash' AND status='completed'/.test(api),
    'the API has written its own copy of the rule again — the copy is what went stale');
  assert.ok(/invoices i WHERE i\.id =/.test(ledger.receivedSql()), 'the rule does not consider an invoice');
});

test('the SQL and JS halves of income agree on every job in the table', () => {
  for (const b of db.prepare('SELECT * FROM bookings').all()) {
    const sql = db.prepare(
      `SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE id = ?`).get(b.id).t;
    assert.strictEqual(sql, ledger.westmereIncome(b),
      'job ' + b.ref + ': SQL says ' + sql + ', JS says ' + ledger.westmereIncome(b));
  }
});

test('the card fee is still not income, and still not in the turnover SQL', () => {
  // The rule the owner set earlier, unchanged by any of this.
  assert.ok(!/card_received/.test(ledger.incomeSql()), 'the card fee has got into turnover');
  assert.strictEqual(ledger.westmereIncome(
    { fare: 96, payment: 'card', admin_fee: 0, driver_pay: 96, card_received: 93, passed_at: 'x' }), 0,
    'a cover card job is no longer worth nothing');
});

test('every job on an invoice is linked to it, both kinds', () => {
  const api = read('server/api.js');
  assert.ok(/UPDATE bookings SET invoice_id = \? WHERE id = \? AND invoice_id IS NULL/.test(api),
    'account invoices no longer link their jobs');
  assert.ok(/invoice_id = COALESCE\(invoice_id, \?\)/.test(api),
    'operator invoices no longer link their jobs');
  const dbsrc = read('server/db.js');
  assert.ok(/ALTER TABLE bookings ADD COLUMN invoice_id INTEGER/.test(dbsrc), 'the column is not migrated');
  assert.ok(/booking_ids_json/.test(dbsrc), 'historic account invoices are not backfilled');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoiced-income\.test\.js/.test(read('package.json')),
    'invoiced-income.test.js is not in the npm test chain — an unrun guard is no guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
