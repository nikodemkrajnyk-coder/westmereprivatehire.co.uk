/**
 * A COMPLETED JOB CANNOT BE CANCELLED — run with:
 *   node server/tests/completed-is-final.test.js   (also gated by `npm test`)
 *
 * THE OWNER'S RULE, in his words: "a job that is COMPLETED in the system (the
 * ones that count toward income / are 'added up') CANNOT be cancelled."
 *
 * WHY IT IS A MONEY RULE, NOT A UI ONE
 *   A completed booking is what the turnover is summed from (driver-ledger's
 *   westmereIncome), what a driver's balance is built on, and what an invoice
 *   may already have billed. Cancelling one does not undo the journey; it
 *   removes the money from every total that has already counted it, silently.
 *   Deleting one is worse — there is no row left to disagree with.
 *
 *   So all four doors are shut: the owner/admin PATCH, the refund-aware cancel
 *   route, the hard delete, and the tokenised link in the customer's inbox,
 *   which lives there for ever and would otherwise strike out a finished
 *   journey a week later. The driver's own cancel already refused.
 *
 * THE WAY BACK IS DELIBERATE, NOT ABSENT. Mark the job not-completed first —
 * a visible act, and then it cancels like anything else. Same shape as a
 * settled job refusing a change of commission.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-final-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const api = require('../api');
const pub = require('../public-api');
const ledger = require('../driver-ledger');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { stripComments: strip } = require('./_source');

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(router, method, routePath, opts) {
  const o = opts || {};
  const l = router.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const handlers = l.route.stack.map((x) => x.handle);
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: o.role || 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of handlers) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced && h !== handlers[handlers.length - 1]) break;
  }
  return r;
}

let seq = 0;
function seed(status, over) {
  const o = Object.assign({ fare: 120, payment: 'card', paid_at: '2026-09-01 10:00' }, over || {});
  const ref = 'WPH-F' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,
                                    passenger_email,passenger_name,pay_token,paid_at)
              VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?)`)
    .run(ref, 'Steyning', 'Gatwick', '2026-09-01', '07:00', o.fare, o.payment, status,
         'ben@example.com', 'Ben Chan', 'tok' + seq, o.paid_at);
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

// ── 1. ALL FOUR DOORS ────────────────────────────────────────────────────
console.log('\nA finished job stays finished');

test('PATCH cannot cancel it', async () => {
  const b = seed('completed');
  const r = await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'cancelled' } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/income/i.test(r.body.error), 'it must say why: ' + r.body.error);
  assert.ok(/not completed first/i.test(r.body.error), 'and how to proceed: ' + r.body.error);
  assert.strictEqual(rowOf(b.id).status, 'completed', 'and the job must be untouched');
});

test('the refund-aware cancel route cannot either', async () => {
  const b = seed('completed');
  const r = await call(api, 'post', '/bookings/:id/cancel', { params: { id: String(b.id) }, body: {} });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'completed');
});

test('it cannot be deleted either — that is cancelling it with no row left', async () => {
  const b = seed('completed');
  const r = await call(api, 'delete', '/bookings/:id', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(rowOf(b.id), 'the booking must still exist');
});

test('nor from the link in the customer’s inbox, a week later', async () => {
  const b = seed('completed');
  const r = await call(pub, 'get', '/cancel/:ref', { params: { ref: b.ref }, query: { t: b.pay_token } });
  assert.strictEqual(r.statusCode, 409, String(r.body).slice(0, 120));
  assert.ok(/already taken place/i.test(String(r.body)), 'it must say so in words a customer reads');
  assert.strictEqual(rowOf(b.id).status, 'completed');
});

test('and the driver cannot cancel one he has finished', () => {
  /* This door was already shut; the guard is here so all four are in one
     place and none can be reopened on its own. */
  const offers = strip(read('server/offer-routes.js'));
  assert.ok(/\['completed', 'cancelled'\]\.includes\(b\.status\)/.test(offers),
    'the driver job cancel no longer refuses a completed job');
});

// ── 2. WHAT IS STILL ALLOWED ─────────────────────────────────────────────
test('a job that is NOT completed cancels exactly as before', async () => {
  for (const status of ['pending', 'confirmed']) {
    const b = seed(status, { payment: 'pending', paid_at: null });
    const r = await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'cancelled' } });
    assert.strictEqual(r.statusCode, 200, status + ': ' + JSON.stringify(r.body));
    assert.strictEqual(rowOf(b.id).status, 'cancelled');
  }
});

test('the way back: mark it not completed, then cancel', async () => {
  /* The rule must not trap him. A job completed by mistake is corrected in two
     deliberate steps rather than one careless one. */
  const b = seed('completed');
  let r = await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'confirmed' } });
  assert.strictEqual(r.statusCode, 200, 'un-completing must be allowed: ' + JSON.stringify(r.body));
  r = await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'cancelled' } });
  assert.strictEqual(r.statusCode, 200, 'and then it cancels: ' + JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'cancelled');
});

// ── 3. WHY IT MATTERS, IN FIGURES ────────────────────────────────────────
test('the money a completed job carries is what the rule protects', async () => {
  /* Not a principle — an amount. A completed £120 job is £120 of turnover;
     cancelling it would have taken that out of a total already reported. */
  const b = seed('completed', { fare: 120 });
  const before = ledger.westmereIncome(rowOf(b.id));
  assert.strictEqual(before, 120, 'a completed job we drove ourselves is worth its fare');
  await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'cancelled' } });
  assert.strictEqual(ledger.westmereIncome(rowOf(b.id)), 120, 'and the refusal keeps it there');
});

// ── 4. THE RULE IS ONE RULE, AND THE APPS READ IT ────────────────────────
// The server refuses; the apps must not offer the button in the first place.
// Both ask the SAME shared module, so there is one definition of "a finished
// job is final" rather than a server rule and two app opinions.
const LC = require('../../wm-lifecycle');

test('the shared lifecycle module refuses cancel and delete on a completed job', () => {
  const done = LC.actionsFor({ status: 'completed', customer_email: 'a@b.com', fare: 120 });
  assert.strictEqual(done.cancel, false, 'a completed job must not offer Cancel');
  assert.strictEqual(done.del, false, 'a completed job must not offer Delete');
  assert.strictEqual(done.unmarkCompleted, true, 'there must be a way back out of a wrong completion');
  assert.strictEqual(LC.canCancel({ status: 'completed' }), false);
  assert.strictEqual(LC.canDelete({ status: 'completed' }), false);

  // …and every other state is untouched: this rule is about completion only.
  for (const st of ['pending', 'offered', 'awaiting_payment', 'confirmed', 'active']) {
    assert.strictEqual(LC.actionsFor({ status: st }).cancel, true, st + ' must still be cancellable');
    assert.strictEqual(LC.actionsFor({ status: st }).del, true, st + ' must still be deletable');
    assert.strictEqual(LC.actionsFor({ status: st }).unmarkCompleted, false,
      st + ' is not completed, so there is nothing to undo');
  }
  const cancelled = LC.actionsFor({ status: 'cancelled' });
  assert.strictEqual(cancelled.cancel, false, 'a cancelled booking cannot be cancelled again');
  assert.strictEqual(cancelled.del, true, 'a cancelled booking is still deleted by hand');
});

test('neither app offers to cancel or delete a completed job', () => {
  const owner = strip(read('westmere-owner.html'));
  const admin = strip(read('westmere-admin.html'));

  // OWNER — the Delete on the job card / trip page is gated, and the page says
  // why when it is not offered.
  assert.ok(/if\(ACT\.del\)\{/.test(owner), 'the owner Delete must be gated on ACT.del');
  assert.ok(/counts towards your income and cannot be cancelled/.test(owner),
    'the owner app must SAY why there is no Cancel, not just hide it');
  assert.ok(/ACT\.unmarkCompleted/.test(owner), 'the owner app must offer the way back');

  // ADMIN — the same, on all three places a Cancel is offered.
  assert.ok(/if\(A\.cancel\)acts\+=/.test(admin),
    "the admin day view's Cancel must be gated on A.cancel, not on A.edit");
  assert.ok(/if\(ACT\.cancel\)\{/.test(admin), "the All Journeys Cancel Trip must be gated on ACT.cancel");
  assert.ok(/A\.cancel\)acts\+='<button class="btn btn-cancel-trip/.test(admin),
    'the trip detail page must gate its Cancel Trip too');
  assert.ok(/counts towards your income and cannot be cancelled/.test(admin),
    'the admin app must SAY why there is no Cancel');
  assert.ok(/admUnmarkCompleted/.test(admin), 'the admin app must offer the way back');

  // Nothing may test "not cancelled" and call that permission to cancel: a
  // COMPLETED job is not cancelled either, which is how this shipped.
  assert.ok(!/if\(!isCancelled\)\{\s*$/m.test(admin),
    'a Cancel gated on "not already cancelled" lets a finished job through');
});

// ── 5. THE WAY BACK ──────────────────────────────────────────────────────
console.log('\nThe one door back out of a wrong completion');

test('POST /bookings/:id/unmark-completed puts it back to confirmed', async () => {
  const b = seed('completed');
  const r = await call(api, 'post', '/bookings/:id/unmark-completed', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'confirmed', 'it must be a live booking again');
  // The money that arrived still arrived — un-settling is a separate act.
  assert.ok(rowOf(b.id).paid_at, 'un-completing must not wipe the payment');
});

test('…and then it cancels like anything else', async () => {
  const b = seed('completed');
  await call(api, 'post', '/bookings/:id/unmark-completed', { params: { id: String(b.id) } });
  const r = await call(api, 'patch', '/bookings/:id', { params: { id: String(b.id) }, body: { status: 'cancelled' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'cancelled');
});

test('it refuses a job that is not completed — it is an undo, not a status picker', async () => {
  const b = seed('confirmed');
  const r = await call(api, 'post', '/bookings/:id/unmark-completed', { params: { id: String(b.id) } });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'confirmed');
});

test('a driver cannot un-complete a job — only the owner or admin', async () => {
  const b = seed('completed');
  const r = await call(api, 'post', '/bookings/:id/unmark-completed',
    { params: { id: String(b.id) }, role: 'driver' });
  assert.strictEqual(r.statusCode, 403, JSON.stringify(r.body));
  assert.strictEqual(rowOf(b.id).status, 'completed');
});

test('neither app PATCHes status:confirmed to do it — that invariant still holds', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    const code = strip(read(f));
    assert.ok(!/JSON\.stringify\(\{\s*status:\s*'confirmed'\s*\}\)/.test(code),
      f + ' must reach the un-complete ROUTE, not PATCH a booking to confirmed');
    assert.ok(/\/unmark-completed/.test(code), f + ' must call the un-complete route');
  }
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('completed-is-final.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
