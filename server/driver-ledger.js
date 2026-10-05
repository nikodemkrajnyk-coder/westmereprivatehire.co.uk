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
 * THE JOB IS THE UNIT OF SETTLEMENT, and that is the whole reconciliation.
 *   Each job carries `driver_settled`: how much of its movement has changed
 *   hands, signed the same way the movement is. The balance is what is left:
 *
 *       balance = Σ (delta(job) − settled(job))
 *
 *   A lump payment is not a second figure that pulls against this. Paying a
 *   driver £300 SPENDS that £300 across his oldest unsettled jobs and stamps
 *   them; the receipt (driver_settlements) records that money moved, when and
 *   by what method, and the balance never reads it. There is therefore one
 *   place to look when the driver disagrees — his jobs — and the receipt
 *   tells him which payment cleared which.
 *
 *   This is the operator model with the invoice swapped for the job: an
 *   operator owes the invoices they have not paid, a driver is owed the jobs
 *   that have not been settled. Two relationships, one shape.
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

/**
 * The split of a fare into what Westmere keeps and what the driver is paid.
 *
 * `rate` is a FRACTION (0.10, not 10) and is optional: left out, a job is worth
 * the house rate, which is what every caller meant before commission became a
 * choice. Passed as 0 it is a cover job — a favour, or one he could have driven
 * himself — and the driver keeps the fare.
 *
 * The rate is a parameter rather than a second function because there is one
 * definition of what a job is worth; "no commission" is a value of it, not an
 * exception to it. GUARDRAIL: server/tests/driver-ledger.test.js
 */
function computeSplit(fare, rate) {
  if (fare == null || isNaN(fare)) return { driver_pay: null, admin_fee: null };
  const r = (rate === null || rate === undefined || isNaN(rate)) ? ADMIN_FEE_PCT : Number(rate);
  const f = Number(fare);
  const fee = Math.round(f * r * 100) / 100;
  const pay = Math.round((f - fee) * 100) / 100;
  return { driver_pay: pay, admin_fee: fee };
}

/**
 * The rate to OFFER for a job going to this driver, as a fraction.
 *
 * NULL is not zero. A driver saved before the column existed has no default and
 * takes the house rate; a driver deliberately set to 0 is one we charge nothing.
 * Reading a missing column as zero would quietly stop charging commission for
 * every driver already on file.
 */
function rateForDriver(driver) {
  const pct = driver && driver.commission_pct;
  if (pct === null || pct === undefined || pct === '' || isNaN(pct)) return ADMIN_FEE_PCT;
  return Math.max(0, Math.min(100, Number(pct))) / 100;
}

/* ── WHAT ACTUALLY LANDED FROM A CARD PAYMENT ─────────────────────────────
   Stripe takes its cut whoever drove the job: a £96 fare arrives as about £93.
   On a job passed on for NO commission nothing covered that, and the owner was
   paying it out of his own pocket on work he kept nothing from.

   HE TYPES THE AMOUNT RECEIVED, not a fee and not a rate. That is the number
   on his statement, so it is the one he can check without doing arithmetic
   first — and the fee is simply the difference from the fare. An earlier pass
   estimated it at 1.5% + 20p; his answer was that he would rather key in the
   real one. There is no rate in this file to fall back on.

   NULL means he has not said, and the driver is paid on the whole fare.

   ONLY ON A CARD PAYMENT. A debit card is a card as far as Stripe is
   concerned. Cash, account and invoice cost nothing to collect, and `pending`
   means no method has been chosen — a deduction taken on a guess is money off
   a driver for a payment that may never be made by card. A figure left on a
   job whose method later changes is ignored rather than applied.
   GUARDRAIL: server/tests/card-received.test.js */

/** Was this fare taken by card (or debit card)? The only method Stripe bills us for. */
function isCardJob(b) {
  return String((b && b.payment) || '').toLowerCase() === 'card';
}

/** What actually landed, as the owner typed it. The FARE when he has not said,
    or when the job was not paid by card — never more than the fare, never less
    than nothing. */
function receivedOn(b) {
  const fare = Number(b && b.fare) || 0;
  if (!b || !isCardJob(b)) return fare;
  /* NULL IS NOT ZERO, and here the difference is the driver's whole payout.
     The column is NULL until the owner says what landed, and `Number(null)` is
     0 — which read as "nothing arrived", made the fee the entire fare and paid
     the driver £0 on every card job in the system. The column has to be
     checked for emptiness before it is turned into a number. */
  const raw = b.card_received;
  if (raw === null || raw === undefined || raw === '') return fare;
  const v = Number(raw);
  if (!isFinite(v) || v < 0) return fare;
  return Math.min(Math.round(v * 100) / 100, fare);
}

/** The difference — what the card cost. Shown, never stored: one figure is
    typed and the other is derived from it, so the two can never disagree. */
function cardFeeOn(b) {
  const fare = Number(b && b.fare) || 0;
  return Math.round((fare - receivedOn(b)) * 100) / 100;
}

/** Did the driver take the money at the kerb? */
function isCashJob(b) {
  return String((b && b.payment) || '').toLowerCase() === 'cash';
}

/** The split for one job — the stored figures win, so a hand-adjusted payout
    is never silently recomputed out from under the driver. */
/**
 * THE AMOUNT THE OWNER AGREED WITH THE DRIVER, if he set one.
 *
 * Passing a job is a conversation. Most of the time the rate answers it, and
 * this is null; sometimes the two of them settle on a number instead, and then
 * that number is the answer — not a starting point the arithmetic can erode.
 *
 * WHICH IS WHY IT BEATS THE CARD FEE TOO. The fee normally comes off the
 * driver's side (the owner's own rule), but an agreed figure is a figure he has
 * given a man: if Stripe's cut turns up three days later, the shortfall is the
 * firm's, not a quiet £3 off what was promised. The commission stored beside it
 * is whatever is left of the fare, so the fare still equals commission + payout
 * and the turnover SQL needs to know nothing about any of this.
 * GUARDRAIL: server/tests/driver-payout-set.test.js
 */
function manualPayoutOn(b) {
  const v = b && b.driver_payout_set;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function jobSplit(b) {
  const fare = Number(b && b.fare) || 0;
  const derived = computeSplit(fare);
  const commission = Math.round(((b && b.admin_fee != null) ? Number(b.admin_fee) : (derived.admin_fee || 0)) * 100) / 100;
  const before = Math.round(((b && b.driver_pay != null) ? Number(b.driver_pay) : (derived.driver_pay || 0)) * 100) / 100;
  const manual = manualPayoutOn(b);
  /* THE DRIVER IS PAID OUT OF WHAT ARRIVED. The owner's words: the payout is
     worked out from the real received amount, then less commission if it is a
     commission job. Derived rather than stored, because a booking only reads
     `card` once Stripe says the payment succeeded — which can be after the job
     was passed, and a payout frozen at dispatch would be wrong the moment it
     is. `payout_before_fee` is kept so the email and the trip page can show the
     subtraction instead of a number nobody can check. */
  const fee = cardFeeOn(b);
  /* The card fee is still reported — it is a fact about the job, and the trip
     page shows it — but it does not come off an agreed figure. */
  return {
    fare,
    commission,
    received: receivedOn(b),
    card_fee: fee,
    payout_set: manual !== null,
    payout_before_fee: manual !== null ? manual : before,
    payout: manual !== null ? manual : Math.round((before - fee) * 100) / 100
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

/** How much of this job's movement has already changed hands. Signed like the
    delta: positive where we paid him, negative where he handed cash back. */
function settledOn(b) {
  const v = b && b.driver_settled;
  return (v === null || v === undefined || isNaN(v)) ? 0 : Math.round(Number(v) * 100) / 100;
}

/** What is still outstanding on this job — the balance is the sum of these. */
function outstandingOn(b) {
  return Math.round((balanceDelta(b) - settledOn(b)) * 100) / 100;
}

/** Settled in full when nothing is left on it. A job worth nothing either way
    — a cover job the driver was paid for in cash — is settled by definition. */
function isSettled(b) {
  return Math.abs(outstandingOn(b)) < 0.005;
}

/**
 * Westmere's income from this job. On a passed job the fare belongs to the
 * driver and only the commission is turnover; a job nobody was passed is
 * Westmere's own work and the whole fare is.
 */
/* ── PASSED, FOR THE PURPOSE OF INCOME ────────────────────────────────────
   Not the same question as "was this job sent to somebody else". A job passed
   to a DRIVER pays money out — his payout — so only the commission was ever
   ours. A job passed to an OPERATOR pays nothing out through this system: the
   other firm drives it and WE INVOICE THEM, so the whole of what we bill is
   ours and there is no payout to net off.

   Reading operator jobs as "passed" made their income the commission, which is
   zero on an operator job by design — so every job sent to another firm
   counted as nothing at all, however much was billed and collected for it.
   GUARDRAIL: server/tests/invoiced-income.test.js */
function paysSomebodyOut(b) {
  return isPassed(b) && !(b && b.operator_id);
}

function westmereIncome(b) {
  if (!b) return 0;
  if (!paysSomebodyOut(b)) return Math.round((Number(b.fare) || 0) * 100) / 100;
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
    /* WHO IT WAS. A compact trips list is read by passenger — "that Gatwick
       run for Mrs Hall" — and the name was the one thing a history row could
       not say, so the list had to carry the route instead and stopped being
       compact. */
    name: b.customer_name || b.passenger_name || 'Guest',
    route: [b.pickup, b.destination].filter(Boolean).join(' → '),
    pickup: b.pickup,
    destination: b.destination,
    /* HOW THE CUSTOMER PAID, as stored (pending|card|cash|account|invoice).
       `paymentType` below is the LEDGER's question — did the driver take the
       money at the kerb — and the two are not the same: an account job and a
       card job are both 'prepaid' to the ledger and different things on the
       trip's detail page. Never defaulted to cash (CLAUDE.md invariant #1). */
    payment: b.payment || 'pending',
    paid_at: b.paid_at || null,
    paid_amount: (b.paid_amount === null || b.paid_amount === undefined) ? null : Math.round(Number(b.paid_amount) * 100) / 100,
    fare: s.fare,
    paymentType: cash ? 'cash' : 'prepaid',
    commission: s.commission,
    /* What arrived, what the card cost, and what he would have had without it. */
    received: s.received,
    card_fee: s.card_fee,
    payout_before_fee: s.payout_before_fee,
    payout: s.payout,
    /* What this line does to the running figure — the sign is the whole story,
       so it is carried rather than left to be re-derived by each reader. */
    delta: balanceDelta(b),
    /* …and how much of it has been squared. The screen shows a job as paid or
       not; a part-payment is the rare case and says how far it got. */
    settled: settledOn(b),
    outstanding: outstandingOn(b),
    paid: isSettled(b),
    /* The rate actually charged on this job, so the row can offer to change it
       without re-deriving it from two figures and a guess. */
    commission_pct: (Number(b.fare) > 0)
      ? Math.round((jobSplit(b).commission / Number(b.fare)) * 1000) / 10
      : 0
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
  /* The SQL twin of westmereIncome, including the operator rule: a job sent to
     another FIRM pays nothing out, so the whole of it is ours. */
  return `(CASE WHEN ${q}passed_at IS NOT NULL AND ${q}operator_id IS NULL`
    + ` THEN ${commissionSql(p)}`
    + ` ELSE COALESCE(${q}fare, 0) END)`;
}

/**
 * HAS THE MONEY FOR THIS JOB ACTUALLY ARRIVED?
 *
 * One expression, in one place, because this is the gate every revenue figure
 * stands behind and it had been written inline where it was used.
 *
 *   • cash collected on a completed job — he had it in his hand;
 *   • paid_at set — Stripe, or marked paid by hand;
 *   • OR THE INVOICE THAT SETTLES IT HAS BEEN PAID. That third one is new.
 *     Account work and work passed to another firm are both settled by
 *     invoice, and until now neither could ever satisfy this test — so every
 *     penny of invoiced income was missing from turnover.
 *
 * WHY THIS AND NOT "ADD UP THE INVOICES". Because a job must count ONCE. If
 * invoice totals were summed as well, an account job whose booking also had
 * paid_at set would be counted twice, and the two mechanisms would have to be
 * kept in step for ever. Here the invoice only answers WHEN; the job itself
 * still answers HOW MUCH, through incomeSql — so a job passed to a driver on
 * an account invoice still contributes the commission and not the fare, and
 * nothing anywhere adds a second figure for the same work.
 * GUARDRAIL: server/tests/invoiced-income.test.js
 */
function receivedSql(p) {
  const q = p || '';
  return `((LOWER(COALESCE(${q}payment,'')) = 'cash' AND ${q}status = 'completed')`
    + ` OR ${q}paid_at IS NOT NULL`
    + ` OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${q}invoice_id AND COALESCE(i.paid,0) = 1))`;
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
    cashCommission: Math.round((t.cashCommission + (r.paymentType === 'cash' ? r.commission : 0)) * 100) / 100,
    /* WHAT IS ACTUALLY LEFT. `balance` below is every job in the period
       whether or not it has been paid — it is what the statement walks
       through. This is the figure the owner owes today. */
    outstanding: Math.round((t.outstanding + r.outstanding) * 100) / 100,
    settledJobs: t.settledJobs + (r.paid ? 1 : 0)
  }), { jobs: 0, fares: 0, commission: 0, payout: 0, cashCommission: 0, outstanding: 0, settledJobs: 0 });
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
    `SELECT id, driver_id, amount, method, note, paid_on, created_at, applied_json
       FROM driver_settlements WHERE ${where} ORDER BY paid_on, id`
  ).all(...params).map((r) => {
    /* WHAT IT PAID FOR, parsed for the reader. The screen states any part of a
       payment that no job claimed — it is out of the balance by design, and
       out of sight would be money lost. */
    let applied = null;
    try { applied = r.applied_json ? JSON.parse(r.applied_json) : null; } catch (_) { applied = null; }
    return Object.assign({}, r, { amount: Math.round(Number(r.amount) * 100) / 100, applied });
  });
}

/** Record one. Returns the row as stored. */
function recordSettlement(driverId, amount, opts) {
  const o = opts || {};
  const amt = Math.round(Number(amount) * 100) / 100;
  /* A PAYMENT of nothing is a mistake; a BATCH that nets to nothing is not.
     A week of one prepaid job and one cash job of the same commission squares
     itself — no transfer leaves the bank, and the jobs still have to be marked
     paid and the act still has to be undoable. Only the batch passes
     allowZero, and it always carries the jobs it settled. */
  if (!isFinite(amt)) throw new Error('A settlement needs an amount');
  if (amt === 0 && !o.allowZero) throw new Error('A settlement needs a non-zero amount');
  const db = getDb();
  const paidOn = o.paid_on || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
  const info = db.prepare(
    `INSERT INTO driver_settlements (driver_id, amount, method, note, paid_on, created_by, applied_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(driverId, amt, o.method || null, o.note || null, paidOn, o.created_by || null,
        o.applied ? JSON.stringify(o.applied) : null);
  return db.prepare('SELECT * FROM driver_settlements WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * The single running figure for a driver: the jobs that have not been settled.
 *
 *   positive → Westmere owes the driver
 *   negative → the driver owes Westmere
 *
 * IT DOES NOT READ THE SETTLEMENTS TABLE, and that is the point. It used to be
 * "every job, less every payment", which is two records of the same money and
 * no way to answer "which jobs is this £300 for?". A payment now spends itself
 * across the jobs it pays for (see applyPayment) and the receipt is kept
 * beside them. One place to look, and a driver querying a figure can be shown
 * the jobs it is made of. GUARDRAIL: server/tests/driver-settlement.test.js
 */
function driverBalance(driverId) {
  const db = getDb();
  /* SELECT *, LIKE EVERY OTHER READER IN THIS FILE — and that is the point.
     This named its six columns, which made it a SECOND PLACE to remember a
     column, and the day `driver_payout_set` arrived nobody remembered. The row
     came back without it, jobSplit saw undefined, and the balance quietly fell
     back to the derived figure: the same job showed £97 on the balance screen
     and £100 on the weekly payout. A list of columns is a promise to keep
     updating a list of columns, and the ledger already has one place where
     money is decided. */
  const rows = db.prepare(
    `SELECT * FROM bookings
      WHERE driver_id = ? AND passed_at IS NOT NULL AND COALESCE(status,'') <> 'cancelled'`
  ).all(driverId);
  return rows.reduce((t, b) => Math.round((t + outstandingOn(b)) * 100) / 100, 0);
}

/**
 * Square one job, or re-open it. `paid` true stamps the whole of its movement
 * as settled; false clears it. The amount is never typed — it is what the job
 * is worth, so a toggle cannot introduce a figure that disagrees with the job.
 */
function setJobSettled(jobId, paid) {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(jobId);
  if (!b) return null;
  const amount = paid ? balanceDelta(b) : null;
  db.prepare('UPDATE bookings SET driver_settled = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(amount, jobId);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(jobId);
}

/**
 * Spend a payment across the jobs it pays for, oldest first, and keep the
 * receipt. Returns the jobs it cleared and anything it could not place.
 *
 * OLDEST FIRST, because that is the order a driver chases them in, and whole
 * jobs before part ones: a payment that runs out mid-job part-settles that one
 * rather than rounding in anybody's favour. A payment pulling the wrong way
 * for a job (money out against a job he owes us) skips it — handing a driver
 * cash does not clear the commission he owes on a different job, and netting
 * the two silently is how a statement stops being checkable.
 */
function applyPayment(driverId, amount, opts) {
  const o = opts || {};
  let credit = Math.round(Number(amount) * 100) / 100;
  if (!isFinite(credit) || credit === 0) throw new Error('A payment needs a non-zero amount');
  const db = getDb();
  const jobs = db.prepare(
    `SELECT * FROM bookings
      WHERE driver_id = ? AND passed_at IS NOT NULL AND COALESCE(status,'') <> 'cancelled'
      ORDER BY date, time, id`
  ).all(driverId);
  const stamp = db.prepare('UPDATE bookings SET driver_settled = ? WHERE id = ?');
  const cleared = [];
  for (const b of jobs) {
    const left = outstandingOn(b);
    if (left === 0) continue;
    if ((credit > 0) !== (left > 0)) continue;
    const take = (Math.abs(credit) + 0.0001 >= Math.abs(left)) ? left : credit;
    stamp.run(Math.round((settledOn(b) + take) * 100) / 100, b.id);
    cleared.push({ id: b.id, ref: b.ref, amount: take, whole: take === left });
    credit = Math.round((credit - take) * 100) / 100;
    if (credit === 0) break;
  }
  /* THE AMOUNT PER JOB, not just which ones. Two payments can land on the same
     job — fifty pounds off a ninety-pound job, then the forty — and undoing
     the first must take back fifty, not wipe the job clean and lose the other
     payment with it. */
  const receipt = recordSettlement(driverId, amount, Object.assign({}, o, {
    applied: { jobs: cleared.map((c) => ({ id: c.id, amount: c.amount })), unapplied: credit }
  }));
  return { cleared, unapplied: credit, receipt, balance: driverBalance(driverId) };
}

/**
 * Take a payment back off the jobs it was applied to. The receipt says how
 * much landed on each, so this subtracts rather than clearing — a job that two
 * payments touched keeps the other one.
 */
function unapplyPayment(receipt, driverId) {
  const db = getDb();
  let applied = null;
  try { applied = receipt && receipt.applied_json ? JSON.parse(receipt.applied_json) : null; } catch (_) { applied = null; }
  const jobs = (applied && Array.isArray(applied.jobs)) ? applied.jobs : [];
  let reopened = 0;
  for (const j of jobs) {
    /* Older receipts (and the migration) recorded bare ids. Those were the
       whole of what was on the job, so clearing it is the right reversal. */
    const id = (j && typeof j === 'object') ? j.id : j;
    const amount = (j && typeof j === 'object') ? Number(j.amount) : null;
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND driver_id = ?').get(id, driverId);
    if (!b) continue;
    const left = (amount === null || isNaN(amount))
      ? null
      : Math.round((settledOn(b) - amount) * 100) / 100;
    db.prepare('UPDATE bookings SET driver_settled = ? WHERE id = ?')
      .run((left === null || Math.abs(left) < 0.005) ? null : left, id);
    reopened++;
  }
  return reopened;
}

/* ── THE WEEKLY PAYOUT ─────────────────────────────────────────────────────
   The owner pays his drivers by bank transfer, usually on a Monday. Through
   the week the jobs pile up unpaid; on Monday he wants ONE figure per driver,
   makes one transfer by hand, and ticks the lot off in one action.
   
   WHAT GOES IN THE BATCH is everything still unpaid up to the end of the
   chosen week — not only the jobs dated inside it. A job missed a fortnight
   ago is money he still owes, and a payout that left it behind would be a
   "paid up" driver with a balance that never reaches zero. Anything older than
   the week is counted separately so the screen can say so.
   
   THE TOTAL IS NOT TYPED. It is the sum of what each job is still worth —
   outstandingOn — which is already net of that job's own commission: a cover
   job pays the whole fare because its commission is zero, and a cash job pulls
   the other way because the driver is holding our money. One transfer settles
   both directions, which is exactly what the owner does at the bank.
   GUARDRAIL: server/tests/weekly-payout.test.js */

/** Every unpaid job for this driver up to (and including) `to`, oldest first. */
function unpaidUpTo(driverId, to, opts) {
  const o = opts || {};
  const db = getDb();
  const params = [driverId];
  let where = "driver_id = ? AND passed_at IS NOT NULL AND COALESCE(status,'') <> 'cancelled'";
  if (to) { where += ' AND date <= ?'; params.push(to); }
  const rows = db.prepare(`SELECT * FROM bookings WHERE ${where} ORDER BY date, time, id`).all(...params);

  const items = [];
  let total = 0, carried = 0, carriedTotal = 0;
  for (const b of rows) {
    const left = outstandingOn(b);
    if (left === 0) continue;                 // already settled, in full
    const row = historyRow(b);
    row.outstanding = left;
    /* FROM BEFORE THIS WEEK. Not a different kind of money — it is in the
       total like everything else — but the screen owes him the fact that this
       payout is clearing more than the week he is looking at. */
    row.carried = !!(o.from && String(b.date || '') < o.from);
    if (row.carried) { carried++; carriedTotal = Math.round((carriedTotal + left) * 100) / 100; }
    total = Math.round((total + left) * 100) / 100;
    items.push(row);
  }
  return { items, total, carried, carriedTotal };
}

/**
 * Mark a batch of jobs paid in one act, and keep ONE receipt for the lot.
 *
 * The amount is never passed in: each job is settled for exactly what it was
 * still worth, and the receipt's total is their sum. That is what keeps the
 * batch and the per-job ticks the same fact rather than two — mark a week
 * paid and every one of its jobs reads "Paid", because that is literally what
 * happened to them.
 *
 * Undo is the existing unapplyPayment: the receipt lists the amount that
 * landed on each job, so taking the week back puts exactly those jobs back
 * where they were and leaves any other payment on them alone.
 */
function settleBatch(driverId, jobIds, opts) {
  const o = opts || {};
  const ids = (jobIds || []).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
  if (!ids.length) throw new Error('A payout needs at least one job');
  const db = getDb();
  const get = db.prepare(
    `SELECT * FROM bookings WHERE id = ? AND driver_id = ?
       AND passed_at IS NOT NULL AND COALESCE(status,'') <> 'cancelled'`);
  const stamp = db.prepare("UPDATE bookings SET driver_settled = ?, updated_at = datetime('now') WHERE id = ?");

  const settled = [];
  let total = 0;
  const run = db.transaction(() => {
    for (const id of ids) {
      const b = get.get(id, driverId);
      if (!b) throw new Error('Job ' + id + ' is not one of this driver\'s jobs');
      const left = outstandingOn(b);
      if (left === 0) throw new Error('Job ' + (b.ref || id) + ' has already been paid');
      stamp.run(Math.round((settledOn(b) + left) * 100) / 100, id);
      settled.push({ id: b.id, ref: b.ref, amount: left });
      total = Math.round((total + left) * 100) / 100;
    }
  });
  run();

  const receipt = recordSettlement(driverId, total, Object.assign({}, o, {
    allowZero: true,
    note: o.note || null,
    applied: { jobs: settled.map((j) => ({ id: j.id, amount: j.amount })), unapplied: 0, batch: true }
  }));
  return { settled, total, receipt, balance: driverBalance(driverId) };
}

module.exports = {
  ADMIN_FEE_PCT,
  isCardJob,
  receivedOn,
  manualPayoutOn,
  cardFeeOn,
  unpaidUpTo,
  settleBatch,
  unapplyPayment,
  settledOn,
  outstandingOn,
  isSettled,
  setJobSettled,
  applyPayment,
  computeSplit,
  rateForDriver,
  commissionSql,
  incomeSql,
  receivedSql,
  paysSomebodyOut,
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
