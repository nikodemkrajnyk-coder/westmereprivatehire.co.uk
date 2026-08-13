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
  // A bag count is ALWAYS a whole number. `bags` is a TEXT column that has
  // collected five different shapes over the life of the app, and rendering it
  // raw is what produced "0.0 bags" on old records and "small bags" / nothing
  // at all on others:
  //   ''  null                  → 0        (never recorded)
  //   '0' '3' 3                 → 0, 3     (owner app + web form)
  //   '0.0' '2.0' 2.0           → 0, 2     (rows migrated from the old
  //                                         INTEGER/REAL bags column — the
  //                                         source of the "0.0 bags" report)
  //   '4+'                      → 4+       (the web form's top option; the
  //                                         "+" is kept, it is not a decimal)
  //   '2s+1l'                   → 3        (rider app: small + large picker)
  //   'small' 'medium' 'large'  → 2, 4, 6  (legacy admin form, matching the
  //                                         capacity guard's own mapping)
  // Anything else falls back to the sum of the integers in the string, so a
  // free-typed "3 large + 2 carry-on" reads as 5 rather than as itself.
  var _WORD_BAGS = { none: 0, small: 2, medium: 4, large: 6 };

  // → { n: <integer>, plus: <bool> }. Never fractional, never negative.
  function bagsCount(bags) {
    var b = (bags == null ? '' : String(bags)).trim().toLowerCase();
    if (!b) return { n: 0, plus: false };
    if (_WORD_BAGS.hasOwnProperty(b)) return { n: _WORD_BAGS[b], plus: false };
    if (/^no\b/.test(b)) return { n: 0, plus: false };
    var compound = b.match(/^(\d+)\s*s\s*\+\s*(\d+)\s*l$/);            // '2s+1l'
    if (compound) return { n: Math.round(+compound[1]) + Math.round(+compound[2]), plus: false };
    var plus = /\+\s*$/.test(b);
    var nums = b.match(/\d+(?:\.\d+)?/g);
    if (!nums) return { n: 0, plus: false };
    var total = nums.reduce(function (s, v) { return s + (parseFloat(v) || 0); }, 0);
    return { n: Math.max(0, Math.round(total)), plus: plus };
  }

  // ALWAYS a label, integer and correctly pluralised: '0 bags', '1 bag',
  // '3 bags', '4+ bags'. Use where a field is explicitly labelled "Luggage"
  // and must show something.
  function bagsLabel(bags) {
    var c = bagsCount(bags);
    return c.n + (c.plus ? '+' : '') + ' bag' + (c.n === 1 && !c.plus ? '' : 's');
  }

  // The COMPACT rule: a zero-bag journey adds nothing to a summary line, so
  // this returns '' and the caller omits the bags entirely. Every non-zero
  // count renders exactly as bagsLabel.
  function bagsText(bags) {
    var c = bagsCount(bags);
    return c.n === 0 && !c.plus ? '' : bagsLabel(bags);
  }

  // ── Customer change requests ────────────────────────────────────────────
  // A customer can ask, from My Account, for an upcoming trip to be changed.
  // Their request NEVER edits the booking (server/api.js) — it is recorded and
  // shown to staff here. How LOUDLY it is shown depends entirely on how far
  // along the booking is, and that decision lives in this module so the owner
  // and admin apps cannot drift apart on it (guardrail: admin-parity.test.js).
  //
  //   'early'    — the trip is not committed yet (still being priced, or the
  //                customer has not chosen how to pay). There is nothing to
  //                accept or decline: the owner simply prices the NEW details
  //                and sends the estimate. So this is a quiet amber note, not
  //                a decision. Interrupting the owner here would be noise.
  //
  //   'decision' — the trip is committed: confirmed (or already running). A
  //                driver is allocated around it and the customer is expecting
  //                that car at that time, so moving it is a real decision with
  //                money attached. This is the prominent Accept / Decline
  //                panel. NOTE this deliberately includes a confirmed booking
  //                that is not yet PAID (cash on the day): the journey is just
  //                as committed, and the owner should have the same explicit
  //                say. Payment state changes the fare WARNING, not the stage.
  //
  // A completed or cancelled booking cannot receive a request at all (the
  // route refuses); if a stale flag is ever seen on one, it degrades to the
  // quiet note rather than shouting about a trip that has already happened.
  var CHANGE_FIELDS = [
    ['pickup',       'Pickup'],
    ['stop_address', 'Stop'],
    ['destination',  'Drop-off'],
    ['date',         'Date'],
    ['time',         'Time'],
    ['passengers',   'Passengers'],
    ['bags',         'Luggage'],
    ['flight',       'Flight']
  ];

  // Which changed fields can move the price. Everything except the flight
  // number: the route, the day, the hour, the head-count and the luggage all
  // feed the fare or the vehicle size. A flight number alone never does.
  // We do NOT re-price automatically (owner's decision) — this only decides
  // whether to raise "Fare may change — confirm with the customer".
  var PRICE_FIELDS = ['pickup', 'stop_address', 'destination', 'date', 'time', 'passengers', 'bags'];

  function changeAffectsPrice(keys) {
    if (!keys || !keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (PRICE_FIELDS.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  function changeRequestStage(j) {
    if (!j || !j.change_requested_at) return 'none';
    var st = statusOf(j);
    if (st === 'confirmed' || st === 'active') return 'decision';
    return 'early';
  }

  // Parse the compact detail blob the server stamps on the booking. This is
  // rendered straight into two staff apps, so it MUST NOT be able to throw:
  // a truncated or hand-edited value costs the panel its contents, never the
  // page. Always returns the same shape.
  function changeRequestDetail(j) {
    var empty = { changed: [], note: '', price: false, at: '' };
    if (!j) return empty;
    var raw = j.change_request_detail;
    if (!raw) return empty;
    var d;
    try { d = (typeof raw === 'string') ? JSON.parse(raw) : raw; }
    catch (e) { return empty; }
    if (!d || typeof d !== 'object') return empty;
    var changed = [];
    if (Object.prototype.toString.call(d.changed) === '[object Array]') {
      for (var i = 0; i < d.changed.length; i++) {
        var c = d.changed[i];
        if (!c || typeof c !== 'object' || !c.key) continue;
        changed.push({
          key: String(c.key),
          label: String(c.label || c.key),
          current: c.current == null ? '' : String(c.current),
          requested: c.requested == null ? '' : String(c.requested)
        });
      }
    }
    return {
      changed: changed,
      note: d.note == null ? '' : String(d.note),
      price: !!d.price,
      at: d.at == null ? '' : String(d.at)
    };
  }

  // One-line summary for the EARLY note: "Date, Time and Passengers".
  function changedFieldsLabel(j) {
    var names = changeRequestDetail(j).changed.map(function (c) { return c.label.toLowerCase(); });
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
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
  //   • reviewChange  — EARLY-stage change request: nothing to decide, the
  //                     owner just prices the new details. This only dismisses
  //                     the note.
  //   • acceptChange / declineChange — DECISION-stage change request on a
  //                     committed trip. Accept is the ONLY path in the whole
  //                     system by which a customer's requested values ever
  //                     reach the booking, and it is a deliberate staff act.
  //   • clearFareReview — the trip was amended in a way that may have moved
  //                     the price; dismissed once the owner has settled it.
  function actionsFor(j) {
    var st = statusOf(j);
    var isPaid = !!(j && j.paid_at);
    var hasEmail = !!(j && (j.email || j.customer_email || j.passenger_email));
    var hasFare = !!(j && Number(j.fare) > 0);
    var live = st !== 'cancelled';
    var crStage = changeRequestStage(j);
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
      del: true,
      reviewChange: crStage === 'early',
      acceptChange: crStage === 'decision',
      declineChange: crStage === 'decision',
      clearFareReview: !!(j && j.fare_review_at)
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
    bagsCount: bagsCount,
    bagsLabel: bagsLabel,
    bagsText: bagsText,
    actionsFor: actionsFor,
    CHANGE_FIELDS: CHANGE_FIELDS,
    PRICE_FIELDS: PRICE_FIELDS,
    changeAffectsPrice: changeAffectsPrice,
    changeRequestStage: changeRequestStage,
    changeRequestDetail: changeRequestDetail,
    changedFieldsLabel: changedFieldsLabel,
    toConfirmCount: toConfirmCount,
    isAwaitingPayment: isAwaitingPayment,
    isoWeekStart: isoWeekStart,
    weekRangeLabel: weekRangeLabel,
    groupByWeek: groupByWeek,
    _spec: 'estimate-first; no staff auto-confirm; payment never defaults to cash'
  };
}));
