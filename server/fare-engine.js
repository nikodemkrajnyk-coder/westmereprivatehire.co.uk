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
  brighton:      { ga:{out:109,ret:106}, he:{out:151,ret:155}, st:{out:231,ret:236}, lu:{out:217,ret:222}, so:{out:169,ret:166}, ci:{out:186,ret:189} },
  lewes:         { ga:{out:111,ret:108}, he:{out:158,ret:163}, st:{out:237,ret:242}, lu:{out:223,ret:227}, so:{out:173,ret:169}, ci:{out:190,ret:194} },
  horsham:       { ga:{out:66,ret:63},  he:{out:116,ret:121}, st:{out:173,ret:178}, lu:{out:147,ret:150}, so:{out:128,ret:124}, ci:{out:152,ret:157} },
  crawley:       { ga:{out:54,ret:52},  he:{out:100,ret:104} },
  worthing:      { ga:{out:103,ret:100}, he:{out:148,ret:151} },
  haywards:      { ga:{out:77,ret:75} },
  burgess:       { ga:{out:77,ret:74} },
  eastbourne:    { ga:{out:146,ret:143}, he:{out:195,ret:200} },
  seaford:       { ga:{out:132,ret:129} },
  uckfield:      { ga:{out:89,ret:85} },
  eastgrinstead: { ga:{out:75,ret:71} }
};
const FARE_APFULL = { ga:'Gatwick', he:'Heathrow', st:'Stansted', lu:'Luton', so:'Southampton', ci:'London City' };
// Airport coords for routing when town is unknown
const FARE_AP_COORDS = {
  ga:{lat:51.1537,lon:-0.1821}, he:{lat:51.47,lon:-0.4543},
  st:{lat:51.885,lon:0.235},    lu:{lat:51.8747,lon:-0.3684},
  so:{lat:50.9503,lon:-1.3568}, ci:{lat:51.5048,lon:0.0495}
};

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
    if (townKey && FARE_CF[townKey] && FARE_CF[townKey][deAP]) {
      // Fixed all-in fare — no surcharge to add
      const fare = FARE_CF[townKey][deAP].out;
      const rdKey = townKey + '_' + deAP;
      const RD = { horsham_ga:{m:12,t:22}, horsham_he:{m:38,t:55}, lewes_ga:{m:28,t:38}, lewes_he:{m:62,t:80}, brighton_ga:{m:27,t:40}, brighton_he:{m:58,t:75}, worthing_ga:{m:28,t:42}, worthing_he:{m:55,t:70}, burgess_ga:{m:10,t:18}, haywards_ga:{m:18,t:28}, crawley_ga:{m:4,t:12}, crawley_he:{m:32,t:48}, eastbourne_ga:{m:42,t:55}, eastbourne_he:{m:72,t:92}, seaford_ga:{m:35,t:45}, uckfield_ga:{m:22,t:32}, eastgrinstead_ga:{m:14,t:22} };
      const rd = RD[rdKey] || {};
      return { fare, distance_miles: rd.m || null, duration_min: rd.t || null, rate_type: 'fixed', breakdown: `Fixed all-in fare: £${fare} (${FARE_APFULL[deAP]} drop-off)` };
    }
    // Unknown town — geocode + OSRM (per-mile fallback only)
    const [gc, apCoords] = await Promise.all([_fareGeocode(pickup), Promise.resolve(FARE_AP_COORDS[deAP])]);
    if (gc && apCoords) {
      const rt = await _fareRoute(gc.lat, gc.lon, apCoords.lat, apCoords.lon);
      if (rt) {
        const mi = Math.round(rt.distance / 1609.34 * 10) / 10;
        const ti = Math.round(rt.duration / 60);
        const f = _fareCalcMile(mi, night);
        return { fare: Math.ceil(f/0.5)*0.5, distance_miles: mi, duration_min: ti, rate_type: rateLabel, breakdown: `${mi} miles × tapered ${rateLabel} (no fixed fare for this area)` };
      }
    }
    const fallback = _fareCalcMile(15, night);
    return { fare: fallback, distance_miles: null, duration_min: null, rate_type: rateLabel + ' (estimated)', breakdown: 'Estimated ~15 miles (no fixed fare for this area)' };
  }

  // ── Pickup is airport ───────────────────────────────────────────────────
  if (puAP && !deAP) {
    const townKey = deT;
    if (townKey && FARE_CF[townKey] && FARE_CF[townKey][puAP]) {
      // Fixed all-in fare — no surcharge to add
      const fare = FARE_CF[townKey][puAP].ret;
      return { fare, distance_miles: null, duration_min: null, rate_type: 'fixed', breakdown: `Fixed all-in fare: £${fare} (${FARE_APFULL[puAP]} pickup)` };
    }
    const [apCoords, gc] = [FARE_AP_COORDS[puAP], await _fareGeocode(destination)];
    if (gc && apCoords) {
      const rt = await _fareRoute(apCoords.lat, apCoords.lon, gc.lat, gc.lon);
      if (rt) {
        const mi = Math.round(rt.distance / 1609.34 * 10) / 10;
        const ti = Math.round(rt.duration / 60);
        const f = _fareCalcMile(mi, night);
        return { fare: Math.ceil(f/0.5)*0.5, distance_miles: mi, duration_min: ti, rate_type: rateLabel, breakdown: `${mi} miles × tapered ${rateLabel} (no fixed fare for this area)` };
      }
    }
    const fallback = _fareCalcMile(15, night);
    return { fare: fallback, distance_miles: null, duration_min: null, rate_type: rateLabel + ' (estimated)', breakdown: 'Estimated ~15 miles (no fixed fare for this area)' };
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
      base_fare: Number(result.fare) || 0,
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
  FARE_APFULL,
  FARE_AP_COORDS,
};
