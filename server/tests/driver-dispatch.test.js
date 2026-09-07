/**
 * SENDING A JOB TO A DRIVER — run with:
 *   node server/tests/driver-dispatch.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   Passing a job on was a chain of five native prompt() boxes — who, name,
 *   email, registration, car — each a modal with no way back and nothing on
 *   screen to check against. On a phone the owner saw "Enter a number:".
 *
 * WHAT IS GUARDED
 *   1. The prompt chain is gone from BOTH apps, replaced by one form that
 *      captures name, email and phone together, with saved drivers selectable.
 *   2. The confirmation shows the money before anything is sent — fare,
 *      commission and payout — because the driver's email shows it too and the
 *      two must not be the first place they disagree.
 *   3. Sending assigns the booking, stores the split, and STAMPS it as passed
 *      on: driver_id alone cannot say it, because the owner is a driver too.
 *   4. Both emails leave from that one action.
 *   5. "Save this driver" persists him for reuse — with no login and no email
 *      to him, because a driver record is internal data.
 *   6. The payout is the fare less ten per cent, and the job then appears in
 *      that driver's history and balance.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-disp-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const SENT = [];
global.fetch = async (u, o) => {
  try { SENT.push(JSON.parse(o.body)); } catch (e) {}
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const router = require('../offer-routes');

const ROOT = path.join(__dirname, '..', '..');
const APPS = [['westmere-owner.html', 'the owner app'], ['westmere-admin.html', 'the admin app']];
const app = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
/* The route's own middleware calls next() without awaiting it, so awaiting the
   chain is not enough — the handler is awaited directly. */
async function dispatch(id, body) {
  const l = router.stack.find((x) => x.route && x.route.path === '/bookings/:id/dispatch' && x.route.methods.post);
  assert.ok(l, 'POST /bookings/:id/dispatch is missing');
  const handlers = l.route.stack.map((x) => x.handle);
  const req = { params: { id: String(id) }, query: {}, body: body || {}, ip: '::1',
                auth: { role: 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of handlers) {
    let advanced = false;
    await h(req, r, () => { advanced = true; });
    if (!advanced && h !== handlers[handlers.length - 1]) break;
  }
  return r;
}

let seq = 0;
function seedBooking(over) {
  const o = Object.assign({ fare: 96, payment: 'account', status: 'confirmed' }, over || {});
  const ref = 'WPH-D' + (++seq);
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,passenger_email,passenger_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Worthing', 'Gatwick', '2026-10-02', '07:00', 2, o.fare, o.payment, o.status,
         'ben@example.com', 'Ben Chan');
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
}
const rowOf = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

// ── 1. ONE FORM, NOT A CHAIN OF PROMPTS ──────────────────────────────────
console.log('\nOne form, not five prompt boxes');

for (const [file, label] of APPS) {
  test(label + ': the prompt chain is gone', () => {
    /* COMMENTS STRIPPED FIRST. The comment above the replacement quotes the
       prompt it replaced — "Enter a number:" — so searching the raw file found
       the guard's own documentation and reported the bug as still present. */
    const s = app(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    for (const gone of ['Send this job to who', 'Their registration number', 'Enter a number']) {
      assert.ok(s.indexOf(gone) === -1, label + ' still asks "' + gone + '" in a prompt box');
    }
    assert.ok(!/function dispOfferAdhoc/.test(s), label + ' still has the typed-in-prompts path');
    /* And no function in the dispatch path asks anything through a native box.
       Bounded per function rather than between two landmarks — dispReclaim is
       an owner-app action and does not exist in admin, so a span between them
       measured nothing there. */
    const fnBody = (name) => {
      const i = s.indexOf(name + '(');
      assert.ok(i > -1, label + ': ' + name + ' is missing');
      const end = s.indexOf('\n}', i);
      assert.ok(end > i, label + ': ' + name + ' has no closing brace');
      return s.slice(i, end);
    };
    for (const fn of ['function dispOpen', 'function dispReview', 'function dispSend']) {
      assert.ok(!/\bprompt\(/.test(fnBody(fn)),
        label + ': ' + fn + ' still calls prompt()');
    }
  });

  test(label + ': name, email and phone are on one form', () => {
    const s = app(file);
    for (const id of ['disp-name', 'disp-email', 'disp-phone']) {
      assert.ok(s.indexOf('id="' + id + '"') !== -1, label + ' has no ' + id + ' field');
    }
    assert.ok(s.indexOf('id="disp-saved"') !== -1,
      label + ' has no saved-driver picker — he would retype an address he has used before');
    assert.ok(/fetch\('\/api\/drivers'/.test(s), label + ' never loads the saved drivers');
  });

  test(label + ': there is a tick to save the driver', () => {
    const s = app(file);
    assert.ok(s.indexOf('id="disp-save"') !== -1, label + ' has no save tick');
    assert.ok(/save_driver:\s*document\.getElementById\('disp-save'\)\.checked/.test(s),
      label + ': the tick is drawn but never sent');
  });

  test(label + ': the confirmation shows the money before it sends', () => {
    const s = app(file);
    assert.ok(/function dispReview/.test(s), label + ' has no confirmation step');
    for (const shown of ['Your commission (10%)', 'Driver payout', 'Fare']) {
      assert.ok(s.indexOf(shown) !== -1,
        label + ": the confirmation does not show '" + shown + "' — the driver's email does");
    }
    assert.ok(/id="disp-send"/.test(s) && /dispSend/.test(s),
      label + ': nothing sends from the confirmation');
  });

  test(label + ': it posts to the dispatch route, not the offer route', () => {
    const s = app(file);
    const fn = s.slice(s.indexOf('async function dispSend'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/\/dispatch'/.test(body), label + ': the form does not send a dispatch');
    assert.ok(!/\/offer'/.test(body),
      label + ': the form still OFFERS the job — this is a dispatch, there is nothing to accept');
  });
}

// ── 2. WHAT SENDING ACTUALLY DOES ────────────────────────────────────────
console.log('\nSending assigns the job, pays the driver, and tells the customer');

test('the booking is assigned, split stored, and stamped as passed on', async () => {
  const b = seedBooking({ fare: 96 });
  const r = await dispatch(b.id, { name: 'Marek Nowak', email: 'marek@example.com',
    phone: '07700 900222', reg: 'lt21 xyz', car: 'Skoda Superb, grey' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(b.id);
  assert.strictEqual(after.assigned_to_name, 'Marek Nowak', 'the driver is not on the booking');
  assert.strictEqual(after.assigned_to_reg, 'LT21 XYZ', 'the plate is not normalised for the customer');
  assert.strictEqual(after.driver_pay, 86.40, 'payout should be the fare less 10%');
  assert.strictEqual(after.admin_fee, 9.60, 'commission should be 10% of the fare');
  assert.ok(after.passed_at,
    'the job is not stamped as passed on — driver_id alone cannot say it, because '
    + 'the owner is a driver too and his own jobs carry his id');
});

test('both emails leave from the one action', async () => {
  SENT.length = 0;
  const b = seedBooking({});
  await dispatch(b.id, { name: 'Marek Nowak', email: 'marek@example.com' });
  const subjects = SENT.map((e) => String(e.subject || ''));
  assert.ok(subjects.some((s) => /Your job/.test(s)),
    'the driver was not sent the job: ' + JSON.stringify(subjects));
  assert.ok(subjects.some((s) => /Your driver/.test(s)),
    'the customer was not told who is picking them up: ' + JSON.stringify(subjects));
  const driverMail = SENT.find((e) => /Your job/.test(e.subject || ''));
  /* THE BREAKDOWN, PLAINLY. Three figures he can check — fare, the ten per
     cent, what reaches him — and one short status line. Not a paragraph: an
     earlier version explained each case in a sentence and a half, and a driver
     reading a job at six in the morning wants the number and the word. */
  assert.ok(/Fare/.test(driverMail.html), "the driver's email does not show the fare");
  assert.ok(driverMail.html.indexOf('£96.00') !== -1, 'the fare figure is missing');
  assert.ok(/Commission \(10%\)/.test(driverMail.html),
    'the commission line is missing or no longer names the rate');
  assert.ok(driverMail.html.indexOf('\u2212£9.60') !== -1,
    'the commission is not shown as a deduction');
  assert.ok(/Total/.test(driverMail.html) && driverMail.html.indexOf('£86.40') !== -1,
    'the total the driver is paid is missing');
  assert.ok(/Prepaid/.test(driverMail.html),
    'a prepaid job must say so — one word, not a paragraph');
  for (const gone of ['already settled with Westmere', 'take no money in the car', 'nothing to hand over']) {
    assert.ok(driverMail.html.indexOf(gone) === -1,
      'the explanatory prose is back: "' + gone + '"');
  }

  const customerMail = SENT.find((e) => /Your driver/.test(e.subject || ''));
  assert.ok(!/commission|payout/i.test(customerMail.html),
    'the customer is being shown what the operator pays the driver');
});

test('the calendar section is ONE link, and no prose about the .ics', async () => {
  /* The dispatch email is read on a phone by somebody who already knows he has
     the job. Two sentences telling him a file is attached and what to do with
     it are furniture; the link is the whole of the useful part.

     The .ics is STILL ATTACHED — silently. That is the point of the change: the
     attachment keeps working for the clients that open it, and the body stops
     narrating it. So this guard asserts the attachment AND the absence of the
     words, or a "fix" that simply dropped the .ics would pass. */
  SENT.length = 0;
  const b = seedBooking({});
  await dispatch(b.id, { name: 'Marek Nowak', email: 'marek@example.com' });
  const mail = SENT.find((e) => /Your job/.test(e.subject || ''));
  assert.ok(mail, 'no driver email was sent');

  assert.ok(/calendar\.google\.com\/calendar\/render\?/.test(mail.html),
    'the add-to-calendar link is gone — that is the one thing the section is for');
  assert.ok(/Add to calendar/i.test(mail.html), 'the link has lost its label');

  const att = (mail.attachments || []);
  assert.strictEqual(att.length, 1, 'the .ics must still be attached, silently');
  assert.ok(/^text\/calendar/.test(att[0].content_type || ''), 'and still be a calendar file');

  /* The prose, by its own words and by its shape. */
  const text = mail.html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');
  for (const gone of ['attached as a calendar file', 'goes straight into your diary',
                      'all-day entry', 'Or add it to Google Calendar']) {
    assert.ok(text.indexOf(gone) === -1, 'the .ics explanation is back: "' + gone + '"');
  }
  assert.ok(!/\.ics/i.test(text), 'the body still names the attachment file');

  /* ONE link, not two: the older block offered the .ics and the Google link as
     alternatives, and "remove the prose" must not leave both anchors behind. */
  const cal = (mail.html.match(/calendar\.google\.com/g) || []).length;
  assert.strictEqual(cal, 1, 'expected exactly one calendar link, found ' + cal);
});

test('the OFFER emails keep their full calendar wording', async () => {
  /* calendarBlock is shared by four emails. Only the dispatch was asked to go
     minimal; an offer to somebody who has never had a job from us still has to
     say what the attachment is. This guard is what stops the change being made
     by deleting the paragraph outright. */
  SENT.length = 0;
  const email = require('../email');
  const job = { ref: 'WPH-OFFER1', date: '2026-09-14', time: '07:15',
    pickup: '14 Puttock Way, Horsham', destination: 'Gatwick Airport',
    fare: 96, driver_name: 'Sam Cole', driver_email: 'sam@example.com' };
  await email.sendAdhocJobOffer(job);
  const offer = SENT[0];
  assert.ok(offer, 'the ad-hoc offer did not send');
  assert.ok(/attached as a calendar file/.test(offer.html),
    'the offer email has lost the wording the dispatch email dropped');
  assert.ok(/WPH-OFFER1\.ics/.test(offer.html), 'and it still names the file');
});

test('"save this driver" persists him — with no login and no email to him', async () => {
  SENT.length = 0;
  const b = seedBooking({});
  await dispatch(b.id, { name: 'Dawid Kowalski', email: 'dawid@example.com',
    phone: '07700 900333', reg: 'BX19 HTS', car: 'Mercedes E-Class', save_driver: true });
  const d = db.prepare("SELECT * FROM users WHERE email = 'dawid@example.com'").get();
  assert.ok(d, 'the driver was not saved');
  assert.strictEqual(d.phone, '07700 900333', 'the phone number was not saved');
  assert.strictEqual(d.reg, 'BX19 HTS', 'the registration was not saved');
  assert.strictEqual(d.has_login, 0, 'the saved driver was given a login — this is internal data');
  assert.ok(!SENT.some((e) => String(e.to || '') === 'dawid@example.com' && /welcome/i.test(e.subject || '')),
    'a welcome email was sent to the driver — nothing should land in his inbox because of the tick');
});

test('saving twice updates rather than duplicating', async () => {
  const before = db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'dawid@example.com'").get().c;
  const b = seedBooking({});
  await dispatch(b.id, { name: 'Dawid Kowalski', email: 'dawid@example.com', save_driver: true });
  const after = db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'dawid@example.com'").get().c;
  assert.strictEqual(after, before, 'a second dispatch created a duplicate driver');
});

test('a saved driver can be picked without retyping', async () => {
  const drv = db.prepare("SELECT * FROM users WHERE email = 'dawid@example.com'").get();
  const b = seedBooking({});
  const r = await dispatch(b.id, { driver_id: drv.id });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = rowOf(b.id);
  assert.strictEqual(after.assigned_to_name, 'Dawid Kowalski', 'the saved name was not used');
  assert.strictEqual(after.assigned_to_reg, 'BX19 HTS', 'the saved plate was not used');
});

test('a bad address is refused before anything is sent', async () => {
  SENT.length = 0;
  const b = seedBooking({});
  const r = await dispatch(b.id, { name: 'Someone', email: 'not-an-address' });
  assert.strictEqual(r.statusCode, 400, 'a malformed address was accepted');
  assert.strictEqual(SENT.length, 0, 'emails went out despite the refusal');
  assert.ok(!rowOf(b.id).passed_at, 'the booking was passed on despite the refusal');
});

// ── 3. THE MONEY THAT FOLLOWS ────────────────────────────────────────────
console.log('\nThe job lands in that driver\'s history and balance');

test('a dispatched job appears in the driver\'s history with a running balance', async () => {
  const drv = db.prepare("SELECT * FROM users WHERE email = 'dawid@example.com'").get();
  const h = ledger.driverHistory(drv.id);
  assert.ok(h.items.length >= 1, 'the job is not in his history');
  const row = h.items[h.items.length - 1];
  assert.strictEqual(row.commission, 9.60, 'his history disagrees with the booking about the commission');
  assert.strictEqual(row.payout, 86.40, 'his history disagrees about the payout');
  assert.strictEqual(row.paymentType, 'prepaid', 'an account job is not prepaid');
  assert.strictEqual(h.totals.balance, ledger.driverBalance(drv.id),
    'the running balance and the standalone balance disagree');
});

test('a cash job moves the balance the other way', async () => {
  const b = seedBooking({ payment: 'cash', fare: 100 });
  await dispatch(b.id, { name: 'Cash Driver', email: 'cash@example.com', save_driver: true });
  const drv = db.prepare("SELECT * FROM users WHERE email = 'cash@example.com'").get();
  const h = ledger.driverHistory(drv.id);
  const row = h.items[0];
  assert.strictEqual(row.paymentType, 'cash', 'a cash job is not marked cash');
  assert.strictEqual(row.delta, -10,
    'he took £100 at the kerb, so he owes the £10 commission — the balance must move against him');
  assert.strictEqual(h.totals.balance, -10, 'the running balance is wrong for a cash job');
});

test('only the commission is Westmere income on a passed job', () => {
  const passed = { fare: 100, payment: 'account', passed_at: '2026-10-02', admin_fee: 10, driver_pay: 90 };
  const own = { fare: 100, payment: 'account' };
  assert.strictEqual(ledger.westmereIncome(passed), 10,
    'a passed job counts its whole fare as turnover — the payout is not Westmere\'s money');
  assert.strictEqual(ledger.westmereIncome(own), 100,
    'a job Westmere drove itself should count in full');
});

test('a CASH job names the amount and says the fee carries', async () => {
  /* He collects the fare himself, so the email has to name it — he cannot ask
     the passenger otherwise. And his ten per cent is not handed over at the
     kerb: it is netted against his next payout, which is what the line means
     and what driver-ledger.js actually does. */
  SENT.length = 0;
  const b = seedBooking({ payment: 'cash', fare: 96 });
  await dispatch(b.id, { name: 'Marek Nowak', email: 'marek@example.com' });
  const mail = SENT.find((e) => /Your job/.test(e.subject || ''));
  assert.ok(mail, 'no driver email was sent for the cash job');
  assert.ok(/Cash/.test(mail.html), 'a cash job must say so');
  assert.ok(/collect/i.test(mail.html) && mail.html.indexOf('£96.00') !== -1,
    'a cash job must name what to collect — without it he cannot do the job');
  assert.ok(/carries/i.test(mail.html) && mail.html.indexOf('£9.60') !== -1,
    'it must say the fee carries to the next payout, and name it');
  /* One line, not a paragraph. */
  const text = mail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const line = /Cash[^.]*\.[^.]*\./.exec(text);
  assert.ok(line && line[0].length < 120,
    'the cash status has grown into a paragraph: ' + (line ? line[0].length : '?') + ' chars');
});

test('and the fee really is netted against a later payout', async () => {
  /* "Carries to your next payout" is the ledger's netting, not a form of words:
     a cash job moves the balance AGAINST him by the commission, and the next
     prepaid job's payout is reduced by exactly that. */
  const email = 'netting@example.com';
  const cashJob = seedBooking({ payment: 'cash', fare: 100 });
  await dispatch(cashJob.id, { name: 'Netting Driver', email, save_driver: true });
  const drv = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  assert.strictEqual(ledger.driverBalance(drv.id), -10,
    'after a £100 cash job he should owe the £10 fee');

  const prepaid = seedBooking({ payment: 'account', fare: 100 });
  await dispatch(prepaid.id, { driver_id: drv.id });
  assert.strictEqual(ledger.driverBalance(drv.id), 80,
    'the £10 fee must net off the £90 payout, leaving £80 owed — not £90');
});

test('the full split is still STORED, whatever the email shows', async () => {
  /* The email got simpler; the records did not. */
  const b = seedBooking({ fare: 96 });
  await dispatch(b.id, { name: 'Marek Nowak', email: 'marek@example.com', save_driver: true });
  const row = rowOf(b.id);
  assert.strictEqual(row.driver_pay, 86.40, 'the payout is not on the booking');
  assert.strictEqual(row.admin_fee, 9.60, 'the commission is not on the booking');
  const drv = db.prepare("SELECT * FROM users WHERE email = 'marek@example.com'").get();
  const h = ledger.driverHistory(drv.id);
  const last = h.items[h.items.length - 1];
  assert.strictEqual(last.fare, 96, 'the ledger lost the fare');
  assert.strictEqual(last.commission, 9.60, 'the ledger lost the commission');
  assert.strictEqual(last.payout, 86.40, 'the ledger lost the payout');
  assert.strictEqual(ledger.westmereIncome(row), 9.60,
    'the income rule no longer sees the commission');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('driver-dispatch.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
