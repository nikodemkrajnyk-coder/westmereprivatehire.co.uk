/**
 * Luggage + flight-number display guardrail — run with:
 *   node server/tests/bags-flight.test.js   (also gated by `npm test`)
 *
 * TWO reported bugs, both caused by a stored value being printed raw:
 *
 * 1) LUGGAGE — some records rendered "0.0 bags" (rows migrated from the old
 *    INTEGER/REAL `bags` column), others rendered nothing, others the raw
 *    compound "2s+1l" or the legacy word "medium". `bags` is a TEXT column
 *    that five different writers have filled with five different shapes.
 *    THE RULE: a bag count is ALWAYS a whole number.
 *      • compact summary lines  → WMLifecycle.bagsText()  — '' when zero, so
 *        the bags are omitted from the line entirely
 *      • explicit "Luggage" fields → WMLifecycle.bagsLabel() — always shows an
 *        integer label, "0 bags"
 *    No decimal ever reaches a screen, an email, a calendar entry or a PDF.
 *
 * 2) FLIGHT NUMBER — shown on every booking, including town-to-town jobs where
 *    it is meaningless, AND printed in the admin jobs list as a bare line
 *    directly under the pickup address, where it read like another line of the
 *    address. THE RULE: a flight number appears only when the journey touches
 *    an airport (WMAddr.flightFor → '' otherwise) and always in its own
 *    LABELLED field, never concatenated into an address.
 *
 * Fails loudly (exit 1) if a surface stops delegating to the shared helpers or
 * starts printing the raw column value again. Pure Node, no framework.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
}

const LC = require('../../wm-lifecycle');
const ADDR = require('../../address-normalize');
const { regionFrom, routeBlock } = require('./_source');

const OWNER  = read('westmere-owner.html');
const ADMIN  = read('westmere-admin.html');
const RIDER  = read('westmere-rider.html');
const DRIVER = read('westmere-driver.html');

// ── 1. LUGGAGE: always an integer ────────────────────────────────────────
console.log('\nLuggage renders as a clean integer, everywhere');

test('bagsLabel is always an integer label — "0 bags" / "1 bag" / "3 bags"', () => {
  assert.strictEqual(LC.bagsLabel(0), '0 bags');
  assert.strictEqual(LC.bagsLabel('0'), '0 bags');
  assert.strictEqual(LC.bagsLabel(''), '0 bags');
  assert.strictEqual(LC.bagsLabel(null), '0 bags');
  assert.strictEqual(LC.bagsLabel('1'), '1 bag', 'one bag is singular');
  assert.strictEqual(LC.bagsLabel('3'), '3 bags');
});

test('THE REPORTED BUG: a decimal value never renders a decimal', () => {
  // Rows migrated from the old INTEGER/REAL bags column read back as "0.0".
  for (const raw of ['0.0', 0.0, '0.00', '2.0', 2.0, '3.0', '2.6']) {
    const label = LC.bagsLabel(raw);
    const text = LC.bagsText(raw);
    assert.ok(!/\./.test(label), 'bagsLabel(' + JSON.stringify(raw) + ') leaked a decimal: ' + label);
    assert.ok(!/\./.test(text), 'bagsText(' + JSON.stringify(raw) + ') leaked a decimal: ' + text);
  }
  assert.strictEqual(LC.bagsLabel('0.0'), '0 bags', 'the "0.0 bags" record must read "0 bags"');
  assert.strictEqual(LC.bagsLabel('2.0'), '2 bags');
  assert.strictEqual(LC.bagsText('0.0'), '', 'zero adds nothing to a compact summary line');
});

test('every stored shape collapses to a whole number', () => {
  assert.strictEqual(LC.bagsLabel('2s+1l'), '3 bags', 'the rider app small+large picker');
  assert.strictEqual(LC.bagsLabel('0s+0l'), '0 bags');
  assert.strictEqual(LC.bagsLabel('1s+0l'), '1 bag');
  assert.strictEqual(LC.bagsLabel('small'), '2 bags', 'the legacy admin form words');
  assert.strictEqual(LC.bagsLabel('medium'), '4 bags');
  assert.strictEqual(LC.bagsLabel('large'), '6 bags');
  assert.strictEqual(LC.bagsLabel('No luggage'), '0 bags');
  assert.strictEqual(LC.bagsLabel('4+'), '4+ bags', 'the "4 or more" option keeps its + (not a decimal)');
  assert.strictEqual(LC.bagsText('4+'), '4+ bags');
});

test('the zero rule is consistent: omitted in summaries, "0 bags" in a labelled field', () => {
  for (const zero of ['', '0', '0.0', 0, null, undefined, '0s+0l', 'none']) {
    assert.strictEqual(LC.bagsText(zero), '', 'compact summary must omit bags for ' + JSON.stringify(zero));
    assert.strictEqual(LC.bagsLabel(zero), '0 bags', 'a labelled field must read "0 bags" for ' + JSON.stringify(zero));
  }
});

test('every app renders luggage through the shared helper, never the raw value', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN],
                             ['westmere-rider.html', RIDER], ['westmere-driver.html', DRIVER]]) {
    assert.ok(/WMLifecycle\.bags(Text|Label|Count)\(/.test(src),
      name + ' must take its luggage label from the shared WMLifecycle helper');
    assert.ok(/<script src="\/wm-lifecycle\.js">/.test(src), name + ' must load /wm-lifecycle.js');
    // The raw column value must never be concatenated with the word "bag(s)".
    assert.ok(!/\.bags\s*\+\s*'\s*bags?/.test(src) && !/\.bags\s*\+\s*"\s*bags?/.test(src),
      name + ' still builds a luggage label out of the raw bags value');
  }
});

test('the server prints luggage through the shared helper too', () => {
  const emailSrc = read('server/email.js');
  assert.ok(/require\('\.\.\/wm-lifecycle'\)/.test(emailSrc), 'email.js must require ../wm-lifecycle');
  assert.ok(!/function bagsLabel\(/.test(emailSrc), 'email.js must not keep its own copy of the luggage label');
  // The raw value must not be printed in any email row.
  assert.ok(!/detailRow\('Luggage', escHtml\(bags\)\)/.test(emailSrc) &&
            !/detailRow\('Luggage', escHtml\(String\(bags\)\)\)/.test(emailSrc),
    'email.js still prints the raw bags value in a Luggage row');
  const gcal = read('server/google-calendar.js');
  assert.ok(/bagsText\(b\.bags\)/.test(gcal), 'the calendar description must use the shared luggage label');
  assert.ok(!/\$\{b\.bags\} bags/.test(gcal), 'the calendar description still prints the raw bags value');
  const wa = read('server/whatsapp.js');
  assert.ok(!/\$\{booking\.bags\}/.test(wa), 'the WhatsApp alert still prints the raw bags value');
});

// ── 2. FLIGHT NUMBER: airport runs only ──────────────────────────────────
console.log('\nFlight number appears only on airport runs, in its own field');

const TOWN_A = '12, High Street, Horsham, West Sussex, England, RH12 1AB, United Kingdom';
const TOWN_B = 'Brighton, Brighton and Hove, England, BN1 1HJ, United Kingdom';
const AIRPORT = 'Gatwick Airport, Station Approach Road, Crawley, West Sussex, England, RH6 0RD, United Kingdom';

test('isAirportRun recognises an airport at either end, and nothing else', () => {
  assert.strictEqual(ADDR.isAirportRun(TOWN_A, TOWN_B), false, 'town-to-town is not an airport run');
  assert.strictEqual(ADDR.isAirportRun(TOWN_A, AIRPORT), true, 'drop-off at an airport');
  assert.strictEqual(ADDR.isAirportRun(AIRPORT, TOWN_A), true, 'pickup at an airport');
  assert.strictEqual(ADDR.isAirportRun('Horsham', 'Heathrow Airport Terminal 5'), true);
  // An airport we have no canonical name for still counts.
  assert.strictEqual(ADDR.isAirportRun('Horsham', 'Shoreham Airport, BN43'), true);
  // …but a town that merely CONTAINS an airport code's letters does not.
  assert.strictEqual(ADDR.isAirportRun('Manchester Road, Horsham', 'Stanmore'), false);
});

test('flightFor returns the flight ONLY on an airport run', () => {
  assert.strictEqual(ADDR.flightFor({ flight: 'BA2678', pickup: TOWN_A, destination: TOWN_B }), '',
    'a town-to-town journey must show NO flight number at all');
  assert.strictEqual(ADDR.flightFor({ flight: 'BA2678', pickup: TOWN_A, destination: AIRPORT }), 'BA2678');
  assert.strictEqual(ADDR.flightFor({ flight: ' ba2678 ', pickup: AIRPORT, destination: TOWN_A }), 'BA2678',
    'the flight number is tidied, not reformatted away');
  assert.strictEqual(ADDR.flightFor({ flight: '', pickup: TOWN_A, destination: AIRPORT }), '');
  assert.strictEqual(ADDR.flightFor(null), '');
  // The owner app (pickup/dest) and rider app (from/dest) shapes both work.
  assert.strictEqual(ADDR.flightFor({ flight: 'U28492', pickup: TOWN_A, dest: AIRPORT }), 'U28492');
  assert.strictEqual(ADDR.flightFor({ flight: 'U28492', from: AIRPORT, dest: TOWN_A }), 'U28492');
});

test('THE REPORTED BUG: the admin list never prints the flight under the address', () => {
  const start = ADMIN.indexOf('var tbody=el(\'jobs-tbody\')');
  assert.ok(start !== -1, 'the admin All Journeys table renderer moved');
  const end = ADMIN.indexOf('jdetail-row', start);
  assert.ok(end !== -1, 'the All Journeys row template moved');
  const block = ADMIN.slice(start, end);
  // The pickup cell must not carry a bare flight sub-line (that is what read as
  // part of the address).
  assert.ok(!/b\.flight\?'<div class="sub-v">'\+escTo\(b\.flight\)/.test(block),
    'the flight number is being printed as a bare sub-line under the pickup address again');
  assert.ok(!/_admShortAddr\(b\.pickup\)[\s\S]{0,240}?_admFlight\(b\)[\s\S]{0,80}?<\/td>/.test(block),
    'the flight number must not sit inside the pickup cell at all');
  // It has its own labelled column instead.
  assert.ok(/<th>Flight<\/th>/.test(ADMIN), 'the jobs table must have its own Flight column header');
  assert.ok(/\+'<td>'\+\(_admFlight\(b\)\?/.test(block), 'the Flight column must render via _admFlight');
});

test('the admin Flight column count matches the table header and the detail colspan', () => {
  const header = ADMIN.match(/<thead><tr><th>Ref<\/th>[\s\S]*?<\/tr><\/thead>/);
  assert.ok(header, 'jobs table header not found');
  const cols = (header[0].match(/<th[ >]/g) || []).length;
  assert.strictEqual(cols, 11, 'the jobs table should have 11 columns (Flight added)');
  assert.ok(new RegExp('colspan="' + cols + '"').test(ADMIN),
    'the detail row colspan must match the ' + cols + '-column table');
});

test('every app gates its flight display on the shared airport rule', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN],
                             ['westmere-rider.html', RIDER], ['westmere-driver.html', DRIVER]]) {
    assert.ok(/WMAddr\.flightFor\(/.test(src), name + ' must gate its flight display on WMAddr.flightFor');
  }
  // …and no app renders a Flight field straight off the raw column.
  assert.ok(!/_jdField\('Flight',escTo\(b\.flight\)\)/.test(ADMIN), 'admin detail must gate its Flight field');
  assert.ok(!/if\(j\.flight\)\{/.test(OWNER), 'the owner app must not branch on the raw j.flight');
  assert.ok(!/if\(j\.flight\)\{/.test(DRIVER), 'the driver app must not branch on the raw j.flight');
});

test('the manual booking forms only OFFER a flight field on an airport run', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN]]) {
    assert.ok(/id="nb-flight-wrap"[^>]*display:none/.test(src),
      name + ': the flight field must start hidden and be revealed for airport runs');
    assert.ok(/function nbFlightField\(\)[\s\S]{0,400}WMAddr\.isAirportRun\(/.test(src),
      name + ': nbFlightField() must use the shared airport rule');
  }
});

test('the server gates the flight number on every non-app surface', () => {
  const emailSrc = read('server/email.js');
  assert.ok(/flightFor/.test(emailSrc), 'email.js must import the shared flight rule');
  assert.ok(!/if \(flight\) rows \+= detailRow\('Flight'/.test(emailSrc),
    'an email still prints the flight straight off the booking row');
  assert.ok(!/if \(d\.flight\) rows \+= confRow/.test(emailSrc),
    'the confirmation template still prints the flight straight off the booking row');
  const gcal = read('server/google-calendar.js');
  assert.ok(/flightFor\(b\)/.test(gcal) && !/b\.flight \? `Flight \$\{b\.flight\}`/.test(gcal),
    'the calendar description must gate the flight on an airport run');
  const ics = read('server/driver-cal-routes.js');
  assert.ok(/flightFor\(booking\)/.test(ics) && !/booking\.flight \? `Flight: \$\{booking\.flight\}`/.test(ics),
    "the driver's ICS feed must gate the flight on an airport run");
  const pdf = read('server/invoice-pdf.js');
  assert.ok(/flightFor\(b\)/.test(pdf) && !/if \(b\.flight\) \{/.test(pdf),
    'the invoice PDF must gate the flight on an airport run');
});

// ── 3. Rendered output: the real emails ──────────────────────────────────
console.log('\nRendered emails obey both rules');

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

const TOWN_BOOKING = {
  ref: 'WM-TOWN', name: 'Test Customer', email: 'cust@example.com', phone: '07000000000',
  pickup: TOWN_A, destination: TOWN_B, date: '2026-08-20', time: '10:00',
  fare: 55, passengers: 2, bags: '0.0', flight: 'BA2678',
  pay_token: 'deadbeefdeadbeefdeadbeefdeadbeef'
};
const AIRPORT_BOOKING = Object.assign({}, TOWN_BOOKING, {
  ref: 'WM-AIR', destination: AIRPORT, bags: '2s+1l'
});

for (const fnName of ['sendAdminAlert', 'sendCustomerConfirmed']) {
  test(fnName + ': town-to-town shows NO flight and NO decimal luggage', async () => {
    const { html } = await renderEmail(fnName, TOWN_BOOKING);
    assert.ok(html.length > 0, 'no html captured');
    assert.ok(!/BA2678/.test(html), fnName + ' printed a flight number on a town-to-town journey');
    assert.ok(!/>Flight</.test(html), fnName + ' rendered a Flight row on a town-to-town journey');
    assert.ok(!/0\.0 bags/.test(html), fnName + ' rendered "0.0 bags"');
    assert.ok(!/0 bags/.test(html), fnName + ' should omit the luggage row entirely when there are no bags');
  });
  test(fnName + ': an airport run shows the flight and an integer bag count', async () => {
    const { html } = await renderEmail(fnName, AIRPORT_BOOKING);
    assert.ok(/BA2678/.test(html), fnName + ' dropped the flight number on an airport run');
    assert.ok(/>Flight</.test(html), fnName + ' must give the flight its own labelled row');
    assert.ok(/3 bags/.test(html), fnName + ' must show the compound "2s+1l" as "3 bags"');
    assert.ok(!/2s\+1l/.test(html), fnName + ' leaked the raw bags value');
  });
}

test('the flight number is never concatenated into an address line', async () => {
  const { html, subject } = await renderEmail('sendAdminAlert', AIRPORT_BOOKING);
  // The Pickup/Drop-off values must contain the address and nothing else.
  const puIdx = html.indexOf('Gatwick Airport');
  assert.ok(puIdx !== -1, 'the short drop-off address is missing');
  // Bounded by the end of the table cell the address lives in.
  const around = regionFrom(html, puIdx, [/<\/td>/]);
  assert.ok(!/BA2678/.test(around), 'the flight number is rendered inside the address value');
  assert.ok(!/BA2678/.test(subject), 'the flight number must not be in the subject route');
});

// ── 4. The Google Calendar entry ─────────────────────────────────────────
console.log('\nCalendar entries obey both rules');

test('a calendar description shows integer bags and gates the flight', () => {
  const gcal = require('../google-calendar');
  const town = gcal.bookingToEvent({
    ref: 'WM-TOWN', date: '2026-08-20', time: '10:00', pickup: TOWN_A, destination: TOWN_B,
    customer_name: 'Test', passengers: 2, bags: '0.0', flight: 'BA2678', status: 'confirmed'
  });
  assert.ok(!/0\.0/.test(town.description), 'a calendar entry rendered "0.0 bags"');
  assert.ok(!/bags/.test(town.description), 'zero bags must be omitted from the calendar entry');
  assert.ok(!/BA2678/.test(town.description), 'a town-to-town calendar entry must carry no flight number');

  const air = gcal.bookingToEvent({
    ref: 'WM-AIR', date: '2026-08-20', time: '10:00', pickup: TOWN_A, destination: AIRPORT,
    customer_name: 'Test', passengers: 2, bags: '2s+1l', flight: 'ba2678', status: 'confirmed'
  });
  assert.ok(/3 bags/.test(air.description), 'the calendar entry must show an integer bag count');
  assert.ok(/Flight BA2678/.test(air.description), 'an airport calendar entry must carry the flight number');
});

// ── summary ──────────────────────────────────────────────────────────────
(async () => {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
