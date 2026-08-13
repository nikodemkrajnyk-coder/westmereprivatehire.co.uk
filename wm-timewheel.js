/* Westmere time wheel — the iOS-clock style time picker.
 *
 * ONE component, used by BOTH the public booking form (wm-picker.js) and My
 * Account (westmere-rider.html). The two used to have separate time pickers
 * that looked different from each other: the booking form was a grid of 96
 * tappable HH:MM buttons, My Account was two tap-lists. The owner asked for a
 * spin wheel, and for the two surfaces to be identical — so this is a single
 * definition rather than the same idea implemented twice.
 *
 * VALUE CONTRACT — deliberately unchanged: it takes and returns "HH:MM" on a
 * 24-hour clock, exactly what both forms stored before. Nothing downstream
 * (the fare engine, the booking record, the emails) sees any difference.
 *
 * The wheel is native scrolling with CSS scroll-snap, so momentum, rubber-band
 * and accessibility all come from the platform rather than from a gesture
 * library. Selection is read from scrollTop, which means a flick that lands
 * between two rows still resolves to whichever row snapped to the centre.
 *
 * Keyboard: ↑/↓ move the focused column, Tab moves between columns, Enter
 * confirms, Escape cancels. Each column is a real listbox, so a screen reader
 * announces the value.
 *
 * GUARDRAIL: server/tests/time-wheel.test.js
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WMTimeWheel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROW_H = 42;          // must match .wmtw-opt height in the CSS below
  var VISIBLE = 5;         // rows shown; odd so there is a true centre row
  var MIN_STEP = 5;        // minutes granularity

  function pad(n) { return String(n).padStart(2, '0'); }
  function isTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()); }

  // Snap an arbitrary minute onto the wheel's step, carrying the hour if it
  // rounds past the top of the hour.
  function normalise(hhmm) {
    var h = 9, m = 0;
    if (isTime(hhmm)) { h = parseInt(hhmm.slice(0, 2), 10); m = parseInt(hhmm.slice(3, 5), 10); }
    m = Math.round(m / MIN_STEP) * MIN_STEP;
    if (m >= 60) { m = 0; h = (h + 1) % 24; }
    return { h: h, m: m };
  }

  var STYLE_ID = 'wmtw-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    // The selected row is an outlined frame, never a filled block — the same
    // language the date/passenger pickers use.
    st.textContent = [
      '.wmtw-back{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;',
      'background:rgba(16,42,67,.42);padding:20px}',
      '.wmtw{background:#fff;border:1px solid #dfe5ea;border-radius:16px;width:100%;max-width:340px;',
      'box-shadow:0 24px 60px rgba(16,42,67,.22);overflow:hidden;font-family:inherit}',
      '.wmtw-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;',
      'border-bottom:1px solid #dfe5ea}',
      '.wmtw-ttl{font-size:.95rem;color:#102a43;letter-spacing:.02em}',
      '.wmtw-x{background:none;border:none;font-size:1.3rem;line-height:1;color:#102a43;cursor:pointer;padding:2px 6px;border-radius:8px}',
      '.wmtw-body{position:relative;display:flex;justify-content:center;gap:6px;padding:10px 16px 4px}',
      '.wmtw-col{height:' + (ROW_H * VISIBLE) + 'px;overflow-y:scroll;scroll-snap-type:y mandatory;',
      'scrollbar-width:none;-ms-overflow-style:none;flex:0 0 84px;text-align:center;',
      'overscroll-behavior:contain;-webkit-overflow-scrolling:touch;outline:none}',
      '.wmtw-col::-webkit-scrollbar{display:none}',
      '.wmtw-opt{height:' + ROW_H + 'px;line-height:' + ROW_H + 'px;scroll-snap-align:center;',
      'font-size:1.32rem;color:rgba(16,42,67,.34);cursor:pointer;transition:color .12s;',
      'font-variant-numeric:tabular-nums}',
      '.wmtw-opt.is-on{color:#102a43;font-weight:500}',
      '.wmtw-sep{align-self:center;font-size:1.32rem;color:#102a43;padding-bottom:2px}',
      // The centre band: a frame, not a fill.
      '.wmtw-band{position:absolute;left:16px;right:16px;top:50%;height:' + ROW_H + 'px;',
      'transform:translateY(-50%);border:1.5px solid #102a43;border-radius:10px;pointer-events:none}',
      '.wmtw-ft{display:flex;gap:10px;padding:12px 16px 16px}',
      '.wmtw-btn{flex:1;padding:11px 0;border-radius:8px;border:1px solid #102a43;background:#fff;',
      'color:#102a43;font-family:inherit;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}',
      '.wmtw-btn.is-ghost{border-color:#c8d1d9;color:#657485}',
      '.wmtw-col:focus-visible{box-shadow:inset 0 0 0 2px rgba(16,42,67,.35);border-radius:10px}'
    ].join('');
    document.head.appendChild(st);
  }

  function buildColumn(values, selectedIdx, label) {
    var col = document.createElement('div');
    col.className = 'wmtw-col';
    col.tabIndex = 0;
    col.setAttribute('role', 'listbox');
    col.setAttribute('aria-label', label);
    // Half-height spacers so the first and last rows can reach the centre.
    var padPx = (ROW_H * (VISIBLE - 1)) / 2;
    var spacerTop = document.createElement('div'); spacerTop.style.height = padPx + 'px';
    var spacerBot = document.createElement('div'); spacerBot.style.height = padPx + 'px';
    col.appendChild(spacerTop);
    values.forEach(function (v, i) {
      var o = document.createElement('div');
      o.className = 'wmtw-opt' + (i === selectedIdx ? ' is-on' : '');
      o.textContent = v;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', i === selectedIdx ? 'true' : 'false');
      o.dataset.i = String(i);
      col.appendChild(o);
    });
    col.appendChild(spacerBot);
    return col;
  }

  function indexOf(col) {
    return Math.round(col.scrollTop / ROW_H);
  }
  function scrollToIndex(col, i, smooth) {
    col.scrollTo({ top: i * ROW_H, behavior: smooth ? 'smooth' : 'auto' });
  }
  function paint(col, idx) {
    var opts = col.querySelectorAll('.wmtw-opt');
    for (var i = 0; i < opts.length; i++) {
      var on = i === idx;
      opts[i].classList.toggle('is-on', on);
      opts[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  /* open({ value, title, onConfirm, onCancel }) */
  function open(opts) {
    opts = opts || {};
    injectStyle();
    var start = normalise(opts.value);

    var hours = [], mins = [];
    for (var h = 0; h < 24; h++) hours.push(pad(h));
    for (var m = 0; m < 60; m += MIN_STEP) mins.push(pad(m));
    var hIdx = start.h, mIdx = Math.round(start.m / MIN_STEP) % mins.length;

    var back = document.createElement('div');
    back.className = 'wmtw-back';
    var box = document.createElement('div');
    box.className = 'wmtw';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', opts.title || 'Choose a time');

    var hd = document.createElement('div');
    hd.className = 'wmtw-hd';
    hd.innerHTML = '<span class="wmtw-ttl">' + (opts.title || 'Pick a time') + '</span>';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'wmtw-x'; x.setAttribute('aria-label', 'Close'); x.innerHTML = '&times;';
    hd.appendChild(x);

    var body = document.createElement('div');
    body.className = 'wmtw-body';
    var hCol = buildColumn(hours, hIdx, 'Hour');
    var sep = document.createElement('div'); sep.className = 'wmtw-sep'; sep.textContent = ':';
    var mCol = buildColumn(mins, mIdx, 'Minute');
    var band = document.createElement('div'); band.className = 'wmtw-band';
    body.appendChild(hCol); body.appendChild(sep); body.appendChild(mCol); body.appendChild(band);

    var ft = document.createElement('div');
    ft.className = 'wmtw-ft';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'wmtw-btn is-ghost'; cancel.textContent = 'Cancel';
    var done = document.createElement('button');
    done.type = 'button'; done.className = 'wmtw-btn'; done.textContent = 'Done';
    ft.appendChild(cancel); ft.appendChild(done);

    box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
    back.appendChild(box);
    document.body.appendChild(back);

    // Position without animation, then let the user scroll.
    scrollToIndex(hCol, hIdx, false);
    scrollToIndex(mCol, mIdx, false);

    // The authoritative selection. scroll-snap settles asynchronously, so
    // reading scrollTop at the moment Done is pressed can catch a column
    // mid-snap and return the neighbouring row. Track it as it changes instead.
    var cur = { h: hIdx, m: mIdx };
    var settle = null;
    function onScroll(col, which) {
      return function () {
        var i = indexOf(col);
        cur[which] = i;
        paint(col, i);
        if (settle) clearTimeout(settle);
        settle = setTimeout(function () {
          var j = indexOf(col);
          cur[which] = j;
          paint(col, j);
        }, 60);
      };
    }
    hCol.addEventListener('scroll', onScroll(hCol, 'h'), { passive: true });
    mCol.addEventListener('scroll', onScroll(mCol, 'm'), { passive: true });

    // Tapping a row selects it (a wheel you can only flick is hard to aim).
    function onTap(col, which) {
      return function (e) {
        var t = e.target.closest ? e.target.closest('.wmtw-opt') : null;
        if (!t) return;
        var i = parseInt(t.dataset.i, 10);
        cur[which] = i;
        scrollToIndex(col, i, true);
        paint(col, i);
      };
    }
    hCol.addEventListener('click', onTap(hCol, 'h'));
    mCol.addEventListener('click', onTap(mCol, 'm'));

    function key(e) {
      var col = document.activeElement === mCol ? mCol : (document.activeElement === hCol ? hCol : null);
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key === 'Enter') { e.preventDefault(); close(true); return; }
      if (!col) return;
      var n = col.querySelectorAll('.wmtw-opt').length;
      var w = col === mCol ? 'm' : 'h';
      if (e.key === 'ArrowDown') { e.preventDefault(); var d = Math.min(n - 1, cur[w] + 1); cur[w] = d; scrollToIndex(col, d, true); paint(col, d); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); var u = Math.max(0, cur[w] - 1); cur[w] = u; scrollToIndex(col, u, true); paint(col, u); }
    }
    document.addEventListener('keydown', key);

    function value() {
      return pad(Math.min(23, Math.max(0, cur.h))) + ':' +
             pad(Math.min(60 - MIN_STEP, Math.max(0, cur.m * MIN_STEP)));
    }
    function close(confirmed) {
      document.removeEventListener('keydown', key);
      if (back.parentNode) back.parentNode.removeChild(back);
      if (confirmed) { if (opts.onConfirm) opts.onConfirm(value()); }
      else if (opts.onCancel) opts.onCancel();
    }

    done.addEventListener('click', function () { close(true); });
    cancel.addEventListener('click', function () { close(false); });
    x.addEventListener('click', function () { close(false); });
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(false); });

    hCol.focus({ preventScroll: true });
    return { close: close, value: value };
  }

  return { open: open, _normalise: normalise, _isTime: isTime, ROW_H: ROW_H, MIN_STEP: MIN_STEP };
}));
