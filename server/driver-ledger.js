/**
 * WHAT A SUBCONTRACTED JOB DOES TO THE MONEY.
 *
 * A job passed to another driver moves three figures at once, and they pull in
 * different directions depending on who took the fare:
 *
 *   PREPAID (account, card, or anything already settled to Westmere)
 *     Westmere holds the fare. The driver is OWED his payout — the fare less
 *     commission. The balance moves IN HIS FAVOUR.
 *
 *   CASH (the passenger paid the driver in the car)
 *     The driver holds the fare. He OWES Westmere the commission. The balance
 *     moves in Westmere's favour, and sits as a credit that nets off the next
 *     payout owed to him — which is the whole point of a running balance rather
 *     than two separate columns nobody reconciles.
 *
 * ONE RUNNING FIGURE. A positive balance is money Westmere owes the driver; a
 * negative one is money the driver owes Westmere. Two numbers ("we owe you",
 * "you owe us") is how a subcontractor and an operator end up disagreeing.
 *
 * AND ONLY THE COMMISSION IS TURNOVER. On a passed job the fare is not
 * Westmere's income — it is collected on the driver's behalf and paid straight
 * out again. Counting the whole fare overstates turnover by the payout, which
 * matters at the point somebody files a return. `westmereIncome` is the one
 * answer to "what did this job earn us".
 *
 * DERIVED, NOT STORED. The history is the bookings themselves — a ledger table
 * kept alongside them would be a second copy of the same facts, free to drift
 * the moment a fare is corrected. Re-priced trip, re-priced payout, no
 * reconciliation step.
 *
 * GUARDRAIL: server/tests/driver-ledger.test.js
 */
'use strict';

const { getDb } = require('./db');

/* THE RATE. Ten per cent, defined once, here. offer-routes.js re-exports it and
   computeSplit so its callers and guards read unchanged; the SQL expressions
   below interpolate it so a rate change reaches the database too. It used to be
   the other way round — this module imported from a routes file, which put the
   money arithmetic downstream of an Express router and left api.js free to write
   its own copy. It wrote three. */
const ADMIN_FEE_PCT = 0.10;

/** The split of a fare into what Westmere keeps and what the driver is paid. */
function computeSplit(fare) {
  if (fare == null || isNaN(fare)) return { driver_pay: null, admin_fee: null };
  const f = Number(fare);
  const fee = Math.round(f * ADMIN_FEE_PCT * 100) / 100;
  const pay = Math.round((f - fee) * 100) / 100;
  return { driver_pay: pay, admin_fee: fee };
}

/** Did the driver take the money at the kerb? */
function isCashJob(b) {
  return String((b && b.payment) || '').toLowerCase() === 'cash';
}

/** The split for one job — the stored figures win, so a hand-adjusted payout
    is never silently recomputed out from under the driver. */
function jobSplit(b) {
  const fare = Number(b && b.fare) || 0;
  const derived = computeSplit(fare);
  const commission = (b && b.admin_fee != null) ? Number(b.admin_fee) : (derived.admin_fee || 0);
  const payout = (b && b.driver_pay != null) ? Number(b.driver_pay) : (derived.driver_pay || 0);
  return {
    fare,
    commission: Math.round(commission * 100) / 100,
    payout: Math.round(payout * 100) / 100
  };
}

/**
 * What this job moves the running balance by.
 *   prepaid → +payout   (we hold the fare, we owe him his share)
 *   cash    → −commission (he holds the fare, he owes us ours)
 */
function balanceDelta(b) {
  const s = jobSplit(b);
  return isCashJob(b) ? -s.commission : s.payout;
}

/**
 * Westmere's income from this job. On a passed job the fare belongs to the
 * driver and only the commission is turnover; a job nobody was passed is
 * Westmere's own work and the whole fare is.
 */
function westmereIncome(b) {
  if (!b) return 0;
  if (!isPassed(b)) return Math.round((Number(b.fare) || 0) * 100) / 100;
  return jobSplit(b).commission;
}

/** Has this job been passed to a subcontracted driver? */
function isPassed(b) {
  return !!(b && b.passed_at);
}

/** One history row, as the driver's statement and the account screen show it. */
function historyRow(b) {
  const s = jobSplit(b);
  const cash = isCashJob(b);
  return {
    id: b.id,
    ref: b.ref,
    date: b.date,
    time: b.time || 'ASAP',
    route: [b.pickup, b.destination].filter(Boolean).join(' → '),
    pickup: b.pickup,
    destination: b.destination,
    fare: s.fare,
    paymentType: cash ? 'cash' : 'prepaid',
    commission: s.commission,
    payout: s.payout,
    /* What this line does to the running figure — the sign is the whole story,
       so it is carried rather than left to be re-derived by each reader. */
    delta: balanceDelta(b)
  };
}


/* ── THE SAME ARITHMETIC, IN SQL ──────────────────────────────────────────────
   Turnover is summed over tens of thousands of rows; pulling every booking into
   Node to add it up in JavaScript would be a page of code and a lot of memory to
   answer "what did we take this month".

   So the sums stay in SQL — but the EXPRESSION is generated here, from the same
   ADMIN_FEE_PCT the JavaScript uses, and never written out at the call site.
   That is what keeps one authority across two languages. A guard sums the same
   bookings both ways and requires the answers to agree to the penny
   (server/tests/driver-ledger.test.js), so the two halves cannot drift.

   `p` prefixes the columns when the bookings table is aliased ('b.'). */

/** SQL for the commission on one row — the stored admin_fee wins, as in jobSplit. */
function commissionSql(p) {
  const q = p || '';
  return `ROUND(COALESCE(${q}admin_fee, ${q}fare * ${ADMIN_FEE_PCT}), 2)`;
}

/**
 * SQL for Westmere's income from one row: a passed job earns the commission
 * only, an unpassed one the whole fare. The JavaScript twin is westmereIncome().
 */
function incomeSql(p) {
  const q = p || '';
  return `(CASE WHEN ${q}passed_at IS NOT NULL`
    + ` THEN ${commissionSql(p)}`
    + ` ELSE COALESCE(${q}fare, 0) END)`;
}

/**
 * Every job passed to this driver, oldest first, each with the running balance
 * as it stood after that job. Optionally bounded to a period for a statement.
 */
function driverHistory(driverId, opts) {
  const o = opts || {};
  const db = getDb();
  const params = [driverId];
  let where = "b.driver_id = ? AND b.passed_at IS NOT NULL AND COALESCE(b.status,'') <> 'cancelled'";
  if (o.from) { where += ' AND b.date >= ?'; params.push(o.from); }
  if (o.to)   { where += ' AND b.date <= ?'; params.push(o.to); }
  const rows = db.prepare(
    `SELECT b.* FROM bookings b WHERE ${where} ORDER BY b.date, b.time, b.id`
  ).all(...params);

  let running = 0;
  const items = rows.map((b) => {
    const r = historyRow(b);
    running = Math.round((running + r.delta) * 100) / 100;
    r.balanceAfter = running;
    return r;
  });
  const totals = items.reduce((t, r) => ({
    jobs: t.jobs + 1,
    fares: Math.round((t.fares + r.fare) * 100) / 100,
    commission: Math.round((t.commission + r.commission) * 100) / 100,
    payout: Math.round((t.payout + (r.paymentType === 'cash' ? 0 : r.payout)) * 100) / 100,
    cashCommission: Math.round((t.cashCommission + (r.paymentType === 'cash' ? r.commission : 0)) * 100) / 100
  }), { jobs: 0, fares: 0, commission: 0, payout: 0, cashCommission: 0 });
  totals.balance = running;
  return { items, totals };
}


/* ── SETTLEMENTS ──────────────────────────────────────────────────────────────
   The jobs alone only ever say what is OWED. Paying a driver has to move the
   balance too, or the cash email's promise — "your fee carries to your next
   payout" — is a figure that only ever grows.

   ONE SIGNED COLUMN, not a paid/received pair. `amount` is money moving from
   Westmere to the driver: positive when we pay him, negative when he hands cash
   back to cover what he owes. Two columns would need a rule about which one a
   correction goes in, and the rule is where the disagreement lives.

   Settlements ARE stored, unlike the history — a payment is an event that
   happened, not a fact derivable from the bookings. */

/** What has already been paid across (or collected back), oldest first. */
function driverSettlements(driverId, opts) {
  const o = opts || {};
  const db = getDb();
  const params = [driverId];
  let where = 'driver_id = ?';
  if (o.from) { where += ' AND paid_on >= ?'; params.push(o.from); }
  if (o.to)   { where += ' AND paid_on <= ?'; params.push(o.to); }
  return db.prepare(
    `SELECT id, driver_id, amount, method, note, paid_on, created_at
       FROM driver_settlements WHERE ${where} ORDER BY paid_on, id`
  ).all(...params).map((r) => Object.assign({}, r, { amount: Math.round(Number(r.amount) * 100) / 100 }));
}

/** Record one. Returns the row as stored. */
function recordSettlement(driverId, amount, opts) {
  const o = opts || {};
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!isFinite(amt) || amt === 0) throw new Error('A settlement needs a non-zero amount');
  const db = getDb();
  const paidOn = o.paid_on || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
  const info = db.prepare(
    `INSERT INTO driver_settlements (driver_id, amount, method, note, paid_on, created_by)
     VALUES (?,?,?,?,?,?)`
  ).run(driverId, amt, o.method || null, o.note || null, paidOn, o.created_by || null);
  return db.prepare('SELECT * FROM driver_settlements WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * The single running figure for a driver, across everything: what the jobs owe
 * him, less what has already been handed over.
 *
 *   positive → Westmere owes the driver
 *   negative → the driver owes Westmere
 */
function driverBalance(driverId) {
  const jobs = driverHistory(driverId).totals.balance;
  const paid = driverSettlements(driverId)
    .reduce((t, s) => Math.round((t + s.amount) * 100) / 100, 0);
  return Math.round((jobs - paid) * 100) / 100;
}

module.exports = {
  ADMIN_FEE_PCT,
  computeSplit,
  commissionSql,
  incomeSql,
  driverSettlements,
  recordSettlement,
  isCashJob,
  isPassed,
  jobSplit,
  balanceDelta,
  westmereIncome,
  historyRow,
  driverHistory,
  driverBalance
};
