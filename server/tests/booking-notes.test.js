/**
 * NOTES ON THE CARD, AND MEET & GREET IN THE EMAIL — run with:
 *   node server/tests/booking-notes.test.js   (also gated by `npm test`)
 *
 * TWO SMALL THINGS, ONE FILE, BECAUSE BOTH ARE "SHOW IT ONLY WHEN IT APPLIES".
 *
 * 1. THE OWNER'S NOTE ON THE BOOKING
 *    The job card had a Notes row all along — gated on `j.notes`. The mapper
 *    emits `note` (`note:b.notes||''`), so `j.notes` was undefined and the row
 *    NEVER rendered. Edit worked only because ebOpen reads `j.note||j.notes`,
 *    which is why the note looked like it was "edit-only" rather than missing.
 *
 *    Fixing that alone would have introduced a second bug: the rider app used to
 *    write "Vehicle: <name>" into notes, and server/email.js has always stripped
 *    that with cleanOwnerNote(). Showing notes without the same filter would
 *    have started printing "Vehicle: Executive" on the owner's cards.
 *
 * 2. MEET & GREET (and FLIGHT TRACKING), AIRPORT RUNS ONLY
 *    Two things an airport customer needs told once: the driver comes in to find
 *    them, and the airport's parking charge is not inside the quoted fare. On a
 *    town-to-town job both sentences are noise, so the block must not appear at
 *    all. "Airport" is isAirportRun() from address-normalize.js — the same
 *    detector that gates the flight-number field, so the form and the email
 *    agree.
 *
 * Runs the SHIPPED email template and the SHIPPED owner-app helper. Exit 1 on
 * failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

process.env.RESEND_API_KEY = 'test_fake';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OWNER = read('westmere-owner.html');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── Lift the SHIPPED helper out of the owner app and run it for real ─────
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'westmere-owner.html no longer defines ' + name + '()');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(extractFn(OWNER, 'ownerNoteOf'), ctx);
const ownerNoteOf = ctx.ownerNoteOf;

console.log('\nThe owner note on the booking card');

// ── 1. THE FIELD-NAME BUG ────────────────────────────────────────────────
test('the note is read from the field the mapper actually emits', () => {
  // This is the whole bug: the mapper writes `note`, the card asked for `notes`.
  assert.strictEqual(ownerNoteOf({ note: 'Round the back, call on arrival' }),
    'Round the back, call on arrival', 'a `note` must be found');
  assert.strictEqual(ownerNoteOf({ notes: 'Round the back' }), 'Round the back',
    'a `notes` must be found too, so a mapper change cannot break it again');
  // And the mapper really does emit `note` — if that ever changes, the helper
  // above still covers it, but the assertion records what is true today.
  assert.ok(/note:\s*b\.notes\s*\|\|\s*''/.test(OWNER),
    'the mapper is expected to emit `note` from b.notes');
});

test('a booking with no note renders nothing at all', () => {
  for (const j of [{}, { note: '' }, { note: '   ' }, { note: null }, { notes: null }, null]) {
    assert.strictEqual(ownerNoteOf(j), '',
      'empty note must produce nothing — no orphan "Notes:" label on the card');
  }
});

test('the rider app\'s "Vehicle:" dump is still excluded', () => {
  // server/email.js has always stripped this with cleanOwnerNote(). The owner
  // app had no equivalent, so showing notes without it would print the dump.
  for (const v of ['Vehicle: Executive', 'vehicle:Saloon', '  VEHICLE : Estate  ']) {
    assert.strictEqual(ownerNoteOf({ note: v }), '', JSON.stringify(v) + ' must be filtered out');
  }
  // But a real note that merely mentions a vehicle is NOT a dump.
  assert.strictEqual(ownerNoteOf({ note: 'Customer asked for a larger vehicle' }),
    'Customer asked for a larger vehicle', 'a genuine note must survive');
});

test('it matches the server-side filter it was mirrored from', () => {
  const emailSrc = read('server/email.js');
  assert.ok(/function cleanOwnerNote/.test(emailSrc), 'server/email.js still owns the original');
  assert.ok(/\^vehicle\\s\*:/i.test(emailSrc) || /\^vehicle/i.test(emailSrc),
    'the server filter still targets a leading "vehicle:"');
  assert.ok(/\/\^vehicle\\s\*:\/i/.test(OWNER),
    'the owner app must use the same leading-"vehicle:" rule');
});

test('the card and the trip page both gate on the filtered note', () => {
  // Two call sites had the same bug; both must go through the helper, or one of
  // them silently keeps showing nothing (or shows the dump).
  const uses = (OWNER.match(/ownerNoteOf\(j\)/g) || []).length;
  assert.ok(uses >= 3, 'expected the helper on both views, found ' + uses + ' uses');
  assert.ok(!/\bj\.notes\s*\?/.test(OWNER), 'no view may still gate on the raw j.notes');
  assert.ok(!/if\(j\.notes\)/.test(OWNER), 'nor test it directly');
});

// ── 2. MEET & GREET ──────────────────────────────────────────────────────
console.log('\nMeet & greet — airport runs only');

const email = require('../email');
let CAP = null;
global.fetch = async (u, o) => { CAP = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

const BASE = { ref: 'WPH-1', name: 'Mr Ben Chan', email: 'ben@example.com', date: '2026-09-01',
               time: '09:00', fare: 129, payment: 'cash', passengers: 2, bags: '2', pay_token: 'tok' };
async function confirmed(o) {
  CAP = null;
  await email.sendCustomerConfirmed(Object.assign({}, BASE, o));
  return CAP.html;
}
const hasMeetGreet = (h) =>
  /Meet &amp; greet included<\/strong> &mdash; your driver will meet you at arrivals and help with your luggage\./.test(h);
// The owner pulled the name board. Nothing in the airport block may offer one.
const noNameBoard = (h) => !/name board/i.test(h);
const hasParking = (h) => /Airport parking is included in your fare/.test(h);

test('an airport booking gets both sentences', async () => {
  const h = await confirmed({ pickup: '14 Greenhill Avenue, Caterham', destination: 'London Gatwick Airport' });
  assert.ok(hasMeetGreet(h), 'the meet & greet sentence must be there');
  assert.ok(noNameBoard(h), 'and it must NOT promise a name board');
  assert.ok(hasParking(h), 'and the parking sentence must be there');
  assert.ok(/nothing extra to pay/.test(h),
    'the parking line must say plainly that there is nothing more to pay');
  // The old wording was the opposite promise. If it ever comes back, the fare
  // stops matching what the customer was told.
  assert.ok(!/not included in your fare|added separately|charged by the airport/.test(h),
    'no leftover "parking costs extra" wording anywhere in the email');
});

test('it fires on the pickup, the drop-off, or a STOP in the middle', async () => {
  for (const o of [
    { pickup: 'London Gatwick Airport, South Terminal', destination: 'Caterham' },
    { pickup: 'Caterham', destination: 'London Gatwick Airport' },
    { pickup: 'Lewes', destination: 'Brighton', stop_address: 'Gatwick Airport' },
  ]) {
    assert.ok(hasMeetGreet(await confirmed(o)), 'missed: ' + JSON.stringify(o));
  }
});

test('an airport we do not price still counts', async () => {
  // isAirportRun is deliberately broader than the fare engine's six priced
  // airports — a Birmingham run is still met, and still has parking.
  assert.ok(hasMeetGreet(await confirmed({ pickup: 'Lewes', destination: 'Birmingham Airport' })));
  assert.ok(hasMeetGreet(await confirmed({ pickup: 'Uckfield TN22', destination: 'STN' })),
    'an airport CODE must count too');
});

test('a town-to-town booking shows NEITHER sentence', async () => {
  const h = await confirmed({ pickup: 'Lewes, BN7 2AN', destination: 'Brighton, BN1 1AA' });
  assert.ok(!hasMeetGreet(h), 'meet & greet must not appear on a town-to-town job');
  assert.ok(!hasParking(h), 'and neither must the parking line');
  assert.ok(!/Your airport transfer/.test(h), 'nor the block heading');
});

test('a city that shares an airport code is not an airport', async () => {
  // "Manchester" the city must not read as MAN, "Stanmore" must not read as STN.
  for (const o of [{ pickup: 'Manchester', destination: 'Leeds' },
                   { pickup: 'Stanmore', destination: 'Watford' }]) {
    assert.ok(!hasMeetGreet(await confirmed(o)), 'false positive on ' + JSON.stringify(o));
  }
});

test('it uses the SAME detector as the flight-number gate', () => {
  // If these two ever disagree, a booking gets a flight field and no meet-&-greet
  // line, or the reverse — and nobody would notice for months.
  const src = read('server/email.js');
  assert.ok(/isAirportRun/.test(src), 'email.js must import isAirportRun');
  assert.ok(/require\('\.\.\/address-normalize'\)/.test(src),
    'and it must come from the shared normalizer, not a local copy');
  assert.ok(/isAirportRun\(d\.pickup, d\.destination, d\.stop_address\)/.test(src),
    'all three legs must be checked');
  const norm = read('address-normalize.js');
  assert.ok(/isAirportRun:/.test(norm) || /isAirportRun,/.test(norm),
    'address-normalize.js must still export it');
});

test('the acknowledgement email does NOT carry it', async () => {
  // The ack goes out before a fare exists; promising what is included in a fare
  // nobody has quoted yet would be premature.
  CAP = null;
  await email.sendCustomerAcknowledgement(Object.assign({}, BASE, {
    pickup: 'Caterham', destination: 'London Gatwick Airport', fare: null }));
  assert.ok(!hasMeetGreet(CAP.html), 'the acknowledgement must not carry the block');
});

// ── 3. FLIGHT TRACKING ───────────────────────────────────────────────────
console.log('\nFlight tracking — airport runs WITH a flight number');

const hasFlightLine = (h) => /We track your flight, so delays are no problem/.test(h);
const trackHref = (h) => (h.match(/href="(https:\/\/www\.flightaware\.com\/live\/flight\/[^"]*)"/) || [])[1] || null;

test('an airport booking with a flight number gets the tracking line', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'London Gatwick Airport', flight: 'BA2751' });
  assert.ok(hasFlightLine(h), 'the reassurance sentence must be there');
  // Reassurance, not a priced commitment. The owner pulled this phrase.
  assert.ok(!/at no extra charge/.test(h), 'no "at no extra charge" promise');
  assert.ok(/Flight BA2751/.test(h), 'and the flight number itself');
  assert.strictEqual(trackHref(h), 'https://www.flightaware.com/live/flight/BA2751',
    'with a well-formed tracker link');
  assert.ok(/Track your flight/.test(h), 'labelled for a human');
  // It sits with the meet & greet, not instead of it.
  assert.ok(hasMeetGreet(h), 'the meet & greet block must still be there');
});

test('NO flight number means no flight line at all', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'London Gatwick Airport', flight: null });
  assert.ok(!hasFlightLine(h), 'no reassurance line without a flight');
  assert.ok(!/Flight\s+<\/strong>|>Flight <\/strong>/.test(h), 'and no empty "Flight" label');
  assert.strictEqual(trackHref(h), null, 'and no tracker link');
  assert.ok(hasMeetGreet(h), 'but meet & greet still applies to the airport run');
  for (const f of ['', '   ']) {
    assert.ok(!hasFlightLine(await confirmed({ pickup: 'Caterham', destination: 'Gatwick Airport', flight: f })),
      'a blank flight (' + JSON.stringify(f) + ') must not render the line');
  }
});

test('a town-to-town booking never shows it, even with a flight-like string', async () => {
  // flightFor() gates on the airport run, so "BA2751" on a Lewes → Brighton job
  // cannot reach the email.
  const h = await confirmed({ pickup: 'Lewes, BN7 2AN', destination: 'Brighton, BN1 1AA', flight: 'BA2751' });
  assert.ok(!hasFlightLine(h), 'no flight line on a town-to-town booking');
  assert.strictEqual(trackHref(h), null, 'and certainly no tracker link');
  assert.ok(!hasMeetGreet(h), 'nor meet & greet');
});

test('the tracker URL is built from a NORMALISED ident, and refuses junk', async () => {
  // Messy customer typing still produces one canonical link.
  for (const [typed, want] of [['ba 2751', 'BA2751'], ['BA-2751', 'BA2751'], ['  ezy8123 ', 'EZY8123']]) {
    const h = await confirmed({ pickup: 'Caterham', destination: 'Gatwick Airport', flight: typed });
    assert.strictEqual(trackHref(h), 'https://www.flightaware.com/live/flight/' + want,
      JSON.stringify(typed) + ' must normalise to ' + want);
  }
  // Real IATA designators are not always two letters — easyJet is U2 and flies
  // Gatwick constantly. A two-LETTER rule silently dropped their links.
  for (const ident of ['U21234', '4U7788', 'LS123A']) {
    const h = await confirmed({ pickup: 'Caterham', destination: 'Gatwick Airport', flight: ident });
    assert.strictEqual(trackHref(h), 'https://www.flightaware.com/live/flight/' + ident,
      ident + ' is a real flight number and must get a link');
  }
  // Anything that is not a plausible ident gets the flight number but NO link —
  // a dead "Track your flight" is worse than none.
  for (const junk of ['Terminal 5 arrivals', 'ask the driver', '12345', 'BA2751/../../evil']) {
    const h = await confirmed({ pickup: 'Caterham', destination: 'Gatwick Airport', flight: junk });
    assert.strictEqual(trackHref(h), null, JSON.stringify(junk) + ' must NOT produce a link');
  }
});

test('nothing user-typed reaches the URL unescaped', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'Gatwick Airport',
                              flight: '"><script>alert(1)</script>' });
  assert.strictEqual(trackHref(h), null, 'that is not a flight number, so no link');
  assert.ok(!/<script>alert/.test(h), 'and the raw string must never be emitted as markup');
});

test('the acknowledgement email carries no flight tracking either', async () => {
  CAP = null;
  await email.sendCustomerAcknowledgement(Object.assign({}, BASE, {
    pickup: 'Caterham', destination: 'London Gatwick Airport', flight: 'BA2751', fare: null }));
  assert.ok(!hasFlightLine(CAP.html), 'the ack goes out before any of this is settled');
});

/* ── 4. WHO IS TURNING UP, AND IN WHAT ──────────────────────────────────
   A customer standing on a kerb wants a name and a number plate, not a
   promise that a car exists. These assert the row is really rendered, that
   an ASSIGNED driver wins over the default, and that the acknowledgement and
   the estimate stay out of it — both go out before anyone has said yes. */
console.log('\nDriver, vehicle and registration');

test('a confirmation names the driver, the car and the plate', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'Lewes' });
  assert.ok(/Your driver and car/.test(h), 'the row must be labelled');
  assert.ok(/Nikodem/.test(h), 'the driver');
  assert.ok(/Tesla Model S/.test(h), 'the car');
  assert.ok(/ML68 YHC/.test(h), 'and the registration, spaced as it is on the plate');
});

test('it is on town-to-town too, not just airports', async () => {
  const town = await confirmed({ pickup: 'Lewes, BN7 2AN', destination: 'Brighton, BN1 1AA' });
  assert.ok(/ML68 YHC/.test(town), 'the car is the same car wherever it is going');
  assert.ok(!/Your airport transfer/.test(town), 'but the airport block is still absent');
});

test('an ASSIGNED driver overrides the default', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'Lewes',
    driver_name: 'Sam Whitfield', driver_vehicle: 'Mercedes E-Class', driver_reg: 'LT19 KPX' });
  assert.ok(/Sam Whitfield/.test(h) && /Mercedes E-Class/.test(h) && /LT19 KPX/.test(h),
    'the assigned driver and car must be used');
  // The default must not leak in alongside them, or the customer sees two cars.
  assert.ok(!/Nikodem/.test(h) && !/Tesla Model S/.test(h) && !/ML68 YHC/.test(h),
    'and the fallback must NOT appear as well');
});

test('a blank assigned value falls back rather than printing nothing', async () => {
  const h = await confirmed({ pickup: 'Caterham', destination: 'Lewes',
    driver_name: '   ', driver_vehicle: null, driver_reg: '' });
  assert.ok(/Nikodem/.test(h) && /Tesla Model S/.test(h) && /ML68 YHC/.test(h),
    'empty is "unset", not "print an empty row"');
});

test('the acknowledgement and the estimate name no driver', async () => {
  CAP = null;
  await email.sendCustomerAcknowledgement(Object.assign({}, BASE, {
    pickup: 'Caterham', destination: 'Lewes', fare: null }));
  assert.ok(!/Your driver and car/.test(CAP.html),
    'the ack goes out before the job is taken on');
  CAP = null;
  await email.sendCustomerEstimate(Object.assign({}, BASE, {
    pickup: 'Caterham', destination: 'Lewes' }));
  assert.ok(!/Your driver and car/.test(CAP.html),
    'and a quote is not yet a booking');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/booking-notes\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
