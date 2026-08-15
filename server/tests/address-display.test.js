/**
 * Address-display regression guard — run with:
 *   node server/tests/address-display.test.js
 *
 * The owner asked for SHORT addresses everywhere they are shown, and for a
 * guardrail because the change had regressed before. Root cause: the raw
 * geocoder string (Nominatim `display_name`) was rendered verbatim, and the
 * ad-hoc shorteners were duplicated + inconsistent (the emails used none). The
 * fix routes every DISPLAY through the ONE shared normalizer, address-normalize.js.
 *
 * This test fails loudly (exit 1) if:
 *   (a) the normalizer stops producing the owner's short form,
 *   (b) an airport stops collapsing to name(+terminal),
 *   (c) a long raw address leaks back into any of the three key emails, OR a
 *       display template stops delegating to the shared normalizer,
 *   (d) the full precise address stops being used for navigation (Waze).
 *
 * Pure Node, no framework, Resend stubbed via global.fetch.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// The two real long strings from the WM-OKAMDV owner-alert (the reported bug).
const LONG_PICKUP = 'Brighton, Brighton and Hove, England, BN1 1HJ, United Kingdom';
const LONG_DROPOFF = 'Gatwick Airport, Station Approach Road, Lowfield Heath, Tinsley Green, Crawley, West Sussex, England, RH6 0RD, United Kingdom';
// Fragments that must NEVER appear as display text once shortened.
const LONG_FRAGMENTS = [', United Kingdom', ', England', 'Brighton and Hove', 'Station Approach Road', 'Tinsley Green', 'West Sussex', 'Lowfield Heath'];

// ── (a) + (b) Normalizer unit tests ──────────────────────────────────────
console.log('\nAddress normalizer (shared source of truth)');
const addr = require('../../address-normalize');

test('collapses the two reported long strings to the owner short form', () => {
  assert.strictEqual(addr.shortDisplay(LONG_PICKUP), 'Brighton, BN1 1HJ');
  assert.strictEqual(addr.shortDisplay(LONG_DROPOFF), 'Gatwick Airport');
});
test('house number + street + town + postcode is preserved', () => {
  assert.strictEqual(
    addr.shortDisplay('12, High Street, Horsham, Mid Sussex, West Sussex, England, RH12 1AB, United Kingdom'),
    '12 High Street, Horsham, RH12 1AB');
});
test('airport collapses to name, with terminal when specified', () => {
  assert.strictEqual(addr.shortDisplay('London Gatwick Airport, North Terminal, Crawley, West Sussex, RH6 0NP, United Kingdom'), 'Gatwick Airport, North Terminal');
  assert.strictEqual(addr.shortDisplay('Heathrow Airport Terminal 5, Longford, TW6 2GA, United Kingdom'), 'Heathrow Airport, Terminal 5');
  assert.strictEqual(addr.shortDisplay('Gatwick Airport, Crawley, RH6 0RD, United Kingdom'), 'Gatwick Airport');
});
test('a town whose name starts "St" is not mistaken for a street', () => {
  assert.strictEqual(addr.shortDisplay('St Albans, Hertfordshire, England, AL1 1AA, United Kingdom'), 'St Albans, AL1 1AA');
});
test('short output never contains a stripped region/country fragment', () => {
  for (const raw of [LONG_PICKUP, LONG_DROPOFF]) {
    const out = addr.shortDisplay(raw);
    for (const frag of LONG_FRAGMENTS) assert.ok(!out.includes(frag), 'short form leaked "' + frag + '": ' + out);
  }
});

// ── (a2) OLD RECORDS — messy typed free text must shorten too ────────────
// The first pass only really bit on the comma-separated geocoder strings NEW
// bookings store. Older rows hold typed free text ("302 bishopsford Morden via
// Greenhill avenue caterham"), and those rendered in FULL on every surface
// because nothing in the normalizer could take them apart. Normalisation is
// applied at RENDER time, so it has to cope with legacy junk as well.
console.log('\nOld messy records shorten too (render-time, no data migration)');

// Real-world shapes: no commas, lowercase, typos, a routing note, county and
// country tacked on the end.
const OLD_RECORDS = [
  '302 bishopsford Morden via Greenhill avenue caterham',
  'Bishopsfprd road, morden, surrey, england',
  '302 bishopsford road morden surrey england',
  '  crawley,  west sussex , england ',
  'Redhill, Reigate and Banstead, Surrey, England, RH1 1AA, United Kingdom',
  'flat 2, 14 queens road, haywards heath, west sussex, rh16 1ea, united kingdom'
];
// Fragments that must never survive into the short form of an OLD record.
const OLD_FRAGMENTS = [', England', ', United Kingdom', 'united kingdom', 'england',
  'surrey', 'Surrey', 'West Sussex', 'west sussex', ' via '];

test('an old messy record renders SHORT — county/country/route noise stripped', () => {
  for (const raw of OLD_RECORDS) {
    const out = addr.shortDisplay(raw);
    assert.ok(out, 'an old record must still render something: ' + raw);
    for (const frag of OLD_FRAGMENTS) {
      assert.ok(!out.includes(frag),
        'the short form of "' + raw + '" still contains "' + frag + '": ' + out);
    }
    assert.ok(out.length < raw.trim().length,
      'the short form must be SHORTER than the stored string — got "' + out + '" from "' + raw + '"');
  }
});

test('specific old-record shapes render the way the owner asked', () => {
  // A " via <route>" leg is a routing note, not part of the address.
  assert.strictEqual(addr.shortDisplay('302 bishopsford Morden via Greenhill avenue caterham'),
    '302 Bishopsford Morden');
  // A street line with no house number keeps its town.
  assert.strictEqual(addr.shortDisplay('Bishopsfprd road, morden, surrey, england'),
    'Bishopsfprd Road, Morden');
  // Trailing county/country with no commas at all.
  assert.strictEqual(addr.shortDisplay('302 bishopsford road morden surrey england'),
    '302 Bishopsford Road Morden');
  // Lowercase input is tidied; the postcode is uppercased and spaced.
  assert.strictEqual(addr.shortDisplay('  crawley,  west sussex , england '), 'Crawley');
  assert.strictEqual(addr.shortDisplay('12 high street, horsham, rh12 1ab'),
    '12 High Street, Horsham, RH12 1AB');
});

test('an unstructured blob is capped, not dumped in full', () => {
  const rambling = 'pick up outside the big white house on the corner opposite the church in slinfold near horsham west sussex england';
  const out = addr.shortDisplay(rambling);
  assert.ok(out.split(' ').length <= 6, 'a free-text blob must be capped to a few words: ' + out);
  assert.ok(!/england|sussex/i.test(out), 'region noise must still be stripped: ' + out);
});

test('normalising is DISPLAY-only — the input string is never mutated', () => {
  const raw = '302 bishopsford Morden via Greenhill avenue caterham';
  const copy = String(raw);
  addr.shortDisplay(raw);
  addr.tinyLabel(raw);
  assert.strictEqual(raw, copy, 'the normalizer must not mutate what it is given');
  // …and it has no database access at all, so it cannot rewrite a stored value:
  // the normalizer is a pure display module with no way to persist anything.
  const src = read('address-normalize.js');
  for (const forbidden of [/better-sqlite3/, /getDb\(/, /\bUPDATE\s+bookings\b/i, /require\('\.\/db'\)/]) {
    assert.ok(!forbidden.test(src),
      'address-normalize.js must stay a pure display module — it must never touch stored data (' + forbidden + ')');
  }
});

// ── (c) The real email templates must use the normalizer (no leak) ───────
console.log('\nEmails render the SHORT address, keep FULL for nav');

// Render an email by stubbing Resend's HTTP call and capturing the payload.
async function renderEmail(fnName, booking) {
  process.env.RESEND_API_KEY = 'test_fake_key';
  process.env.ADMIN_EMAIL = 'owner@example.com';
  let captured = { html: '', subject: '' };
  global.fetch = async (url, opts) => {
    const p = JSON.parse(opts.body);
    captured = { html: p.html || '', subject: p.subject || '' };
    return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
  };
  delete require.cache[require.resolve('../email')];
  const email = require('../email');
  await email[fnName](booking);
  return captured;
}

const BASE = {
  ref: 'WM-OKAMDV', name: 'Test Customer', email: 'cust@example.com', phone: '07000000000',
  pickup: LONG_PICKUP, destination: LONG_DROPOFF, date: '2026-08-20', time: '10:00',
  fare: 99, pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
};

for (const fnName of ['sendAdminAlert', 'sendCustomerEstimate', 'sendCustomerConfirmed', 'sendCustomerAcknowledgement']) {
  test(fnName + ': shows short address, never the long raw form', async () => {
    const { html, subject } = await renderEmail(fnName, BASE);
    assert.ok(html.length > 0, 'no html captured');
    // Short forms are present…
    assert.ok(html.includes('Brighton, BN1 1HJ'), 'short pickup missing from ' + fnName);
    assert.ok(html.includes('Gatwick Airport'), 'short drop-off missing from ' + fnName);
    // …and the long fragments are gone from the visible body + subject.
    for (const frag of LONG_FRAGMENTS) {
      assert.ok(!html.includes(frag), fnName + ' leaked long fragment "' + frag + '" into the email body');
      assert.ok(!subject.includes(frag), fnName + ' leaked long fragment "' + frag + '" into the subject');
    }
  });
}

test('owner-alert keeps the FULL address in the Waze nav link (routing intact)', async () => {
  const { html } = await renderEmail('sendAdminAlert', BASE);
  const fullPu = 'waze.com/ul?q=' + encodeURIComponent(LONG_PICKUP);
  const fullDe = 'waze.com/ul?q=' + encodeURIComponent(LONG_DROPOFF);
  assert.ok(html.includes(fullPu), 'Waze pickup link lost the full precise address');
  assert.ok(html.includes(fullDe), 'Waze drop-off link lost the full precise address');
});

// ── (c) Static check: every display template delegates to the normalizer ──
console.log('\nDisplay templates delegate to the single source of truth');

test('email.js imports the shared normalizer and never renders a raw address', () => {
  const src = read('server/email.js');
  assert.ok(/require\('\.\.\/address-normalize'\)/.test(src), 'email.js must require ../address-normalize');
  assert.ok(/function dispAddr/.test(src), 'email.js must define the dispAddr display helper');
  // No template may print a raw pickup/destination again.
  for (const bad of [/escHtml\(pickup\)/, /escHtml\(destination\)/, /escHtml\(d\.pickup\)/, /escHtml\(d\.destination\)/, /escHtml\(b\.pickup/, /escHtml\(b\.destination/, /detailRow\('Pickup', pickup\)/]) {
    assert.ok(!bad.test(src), 'email.js still renders a raw address: ' + bad);
  }
});

// westmere-rider.html is the LIVE customer "My Account" app (westmere-account.html
// 301-redirects to it), so the guardrail protects the rider app, not the legacy one.
test('owner + admin + rider + driver apps and the pay page load the normalizer', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html',
                   'westmere-driver.html', 'westmere-pay.html']) {
    const src = read(f);
    assert.ok(/<script src="\/address-normalize\.js">/.test(src), f + ' must load /address-normalize.js');
    assert.ok(/WMAddr\.shortDisplay/.test(src), f + ' must delegate its short-address helper to WMAddr.shortDisplay');
  }
});

// The calendar/ICS/PDF surfaces used to carry their OWN divergent copies of the
// shortener — exactly the duplication this module was written to kill — so an
// old record could still render long in a calendar entry or on an invoice.
test('calendar, ICS and PDF surfaces delegate to the shared normalizer', () => {
  for (const f of ['server/google-calendar.js', 'server/driver-cal-routes.js',
                   'server/google-routes.js', 'server/invoice-pdf.js', 'server/whatsapp.js']) {
    const src = read(f);
    assert.ok(/require\('\.\.\/address-normalize'\)/.test(src),
      f + ' must require the shared ../address-normalize');
    assert.ok(!/const _AIRPORTS = \[/.test(src),
      f + ' still carries its own local copy of the address shortener');
  }
});

// ── (g) NO "Pickup:" LABEL ON A CALENDAR EVENT ───────────────────────────
// The owner's report: a calendar entry still read "Pickup: <address>". The
// booking sync (google-calendar.js) had already been cleaned up — its title is
// the bare route and its location is the short address — but TWO other
// composers were left on the old labelled format and nobody noticed, because
// they are different code paths: google-routes.js builds the staff "add to
// calendar" event, and driver-cal-routes.js builds the driver's ICS feed. A
// booking created through either still carried the prefix.
console.log('\nCalendar events carry the address alone — no "Pickup:" label');

const CAL_SURFACES = ['server/google-calendar.js', 'server/google-routes.js', 'server/driver-cal-routes.js'];

test('no calendar composer labels an address with "Pickup"', () => {
  for (const f of CAL_SURFACES) {
    for (const [i, line] of read(f).split('\n').entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;           // comments may say the word
      if (/Waze|maps\.google/.test(line)) continue;        // "Pickup (Waze)" is a link label
      assert.ok(!/`?Pickup:\s*\$\{|'Pickup: '\s*\+|"Pickup: "\s*\+/.test(line),
        f + ':' + (i + 1) + ' still prefixes an address with "Pickup:" — ' +
        'the address must stand alone:\n        ' + line.trim().slice(0, 110));
    }
  }
});

test('the ICS feed titles an event with the route, not a label', () => {
  const ics = read('server/driver-cal-routes.js');
  for (const m of ics.matchAll(/SUMMARY:'\s*\+\s*icsEscape\(`([^`]*)`/g)) {
    // Strip the ${...} interpolations first: `booking.pickup` is a property
    // name, not a label, and matching it would fail on correct code.
    const literal = m[1].replace(/\$\{[^}]*\}/g, '');
    assert.ok(!/Pickup/i.test(literal),
      'an ICS SUMMARY still carries a Pickup label: ' + m[1]);
  }
  assert.ok(/SUMMARY/.test(ics), 'expected the ICS composer to still build a SUMMARY');
});

test('every calendar LOCATION uses the SHORT address, never the raw string', () => {
  // LOCATION is a display field; the Waze links in the description keep the
  // full address, which is what actually gets navigated to.
  for (const f of ['server/google-routes.js', 'server/driver-cal-routes.js']) {
    const src = read(f);
    for (const m of src.matchAll(/location:\s*([^,\n]+)|LOCATION:'\s*\+\s*icsEscape\(([^)]*)\)/gi)) {
      const expr = (m[1] || m[2] || '').trim();
      if (!expr) continue;
      assert.ok(/_shortAddr|shortDisplay/.test(expr),
        f + ' sets a calendar location from the raw address: ' + expr.slice(0, 80));
    }
  }
});

test('the composed events really do come out clean', () => {
  // Driven, not just grepped: build a real event and read it.
  const LONG_PU = '14 Queens Road, Haywards Heath, Mid Sussex, West Sussex, England, RH16 1EA, United Kingdom';
  const LONG_DE = 'Gatwick Airport, Crawley, West Sussex, England, RH6 0NP, United Kingdom';
  const gcal = require('../google-calendar');
  const ev = gcal.bookingToEvent({
    ref: 'WM-CAL', date: '2026-09-04', time: '05:30', pickup: LONG_PU, destination: LONG_DE,
    customer_name: 'Test', status: 'confirmed'
  });
  assert.ok(!/Pickup:/.test(ev.summary + ' ' + ev.description + ' ' + (ev.location || '')),
    'the composed event still contains a "Pickup:" label');
  assert.ok(!/United Kingdom|Mid Sussex/.test(ev.summary + ' ' + (ev.location || '')),
    'the composed event still carries the long raw address: ' + ev.summary + ' | ' + ev.location);
  assert.ok(/Gatwick/.test(ev.summary), 'the title should still name the destination');
  // …and the FULL address must survive where navigation needs it.
  assert.ok(ev.description.includes(encodeURIComponent(LONG_DE)),
    'the Waze link must still route to the FULL destination address');
});

// ── (h) THE AI ASSISTANT SHOWS SHORT ADDRESSES ───────────────────────────
// The owner's report: the assistant still read back the full geocoder string.
// Root cause: the earlier address work covered every surface that renders
// HTML — emails, the apps, the calendar, the invoice — and missed this one,
// because the assistant renders addresses into PROMPT TEXT. The model then
// repeats whatever it was handed, so a raw address in the tool result or in the
// system prompt comes straight back out in the reply.
console.log('\nThe assistant reads back SHORT addresses');

test('assistant-routes.js delegates to the shared normalizer', () => {
  const src = read('server/assistant-routes.js');
  assert.ok(/require\('\.\.\/address-normalize'\)/.test(src),
    'server/assistant-routes.js must require the shared ../address-normalize');
});

test('every address the assistant echoes goes through the shortener', () => {
  const src = read('server/assistant-routes.js');
  const offenders = [];
  for (const [i, line] of src.split('\n').entries()) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/description:/.test(line)) continue;              // tool schema prose
    // A line that renders BOTH ends of a journey into text is an echo.
    if (!/\$\{[^}]*pickup[^}]*\}/.test(line)) continue;
    if (!/→|\\u2192/.test(line)) continue;
    if (!/shortAddr|shortDisplay/.test(line)) {
      offenders.push((i + 1) + ': ' + line.trim().slice(0, 100));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'the assistant echoes a raw address — it will read the full geocoder string ' +
    'back to the owner:\n      ' + offenders.join('\n      '));
});

test('the owner app assistant cards render the short address', () => {
  const src = read('westmere-owner.html');
  // showBookingCard shortened the DESTINATION and missed the PICKUP line
  // directly above it, which is how a long address kept appearing next to a
  // short one in the very same card.
  const cards = [...src.matchAll(/rows\.push\('<strong>(Pickup|Destination):<\/strong> '\+escH\(([^)]*)\)/g)];
  assert.ok(cards.length >= 2, 'expected the assistant booking cards');
  for (const m of cards) {
    assert.ok(/_shortAddr/.test(m[2]),
      'an assistant card renders a raw ' + m[1] + ': ' + m[2]);
  }
  // …and the spoken/typed transcript too.
  const echo = src.match(/\+\(bk\.pickup\?'Pickup: '\+([^+]*)\+/);
  assert.ok(echo && /_shortAddr/.test(echo[1]),
    'the assistant transcript echoes a raw pickup address');
});

test('the assistant still BOOKS and geocodes the full address', () => {
  // Display-only: shortening what the model reads back must not change what is
  // written to the database or what the fare engine geocodes.
  const src = read('server/assistant-routes.js');
  assert.ok(/calculateFare\(input\.pickup, input\.destination/.test(src),
    'calculate_fare must still geocode the FULL address the owner dictated');
  assert.ok(!/shortAddr\(input\.pickup\)/.test(src),
    'the assistant must never shorten an address on its way INTO a booking or a fare');
});

test('navigation keeps the FULL address on every app surface', () => {
  // Waze / Google Maps links must never be built from the shortened display
  // form, or an old record's short label would be routed to instead.
  for (const [f, pattern] of [
    ['westmere-driver.html', /maps\.google\.com\/\?q='\+encodeURIComponent\(j\.dest(ination)?\|\|''\)/],
    ['westmere-owner.html', /encodeURIComponent\(j\.pickup\|\|''\)/],
    ['westmere-admin.html', /waze\.com|maps\.google\.com/]
  ]) {
    assert.ok(pattern.test(read(f)), f + ' must keep the full stored address in its navigation links');
  }
  const gcal = read('server/google-calendar.js');
  assert.ok(/waze\.com\/ul\?q=\$\{encodeURIComponent\(b\.destination\)\}/.test(gcal),
    'the calendar Waze link must use the FULL destination');
});

// ── (f) THE BOOKING FORM'S PICKER IS SHORT ───────────────────────────────
// The owner's report: the pickup/drop-off autocomplete and "Use my current
// location" showed the raw Nominatim display_name — "London Borough of
// Hillingdon, Greater London, England, United Kingdom", "Hillingdon, Greater
// London, England, TW6 2C…". Unreadable in a dropdown, and worse once it landed
// in the field. The label is now capped; the booking still carries the precise
// address, because that is what the driver navigates to.
console.log('\nThe booking form shows a SHORT address, and books the full one');

const NOMINATIM = [
  'London Borough of Hillingdon, Greater London, England, United Kingdom',
  'Hillingdon, Greater London, England, TW6 2CX, United Kingdom',
  'Heathrow Airport, Longford, London Borough of Hillingdon, Greater London, England, TW6 1AP, United Kingdom',
  '14 Queens Road, Haywards Heath, Mid Sussex, West Sussex, England, RH16 1EA, United Kingdom',
  'Gatwick Airport, Crawley, West Sussex, England, RH6 0NP, United Kingdom',
  'Flat 2, 14 Queens Road, Haywards Heath, West Sussex, RH16 1EA, United Kingdom',
  'Brighton, Brighton and Hove, England, United Kingdom'
];

test('briefDisplay caps a geocoder string at five words', () => {
  for (const raw of NOMINATIM) {
    const out = addr.briefDisplay(raw);
    assert.ok(out, 'must still render something for: ' + raw);
    const words = out.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 5,
      '"' + out + '" is ' + words + ' words (max 5) — from: ' + raw);
    for (const junk of ['United Kingdom', 'England', 'Greater London']) {
      assert.ok(!out.includes(junk), '"' + out + '" still carries "' + junk + '"');
    }
  }
});

test('the owner\'s two reported strings shorten the way he asked', () => {
  assert.strictEqual(addr.briefDisplay('London Borough of Hillingdon, Greater London, England, United Kingdom'),
    'London Borough of Hillingdon');
  assert.strictEqual(addr.briefDisplay('Hillingdon, Greater London, England, TW6 2CX, United Kingdom'),
    'Hillingdon, TW6 2CX');
});

test('an empty or junk value never yields a broken label', () => {
  for (const v of ['', null, undefined, '   ', ',,,']) {
    assert.strictEqual(typeof addr.briefDisplay(v), 'string');
  }
});

test('the picker shows the short label but the BOOKING sends the full address', () => {
  const app = read('booking-app.js');
  // The suggestion row and the field both go through the brief form…
  // The row shows a SHORT label. It is normally briefAddr(display_name); where
  // two distinct places shorten to the same words (the airport and its railway
  // station) the row falls back to that place's own name so the two can be told
  // apart — still short, still never the raw administrative chain.
  assert.ok(/it\.textContent = [^;]*briefAddr\(o\.display_name\)/.test(app),
    'the autocomplete list must show the brief label, not the raw display_name');
  assert.ok(!/it\.textContent\s*=\s*o\.display_name\s*;/.test(app),
    'the autocomplete list is printing the raw display_name');
  assert.ok(/function setAddress\(input, full\)[\s\S]{0,200}input\.value = briefAddr\(full\)/.test(app),
    'choosing a suggestion must put the brief label in the field');
  assert.ok(/setAddress\(pickup, d\.display_name\)/.test(app),
    '"Use my current location" must fill the brief label too');
  // …while the full string is kept and is what actually gets booked.
  assert.ok(/input\.dataset\.fullAddress = full/.test(app),
    'the full address must be stashed on the input');
  assert.ok(/raw\.pickup = fullAddr\(pickup\)/.test(app) && /raw\.destination = fullAddr\(dest\)/.test(app),
    'the submitted booking must carry the FULL pickup and destination, not the label');
  // A hand-typed address must not inherit the previous pick's full value.
  assert.ok(/delete input\.dataset\.fullAddress/.test(app),
    'typing must clear the remembered full address, or the booking sends a stale one');
  // The fare path is unchanged: it still sees the full address.
  assert.ok(/var p = fullAddr\(pickup\), d = fullAddr\(dest\)/.test(app),
    'the fare estimator must keep using the full address so pricing is unaffected');
});

test('every page with the booking form loads the shared normalizer first', () => {
  for (const f of ['book.html', 'index.html']) {
    const src = read(f);
    // Compare the SCRIPT TAGS, not any mention of the filename: a comment in
    // the markup naming booking-app.js used to be matched here, and the test
    // failed on a page whose script order was perfectly correct.
    const norm = src.search(/<script[^>]+src="[^"]*address-normalize\.js"/);
    const app = src.search(/<script[^>]+src="[^"]*booking-app\.js"/);
    assert.ok(norm !== -1, f + ' must load /address-normalize.js for the short labels');
    assert.ok(app !== -1, f + ' no longer loads booking-app.js');
    assert.ok(norm < app,
      f + ' loads address-normalize.js AFTER booking-app.js — window.WMAddr would be ' +
      'undefined when the form wires up, and the picker would fall back to the long string');
  }
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
