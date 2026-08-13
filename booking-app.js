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
    // NOT added on top (£65/£125 already includes it). Both directions.
    brighton:      { ga:{out:75,ret:75}, he:{out:125,ret:125}, st:{out:188,ret:192}, lu:{out:176,ret:181}, so:{out:138,ret:135}, ci:{out:151,ret:154} },
    // Lewes/Haywards/Burgess ga+he are FLAT ALL-IN (mirror of fare-engine.js);
    // marked in FARE_CF_ALLIN so the fee/toll is NOT added on top. Both directions.
    lewes:         { ga:{out:80,ret:80}, he:{out:150,ret:150}, st:{out:193,ret:197}, lu:{out:181,ret:184}, so:{out:140,ret:138}, ci:{out:155,ret:158} },
    // Horsham → Gatwick AND Heathrow are FLAT ALL-IN (£50 / £90, no fee/toll on top).
    horsham:       { ga:{out:50,ret:50},  he:{out:90,ret:90}, st:{out:141,ret:145}, lu:{out:120,ret:122}, so:{out:104,ret:101}, ci:{out:124,ret:128} },
    // crawley: no fixed fare — quote on request (see FARE_ON_REQUEST below).
    worthing:      { ga:{out:85,ret:82}, he:{out:121,ret:123} },
    haywards:      { ga:{out:65,ret:65}, he:{out:126,ret:126}, lu:{out:142,ret:145}, st:{out:135,ret:139}, so:{out:112,ret:109}, ci:{out:120,ret:123} },
    burgess:       { ga:{out:60,ret:60}, he:{out:126,ret:126}, lu:{out:159,ret:162}, st:{out:161,ret:165}, so:{out:114,ret:111}, ci:{out:135,ret:138} },
    eastbourne:    { ga:{out:119,ret:117}, he:{out:158,ret:163} },
    seaford:       { ga:{out:108,ret:105} },
    uckfield:      { ga:{out:73,ret:70} },
    eastgrinstead: { ga:{out:62,ret:58} }
  };
  var FARE_APFULL = { ga:'Gatwick', he:'Heathrow', st:'Stansted', lu:'Luton', so:'Southampton', ci:'London City' };
  // Town→airport fixed fares that are ALL-IN (fee/toll already baked into the
  // FARE_CF value) — mirror of server/fare-engine.js FARE_CF_ALLIN.
  var FARE_CF_ALLIN = { brighton:{ ga:true, he:true }, lewes:{ ga:true, he:true }, haywards:{ ga:true, he:true }, burgess:{ ga:true, he:true }, horsham:{ ga:true, he:true } };
  function isAllIn(town, ap) { return !!(FARE_CF_ALLIN[town] && FARE_CF_ALLIN[town][ap]); }
  // Towns priced MANUALLY — an airport journey to/from one returns no number, so
  // the estimate widget shows the "request a booking" message (mirror of engine).
  var FARE_ON_REQUEST = { crawley: true };
  function onRequest(town) { return !!(town && FARE_ON_REQUEST[town]); }
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
  // ── NON-AIRPORT QUICK ESTIMATE ────────────────────────────────────────
  // Town-to-town journeys used to show no price at all — just "please request
  // a booking". The owner asked for an approximate distance-based guide:
  //   £2.50 per routed mile, with a £40 floor.
  //
  // This is DELIBERATELY separate from calculateFare() and from FARE_CF. It
  // never runs for a journey with an airport at either end, so no airport quote
  // moves by a penny: those keep the fixed FARE_CF fares and the tapered
  // per-mile engine (day 3.79/2.37/2.13, night 3.60/2.95/2.64, 10-mile floor)
  // exactly as they were. Nothing here touches the owner's manual fare-setting
  // or the confirmation flow — this is the customer-facing preliminary guide.
  // GUARDRAIL: server/tests/quick-estimate-nonairport.test.js
  var NONAP_PER_MILE = 2.50;
  var NONAP_MIN = 40;
  function nonAirportEstimate(mi) {
    if (!(mi > 0)) return null;                       // no distance → no guess
    var f = Math.ceil((mi * NONAP_PER_MILE) / 0.5) * 0.5;
    return Math.max(NONAP_MIN, f);
  }
  // Route the journey and price it. Fails CLOSED: if the geocoder or the router
  // cannot answer, the widget goes back to "request a booking" rather than
  // inventing a distance.
  // The shared geocode() appends ", UK" unless the string already contains the
  // standalone token "UK". An address chosen from the autocomplete ends in
  // "United Kingdom", which does NOT contain that token — so it was sending
  // Nominatim "…, United Kingdom, UK", which returns nothing at all. That
  // pre-existing quirk is invisible on the airport path (a known town matches
  // FARE_CF by name and never geocodes) but it would stop this estimate firing
  // for almost every real customer, so the non-airport path gets its own
  // country handling. geocode() itself is deliberately left alone: "fixing" it
  // there would start pricing airport journeys that currently quote nothing.
  function geocodeForEstimate(addr) {
    var a = String(addr || '');
    var q = /\bUK\b|united kingdom/i.test(a) ? a : a + ', UK';
    return fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
                 '&format=json&limit=1&countrycodes=gb', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (arr) { return (arr && arr[0]) ? { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) } : null; })
      .catch(function () { return null; });
  }

  function quoteNonAirport(pickup, destination) {
    return Promise.all([geocodeForEstimate(pickup), geocodeForEstimate(destination)]).then(function (g) {
      if (!g[0] || !g[1]) return null;
      return route(g[0].lat, g[0].lon, g[1].lat, g[1].lon).then(function (rt) {
        if (!rt) return null;
        var mi = Math.round(rt.distance / 1609.34 * 10) / 10;
        var fare = nonAirportEstimate(mi);
        return fare == null ? null : { fare: fare, distance_miles: mi, rate_type: 'approx_per_mile' };
      });
    }).catch(function () { return null; });
  }

  function calculateFare(pickup, destination, timeStr) {
    var h = timeStr ? parseInt(timeStr.split(':')[0],10) : new Date().getHours();
    var night = h >= 22 || h < 6;
    var rateLabel = night ? 'night rate' : 'day rate';
    var puAP = normAirport(pickup), deAP = normAirport(destination);
    var puT = normTown(pickup), deT = normTown(destination);
    // Airport-only instant estimate (mirror of server/fare-engine.js): only a
    // journey with a recognised airport at the pickup OR drop-off is auto-priced.
    // No airport at either end (town-to-town) → no number; the widget shows the
    // "request a booking" message. makeEstimator gates too, but keep the engine
    // itself airport-only so the mirror can never price a town-to-town journey.
    if (!puAP && !deAP) return Promise.resolve({ fare:null, on_request:true, rate_type:'on_request' });
    // Destination is airport → add drop-off fee (+ toll)
    if (deAP && !puAP) {
      // Quote-on-request town (e.g. Crawley) → no number; widget shows the request message.
      if (onRequest(puT)) return Promise.resolve({ fare:null, on_request:true, rate_type:'on_request' });
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
          return { fare:null, on_request:true, rate_type:'on_request' }; // route failed → fail closed, never a ~15mi estimate
        });
        return { fare:null, on_request:true, rate_type:'on_request' }; // geocode failed → fail closed
      });
    }
    // Pickup is airport → add pickup (short-stay) fee (+ toll)
    if (puAP && !deAP) {
      // Quote-on-request town (e.g. Crawley) → no number; widget shows the request message.
      if (onRequest(deT)) return Promise.resolve({ fare:null, on_request:true, rate_type:'on_request' });
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
          return { fare:null, on_request:true, rate_type:'on_request' }; // route failed → fail closed, never a ~15mi estimate
        });
        return { fare:null, on_request:true, rate_type:'on_request' }; // geocode failed → fail closed
      });
    }
    // Airport-to-airport (both ends airports) → per-mile routing. Town-to-town
    // never reaches here (it returned on_request above).
    return Promise.all([geocode(pickup), geocode(destination)]).then(function(g){
      if (g[0] && g[1]) return route(g[0].lat,g[0].lon,g[1].lat,g[1].lon).then(function(rt){
        if (rt) { var mi=Math.round(rt.distance/1609.34*10)/10; return { fare:calcMile(mi,night), distance_miles:mi, duration_min:Math.round(rt.duration/60), rate_type:rateLabel }; }
        return { fare:null, on_request:true, rate_type:'on_request' }; // route failed → fail closed
      });
      return { fare:null, on_request:true, rate_type:'on_request' }; // geocode failed → fail closed
    });
  }

  // ── Address autocomplete (Nominatim) ───────────────────────────────────
  // ── Address display: short in the field, full on the booking ────────────
  // The shared normalizer (address-normalize.js) is the single source of truth
  // for how an address is shown to a human, exactly as it is in the emails, the
  // staff apps and the invoice. `fullAddress` on the element carries the precise
  // string the geocoder returned, which is what the booking and the driver's
  // Waze link must use. GUARDRAIL: server/tests/address-display.test.js.
  function briefAddr(s) {
    return (window.WMAddr && window.WMAddr.briefDisplay)
      ? (window.WMAddr.briefDisplay(s) || s)
      : s;
  }
  // Write a chosen address: brief in the box, full remembered alongside it.
  function setAddress(input, full) {
    if (!input) return;
    input.value = briefAddr(full);
    input.dataset.fullAddress = full;
  }
  // What the BOOKING should carry. Falls back to whatever is typed, so an
  // address entered by hand (no geocoder involved) is unaffected.
  function fullAddr(input) {
    if (!input) return '';
    var full = input.dataset ? input.dataset.fullAddress : '';
    return (full && full.trim()) ? full : (input.value || '').trim();
  }

  function attachAutocomplete(input) {
    var box = document.createElement('div'); box.className = 'ac-list'; box.style.display = 'none';
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(box);
    var t = null;
    input.setAttribute('autocomplete','off');
    input.addEventListener('input', function () {
      var v = input.value.trim();
      // Typing replaces a picked suggestion, so the remembered full address is
      // no longer this address. Without this, editing a chosen pickup would
      // send the OLD full string to the booking while showing the new text.
      if (input.dataset) delete input.dataset.fullAddress;
      if (t) clearTimeout(t);
      if (v.length < 3) { box.style.display = 'none'; return; }
      t = setTimeout(function () {
        fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(v) + '&format=json&addressdetails=1&limit=5&countrycodes=gb')
          .then(function(r){return r.json();}).then(function(arr){
            box.innerHTML = '';
            if (!arr || !arr.length) { box.style.display = 'none'; return; }
            arr.forEach(function (o) {
              // SHORT LABEL, FULL VALUE KEPT. Nominatim's display_name is the
              // whole administrative chain — "London Borough of Hillingdon,
              // Greater London, England, United Kingdom" — which is unreadable
              // in a dropdown and worse once it lands in the field. Show the
              // brief form; stash the full string on the input so the booking
              // and the driver's navigation still get the precise address.
              var it = document.createElement('div'); it.className = 'ac-item';
              it.textContent = briefAddr(o.display_name);
              it.title = o.display_name;
              it.addEventListener('mousedown', function (e) {
                e.preventDefault();
                setAddress(input, o.display_name);
                box.style.display = 'none';
                input.dispatchEvent(new Event('change'));
              });
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
  // ── #B: an estimate is NOT a booking ──────────────────────────────────
  // Customers were reading the quick estimate as a confirmed booking. The
  // heading says so in as many words, on every estimate the widget shows.
  var ESTIMATE_LABEL = '<span class="fe-label fe-label-warn">Approximate estimate — not a confirmed booking</span>';

  function makeEstimator(pickup, dest, timeEl, fareBox) {
    function isAirportJourney(p, d) { return !!(normAirport(p) || normAirport(d)); }
    var ft = null;
    function updateFare() {
      if (!fareBox) return;
      // FULL addresses here, not the shortened labels: this is the fare path,
      // and it must see exactly what it saw before the display was shortened.
      var p = fullAddr(pickup), d = fullAddr(dest);
      if (!p || !d) { fareBox.style.display = 'none'; fareBox.className = 'fare-estimate'; return; }
      // Not an airport pickup/drop-off → no instant price, show request message.
      if (!isAirportJourney(p, d)) {
        if (ft) clearTimeout(ft);
        ft = setTimeout(function () {
          fareBox.style.display = 'block';
          fareBox.className = 'fare-estimate';
          fareBox.innerHTML = '<span class="fe-calc">Calculating estimate…</span>';
          quoteNonAirport(p, d).then(function (r) {
            var money = function (n) { return (n % 1 === 0) ? n : n.toFixed(2); };
            if (r && r.fare) {
              fareBox.className = 'fare-estimate';
              fareBox.innerHTML = ESTIMATE_LABEL
                + '<span class="fe-amount">approx £' + money(r.fare) + '</span>'
                + '<span class="fe-note">About ' + r.distance_miles + ' miles · approximate guide only. '
                + 'Request your booking below and we’ll confirm the exact fare.</span>';
            } else {
              // Fail closed — never guess a distance.
              fareBox.className = 'fare-estimate msg';
              fareBox.innerHTML = '<span class="fe-label">Your journey</span>'
                + '<span class="fe-note" style="margin-top:3px">For this journey, please request a booking below and we’ll confirm your fare.</span>';
            }
          });
        }, 500);
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
            fareBox.innerHTML = ESTIMATE_LABEL + '<span class="fe-amount">approx £' + money(total) + '</span>'
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
            pickup: pickup ? fullAddr(pickup) : ''
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
          .then(function(r){return r.json();}).then(function(d){ if (d && d.display_name) { setAddress(pickup, d.display_name); updateFare(); } locBtn.textContent = 'Use my current location'; })
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
      // The fields show a SHORT label; the booking carries the full address so
      // the driver's navigation is exact. (Display short, route full — the same
      // rule the emails, apps and invoice follow.)
      if (pickup) raw.pickup = fullAddr(pickup);
      if (dest) raw.destination = fullAddr(dest);
      if (stop && raw.stop_address) raw.stop_address = fullAddr(stop);
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
            if (status) { status.style.color = '#2f6b34'; status.textContent = 'Thank you for booking with us — we will be in touch shortly. Reference ' + (res.d.ref || '') + '.'; }
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
