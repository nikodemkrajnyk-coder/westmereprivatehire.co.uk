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

/* The one rate, shared with the offer flow (server/offer-routes.js) so a job
   cannot be worth one thing when it is offered and another when it is paid. */
const { ADMIN_FEE_PCT, computeSplit } = require('./offer-routes');

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

/** The single running figure for a driver, across everything. */
function driverBalance(driverId) {
  return driverHistory(driverId).totals.balance;
}

module.exports = {
  ADMIN_FEE_PCT,
  isCashJob,
  isPassed,
  jobSplit,
  balanceDelta,
  westmereIncome,
  historyRow,
  driverHistory,
  driverBalance
};
