/* ── THE OPERATOR INVOICE'S ARITHMETIC, IN ONE PLACE ───────────────────────
   Loaded by the owner app and the admin app. Neither keeps its own copy.

   WHY THIS FILE EXISTS
     The owner app got the job sheet — a row per job, the toll in a column of
     its own, ten per cent of the fares and nothing else, and a fare the driver
     already took netted off the payout. The admin app did not, and went on
     posting {date, description, amount}: no rate, no toll, no tick. The same
     seven jobs came to £616.50 through one door and £675 through the other.

     Two screens computing the same settlement is how they end up disagreeing,
     and the disagreement is invisible until somebody's accounts department
     finds it. So the sum lives here, and the pages ask it.

   WHAT THE SETTLEMENT IS
       fares − commission + tolls − collected by the driver
     with commission taken on the FARES ONLY. A toll is money laid out at a
     barrier, not money earned; charging a tenth of it and then counting it a
     second time as a fee is what put APD's August £39.10 over.

   GUARDRAIL: server/tests/invoice-table.test.js — the arithmetic here is
   executed against APD's real month, and both pages are checked for using it.  */
(function (global) {
  'use strict';

  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var money = function (n) { return '£' + (Number(n) || 0).toFixed(2); };

  /* THE ROW COMMISSIONS ARE FOR READING, THE TOTAL IS FOR BILLING.
     Each row shows its own ten per cent the way an operator's sheet does — but
     the total is ten per cent of the FARES, computed once, because that is what
     the server writes onto the invoice. Adding up rounded rows instead can land
     a penny away from the document, and a screen that disagrees with the bill
     is the whole reason the screen exists. */
  function compute(rows, pct) {
    var rate = (isFinite(+pct) && +pct > 0) ? +pct : 0;
    var out = { rows: [], fares: 0, tolls: 0, commission: 0, collected: 0, total: 0, pct: rate };
    (rows || []).forEach(function (r) {
      var fare = (+r.fare) || 0, toll = (+r.toll) || 0;
      out.rows.push({ fare: r2(fare), toll: r2(toll),
                      commission: r2(fare * (rate / 100)), collected: !!r.collected });
      out.fares = r2(out.fares + fare);
      out.tolls = r2(out.tolls + toll);
      /* NETTED ONLY UNDER AN ARRANGEMENT. No rate means no operator and no
         settlement — it is a plain invoice, which has no Card column and must
         not have money taken off it by a flag left over from one. The server
         applies the same rule, so the screen and the document cannot disagree. */
      if (r.collected && rate > 0) out.collected = r2(out.collected + fare);
    });
    out.commission = r2(out.fares * (rate / 100));
    out.total = r2(out.fares - out.commission + out.tolls - out.collected);
    return out;
  }

  /* ── THE COLUMNS ─────────────────────────────────────────────────────────
     Two shapes, one set of headings and one set of totals.

       'stacked'  the owner app — a phone. Seven columns across do not fit
                  375px: the addresses ate the width and every money column sat
                  off the right-hand edge. The journey goes on one line and the
                  four figures on the next, in a grid that lines up down the
                  page and under the totals.

       'flat'     the admin app — a desktop modal, wide enough to hold the
                  operator's sheet the way they actually write it: one row per
                  job, every column across.

     The grid templates are passed in by the page, so a page can change its own
     widths without touching anybody else's — but the COLUMNS, their order and
     their headings are decided here, once. */
  var CAP = 'font-size:.64rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(27,27,26,.45)';

  function headHtml(o) {
    o = o || {};
    var c = CAP, R = CAP + ';text-align:right', M = CAP + ';text-align:center';
    var card = '<div style="' + M + '" title="The driver was paid this fare directly">Card</div>';
    var money4 = card
      + '<div style="' + R + '">Fare</div><div style="' + R + '">Com.</div>'
      + '<div style="' + R + '">Toll</div><div></div>';
    if (o.mode === 'flat') {
      return '<div style="display:grid;grid-template-columns:' + o.grid + ';gap:.35rem;'
        + 'padding-bottom:.3rem;border-bottom:1px solid rgba(27,27,26,.15);margin-bottom:.35rem">'
        + '<div style="' + c + '">Date</div><div style="' + c + '">From</div><div style="' + c + '">To</div>'
        + money4 + '</div>';
    }
    return '<div style="display:flex;gap:.3rem;margin-bottom:.15rem">'
      + '<div style="' + c + ';width:' + o.trip + ';flex:0 0 ' + o.trip + '">Date</div>'
      + '<div style="' + c + ';flex:1">From</div><div style="' + c + ';flex:1">To</div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:' + o.money + ';gap:.25rem;justify-content:end;'
      + 'padding-bottom:.25rem;border-bottom:1px solid rgba(27,27,26,.15);margin-bottom:.3rem">'
      + money4 + '</div>';
  }

  /* THE TOTALS, under their own columns — the way they sit on the sheet the
     owner is checking against. A totals line floating free of its columns has
     to be read twice. */
  function totalsHtml(m, o) {
    o = o || {};
    var V = 'font-family:var(--serif);font-size:.92rem;color:var(--navy);text-align:right';
    /* −£50.00 is wider than the Card column. Right-aligned and unwrapped it
       overflows to the LEFT, into empty space, instead of folding onto a second
       line and pushing the other three totals out of line with their columns. */
    var figures =
        '<div class="wm-t-collected" style="' + V + ';font-size:.78rem;white-space:nowrap;overflow:visible">'
      + (m.collected > 0 ? ('&minus;' + money(m.collected)) : '&mdash;') + '</div>'
      + '<div class="wm-t-fares" style="' + V + '">' + money(m.fares) + '</div>'
      + '<div class="wm-t-com" style="' + V + '">' + money(m.commission) + '</div>'
      + '<div class="wm-t-tolls" style="' + V + '">' + money(m.tolls) + '</div><div></div>';
    var caps =
        '<div style="' + CAP + ';text-align:center">Card</div>'
      + '<div style="' + CAP + ';text-align:right">Fares</div>'
      + '<div style="' + CAP + ';text-align:right">Com.</div>'
      + '<div style="' + CAP + ';text-align:right">Tolls</div><div></div>';
    if (o.mode === 'flat') {
      return '<div style="padding-top:.45rem;margin-top:.35rem;border-top:1px solid rgba(27,27,26,.25)">'
        + '<div style="display:grid;grid-template-columns:' + o.grid + ';gap:.35rem;align-items:baseline">'
        + '<div style="' + CAP + ';grid-column:1 / span 3">Totals</div>' + figures + '</div></div>';
    }
    return '<div style="padding-top:.45rem;margin-top:.35rem;border-top:1px solid rgba(27,27,26,.25)">'
      + '<div style="display:grid;grid-template-columns:' + o.money + ';gap:.25rem;justify-content:end;align-items:baseline">'
      + figures + '</div>'
      + '<div style="display:grid;grid-template-columns:' + o.money + ';gap:.25rem;justify-content:end;margin-top:.1rem">'
      + caps + '</div></div>';
  }

  /* THE FIGURE HE IS HERE FOR, and the four steps that produce it written out
     underneath — because on a phone the column totals are off to the right, and
     because this is the number he reads down the telephone. */
  function payoutHtml(m) {
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:.7rem;'
      + 'margin-top:.6rem;padding-top:.55rem;border-top:2px solid var(--navy)">'
      + '<span style="font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(27,27,26,.5)">Pay out</span>'
      + '<span class="wm-payout" style="font-family:var(--serif);font-size:1.4rem;color:var(--navy)">'
      + money(m.total) + '</span></div>'
      + '<div style="text-align:right;font-size:.74rem;color:rgba(27,27,26,.5);margin-top:.15rem;line-height:1.5">'
      + 'Fares ' + money(m.fares)
      + ' &minus; ' + m.pct + '% commission ' + money(m.commission)
      + ' + tolls ' + money(m.tolls)
      + (m.collected > 0 ? (' &minus; collected by driver ' + money(m.collected)) : '')
      + '</div>';
  }

  global.WMInvoiceMaths = {
    compute: compute,
    headHtml: headHtml,
    totalsHtml: totalsHtml,
    payoutHtml: payoutHtml,
    money: money
  };
})(typeof window !== 'undefined' ? window : this);

/* Node can require this file too — the guards run the arithmetic directly
   rather than lifting it out of a page with a regular expression. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : this).WMInvoiceMaths;
}
