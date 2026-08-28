/**
 * SENDING A JOB TO SOMEBODY WHO IS NOT ON THE SYSTEM —
 *   node server/tests/adhoc-offer.test.js   (also gated by `npm test`)
 *
 * The owner passes work to drivers he does not employ: another operator, a
 * friend with a car, somebody covering a Sunday. They have no account, so the
 * offer is a NAME and an EMAIL typed in on the spot.
 *
 * The thing that makes this delicate is that an ad-hoc offer has no driver id,
 * and the existing accept/decline guard on `b.offered_to_driver_id !== driverId`
 * would pass by ACCIDENT when both sides are null — assigning the job to
 * driver_id NULL, which reads everywhere as unassigned. That is why there are
 * two pairs of functions and why the public route branches explicitly.
 *
 * ALSO PINNED: what leaves the building. This email carries the passenger's
 * name and phone number to an address the owner typed from memory. That is the
 * owner's stated intent — a driver who cannot ring the passenger cannot run the
 * job — but it means a blank or malformed address must be refused before the
 * send, not after.
 *
 * THE FARE, NOT THE SPLIT — THE OWNER'S DECISION, MADE EXPLICITLY.
 * A registered driver is shown his pay after the 10%, because he has agreed to
 * that arrangement. Somebody outside the system has agreed to nothing, so a net
 * figure would state a term he never accepted and he would have no way to tell
 * it was not the whole fare. The owner was asked and chose: the ad-hoc email
 * shows the FULL FARE, and he adjusts the fare himself when he wants to.
 *
 * BOTH HALVES ARE PINNED HERE, deliberately. The obvious future tidy-up is to
 * notice two similar emails and merge them — which would silently move one set
 * of drivers onto the other's terms. So this file asserts that the ad-hoc email
 * shows the fare and never mentions commission, AND that the registered one
 * still shows pay-after-commission. Changing either is then a decision somebody
 * has to take on purpose.
 *
 * The confirm page each lands on repeats the SAME number as its email — a job
 * that says £75 in the email and £67.50 on the page is an argument.
 *
 * Runs the REAL shipped handlers against throwaway databases, with the mailer
 * intercepted. Nothing is sent. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OFFER = read('server/offer-routes.js');
const PUBLIC = read('server/public-api.js');
const OWNER = read('westmere-owner.html');
const DB = read('server/db.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const Database = require('better-sqlite3');
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, customer_id INTEGER, driver_id INTEGER,
      pickup TEXT, destination TEXT, stop_address TEXT, date TEXT, time TEXT,
      passengers INTEGER, bags TEXT, trip_type TEXT, flight TEXT, fare REAL, payment TEXT,
      status TEXT, notes TEXT, customer_note TEXT, passenger_name TEXT, passenger_phone TEXT,
      needs_reassignment INTEGER DEFAULT 0, intake_reason TEXT,
      offered_to_driver_id INTEGER, offered_to_name TEXT, offered_to_email TEXT,
      offered_to_reg TEXT, offered_to_car TEXT,
      assigned_to_name TEXT, assigned_to_email TEXT, assigned_to_reg TEXT, assigned_to_car TEXT,
      offered_at TEXT, decided_at TEXT, done_at TEXT,
      cancelled_at TEXT, cancellation_reason TEXT, driver_pay REAL, admin_fee REAL,
      offer_token TEXT, updated_at TEXT
    );
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, phone TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT,
      role TEXT, active INTEGER DEFAULT 1, is_default_driver INTEGER DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_id INTEGER,
      action TEXT, detail TEXT, ip TEXT);
  `);
  db.prepare("INSERT INTO customers (id,email,full_name,phone) VALUES (1,'go@example.com','Gavin O''Shea','07700 900456')").run();
  db.prepare("INSERT INTO users (id,full_name,email,role,active) VALUES (7,'Dave Driver','dave@example.com','driver',1)").run();
  // The OWNER, flagged as the default driver — every confirmed booking is
  // allocated to him as it comes in, which is the state the button has to work in.
  db.prepare("INSERT INTO users (id,full_name,email,role,active,is_default_driver) VALUES (2,'Nikodem','nikodem@example.com','owner',1,1)").run();
  db.prepare(`INSERT INTO bookings
    (id,ref,customer_id,pickup,destination,stop_address,date,time,passengers,bags,flight,fare,status,notes)
    VALUES (1,'WPH-7001',1,'The Grand Hotel, Brighton','London Gatwick Airport, South Terminal',
            'Lewes Station','2026-09-14','05:30',3,'2 large','BA2751',75,'confirmed','Front door pickup')`).run();
  /* Seeded CONFIRMED, because that is the only state a job can be offered from
     — the owner's rule, enforced by the route. The tests that check a refusal
     set the status they are testing. */
  return db;
}

/* The shipped modules, loaded against a throwaway database and a stubbed
   mailer. Requiring offer-routes for real would pull in the live db module, so
   getDb is redirected — the ROUTE code itself is untouched. */
function load(db) {
  const sent = [];
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && /server\/(offer-routes|public-api)\.js$/.test(parent.filename || '')) {
      if (request === './db') return { getDb: () => db };
      if (request === './email') return new Proxy({}, {
        get: (t, k) => (typeof k === 'string' && /^send/.test(k))
          ? (payload) => { sent.push({ fn: k, payload }); return Promise.resolve(true); }
          : t[k]
      });
      if (request === './intake') return { notifyCustomerConfirmed: () => Promise.resolve(true), ensurePayToken: () => 'tok' };
      if (request === './events') return { broadcast: () => {} };
    }
    return origLoad.apply(this, arguments);
  };
  for (const m of ['../offer-routes', '../public-api']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
  let offers;
  try { offers = require('../offer-routes'); }
  finally { Module._load = origLoad; }
  return { offers, sent };
}

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
/** Drive the shipped POST /bookings/:id/offer handler. */
function offer(offers, body, id) {
  const layer = offers.stack.find(l => l.route && l.route.path === '/bookings/:id/offer');
  assert.ok(layer, 'the offer route is gone');
  const handlers = layer.route.stack.map(s => s.handle);
  const req = { params: { id: String(id || 1) }, body, auth: { role: 'owner', id: 1, type: 'user' }, ip: '::1' };
  const r = res();
  let i = 0;
  const next = () => { if (i < handlers.length) handlers[i++](req, r, next); };
  next();
  return r;
}

console.log('\nA job is only offered once it is confirmed');

/* THE OWNER'S RULE. Offering a pending quote sends a driver out on a trip that
   may never happen — and on the ad-hoc path it hands somebody outside the
   business a customer's name and phone number for a booking that was never
   made. Both halves are pinned: the button is not drawn, AND the route refuses.
   A hidden button is a courtesy; the route is the rule. */
for (const status of ['pending', 'awaiting_payment', 'offered', 'estimate']) {
  test('refused: offering a ' + status + ' booking', () => {
    const db = makeDb();
    db.prepare('UPDATE bookings SET status = ? WHERE id = 1').run(status);
    const { offers, sent } = load(db);
    for (const body of [{ driver_id: 7 }, { name: 'Sam Cole', email: 'sam@example.com' }]) {
      const r = offer(offers, body);
      assert.strictEqual(r.statusCode, 409,
        JSON.stringify(body) + ' on a ' + status + ' booking should be 409, got ' + r.statusCode);
      assert.ok(/only be offered once it is confirmed/.test(r.body.error),
        'and say why: ' + r.body.error);
    }
    assert.strictEqual(sent.length, 0, 'nothing may be emailed');
    assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id=1').get().status, status,
      'and the booking must not move');
  });
}

for (const status of ['confirmed', 'active']) {
  test('allowed: offering a ' + status + ' booking', () => {
    const db = makeDb();
    db.prepare('UPDATE bookings SET status = ? WHERE id = 1').run(status);
    const { offers, sent } = load(db);
    const r = offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(sent.length, 1, 'and the email goes');
  });
}

test('completed and cancelled are still refused, as before', () => {
  for (const status of ['completed', 'cancelled']) {
    const db = makeDb();
    db.prepare('UPDATE bookings SET status = ? WHERE id = 1').run(status);
    const { offers } = load(db);
    const r = offer(offers, { driver_id: 7 });
    assert.strictEqual(r.statusCode, 409, status + ' must stay refused');
    assert.ok(/already /.test(r.body.error), 'with the original wording: ' + r.body.error);
  }
});

test('the button is drawn only on a confirmed job', () => {
  const fn = /function jobCardHtml\(j\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'jobCardHtml is missing');
  assert.ok(/var dispCanOffer=\(j\.apiStatus==='confirmed'\|\|j\.apiStatus==='active'\)&&!dispHeldByOther;/.test(fn[0]),
    'the card must decide whether offering is allowed');
  assert.ok(/\}else if\(dispCanOffer\)\{/.test(fn[0]),
    'and the Offer button must be behind it');
  /* It used to also require an EMPTY driver_id. Every confirmed booking is
     allocated to the default driver on the way in, so that hid the button on
     almost every job the owner had — see the default-driver block below. */
  // Reclaim must NOT be gated — an offer already made has to stay retractable.
  const reclaim = fn[0].slice(fn[0].indexOf("if(j.apiStatus==='offered'){"), fn[0].indexOf('}else if'));
  assert.ok(/dispReclaim/.test(reclaim) && !/dispCanOffer/.test(reclaim),
    'Reclaim must stay available whatever the status');
});

console.log('\nA name and an email are required');

for (const [label, body, expect] of [
  ['no name',            { email: 'x@y.co' },                  /name is required/i],
  ['blank name',         { name: '   ', email: 'x@y.co' },     /name is required/i],
  ['no email',           { name: 'Sam Cole' },                 /email address is required/i],
  ['malformed email',    { name: 'Sam Cole', email: 'sam@' },  /does not look right/i],
  ['email with a space', { name: 'Sam Cole', email: 'a b@c.co' }, /does not look right/i],
  ['nothing at all',     {},                                    /required/i]
]) {
  test('refused: ' + label, () => {
    const db = makeDb();
    const { offers, sent } = load(db);
    const r = offer(offers, body);
    assert.strictEqual(r.statusCode, 400, label + ' should be a 400, got ' + r.statusCode);
    assert.ok(expect.test(r.body.error), 'message was: ' + r.body.error);
    assert.strictEqual(sent.length, 0, 'nothing may be emailed');
    assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id=1').get().status, 'confirmed',
      'and the booking must not move');
  });
}

console.log('\nWhat the ad-hoc driver is sent');

test('the email carries the trip, the passenger and the fare', () => {
  const db = makeDb();
  const { offers, sent } = load(db);
  const r = offer(offers, { name: 'Sam Cole', email: 'Sam@Example.COM',
    reg: 'LT21 XYZ', car: 'Skoda Superb, dark grey' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(sent.length, 1, 'exactly one email');
  assert.strictEqual(sent[0].fn, 'sendAdhocJobOffer', 'the ad-hoc sender, not the driver one');
  const p = sent[0].payload;
  assert.strictEqual(p.driver_email, 'sam@example.com', 'address lower-cased and used as typed');
  assert.strictEqual(p.driver_name, 'Sam Cole');
  // trip
  assert.strictEqual(p.pickup, 'The Grand Hotel, Brighton');
  assert.strictEqual(p.destination, 'London Gatwick Airport, South Terminal');
  assert.strictEqual(p.stop_address, 'Lewes Station');
  assert.strictEqual(p.date, '2026-09-14');
  assert.strictEqual(p.time, '05:30');
  assert.strictEqual(p.passengers, 3);
  assert.strictEqual(p.flight, 'BA2751');
  // client
  assert.strictEqual(p.customer_name, "Gavin O'Shea", 'the passenger must be named');
  assert.strictEqual(p.customer_phone, '07700 900456', 'and reachable');
  // money
  assert.strictEqual(p.fare, 75, 'the FARE goes to an outside driver');
  assert.ok(p.offer_token && p.offer_token.length > 20, 'and a token to decide with');
  // the car, read back to them so a typo in the plate is caught by the one
  // person who knows it
  assert.strictEqual(p.driver_reg, 'LT21 XYZ');
  assert.strictEqual(p.driver_car, 'Skoda Superb, dark grey');
});

test('the rendered email SHOWS the fare, the passenger and both buttons', async () => {
  /* The payload is not the email. This renders the real template. */
  const email = require('../email');
  const captured = [];
  const Module = require('module');
  const p = path.join(ROOT, 'server', 'email.js');
  const src = fs.readFileSync(p, 'utf8').replace('async function sendEmail(',
    'async function sendEmail(a,b,c,d,e,f){global.__A.push({to:a,subject:b,html:c});return 1;}\nasync function __r(');
  global.__A = captured;
  const m = new Module(p, null); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  await m.exports.sendAdhocJobOffer({
    driver_name: 'Sam Cole', driver_email: 'sam@example.com', ref: 'WPH-7001',
    pickup: 'The Grand Hotel, Brighton', destination: 'London Gatwick Airport',
    stop_address: 'Lewes Station', date: '2026-09-14', time: '05:30',
    fare: 75, driver_pay: 67.5, admin_fee: 7.5, passengers: 3, bags: '2 large', flight: 'BA2751',
    customer_name: "Gavin O'Shea", customer_phone: '07700 900456', offer_token: 'T'.repeat(32)
  });
  assert.strictEqual(captured.length, 1);
  const h = captured[0].html;
  assert.ok(/Monday, 14 September 2026/.test(h), 'a human date, not an ISO string: ' + (/\d{4}-\d{2}-\d{2}/.test(h.replace(/<[^>]+>/g,' ')) ? 'ISO leaked' : ''));
  assert.ok(!/\b2026-09-14\b/.test(h.replace(/<[^>]+>/g, ' ')), 'no raw ISO date may reach the reader');
  assert.ok(/Gavin O&#39;Shea|Gavin O'Shea/.test(h), 'the passenger must be named');
  assert.ok(/07700 900456/.test(h), 'and their number given');
  assert.ok(/£75\.00|&pound;75\.00/.test(h), 'the fare must be shown');
  assert.ok(/The fare for this job/.test(h), 'and labelled as the fare');
  /* The money, not the wording. "to you" as a bare substring also matches
     "into your diary" in the add-to-calendar line, which quotes nothing. */
  const money = (h.match(/£\s?[\d.]+|&pound;\s?[\d.]+/g) || []);
  assert.deepStrictEqual([...new Set(money)], ['£75.00'],
    'the ONLY figure on an ad-hoc email is the full fare — found: ' + money.join(', '));
  assert.ok(!/\bto you\b/.test(h.replace(/into your/g, '')),
    'nothing may read as a net-of-commission promise');
  assert.ok(!/commission/i.test(h),
    'an outside driver never agreed a commission — it must not be mentioned');
  assert.ok(/\/offer\/WPH-7001\/accept\?t=/.test(h) && /\/offer\/WPH-7001\/decline\?t=/.test(h),
    'both tokenised actions must be there');
  assert.ok(/Gatwick/.test(h) && /Lewes Station/.test(h) && /BA2751/.test(h), 'the trip in full');
});

test('the REGISTERED email still shows pay AFTER commission', async () => {
  /* The other half of the owner's decision. If these two ever collapse into one
     template, an outside driver starts being quoted a net figure he never
     agreed to — or a registered driver starts being quoted the gross. */
  const Module = require('module');
  const p = path.join(ROOT, 'server', 'email.js');
  const src = fs.readFileSync(p, 'utf8').replace('async function sendEmail(',
    'async function sendEmail(a,b,c,d,e,f){global.__B.push({subject:b,html:c});return 1;}\nasync function __r(');
  global.__B = [];
  const m = new Module(p, null); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  await m.exports.sendDriverJobOffer({
    driver_name: 'Dave Driver', driver_email: 'dave@example.com', ref: 'WPH-7001',
    pickup: 'Brighton', destination: 'Gatwick Airport', date: '2026-09-14', time: '05:30',
    fare: 75, driver_pay: 67.5, admin_fee: 7.5, passengers: 3, offer_token: 'T'.repeat(32)
  });
  const h = global.__B[0].html;
  assert.ok(/£67\.50|&pound;67\.50/.test(h), 'the registered driver is shown his pay, not the fare');
  assert.ok(/to you/.test(h), 'and told it is his');
  assert.ok(/commission/i.test(h), 'and told the commission has come off');
  assert.ok(!/Your passenger/.test(h),
    "and does NOT get the passenger's number in the email — he has the driver app for that");
});

test('the two emails are separate functions, and stay separate', () => {
  const src = read('server/email.js');
  assert.ok(/async function sendAdhocJobOffer\(d\)/.test(src), 'the ad-hoc sender must exist');
  assert.ok(/async function sendDriverJobOffer\(d\)/.test(src), 'and the registered one');
  const adhoc = src.slice(src.indexOf('async function sendAdhocJobOffer'), src.indexOf('async function sendDriverJobOffer'));
  assert.ok(/const amount = \(d\.fare/.test(adhoc),
    'the ad-hoc email must read d.fare — the owner chose the full fare');
  assert.ok(!/driver_pay/.test(adhoc.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and must not compute or show a net figure anywhere');
});

console.log('\nAccepting and declining');

test('accept assigns the job to the NAME, with no driver account', () => {
  const db = makeDb();
  const { offers } = load(db);
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
  const out = offers.acceptAdhocOffer(db, 1);
  assert.ok(out.ok, JSON.stringify(out));
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.status, 'confirmed');
  assert.strictEqual(b.assigned_to_name, 'Sam Cole', 'the person who took it is named on the job');
  assert.strictEqual(b.driver_id, null, 'and no account is invented for them');
  assert.strictEqual(b.offer_token, null, 'the link stops working once used');
  assert.strictEqual(b.offered_to_email, null);
});

test('decline puts it back and flags it for reassignment', () => {
  const db = makeDb();
  const { offers } = load(db);
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
  const out = offers.declineAdhocOffer(db, 1, 'busy');
  assert.ok(out.ok);
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.status, 'pending', 'a declined job goes back to the owner as pending');
  assert.strictEqual(b.needs_reassignment, 1, 'the owner must see it needs somebody else');
  assert.strictEqual(b.offer_token, null);
  assert.strictEqual(b.driver_pay, null, 'and no stale split left behind');
});

test('the REGISTERED accept path cannot swallow an ad-hoc offer', () => {
  /* The trap this whole design exists to avoid: both sides null, `!==` false,
     guard passes, job assigned to driver_id NULL = unassigned. */
  const db = makeDb();
  const { offers } = load(db);
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
  const out = offers.acceptOffer(db, 1, null);
  assert.strictEqual(out.ok, false, 'acceptOffer must refuse an offer that has no driver id');
  assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id=1').get().status, 'offered',
    'and must leave the booking alone');
});

test('the ad-hoc accept cannot swallow a REGISTERED offer either', () => {
  const db = makeDb();
  const { offers } = load(db);
  offer(offers, { driver_id: 7 });
  const out = offers.acceptAdhocOffer(db, 1);
  assert.strictEqual(out.ok, false, 'it must refuse an offer that HAS a driver id');
});

test('the public confirm page picks the right pair', () => {
  const r = PUBLIC.slice(PUBLIC.indexOf("router.post('/offer/:ref/:action'"));
  assert.ok(/const adhoc = !b\.offered_to_driver_id && !!b\.offered_to_email;/.test(r.slice(0, 2000)),
    'it must decide which kind of offer this is');
  assert.ok(/acceptAdhocOffer\(getDb\(\), b\.id\)/.test(r.slice(0, 2000)) &&
            /declineAdhocOffer\(getDb\(\), b\.id/.test(r.slice(0, 2000)), 'and call the matching pair');
});

test('the GET confirm page mutates nothing, and quotes the same number', () => {
  const g = PUBLIC.slice(PUBLIC.indexOf("router.get('/offer/:ref/:action'"),
                         PUBLIC.indexOf("router.post('/offer/:ref/:action'"));
  assert.ok(!/UPDATE bookings/.test(g) && !/acceptOffer|declineOffer|acceptAdhoc|declineAdhoc/.test(g),
    'a link prefetch by a mail client must not decide a job');
  assert.ok(/<form method="POST">/.test(g), 'deciding is a POST');
  assert.ok(/adhoc\s*\?\s*\(\(b\.fare/.test(g) || /const amount = adhoc/.test(g),
    'an outside driver quoted the fare must not be shown a net figure on the confirm page');
});

console.log('\nThe registered path still works');

test('offering to a registered driver is unchanged', () => {
  const db = makeDb();
  const { offers, sent } = load(db);
  const r = offer(offers, { driver_id: 7 });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(sent[0].fn, 'sendDriverJobOffer', 'the registered sender');
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.offered_to_driver_id, 7);
  assert.strictEqual(b.offered_to_email, null, 'and no ad-hoc fields set');
  assert.strictEqual(b.driver_pay, 67.5, 'the 10% split still computed');
  assert.strictEqual(b.admin_fee, 7.5);
  const out = offers.acceptOffer(db, 1, 7);
  assert.ok(out.ok && db.prepare('SELECT driver_id FROM bookings WHERE id=1').get().driver_id === 7);
});

test('an unknown driver_id is still a 404', () => {
  const db = makeDb();
  const { offers } = load(db);
  assert.strictEqual(offer(db && offers, { driver_id: 999 }).statusCode, 404);
});

console.log('\nThe owner app, and the record');

test('the owner can choose "someone else" and is asked for both', () => {
  assert.ok(/Someone else — enter their name and email/.test(OWNER), 'the option must be offered');
  const fn = /async function dispOfferAdhoc\(id\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'dispOfferAdhoc is missing');
  assert.ok(/prompt\('Their name\?'\)/.test(fn[0]) && /prompt\('Their email address/.test(fn[0]),
    'both are asked for');
  assert.ok(/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/.test(fn[0]),
    'the address is checked before the send, not only on the server');
  assert.ok(/confirm\(/.test(fn[0]) && /passenger/i.test(fn[0]),
    'the confirmation must say the passenger details are going out — that is the point to catch it');
  assert.ok(/body:JSON\.stringify\(\{name:name,email:email,reg:reg,car:car\}\)/.test(fn[0]),
    'and it posts all four');
});

test('the form asks for the CAR as well — the customer has to find it', () => {
  /* Comments stripped first. A guard that greps the source will otherwise read
     the paragraph explaining why the owner's Tesla must not be pre-filled and
     conclude that it is. */
  const fn = /async function dispOfferAdhoc\(id\)\{[\s\S]*?\n\}/.exec(OWNER)[0]
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/prompt\('Their registration number/.test(fn), 'the registration is asked for');
  assert.ok(/prompt\('Their car/.test(fn), 'and the make and model');

  /* The registration is checked here because it is read out to a passenger
     standing on a pavement. The car is NOT defaulted: a guessed make printed to
     a customer is worse than a gap, so blank is allowed and only blank. */
  const regBlock = fn.slice(fn.indexOf("prompt('Their registration"));
  assert.ok(/\^\[A-Z0-9\]\[A-Z0-9 -\]\{3,11\}\$/.test(regBlock),
    'the registration is validated in the form, not only on the server');
  assert.ok(/A registration is needed/.test(regBlock), 'and it cannot be skipped');

  const carBlock = fn.slice(fn.indexOf("prompt('Their car"));
  assert.ok(!/A car is needed|alert\('That does not look like a car/.test(carBlock),
    'the car must NOT be forced — blank is a legitimate answer');
  assert.ok(!/Tesla|Model S|ML68/.test(fn),
    'and nothing may be pre-filled with the owner\u2019s own car');

  assert.ok(/If they accept, the customer is told to look for this car/.test(fn),
    'the confirm dialog says where these details end up');
});

test('the offer stores the car, and the accept moves it onto the job', () => {
  const db = makeDb();
  const { offers } = load(db);
  const r = offer(offers, { name: 'Sam Cole', email: 'sam@example.com',
    reg: 'lt21 xyz', car: 'Skoda Superb, dark grey' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));

  const offered = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(offered.offered_to_reg, 'LT21 XYZ',
    'a registration is upper-cased on the way in — the owner types it as it comes');
  assert.strictEqual(offered.offered_to_car, 'Skoda Superb, dark grey');
  assert.strictEqual(offered.assigned_to_reg, null,
    'but nothing is ASSIGNED until they accept — an offer is not an answer');

  const out = offers.acceptAdhocOffer(db, 1);
  assert.ok(out.ok, JSON.stringify(out));
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.assigned_to_name, 'Sam Cole');
  assert.strictEqual(b.assigned_to_email, 'sam@example.com',
    'and the ADDRESS, or their own reminder has nowhere to go — offered_to_email is cleared below');
  assert.strictEqual(b.assigned_to_reg, 'LT21 XYZ', 'the car moves across with the person');
  assert.strictEqual(b.assigned_to_car, 'Skoda Superb, dark grey');
  assert.strictEqual(b.offered_to_reg, null, 'and the offer is spent');
  assert.strictEqual(b.offered_to_car, null);

  /* The point of all of it: the customer's reminder reads the booking row and
     names the right car. Rendered, not inferred from the source. */
  const email = require('../email.js');
  const rows = [];
  email.__setTransport && email.__setTransport(null);
  assert.ok(/LT21 XYZ/.test(email.driverBlockHtml(b)) &&
            /Skoda Superb, dark grey/.test(email.driverBlockHtml(b)) &&
            /Sam Cole/.test(email.driverBlockHtml(b)),
    'the customer block names the ad-hoc driver and their car');
  assert.ok(!/Tesla|ML68 YHC|Nikodem/.test(email.driverBlockHtml(b)),
    'and no trace of the owner\u2019s own car is left in it');
  void rows;
});

test('a declined offer takes the car back with it', () => {
  const db = makeDb();
  const { offers } = load(db);
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
  offers.declineAdhocOffer(db, 1, 'busy');
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.offered_to_reg, null, 'a refused car is not left on the job');
  assert.strictEqual(b.offered_to_car, null);
  assert.strictEqual(b.assigned_to_reg, null, 'and was never assigned');
});

test('a job cannot go out without a registration', () => {
  const db = makeDb();
  const { offers, sent } = load(db);
  for (const body of [
    { name: 'Sam Cole', email: 'sam@example.com', car: 'Skoda Superb' },
    { name: 'Sam Cole', email: 'sam@example.com', reg: '   ', car: 'Skoda Superb' },
    { name: 'Sam Cole', email: 'sam@example.com', reg: 'X' }
  ]) {
    const r = offer(offers, body);
    assert.strictEqual(r.statusCode, 400, JSON.stringify(body) + ' → ' + r.statusCode);
  }
  assert.strictEqual(sent.length, 0, 'and no job email goes out on a bad one');
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.offered_to_name, null, 'nor is a half-offer written');
});

console.log('\nA job on the DEFAULT driver can still be passed on');

/* THE OWNER'S PROBLEM. Every confirmed booking is allocated to him the moment
   it arrives (server/public-api.js — auto-allocate to the default driver), so
   driver_id is set on essentially all of them. The offer button used to require
   an EMPTY driver_id, which meant it was hidden on almost every job he had, and
   the route below had never been asked the question at all.

   The default allocation means "I will do this one myself". Offering it is him
   saying he cannot. A job a REAL driver has taken is a different thing. */
test('a confirmed job sitting on the DEFAULT driver can be offered', () => {
  for (const body of [{ driver_id: 7 },
                      { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda' }]) {
    const db = makeDb();
    db.prepare('UPDATE bookings SET driver_id = 2 WHERE id = 1').run();   // the owner
    const { offers, sent } = load(db);
    const r = offer(offers, body);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(body) + ' → ' + JSON.stringify(r.body));
    assert.strictEqual(sent.length, 1, 'and the job email goes');
    assert.strictEqual(db.prepare('SELECT status FROM bookings WHERE id=1').get().status, 'offered');
  }
});

test('a job a REAL driver already has is refused, by NAME', () => {
  const db = makeDb();
  db.prepare('UPDATE bookings SET driver_id = 7 WHERE id = 1').run();
  const { offers, sent } = load(db);
  const r = offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda' });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/already with Dave Driver/.test(r.body.error),
    'and says who has it, so the owner knows who to ring: ' + r.body.error);
  assert.ok(/Reclaim it first/.test(r.body.error), 'and what to do about it');
  assert.strictEqual(sent.length, 0, 'nothing is emailed over the top of a driver who has the job');
});

test('an AD-HOC driver holding it blocks a second offer too', () => {
  const db = makeDb();
  db.prepare("UPDATE bookings SET assigned_to_name = 'Sam Cole' WHERE id = 1").run();
  const { offers } = load(db);
  const r = offer(offers, { driver_id: 7 });
  assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
  assert.ok(/already with Sam Cole/.test(r.body.error),
    'they have no users row to join to, so the name on the booking is the check: ' + r.body.error);
});

test('the confirmed-only rule is untouched by any of this', () => {
  const db = makeDb();
  db.prepare("UPDATE bookings SET status = 'pending', driver_id = 2 WHERE id = 1").run();
  const { offers } = load(db);
  const r = offer(offers, { driver_id: 7 });
  assert.strictEqual(r.statusCode, 409);
  assert.ok(/only be offered once it is confirmed/.test(r.body.error),
    'a pending job on the default driver is still a pending job: ' + r.body.error);
});

test('accepting takes the job OFF the default driver', () => {
  /* The one that would have gone wrong quietly. driverDetails resolves the
     REGISTERED branch first, so a booking left with driver_id = the owner would
     tell the customer to look for his Tesla while somebody else drove. */
  const db = makeDb();
  db.prepare('UPDATE bookings SET driver_id = 2 WHERE id = 1').run();
  const { offers } = load(db);
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com', reg: 'LT21 XYZ', car: 'Skoda Superb' });
  assert.ok(offers.acceptAdhocOffer(db, 1).ok);
  const b = db.prepare('SELECT * FROM bookings WHERE id=1').get();
  assert.strictEqual(b.driver_id, null, 'the default allocation is gone');
  assert.strictEqual(b.assigned_to_name, 'Sam Cole');

  const email = require('../email.js');
  const who = email.driverDetails(Object.assign({}, b, { driver_name: null }));
  assert.strictEqual(who.source, 'adhoc', 'and the reminders resolve to the new driver');
  assert.strictEqual(who.name, 'Sam Cole');
  assert.ok(!/Nikodem|Tesla|ML68/.test(email.driverBlockHtml(b)),
    'with no trace of the owner left in the block the customer reads');
});

test('a REGISTERED accept overrides the default too', () => {
  const db = makeDb();
  db.prepare('UPDATE bookings SET driver_id = 2 WHERE id = 1').run();
  const { offers } = load(db);
  offer(offers, { driver_id: 7 });
  assert.ok(offers.acceptOffer(db, 1, 7).ok);
  assert.strictEqual(db.prepare('SELECT driver_id FROM bookings WHERE id=1').get().driver_id, 7,
    'the job moves from the owner to the driver who took it');
});

test('the BUTTON shows on a job the default driver holds, and hides once a real one does', () => {
  const fn = /function jobCardHtml\(j\)\{[\s\S]*?\n\}/.exec(OWNER)[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/dispHeldByOther\s*=\s*\(!!j\.driverId&&!j\.driverIsDefault\)\|\|!!j\.assignedToName/.test(fn),
    'held-by-somebody-else is the test, not has-a-driver');
  assert.ok(/dispCanOffer=\(j\.apiStatus==='confirmed'\|\|j\.apiStatus==='active'\)&&!dispHeldByOther/.test(fn),
    'and it still requires a confirmed job');
  assert.ok(/\}else if\(dispCanOffer\)\{[\s\S]{0,400}dispOffer\(/.test(fn),
    'the button must no longer demand an EMPTY driver_id — that hid it on every job');
  assert.ok(!/!j\.driverId&&dispCanOffer/.test(fn), 'the old condition is gone');
});

test('the flag reaches the card from the API, not guessed from a name', () => {
  assert.ok(/driverIsDefault:!!b\.driver_is_default/.test(OWNER), 'the card reads the API field');
  const api = read('server/api.js');
  assert.ok(/u\.is_default_driver as driver_is_default/.test(api), 'and the API selects it');
  const offerSrc = read('server/offer-routes.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/is_default_driver FROM users WHERE id/.test(offerSrc),
    'the route asks the FLAG, never matches the owner by name');
  assert.ok(!/Nikodem/.test(offerSrc), 'no name-matching anywhere in the route');
});

test('the card stops announcing the default driver on every job', () => {
  const fn = /function dispStateRow\(j\)\{[\s\S]*?\n\}/.exec(OWNER)[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/j\.driverIsDefault&&!j\.assignedToName\)return ''/.test(fn),
    '"Nikodem · accepted" on all of them buries the ones somebody else took');
});

test('the card names who it went to, with the address', () => {
  const fn = /function dispStateRow\(j\)\{[\s\S]*?\n\}/.exec(OWNER)[0];
  assert.ok(/offeredIsAdhoc&&j\.offeredToEmail/.test(fn),
    'the owner typed that address from memory — the card is where he checks it');
  assert.ok(/not a registered driver/.test(fn),
    'an accepted ad-hoc job must not report a commission split nobody agreed to');
});

test('the columns exist and are additive', () => {
  for (const c of ['offered_to_name', 'offered_to_email', 'assigned_to_name',
                   'assigned_to_email', 'offered_to_reg', 'offered_to_car',
                   'assigned_to_reg', 'assigned_to_car']) {
    assert.ok(new RegExp("\\['" + c + "'").test(DB), c + ' is not migrated in');
  }
  assert.ok(/ALTER TABLE bookings ADD COLUMN/.test(DB), 'added, never a rebuild');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/adhoc-offer\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
