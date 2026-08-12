/**
 * ADMIN ↔ OWNER lifecycle parity guardrail — run with:
 *   node server/tests/admin-parity.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The owner app (westmere-owner.html) carries the "estimate-first" booking
 *   lifecycle that came out of the "Mr Ben" incident. The admin app
 *   (westmere-admin.html) had drifted: it still had a one-click "Confirm" that
 *   PATCHed status:'confirmed' straight from a new request, its own payment
 *   badge that called an unchosen method "Pending", a manual booking form that
 *   defaulted every booking to payment='cash', and long raw addresses.
 *
 *   Both apps now delegate to the shared module /wm-lifecycle.js. These tests
 *   assert that they STAY delegated — so admin can never quietly re-grow its
 *   own lifecycle. The owner's rule: "always check a new update fits the logic
 *   before it's applied."
 *
 * Pure static + module checks. No DB, no network. Exit 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'); }

const LC = require('../../wm-lifecycle');
const ADMIN = read('westmere-admin.html');
const OWNER = read('westmere-owner.html');

// ── 1. The shared module is the single source of truth ────────────────────
console.log('\nShared lifecycle module is wired into BOTH staff apps');
test('both apps load /wm-lifecycle.js', () => {
  assert.ok(/<script src="\/wm-lifecycle\.js"><\/script>/.test(OWNER), 'owner app must load the shared lifecycle module');
  assert.ok(/<script src="\/wm-lifecycle\.js"><\/script>/.test(ADMIN), 'admin app must load the shared lifecycle module');
});
test('both apps take the STATUS badge from the shared module', () => {
  assert.ok(/WMLifecycle\.statusLabel\(/.test(OWNER), 'owner must use WMLifecycle.statusLabel');
  assert.ok(/WMLifecycle\.statusLabel\(/.test(ADMIN), 'admin must use WMLifecycle.statusLabel');
});
test('both apps take the PAYMENT badge from the shared module', () => {
  assert.ok(/WMLifecycle\.payStatus\(/.test(OWNER), 'owner must use WMLifecycle.payStatus');
  assert.ok(/WMLifecycle\.payStatus\(/.test(ADMIN), 'admin must use WMLifecycle.payStatus');
});
test('both apps gate their ACTIONS on the shared actionsFor()', () => {
  assert.ok(/WMLifecycle\.actionsFor\(/.test(OWNER), 'owner must gate actions on WMLifecycle.actionsFor');
  assert.ok(/WMLifecycle\.actionsFor\(/.test(ADMIN), 'admin must gate actions on WMLifecycle.actionsFor');
});
test('both apps take luggage + weekly grouping from the shared module', () => {
  assert.ok(/WMLifecycle\.bagsText\(/.test(OWNER) && /WMLifecycle\.bagsText\(/.test(ADMIN), 'both apps must use the shared bagsText');
  assert.ok(/WMLifecycle\.groupByWeek\(/.test(OWNER) && /WMLifecycle\.groupByWeek\(/.test(ADMIN), 'both apps must group Completed by the shared ISO week');
});

// ── 2. NO staff path may auto-confirm ─────────────────────────────────────
console.log('\nNo auto-confirm anywhere in either staff app');
test('the shared module offers no "confirm" action at all', () => {
  const keys = Object.keys(LC.actionsFor({ status: 'pending' }));
  assert.ok(!keys.includes('confirm'), 'actionsFor must never expose a one-click confirm');
  // Every status: still no confirm.
  LC.STATUSES.forEach((st) => {
    assert.ok(!Object.keys(LC.actionsFor({ status: st })).includes('confirm'),
      'no status may expose a confirm action (' + st + ')');
  });
});
test('the dead one-click confirmJob() must not come back', () => {
  assert.ok(!/function\s+confirmJob\b/.test(ADMIN), 'admin confirmJob() must stay removed — it auto-confirmed a new request');
  assert.ok(!/onclick="confirmJob\(/.test(ADMIN), 'no admin button may call confirmJob()');
});
test('no admin path PATCHes a booking to status:confirmed', () => {
  // Strip comments so the explanatory note about the removed function does not
  // register as a real call site.
  const code = ADMIN.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/JSON\.stringify\(\{[^}]*status\s*:\s*['"]confirmed['"]/.test(code),
    'admin must never PATCH status:confirmed — the customer (or a real cash settlement) confirms');
  assert.ok(!/body\.status\s*=\s*['"]confirmed['"]/.test(code), 'admin must not build a confirmed status body');
});
test('no owner path PATCHes a booking to status:confirmed either', () => {
  const code = OWNER.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/JSON\.stringify\(\{[^}]*status\s*:\s*['"]confirmed['"]/.test(code),
    'owner must never PATCH status:confirmed');
});

// ── 3. Send Estimate: same route, and it leaves the booking pending ───────
console.log('\nAdmin Send Estimate behaves exactly like owner Send Estimate');
test('admin Send Estimate posts the SHARED /send-estimate route', () => {
  const fn = ADMIN.match(/async function admSendEstimate[\s\S]*?\n\}/);
  assert.ok(fn, 'admSendEstimate not found');
  assert.ok(/\/api\/bookings\/'\+bookingId\+'\/send-estimate/.test(fn[0]),
    'admin must call the shared send-estimate route, not its own confirm flow');
});
test('admin Send Estimate never changes status (booking stays pending)', () => {
  const fn = ADMIN.match(/async function admSendEstimate[\s\S]*?\n\}/)[0];
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn), 'Send Estimate must never confirm');
  assert.ok(/[Pp]ending/.test(fn), 'the confirmation must tell the operator the booking is now Pending');
});
test('admin Send Estimate shows the recipient address, like owner', () => {
  const a = ADMIN.match(/async function admSendEstimate[\s\S]*?\n\}/)[0];
  const o = OWNER.match(/async function ownerSendEstimate[\s\S]*?\n\}/)[0];
  [['admin', a], ['owner', o]].forEach(([who, fn]) => {
    assert.ok(/d\.sent_to/.test(fn) && /emailed to/i.test(fn),
      who + ' Send Estimate must name the address it emailed, so a typo is caught');
  });
});

// ── 4. Mark as Paid: the ONE staff action that confirms ───────────────────
console.log('\nAdmin "Mark as Paid" settles cash the same way owner does');
test('admin Mark as Paid posts the shared /mark-paid route and does not PATCH', () => {
  const fn = ADMIN.match(/async function admMarkPaid[\s\S]*?\n\}/);
  assert.ok(fn, 'admMarkPaid not found — admin has no way to settle a cash booking');
  assert.ok(/\/mark-paid/.test(fn[0]), 'admMarkPaid must POST to the shared /mark-paid route');
  assert.ok(!/status['"]?\s*:\s*['"]confirmed['"]/.test(fn[0]),
    'admMarkPaid must NOT set the status itself — the shared route does the awaiting_payment → confirmed promotion');
});
test('Mark as Paid is offered on awaiting_payment ONLY, in both apps', () => {
  assert.strictEqual(LC.actionsFor({ status: 'awaiting_payment' }).markPaid, true,
    'an awaiting-payment booking must offer Mark as Paid');
  ['pending', 'offered', 'confirmed', 'completed', 'cancelled'].forEach((st) => {
    assert.strictEqual(LC.actionsFor({ status: st }).markPaid, false,
      st + ' must NOT offer Mark as Paid');
  });
  assert.ok(/ACT\.markPaid/.test(OWNER) && /A\.markPaid|ACT\.markPaid/.test(ADMIN),
    'both apps must gate the button on the shared rule');
});
test('the shared /mark-paid route promotes awaiting_payment → confirmed', () => {
  const api = read('server/api.js');
  const m = api.match(/router\.post\('\/bookings\/:id\/mark-paid'[\s\S]*?\n\}\);/);
  assert.ok(m, 'mark-paid route not found');
  assert.ok(/awaiting_payment/.test(m[0]) && /'confirmed'/.test(m[0]),
    'mark-paid must promote an awaiting_payment booking to confirmed');
  assert.ok(/\['admin', 'owner', 'driver'\]/.test(m[0]),
    'the admin role must be allowed to settle a payment (shared route, not a fork)');
});

// ── 5. Send Reminder for card abandoners ──────────────────────────────────
console.log('\nAdmin can chase an unpaid booking, like owner');
test('admin has a Send Reminder wired to the shared /payment-reminder route', () => {
  const fn = ADMIN.match(/async function admSendPayReminder[\s\S]*?\n\}/);
  assert.ok(fn, 'admSendPayReminder not found');
  assert.ok(/\/payment-reminder/.test(fn[0]), 'must post to the shared payment-reminder route');
});
test('the reminder rule is identical in both apps (unpaid + email + fare)', () => {
  const chased = { status: 'awaiting_payment', fare: 50, customer_email: 'a@b.com' };
  assert.strictEqual(LC.actionsFor(chased).sendReminder, true, 'an unpaid card abandoner is chaseable');
  assert.strictEqual(LC.actionsFor({ status: 'awaiting_payment', fare: 50, customer_email: 'a@b.com', paid_at: '2026-01-01' }).sendReminder, false,
    'an already-paid booking must not be chased');
  assert.strictEqual(LC.actionsFor({ status: 'awaiting_payment', fare: 50 }).sendReminder, false,
    'a booking with no email cannot be chased');
  assert.strictEqual(LC.actionsFor({ status: 'pending', fare: 50, customer_email: 'a@b.com' }).sendReminder, false,
    'a brand-new request has chosen nothing yet — nothing to chase');
});

// ── 6. Payment is NEVER silently defaulted to cash ────────────────────────
console.log('\nPayment method is never silently defaulted to cash');
test('the shared module never falls back to cash', () => {
  assert.strictEqual(LC.paymentOf({}), 'pending', 'a blank method is "pending", never "cash"');
  assert.strictEqual(LC.paymentOf({ payment: 'nonsense' }), 'pending', 'an unknown method is "pending", never "cash"');
  assert.strictEqual(LC.paymentOf({ payment: 'cash' }), 'cash', 'a real cash choice is preserved');
});
test('neither staff app contains a `|| \'cash\'` style default', () => {
  [['admin', ADMIN], ['owner', OWNER]].forEach(([who, src]) => {
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\|\|\s*'cash'/.test(code), who + " must not default any value to 'cash'");
  });
});
test('the admin manual-booking form cannot record a card/cash choice for the customer', () => {
  const sel = ADMIN.match(/<select class="fi" id="nb-pay">[\s\S]*?<\/select>/);
  assert.ok(sel, 'admin payment select not found');
  assert.ok(/value="pending"[^>]*selected/.test(sel[0]), 'a new manual booking must default to "not chosen yet"');
  assert.ok(!/value="cash"/.test(sel[0]), 'staff must not be able to record the customer\'s cash choice');
  assert.ok(!/value="card"/.test(sel[0]), 'staff must not be able to record the customer\'s card choice');
});
test('the assistant prefill does not fall back to cash', () => {
  const m = ADMIN.match(/if\(b\.payment\)\{[\s\S]*?\n  \}/);
  assert.ok(m, 'assistant payment prefill not found');
  assert.ok(!/pay\.value\s*=\s*'cash'/.test(m[0]), 'the prefill must never select cash as a fallback');
});

// ── 7. Manual booking parity with the web form ────────────────────────────
console.log('\nAdmin manual booking matches the web-booking logic');
test('admin manual booking REQUIRES and validates an email', () => {
  const fn = ADMIN.match(/async function submitBooking[\s\S]*?\n\}/);
  assert.ok(fn, 'submitBooking not found');
  assert.ok(/if\(!email\)/.test(fn[0]), 'a blank email must be rejected — Send Estimate needs a recipient');
  assert.ok(/\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+/.test(fn[0]), 'the email must be format-validated, like the web form');
});
test('admin manual booking sends passenger name, flight and luggage', () => {
  const fn = ADMIN.match(/async function submitBooking[\s\S]*?\n\}/)[0];
  assert.ok(/passenger_name:name/.test(fn), 'passenger name must flow through to the emails');
  assert.ok(/passenger_email:email/.test(fn), 'passenger email must be sent (not null)');
  assert.ok(/flight:/.test(fn), 'the flight number must be captured, like the web form');
  assert.ok(/bags:/.test(fn), 'luggage must be captured');
  assert.ok(/id="nb-flight"/.test(ADMIN), 'the form needs a flight field');
});
test('admin manual booking does not send a status (server default = pending)', () => {
  const fn = ADMIN.match(/async function submitBooking[\s\S]*?\n\}/)[0];
  assert.ok(!/status\s*:/.test(fn), 'manual creation must not set a status — the server defaults to pending');
  assert.ok(!/Booking confirmed/.test(fn), 'the toast must not claim the booking is confirmed — it is Pending');
});

// ── 8. Status ladder: New request → Pending → Awaiting payment → Confirmed ─
console.log('\nStatus lifecycle labels are shared and correct');
test('a brand-new request reads "New request", not "Awaiting" anything', () => {
  assert.strictEqual(LC.statusLabel({ status: 'pending' }).label, 'New request');
  assert.strictEqual(LC.payStatus({ status: 'pending' }).short, '—',
    'a new request must show no payment badge — nothing is awaiting yet');
});
test('once the estimate is sent the request reads "Pending · estimate sent"', () => {
  assert.strictEqual(LC.statusLabel({ status: 'pending', estimate_sent_at: '2026-08-12' }).label, 'Pending · estimate sent');
  assert.strictEqual(LC.payStatus({ status: 'pending', estimate_sent_at: '2026-08-12' }).short, '—',
    'an estimate-sent booking still has no chosen method — still no "Awaiting"');
});
test('"Awaiting payment" appears ONLY after the customer chooses a method', () => {
  assert.strictEqual(LC.statusLabel({ status: 'awaiting_payment' }).label, 'Awaiting payment');
  assert.strictEqual(LC.payStatus({ status: 'awaiting_payment' }).short, 'Awaiting');
  assert.strictEqual(LC.payStatus({ status: 'awaiting_payment', payment: 'cash' }).short, 'Cash',
    'a cash choice reads "Cash", not "Awaiting"');
});
test('a CANCELLED booking never reads "Awaiting payment"', () => {
  // Caught live in the admin journeys table: a booking cancelled before the
  // customer chose a method fell through to the "await" branch and showed an
  // amber "Awaiting" badge on a dead booking.
  assert.strictEqual(LC.payStatus({ status: 'cancelled', payment: 'pending' }).short, '—',
    'a cancelled booking with no chosen method must read neutral, not "Awaiting"');
  assert.strictEqual(LC.statusLabel({ status: 'cancelled' }).label, 'Cancelled');
  // A cancelled booking that WAS genuinely paid still shows the real state.
  assert.strictEqual(LC.payStatus({ status: 'cancelled', paid_at: '2026-01-01' }).short, 'Prepaid ✓',
    'a cancelled-but-paid booking must still show it was paid (refund flows depend on this)');
});
test('Mark Completed is offered on confirmed/active in both apps', () => {
  assert.strictEqual(LC.actionsFor({ status: 'confirmed' }).markCompleted, true);
  assert.strictEqual(LC.actionsFor({ status: 'active' }).markCompleted, true);
  assert.strictEqual(LC.actionsFor({ status: 'pending' }).markCompleted, false);
  assert.ok(/ACT\.markCompleted/.test(OWNER), 'owner must gate Mark Completed on the shared rule');
  assert.ok(/ACT\.markCompleted|A\.markCompleted/.test(ADMIN), 'admin must offer Mark Completed too');
});
test('a paid booking reads Confirmed + Prepaid', () => {
  assert.strictEqual(LC.statusLabel({ status: 'confirmed' }).label, 'Confirmed');
  assert.strictEqual(LC.payStatus({ status: 'confirmed', paid_at: '2026-01-01' }).short, 'Prepaid ✓');
});
test('the module ladder matches the DB CHECK constraint', () => {
  const db = read('server/db.js');
  LC.STATUSES.forEach((st) => {
    assert.ok(new RegExp("'" + st + "'").test(db), 'status ' + st + ' must exist in the DB schema');
  });
});
test('admin renders the shared status label, not the raw DB value', () => {
  assert.ok(/function admStatusTag\(b\)\{[\s\S]*?WMLifecycle\.statusLabel/.test(ADMIN),
    'admStatusTag must delegate to the shared module');
  const code = ADMIN.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/b\.status\.charAt\(0\)\.toUpperCase\(\)/.test(code),
    'admin must not title-case the raw status (that rendered "Awaiting_payment")');
});

// ── 9. "To Confirm" count badge ───────────────────────────────────────────
console.log('\n"To Confirm" badge counts awaiting-payment bookings in both apps');
test('both apps count the badge with the shared toConfirmCount()', () => {
  assert.ok(/WMLifecycle\.toConfirmCount\(/.test(OWNER), 'owner badge must use the shared counter');
  assert.ok(/WMLifecycle\.toConfirmCount\(/.test(ADMIN), 'admin badge must use the shared counter');
  assert.ok(/id="sb-toconfirm-badge"/.test(ADMIN), 'admin needs a To Confirm badge element');
});
test('the counter counts awaiting_payment ONLY, and hides at zero', () => {
  assert.strictEqual(LC.toConfirmCount([{ status: 'awaiting_payment' }, { status: 'pending' }, { status: 'awaiting_payment' }]), 2);
  assert.strictEqual(LC.toConfirmCount([{ status: 'pending' }, { status: 'confirmed' }]), 0,
    'new requests and confirmed jobs are not "to confirm"');
  assert.strictEqual(LC.toConfirmCount([]), 0);
});

// ── 10. Short addresses + passenger/luggage counts in admin ───────────────
console.log('\nAdmin shows short addresses, passengers and luggage');
test('admin renders addresses through the shared WMAddr normalizer', () => {
  assert.ok(/function _admShortAddr\(a\)\{ return window\.WMAddr \? WMAddr\.shortDisplay\(a\)/.test(ADMIN),
    'admin must delegate address display to the shared normalizer');
  // The journeys table, the timelines and the detail panel must all shorten.
  assert.ok(/_admShortAddr\(b\.pickup\)/.test(ADMIN), 'the journeys table must shorten the pickup');
  assert.ok(/_admShortAddr\(b\.destination\)/.test(ADMIN), 'the journeys table must shorten the destination');
  const detail = ADMIN.match(/function bookingDetailHtml[\s\S]*?\n\}/);
  assert.ok(detail && /_admShortAddr\(b\.pickup\)/.test(detail[0]) && /_admShortAddr\(b\.destination\)/.test(detail[0]),
    'the booking detail panel must shorten From/To');
});
test('admin no longer prints raw long addresses in the journeys table', () => {
  const code = ADMIN.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/<div class="main-v">'\+b\.pickup\+'<\/div>/.test(code),
    'the raw pickup must not be rendered — it produced "Bolney, West Sussex, England…"');
  assert.ok(!/<div class="main-v">'\+b\.destination\+'<\/div>/.test(code), 'the raw destination must not be rendered');
});
test('admin shows passengers + luggage on the card and in the detail', () => {
  assert.ok(/_admBags\(/.test(ADMIN), 'admin must render a luggage label');
  assert.ok(/pax/.test(ADMIN), 'admin must render a passenger count');
  const detail = ADMIN.match(/function bookingDetailHtml[\s\S]*?\n\}/)[0];
  assert.ok(/Passengers/.test(detail) && /_admBags\(b\.bags\)/.test(detail),
    'the detail panel must show passengers and the luggage label');
});
test('the luggage rule is shared and identical', () => {
  assert.strictEqual(LC.bagsText('3'), '3 bags');
  assert.strictEqual(LC.bagsText('1'), '1 bag');
  assert.strictEqual(LC.bagsText('0'), '', 'no luggage renders empty');
  assert.strictEqual(LC.bagsText('0s+0l'), '', 'the empty compound form renders empty');
});

// ── 11. Completed (weekly + takings) and Cancelled (manual delete) views ──
console.log('\nAdmin has the weekly Completed ledger and the Cancelled record');
test('admin has a Completed view grouped by week with takings', () => {
  const fn = ADMIN.match(/function buildAdmCompleted[\s\S]*?\n\}/);
  assert.ok(fn, 'buildAdmCompleted not found');
  assert.ok(/WMLifecycle\.groupByWeek\(/.test(fn[0]), 'Completed must group by the shared ISO week');
  assert.ok(/g\.takings/.test(fn[0]), "each week must show that week's takings");
  assert.ok(/id="adm-completed-list"/.test(ADMIN), 'the Completed view needs its list container');
});
test('admin has a Cancelled view with a manual Delete', () => {
  const fn = ADMIN.match(/function buildAdmCancelled[\s\S]*?\n\}/);
  assert.ok(fn, 'buildAdmCancelled not found');
  assert.ok(/'cancelled'/.test(fn[0]), 'the Cancelled view must select cancelled bookings');
  assert.ok(/id="adm-cancelled-list"/.test(ADMIN), 'the Cancelled view needs its list container');
  const del = ADMIN.match(/async function admDeleteBooking[\s\S]*?\n\}/);
  assert.ok(del && /method:'DELETE'/.test(del[0]), 'Delete must hard-remove via the shared DELETE route');
});
test('a cancelled booking offers no Edit and no Message, in both apps', () => {
  const a = LC.actionsFor({ status: 'cancelled', customer_email: 'a@b.com' });
  assert.strictEqual(a.edit, false, 'a cancelled booking is a record — not editable');
  assert.strictEqual(a.message, false, 'a cancelled booking must not offer Send Message');
  assert.strictEqual(a.del, true, 'a cancelled booking can be deleted by hand');
});

// ── 12. Admin keeps its own tools (nothing was removed) ───────────────────
console.log('\nAdmin-only tooling is still intact');
test('driver dispatch / offers, driver management and invoices admin survive', () => {
  [
    ['openReassign', 'driver re-assignment'],
    ['reclaimOffer', 'offer reclaim'],
    ['rsAssign', 'dispatch assign'],
    ['saveDriver', 'driver management'],
    ['revokeDriverLogin', 'driver login control'],
    ['createInvoiceNew', 'invoice creation'],
    ['sendInvoice', 'invoice sending'],
    ['loadAnalytics', 'reports/analytics'],
    ['buildRecordBook', 'record book'],
    ['refundTrip', 'refunds'],
    ['cancelTrip', 'cancel-with-refund flow']
  ].forEach(([fn, what]) => {
    assert.ok(new RegExp('function\\s+' + fn + '\\b').test(ADMIN), 'admin must keep ' + what + ' (' + fn + ')');
  });
});
test('admin keeps a Message Customer action (shared with owner)', () => {
  assert.ok(/function wmMessageOpen/.test(ADMIN) && /function wmMessageOpen/.test(OWNER),
    'both apps must offer Send Message to the customer');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
