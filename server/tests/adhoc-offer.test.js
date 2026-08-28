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
      assigned_to_name TEXT, offered_at TEXT, decided_at TEXT, done_at TEXT,
      cancelled_at TEXT, cancellation_reason TEXT, driver_pay REAL, admin_fee REAL,
      offer_token TEXT, updated_at TEXT
    );
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, phone TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT,
      role TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_id INTEGER,
      action TEXT, detail TEXT, ip TEXT);
  `);
  db.prepare("INSERT INTO customers (id,email,full_name,phone) VALUES (1,'go@example.com','Gavin O''Shea','07700 900456')").run();
  db.prepare("INSERT INTO users (id,full_name,email,role,active) VALUES (7,'Dave Driver','dave@example.com','driver',1)").run();
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
    const r = offer(offers, { name: 'Sam Cole', email: 'sam@example.com' });
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
  assert.ok(/var dispCanOffer=\(j\.apiStatus==='confirmed'\|\|j\.apiStatus==='active'\);/.test(fn[0]),
    'the card must decide whether offering is allowed');
  assert.ok(/\}else if\(!j\.driverId&&dispCanOffer\)\{/.test(fn[0]),
    'and the Offer button must be behind it');
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
  const r = offer(offers, { name: 'Sam Cole', email: 'Sam@Example.COM' });
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
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com' });
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
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com' });
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
  offer(offers, { name: 'Sam Cole', email: 'sam@example.com' });
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
  assert.ok(/body:JSON\.stringify\(\{name:name,email:email\}\)/.test(fn[0]), 'and it posts both');
});

test('the card names who it went to, with the address', () => {
  const fn = /function dispStateRow\(j\)\{[\s\S]*?\n\}/.exec(OWNER)[0];
  assert.ok(/offeredIsAdhoc&&j\.offeredToEmail/.test(fn),
    'the owner typed that address from memory — the card is where he checks it');
  assert.ok(/not a registered driver/.test(fn),
    'an accepted ad-hoc job must not report a commission split nobody agreed to');
});

test('the columns exist and are additive', () => {
  for (const c of ['offered_to_name', 'offered_to_email', 'assigned_to_name']) {
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
