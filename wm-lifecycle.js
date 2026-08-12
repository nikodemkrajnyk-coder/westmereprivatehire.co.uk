// ── Booking lifecycle — SINGLE SOURCE OF TRUTH ───────────────────────────
// The status ladder, the payment badge, the luggage label and — most
// importantly — WHICH ACTIONS A STAFF APP MAY OFFER on a given booking.
//
// WHY THIS EXISTS (root cause + regression history):
//   The owner app (westmere-owner.html) grew an "estimate-first" lifecycle
//   after the "Mr Ben" incident: a card choice recorded as cash, dead payment
//   links in the estimate email, and "Send Estimate" silently auto-confirming
//   the booking. The admin app (westmere-admin.html) kept its ORIGINAL
//   one-click "Confirm" button, its own payment badge, and its own manual
//   booking form — so the two staff apps disagreed about what a booking's
//   state meant and what staff were allowed to do to it.
//
//   Copying the owner's logic into admin would have re-created exactly the
//   divergence that address-normalize.js was written to kill (~6 ad-hoc copies
//   of the address shortener). So the lifecycle lives HERE, once, and BOTH
//   staff apps delegate to it. If a rule changes, it changes in one file and
//   both apps move together.
//
// THE INVARIANTS THIS MODULE ENFORCES (see CLAUDE.md "Payment invariants"):
//   1. `payment` is never silently defaulted. There is no "cash" fallback
//      anywhere in here; an unknown method reads as `pending`.
//   2. No staff app may offer a one-click "Confirm". A booking becomes
//      confirmed ONLY when the CUSTOMER acts (card paid via the Stripe
//      webhook, or "pay your driver" chosen) — or when staff settle a real
//      cash payment via `markPaid`, which is the single deliberate exception.
//   3. "Awaiting payment" is shown ONLY once the customer has actually chosen
//      a method. A brand-new request is NOT "awaiting payment".
//
// Exposed as `module.exports` (server/tests: require('../wm-lifecycle')) AND
// as the browser global `window.WMLifecycle`
// (apps: <script src="/wm-lifecycle.js">).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WMLifecycle = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // The full status ladder, in lifecycle order. Mirrors the bookings CHECK
  // constraint in server/db.js — keep the two in step.
  var STATUSES = ['pending', 'offered', 'awaiting_payment', 'confirmed', 'active', 'completed', 'cancelled'];

  // Valid payment methods. Mirrors server/payment-methods.js. `pending` means
  // NO CHOICE YET and is the only default — never 'cash'.
  var PAYMENT_METHODS = ['pending', 'card', 'cash', 'account', 'invoice'];

  // Read the status off either shape: the owner app maps it to `apiStatus`,
  // the admin app reads raw `/api/bookings` rows with `status`.
  function statusOf(j) {
    if (!j) return '';
    return String(j.apiStatus || j.status || '');
  }

  function paymentOf(j) {
    if (!j) return 'pending';
    var p = String(j.payment || '').toLowerCase();
    // NEVER default to cash. An unrecognised/blank method is "no choice yet".
    return PAYMENT_METHODS.indexOf(p) === -1 ? 'pending' : p;
  }

  // ── Status badge ────────────────────────────────────────────────────────
  // `pending` splits in two for the operator: a brand-new request that still
  // needs a price, versus one where the estimate has gone out and we are
  // waiting on the customer.
  function statusLabel(j) {
    var st = statusOf(j);
    if (st === 'pending') {
      if (j && j.estimate_sent_at) {
        return { key: 'pending_sent', label: 'Pending · estimate sent', cls: 'tag-await', color: '#9C5800', bg: 'rgba(156,88,0,.10)' };
      }
      return { key: 'new', label: 'New request', cls: 'tag-new', color: '#555555', bg: 'rgba(106,106,106,.12)' };
    }
    if (st === 'offered') return { key: 'offered', label: 'Awaiting driver', cls: 'tag-upcoming', color: '#2A3A66', bg: 'rgba(42,58,102,.07)' };
    if (st === 'awaiting_payment') return { key: 'awaiting_payment', label: 'Awaiting payment', cls: 'tag-await', color: '#9C5800', bg: 'rgba(156,88,0,.12)' };
    if (st === 'cancelled') return { key: 'cancelled', label: 'Cancelled', cls: 'tag-cancel', color: '#8B2222', bg: 'rgba(139,34,34,.10)' };
    if (st === 'active') return { key: 'active', label: 'Active', cls: 'tag-upcoming', color: '#2D6E47', bg: 'rgba(45,110,71,.1)' };
    if (st === 'completed') return { key: 'completed', label: 'Completed', cls: 'tag-done', color: '#2D6E47', bg: 'rgba(45,110,71,.12)' };
    return { key: 'confirmed', label: 'Confirmed', cls: 'tag-upcoming', color: '#2D6E47', bg: 'rgba(45,110,71,.08)' };
  }

  // ── Payment badge ───────────────────────────────────────────────────────
  // Owner spec (from a real screenshot bug): a brand-new booking must NOT read
  // "Awaiting" — nobody is awaiting anything until the customer picks a method.
  // Those show a neutral "—"; the STATUS badge carries the real state.
  function payStatus(j) {
    if (j && (j.paid_at || paymentOf(j) === 'card')) {
      return { key: 'prepaid', label: 'Prepaid', short: 'Prepaid ✓', cls: 'tag-prepaid', color: '#2D6E47', bg: 'rgba(45,110,71,.12)' };
    }
    var p = paymentOf(j);
    if (p === 'cash') return { key: 'cash', label: 'Cash', short: 'Cash', cls: 'tag-cash', color: '#555555', bg: 'rgba(106,106,106,.16)' };
    if (p === 'account' || p === 'invoice') return { key: 'account', label: 'Account', short: 'Account', cls: 'tag-account', color: '#3A5A8C', bg: 'rgba(58,90,140,.12)' };
    var st = statusOf(j);
    // Nothing is "awaiting" on a booking where no method was ever chosen: a new
    // request, one that only got an estimate, or one that was cancelled before
    // the customer decided. Those read neutral — the STATUS badge carries the
    // real state.
    if (st === 'pending' || st === 'offered' || st === 'cancelled' || st === '') {
      return { key: 'none', label: 'No payment chosen yet', short: '—', cls: 'tag-none', color: 'rgba(27,27,26,.4)', bg: 'rgba(27,27,26,.05)' };
    }
    return { key: 'await', label: 'Awaiting payment', short: 'Awaiting', cls: 'tag-await', color: '#9C5800', bg: 'rgba(156,88,0,.12)' };
  }

  // ── Luggage ─────────────────────────────────────────────────────────────
  // '', '0' and the '0s+0l' shape all mean "no bags" and render as nothing.
  function bagsText(bags) {
    var b = (bags == null ? '' : String(bags)).trim();
    if (!b || b === '0' || b === '0s+0l') return '';
    return b + ' bag' + (b === '1' ? '' : 's');
  }

  // ── Which actions a staff app may offer ─────────────────────────────────
  // The ONE place that decides what staff can do to a booking. Deliberately
  // has no `confirm` key: there is no one-click confirm in any staff app.
  //   • sendEstimate  — pending only; sets the fare + emails the customer.
  //                     NEVER changes status (estimate-first).
  //   • markPaid      — the customer chose a method and we took the money
  //                     (cash on the day). awaiting_payment → confirmed. This
  //                     is the only staff action that confirms, and it is a
  //                     deliberate, explicit settlement.
  //   • sendReminder  — an unpaid booking with an email and a fare (e.g. a
  //                     card customer who abandoned checkout).
  //   • markCompleted / togglePaid / invoice / message / edit / del — as owner.
  function actionsFor(j) {
    var st = statusOf(j);
    var isPaid = !!(j && j.paid_at);
    var hasEmail = !!(j && (j.email || j.customer_email || j.passenger_email));
    var hasFare = !!(j && Number(j.fare) > 0);
    var live = st !== 'cancelled';
    return {
      sendEstimate: st === 'pending',
      markPaid: st === 'awaiting_payment',
      markCompleted: st === 'confirmed' || st === 'active',
      togglePaid: st === 'confirmed' || st === 'active' || st === 'completed',
      sendReminder: !isPaid && hasEmail && hasFare &&
        (st === 'completed' || st === 'confirmed' || st === 'awaiting_payment'),
      invoice: (st === 'confirmed' || st === 'active' || st === 'completed') && hasFare,
      message: hasEmail && live,
      edit: live,
      del: true
    };
  }

  // Count of bookings the operator still has to settle — the "To Confirm"
  // badge in both staff apps. Awaiting-payment only: a new request is not
  // "to confirm", it is "to price".
  function toConfirmCount(list) {
    if (!list || !list.length) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) if (statusOf(list[i]) === 'awaiting_payment') n++;
    return n;
  }

  function isAwaitingPayment(j) { return statusOf(j) === 'awaiting_payment'; }

  // ── Weekly grouping (the "Completed" view in both staff apps) ────────────
  // Finished jobs read as a weekly ledger, not a flat list: each week carries
  // its own takings total so the operator can see what a week actually earned.
  function isoWeekStart(d) {
    var x = new Date(d);
    var day = (x.getDay() + 6) % 7;          // Monday = 0
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function weekRangeLabel(start) {
    var end = new Date(start); end.setDate(end.getDate() + 6);
    var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function f(d, withYear) { return wd[d.getDay()] + ' ' + d.getDate() + ' ' + mo[d.getMonth()] + (withYear ? ' ' + d.getFullYear() : ''); }
    return f(start, false) + ' – ' + f(end, true);
  }

  function _dk(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // → [{ key, start, label, items, takings }], newest week first. Undated jobs
  // collect in a trailing "Undated" bucket rather than being dropped.
  function groupByWeek(list) {
    var groups = {};
    (list || []).forEach(function (j) {
      var key = '0000-00-00', start = null;
      if (j && j.date) {
        var p = String(j.date).split('-');
        var d = new Date(+p[0], (+p[1]) - 1, +p[2]);
        if (!isNaN(d.getTime())) { start = isoWeekStart(d); key = _dk(start.getFullYear(), start.getMonth(), start.getDate()); }
      }
      if (!groups[key]) groups[key] = { key: key, start: start, items: [] };
      groups[key].items.push(j);
    });
    return Object.keys(groups).sort().reverse().map(function (k) {
      var g = groups[k];
      g.items.sort(function (a, b) {
        var dc = String(a.date || '').localeCompare(String(b.date || ''));
        if (dc !== 0) return -dc;                                   // later date first
        return String(b.time || '').localeCompare(String(a.time || ''));
      });
      g.label = g.start ? weekRangeLabel(g.start) : 'Undated';
      g.takings = g.items.reduce(function (s, j) { return s + (Number(j.fare) || 0); }, 0);
      return g;
    });
  }

  return {
    STATUSES: STATUSES,
    PAYMENT_METHODS: PAYMENT_METHODS,
    statusOf: statusOf,
    paymentOf: paymentOf,
    statusLabel: statusLabel,
    payStatus: payStatus,
    bagsText: bagsText,
    actionsFor: actionsFor,
    toConfirmCount: toConfirmCount,
    isAwaitingPayment: isAwaitingPayment,
    isoWeekStart: isoWeekStart,
    weekRangeLabel: weekRangeLabel,
    groupByWeek: groupByWeek,
    _spec: 'estimate-first; no staff auto-confirm; payment never defaults to cash'
  };
}));
