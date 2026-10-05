/**
 * SEEING — AND RE-SENDING — WHAT THE DRIVER GOT — run with:
 *   node server/tests/driver-email-view.test.js   (also gated by `npm test`)
 *
 * The owner could see the job, the payout and whether the reminder went, but
 * not the document in the driver's inbox. "Has he got the right address" and
 * "does he know what it pays" were questions only the driver could answer. And
 * once the payout can be adjusted after the fact, the email the driver is
 * holding goes stale the moment it is.
 *
 * THE PREVIEW IS THE EMAIL, NOT A PICTURE OF IT. buildDriverDispatch is the
 * single place the job email is made; the sender is now four lines that hand
 * its result to Resend, and the preview route asks the same function for the
 * same parts. A preview assembled any other way is a second document that
 * happens to look similar, and the day the two diverge is the day the owner is
 * reassured by the wrong one. This file pins that they are the same bytes.
 *
 * AND A RESEND IS BUILT FROM THE ROW AS IT STANDS, so it cannot name a figure
 * the ledger disagrees with — which is the whole reason for sending it again.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-devw-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const SENT = [];
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (!/resend\.com/.test(String(u))) return realFetch(u, o);
  try { SENT.push(JSON.parse(o.body)); } catch (e) {}
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const email = require('../email');
const api = require('../api');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function resp() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(method, routePath, params, body) {
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params, query: {}, body: body || {}, ip: '::1', auth: { role: 'owner', id: 1, type: 'user' } };
  const r = resp();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let next = false;
    await h(req, r, () => { next = true; });
    if (!next) break;
  }
  return r;
}

let seq = 0;
function passedJob(over) {
  const o = over || {};
  const d = db.prepare(`INSERT INTO users (username,password,role,full_name,email,phone,vehicle,reg,active,has_login,commission_pct)
                        VALUES (?, '', 'driver', 'Gary Mitchell', ?, '07700 900411', 'Mercedes E-Class', 'WM70 XYZ', 1, 0, 10)`)
    .run('dv' + (++seq) + Date.now().toString(36), 'gary' + seq + '@example.com').lastInsertRowid;
  const ref = 'WPH-V' + seq;
  db.prepare(`INSERT INTO bookings (ref,passenger_name,passenger_email,passenger_phone,pickup,destination,
                                    date,time,passengers,bags,fare,payment,status,driver_id,driver_pay,
                                    admin_fee,driver_payout_set,passed_at,assigned_to_name,assigned_to_email)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, 'Mrs Hall', 'hall@example.com', '07700 900101',
         'Weppons Farm, Wiston BN44 3DN', 'Gatwick Airport, South Terminal',
         '2026-10-14', '05:30', 2, 2, o.fare == null ? 95 : o.fare, o.payment || 'card', 'confirmed',
         d, o.driver_pay == null ? 85.5 : o.driver_pay, o.admin_fee == null ? 9.5 : o.admin_fee,
         o.payout_set == null ? null : o.payout_set, o.passed_at === null ? null : '2026-10-13 09:00',
         'Gary Mitchell', 'gary' + seq + '@example.com');
  return { driver: d, row: db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref) };
}
const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&pound;/g, '£').replace(/&middot;/g, '·')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

// ── 1. THE PREVIEW IS THE EMAIL ───────────────────────────────────────────
console.log('\nThe preview is the email, not a picture of it');

test('the sender has ONE builder, and it is the one the preview uses', () => {
  const src = strip(read('server/email.js'));
  assert.ok(/function buildDriverDispatch\(/.test(src), 'the builder is gone');
  const send = fnBlock(src, 'sendDriverDispatch');
  assert.ok(/buildDriverDispatch\(d\)/.test(send),
    'the sender builds its own email again — the preview can now drift from it');
  assert.ok(!/heroEmail\(/.test(send), 'the sender is assembling a body of its own');
  const apiSrc = strip(read('server/api.js'));
  assert.ok(/buildDriverDispatch\(payload\)/.test(apiSrc), 'the preview route is not using the builder');
});

test('the preview returns the SAME BYTES the sender would put on the wire', async () => {
  SENT.length = 0;
  const j = passedJob({});
  const pv = await call('get', '/bookings/:id/driver-email', { id: String(j.row.id) });
  assert.strictEqual(pv.statusCode, 200, JSON.stringify(pv.body));
  const rs = await call('post', '/bookings/:id/driver-email/resend', { id: String(j.row.id) });
  assert.strictEqual(rs.statusCode, 200, JSON.stringify(rs.body));
  const actual = SENT[SENT.length - 1];
  assert.strictEqual(pv.body.html, actual.html, 'the preview and the sent email are different documents');
  assert.strictEqual(pv.body.subject, actual.subject, 'the subjects differ');
  assert.strictEqual(pv.body.to, [].concat(actual.to)[0], 'the preview names a different recipient');
});

test('the preview carries the things the owner wants to check', async () => {
  const j = passedJob({});
  const pv = await call('get', '/bookings/:id/driver-email', { id: String(j.row.id) });
  const t = text(pv.body.html);
  assert.ok(/Weppons Farm/.test(t) && /Gatwick/.test(t), 'the trip is not in the preview');
  assert.ok(/Payout/.test(t) && /£85\.50/.test(t), 'the payout line is missing');
  assert.ok(/Prepaid|Cash/.test(t), 'the payment type is missing');
  assert.ok(/Mrs Hall/.test(t), 'the passenger is missing');
  assert.ok(/waze/i.test(pv.body.html), 'the Waze links are gone');
  assert.strictEqual(pv.body.has_calendar, true, 'the calendar file is not attached');
  assert.ok(!/undefined|NaN|\[object/.test(t), 'the preview has a hole in it: ' + t.slice(0, 200));
});

test('it is built from the row AS IT STANDS — an adjusted payout shows', async () => {
  const j = passedJob({});
  await call('patch', '/bookings/:id/driver-payout', { id: String(j.row.id) }, { payout: 70 });
  const pv = await call('get', '/bookings/:id/driver-email', { id: String(j.row.id) });
  const t = text(pv.body.html);
  assert.ok(/£70\.00/.test(t), 'the preview still shows the old payout');
  assert.ok(!/£85\.50/.test(t), 'the preview shows both figures');
  assert.ok(/agreed/.test(t), 'an adjusted payout is not named as agreed');
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(j.row.id);
  assert.strictEqual(ledger.jobSplit(row).payout, 70, 'the ledger and the preview disagree');
});

// ── 2. THE RESEND ─────────────────────────────────────────────────────────
console.log('\nSending it again, and saying so');

test('a resend goes to the driver with the CURRENT figure, and is audited', async () => {
  SENT.length = 0;
  const j = passedJob({});
  await call('patch', '/bookings/:id/driver-payout', { id: String(j.row.id) }, { payout: 62.5 });
  SENT.length = 0;
  const r = await call('post', '/bookings/:id/driver-email/resend', { id: String(j.row.id) });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.payout, 62.5, 'the response names a different figure');
  const mail = SENT[SENT.length - 1];
  assert.ok(/£62\.50/.test(text(mail.html)), 'the resent email does not carry the current payout');
  const log = db.prepare(`SELECT * FROM audit_log WHERE action = 'driver_email_resent'
                           ORDER BY id DESC LIMIT 1`).get();
  assert.ok(log, 'the resend was not audited');
  assert.ok(/62\.50/.test(log.detail), 'the audit line does not record what was sent: ' + log.detail);
  assert.ok(new RegExp(j.row.ref).test(log.detail), 'the audit line does not name the job');
});

test('a job nobody was passed, and a cancelled one, are both refused', async () => {
  const none = passedJob({ passed_at: null });
  const a = await call('get', '/bookings/:id/driver-email', { id: String(none.row.id) });
  assert.strictEqual(a.statusCode, 409, 'a never-passed job rendered a driver email');
  const b = await call('post', '/bookings/:id/driver-email/resend', { id: String(none.row.id) });
  assert.strictEqual(b.statusCode, 409);

  const j = passedJob({});
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(j.row.id);
  const c = await call('post', '/bookings/:id/driver-email/resend', { id: String(j.row.id) });
  assert.strictEqual(c.statusCode, 409, 'a cancelled job was re-sent to its driver');
});

test('both are staff-only', async () => {
  const j = passedJob({});
  for (const [m, p] of [['get', '/bookings/:id/driver-email'], ['post', '/bookings/:id/driver-email/resend']]) {
    const l = api.stack.find((x) => x.route && x.route.path === p && x.route.methods[m]);
    const req = { params: { id: String(j.row.id) }, query: {}, body: {}, ip: '::1',
                  auth: { role: 'driver', id: 2, type: 'user' } };
    const r = resp();
    for (const h of l.route.stack.map((x) => x.handle)) {
      let next = false; await h(req, r, () => { next = true; }); if (!next) break;
    }
    assert.strictEqual(r.statusCode, 403, p + ' is open to a driver');
  }
});

// ── 3. THE CONTROLS ───────────────────────────────────────────────────────
console.log('\nBoth apps offer both, on a passed job');

for (const [who, file, view, resend] of [
  ['owner', 'westmere-owner.html', 'ownerViewDriverEmail', 'ownerResendDriverEmail'],
  ['admin', 'westmere-admin.html', 'admViewDriverEmail', 'admResendDriverEmail']]) {
  test(who + ': View and Resend are wired to the real routes', () => {
    const src = strip(read(file), { html: true });
    const v = fnBlock(src, view);
    assert.ok(/\/driver-email'/.test(v), who + ': View does not call the preview route');
    assert.ok(/invPreviewOpen\(/.test(v), who + ': View does not show it in the preview chrome');
    assert.ok(/html:\s*d\.html/.test(v), who + ': View is not rendering the server\'s HTML');
    const r = fnBlock(src, resend);
    assert.ok(/driver-email\/resend/.test(r), who + ': Resend does not call the resend route');
    assert.ok(/method:\s*'POST'/.test(r), who + ': Resend is not POSTing');
    assert.ok(/WMAsk\.confirm/.test(r), who + ': Resend fires without asking');
    assert.ok(new RegExp(view + '\\(').test(src) && new RegExp(resend + '\\(').test(src),
      who + ': the buttons are not on any card');
  });

  test(who + ': adjusting the payout offers the resend', () => {
    const src = strip(read(file), { html: true });
    const adj = fnBlock(src, who === 'owner' ? 'ownerAdjustPayout' : 'admAdjustPayout');
    assert.ok(new RegExp(resend + '\\(id').test(adj),
      who + ': after changing the pay, the driver is left holding an email with the old figure');
    assert.ok(/d\.previous!==d\.payout/.test(adj),
      who + ': it offers a resend even when nothing changed');
  });
}

test('the preview chrome can show HTML we hold, not only a URL', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    const open = fnBlock(strip(read(f), { html: true }), 'invPreviewOpen');
    assert.ok(/srcdoc/.test(open), f + ': the preview cannot show a document we already have');
    assert.ok(/o_\.html \? ''/.test(open), f + ': an email preview still offers "Open the PDF"');
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/driver-email-view\.test\.js/.test(read('package.json')),
    'driver-email-view.test.js is not in the npm test chain — an unrun guard is no guard');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  try { fs.unlinkSync(TMP); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
