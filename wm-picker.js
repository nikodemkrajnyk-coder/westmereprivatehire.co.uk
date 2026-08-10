/* Westmere custom date & time picker.
 *
 * Replaces the NATIVE <input type=date|time> popups on booking forms with a
 * self-contained, always-LIGHT widget. Native mobile / in-app browser pickers
 * (WhatsApp / Instagram / Facebook in-app WebViews, Samsung Internet dark mode,
 * older Android WebView, some iOS versions) render the calendar & time popup
 * dark-on-dark in device dark mode — the reported "I can't see what I'm doing"
 * booking blocker. `color-scheme:light` on the input alone does NOT tame those
 * environments, so we stop relying on the native popup entirely.
 *
 * The real <input> is kept (visually hidden) as the value store, so form
 * submission, the live fare estimate and everything downstream are unchanged —
 * this only swaps the picker UI. If this script fails to load, the native input
 * is left fully functional (with the existing color-scheme:light fallback).
 */
(function () {
  'use strict';

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var CAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>';
  var CLK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.4 2"/></svg>';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function sameDay(a, b) { return !!(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()); }
  function fmtDate(d) { return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear(); }
  function fmtTime(s) {
    var m = /^(\d{2}):(\d{2})/.exec(s);
    if (!m) return s;
    var h = +m[1], ap = h < 12 ? 'am' : 'pm', h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + m[2] + ' ' + ap;
  }

  var openBackdrop = null;
  function closePopup() {
    if (openBackdrop && openBackdrop.parentNode) openBackdrop.parentNode.removeChild(openBackdrop);
    openBackdrop = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Esc') closePopup(); }

  function makeBackdrop() {
    var bd = document.createElement('div');
    bd.className = 'wm-pop-backdrop';
    bd.addEventListener('mousedown', function (e) { if (e.target === bd) closePopup(); });
    return bd;
  }

  function fire(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setFieldValue(field, text) {
    field.querySelector('.wm-field-val').textContent = text;
    field.classList.remove('is-empty');
  }

  // ── DATE popup ─────────────────────────────────────────────────────────
  function openDate(input, field) {
    closePopup();
    var min = parseDate(input.getAttribute('min'));
    var minDay = min ? startOfDay(min) : null;
    var selected = parseDate(input.value);
    var today = startOfDay(new Date());
    var base = selected || today;
    var view = new Date(base.getFullYear(), base.getMonth(), 1);

    var bd = makeBackdrop();
    var pop = document.createElement('div');
    pop.className = 'wm-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a date');
    bd.appendChild(pop);

    function render() {
      var y = view.getFullYear(), mo = view.getMonth();
      var startDow = new Date(y, mo, 1).getDay();
      var days = new Date(y, mo + 1, 0).getDate();
      var prevDisabled = !!(minDay && new Date(y, mo, 1) <= new Date(minDay.getFullYear(), minDay.getMonth(), 1));

      var html = '<div class="wm-pop-head">'
        + '<button type="button" class="wm-nav" data-prev ' + (prevDisabled ? 'disabled' : '') + ' aria-label="Previous month">‹</button>'
        + '<span class="wm-pop-title">' + MONTHS[mo] + ' ' + y + '</span>'
        + '<button type="button" class="wm-nav" data-next aria-label="Next month">›</button></div>';
      html += '<div class="wm-dow">' + DOW.map(function (d) { return '<span>' + d[0] + '</span>'; }).join('') + '</div>';
      html += '<div class="wm-grid">';
      for (var i = 0; i < startDow; i++) html += '<button type="button" class="wm-day is-empty" disabled></button>';
      for (var dnum = 1; dnum <= days; dnum++) {
        var cur = new Date(y, mo, dnum);
        var dis = !!(minDay && cur < minDay);
        var cls = 'wm-day';
        if (sameDay(cur, selected)) cls += ' is-selected';
        if (sameDay(cur, today)) cls += ' is-today';
        html += '<button type="button" class="' + cls + '" data-day="' + dnum + '" ' + (dis ? 'disabled' : '') + '>' + dnum + '</button>';
      }
      html += '</div>';
      pop.innerHTML = html;

      var prev = pop.querySelector('[data-prev]');
      if (prev) prev.addEventListener('click', function () { if (!prevDisabled) { view = new Date(y, mo - 1, 1); render(); } });
      pop.querySelector('[data-next]').addEventListener('click', function () { view = new Date(y, mo + 1, 1); render(); });
      Array.prototype.forEach.call(pop.querySelectorAll('[data-day]'), function (b) {
        b.addEventListener('click', function () {
          var d = new Date(y, mo, +b.getAttribute('data-day'));
          input.value = isoDate(d);
          setFieldValue(field, fmtDate(d));
          fire(input);
          closePopup();
        });
      });
    }

    render();
    document.body.appendChild(bd);
    document.addEventListener('keydown', onKey);
    openBackdrop = bd;
  }

  // ── TIME popup ─────────────────────────────────────────────────────────
  function openTime(input, field) {
    closePopup();
    var cur = input.value;
    var bd = makeBackdrop();
    var pop = document.createElement('div');
    pop.className = 'wm-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a time');

    var html = '<div class="wm-pop-head"><span class="wm-pop-title">Pick a time</span>'
      + '<button type="button" class="wm-nav" data-close aria-label="Close">×</button></div>';
    html += '<div class="wm-sub">Tap a time (24-hour clock)</div>';
    html += '<div class="wm-times">';
    for (var h = 0; h < 24; h++) {
      for (var mi = 0; mi < 60; mi += 15) {
        var t = pad(h) + ':' + pad(mi);
        html += '<button type="button" class="wm-time' + (t === cur ? ' is-selected' : '') + '" data-t="' + t + '">' + t + '</button>';
      }
    }
    html += '</div>';
    pop.innerHTML = html;
    bd.appendChild(pop);

    pop.querySelector('[data-close]').addEventListener('click', closePopup);
    Array.prototype.forEach.call(pop.querySelectorAll('[data-t]'), function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-t');
        input.value = t;
        setFieldValue(field, fmtTime(t));
        fire(input);
        closePopup();
      });
    });

    document.body.appendChild(bd);
    document.addEventListener('keydown', onKey);
    openBackdrop = bd;

    var sel = pop.querySelector('.wm-time.is-selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'center' });
  }

  // ── Enhance one native input ───────────────────────────────────────────
  function syncFieldFromInput(input, field, isDate, label) {
    if (input.value) {
      if (isDate) { var d = parseDate(input.value); if (d) setFieldValue(field, fmtDate(d)); }
      else setFieldValue(field, fmtTime(input.value));
    } else {
      field.querySelector('.wm-field-val').textContent = label;
      field.classList.add('is-empty');
    }
  }

  function enhance(input) {
    if (input.dataset.wmEnhanced) return;
    input.dataset.wmEnhanced = '1';
    var isDate = input.type === 'date';
    var label = isDate ? 'Select date' : 'Select time';

    input.classList.add('wm-native-hidden');
    input.setAttribute('tabindex', '-1');
    input.setAttribute('aria-hidden', 'true');

    var field = document.createElement('button');
    field.type = 'button';
    field.className = 'wm-field is-empty';
    field.innerHTML = '<span class="wm-field-val">' + label + '</span>'
      + '<span class="wm-field-ic">' + (isDate ? CAL_SVG : CLK_SVG) + '</span>';

    syncFieldFromInput(input, field, isDate, label);

    field.addEventListener('click', function () { (isDate ? openDate : openTime)(input, field); });
    input.parentNode.insertBefore(field, input.nextSibling);

    // Keep the visible field in sync if the value is changed programmatically
    // (prefill) or the form is reset after a successful booking.
    input.addEventListener('change', function () { syncFieldFromInput(input, field, isDate, label); });
    if (input.form) input.form.addEventListener('reset', function () {
      setTimeout(function () { syncFieldFromInput(input, field, isDate, label); }, 0);
    });
  }

  function init() {
    var forms = document.querySelectorAll('form[data-booking-form]');
    Array.prototype.forEach.call(forms, function (f) {
      Array.prototype.forEach.call(f.querySelectorAll('input[type=date],input[type=time]'), enhance);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
