/* Westmere booking form engine (client) — powers the template Request-a-Quote form.
 * Fare logic is a faithful port of server/fare-engine.js (same FARE_CF table,
 * same town/airport matching, same tapered per-mile formula) so the live
 * estimate matches the real engine. Geocoding via Nominatim, routing via OSRM
 * (same services the server engine uses). On submit it POSTs the exact wizard
 * payload to /api/public/book — nothing downstream changes.
 */
(function () {
  'use strict';

  // ── Fare engine (mirror of server/fare-engine.js) ──────────────────────
  var FARE_CF = {
    // Brighton→Gatwick/Heathrow are owner-set FLAT ALL-IN fares (mirror of
    // server/fare-engine.js) — marked in FARE_CF_ALLIN so the airport fee/toll is
    // NOT added on top (£70/£125 already includes it). Both directions.
    brighton:      { ga:{out:70,ret:70}, he:{out:125,ret:125}, st:{out:188,ret:192}, lu:{out:176,ret:181}, so:{out:138,ret:135}, ci:{out:151,ret:154} },
    lewes:         { ga:{out:91,ret:88}, he:{out:129,ret:133}, st:{out:193,ret:197}, lu:{out:181,ret:184}, so:{out:140,ret:138}, ci:{out:155,ret:158} },
    horsham:       { ga:{out:54,ret:52},  he:{out:94,ret:99}, st:{out:141,ret:145}, lu:{out:120,ret:122}, so:{out:104,ret:101}, ci:{out:124,ret:128} },
    crawley:       { ga:{out:45,ret:43},  he:{out:82,ret:86} },
    worthing:      { ga:{out:85,ret:82}, he:{out:121,ret:123} },
    haywards:      { ga:{out:63,ret:62}, he:{out:105,ret:109}, lu:{out:142,ret:145}, st:{out:135,ret:139}, so:{out:112,ret:109}, ci:{out:120,ret:123} },
    burgess:       { ga:{out:63,ret:61}, he:{out:114,ret:118}, lu:{out:159,ret:162}, st:{out:161,ret:165}, so:{out:114,ret:111}, ci:{out:135,ret:138} },
    eastbourne:    { ga:{out:119,ret:117}, he:{out:158,ret:163} },
    seaford:       { ga:{out:108,ret:105} },
    uckfield:      { ga:{out:73,ret:70} },
    eastgrinstead: { ga:{out:62,ret:58} }
  };
  var FARE_APFULL = { ga:'Gatwick', he:'Heathrow', st:'Stansted', lu:'Luton', so:'Southampton', ci:'London City' };
  // Town→airport fixed fares that are ALL-IN (fee/toll already baked into the
  // FARE_CF value) — mirror of server/fare-engine.js FARE_CF_ALLIN.
  var FARE_CF_ALLIN = { brighton:{ ga:true, he:true } };
  function isAllIn(town, ap) { return !!(FARE_CF_ALLIN[town] && FARE_CF_ALLIN[town][ap]); }
  var FARE_AP_COORDS = {
    ga:{lat:51.1537,lon:-0.1821}, he:{lat:51.47,lon:-0.4543},
    st:{lat:51.885,lon:0.235},    lu:{lat:51.8747,lon:-0.3684},
    so:{lat:50.9503,lon:-1.3568}, ci:{lat:51.5048,lon:0.0495}
  };
  // Airport terminal fees + road tolls (mirror of server/fare-engine.js). Added on
  // top of the displayed base fare. dropoff→out, pickup(short-stay)→ret.
  var AIRPORT_FEES = {
    ga:{dropoff:10,pickup:8}, he:{dropoff:7,pickup:8}, lu:{dropoff:7,pickup:7},
    st:{dropoff:10,pickup:13}, so:{dropoff:7,pickup:7}, ci:{dropoff:8,pickup:10}
  };
  var DARTFORD_TOLL = 3.50, BLACKWALL_TOLL = 4.20;
  // Stansted fixed fares already embed the Dartford premium (not re-added); London
  // City base has no tunnel charge so the Blackwall/Silvertown toll is always added.
  function airportToll(ap, isFixed) {
    if (ap === 'st') return isFixed ? 0 : DARTFORD_TOLL;
    if (ap === 'ci') return BLACKWALL_TOLL;
    return 0;
  }
  function normTown(s) {
    if (!s) return null;
    var l = s.toLowerCase();
    var pc = [['rh12','horsham'],['rh13','horsham'],['rh14','horsham'],['bn5','horsham'],
      ['rh10','crawley'],['rh11','crawley'],['rh16','haywards'],['bn6','haywards'],['rh17','haywards'],
      ['rh15','burgess'],['rh19','eastgrinstead'],['bn1','brighton'],['bn2','brighton'],['bn3','brighton'],
      ['bn41','brighton'],['bn10','brighton'],['bn7','lewes'],['bn8','lewes'],['bn9','lewes'],
      ['bn11','worthing'],['bn12','worthing'],['bn13','worthing'],['bn14','worthing'],['bn43','worthing'],
      ['bn44','worthing'],['bn42','worthing'],['bn15','worthing'],['bn21','eastbourne'],['bn22','eastbourne'],
      ['bn23','eastbourne'],['bn26','eastbourne'],['bn25','seaford'],['tn22','uckfield'],['tn21','uckfield'],['tn20','uckfield']];
    for (var i=0;i<pc.length;i++){ if (new RegExp('\\b'+pc[i][0]+'\\b').test(l)) return pc[i][1]; }
    var nm = [['haywards heath','haywards'],['burgess hill','burgess'],['east grinstead','eastgrinstead'],
      ['saltdean','brighton'],['rottingdean','brighton'],['peacehaven','brighton'],['woodingdean','brighton'],
      ['patcham','brighton'],['portslade','brighton'],['moulsecoomb','brighton'],['coldean','brighton'],
      ['hollingbury','brighton'],['withdean','brighton'],['hove','brighton'],['brighton','brighton'],
      ['shoreham','worthing'],['lancing','worthing'],['southwick','worthing'],['worthing','worthing'],
      ['eastbourne','eastbourne'],['polegate','eastbourne'],['seaford','seaford'],['newhaven','lewes'],
      ['lewes','lewes'],['uckfield','uckfield'],['horsham','horsham'],['crawley','crawley']];
    for (var j=0;j<nm.length;j++){ if (l.indexOf(nm[j][0])>=0) return nm[j][1]; }
    return null;
  }
  function normAirport(s) {
    if (!s) return null;
    var l = s.toLowerCase();
    if (l.indexOf('gatwick')>=0) return 'ga';
    if (l.indexOf('heathrow')>=0) return 'he';
    if (l.indexOf('stansted')>=0) return 'st';
    if (l.indexOf('luton')>=0) return 'lu';
    if (l.indexOf('southampton')>=0) return 'so';
    if (l.indexOf('london city')>=0 || l.indexOf('city airport')>=0) return 'ci';
    return null;
  }
  function calcMile(mi, night) {
    var m = Math.max(mi, 10), f;
    if (night) { f = m <= 10 ? m*3.60 : m <= 20 ? 36.0+(m-10)*2.95 : 65.5+(m-20)*2.64; }
    else       { f = m <= 10 ? m*3.79 : m <= 20 ? 37.9+(m-10)*2.37 : 61.6+(m-20)*2.13; }
    return Math.ceil(f/0.5)*0.5;
  }
  function geocode(addr) {
    var q = /\bUK\b/i.test(addr) ? addr : addr + ', UK';
    return fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1&countrycodes=gb', { headers:{ 'Accept':'application/json' } })
      .then(function(r){return r.json();})
      .then(function(a){ return (a && a[0]) ? { lat:parseFloat(a[0].lat), lon:parseFloat(a[0].lon) } : null; })
      .catch(function(){ return null; });
  }
  function route(lat1,lon1,lat2,lon2) {
    return fetch('https://router.project-osrm.org/route/v1/driving/'+lon1+','+lat1+';'+lon2+','+lat2+'?overview=false')
      .then(function(r){return r.json();})
      .then(function(d){ return (d.routes && d.routes.length) ? { distance:d.routes[0].distance, duration:d.routes[0].duration } : null; })
      .catch(function(){ return null; });
  }
  // Faithful port of calculateFare — returns {fare,distance_miles,duration_min,rate_type}
  function calculateFare(pickup, destination, timeStr) {
    var h = timeStr ? parseInt(timeStr.split(':')[0],10) : new Date().getHours();
    var night = h >= 22 || h < 6;
    var rateLabel = night ? 'night rate' : 'day rate';
    var puAP = normAirport(pickup), deAP = normAirport(destination);
    var puT = normTown(pickup), deT = normTown(destination);
    // Destination is airport → add drop-off fee (+ toll)
    if (deAP && !puAP) {
      var feeD = (AIRPORT_FEES[deAP]||{}).dropoff||0;
      if (puT && FARE_CF[puT] && FARE_CF[puT][deAP]) {
        var aiD = isAllIn(puT, deAP); // owner flat fare: fee/toll already included
        var bD = FARE_CF[puT][deAP].out, tD = aiD ? 0 : airportToll(deAP,true), feeDd = aiD ? 0 : feeD;
        return Promise.resolve({ fare:bD+feeDd+tD, base_fare:bD, airport_fee:feeDd, toll_fee:tD, rate_type:'fixed', label:FARE_APFULL[deAP]+' drop-off' });
      }
      var ap = FARE_AP_COORDS[deAP], tDm = airportToll(deAP,false);
      return geocode(pickup).then(function(gc){
        if (gc && ap) return route(gc.lat,gc.lon,ap.lat,ap.lon).then(function(rt){
          if (rt) { var mi=Math.round(rt.distance/1609.34*10)/10; var b=calcMile(mi,night); return { fare:b+feeD+tDm, base_fare:b, airport_fee:feeD, toll_fee:tDm, distance_miles:mi, duration_min:Math.round(rt.duration/60), rate_type:rateLabel, label:FARE_APFULL[deAP]+' drop-off' }; }
          var be=calcMile(15,night); return { fare:be+feeD+tDm, base_fare:be, airport_fee:feeD, toll_fee:tDm, rate_type:rateLabel+' (estimated)', label:FARE_APFULL[deAP]+' drop-off' };
        });
        var be2=calcMile(15,night); return { fare:be2+feeD+tDm, base_fare:be2, airport_fee:feeD, toll_fee:tDm, rate_type:rateLabel+' (estimated)', label:FARE_APFULL[deAP]+' drop-off' };
      });
    }
    // Pickup is airport → add pickup (short-stay) fee (+ toll)
    if (puAP && !deAP) {
      var feeP = (AIRPORT_FEES[puAP]||{}).pickup||0;
      if (deT && FARE_CF[deT] && FARE_CF[deT][puAP]) {
        var aiP = isAllIn(deT, puAP); // owner flat fare: fee/toll already included
        var bP = FARE_CF[deT][puAP].ret, tP = aiP ? 0 : airportToll(puAP,true), feePp = aiP ? 0 : feeP;
        return Promise.resolve({ fare:bP+feePp+tP, base_fare:bP, airport_fee:feePp, toll_fee:tP, rate_type:'fixed', label:FARE_APFULL[puAP]+' pickup' });
      }
      var ap2 = FARE_AP_COORDS[puAP], tPm = airportToll(puAP,false);
      return geocode(destination).then(function(gc){
        if (gc && ap2) return route(ap2.lat,ap2.lon,gc.lat,gc.lon).then(function(rt){
          if (rt) { var mi=Math.round(rt.distance/1609.34*10)/10; var b=calcMile(mi,night); return { fare:b+feeP+tPm, base_fare:b, airport_fee:feeP, toll_fee:tPm, distance_miles:mi, duration_min:Math.round(rt.duration/60), rate_type:rateLabel, label:FARE_APFULL[puAP]+' pickup' }; }
          var be=calcMile(15,night); return { fare:be+feeP+tPm, base_fare:be, airport_fee:feeP, toll_fee:tPm, rate_type:rateLabel+' (estimated)', label:FARE_APFULL[puAP]+' pickup' };
        });
        var be2=calcMile(15,night); return { fare:be2+feeP+tPm, base_fare:be2, airport_fee:feeP, toll_fee:tPm, rate_type:rateLabel+' (estimated)', label:FARE_APFULL[puAP]+' pickup' };
      });
    }
    // Town to town
    return Promise.all([geocode(pickup), geocode(destination)]).then(function(g){
      if (g[0] && g[1]) return route(g[0].lat,g[0].lon,g[1].lat,g[1].lon).then(function(rt){
        if (rt) { var mi=Math.round(rt.distance/1609.34*10)/10; return { fare:calcMile(mi,night), distance_miles:mi, duration_min:Math.round(rt.duration/60), rate_type:rateLabel }; }
        return { fare:calcMile(8,night), rate_type:rateLabel+' (estimated)' };
      });
      return { fare:calcMile(8,night), rate_type:rateLabel+' (estimated)' };
    });
  }

  // ── Address autocomplete (Nominatim) ───────────────────────────────────
  function attachAutocomplete(input) {
    var box = document.createElement('div'); box.className = 'ac-list'; box.style.display = 'none';
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(box);
    var t = null;
    input.setAttribute('autocomplete','off');
    input.addEventListener('input', function () {
      var v = input.value.trim();
      if (t) clearTimeout(t);
      if (v.length < 3) { box.style.display = 'none'; return; }
      t = setTimeout(function () {
        fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(v) + '&format=json&addressdetails=1&limit=5&countrycodes=gb')
          .then(function(r){return r.json();}).then(function(arr){
            box.innerHTML = '';
            if (!arr || !arr.length) { box.style.display = 'none'; return; }
            arr.forEach(function (o) {
              var it = document.createElement('div'); it.className = 'ac-item'; it.textContent = o.display_name;
              it.addEventListener('mousedown', function (e) { e.preventDefault(); input.value = o.display_name; box.style.display = 'none'; input.dispatchEvent(new Event('change')); });
              box.appendChild(it);
            });
            box.style.display = 'block';
          }).catch(function(){ box.style.display = 'none'; });
      }, 350);
    });
    input.addEventListener('blur', function () { setTimeout(function(){ box.style.display = 'none'; }, 200); });
  }

  // ── Quick estimate (shared) ─────────────────────────────────────────────
  // Wires pickup + drop-off → instant airport fare into a [data-fare-estimate]
  // box. Used by the full booking form (init) AND standalone on the homepage
  // (initQuick), so both surfaces share ONE engine — no duplicate fare logic.
  // Airport journeys get a price; anything else gets a "request a booking"
  // message. Returns updateFare so callers (e.g. use-my-location) can refresh.
  function makeEstimator(pickup, dest, timeEl, fareBox) {
    function isAirportJourney(p, d) { return !!(normAirport(p) || normAirport(d)); }
    var ft = null;
    function updateFare() {
      if (!fareBox) return;
      var p = pickup && pickup.value.trim(), d = dest && dest.value.trim();
      if (!p || !d) { fareBox.style.display = 'none'; fareBox.className = 'fare-estimate'; return; }
      // Not an airport pickup/drop-off → no instant price, show request message.
      if (!isAirportJourney(p, d)) {
        if (ft) clearTimeout(ft);
        fareBox.style.display = 'block';
        fareBox.className = 'fare-estimate msg';
        fareBox.innerHTML = '<span class="fe-label">Your journey</span>'
          + '<span class="fe-note" style="margin-top:3px">For this journey, please request a booking below and we’ll confirm your fare.</span>';
        return;
      }
      if (ft) clearTimeout(ft);
      ft = setTimeout(function () {
        fareBox.style.display = 'block';
        fareBox.className = 'fare-estimate';
        fareBox.innerHTML = '<span class="fe-calc">Calculating estimate…</span>';
        Promise.resolve(calculateFare(p, d, timeEl && timeEl.value)).then(function (r) {
          if (r && r.fare) {
            var total = Math.ceil(r.fare / 0.5) * 0.5;
            var money = function (n) { return (n % 1 === 0) ? n : n.toFixed(2); };
            var extras = [];
            if (r.airport_fee) extras.push('£' + money(r.airport_fee) + ' airport ' + (/pickup/i.test(r.label || '') ? 'pickup' : 'drop-off') + ' fee');
            if (r.toll_fee) extras.push('£' + money(r.toll_fee) + ' toll');
            var extraNote = extras.length ? ' · incl. ' + extras.join(' + ') : '';
            fareBox.className = 'fare-estimate';
            fareBox.innerHTML = '<span class="fe-label">Estimated fare</span><span class="fe-amount">approx £' + money(total) + '</span>'
              + '<span class="fe-note">' + (r.label || 'Airport transfer') + extraNote + ' · approximate — we confirm the exact price with your request</span>';
          } else {
            fareBox.className = 'fare-estimate msg';
            fareBox.innerHTML = '<span class="fe-note">Please request a booking below and we’ll confirm your fare.</span>';
          }
        });
      }, 500);
    }
    [pickup, dest, timeEl].forEach(function (el) { if (el) { el.addEventListener('change', updateFare); el.addEventListener('blur', updateFare); } });
    return updateFare;
  }

  // Standalone quick-estimate widget (e.g. homepage, below the fixed fares).
  // Reuses makeEstimator + autocomplete without the full booking form/submit.
  function initQuick() {
    var scopes = document.querySelectorAll('[data-quick-estimate]');
    for (var i = 0; i < scopes.length; i++) {
      (function (scope) {
        // If it lives inside the full booking form, init() already wired it.
        if (scope.closest && scope.closest('form[data-booking-form]')) return;
        var pickup = scope.querySelector('[name="pickup"]');
        var dest   = scope.querySelector('[name="destination"]');
        var timeEl = scope.querySelector('[name="time"]');
        var fareBox = scope.querySelector('[data-fare-estimate]');
        if (!pickup || !dest || !fareBox) return;
        [pickup, dest].forEach(function (el) { attachAutocomplete(el); });
        makeEstimator(pickup, dest, timeEl, fareBox);
      })(scopes[i]);
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function init() {
    var form = document.querySelector('form[data-booking-form]');
    if (!form) return;
    var pickup = form.querySelector('[name="pickup"]');
    var dest   = form.querySelector('[name="destination"]');
    var stop   = form.querySelector('[name="stop_address"]');
    var dateEl = form.querySelector('[name="date"]');
    var timeEl = form.querySelector('[name="time"]');
    var fareBox = document.querySelector('[data-fare-estimate]');
    var status = form.querySelector('.status');

    // Set today as the MINIMUM selectable date (not a locked value) — uses the
    // visitor's LOCAL date so it never rolls to "tomorrow"/"yesterday" via UTC.
    if (dateEl && !dateEl.getAttribute('min')) {
      var now = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      dateEl.setAttribute('min', now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()));
    }

    // ── Remember me + logged-in account prefill ──────────────────────────
    var nameEl = form.querySelector('[name="name"]');
    var phoneEl = form.querySelector('[name="phone"]');
    var emailEl = form.querySelector('[name="email"]');
    var rememberEl = form.querySelector('[data-remember]');
    var REMEMBER_KEY = 'wm_remember_contact';

    // Track fields the user edits so async prefill never overwrites typing.
    function markEdited(el){ if (el) el.dataset.userEdited = '1'; }
    function clearEdited(){ [nameEl, phoneEl, emailEl, pickup].forEach(function (el) { if (el) delete el.dataset.userEdited; }); }
    [nameEl, phoneEl, emailEl, pickup].forEach(function (el) { if (el) el.addEventListener('input', function () { markEdited(el); }); });
    function setIfFree(el, val){ if (el && val && !el.dataset.userEdited) el.value = val; }

    // 1) Prefill from "remember me" device memory (no passwords/payment stored).
    function applyRemembered(){
      try {
        var saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
        if (saved) {
          if (rememberEl) rememberEl.checked = true;
          setIfFree(nameEl, saved.name); setIfFree(phoneEl, saved.phone);
          setIfFree(emailEl, saved.email); setIfFree(pickup, saved.pickup);
          return true;
        }
      } catch (e) {}
      return false;
    }
    applyRemembered();

    // 2) Logged-in account data takes PRIORITY over remember-me: if a customer
    //    session cookie is present, override contact details from their profile.
    fetch('/api/customer/profile', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.profile) {
          var p = d.profile;
          if (nameEl && p.full_name && !nameEl.dataset.userEdited) nameEl.value = p.full_name;
          if (phoneEl && p.phone && !phoneEl.dataset.userEdited) phoneEl.value = p.phone;
          if (emailEl && p.email && !emailEl.dataset.userEdited) emailEl.value = p.email;
        }
      }).catch(function () {});

    // Persist when box is checked; clear when unchecked.
    function saveRemember(){
      try {
        if (rememberEl && rememberEl.checked) {
          localStorage.setItem(REMEMBER_KEY, JSON.stringify({
            name: nameEl ? nameEl.value.trim() : '',
            phone: phoneEl ? phoneEl.value.trim() : '',
            email: emailEl ? emailEl.value.trim() : '',
            pickup: pickup ? pickup.value.trim() : ''
          }));
        } else {
          localStorage.removeItem(REMEMBER_KEY);
        }
      } catch (e) {}
    }
    if (rememberEl) rememberEl.addEventListener('change', saveRemember);
    [nameEl, phoneEl, emailEl].forEach(function (el) { if (el) el.addEventListener('change', function () { if (rememberEl && rememberEl.checked) saveRemember(); }); });

    [pickup, dest, stop].forEach(function (el) { if (el) attachAutocomplete(el); });

    // Use my current location
    var locBtn = document.querySelector('[data-use-location]');
    if (locBtn) locBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!navigator.geolocation) return;
      locBtn.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        fetch('https://nominatim.openstreetmap.org/reverse?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&format=json')
          .then(function(r){return r.json();}).then(function(d){ if (d && d.display_name) { pickup.value = d.display_name; updateFare(); } locBtn.textContent = 'Use my current location'; })
          .catch(function(){ locBtn.textContent = 'Use my current location'; });
      }, function () { locBtn.textContent = 'Use my current location'; });
    });

    // Add a stop
    var stopToggle = document.querySelector('[data-add-stop]');
    var stopField = document.querySelector('[data-stop-field]');
    if (stopToggle && stopField) stopToggle.addEventListener('click', function (e) {
      e.preventDefault();
      var shown = stopField.style.display !== 'none';
      stopField.style.display = shown ? 'none' : '';
      stopToggle.textContent = shown ? '+ Add a stop on the way' : '− Remove stop';
      if (shown && stop) stop.value = '';
    });

    // Quick estimate — shared engine (same one the homepage widget uses).
    var updateFare = makeEstimator(pickup, dest, timeEl, fareBox);

    // Submit → exact same endpoint + payload as the wizard
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form), raw = {};
      fd.forEach(function (v, k) { raw[k] = v; });
      // Client-side validation — instant feedback, no server round-trip
      var miss = [];
      if (!raw.name || !raw.name.trim()) miss.push('your name');
      if (!raw.phone || !raw.phone.trim()) miss.push('a phone number');
      if (!raw.email || !raw.email.trim()) miss.push('an email');
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email)) miss.push('a valid email');
      if (!raw.pickup || !raw.pickup.trim()) miss.push('a pickup location');
      if (!raw.destination || !raw.destination.trim()) miss.push('a destination');
      if (miss.length) { if (status) { status.style.color = '#9a2b2b'; status.textContent = 'Please enter ' + miss.join(', ') + '.'; } return; }
      saveRemember(); // persist contact details on submit when "remember me" is ticked
      var payload = {
        name: raw.name, email: raw.email, phone: raw.phone,
        pickup: raw.pickup, destination: raw.destination,
        stop_address: raw.stop_address || '',
        date: raw.date || '', time: raw.time || '',
        passengers: Number(raw.passengers || 1),
        bags: raw.luggage || raw.bags || '',
        flight: raw.flightNumber || raw.flight || '',
        notes: raw.notes || '', fare: null, payment: 'pending', source: 'website'
      };
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      if (status) { status.style.color = ''; status.textContent = 'Sending your request…'; }
      fetch('/api/public/book', { method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) })
        .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
        .then(function(res){
          if (res.ok && res.d.ok) {
            if (status) { status.style.color = '#2f6b34'; status.textContent = 'Request received — we\'ll confirm your driver and fare shortly. Reference ' + (res.d.ref || '') + '.'; }
            form.reset(); if (fareBox) fareBox.style.display = 'none';
            clearEdited(); applyRemembered(); // restore saved details (+ ticked box) for a follow-up booking
          } else { throw new Error((res.d && res.d.error) || 'Could not submit'); }
        })
        .catch(function(err){
          if (status) { status.style.color = '#9a2b2b'; status.innerHTML = 'Sorry, we couldn\'t submit that (' + (err.message||'network error') + '). Please call <a href="tel:+447930342593">07930 342 593</a> or <a href="https://wa.me/447930342593" target="_blank">WhatsApp us</a>.'; }
        })
        .then(function(){ if (btn) btn.disabled = false; });
    });
  }
  function boot() { init(); initQuick(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
