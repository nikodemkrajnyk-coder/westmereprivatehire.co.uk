/**
 * The booking funnel does not ask twice — run with:
 *   node server/tests/booking-carryover.test.js   (also gated by `npm test`)
 *
 * TWO FAULTS FROM THE CONVERSION AUDIT, both at the point of commitment:
 *
 * 1. A visitor typed a pickup and a drop-off on the homepage, got "approx £X",
 *    clicked through to book — and the booking form asked for the same two
 *    addresses again. Re-typing at the exact moment somebody has decided to
 *    commit is the worst place in a funnel to put work.
 *
 * 2. The address dropdown offered the same place several times over. Nominatim
 *    returns rows that are genuinely distinct to it — the terminal building,
 *    the airport polygon, the same site in the next district — but briefAddr()
 *    shortens all of them to the same words, so "Gatwick Airport" appeared five
 *    times, identical. Picking any of them looked like the box was broken.
 *
 * The dedupe is tested by RUNNING the shipped filter over real Nominatim-shaped
 * rows, not by reading it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const APP = read('booking-app.js');

console.log('\nThe booking funnel does not ask twice');

// ── 1. THE CARRY-OVER ────────────────────────────────────────────────────
test('the quick estimate saves what was typed, and the booking form applies it', () => {
  assert.ok(/function saveDraft\(/.test(APP), 'booking-app.js has no saveDraft() — nothing is carried');
  assert.ok(/function applyDraft\(/.test(APP), 'booking-app.js has no applyDraft() — nothing is restored');
  // The homepage widget must SAVE...
  const quick = APP.slice(APP.indexOf('function initQuick'), APP.indexOf('function init()'));
  assert.ok(/saveDraft\(/.test(quick),
    'the standalone quick-estimate widget never saves a draft, so nothing reaches the booking form');
  // ...and the booking form must APPLY.
  const form = APP.slice(APP.indexOf('function init()'));
  assert.ok(/applyDraft\(/.test(form), 'the booking form never applies the draft');
});

test('the addresses carry as FULL strings, not the shortened labels', () => {
  const save = APP.slice(APP.indexOf('function saveDraft'), APP.indexOf('function readDraft'));
  assert.ok(/fullAddr\(el\)/.test(save),
    'the draft stores the display value — the fare engine and the driver\'s navigation need the ' +
    'precise string the geocoder resolved, not the short label the field shows');
  const apply = APP.slice(APP.indexOf('function applyDraft'), APP.indexOf('// Standalone quick-estimate'));
  assert.ok(/dataset\.fullAddress = v\.full/.test(apply),
    'the restored field does not carry its full address forward — the booking would go out with the short form');
});

test('a draft never overwrites something the visitor is typing', () => {
  const apply = APP.slice(APP.indexOf('function applyDraft'), APP.indexOf('// Standalone quick-estimate'));
  assert.ok(/dataset\.userEdited/.test(apply), 'applyDraft ignores the user-edited flag');
  assert.ok(/\(el\.value \|\| ''\)\.trim\(\)/.test(apply), 'applyDraft overwrites a field that already has a value');
});

test('addresses travel in sessionStorage, never in the URL', () => {
  // A home address in a query string is logged by the server, kept in history
  // and handed to every referrer. It must not travel that way.
  assert.ok(/sessionStorage\.setItem\(DRAFT_KEY/.test(APP), 'the draft is not held in sessionStorage');
  const quick = APP.slice(APP.indexOf('function initQuick'), APP.indexOf('function init()'));
  assert.ok(!/location\.href\s*=|\?pickup=|searchParams\.set/.test(quick),
    'the quick estimate is putting the address into a URL');
});

test('the draft is cleared once the booking is actually made', () => {
  assert.ok(/function clearDraft\(/.test(APP), 'there is no clearDraft()');
  const ok = APP.slice(APP.indexOf('if (res.ok && res.d.ok)'), APP.indexOf('} else { throw new Error'));
  assert.ok(/clearDraft\(\)/.test(ok),
    'the draft survives a completed booking — the next one would open pre-filled with the last trip');
});

// ── 2. THE DUPLICATE SUGGESTIONS ─────────────────────────────────────────
// Rebuild the shipped pieces and run them, so this tests behaviour.
// briefAddr delegates to window.WMAddr.briefDisplay — the SHIPPED normaliser
// in address-normalize.js. Load the real thing rather than a stand-in, so the
// dedupe is tested against the labels customers actually see.
const WMAddr = (() => {
  const sandbox = { window: {}, module: { exports: {} } };
  sandbox.self = sandbox.window;
  new Function('window', 'self', 'module', 'exports', read('address-normalize.js'))(
    sandbox.window, sandbox.window, sandbox.module, sandbox.module.exports);
  return sandbox.window.WMAddr || sandbox.module.exports;
})();
assert.ok(WMAddr && typeof WMAddr.briefDisplay === 'function',
  'address-normalize.js no longer exports briefDisplay — the dropdown labels come from it');
const briefAddr = new Function('window',
  APP.slice(APP.indexOf('function briefAddr'), APP.indexOf('function setAddress')) +
  '\nreturn briefAddr;')({ WMAddr: WMAddr });

// The whole SHIPPED dedupe-and-disambiguate block, run verbatim. Returns the
// rows with the label the dropdown would actually print on each.
function dedupe(arr) {
  const start = APP.indexOf('var norm = function (x)');
  const end = APP.indexOf('arr.forEach(function (o) {\n              // SHORT LABEL');
  const src = APP.slice(start, end);
  assert.ok(start !== -1 && end > start, 'the autocomplete dedupe block has moved — re-point this harness');
  return new Function('arr', 'briefAddr', src + '\nreturn arr;')(arr, briefAddr);
}
const labelsOf = (rows) => rows.map(o => o._acLabel || briefAddr(o.display_name));

test('the shipped dedupe collapses five Gatwicks into one', () => {
  // Real Nominatim shapes: distinct rows, identical once shortened.
  const rows = [
    { display_name: 'Gatwick Airport, Crawley, West Sussex, England, RH6 0NP, United Kingdom' },
    { display_name: 'Gatwick Airport, Horley, Surrey, England, RH6 0NP, United Kingdom' },
    { display_name: 'Gatwick Airport, Mole Valley, Surrey, England, United Kingdom' },
    { display_name: 'Gatwick Airport, Charlwood, Surrey, England, RH6 0PJ, United Kingdom' },
    { display_name: 'Gatwick Airport, Reigate and Banstead, Surrey, England, United Kingdom' }
  ];
  const out = dedupe(rows);
  assert.strictEqual(out.length, 1, 'the dropdown still shows ' + out.length + ' identical entries');
  assert.strictEqual(out[0].display_name, rows[0].display_name,
    'the FIRST row must survive — Nominatim returns them in relevance order, so it is the best match');
});

test('genuinely different places are all kept', () => {
  const rows = [
    { display_name: 'Gatwick Airport, Crawley, West Sussex, England, RH6 0NP, United Kingdom' },
    { display_name: 'Gatwick Airport Railway Station, Crawley, West Sussex, England, United Kingdom' },
    { display_name: 'Heathrow Airport, Hillingdon, Greater London, England, United Kingdom' },
    { display_name: 'Brighton Station, Brighton and Hove, England, United Kingdom' }
  ];
  const out = dedupe(rows);
  assert.strictEqual(out.length, 4,
    'a de-duplicator that removes distinct places is worse than the duplicates it removes: got ' +
    labelsOf(out).join(' | '));
});

test('NOTHING the customer reads is repeated — the real complaint', () => {
  // Keeping a distinct place is only half of it. If two survivors PRINT the
  // same words the dropdown still looks broken, which is what was reported.
  const rows = [
    { display_name: 'Gatwick Airport, Crawley, West Sussex, England, RH6 0NP, United Kingdom' },
    { display_name: 'Gatwick Airport, Horley, Surrey, England, RH6 0NP, United Kingdom' },
    { display_name: 'Gatwick Airport, Mole Valley, Surrey, England, United Kingdom' },
    { display_name: 'Gatwick Airport, Charlwood, Surrey, England, RH6 0PJ, United Kingdom' },
    { display_name: 'Gatwick Airport, Reigate and Banstead, Surrey, England, United Kingdom' },
    { display_name: 'Gatwick Airport Railway Station, Crawley, West Sussex, England, United Kingdom' }
  ];
  const labels = labelsOf(dedupe(rows));
  assert.strictEqual(new Set(labels).size, labels.length,
    'the dropdown still prints the same words twice: ' + labels.join(' | '));
  assert.strictEqual(labels.length, 2, 'expected the airport and the station, got: ' + labels.join(' | '));
  assert.ok(labels.some(l => /railway station/i.test(l)),
    'the station was hidden or is indistinguishable from the airport: ' + labels.join(' | '));
});

test('the dedupe is case- and whitespace-insensitive, and drops nothing empty', () => {
  const rows = [
    { display_name: 'Lewes, East Sussex, England, United Kingdom' },
    { display_name: 'LEWES,  East Sussex, England, United Kingdom' },
    { display_name: 'Lewes, East Sussex, England, BN7 1XG, United Kingdom' }
  ];
  const out = dedupe(rows);
  assert.ok(out.length < rows.length, 'the same town in different casing is still repeated');
  assert.ok(out.length >= 1, 'the dedupe emptied the list');
});

test('the dropdown renders from the DEDUPED list, not the raw response', () => {
  const ac = APP.slice(APP.indexOf('function attachAutocomplete'), APP.indexOf('// ── Quick estimate (shared)'));
  const filtered = ac.indexOf('arr = arr.filter(');
  const rendered = ac.indexOf('arr.forEach(function (o) {');
  assert.ok(filtered !== -1, 'the dedupe is gone from attachAutocomplete');
  assert.ok(filtered < rendered, 'the list is rendered before it is deduped');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/booking-carryover\.test\.js/.test(read('package.json')), 'booking-carryover.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
