// ── Address display normalizer — SINGLE SOURCE OF TRUTH ──────────────────
// Collapses a raw geocoder / geolocation string (Nominatim `display_name`,
// which is what the booking form stores) into the short, human-readable form
// the owner wants to SEE. The full precise address is always kept in the DB
// and used for navigation (Waze / maps) — this module only touches DISPLAY.
//
// WHY THIS EXISTS (root cause + regression history):
//   The booking autocomplete writes the full formatted address, e.g.
//     "Brighton, Brighton and Hove, England, BN1 1HJ, United Kingdom"
//     "Gatwick Airport, Station Approach Road, Lowfield Heath, Tinsley Green,
//      Crawley, West Sussex, England, RH6 0RD, United Kingdom"
//   into the pickup/destination fields. That raw string was then rendered
//   verbatim in the owner-alert email, the customer emails and the apps.
//   Shortening had been re-implemented ad-hoc in ~6 divergent copies
//   (_tinyAddr / _shortAddr / _admShortAddr …) and the EMAILS used none of
//   them, so the long form kept coming back. This module is the ONE place the
//   rule lives; every display site delegates here. The guardrail test
//   (server/tests/address-display.test.js) fails loudly if a long address
//   reappears in any email or if a template stops using this module.
//
// OWNER'S SPEC for the short form:
//   • Normal address → house number (if present) + town/locality + postcode
//       "Brighton, BN1 1HJ"        "12 High Street, Horsham, RH12 1AB"
//   • Airport         → airport name (+ terminal if specified)
//       "Gatwick Airport"          "Gatwick Airport, North Terminal"
//
// OLD RECORDS (second pass, Aug 2026): the rules above only really bit on the
// comma-separated geocoder strings that NEW bookings store. Older rows hold
// typed free text — "302 bishopsford Morden via Greenhill avenue caterham",
// lowercase, no commas, county/country tacked on — and those rendered in full
// on every surface. Normalisation is DISPLAY-ONLY and applies at render time,
// so it must cope with that legacy junk too:
//   • a " via <route>" leg is dropped (it is a routing note, not an address);
//   • county / district / borough / country tokens are stripped, whether they
//     are comma-separated tokens or just trailing words;
//   • all-lowercase input is title-cased, runs of whitespace collapse;
//   • a free-text blob is capped at its first few words (house no. + place).
// It cannot fix typos ("Bishopsfprd"), but it renders SHORT, never the full
// long string. Nothing is written back — the stored value stays intact for
// navigation. Guardrail: server/tests/address-display.test.js.
//
// AIRPORT DETECTION lives here too (`isAirport` / `isAirportRun` / `flightFor`)
// because "is this an airport run?" is a question about the ADDRESSES. Flight
// numbers are only shown on airport runs — see flightFor() below.
//
// Exposed as `module.exports` (server: require('../address-normalize')) AND as
// the browser global `window.WMAddr` (apps: <script src="/address-normalize.js">).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WMAddr = factory();
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Administrative region / country tokens — never shown.
  var SKIP = /^(england|scotland|wales|northern ireland|united kingdom|uk|u\.k\.|gb|great britain|greater london)$/i;
  // Ceremonial counties + unitary authorities that Nominatim (and people)
  // append after the town. Dropped: the town + postcode already locate it.
  var COUNTY = /^(west sussex|east sussex|mid sussex|sussex|surrey|kent|hampshire|hertfordshire|herts|berkshire|berks|buckinghamshire|bucks|oxfordshire|essex|middlesex|dorset|wiltshire|somerset|devon|cornwall|norfolk|suffolk|bedfordshire|beds|cambridgeshire|cambs|brighton and hove)$/i;
  // "…​ District" / "… Borough" / "London Borough of …" style admin areas.
  var ADMIN_AREA = /(^london borough of\b)|(\b(district|borough|county|council|unitary authority)$)/i;
  // A trailing region/country tacked onto free text WITHOUT a comma, e.g.
  // "302 Bishopsford Road Morden Surrey England". Applied repeatedly.
  var TRAIL_REGION = /[\s,]+(england|scotland|wales|northern ireland|united kingdom|u\.?k\.?|great britain|west sussex|east sussex|mid sussex|surrey|kent|hampshire|hertfordshire|berkshire|middlesex|greater london|essex)\.?$/i;
  // A " via <somewhere>" leg is a routing note, not part of the address.
  var VIA = /\s+\bvia\b\s+.+$/i;
  // Free text with no usable comma structure: keep this many words at most.
  var FREETEXT_WORDS = 6;
  // Words that stay lowercase inside a title-cased name (never first).
  var SMALL_WORD = /^(and|of|the|on|upon|in|le|la|sur|by|next|under)$/i;
  // A full UK postcode anywhere in the string (outward + inward).
  var POSTCODE_FULL = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
  // A single comma-token that is (all of) a postcode — full or outward only.
  var POSTCODE_TOKEN = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i;
  // Street-type words: only consumed as part of a "<number> <street>" detail line.
  var STREET = /\b(road|rd|street|lane|avenue|ave|close|way|drive|court|place|terrace|crescent|cres|grove|gardens|gdns|row|walk|mews|parade|square|broadway|boulevard|approach|wharf|quay|embankment)\b/i;
  var HOUSE_NUM = /^\d+[a-z]?$/i;

  // Airports → canonical display name (specific patterns before generic).
  var AIRPORTS = [
    [/gatwick/i, 'Gatwick Airport'],
    [/heathrow/i, 'Heathrow Airport'],
    [/stansted/i, 'Stansted Airport'],
    [/\bluton\b/i, 'Luton Airport'],
    [/london city airport|\bcity airport\b/i, 'London City Airport'],
    [/southampton airport/i, 'Southampton Airport'],
    [/\bbristol airport\b/i, 'Bristol Airport'],
    [/\bbirmingham airport\b/i, 'Birmingham Airport'],
    [/\bmanchester airport\b/i, 'Manchester Airport'],
    [/\bfarnborough airport\b/i, 'Farnborough Airport'],
    [/\bbiggin hill\b/i, 'Biggin Hill Airport']
  ];
  var TERMINAL = /\b(north terminal|south terminal|terminal\s*([1-5])|\bt([1-5])\b)\b/i;

  function findAirport(s) {
    if (s == null) return null;
    for (var i = 0; i < AIRPORTS.length; i++) if (AIRPORTS[i][0].test(s)) return AIRPORTS[i][1];
    return null;
  }

  // ── Airport detection (the flight-number gate) ───────────────────────────
  // Wider than findAirport: an airport we have no canonical name for is still
  // an airport. Codes are matched CASE-SENSITIVELY so "Manchester" (the city)
  // never reads as MAN and "Stanmore" never as STN.
  var AIRPORT_WORD = /\b(airport|airfield|aerodrome)\b/i;
  var AIRPORT_CODE = /\b(LGW|LHR|STN|LTN|LCY|SEN|SOU|BHX|MAN|BRS|EMA|NCL|EDI|GLA|LPL|LBA|ABZ|BFS|CWL|EXT|NQY)\b/;

  function isAirport(s) {
    if (s == null) return false;
    var v = String(s);
    if (!v.trim()) return false;
    return !!findAirport(v) || AIRPORT_WORD.test(v) || AIRPORT_CODE.test(v);
  }

  // True when ANY leg of the journey touches an airport. Takes the raw
  // addresses (pickup, destination, and any stop) in any order.
  function isAirportRun() {
    for (var i = 0; i < arguments.length; i++) if (isAirport(arguments[i])) return true;
    return false;
  }

  // ── THE flight-number rule ──────────────────────────────────────────────
  // A flight number belongs to an AIRPORT run and nowhere else. On a
  // town-to-town job the field is meaningless (and used to leak into the
  // pickup address in the admin list, reading like part of the address), so
  // every surface asks HERE instead of testing `booking.flight` directly.
  // Returns the tidied flight number, or '' — meaning "render no flight
  // field at all". Accepts every booking shape in the codebase: the API row
  // (pickup/destination), the owner app (pickup/dest) and the rider app
  // (from/dest).
  function flightFor(b) {
    if (!b) return '';
    var f = String(b.flight == null ? '' : b.flight).trim();
    if (!f) return '';
    return isAirportRun(b.pickup, b.from, b.destination, b.dest, b.stop_address)
      ? f.toUpperCase().replace(/\s+/g, '')
      : '';
  }

  // Title-case a word that was typed in all lowercase; anything the user
  // already capitalised (or that starts with a digit) is left alone.
  function fixWord(w, first) {
    if (!w) return w;
    if (/[A-Z]/.test(w)) return w;
    if (/^\d/.test(w)) return w;
    if (!first && SMALL_WORD.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  function tidyCase(s) {
    return String(s).split(' ').map(function (w, i) {
      return w.split('-').map(function (p, j) { return fixWord(p, i === 0 && j === 0); }).join('-');
    }).join(' ');
  }

  // Strip routing notes, trailing regions and duplicate whitespace before any
  // structural parsing. Purely cosmetic — the stored value is untouched.
  function preClean(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    s = s.replace(VIA, '');
    var guard = 0;
    while (TRAIL_REGION.test(s) && guard++ < 6) s = s.replace(TRAIL_REGION, '');
    return s.replace(/[\s,]+$/, '').trim();
  }

  function terminalOf(s) {
    var m = String(s).match(TERMINAL);
    if (!m) return '';
    if (/north/i.test(m[0])) return 'North Terminal';
    if (/south/i.test(m[0])) return 'South Terminal';
    var num = m[2] || m[3];
    return num ? ('Terminal ' + num) : '';
  }

  function tidyPostcode(s) {
    var m = String(s).toUpperCase().match(POSTCODE_FULL);
    return m ? (m[1] + ' ' + m[2]) : '';
  }

  // A comma-token that is an administrative area, a country or a postcode —
  // never part of the short display form.
  function isNoiseToken(t) {
    return SKIP.test(t) || COUNTY.test(t) || ADMIN_AREA.test(t) || POSTCODE_TOKEN.test(t);
  }

  // Split into cleaned comma-tokens with region + postcode tokens removed.
  function localityTokens(s) {
    return String(s).split(',').map(function (t) { return t.trim(); }).filter(Boolean)
      .filter(function (t) { return !isNoiseToken(t); });
  }

  // A token that already reads "<number> <something>" ("302 Bishopsford Road")
  // or is a bare street line ("High Street") is the address DETAIL, and the
  // next token is the town.
  function isDetailToken(t) {
    return /^\d+[a-z]?\s+\S/i.test(t) || STREET.test(t);
  }

  // "Flat 2", "Unit 5", "Apartment 3B" — the door, not the town. Kept (a
  // driver needs it) but it never stands in for the locality.
  var SUBPREMISE = /^(flat|apartment|apt|unit|suite|studio|maisonette|annexe|annex|room)\b/i;

  // Cut to `n` characters without slicing a word in half.
  function clip(s, n) {
    var v = String(s);
    if (v.length <= n) return v;
    var cut = v.slice(0, n);
    var sp = cut.lastIndexOf(' ');
    return (sp > 6 ? cut.slice(0, sp) : cut).replace(/[\s,]+$/, '');
  }

  // Cap an unstructured blob at its first few words so a legacy free-text
  // record renders short instead of dumping the whole typed sentence.
  function capWords(t) {
    var w = String(t).split(' ').filter(Boolean);
    return w.length <= FREETEXT_WORDS ? w.join(' ') : w.slice(0, FREETEXT_WORDS).join(' ');
  }

  // PRIMARY: the short display form (owner's spec). Airports special-cased.
  function shortDisplay(raw) {
    if (raw == null) return '';
    var s = preClean(raw);
    if (!s) return '';

    var ap = findAirport(s);
    if (ap) { var term = terminalOf(s); return term ? (ap + ', ' + term) : ap; }

    var postcode = tidyPostcode(s);
    var tokens = localityTokens(s);
    if (!tokens.length) return postcode || tidyCase(capWords(s.split(',')[0].trim()));

    // Optional leading detail line. A bare house number takes the following
    // street token with it; an inline "<number> <street>" or a plain street
    // line is a detail on its own. A town name beginning "St"/"Dr" is never
    // mistaken for a street, because that needs a number or a street word.
    var sub = '', detail = [], i = 0;
    if (SUBPREMISE.test(tokens[0])) { sub = tokens[0]; i = 1; }
    if (i < tokens.length && HOUSE_NUM.test(tokens[i])) {
      detail.push(tokens[i]); i++;
      if (i < tokens.length && STREET.test(tokens[i])) { detail.push(tokens[i]); i++; }
    } else if (i < tokens.length && isDetailToken(tokens[i])) {
      detail.push(tokens[i]); i++;
    }
    var town = tokens[i] || ((sub || detail.length) ? '' : tokens[tokens.length - 1]) || '';

    var out = [];
    if (sub) out.push(capWords(sub));
    if (detail.length) out.push(capWords(detail.join(' ')));
    if (town) out.push(capWords(town));
    if (postcode) out.push(postcode);
    // Drop accidental consecutive duplicates, then tidy the casing of any
    // part that was typed in lowercase.
    return out.filter(function (v, idx) { return v && v !== out[idx - 1]; })
      .map(function (v) { return POSTCODE_TOKEN.test(v) ? v : tidyCase(v); })
      .join(', ');
  }

  // SECONDARY: a single ultra-short label (airport-or-town) for tight UI such as
  // calendar cells / event titles. Preserves the old `_tinyAddr` behaviour.
  function tinyLabel(raw) {
    if (raw == null) return '';
    var s = preClean(raw);
    if (!s) return '';
    var ap = findAirport(s);
    if (ap) return ap.replace(/ Airport$/, '');
    var tokens = localityTokens(s);
    if (!tokens.length) return clip(tidyCase(s.split(',')[0].trim()), 18);
    var i = 0;
    if (SUBPREMISE.test(tokens[0]) && tokens.length > 1) i = 1;
    if (HOUSE_NUM.test(tokens[i])) { i++; if (i < tokens.length && STREET.test(tokens[i])) i++; }
    else if (tokens.length > i + 1 && isDetailToken(tokens[i])) i++;
    return clip(tidyCase(tokens[i] || tokens[0]), 18);
  }

  // BRIEF: shortDisplay, then capped to a handful of words.
  //
  // The booking form's autocomplete lists raw Nominatim `display_name` strings,
  // which run to things like "London Borough of Hillingdon, Greater London,
  // England, United Kingdom" — unreadable in a dropdown on a phone. shortDisplay
  // already strips the country and the administrative tail, but a full street
  // address can still come back as "14 Queens Road, Haywards Heath, RH16 1EA"
  // (7 words). This drops trailing comma-parts until the label fits.
  //
  // DISPLAY ONLY. The caller keeps the full string for the booking record and
  // for navigation — same rule as every other surface in the system.
  function briefDisplay(raw, maxWords) {
    var max = maxWords > 0 ? maxWords : 5;
    var s = shortDisplay(raw);
    if (!s) return '';
    var parts = s.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) return s;
    var words = function (t) { return t.split(/\s+/).filter(Boolean).length; };

    // The first part always survives — a label with nothing in it is worse than
    // a long one — but it is itself clipped if it alone overruns.
    var out = [parts[0]];
    var used = words(parts[0]);
    if (used > max) {
      return parts[0].split(/\s+/).filter(Boolean).slice(0, max).join(' ');
    }
    for (var i = 1; i < parts.length; i++) {
      var w = words(parts[i]);
      if (used + w > max) break;
      out.push(parts[i]);
      used += w;
    }
    return out.join(', ');
  }

  return {
    shortDisplay: shortDisplay,
    briefDisplay: briefDisplay,
    tinyLabel: tinyLabel,
    findAirport: findAirport,
    isAirport: isAirport,
    isAirportRun: isAirportRun,
    flightFor: flightFor,
    _spec: 'house+town+postcode / airport+terminal; flight only on airport runs'
  };
}));
