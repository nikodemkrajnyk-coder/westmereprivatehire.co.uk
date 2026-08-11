/**
 * Fare engine — single source of truth for journey pricing.
 *
 * Mirrors the CF fixed-fare table in index.html and the tapered per-mile rates.
 * Checks fixed airport fares first (Gatwick, Heathrow, Stansted, Luton,
 * Southampton, London City), then falls back to a tapered per-mile calculation
 * via geocoding + OSRM routing.
 *
 * Used by:
 *   • server/assistant-routes.js — the AI assistant's calculate_fare tool
 *   • server/public-api.js       — server-side suggested fare on new bookings
 */

const { deadMilesFee } = require('./dead-miles');

// Driver home base (Horsham) — origin of the dead-miles (collection) leg.
const DRIVER_BASE = { lat: 51.0632, lon: -0.3254 };

// ── Fare engine (exact mirror of CF table in index.html) ─────────────────
// Values are ALL-IN fixed fares — airport charges and dead miles included.
// out = town→airport (drop-off), ret = airport→town (pickup)
const FARE_CF = {
  // Brighton→Gatwick and Brighton→Heathrow are owner-set FLAT ALL-IN fares
  // (Aug 2026): top normal private-hire competitor price (excluding chauffeur/
  // limo/executive) minus £5 — Gatwick £70 (Hove Airport Cars) − £5 = £65;
  // Heathrow £130 (Streamline) − £5 = £125. Marked all-in in FARE_CF_ALLIN below,
  // so the engine does NOT add the airport fee/toll on top (the £65/£125 already
  // includes it). Applies both directions (drop-off/pickup).
  brighton:      { ga:{out:65,ret:65}, he:{out:125,ret:125}, st:{out:188,ret:192}, lu:{out:176,ret:181}, so:{out:138,ret:135}, ci:{out:151,ret:154} },
  // Lewes/Haywards Heath/Burgess Hill Gatwick+Heathrow are owner-set FLAT ALL-IN
  // fares (top normal private-hire − £5), marked in FARE_CF_ALLIN so the engine
  // does NOT add the airport fee/toll on top. Both directions. Other airports for
  // these towns keep the normal base + fee-on-top behaviour.
  lewes:         { ga:{out:80,ret:80}, he:{out:150,ret:150}, st:{out:193,ret:197}, lu:{out:181,ret:184}, so:{out:140,ret:138}, ci:{out:155,ret:158} },
  // Horsham → Gatwick AND Heathrow are FLAT ALL-IN (£50 / £90, marked in
  // FARE_CF_ALLIN — no fee/toll on top). Other Horsham airports stay base + fee.
  horsham:       { ga:{out:50,ret:50},  he:{out:90,ret:90}, st:{out:141,ret:145}, lu:{out:120,ret:122}, so:{out:104,ret:101}, ci:{out:124,ret:128} },
  // crawley: intentionally NO fixed fare — priced MANUALLY (quote on request).
  // Its normalizer keys stay so FARE_ON_REQUEST below can catch Crawley journeys.
  worthing:      { ga:{out:85,ret:82}, he:{out:121,ret:123} },
  haywards:      { ga:{out:60,ret:60}, he:{out:126,ret:126}, lu:{out:142,ret:145}, st:{out:135,ret:139}, so:{out:112,ret:109}, ci:{out:120,ret:123} },
  burgess:       { ga:{out:56,ret:56}, he:{out:126,ret:126}, lu:{out:159,ret:162}, st:{out:161,ret:165}, so:{out:114,ret:111}, ci:{out:135,ret:138} },
  eastbourne:    { ga:{out:119,ret:117}, he:{out:158,ret:163} },
  seaford:       { ga:{out:108,ret:105} },
  uckfield:      { ga:{out:73,ret:70} },
  eastgrinstead: { ga:{out:62,ret:58} }
};
const FARE_APFULL = { ga:'Gatwick', he:'Heathrow', st:'Stansted', lu:'Luton', so:'Southampton', ci:'London City' };
// Town→airport fixed fares that are ALL-IN: the airport drop-off/pick-up fee and
// any toll are ALREADY baked into the FARE_CF value, so the engine must NOT add
// them again. Owner-set flat fares only (Brighton/Hove Gatwick & Heathrow).
const FARE_CF_ALLIN = {
  brighton: { ga:true, he:true },
  lewes:    { ga:true, he:true },
  haywards: { ga:true, he:true },
  burgess:  { ga:true, he:true },
  horsham:  { ga:true, he:true },  // both all-in (£45 / £90 flat).
};
function _fareIsAllIn(town, ap) { return !!(FARE_CF_ALLIN[town] && FARE_CF_ALLIN[town][ap]); }
// Towns the owner prices MANUALLY — no auto fare. An airport journey to/from one
// of these returns "quote on request" (fare:null) so the customer is guided to
// request a booking and the owner quotes it by hand (same as unpriced routes).
const FARE_ON_REQUEST = { crawley: true };
function _fareOnRequest(town) { return !!(town && FARE_ON_REQUEST[town]); }
// Airport coords for routing when town is unknown
const FARE_AP_COORDS = {
  ga:{lat:51.1537,lon:-0.1821}, he:{lat:51.47,lon:-0.4543},
  st:{lat:51.885,lon:0.235},    lu:{lat:51.8747,lon:-0.3684},
  so:{lat:50.9503,lon:-1.3568}, ci:{lat:51.5048,lon:0.0495}
};

// ── Airport terminal fees + road tolls (added ON TOP of the all-in base fare) ──
// Researched Aug 2026 from official airport pages / current published rates.
// dropoff = town→airport (out) forecourt set-down charge.
// pickup  = airport→town (ret) short-stay / pick-up car park (~30 min).
// Kept as explicit, readable per-airport constants (not baked into FARE_CF, which
// stays as the displayed headline price).
const AIRPORT_FEES = {
  ga: { dropoff: 10, pickup: 8  }, // Gatwick: drop-off £10/10min (6 Jan 2026); Short Stay ~£8/30min
  he: { dropoff: 7,  pickup: 8  }, // Heathrow: drop-off £7 all terminals (2026); Short Stay ~£7.50/30min → £8
  lu: { dropoff: 7,  pickup: 7  }, // Luton: drop-off £7/10min; Terminal CP1 £7/30min
  st: { dropoff: 10, pickup: 13 }, // Stansted: drop-off £10/15min (19 Mar 2026); Short Stay £13/30min
  so: { dropoff: 7,  pickup: 7  }, // Southampton: Pick up & Drop Off £7/20min (both ways)
  ci: { dropoff: 8,  pickup: 10 }  // London City: drop-off £8/5min (6 Jan 2026); pickup £10 (owner-confirmed)
};
// Road tolls (car). Added per airport route only where NOT already embedded in base.
const DARTFORD_TOLL  = 3.50; // Dart Charge car PAYG, from 1 Sep 2025 — Stansted routes
const BLACKWALL_TOLL = 4.20; // Silvertown/Blackwall tunnel, peak Auto Pay from 21 Sep 2026 — London City routes
// Stansted FIXED fares already embed a ~£12 Dartford/M25 premium, so the Dartford
// toll is NOT re-added to fixed Stansted fares (would double-count) — it IS added
// to the per-mile fallback (which has no toll baked in). London City base has no
// tunnel charge, so the Blackwall/Silvertown toll is added to ALL London City routes.
function _airportToll(ap, isFixed) {
  if (ap === 'st') return isFixed ? 0 : DARTFORD_TOLL;
  if (ap === 'ci') return BLACKWALL_TOLL;
  return 0;
}
// Build a human breakdown string for an airport journey.
function _airportBreakdown(base, fee, toll, ap, dir, isFixed, extra) {
  const parts = ['£' + base + (isFixed ? ' fixed fare' : ' ' + extra)];
  if (fee)  parts.push('£' + fee + ' ' + FARE_APFULL[ap] + ' ' + dir + ' fee');
  if (toll) parts.push('£' + toll + ' toll');
  let s = parts.join(' + ') + ' = £' + (base + fee + toll);
  if (ap === 'st' && isFixed) s += ' (fare already includes Dartford Crossing)';
  return s;
}

function _fareNormTown(s) {
  if (!s) return null;
  const l = s.toLowerCase();
  // Postcode prefixes (checked first — most precise)
  const pc = [
    ['rh12','horsham'],['rh13','horsham'],['rh14','horsham'],['bn5','horsham'],
    ['rh10','crawley'], ['rh11','crawley'],
    ['rh16','haywards'],['bn6','haywards'],['rh17','haywards'],
    ['rh15','burgess'],
    ['rh19','eastgrinstead'],
    ['bn1','brighton'], ['bn2','brighton'], ['bn3','brighton'],
    ['bn41','brighton'],  // Portslade
    ['bn10','brighton'],  // Peacehaven
    ['bn7','lewes'],  ['bn8','lewes'],  ['bn9','lewes'],
    ['bn11','worthing'],['bn12','worthing'],['bn13','worthing'],['bn14','worthing'],
    ['bn43','worthing'], // Shoreham
    ['bn44','worthing'], // Steyning area
    ['bn42','worthing'], // Southwick
    ['bn15','worthing'], // Lancing
    ['bn21','eastbourne'],['bn22','eastbourne'],['bn23','eastbourne'],['bn26','eastbourne'],
    ['bn25','seaford'],
    ['tn22','uckfield'], ['tn21','uckfield'], ['tn20','uckfield'],
  ];
  for (const [k, v] of pc) { if (new RegExp('\\b'+k+'\\b').test(l)) return v; }
  // Named places — order matters: longer/more-specific strings first
  const nm = [
    ['haywards heath','haywards'],
    ['burgess hill','burgess'],
    ['east grinstead','eastgrinstead'],
    ['saltdean','brighton'],
    ['rottingdean','brighton'],
    ['peacehaven','brighton'],
    ['woodingdean','brighton'],
    ['patcham','brighton'],
    ['portslade','brighton'],
    ['moulsecoomb','brighton'],
    ['coldean','brighton'],
    ['hollingbury','brighton'],
    ['withdean','brighton'],
    ['hove','brighton'],
    ['brighton','brighton'],
    ['shoreham','worthing'],
    ['lancing','worthing'],
    ['southwick','worthing'],
    ['worthing','worthing'],
    ['eastbourne','eastbourne'],
    ['polegate','eastbourne'],
    ['seaford','seaford'],
    ['newhaven','lewes'],
    ['lewes','lewes'],
    ['uckfield','uckfield'],
    ['horsham','horsham'],
    ['crawley','crawley'],
  ];
  for (const [k, v] of nm) { if (l.includes(k)) return v; }
  return null;
}

function _fareNormAirport(s) {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes('gatwick')) return 'ga';
  if (l.includes('heathrow')) return 'he';
  if (l.includes('stansted')) return 'st';
  if (l.includes('luton')) return 'lu';
  if (l.includes('southampton')) return 'so';
  if (l.includes('london city') || l.includes('city airport')) return 'ci';
  return null;
}

function _fareCalcMile(mi, night) {
  const m = Math.max(mi, 10); // 10-mile minimum
  let f;
  if (night) {
    f = m <= 10 ? m * 3.60 : m <= 20 ? 36.0 + (m - 10) * 2.95 : 65.5 + (m - 20) * 2.64;
  } else {
    f = m <= 10 ? m * 3.79 : m <= 20 ? 37.9 + (m - 10) * 2.37 : 61.6 + (m - 20) * 2.13;
  }
  return Math.ceil(f / 0.5) * 0.5;
}

async function _fareGeocode(addr) {
  const q = /\bUK\b/i.test(addr) ? addr : addr + ', UK';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1&countrycodes=gb', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'WestmerePrivateHire/1.0' }
    });
    const arr = await r.json();
    if (arr && arr[0]) return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
  } catch (_) {}
  return null;
}

async function _fareRoute(lat1, lon1, lat2, lon2) {
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`);
    const d = await r.json();
    if (d.routes && d.routes.length) return { distance: d.routes[0].distance, duration: d.routes[0].duration };
  } catch (_) {}
  return null;
}

async function calculateFare(pickup, destination, timeStr) {
  const h = timeStr ? parseInt(timeStr.split(':')[0], 10) : new Date().getHours();
  const night = h >= 22 || h < 6;
  const rateLabel = night ? 'night rate' : 'day rate';

  const puAP = _fareNormAirport(pickup);
  const deAP = _fareNormAirport(destination);
  const puT  = _fareNormTown(pickup);
  const deT  = _fareNormTown(destination);

  // ── Destination is airport ──────────────────────────────────────────────
  if (deAP && !puAP) {
    const townKey = puT;
    // Quote-on-request towns (e.g. Crawley) never auto-price — no number.
    if (_fareOnRequest(townKey)) {
      return { fare: null, base_fare: null, airport_fee: 0, toll_fee: 0, rate_type: 'on_request', on_request: true, breakdown: 'Fare quoted on request' };
    }
    if (townKey && FARE_CF[townKey] && FARE_CF[townKey][deAP]) {
      // Fixed base (displayed headline price) + explicit drop-off fee (+ toll where applicable)
      const base = FARE_CF[townKey][deAP].out;
      const allIn = _fareIsAllIn(townKey, deAP); // owner flat fare: fee/toll already included
      const fee  = allIn ? 0 : (AIRPORT_FEES[deAP] ? AIRPORT_FEES[deAP].dropoff : 0);
      const toll = allIn ? 0 : _airportToll(deAP, true);
      const fare = base + fee + toll;
      const rdKey = townKey + '_' + deAP;
      const RD = { horsham_ga:{m:12,t:22}, horsham_he:{m:38,t:55}, lewes_ga:{m:28,t:38}, lewes_he:{m:62,t:80}, brighton_ga:{m:27,t:40}, brighton_he:{m:58,t:75}, worthing_ga:{m:28,t:42}, worthing_he:{m:55,t:70}, burgess_ga:{m:10,t:18}, haywards_ga:{m:18,t:28}, crawley_ga:{m:4,t:12}, crawley_he:{m:32,t:48}, eastbourne_ga:{m:42,t:55}, eastbourne_he:{m:72,t:92}, seaford_ga:{m:35,t:45}, uckfield_ga:{m:22,t:32}, eastgrinstead_ga:{m:14,t:22} };
      const rd = RD[rdKey] || {};
      return { fare, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: rd.m || null, duration_min: rd.t || null, rate_type: 'fixed', breakdown: _airportBreakdown(base, fee, toll, deAP, 'drop-off', true) };
    }
    // Unknown town — geocode + OSRM (per-mile fallback) + drop-off fee (+ toll)
    const fee = AIRPORT_FEES[deAP] ? AIRPORT_FEES[deAP].dropoff : 0;
    const toll = _airportToll(deAP, false);
    const [gc, apCoords] = await Promise.all([_fareGeocode(pickup), Promise.resolve(FARE_AP_COORDS[deAP])]);
    if (gc && apCoords) {
      const rt = await _fareRoute(gc.lat, gc.lon, apCoords.lat, apCoords.lon);
      if (rt) {
        const mi = Math.round(rt.distance / 1609.34 * 10) / 10;
        const ti = Math.round(rt.duration / 60);
        const base = _fareCalcMile(mi, night);
        return { fare: base + fee + toll, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: mi, duration_min: ti, rate_type: rateLabel, breakdown: _airportBreakdown(base, fee, toll, deAP, 'drop-off', false, `${mi} mi × tapered ${rateLabel}`) };
      }
    }
    const base = _fareCalcMile(15, night);
    return { fare: base + fee + toll, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: null, duration_min: null, rate_type: rateLabel + ' (estimated)', breakdown: _airportBreakdown(base, fee, toll, deAP, 'drop-off', false, `est ~15 mi × tapered ${rateLabel}`) };
  }

  // ── Pickup is airport ───────────────────────────────────────────────────
  if (puAP && !deAP) {
    const townKey = deT;
    // Quote-on-request towns (e.g. Crawley) never auto-price — no number.
    if (_fareOnRequest(townKey)) {
      return { fare: null, base_fare: null, airport_fee: 0, toll_fee: 0, rate_type: 'on_request', on_request: true, breakdown: 'Fare quoted on request' };
    }
    if (townKey && FARE_CF[townKey] && FARE_CF[townKey][puAP]) {
      // Fixed base (displayed headline price) + explicit pickup fee (+ toll where applicable)
      const base = FARE_CF[townKey][puAP].ret;
      const allIn = _fareIsAllIn(townKey, puAP); // owner flat fare: fee/toll already included
      const fee  = allIn ? 0 : (AIRPORT_FEES[puAP] ? AIRPORT_FEES[puAP].pickup : 0);
      const toll = allIn ? 0 : _airportToll(puAP, true);
      const fare = base + fee + toll;
      return { fare, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: null, duration_min: null, rate_type: 'fixed', breakdown: _airportBreakdown(base, fee, toll, puAP, 'pickup', true) };
    }
    const fee = AIRPORT_FEES[puAP] ? AIRPORT_FEES[puAP].pickup : 0;
    const toll = _airportToll(puAP, false);
    const [apCoords, gc] = [FARE_AP_COORDS[puAP], await _fareGeocode(destination)];
    if (gc && apCoords) {
      const rt = await _fareRoute(apCoords.lat, apCoords.lon, gc.lat, gc.lon);
      if (rt) {
        const mi = Math.round(rt.distance / 1609.34 * 10) / 10;
        const ti = Math.round(rt.duration / 60);
        const base = _fareCalcMile(mi, night);
        return { fare: base + fee + toll, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: mi, duration_min: ti, rate_type: rateLabel, breakdown: _airportBreakdown(base, fee, toll, puAP, 'pickup', false, `${mi} mi × tapered ${rateLabel}`) };
      }
    }
    const base = _fareCalcMile(15, night);
    return { fare: base + fee + toll, base_fare: base, airport_fee: fee, toll_fee: toll, distance_miles: null, duration_min: null, rate_type: rateLabel + ' (estimated)', breakdown: _airportBreakdown(base, fee, toll, puAP, 'pickup', false, `est ~15 mi × tapered ${rateLabel}`) };
  }

  // ── Town-to-town: live routing ──────────────────────────────────────────
  const [gc1, gc2] = await Promise.all([_fareGeocode(pickup), _fareGeocode(destination)]);
  if (gc1 && gc2) {
    const rt = await _fareRoute(gc1.lat, gc1.lon, gc2.lat, gc2.lon);
    if (rt) {
      const mi = Math.round(rt.distance / 1609.34 * 10) / 10;
      const ti = Math.round(rt.duration / 60);
      const f = _fareCalcMile(mi, night);
      const minNote = mi < 10 ? ' (10-mile minimum applies)' : '';
      return { fare: f, distance_miles: mi, duration_min: ti, rate_type: rateLabel, breakdown: `${mi} miles × tapered ${rateLabel}${minNote}` };
    }
  }
  // Fallback
  const f = _fareCalcMile(8, night);
  return { fare: f, distance_miles: null, duration_min: null, rate_type: rateLabel + ' (estimated)', breakdown: 'Could not geocode route — estimated short local journey' };
}

/**
 * Suggested fare for a booking — the all-in price the owner is likely to charge.
 *
 * Base fare comes from calculateFare (fixed CF fare or tapered per-mile). The
 * dead-miles (collection) fee is ONLY added to per-mile fares: the fixed CF
 * airport fares already bake the collection cost into their tables, so adding
 * it again would double-charge.
 *
 * Returns null on total failure so callers can fall back to "no suggestion".
 */
async function computeSuggestedFare(pickup, destination, timeStr) {
  if (!pickup || !destination) return null;
  try {
    const result = await calculateFare(pickup, destination, timeStr || null);
    let fare = Number(result.fare) || 0;
    if (!fare) return null;

    let deadFee = 0, deadMi = 0;
    if (result.rate_type !== 'fixed') {
      try {
        const pickupGc = await _fareGeocode(pickup);
        if (pickupGc) {
          const rt = await _fareRoute(DRIVER_BASE.lat, DRIVER_BASE.lon, pickupGc.lat, pickupGc.lon);
          if (rt) {
            deadMi = Math.round(rt.distance / 1609.34 * 10) / 10;
            const dm = deadMilesFee(deadMi);
            deadFee = dm.fee;
            fare += deadFee;
          }
        }
      } catch (_) { /* dead miles unavailable — fall through with base fare */ }
    }

    fare = Math.ceil(fare / 0.5) * 0.5; // round up to nearest 50p
    return {
      fare,
      base_fare: (result.base_fare != null ? result.base_fare : Number(result.fare)) || 0,
      airport_fee: result.airport_fee || 0,
      toll_fee: result.toll_fee || 0,
      dead_miles_fee: deadFee,
      dead_miles: deadMi,
      rate_type: result.rate_type,
      breakdown: result.breakdown,
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  calculateFare,
  computeSuggestedFare,
  deadMilesFee,
  _fareGeocode,
  _fareRoute,
  DRIVER_BASE,
  FARE_CF,
  FARE_CF_ALLIN,
  FARE_ON_REQUEST,
  FARE_APFULL,
  FARE_AP_COORDS,
  AIRPORT_FEES,
  DARTFORD_TOLL,
  BLACKWALL_TOLL,
};
