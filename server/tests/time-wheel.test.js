/**
 * Time wheel + passenger cap guardrail — run with:
 *   node server/tests/time-wheel.test.js   (also gated by `npm test`)
 *
 * TWO owner-approved changes that are easy to half-apply:
 *
 *   · THE TIME PICKER. The booking form and My Account each had their own —
 *     a grid of 96 HH:MM buttons on one, two tap-lists on the other. The owner
 *     asked for the iOS-clock spin wheel and for the two to be identical, so
 *     there is now ONE component (/wm-timewheel.js) and both call it. The risk
 *     is drift: someone "fixes" one surface and the two diverge again. The
 *     other risk is the value contract — the wheel must still produce "HH:MM"
 *     on a 24-hour clock, or the stored time, the fare call and the emails all
 *     change meaning.
 *
 *   · THE PASSENGER CAP. Four seats. A picker that offers a fifth is a booking
 *     the car cannot take.
 *
 * Pure Node: the wheel's pure helpers are exercised for real, the DOM parts are
 * asserted structurally. Exit 1 on failure.
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

console.log('\nTime wheel — one component, on both surfaces');

const WHEEL = read('wm-timewheel.js');
const wheel = require('../../wm-timewheel.js');

// ── The value contract ───────────────────────────────────────────────────
test('the wheel still speaks 24-hour HH:MM, exactly as before', () => {
  assert.strictEqual(typeof wheel.open, 'function', 'WMTimeWheel.open must exist');
  assert.strictEqual(wheel._isTime('05:30'), true);
  assert.strictEqual(wheel._isTime('23:55'), true);
  assert.strictEqual(wheel._isTime('24:00'), false, '24:00 is not a valid stored time');
  assert.strictEqual(wheel._isTime('5:30'), false, 'the hour must stay zero-padded');
  assert.strictEqual(wheel._isTime('ASAP'), false, 'ASAP is not a clock time');
});

test('a stored time snaps onto the wheel without changing meaning', () => {
  assert.deepStrictEqual(wheel._normalise('05:30'), { h: 5, m: 30 });
  assert.deepStrictEqual(wheel._normalise('05:32'), { h: 5, m: 30 }, 'nearest step, not a jump');
  assert.deepStrictEqual(wheel._normalise('05:58'), { h: 6, m: 0 }, 'rounding past the hour must carry');
  assert.deepStrictEqual(wheel._normalise('23:59'), { h: 0, m: 0 }, 'and must wrap at midnight, not produce 24:00');
});

test('ASAP and junk never become a bogus time', () => {
  // ASAP is a real stored value (see CLAUDE.md — "…TASAP" once produced
  // "Invalid Date" in every ASAP customer's email). The wheel must not be
  // handed one and must not invent one.
  for (const bad of ['ASAP', '', null, undefined, 'nonsense', '99:99']) {
    const r = wheel._normalise(bad);
    assert.ok(r.h >= 0 && r.h <= 23, 'hour out of range for ' + bad);
    assert.ok(r.m >= 0 && r.m < 60 && r.m % wheel.MIN_STEP === 0, 'minute off-grid for ' + bad);
  }
});

// ── It really is one component, used twice ───────────────────────────────
test('BOTH surfaces call the shared wheel — neither has its own time picker', () => {
  const picker = read('wm-picker.js');
  assert.ok(/WMTimeWheel\.open\(/.test(picker),
    'the public booking form must open the shared wheel');
  assert.ok(!/class="wm-time'/.test(picker) && !/data-t="/.test(picker),
    'wm-picker.js still builds its own grid of time buttons');

  const rider = read('westmere-rider.html');
  assert.ok(/WMTimeWheel\.open\(/.test(rider),
    'My Account must open the shared wheel');
});

test('every surface with a time field loads /wm-timewheel.js', () => {
  for (const f of ['book.html', 'index.html', 'westmere-rider.html']) {
    assert.ok(/<script src="\/wm-timewheel\.js"><\/script>/.test(read(f)),
      f + ' does not load /wm-timewheel.js — the time field would do nothing');
  }
  assert.ok(read('rider-sw.js').includes('/wm-timewheel.js'),
    'the service worker must precache the wheel, or an offline My Account has no time picker');
});

test('the wheel writes the value back through the existing path', () => {
  // The point of the contract: nothing downstream changes.
  const picker = read('wm-picker.js');
  assert.ok(/onConfirm: function \(t\) \{[\s\S]{0,200}input\.value = t;/.test(picker),
    'the booking form must still write HH:MM into the same input');
  const rider = read('westmere-rider.html');
  assert.ok(/onConfirm:function\(t\)\{[\s\S]{0,240}_rTConfirm_/.test(rider),
    'My Account must still confirm through _rTConfirm_, which writes the hidden field and recalculates the fare');
});

// ── It behaves like a wheel, not a list ──────────────────────────────────
test('it is a real scroll wheel: snap, momentum, a centre row and a frame', () => {
  assert.ok(/scroll-snap-type:y mandatory/.test(WHEEL), 'the columns must scroll-snap');
  assert.ok(/scroll-snap-align:center/.test(WHEEL), 'rows must snap to the CENTRE, like the iOS clock');
  assert.ok(/-webkit-overflow-scrolling:touch/.test(WHEEL), 'momentum scrolling must be enabled on iOS');
  assert.ok(/wmtw-band/.test(WHEEL), 'there must be a centre selection band');
  // The band is the frame language, not a filled block. The stylesheet is built
  // from an array of fragments, so reassemble it before matching a rule —
  // reading a single fragment finds only half a declaration.
  const css = WHEEL.split("'").filter(x => /[{};:]/.test(x)).join('');
  const band = css.match(/\.wmtw-band\{[^}]*\}/);
  assert.ok(band, 'the centre band rule is missing');
  assert.ok(/border:1\.5px solid #102a43/.test(band[0]), 'the band must be a navy FRAME: ' + band[0]);
  assert.ok(!/background:\s*#102a43/.test(band[0]), 'the band must not be a filled navy block');
});

test('no tab styling bleeds onto the wheel rows', () => {
  // The wheel's rows are listbox options with aria-selected="true". The theme
  // styles tabs with a bare [aria-selected="true"] and !important, which drew
  // an inset underline through the middle of the wheel. It must exclude the
  // wheel's rows explicitly.
  // Strip CSS comments first: a comment sitting inside the selector list would
  // otherwise be read as part of a selector and hide the bare one behind it.
  const theme = read('westmere-theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...theme.matchAll(/([^{}]*\[aria-selected="true"\][^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length, 'expected the theme tab rule');
  for (const r of rules) {
    if (!/box-shadow|border|background/.test(r[2])) continue;
    // Only a BARE [aria-selected="true"] can reach the wheel. A part already
    // qualified by something else — e.g. [data-vehicle-option][aria-selected]
    // — cannot match a .wmtw-opt and needs no exclusion.
    const bare = r[1].split(',').map(x => x.trim())
      .filter(x => /^\[aria-selected="true"\]/.test(x));
    for (const part of bare) {
      assert.ok(/:not\(\.wmtw-opt\)/.test(part),
        'a bare [aria-selected="true"] rule styles the time wheel rows too: ' + part.slice(0, 90));
    }
  }
});

test('it is usable without a touchscreen', () => {
  assert.ok(/role', 'listbox'/.test(WHEEL) && /role', 'option'/.test(WHEEL),
    'each column must be a listbox of options for screen readers');
  assert.ok(/aria-selected/.test(WHEEL), 'the selected row must be announced');
  assert.ok(/ArrowDown/.test(WHEEL) && /ArrowUp/.test(WHEEL), 'arrow keys must move the wheel');
  assert.ok(/e\.key === 'Enter'/.test(WHEEL), 'Enter must confirm');
  assert.ok(/e\.key === 'Escape'/.test(WHEEL), 'Escape must cancel');
  assert.ok(/addEventListener\('click', onTap/.test(WHEEL),
    'tapping a row must select it — a wheel you can only flick is hard to aim');
});

// ── Passenger cap ────────────────────────────────────────────────────────
console.log('\nPassengers cap at 4 — the car has four seats');

test('no passenger picker offers a fifth seat', () => {
  // My Account's option list…
  const rider = read('westmere-rider.html');
  const opts = rider.match(/var _rPAX_OPTS=\[([\s\S]*?)\];/);
  assert.ok(opts, 'the rider passenger options are missing');
  const values = [...opts[1].matchAll(/\{v:(\d+)/g)].map(m => +m[1]);
  assert.deepStrictEqual(values, [1, 2, 3, 4], 'My Account must offer exactly 1–4 passengers');
  assert.ok(/_rPAX_MAX=4/.test(rider), 'the cap must be declared once');
  assert.ok(/Math\.min\(_rPAX_MAX,/.test(rider),
    'the setter must clamp to the cap, so an older booking storing 6 comes back as 4 rather than throwing');

  // …and every <select>/<input> that picks passengers on a booking form.
  for (const f of ['book.html', 'westmere-admin.html']) {
    const src = read(f);
    const sel = src.match(/<select[^>]*name="passengers"[^>]*>([\s\S]*?)<\/select>/) ||
                src.match(/<select[^>]*id="nb-pax"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(sel, f + ': no passenger select found');
    const nums = [...sel[1].matchAll(/<option[^>]*>(\d+)</g)].map(m => +m[1]);
    assert.ok(nums.length, f + ': passenger select has no numeric options');
    assert.strictEqual(Math.max(...nums), 4, f + ' offers more than 4 passengers: ' + nums.join(','));
  }
  const owner = read('westmere-owner.html');
  const numInput = owner.match(/<input[^>]*id="nb-pax"[^>]*>/);
  assert.ok(numInput, 'the owner app passenger input is missing');
  const max = numInput[0].match(/max="(\d+)"/);
  assert.ok(max && +max[1] === 4, 'the owner app passenger input must cap at 4, got ' + (max || [])[1]);
});

test('the FLEET capacity field is not capped at 4', () => {
  // dm-max-pax is a vehicle's own seat count in the fleet settings — a
  // different thing entirely. Capping it would silently break the capacity
  // warning for any larger vehicle.
  const admin = read('westmere-admin.html');
  const m = admin.match(/<input[^>]*id="dm-max-pax"[^>]*>/);
  assert.ok(m, 'the fleet capacity field is missing');
  const max = m[0].match(/max="(\d+)"/);
  assert.ok(max && +max[1] > 4,
    'dm-max-pax is the VEHICLE seat count, not a passenger picker — it must not be capped at 4');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
