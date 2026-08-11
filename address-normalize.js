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
// Exposed as `module.exports` (server: require('../address-normalize')) AND as
// the browser global `window.WMAddr` (apps: <script src="/address-normalize.js">).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WMAddr = factory();
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Administrative region / country tokens — never shown.
  var SKIP = /^(england|scotland|wales|northern ireland|united kingdom|uk|u\.k\.|gb|great britain|greater london)$/i;
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
    for (var i = 0; i < AIRPORTS.length; i++) if (AIRPORTS[i][0].test(s)) return AIRPORTS[i][1];
    return null;
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

  // Split into cleaned comma-tokens with region + postcode tokens removed.
  function localityTokens(s) {
    return String(s).split(',').map(function (t) { return t.trim(); }).filter(Boolean)
      .filter(function (t) { return !SKIP.test(t); })
      .filter(function (t) { return !POSTCODE_TOKEN.test(t); });
  }

  // PRIMARY: the short display form (owner's spec). Airports special-cased.
  function shortDisplay(raw) {
    if (raw == null) return '';
    var s = String(raw).trim();
    if (!s) return '';

    var ap = findAirport(s);
    if (ap) { var term = terminalOf(s); return term ? (ap + ', ' + term) : ap; }

    var postcode = tidyPostcode(s);
    var tokens = localityTokens(s);
    if (!tokens.length) return postcode || s.split(',')[0].trim();

    // Optional leading "<house number> <street>" detail (only after a real number,
    // so town names beginning "St"/"Dr" etc. are never mistaken for streets).
    var detail = [], i = 0;
    if (HOUSE_NUM.test(tokens[0])) {
      detail.push(tokens[0]); i = 1;
      if (i < tokens.length && STREET.test(tokens[i])) { detail.push(tokens[i]); i++; }
    }
    var town = tokens[i] || tokens[tokens.length - 1] || '';

    var out = [];
    if (detail.length) out.push(detail.join(' '));
    if (town) out.push(town);
    if (postcode) out.push(postcode);
    // Drop accidental consecutive duplicates.
    return out.filter(function (v, idx) { return v && v !== out[idx - 1]; }).join(', ');
  }

  // SECONDARY: a single ultra-short label (airport-or-town) for tight UI such as
  // calendar cells / event titles. Preserves the old `_tinyAddr` behaviour.
  function tinyLabel(raw) {
    if (raw == null) return '';
    var s = String(raw).trim();
    if (!s) return '';
    var ap = findAirport(s);
    if (ap) return ap.replace(/ Airport$/, '');
    var tokens = localityTokens(s);
    if (!tokens.length) return s.split(',')[0].trim().slice(0, 18);
    var i = 0;
    if (HOUSE_NUM.test(tokens[0])) { i = 1; if (i < tokens.length && STREET.test(tokens[i])) i++; }
    return (tokens[i] || tokens[0]).slice(0, 18);
  }

  return {
    shortDisplay: shortDisplay,
    tinyLabel: tinyLabel,
    findAirport: findAirport,
    _spec: 'house+town+postcode / airport+terminal'
  };
}));
