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
  //
  // A DESCRIPTOR CARRIES NO COLOUR. These used to return `color` and `bg` — an
  // amber wash for awaiting, a green wash for paid, a red one for cancelled —
  // and all three apps painted them straight into an inline style. That made
  // this file the source of every filled status pill in the system, and made
  // the filled pill impossible to restyle from the theme, because an inline
  // background outranks a stylesheet.
  //
  // The owner's rule is that nothing highlights by filling. So the descriptor
  // is now semantics only — key, label and a class name — and what a chip
  // LOOKS like is decided in one place, §20 of westmere-theme.css: a navy
  // hairline frame on white. Do not add a colour back here.
  // GUARDRAIL: server/tests/no-fills.test.js
  function statusLabel(j) {
    var st = statusOf(j);
    if (st === 'pending') {
      if (j && j.estimate_sent_at) {
        return { key: 'pending_sent', label: 'Pending · estimate sent', cls: 'tag-await' };
      }
      return { key: 'new', label: 'New request', cls: 'tag-new' };
    }
    if (st === 'offered') return { key: 'offered', label: 'Awaiting driver', cls: 'tag-upcoming' };
    if (st === 'awaiting_payment') {
      // TWO different awaiting_payment states, and they read differently to the
      // owner. If a method IS chosen (cash) we are genuinely awaiting the money.
      // If none is — a fresh estimate, or a booking the owner has just REOPENED
      // from the Edit form — nobody is awaiting payment yet; we are waiting for
      // the customer to pick a door. Calling that "Awaiting payment" made a
      // reopened job look like it was already mid-collection.
      var pmAw = paymentOf(j);
      if (!pmAw || pmAw === 'pending') {
        return { key: 'to_be_confirmed', label: 'To be confirmed', cls: 'tag-await' };
      }
      return { key: 'awaiting_payment', label: 'Awaiting payment', cls: 'tag-await' };
    }
    if (st === 'cancelled') return { key: 'cancelled', label: 'Cancelled', cls: 'tag-cancel' };
    if (st === 'active') return { key: 'active', label: 'Active', cls: 'tag-upcoming' };
    if (st === 'completed') return { key: 'completed', label: 'Completed', cls: 'tag-done' };
    return { key: 'confirmed', label: 'Confirmed', cls: 'tag-upcoming' };
  }

  // ── Payment badge ───────────────────────────────────────────────────────
  // Owner spec (from a real screenshot bug): a brand-new booking must NOT read
  // "Awaiting" — nobody is awaiting anything until the customer picks a method.
  // Those show a neutral "—"; the STATUS badge carries the real state.
  function payStatus(j) {
    if (j && (j.paid_at || paymentOf(j) === 'card')) {
      return { key: 'prepaid', label: 'Prepaid', short: 'Prepaid ✓', cls: 'tag-prepaid' };
    }
    var p = paymentOf(j);
    if (p === 'cash') return { key: 'cash', label: 'Cash', short: 'Cash', cls: 'tag-cash' };
    if (p === 'account' || p === 'invoice') return { key: 'account', label: 'Account', short: 'Account', cls: 'tag-account' };
    var st = statusOf(j);
    // Nothing is "awaiting" on a booking where no method was ever chosen: a new
    // request, one that only got an estimate, or one that was cancelled before
    // the customer decided. Those read neutral — the STATUS badge carries the
    // real state.
    if (st === 'pending' || st === 'offered' || st === 'cancelled' || st === '') {
      return { key: 'none', label: 'No payment chosen yet', short: '—', cls: 'tag-none' };
    }
    return { key: 'await', label: 'Awaiting payment', short: 'Awaiting', cls: 'tag-await' };
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
      /* ── NO UN-COMPLETING ─────────────────────────────────────────────
         There was a door back: a button that put a completed job on
         'confirmed' again, out of the income figures and cancellable. The
         owner has closed it. His words: a completed job is completed.

         It is a decision about the books, not about the screen. A finished
         job is money that has been counted, and a control that quietly takes
         it back out is a control that can be pressed by mistake — on the
         wrong row, on a phone, months later — with nothing to show it ever
         happened. A job marked finished in error is still EDITABLE, which is
         the ordinary way to correct a detail; what is gone is the one button
         that moved money off the books in a single tap.

         Left here as false rather than deleted so that the rule has somewhere
         to be read, and so no app grows its own version of it.
         GUARDRAIL: server/tests/completed-is-final.test.js */
      unmarkCompleted: false,
      togglePaid: st === 'confirmed' || st === 'active' || st === 'completed',
      sendReminder: !isPaid && hasEmail && hasFare &&
        (st === 'completed' || st === 'confirmed' || st === 'awaiting_payment'),
      invoice: (st === 'confirmed' || st === 'active' || st === 'completed') && hasFare,
      message: hasEmail && live,
      edit: live,
      // ── COMPLETED IS FINAL ────────────────────────────────────────────
      // A completed job counts towards the owner's income. Cancelling or
      // deleting it would take that money out of the books by the back door,
      // so neither is offered — and since the owner closed the un-complete
      // door above, a finished job is finished. Correct one by editing it.
      //
      // The server refuses the same thing on every door that could do it
      // (PATCH/cancel/DELETE /bookings/:id, the customer's /cancel/:ref, and
      // the driver's cancel) — see server/tests/completed-is-final.test.js.
      // These two flags only stop the app from offering a button the server
      // is going to reject.
      cancel: live && st !== 'completed',
      del: st !== 'completed',
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

  /* ── THE PAY WEEK, AS WALL-CLOCK DATES ──────────────────────────────────
     Monday to Sunday, in and out as literal YYYY-MM-DD. Every other week
     helper here builds a local Date from a y/m/d triple, which is fine for
     grouping a list in a browser; this one draws the line a batch of money is
     settled on, and that line must be the same on the owner's phone, on the
     admin desktop and on a Railway box running UTC.

     So it is UTC arithmetic on the components and never a parsed instant —
     the timezone invariant in CLAUDE.md. `new Date('2026-08-16')` read back
     locally is Saturday the 15th west of UTC, and a pay week off by a day puts
     a job in the wrong transfer.
     GUARDRAIL: server/tests/weekly-payout.test.js */
  function weekBounds(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    var t;
    if (m) t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    else {
      // No date given: this week, by UK wall-clock today.
      var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' }).split('-');
      t = Date.UTC(+today[0], +today[1] - 1, +today[2]);
    }
    var dow = (new Date(t).getUTCDay() + 6) % 7;          // Monday = 0
    var from = t - dow * 86400000;
    var to = from + 6 * 86400000;
    var iso = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
    return { from: iso(from), to: iso(to) };
  }

  /** Shift a pay week by whole weeks. weekShift('2026-10-05', -1) → last week. */
  function weekShift(ymd, delta) {
    var b = weekBounds(ymd);
    var p = b.from.split('-');
    var t = Date.UTC(+p[0], +p[1] - 1, +p[2]) + (delta || 0) * 7 * 86400000;
    return weekBounds(new Date(t).toISOString().slice(0, 10));
  }

  /**
   * THIS WEEK AGAINST LAST WEEK, TO THE SAME POINT IN THE WEEK.
   *
   * The whole value of the comparison is that it is like for like. A running
   * week measured against a FINISHED one is not a comparison, it is an
   * arithmetic accident: on a Tuesday morning it reads "£240 against £1,100"
   * and says the business has collapsed, every Monday, for ever. So last week
   * is cut at the same weekday and no further — Tuesday against Tuesday.
   *
   * `valueOf(job)` returns the money this job contributes, or null/0 for one
   * that does not count. The two apps disagree about what counts (the admin
   * dashboard counts money actually received; the owner's earnings page has
   * its own rule) and that disagreement is theirs to keep, so it is a
   * parameter rather than a decision taken here.
   *
   * Dates are wall-clock YYYY-MM-DD throughout — compared as strings, never
   * parsed into instants. See the timezone invariant in CLAUDE.md.
   */
  function weekCompare(jobs, valueOf) {
    var now = weekBounds();
    var prev = weekShift(now.from, -1);
    var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
    // How far into the week we are, 0 (Monday) to 6 (Sunday).
    var p = now.from.split('-');
    var t = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' }).split('-');
    var dow = Math.round((Date.UTC(+t[0], +t[1] - 1, +t[2]) -
                          Date.UTC(+p[0], +p[1] - 1, +p[2])) / 86400000);
    if (!(dow >= 0 && dow <= 6)) dow = 6;
    var q = prev.from.split('-');
    var prevCut = new Date(Date.UTC(+q[0], +q[1] - 1, +q[2]) + dow * 86400000)
      .toISOString().slice(0, 10);

    var sum = function (from, to) {
      var total = 0, n = 0;
      (jobs || []).forEach(function (j) {
        var d = j && j.date ? String(j.date).slice(0, 10) : '';
        if (!d || d < from || d > to) return;
        var v = valueOf ? valueOf(j) : (Number(j.fare) || 0);
        if (v == null) return;
        total += Number(v) || 0;
        n++;
      });
      return { total: Math.round(total * 100) / 100, jobs: n };
    };

    var a = sum(now.from, today);
    var b = sum(prev.from, prevCut);
    var delta = Math.round((a.total - b.total) * 100) / 100;
    return {
      thisWeek: a,
      lastWeek: b,
      from: now.from, to: today,
      lastFrom: prev.from, lastTo: prevCut,
      partial: dow < 6,
      delta: delta,
      /* No percentage off a base of nothing: "up ∞%" after a quiet week is
         worse than saying the figure. */
      pct: b.total > 0 ? Math.round((a.total - b.total) / b.total * 100) : null,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'level'
    };
  }

  /** "Mon 29 Sep – Sun 5 Oct 2026", built from the components, not a locale. */
  function payWeekLabel(bounds) {
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var one = function (ymd, withYear) {
      var p = String(ymd).split('-');
      var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      return wd[(d.getUTCDay() + 6) % 7] + ' ' + (+p[2]) + ' ' + mo[(+p[1]) - 1] + (withYear ? ' ' + p[0] : '');
    };
    return one(bounds.from, false) + ' \u2013 ' + one(bounds.to, true);
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

  /* ── MONTHLY grouping (the "Trip History" view in both staff apps) ───────
     The owner reads his finished work a month at a time — that is the unit a
     tax year and an invoice run are made of, and a year of weekly headers is
     fifty-two of them to scroll past.

     Same shape as groupByWeek so the two views stay interchangeable: newest
     month first, newest job first within it, takings per group. Undated jobs
     fall into their own bucket at the end rather than being dropped, because a
     job with no date is a data problem the owner should be able to see.

     Dates are UK wall-clock strings and are split by hand — never parsed as an
     instant (the timezone invariant in CLAUDE.md). */
  var _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
  function groupByMonth(list) {
    var groups = {};
    (list || []).forEach(function (j) {
      var key = '0000-00', label = 'Undated';
      if (j && j.date) {
        var p = String(j.date).split('-');
        var y = parseInt(p[0], 10), m = parseInt(p[1], 10);
        if (y && m >= 1 && m <= 12) {
          key = p[0] + '-' + (m < 10 ? '0' + m : String(m));
          label = _MONTHS[m - 1] + ' ' + y;
        }
      }
      if (!groups[key]) groups[key] = { key: key, label: label, items: [] };
      groups[key].items.push(j);
    });
    return Object.keys(groups).sort().reverse().map(function (k) {
      var g = groups[k];
      g.items.sort(function (a, b) {
        var dc = String(a.date || '').localeCompare(String(b.date || ''));
        if (dc !== 0) return -dc;
        return String(b.time || '').localeCompare(String(a.time || ''));
      });
      /* A CANCELLED TRIP EARNED NOTHING. Trip History is now ONE list holding
         everything finished — completed AND cancelled together — so the
         month's takings have to say which of them was money. Summing every
         fare in the group would have put the fare of a journey that never
         happened into the figure at the top of the month.
         GUARDRAIL: server/tests/compact-history.test.js */
      g.cancelled = g.items.filter(function (x) { return statusOf(x) === 'cancelled'; }).length;
      g.jobs = g.items.length - g.cancelled;
      g.takings = g.items.reduce(function (s, j) {
        return statusOf(j) === 'cancelled' ? s : s + (Number(j.fare) || 0);
      }, 0);
      /* AND WHAT WAS OURS OF IT. `takings` is what came through the business —
         the fares — and on a job passed to a driver most of it went straight
         back out again. A month header reading £4,100 beside a column of other
         people's names is the same mistake the dashboard was making when it
         told the owner he had earned the whole of a fare he paid £86 of away.
         Both figures are kept because they answer different questions; the
         screens that say "earned" use this one.
         GUARDRAIL: server/tests/income-parity.test.js */
      g.income = Math.round(g.items.reduce(function (s, j) {
        return statusOf(j) === 'cancelled' ? s : s + westmereIncome(j);
      }, 0) * 100) / 100;
      return g;
    });
  }


  /* THE HOUSE RATE, and the only place this module names a number about
     money. It is server/driver-ledger.js ADMIN_FEE_PCT, and the parity guard
     reads both files and fails if they drift apart.
     GUARDRAIL: server/tests/income-parity.test.js */
  var ADMIN_FEE_PCT = 0.10;

  /* ── WHO ACTUALLY DID THE JOB ─────────────────────────────────────────────
     EVERY CONFIRMED JOB HAS A DRIVER ON IT — him. So "has a driver_id" cannot
     answer the question, and the admin list could not say which of a month's
     work he drove and which he paid somebody else to drive. passed_at is the
     question; who it went to is the answer, and a firm is not a driver.

     Reads both spellings because the two apps hold a booking differently: the
     owner app camel-cases the row on its way in, the admin app uses it raw.
     One rule either way, so the two can never give different answers.
     GUARDRAIL: server/tests/passed-job-name.test.js */
  function whoDrove(j) {
    if (!j) return { kind: 'own', name: '' };
    var passed = j.passedAt || j.passed_at;
    if (!passed) return { kind: 'own', name: '' };
    var firmId   = j.operatorId   || j.operator_id;
    var firmName = j.operatorName || j.operator_name;
    var assigned = j.assignedToName || j.assigned_to_name;
    if (firmId || firmName) {
      return { kind: 'firm', name: String(firmName || assigned || 'Another firm') };
    }
    return { kind: 'driver',
             name: String(j.driverName || j.driver_name || assigned || 'Another driver') };
  }

  /* ── WHAT THE FIRM MADE ON A JOB ──────────────────────────────────────────
     NOT THE FARE. On a job passed to a driver the fare is collected on his
     behalf and paid straight back out; only the commission was ever ours. The
     admin dashboard added fares up and told the owner he had earned £192 on a
     day when one of the two jobs was driven by somebody he then had to pay £86
     of it to.

     A job passed to an OPERATOR is different and must not be lumped in: the
     other firm drives it and we INVOICE them, so nothing is paid out through
     this system and the whole of what we bill is ours.

     This is server/driver-ledger.js westmereIncome(), in the browser, for the
     tiles that are drawn from a list the page already has rather than fetched
     as a total. The two are driven over the same table of jobs and required to
     give the same answer to the penny.
     GUARDRAIL: server/tests/income-parity.test.js */
  function westmereIncome(j) {
    if (!j) return 0;
    var fare = Number(j.fare);
    if (!isFinite(fare)) fare = 0;
    var round = function (n) { return Math.round(n * 100) / 100; };
    if (whoDrove(j).kind !== 'driver') return round(fare);
    /* The commission as STORED, which is what the job was actually passed on
       at — a driver on a different rate, or a cover job at nothing, is not the
       house ten per cent. Only a job with nothing stored falls back to it. */
    var fee = (j.admin_fee != null && j.admin_fee !== '' && isFinite(Number(j.admin_fee)))
      ? Number(j.admin_fee) : (fare * ADMIN_FEE_PCT);
    return round(fee);
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
    canCancel: function (j) { return actionsFor(j).cancel; },
    canDelete: function (j) { return actionsFor(j).del; },
    CHANGE_FIELDS: CHANGE_FIELDS,
    PRICE_FIELDS: PRICE_FIELDS,
    changeAffectsPrice: changeAffectsPrice,
    changeRequestStage: changeRequestStage,
    changeRequestDetail: changeRequestDetail,
    changedFieldsLabel: changedFieldsLabel,
    toConfirmCount: toConfirmCount,
    isAwaitingPayment: isAwaitingPayment,
    isoWeekStart: isoWeekStart,
    weekBounds: weekBounds,
    weekShift: weekShift,
    weekCompare: weekCompare,
    payWeekLabel: payWeekLabel,
    weekRangeLabel: weekRangeLabel,
    groupByWeek: groupByWeek,
    groupByMonth: groupByMonth,
    ADMIN_FEE_PCT: ADMIN_FEE_PCT,
    whoDrove: whoDrove,
    westmereIncome: westmereIncome,
    _spec: 'estimate-first; no staff auto-confirm; payment never defaults to cash'
  };
}));
