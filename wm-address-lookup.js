/* SHARED ADDRESS LOOKUP — the same one the booking form uses.
 *
 * WHY IT IS A FILE AND NOT A COPY
 *   The booking page has had a Nominatim autocomplete since it was built, with
 *   two pieces of hard-won behaviour in it: results are de-duplicated on what
 *   the customer SEES (the geocoder returns the terminal, the polygon and the
 *   site in two districts, all of which shorten to "Gatwick Airport"), and the
 *   picked address is remembered in FULL on the element while the box shows the
 *   short form. Both matter here too — an invoice line has to display "Gatwick
 *   Airport" and store the precise string.
 *
 *   That logic lives inside booking-app.js's IIFE and is not exported, and
 *   booking-app.js also wires the fare estimator and the booking submit, so the
 *   owner app cannot simply load it. This is that component on its own.
 *
 *   HONEST LIMITATION: booking-app.js still has its own copy. Unifying them
 *   means editing the live booking path, which is not what this change is for.
 *   The display half is already shared through WMAddr (address-normalize.js),
 *   so the two cannot drift on how an address READS — only on how it is looked
 *   up.
 *
 * USE: WMLookup.attach(inputElement)  → autocomplete on that input
 *      WMLookup.full(inputElement)    → the resolved address, or what was typed
 */
(function () {
  'use strict';

  function brief(s) {
    return (window.WMAddr && window.WMAddr.briefDisplay)
      ? (window.WMAddr.briefDisplay(s) || s) : s;
  }

  /** The precise string, falling back to whatever was typed by hand. */
  function full(input) {
    if (!input) return '';
    var f = input.dataset ? input.dataset.fullAddress : '';
    return (f && f.trim()) ? f : (input.value || '').trim();
  }

  function set(input, addr) {
    if (!input) return;
    input.value = brief(addr);
    input.dataset.fullAddress = addr;
  }

  function attach(input) {
    if (!input || input.dataset.wmLookup === '1') return;
    input.dataset.wmLookup = '1';
    input.setAttribute('autocomplete', 'off');

    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;z-index:70;left:0;right:0;top:100%;background:#fff;' +
      'border:1px solid rgba(27,27,26,.18);border-radius:6px;box-shadow:0 8px 24px rgba(16,42,67,.14);' +
      'max-height:220px;overflow:auto;display:none';
    if (getComputedStyle(input.parentNode).position === 'static') input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(box);

    var timer = null;
    var hide = function () { box.style.display = 'none'; };

    input.addEventListener('input', function () {
      /* Typing replaces a picked suggestion, so the remembered full address is
         no longer this address. Without this, editing a chosen pickup sends the
         OLD string while showing the new text. */
      if (input.dataset) delete input.dataset.fullAddress;
      if (timer) clearTimeout(timer);
      var v = input.value.trim();
      if (v.length < 3) { hide(); return; }
      timer = setTimeout(function () {
        fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(v) +
              '&format=json&addressdetails=1&limit=5&countrycodes=gb')
          .then(function (r) { return r.json(); })
          .then(function (arr) {
            box.innerHTML = '';
            if (!arr || !arr.length) { hide(); return; }
            /* DE-DUPLICATE ON WHAT THE OWNER SEES, keyed on the label PLUS the
               place's own first segment. On the label alone this would hide
               "Gatwick Airport Railway Station", which shortens to the same
               words as the airport — a de-duplicator that removes a place
               somebody wanted is worse than the duplicates it was written for.
               First occurrence wins: Nominatim returns relevance order. */
            var seen = {}, n = 0;
            arr.forEach(function (r) {
              var label = brief(r.display_name);
              var own = String(r.display_name || '').split(',')[0];
              var key = (label + '|' + own).toLowerCase().replace(/\s+/g, ' ').trim();
              if (seen[key]) return;
              seen[key] = 1; n++;
              var row = document.createElement('div');
              row.textContent = label;
              row.title = r.display_name;
              row.style.cssText = 'padding:.55rem .7rem;font-size:.88rem;color:#102a43;cursor:pointer;' +
                'border-bottom:1px solid rgba(27,27,26,.06)';
              row.onmouseenter = function () { row.style.background = 'rgba(27,27,26,.04)'; };
              row.onmouseleave = function () { row.style.background = 'transparent'; };
              row.onmousedown = function (e) {
                e.preventDefault();                 // before the input's blur
                set(input, r.display_name);
                hide();
                input.dispatchEvent(new Event('change', { bubbles: true }));
              };
              box.appendChild(row);
            });
            box.style.display = n ? 'block' : 'none';
          })
          .catch(hide);
      }, 300);
    });
    input.addEventListener('blur', function () { setTimeout(hide, 150); });
  }

  window.WMLookup = { attach: attach, full: full, set: set, brief: brief };
})();
