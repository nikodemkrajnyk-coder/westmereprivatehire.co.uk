// ════════════════════════════════════════════════════════════════════════════
//  WM-COMPACT — the compact list, and the detail page behind it
// ════════════════════════════════════════════════════════════════════════════
//
// The owner's rule for every history surface in the system:
//
//     "Less information on each page, then click to expand."
//
// A list is a SPREADSHEET: a few short columns, one line per row, nothing that
// wraps. Everything else — the full addresses, the phone number, what was paid
// and how, the driver's commission — lives on the DETAIL PAGE you reach by
// tapping the row. A list that tries to carry the detail is the thing this
// module exists to stop.
//
// The column sets live here, as data, so the owner app and the admin app
// cannot drift apart and so a guard can assert them
// (server/tests/compact-history.test.js).
//
// Exposed as `module.exports` (server/tests: require('../wm-compact')) AND as
// the browser global `window.WMCompact` (apps: <script src="/wm-compact.js">).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WMCompact = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ── THE COLUMNS ─────────────────────────────────────────────────────────
  // Short, and short on purpose. `num` right-aligns and uses tabular figures;
  // `hide` drops the column on a narrow phone, where five columns of text do
  // not fit however small the type is.
  /* ONE LIST, TWO OUTCOMES. Trip History holds everything finished — the trips
     that ran and the ones that were cancelled — because the owner's question is
     "what happened to that booking", and the answer used to live in whichever
     of two tabs he guessed right. A cancelled row has to be unmistakable inside
     the one list, so it carries this column AND reads differently: the route is
     struck through and the row is quieter (§28 of westmere-theme.css).

     It appears ONLY when the list actually holds a cancelled trip. A month in
     which nothing was cancelled is not given a column of empty cells to
     explain. */
  var STATUS_COLUMN = { key: 'status', label: 'Status', w: '12%' };


  /* ── THE DESKTOP JOURNEYS LIST ────────────────────────────────────────────
     Admin is the owner's desk, not his pocket, and it had TWO lists of the same
     journeys: a compact five-column history and an eleven-column table of
     everything, which at anything under about 1240px put its last two columns —
     Status and the actions — off the right-hand edge behind an inner scrollbar.
     He reported that as not being able to see the full page, and he was right.

     ONE LIST, with the columns a desk has room for. Still short of what a row
     could hold: the addresses are shortened, the passenger's phone, the flight,
     what was actually paid and every action all live on the page the row opens.
     The widths are fixed and add to 100, because a browser left to size columns
     by content lets one long drop-off push the right-hand column off the screen
     — which is the bug this replaces.
     GUARDRAIL: server/tests/admin-journeys.test.js */
  var JOURNEY_COLUMNS = [
    { key: 'date',    label: 'Date',      w: '9%'  },
    { key: 'time',    label: 'Time',      w: '6%'  },
    { key: 'ref',     label: 'Ref',       w: '10%' },
    { key: 'name',    label: 'Passenger', w: '14%' },
    { key: 'pickup',  label: 'Pickup',    w: '16%' },
    { key: 'dropoff', label: 'Drop-off',  w: '16%' },
    /* WHO DROVE IT. The column the owner asked for, and the one question a
       list of his own work could never answer: every confirmed job carries him
       as its driver, so a job he had passed on looked exactly like a job he
       did himself. His own jobs stay BLANK — a list where most rows say "me"
       is a list with a column of noise down the middle of it, and the thing he
       is scanning for is the exception. */
    { key: 'driver',  label: 'Driver',    w: '11%' },
    { key: 'fare',    label: 'Fare',      w: '7%', num: true },
    { key: 'state',   label: 'Status',    w: '11%' }
  ];

  var HISTORY_COLUMNS = [
    { key: 'ref',      label: 'Ref',       w: '13%' },
    { key: 'date',     label: 'Date',      w: '11%' },
    { key: 'name',     label: 'Passenger', w: '21%' },
    { key: 'pickup',   label: 'Pickup',    w: '27%' },
    { key: 'dropoff',  label: 'Drop-off',  w: '27%' }
  ];

  // A driver's own trips. Same discipline: the commission rate, whether it was
  // paid, the payment method and the addresses are all on the detail page.
  var DRIVER_TRIP_COLUMNS = [
    { key: 'ref',      label: 'Ref',       w: '17%' },
    { key: 'date',     label: 'Date',      w: '14%' },
    { key: 'name',     label: 'Passenger', w: '35%' },
    { key: 'fare',     label: 'Fare',      w: '19%', num: true },
    { key: 'paid',     label: 'Paid',      w: '15%' }
  ];

  /* WHICH OUTCOME THIS IS. Reads the same field the lifecycle module reads,
     and copes with the owner app's own job shape, where the server's status
     lives on `apiStatus` and `status` is the driver-facing stage. */
  function isCancelled(j) {
    if (!j) return false;
    var st = String(j.apiStatus || j.status || '').toLowerCase();
    return st === 'cancelled';
  }

  /* ── THE WEEKLY PAYOUT LIST ──────────────────────────────────────────────
     What the owner is looking at on a Monday with his banking app open: the
     jobs that have piled up unpaid, and what each one puts into the transfer.
     "Payout" is the job's own net — the whole fare on a cover job, the fare
     less the rate on a commission one, and NEGATIVE on a cash job, where the
     driver is holding our money and the commission comes off the transfer.
     Labelled plainly rather than conversationally: this is a payment record,
     and the owner asked for the driver-facing wording to read like one. */
  var PAYOUT_COLUMNS = [
    { key: 'ref',    label: 'Ref',       w: '17%' },
    { key: 'date',   label: 'Date',      w: '14%' },
    { key: 'name',   label: 'Passenger', w: '29%' },
    { key: 'fare',   label: 'Fare',      w: '18%', num: true },
    { key: 'net',    label: 'Payout',    w: '22%', num: true }
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── SHORT DATE — "4 Oct", or "4 Oct 24" when it is not this year ────────
  // Wall-clock, like every other date in this system: the components are read
  // literally and formatted in UTC, never parsed as a local instant. See the
  // timezone invariant in CLAUDE.md.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(ymd, thisYear) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    var yr = thisYear || new Date().getFullYear();
    return d + ' ' + (MONTHS[mo - 1] || '') + (y === yr ? '' : ' ' + String(y).slice(2));
  }

  // ── SHORT PLACE — one word or two, never an address ─────────────────────
  // Uses the shared address normaliser when the app has loaded it (it knows
  // the airports and the Sussex towns); falls back to the first comma-part.
  function shortPlace(raw) {
    if (!raw) return '';
    try {
      var A = (typeof WMAddr !== 'undefined' && WMAddr) ||
              (typeof root !== 'undefined' && root && root.WMAddr);
      if (A && A.tinyLabel) { var t = A.tinyLabel(raw); if (t) return trimPostcode(t); }
    } catch (e) { /* fall through to the plain form */ }
    var first = trimPostcode(String(raw).split(',')[0].trim());
    return first.length > 18 ? first.slice(0, 17) + '…' : first;
  }

  /* A POSTCODE IS NOT A PLACE NAME. "Steyning BN44 3GG" is the normaliser doing
     its job on an address whose locality and postcode share a comma-part — and
     in a column this narrow it costs the half of the label that is readable.
     The postcode is on the detail page, with the rest of the address. */
  function trimPostcode(s) {
    return String(s || '')
      .replace(/\s+[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i, '')
      .trim() || String(s || '').trim();
  }

  // ── WHAT THE MONEY DID ──────────────────────────────────────────────────
  // The stored methods are pending | card | cash | account | invoice
  // (server/payment-methods.js). A debit card is a card as far as Stripe and
  // the books are concerned, so `card` says so out loud rather than implying
  // credit. `pending` is NEVER rendered as cash — see the payment invariants.
  var PAY_LABELS = {
    card:    'Card or debit card',
    cash:    'Cash to the driver',
    account: 'On account',
    invoice: 'Invoiced',
    pending: 'Not chosen yet'
  };
  function payMethod(j) {
    var p = String((j && (j.payment || j.payment_method)) || 'pending').toLowerCase();
    return PAY_LABELS[p] ? p : 'pending';
  }
  function payMethodLabel(j) { return PAY_LABELS[payMethod(j)]; }

  /* A FIGURE IN A COLUMN IS READ, NOT PARSED. Pence are dropped when there are
     none, because a column of trailing .00 is noise — and thousands are grouped,
     because the first thing the eye does with £1182 is count the digits. The
     spend report is where that showed: the chart beside the table wrote
     £1,182.00 and the table wrote £1182, one figure in two spellings a foot
     apart. Nothing below a thousand changes.
     An absence is an em dash. Nought pounds is not a figure anybody wants to
     read down a column. */
  function money(n) {
    var v = Number(n);
    if (!isFinite(v) || !n) return '—';
    var neg = v < 0;
    var s2 = Math.abs(v).toFixed(2).replace(/\.00$/, '');
    var parts = s2.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '\u2212£' : '£') + parts.join('.');
  }

  // What the customer actually handed over, and when. A fare is what we asked
  // for; `paid_at` is what we got. The detail page shows both, because the gap
  // between them is the thing the owner is looking for.
  /* WHETHER THE MONEY ARRIVED — the SAME test the payment badge makes, so the
     badge and the sentence under it cannot disagree. A booking only ever reads
     `card` because a Stripe payment_intent succeeded (CLAUDE.md payment
     invariant #1), so a card job is paid whether or not an old row happens to
     carry the stamp. Reading `paid_at` alone put "not paid yet" underneath a
     "Prepaid ✓" badge on the same screen. */
  function isPaid(j) {
    return !!(j && (j.paid_at || payMethod(j) === 'card'));
  }
  function paidLine(j) {
    if (!j) return 'Not paid';
    if (isPaid(j)) return money(j.fare) + ' paid · ' + payMethodLabel(j);
    return money(j.fare) + ' — not paid yet · ' + payMethodLabel(j);
  }


  /* ── WHAT EACH CUSTOMER IS WORTH ──────────────────────────────────────────
     Customer Spend was a hand-written table with no declared widths, so every
     column was sized by its longest cell and the whole thing moved shape as
     the data did — a long email address shunted the money out of line and the
     figures stopped being comparable down the page, which is the one thing a
     spend report is for. The owner's word for what he wanted was "spreadsheet".

     So it is the same table as Trip History and the journeys list: fixed
     widths that add to 100, tabular figures, the money right-aligned, one row
     per customer. Ranked by what they have spent, because that is the order he
     reads it in and the reason it is sorted at all.
     GUARDRAIL: server/tests/customer-spend-table.test.js */
  var SPEND_COLUMNS = [
    { key: 'rank',     label: '#',           w: '5%'  },
    { key: 'name',     label: 'Customer',    w: '22%' },
    { key: 'email',    label: 'Email',       w: '24%' },
    { key: 'trips',    label: 'Trips',       w: '7%',  num: true },
    { key: 'spent',    label: 'Total spent', w: '13%', num: true },
    { key: 'avg',      label: 'Avg / trip',  w: '12%', num: true },
    { key: 'quoted',   label: 'Quoted',      w: '9%',  num: true },
    { key: 'lastTrip', label: 'Last trip',   w: '8%'  }
  ];

  /* THE SAME REPORT IN A POCKET. The owner's phone cannot hold eight columns,
     and of the eight it is the email, the average and the quoted figure he
     reads on the detail page rather than down a list. Four columns, the same
     cells, and the row opens the customer. */
  var CUSTOMER_COLUMNS = [
    { key: 'name',     label: 'Customer',  w: '42%' },
    { key: 'trips',    label: 'Trips',     w: '13%', num: true },
    { key: 'spent',    label: 'Spent',     w: '24%', num: true },
    { key: 'lastTrip', label: 'Last',      w: '21%' }
  ];

  // ── THE ROW ─────────────────────────────────────────────────────────────
  function historyCells(j) {
    return {
      ref: j.ref || '—',
      date: shortDate(j.date),
      name: j.name || j.customer_name || j.passenger_name || 'Guest',
      pickup: shortPlace(j.pickup),
      dropoff: shortPlace(j.destination || j.dest || j.dropoff),
      status: isCancelled(j) ? 'Cancelled' : ''
    };
  }
  function payoutCells(j) {
    var net = Number(j.outstanding);
    if (!isFinite(net)) net = Number(j.delta) || 0;
    return {
      ref: j.ref || '—',
      date: shortDate(j.date),
      name: j.name || j.customer_name || j.passenger_name || 'Guest',
      fare: money(j.fare),
      /* The sign is the whole story on a cash job, so it is printed rather
         than left to be inferred from a column heading. */
      net: (net < 0 ? '\u2212' : '') + money(Math.abs(net))
    };
  }

  function driverTripCells(j) {
    return {
      ref: j.ref || '—',
      date: shortDate(j.date),
      name: j.name || j.customer_name || j.passenger_name || 'Guest',
      fare: money(j.fare),
      /* `paid` here is the DRIVER's side of the job — has he been settled for
         it — and it is the ledger row's own `paid` (driver-ledger's isSettled).
         Reading the booking column `driver_settled` instead said "No" against
         every job on the screen, including the two the balance above it had
         just counted as settled. */
      paid: (j.paid === undefined ? !!j.driver_settled : !!j.paid) ? 'Yes' : 'No'
    };
  }

  // ── THE TABLE ───────────────────────────────────────────────────────────
  // `open` is the name of a global function taking the row's id. Every row is
  // a real tab stop with a real role, so the spreadsheet is navigable by
  // keyboard and readable by a screen reader — it is a table of journeys, not
  // a stack of clickable divs.
  function tableHtml(cols, items, cells, open, opts) {
    var o = opts || {};
    /* FIXED COLUMNS. Without them the browser sizes a column to its longest
       cell, and one long drop-off pushes the right-hand column off the screen —
       which is exactly what it did on a phone. The widths are part of the
       column definition, so a guard can read them and the two apps cannot
       drift. */
    /* SOME TABLES ARE REPORTS. Customer Spend on the desktop is read, not
       opened — its rows are grouped by email and name rather than by a saved
       customer, so there is no page behind them to go to. A row with no
       destination must not be dressed as a button: no chevron, no tab stop, no
       role, and the pointer stays an arrow. Passing no `open` says so. */
    var clickable = !!open;

    var cols_ = '<colgroup>' + cols.map(function (c) {
      return '<col style="width:' + (c.w || 'auto') + '">';
    }).join('') + (clickable ? '<col class="wm-ctab-colchev">' : '') + '</colgroup>';

    var head = '<thead><tr>' + cols.map(function (c) {
      return '<th class="wm-ctab-h' + (c.num ? ' num' : '') + '">' + esc(c.label) + '</th>';
    }).join('') + (clickable ? '<th class="wm-ctab-h wm-ctab-chev" aria-hidden="true"></th>' : '') + '</tr></thead>';

    var body = '<tbody>' + items.map(function (j) {
      var v = cells(j);
      /* The id goes into an HTML ATTRIBUTE that contains JS, so it is escaped
         twice over: JSON for the JavaScript string, then HTML for the
         attribute it sits in. One without the other and a quote in an id ends
         the attribute early. */
      var id = esc(JSON.stringify(String(j.id)));
      return '<tr class="wm-ctab-r' + (clickable ? '' : ' is-report')
          + (isCancelled(j) ? ' is-cancelled' : '') + '"'
        + (clickable
            ? ' tabindex="0" role="button"'
              + ' aria-label="' + esc((v.name || '') + ' ' + (v.date || '') + ' ' + (v.ref || '')
                  + (isCancelled(j) ? ' — cancelled' : '') + ' — open the full details') + '"'
              + ' onclick="' + open + '(' + id + ')"'
              + ' onkeydown="if(event.key===&#39;Enter&#39;||event.key===&#39; &#39;){event.preventDefault();' + open + '(' + id + ');}"'
            : '')
        + '>'
        + cols.map(function (c) {
            return '<td class="wm-ctab-c' + (c.num ? ' num' : '') + '">' + esc(v[c.key] == null ? '' : v[c.key]) + '</td>';
          }).join('')
        + (clickable ? '<td class="wm-ctab-c wm-ctab-chev" aria-hidden="true">›</td>' : '')
      + '</tr>';
    }).join('') + '</tbody>';

    return '<div class="wm-ctab-wrap"><table class="wm-ctab' + (o.kind ? ' wm-ctab-' + o.kind : '') + '"'
      + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '>'
      + cols_ + head + body + '</table></div>';
  }

  /* The KIND rides on the table as a class. A phone has room for four of the
     five columns, and which four — and how wide — depends on what the table is
     of: a history is two place names, a driver's trips are two short figures.
     The widths live in §28 of westmere-theme.css, keyed on these. */

  /* The lifecycle module, however this file was loaded. Admin's journeys list
     needs two of its answers — what state a booking is in, and who drove it —
     and both must be ITS answers: a second opinion about either is exactly the
     drift this module and that one exist to prevent. */
  function lifecycle() {
    if (typeof WMLifecycle !== 'undefined' && WMLifecycle) return WMLifecycle;
    if (typeof self !== 'undefined' && self && self.WMLifecycle) return self.WMLifecycle;
    if (typeof require === 'function') { try { return require('./wm-lifecycle.js'); } catch (e) {} }
    return null;
  }

  function journeyCells(j) {
    var LC = lifecycle();
    var who = LC ? LC.whoDrove(j) : { kind: 'own', name: '' };
    return {
      date: shortDate(j.date),
      time: j.time || 'ASAP',
      ref: j.ref || '—',
      name: j.name || j.customer_name || j.passenger_name || 'Guest',
      pickup: shortPlace(j.pickup),
      dropoff: shortPlace(j.destination || j.dest || j.dropoff),
      driver: who.kind === 'own' ? '' : who.name,
      fare: money(j.fare),
      state: LC ? LC.statusLabel(j).label : (isCancelled(j) ? 'Cancelled' : '')
    };
  }

  function journeyTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    var list = items || [];
    o.kind = 'history';
    if (list.some(isCancelled)) o.kind = 'history wm-ctab-history-mixed';
    return tableHtml(JOURNEY_COLUMNS, list, journeyCells, open, o);
  }


  /* One customer, however the two screens hold them: the spend report groups
     by email and spells its fields one way, the saved directory carries a row
     id and spells them another. One reader, so the two lists can never put a
     different figure against the same person. */
  function spendCells(c) {
    var spent = (c.totalSpent != null) ? c.totalSpent : c.total_spent;
    var trips = (c.trips != null) ? c.trips : c.booking_count;
    var last  = c.lastTrip || c.last_booking;
    var avg   = (c.avgPerTrip != null) ? c.avgPerTrip
              : ((Number(trips) > 0 && spent != null) ? (Number(spent) / Number(trips)) : null);
    return {
      rank: c._rank == null ? '' : String(c._rank),
      name: c.name || c.email || '—',
      email: c.email || '—',
      trips: String(Number(trips) || 0),
      spent: money(spent),
      avg: money(avg),
      /* A customer with nothing settled yet has no quoted figure to print, and
         a column of £0.00 reads as money rather than as an absence. */
      quoted: Number(c.quotedUnpaid) ? money(c.quotedUnpaid) : '—',
      lastTrip: last ? shortDate(last) : '—'
    };
  }

  /* The desktop report. No `open`: these rows are grouped by email and name,
     not by a saved customer, so there is no page behind them. */
  function spendTable(items, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    o.kind = 'spend';
    var ranked = (items || []).map(function (c, i) {
      var r = {}; for (var k2 in c) r[k2] = c[k2];
      r._rank = i + 1;
      return r;
    });
    return tableHtml(SPEND_COLUMNS, ranked, spendCells, null, o);
  }

  /* The phone list. These ARE saved customers, so the row opens one. */
  function customerTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    o.kind = 'customers';
    return tableHtml(CUSTOMER_COLUMNS, items || [], spendCells, open, o);
  }

  function historyColumnsFor(items) {
    var any = (items || []).some(isCancelled);
    return any ? HISTORY_COLUMNS.concat([STATUS_COLUMN]) : HISTORY_COLUMNS;
  }
  function historyTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    var list = items || [];
    o.kind = 'history';
    if (list.some(isCancelled)) o.kind = 'history wm-ctab-history-mixed';
    return tableHtml(historyColumnsFor(list), list, historyCells, open, o);
  }
  function payoutTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    o.kind = 'trips';
    return tableHtml(PAYOUT_COLUMNS, items || [], payoutCells, open, o);
  }
  function driverTripTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    o.kind = 'trips';
    return tableHtml(DRIVER_TRIP_COLUMNS, items || [], driverTripCells, open, o);
  }

  /**
   * THE COMPARISON LINE — one sentence under the stats, in both apps.
   *
   * It is deliberately a sentence and not a fourth stat card. The owner asked
   * to be able to GLANCE at how the week is going against the last one; a card
   * invites you to study it, and a card with a green arrow in it invites you to
   * feel something about it. Running type, the two figures in navy, the change
   * in words.
   *
   * NO RED AND GREEN. A quieter week is not an error and a busier one is not a
   * success — and this system spends colour on exactly two things, gold for
   * ornament and red for an absence. "Up" and "down" are words.
   *
   * Takes what WMLifecycle.weekCompare returns.
   */
  function compareLine(cmp) {
    if (!cmp) return '';
    var fig = function (n) { return '<b>' + esc(n > 0 ? money(n) : '£0') + '</b>'; };
    var head = (cmp.partial ? 'This week so far ' : 'This week ') + fig(cmp.thisWeek.total);
    if (!cmp.lastWeek.jobs) {
      return head + ' &middot; nothing in the same stretch last week';
    }
    var was = (cmp.partial ? 'same point last week ' : 'last week ') + fig(cmp.lastWeek.total);
    var change;
    if (cmp.direction === 'level') change = 'level';
    else change = (cmp.direction === 'up' ? 'up ' : 'down ') + esc(money(Math.abs(cmp.delta))) +
                  (cmp.pct == null ? '' : ' (' + Math.abs(cmp.pct) + '%)');
    return head + ' &middot; ' + was + ' &middot; <span class="wm-compare-d">' + change + '</span>';
  }

  return {
    HISTORY_COLUMNS: HISTORY_COLUMNS,
    STATUS_COLUMN: STATUS_COLUMN,
    historyColumnsFor: historyColumnsFor,
    isCancelled: isCancelled,
    DRIVER_TRIP_COLUMNS: DRIVER_TRIP_COLUMNS,
    PAYOUT_COLUMNS: PAYOUT_COLUMNS,
    payoutCells: payoutCells,
    payoutTable: payoutTable,
    PAY_LABELS: PAY_LABELS,
    shortDate: shortDate,
    shortPlace: shortPlace,
    payMethod: payMethod,
    payMethodLabel: payMethodLabel,
    money: money,
    paidLine: paidLine,
    isPaid: isPaid,
    historyCells: historyCells,
    driverTripCells: driverTripCells,
    tableHtml: tableHtml,
    historyTable: historyTable,
    JOURNEY_COLUMNS: JOURNEY_COLUMNS,
    journeyTable: journeyTable,
    SPEND_COLUMNS: SPEND_COLUMNS,
    CUSTOMER_COLUMNS: CUSTOMER_COLUMNS,
    spendTable: spendTable,
    customerTable: customerTable,
    spendCells: spendCells,
    journeyCells: journeyCells,
    driverTripTable: driverTripTable,
    compareLine: compareLine,
    _spec: 'list = a few short columns; the row opens a detail page carrying everything else'
  };
}));
