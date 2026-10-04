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

  function money(n) {
    var v = Number(n);
    if (!isFinite(v) || !n) return '—';
    return '£' + v.toFixed(2).replace(/\.00$/, '');
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
    var cols_ = '<colgroup>' + cols.map(function (c) {
      return '<col style="width:' + (c.w || 'auto') + '">';
    }).join('') + '<col class="wm-ctab-colchev"></colgroup>';

    var head = '<thead><tr>' + cols.map(function (c) {
      return '<th class="wm-ctab-h' + (c.num ? ' num' : '') + '">' + esc(c.label) + '</th>';
    }).join('') + '<th class="wm-ctab-h wm-ctab-chev" aria-hidden="true"></th></tr></thead>';

    var body = '<tbody>' + items.map(function (j) {
      var v = cells(j);
      /* The id goes into an HTML ATTRIBUTE that contains JS, so it is escaped
         twice over: JSON for the JavaScript string, then HTML for the
         attribute it sits in. One without the other and a quote in an id ends
         the attribute early. */
      var id = esc(JSON.stringify(String(j.id)));
      return '<tr class="wm-ctab-r' + (isCancelled(j) ? ' is-cancelled' : '') + '" tabindex="0" role="button"'
        + ' aria-label="' + esc((v.name || '') + ' ' + (v.date || '') + ' ' + (v.ref || '')
            + (isCancelled(j) ? ' — cancelled' : '') + ' — open the full details') + '"'
        + ' onclick="' + open + '(' + id + ')"'
        + ' onkeydown="if(event.key===&#39;Enter&#39;||event.key===&#39; &#39;){event.preventDefault();' + open + '(' + id + ');}">'
        + cols.map(function (c) {
            return '<td class="wm-ctab-c' + (c.num ? ' num' : '') + '">' + esc(v[c.key] == null ? '' : v[c.key]) + '</td>';
          }).join('')
        + '<td class="wm-ctab-c wm-ctab-chev" aria-hidden="true">›</td>'
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
  function driverTripTable(items, open, opts) {
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    o.kind = 'trips';
    return tableHtml(DRIVER_TRIP_COLUMNS, items || [], driverTripCells, open, o);
  }

  return {
    HISTORY_COLUMNS: HISTORY_COLUMNS,
    STATUS_COLUMN: STATUS_COLUMN,
    historyColumnsFor: historyColumnsFor,
    isCancelled: isCancelled,
    DRIVER_TRIP_COLUMNS: DRIVER_TRIP_COLUMNS,
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
    driverTripTable: driverTripTable,
    _spec: 'list = a few short columns; the row opens a detail page carrying everything else'
  };
}));
