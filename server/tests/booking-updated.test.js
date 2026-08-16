/**
 * "YOUR BOOKING HAS BEEN UPDATED" guardrail — run with:
 *   node server/tests/booking-updated.test.js   (also gated by `npm test`)
 *
 * WHAT THE FEATURE IS
 *   When the owner or admin edits a trip and saves it, the customer is emailed
 *   automatically: what changed (old struck through → new), and the booking as
 *   it now stands. Both apps save through the SAME route — PATCH
 *   /api/bookings/:id — so the detection lives there, once, and neither app can
 *   drift away from it or forget to ask for the email.
 *
 * THE TWO WAYS THIS FEATURE CAN GO WRONG, AND WHAT IS PINNED
 *   (a) IT DOESN'T SEND when it should. A customer turns up at the old time
 *       because the owner moved the pickup and nobody told them. Pinned: a real
 *       edit to any of pickup / stop / drop-off / date / time / passengers /
 *       luggage / flight / fare sends the email, and the email actually
 *       CONTAINS the new value and the was → now pair.
 *   (b) IT SENDS WHEN IT SHOULDN'T — the worse failure, because it is an email
 *       to a real customer about nothing. Pinned: a no-op save is silent; an
 *       internal-only edit (the private note, the driver, the status, the
 *       payment method, the mileage) is silent; and a save that is already
 *       sending a confirmation or a cancellation does not also send this one,
 *       so one edit never produces two emails.
 *
 *   Plus the house style: the email is navy on white, its buttons are frames,
 *   and there is no gold, no green and no fill anywhere in it.
 *
 * These run the SHIPPED handler (lifted out of server/api.js) and the SHIPPED
 * email template against a throwaway database and a stubbed Resend, so nothing
 * here can pass on code we no longer ship.
 * Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

process.env.RESEND_API_KEY = 'test_fake';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const apiSrc = read('server/api.js');
const emailSrc = read('server/email.js');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const EMAIL = require('../email');

// ── Pull the real PATCH handler + its helpers out of server/api.js ───────
function braceBody(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces at ' + from);
}
function extractFn(name) {
  const start = apiSrc.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'server/api.js no longer defines ' + name + '()');
  const head = apiSrc.slice(apiSrc.indexOf('(', start) + 1, apiSrc.indexOf('{', start)).trim().replace(/\)$/, '');
  return 'function ' + name + '(' + head + ') {' + braceBody(apiSrc, start) + '}';
}
const PATCH_MARKER = "router.patch('/bookings/:id'";
const patchStart = apiSrc.indexOf(PATCH_MARKER);
assert.ok(patchStart !== -1, 'server/api.js no longer defines PATCH /bookings/:id');
const PATCH_BODY = braceBody(apiSrc, apiSrc.indexOf('=>', patchStart));

const fieldsDecl = apiSrc.match(/const CUSTOMER_FIELDS = \[[\s\S]{0,300}?\];/);
assert.ok(fieldsDecl, 'server/api.js no longer declares CUSTOMER_FIELDS');
const CUSTOMER_FIELDS = new Function(fieldsDecl[0] + '; return CUSTOMER_FIELDS;')();

// Re-host the shipped handler with its collaborators injected, so it runs
// exactly as it ships against a throwaway DB.
const runPatch = new Function(
  'req', 'res', 'getDb', 'events', 'require', 'console', 'autoFile', 'gcal',
  'sendCustomerCancellation', 'CUSTOMER_FIELDS',
  extractFn('sameCustomerValue') + '\nreturn (async () => {' + PATCH_BODY + '})();'
);

// ── Throwaway database with the shipped shape ────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE, full_name TEXT, phone TEXT
    );
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      customer_id INTEGER, driver_id INTEGER,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, stop_address TEXT,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT 'ASAP',
      passengers INTEGER NOT NULL DEFAULT 1, bags TEXT NOT NULL DEFAULT '0',
      trip_type TEXT, flight TEXT, fare REAL, payment TEXT DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
      passenger_name TEXT, passenger_phone TEXT, passenger_email TEXT,
      trip_miles REAL, paid_at TEXT, paid_amount REAL, pay_token TEXT, calendar_event_id TEXT,
      review_request_sent_at TEXT, payment_intent_id TEXT,
      -- Set when the price moves on a trip already paid for. Mirrors server/db.js;
      -- the money behaviour itself is guarded by server/tests/fare-adjust.test.js.
      fare_adjust_kind TEXT, fare_adjust_amount REAL, fare_adjust_paid REAL,
      fare_adjust_at TEXT, fare_adjust_method TEXT, fare_adjust_settled_at TEXT,
      fare_adjust_ref TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE review_emails_sent (email TEXT PRIMARY KEY);
  `);
  return db;
}

function seed(db, over) {
  over = over || {};
  db.prepare(`INSERT INTO bookings
      (id,ref,pickup,destination,stop_address,date,time,passengers,bags,flight,fare,payment,status,
       passenger_name,passenger_email,passenger_phone,notes,pay_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(10, 'WPH-UPD1',
      '14 Queens Road, Haywards Heath, RH16 1EA', 'Gatwick Airport, South Terminal', null,
      '2026-09-24', '05:30', 2, '2s+1l', 'BA2431', 42, 'pending',
      over.status || 'confirmed',
      'Mr J Whitfield',
      over.passenger_email === undefined ? 'whitfield@example.com' : over.passenger_email,
      '07700900123', 'Gate code 4821 — do not tell the customer', 'tok-live-1');
  if (over.paid_at) db.prepare('UPDATE bookings SET paid_at = ?, payment = ? WHERE id = 10').run(over.paid_at, 'card');
  return db.prepare('SELECT * FROM bookings WHERE id = 10').get();
}

// Stubbed Resend — captures the payload the shipped email code would send.
let sent = [];
global.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ id: 'test-id' }) };
};

// The handler's require() paths are relative to server/api.js — resolve them
// from there, or the route quietly loses the REAL email template.
const AS_API = { './email': '../email', './intake': '../intake', './pay-lock': '../pay-lock',
                 './payment-methods': '../payment-methods', './stripe': '../stripe' };
const INTAKE_STUB = { ensurePayToken: () => 'tok-live-1', notifyCustomerConfirmed: async () => true };
const inject = (m) => {
  if (m === './intake') return INTAKE_STUB;
  return require(Object.prototype.hasOwnProperty.call(AS_API, m) ? AS_API[m] : m);
};
const noopAutoFile = { fileBooking() {}, updateEarnings() {} };
const noopGcal = {
  createEvent: () => Promise.resolve(null), updateEvent: () => Promise.resolve(true),
  deleteEvent: () => Promise.resolve(true)
};

function callPatch(db, body, auth) {
  sent = [];
  const out = { code: 200, payload: null };
  const res = {
    status(c) { out.code = c; return this; },
    json(p) { out.payload = p; return this; }
  };
  const req = {
    auth: auth || { role: 'owner', type: 'user', id: 7 },
    params: { id: '10' }, body: body, ip: '127.0.0.1'
  };
  return runPatch(req, res, () => db, { broadcast() {} }, inject, console,
    noopAutoFile, noopGcal, () => Promise.resolve(true), CUSTOMER_FIELDS)
    .then(() => out);
}

// The one email this feature sends, out of everything the save may have fired.
function updateEmail() {
  return sent.find(m => /booking has been updated/i.test(m.subject || ''));
}

/* ═══════════════════════════════════════════════════════════════════════
   1. A CUSTOMER-RELEVANT EDIT SENDS THE EMAIL
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nAn edit the customer travels on emails them');

test('moving the pickup time sends the update email', async () => {
  const db = makeDb(); seed(db);
  const out = await callPatch(db, { time: '04:15' });
  assert.strictEqual(out.code, 200, 'the save itself must succeed');
  assert.strictEqual(out.payload.customerNotified, true, 'the customer was not emailed');
  assert.strictEqual(out.payload.notifyReason, 'sent');
  assert.deepStrictEqual(out.payload.customerChanged, ['time']);
  const m = updateEmail();
  assert.ok(m, 'no "your booking has been updated" email was sent');
  assert.strictEqual(m.to, 'whitfield@example.com', 'it went to the wrong address');
});

test('the email carries the NEW value and the old → new pair', async () => {
  const db = makeDb(); seed(db);
  await callPatch(db, { time: '04:15' });
  const html = updateEmail().html;
  assert.ok(html.includes('04:15'), 'the new time is not in the email');
  assert.ok(html.includes('05:30'), 'the old time is not in the email');
  // The old value struck through, the arrow, then the new one in bold — in
  // that order, inside one row.
  const row = /text-decoration:line-through[^]{0,80}05:30[^]{0,200}&rarr;[^]{0,200}04:15/.test(html);
  assert.ok(row, 'the diff is not rendered as struck-through old → new');
});

test('every customer-relevant field triggers it, and carries its new value', async () => {
  const cases = [
    ['pickup',       'Flat 2, 8 Perrymount Road, Haywards Heath', 'Perrymount'],
    ['stop_address', 'Redhill Station, Surrey',                   'Redhill'],
    ['destination',  'Heathrow Airport, Terminal 5',              'Heathrow'],
    ['date',         '2026-09-25',                                'Friday'],
    ['time',         '06:45',                                     '06:45'],
    ['passengers',   4,                                           '4 passenger'],
    ['bags',         '3s+2l',                                     '3'],
    ['flight',       'EZY8021',                                   'EZY8021'],
    ['fare',         57.5,                                        '57.50']
  ];
  for (const [key, value, expect] of cases) {
    const db = makeDb(); seed(db);
    const out = await callPatch(db, { [key]: value });
    assert.strictEqual(out.payload.notifyReason, 'sent', key + ' did not send the email');
    assert.deepStrictEqual(out.payload.customerChanged, [key], key + ' was not reported as changed');
    const m = updateEmail();
    assert.ok(m, key + ' sent no email');
    assert.ok(m.html.includes(expect),
      key + ': the email does not show the new value (looked for "' + expect + '")');
  }
});

test('the list of watched fields is exactly the journey the customer travels on', () => {
  assert.deepStrictEqual(CUSTOMER_FIELDS.slice().sort(),
    ['bags', 'date', 'destination', 'fare', 'flight', 'passengers', 'pickup', 'stop_address', 'time'].sort(),
    'CUSTOMER_FIELDS has drifted — adding a column here puts it in a customer inbox');
  for (const internal of ['notes', 'driver_id', 'status', 'payment', 'paid_at', 'trip_miles', 'customer_id']) {
    assert.ok(!CUSTOMER_FIELDS.includes(internal),
      internal + ' is an internal field and must never email the customer');
  }
});

test('two changes at once are both in one email, not two emails', async () => {
  const db = makeDb(); seed(db);
  const out = await callPatch(db, { date: '2026-09-26', time: '07:00' });
  assert.deepStrictEqual(out.payload.customerChanged, ['date', 'time']);
  assert.strictEqual(sent.filter(m => /updated/i.test(m.subject)).length, 1, 'more than one email went out');
  const html = updateEmail().html;
  assert.ok(html.includes('07:00') && html.includes('05:30'), 'the time diff is missing');
  assert.ok(/September/.test(html), 'the date diff is missing');
});

test('the email also shows the booking as it NOW stands, not only the diff', async () => {
  const db = makeDb(); seed(db);
  await callPatch(db, { time: '04:15' });
  const html = updateEmail().html;
  assert.ok(html.includes('WPH-UPD1'), 'the reference is missing');
  assert.ok(/Gatwick/.test(html), 'the drop-off is missing from the current details');
  assert.ok(/Haywards Heath|Queens Road/.test(html), 'the pickup is missing from the current details');
  assert.ok(/What changed/i.test(html), 'the "what changed" heading is missing');
  assert.ok(/as it now stands/i.test(html), 'the current-details heading is missing');
});

test('the private note never reaches the customer', async () => {
  const db = makeDb(); seed(db);
  await callPatch(db, { time: '04:15' });
  assert.ok(!/Gate code 4821/.test(updateEmail().html),
    'the owner\'s private note was printed in a customer email');
});

/* ═══════════════════════════════════════════════════════════════════════
   2. IT STAYS QUIET WHEN IT SHOULD
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nA save that changes nothing the customer sees is silent');

test('a no-op save (same values retyped) sends nothing', async () => {
  const db = makeDb(); const b = seed(db);
  const out = await callPatch(db, {
    pickup: b.pickup, destination: b.destination, date: b.date, time: b.time,
    passengers: b.passengers, fare: b.fare
  });
  assert.strictEqual(out.payload.customerNotified, false);
  assert.strictEqual(out.payload.notifyReason, 'no-change');
  assert.deepStrictEqual(out.payload.customerChanged, []);
  assert.strictEqual(sent.length, 0, 'a no-op save emailed the customer');
});

test('the same fare in a different shape is not a change', async () => {
  for (const same of ['42', 42.0, '42.00']) {
    const db = makeDb(); seed(db);
    const out = await callPatch(db, { fare: same });
    assert.strictEqual(out.payload.notifyReason, 'no-change',
      'fare ' + JSON.stringify(same) + ' was treated as a change');
  }
  // …and a real change still is one.
  const db = makeDb(); seed(db);
  assert.strictEqual((await callPatch(db, { fare: '42.50' })).payload.notifyReason, 'sent');
});

test('whitespace and flight-number case are not changes', async () => {
  const db = makeDb(); seed(db);
  let out = await callPatch(db, { pickup: '  14 Queens Road, Haywards Heath, RH16 1EA  ' });
  assert.strictEqual(out.payload.notifyReason, 'no-change', 'a retyped address with spaces emailed the customer');
  out = await callPatch(db, { flight: 'ba2431' });
  assert.strictEqual(out.payload.notifyReason, 'no-change', 'a case-only flight edit emailed the customer');
});

test('an internal-only edit sends nothing', async () => {
  for (const body of [
    { notes: 'Customer is a nervous flyer — leave 20 minutes early' },
    { driver_id: 3 },
    { payment: 'account' },
    { trip_miles: 31.4 },
    { passenger_phone: '07700900999' },
    { passenger_name: 'Mr John Whitfield' }
  ]) {
    const db = makeDb(); seed(db);
    const out = await callPatch(db, body);
    assert.strictEqual(out.payload.notifyReason, 'no-change',
      JSON.stringify(body) + ' emailed the customer');
    assert.strictEqual(sent.length, 0, JSON.stringify(body) + ' sent an email');
  }
});

test('a booking with no email address reports it rather than pretending', async () => {
  const db = makeDb(); seed(db, { passenger_email: null });
  const out = await callPatch(db, { time: '04:15' });
  assert.strictEqual(out.payload.customerNotified, false);
  assert.strictEqual(out.payload.notifyReason, 'no-email');
  assert.deepStrictEqual(out.payload.customerChanged, ['time'], 'the change itself must still be reported');
});

/* ═══════════════════════════════════════════════════════════════════════
   3. ONE EDIT NEVER PRODUCES TWO CUSTOMER EMAILS
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nOne save, at most one customer email');

test('a save that CONFIRMS the booking does not also send the update email', async () => {
  const db = makeDb(); seed(db, { status: 'pending' });
  const out = await callPatch(db, { status: 'confirmed', fare: 58 });
  assert.strictEqual(out.payload.customerNotified, false);
  assert.strictEqual(out.payload.notifyReason, 'suppressed',
    'the confirmation email already carries the new details — this would be the second');
  assert.strictEqual(updateEmail(), undefined, 'an update email went out alongside the confirmation');
});

test('a save that CANCELS the booking does not also send the update email', async () => {
  const db = makeDb(); seed(db);
  const out = await callPatch(db, { status: 'cancelled', fare: 0.5 });
  assert.strictEqual(out.payload.notifyReason, 'suppressed');
  assert.strictEqual(updateEmail(), undefined, 'a cancelled booking emailed an update');
});

test('editing an already-cancelled or completed trip emails nobody', async () => {
  for (const status of ['cancelled', 'completed']) {
    const db = makeDb(); seed(db, { status });
    const out = await callPatch(db, { time: '04:15' });
    assert.strictEqual(out.payload.notifyReason, 'suppressed', status + ' emailed an update');
    assert.strictEqual(updateEmail(), undefined, status + ' sent an update email');
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   4. THE EMAIL LOOKS LIKE THE REST OF THEM
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nThe email is navy on white, framed, with no fills');

// Render once, directly through the shipped template, for the style checks.
let RENDERED = '';
test('the template renders through the shipped sender', async () => {
  sent = [];
  const ok = await EMAIL.sendCustomerBookingUpdated({
    ref: 'WPH-UPD1', name: 'Mr J Whitfield', email: 'whitfield@example.com',
    pickup: '14 Queens Road, Haywards Heath, RH16 1EA',
    destination: 'Gatwick Airport, South Terminal',
    date: '2026-09-24', time: '04:15', passengers: 2, bags: '2s+1l',
    flight: 'BA2431', fare: 57.5, payment: 'pending', pay_token: 'tok-live-1'
  }, [{ key: 'time', from: '05:30', to: '04:15' }, { key: 'fare', from: 42, to: 57.5 }]);
  assert.ok(ok, 'the sender returned falsy');
  RENDERED = (sent[0] || {}).html || '';
  assert.ok(RENDERED.length > 2000, 'the email rendered empty');
});

test('no gold and no green anywhere in it', () => {
  const BANNED = /#b78635|#c9a227|#d4af37|#25D366|#2D6E47|goldenrod/i;
  assert.ok(!BANNED.test(RENDERED), 'a gold or green value is in the booking-updated email');
});

test('every button is a frame — a white cell with a navy border, never a fill', () => {
  // The CTAs are <td>s carrying the border (Outlook drops <a> box properties).
  // Only cells that actually hold a link — the monogram badge in the header is
  // a bordered cell too, and it is not a button.
  const cells = [...RENDERED.matchAll(/<td[^>]*style="([^"]*border:\d+px solid[^"]*)"[^>]*>\s*<a\b/g)].map(m => m[1]);
  assert.ok(cells.length >= 1, 'the email has no framed button cells');
  for (const s of cells) {
    assert.ok(/background-color:#ffffff/i.test(s), 'a button cell is not white: ' + s.slice(0, 90));
    assert.ok(/border:\d+px solid #102a43|border:\d+px solid #c8d1d9/i.test(s),
      'a button cell is not framed in the navy/hairline: ' + s.slice(0, 90));
  }
});

test('no anchor in it paints itself a background', () => {
  for (const m of RENDERED.matchAll(/<a\b[^>]*style="([^"]*)"/g)) {
    const bg = /background(?:-color)?:\s*([^;"]+)/i.exec(m[1]);
    if (!bg) continue;
    assert.ok(/^(transparent|none|#fff|#ffffff|white)$/i.test(bg[1].trim()),
      'a link in the email is filled: ' + bg[1]);
  }
});

test('it uses the shared emailBtn helper rather than styling its own CTA', () => {
  // The VML frame is only ever emitted by emailBtn().
  assert.ok(/v:roundrect/.test(RENDERED), 'the CTA did not come through emailBtn (no VML frame for Outlook)');
  assert.ok(/fillcolor="#ffffff"/.test(RENDERED), 'the Outlook frame is filled rather than outlined');
});

test('it is Cormorant on white, like every other customer email', () => {
  assert.ok(/font-family:Cormorant/.test(RENDERED), 'the email is not set in Cormorant');
  assert.ok(/bgcolor="#FFFFFF"/i.test(RENDERED), 'the letter card is not white');
});

test('it goes out from the same address, with the same reply-to, as the others', () => {
  const m = sent[0];
  assert.strictEqual(m.from, 'Westmere Private Hire <bookings@westmereprivatehire.co.uk>');
  assert.strictEqual(m.reply_to, 'bookings@westmereprivatehire.co.uk');
  assert.ok(/booking has been updated/i.test(m.subject), 'the subject does not say what happened: ' + m.subject);
  assert.ok(m.text && m.text.length > 100, 'no plain-text alternative part');
});

test('the payment links are the tokenised ones, never a bare ref', () => {
  const links = [...RENDERED.matchAll(/href="(https:\/\/westmereprivatehire\.co\.uk\/[^"]+)"/g)].map(m => m[1]);
  const acts = links.filter(u => /\/(pay|cancel)\/|westmere-pay\.html/.test(u));
  assert.ok(acts.length >= 1, 'the email has no payment actions on an unpaid booking');
  for (const u of acts) assert.ok(/[?&]t=tok-live-1/.test(u), 'an action link is missing its pay_token: ' + u);
});

test('a settled booking is not asked to pay again', async () => {
  sent = [];
  await EMAIL.sendCustomerBookingUpdated({
    ref: 'WPH-UPD2', name: 'Mrs E Voss', email: 'voss@example.com',
    pickup: 'Cuckfield, RH17 5JX', destination: 'Brighton, BN1 1AA',
    date: '2026-09-24', time: '19:00', passengers: 3, fare: 55,
    payment: 'card', paid_at: '2026-08-14T09:00:00Z', pay_token: 'tok-live-2'
  }, [{ key: 'time', from: '18:00', to: '19:00' }]);
  const html = (sent[0] || {}).html || '';
  assert.ok(html.length > 2000, 'the paid variant rendered empty');
  assert.ok(!/Pay Now/i.test(html), 'a paid booking was shown a Pay Now button');
});

test('a change list with nothing recognisable sends nothing at all', async () => {
  sent = [];
  const ok = await EMAIL.sendCustomerBookingUpdated(
    { ref: 'WPH-UPD3', email: 'x@example.com', pickup: 'A', destination: 'B', date: '2026-09-24', time: '09:00' },
    [{ key: 'notes', from: 'a', to: 'b' }]);
  assert.strictEqual(ok, false, 'an internal-only change list still sent an email');
  assert.strictEqual(sent.length, 0);
});

/* ═══════════════════════════════════════════════════════════════════════
   4b. THE EDIT FORM CAN ACTUALLY REACH THESE FIELDS
   ═══════════════════════════════════════════════════════════════════════
   Detection on the server is worthless if the form has no input for the
   field. Passengers was missing entirely: an owner taking "can we make it
   three of us?" over the phone had nowhere to put it, so the job reached the
   driver still saying two and the customer was never told. */
console.log('\nThe owner edit form exposes the fields the customer travels on');

const EB = (() => {
  const i = OWNER.indexOf("el.id='edit-booking-overlay'");
  assert.ok(i !== -1, 'the owner app no longer builds an edit modal');
  return OWNER.slice(i, OWNER.indexOf('document.body.appendChild(el)', i));
})();

test('the edit form has a passengers field, capped at 4 like the booking form', () => {
  assert.ok(/id="eb-pax"/.test(EB), 'the edit form still has no passengers field');
  const tag = EB.match(/<input id="eb-pax"[^>]*>/);
  assert.ok(tag, 'the passengers field is not an input');
  assert.ok(/max="4"/.test(tag[0]), 'passengers is not capped at 4 — the vehicle is the limit');
  assert.ok(/min="1"/.test(tag[0]), 'passengers can be set below 1');
  assert.ok(/>Passengers</.test(EB), 'the passengers field has no label');
});

test('luggage and flight are editable too', () => {
  assert.ok(/id="eb-bags"/.test(EB), 'the edit form has no luggage field');
  assert.ok(/id="eb-flight"/.test(EB), 'the edit form has no flight-number field');
  assert.ok(/>Luggage</.test(EB) && /Flight number/.test(EB), 'the new fields are unlabelled');
});

test('the new fields match the form around them, not a style of their own', () => {
  for (const id of ['eb-pax', 'eb-bags', 'eb-flight']) {
    const tag = EB.match(new RegExp('<(?:input|select) id="' + id + '"[^>]*>'));
    assert.ok(tag, id + ' is missing');
    const style = (tag[0].match(/style="([^"]*)"/) || [])[1] || '';
    assert.ok(/border:1px solid rgba\(27,27,26,\.15\)/.test(style), id + ' does not use the form frame');
    assert.ok(/font-family:inherit/.test(style), id + ' does not inherit Cormorant');
    assert.ok(/color:var\(--navy\)/.test(style), id + ' is not navy ink');
  }
});

test('the save actually submits them', () => {
  const fn = OWNER.slice(OWNER.indexOf('function ebCollectBody'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/body\.passengers\s*=/.test(body), 'passengers is collected but never sent');
  assert.ok(/body\.bags\s*=/.test(body), 'luggage is never sent');
  assert.ok(/body\.flight\s*=/.test(body), 'the flight number is never sent');
  // A number, not a string: the server compares passengers numerically, and
  // '3' vs 3 would report a change on every save.
  assert.ok(/parseInt\(g\('eb-pax'\), *10\)/.test(body), 'passengers is sent as a string');
  assert.ok(/Math\.min\(4, *Math\.max\(1, *pax\)\)/.test(body), 'a typed 40 would reach the server');
});

test('opening the form never destroys a luggage value the dropdown cannot show', () => {
  const fn = OWNER.slice(OWNER.indexOf("document.getElementById('eb-id').value=bookingId"));
  const body = fn.slice(0, fn.indexOf("el.style.display='flex'"));
  assert.ok(/dataset\.custom/.test(body),
    "an unrecognised bags value ('2s+1l') would snap to No luggage and be deleted on save");
  assert.ok(/eb-pax'\)\.value=/.test(body), 'the passengers field is never populated');
  assert.ok(/eb-flight'\)\.value=/.test(body), 'the flight field is never populated');
});

test('a passengers change flows through PATCH into the update email', async () => {
  const db = makeDb(); seed(db);
  const out = await callPatch(db, { passengers: 4 });
  assert.strictEqual(out.payload.customerNotified, true, 'a passenger change did not email the customer');
  assert.deepStrictEqual(out.payload.customerChanged, ['passengers']);
  assert.strictEqual(db.prepare('SELECT passengers FROM bookings WHERE id = 10').get().passengers, 4,
    'the new passenger count was not saved');
  const m = updateEmail();
  assert.ok(/4 passengers/.test(m.html), 'the email does not show the new count');
  assert.ok(/2 passengers/.test(m.html), 'the email does not show what it was');
});

test('re-saving the same passenger count is silent', async () => {
  const db = makeDb(); const b = seed(db);
  // The form sends a NUMBER; the row holds a number. Sending the string '2'
  // must not read as a change either.
  for (const same of [2, '2']) {
    const db2 = makeDb(); seed(db2);
    const out = await callPatch(db2, { passengers: same });
    assert.strictEqual(out.payload.notifyReason, 'no-change',
      'passengers ' + JSON.stringify(same) + ' emailed the customer for no reason');
  }
  assert.strictEqual(b.passengers, 2);
});

test('the modal markup is not corrupted — no leaked style string', () => {
  // A regex sweep once duplicated a <button> tag here and left a raw CSS
  // string in front of it, which rendered as visible garbage above Save.
  // Four of these were live in production, across BOTH staff apps, from a
  // regex sweep that rewrote button tags. Check every page, not just this
  // modal: a leaked declaration renders as visible garbage next to a control.
  for (const [name, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(!/#102a43\)<button/.test(src),
      'a style string has leaked in front of a button tag in the ' + name + ' app — it prints as text on screen');
    assert.ok(!/[;)]"?\s*<button\b[^>]*class="wm-primary"[^>]*>[^<]*<\/button>'?\s*\+?\s*'[a-z-]+:/.test(src),
      'the ' + name + ' app has a stray style fragment beside a button');
  }
  const buttons = (EB.match(/<button /g) || []).length;
  assert.strictEqual(buttons, 3, 'the edit modal should have exactly close + Cancel + Save, found ' + buttons);
});

/* ═══════════════════════════════════════════════════════════════════════
   5. THE OPERATOR IS TOLD WHAT HAPPENED
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\nBoth apps tell the operator whether the customer was emailed');

test('the owner app reads the answer and puts it into words', () => {
  const fn = OWNER.slice(OWNER.indexOf('function wmSavedMessage'));
  assert.ok(fn.indexOf('function wmSavedMessage') === 0, 'the owner app no longer has wmSavedMessage()');
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const reason of ['sent', 'failed', 'no-email', 'suppressed']) {
    assert.ok(body.includes("'" + reason + "'"), 'the owner app does not handle notifyReason ' + reason);
  }
  assert.ok(/customer emailed/i.test(body), 'the owner is never told the customer WAS emailed');
  assert.ok(/no email was sent|nothing sent/i.test(body), 'the owner is never told when nothing was sent');
});

test('the owner Save actually uses it — not a hardcoded "Booking updated"', () => {
  const save = OWNER.slice(OWNER.indexOf('async function upcomingSave'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(/showToast\(wmSavedMessage\(d\)\)/.test(body),
    'upcomingSave() still shows a fixed message instead of the real outcome');
  assert.ok(!/showToast\('Booking updated'\)/.test(body), 'the old fixed toast is still there');
});

test('the admin app reports the same outcome from the same route', () => {
  assert.ok(/function admSaved\(/.test(ADMIN), 'the admin app has no admSaved()');
  const fn = ADMIN.slice(ADMIN.indexOf('function admSaved('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes("'sent'") && body.includes("'failed'"),
    'the admin app does not handle the sent/failed outcomes');
  assert.ok(/admSaved\(d,'Journey completed'\)/.test(ADMIN), 'admin markJobDone does not report the outcome');
  assert.ok(/admSaved\(d,'Booking cancelled'\)/.test(ADMIN), 'admin cancelJob does not report the outcome');
});

test('both apps save through the SAME route, so neither can drift', () => {
  assert.ok(/fetch\('\/api\/bookings\/'\+id,\{method:'PATCH'/.test(OWNER.replace(/\s/g, '')) ||
            /\/api\/bookings\/'\+id,\{method:'PATCH'/.test(OWNER),
    'the owner app no longer saves through PATCH /api/bookings/:id');
  assert.ok(/\/api\/bookings\/'\+id,\{method:'PATCH'/.test(ADMIN),
    'the admin app no longer saves through PATCH /api/bookings/:id');
});

test('the route reports the outcome to whoever saved', () => {
  const patch = apiSrc.slice(patchStart, apiSrc.indexOf("// NOTE: the old POST /bookings/:id/send-estimate", patchStart));
  assert.ok(/customerNotified/.test(patch), 'PATCH no longer reports customerNotified');
  assert.ok(/notifyReason/.test(patch), 'PATCH no longer reports notifyReason');
  assert.ok(/await require\('\.\/email'\)\.sendCustomerBookingUpdated/.test(patch),
    'the update email is not awaited — the operator would be told "sent" before it was');
});

test('the send is guarded, so a mail failure can never lose the save', async () => {
  const db = makeDb(); seed(db);
  const boom = global.fetch;
  global.fetch = async () => { throw new Error('resend is down'); };
  try {
    const out = await callPatch(db, { time: '04:15' });
    assert.strictEqual(out.code, 200, 'a mail failure rolled back the save');
    assert.strictEqual(out.payload.ok, true);
    assert.strictEqual(out.payload.customerNotified, false);
    assert.strictEqual(out.payload.notifyReason, 'failed', 'the operator was not told the email failed');
    assert.strictEqual(db.prepare('SELECT time FROM bookings WHERE id = 10').get().time, '04:15',
      'the edit itself was lost');
  } finally { global.fetch = boom; }
});

test('a sent email is written to the audit log', async () => {
  const db = makeDb(); seed(db);
  await callPatch(db, { time: '04:15' });
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'booking_update_emailed'").get();
  assert.ok(row, 'no audit entry for the customer email');
  assert.ok(/WPH-UPD1/.test(row.detail) && /time/.test(row.detail), 'the audit entry does not say what changed');
});

// ── Run ──────────────────────────────────────────────────────────────────
(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
