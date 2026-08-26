/**
 * SEND A LETTER TO ANYBODY —
 *   node server/tests/outreach.test.js   (also gated by `npm test`)
 *
 * A form that sends mail out under westmereprivatehire.co.uk to an address
 * typed by hand. Two things follow from that, and they are what this pins:
 *
 *   WHO MAY USE IT. Staff only. A loose gate here is not a bug in an app, it
 *   is somebody else's spam problem with Westmere's name and domain on it, and
 *   the damage lands on a sending reputation that every booking email depends
 *   on.
 *
 *   WHAT IT SENDS. The typed message is DATA. It is escaped and its line
 *   breaks kept — never interpreted as HTML, or a field on an internal form
 *   becomes a way to put arbitrary markup in a stranger's inbox.
 *
 * And the design point: this is the ONE shell with the photo turned off, not a
 * second email design. The coastal hero belongs on a booking the customer has
 * paid for; on a first approach to a hotel it is advertising in the middle of
 * an introduction.
 *
 * Nothing is sent — the mailer is stubbed at the HTTP layer.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { routeBlock } = require('./_source');

process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

let SENT = [];
global.fetch = async (u, o) => {
  SENT.push(JSON.parse(o.body));
  return { ok: true, status: 200, json: async () => ({ id: 'rid' }) };
};
const email = require('../email');

// ── 1. THE LETTERHEAD ────────────────────────────────────────────────────
console.log('\nThe letterhead');

const sample = 'Dear Ms Whitfield,\n\nI run Westmere Private Hire, a small chauffeur service in Sussex.\n\nKind regards,\nNikodem';

async function send(o) {
  SENT = [];
  const ok = await email.sendOutreachMessage(
    (o && o.to) || 'concierge@grandhotel.co.uk',
    (o && o.subject) || 'Introducing Westmere Private Hire',
    (o && o.message) || sample);
  return { ok, mail: SENT[0] };
}

test('it carries the Westmere wordmark and NO hero photo', async () => {
  const { mail } = await send();
  assert.ok(mail, 'nothing was sent');
  assert.ok(/WESTMERE/.test(mail.html), 'the wordmark must be there');
  assert.ok(/Private Hire &middot; Sussex|Private Hire · Sussex/.test(mail.html), 'and the strapline');
  assert.ok(!/westmere-email-hero\.jpg/.test(mail.html),
    'the coastal hero photo must NOT be on a business letter');
});

test('it keeps the rest of the house design', async () => {
  const { mail } = await send();
  assert.ok(/Cormorant/.test(mail.html), 'the house face');
  assert.ok(/With kind regards/.test(mail.html), 'the signature block');
  assert.ok(/westmereprivatehire\.co\.uk/.test(mail.html), 'and the footer');
  assert.ok(!/anything needs adjusting/.test(mail.html),
    'the booking-era footer line makes no sense to somebody who has not booked');
});

test('it is the SAME shell, not a second design', () => {
  const src = read('server/email.js');
  const letter = /function letterEmail[\s\S]*?\n\}/.exec(src);
  assert.ok(letter, 'letterEmail is missing');
  assert.ok(/heroShell\(/.test(letter[0]), 'it must build on heroShell');
  assert.ok(/hero: false/.test(letter[0]), 'suppressing the photo by parameter, not by copying markup');
});

test('the typed message survives intact, paragraphs and all', async () => {
  const { mail } = await send();
  assert.ok(/Dear Ms Whitfield/.test(mail.html), 'the greeting');
  assert.ok(/small chauffeur service in Sussex/.test(mail.html), 'the body');
  assert.ok(/Kind regards/.test(mail.html), 'and the sign-off');
  assert.ok(/<br>/.test(mail.html), 'single line breaks are kept');
});

test('the message is DATA — never markup', async () => {
  const { mail } = await send({ message: 'Hello <script>alert(1)</script> & <b>bold</b>\nsee you' });
  assert.ok(!/<script>alert/.test(mail.html), 'a script tag must never reach the recipient');
  assert.ok(/&lt;script&gt;/.test(mail.html), 'it must be escaped and visible as text');
  assert.ok(/&amp;/.test(mail.html), 'and an ampersand escaped too');
});

test('the PREHEADER is escaped too — the hole beside the body', async () => {
  /* The body has always been escaped. The preheader was not, and several
     callers put human-typed text in it — the owner's Send Message has done so
     since it shipped. Escaped once inside sendEmail, so every caller is
     covered rather than each one remembering. */
  const { mail } = await send({ message: '<img src=x onerror=alert(1)> hello' });
  const hidden = /<div style="display:none[^"]*">([\s\S]*?)<\/div>/.exec(mail.html);
  assert.ok(hidden, 'the preheader div is missing');
  assert.ok(!/<img/.test(hidden[1]), 'no live tag may reach the preheader');
  assert.ok(/&lt;img/.test(hidden[1]), 'it must be escaped');
  const src = read('server/email.js');
  const fn = /async function sendEmail\([\s\S]*?\n\}/.exec(src)[0];
  assert.ok(/escHtml\(preheader\)/.test(fn),
    'sendEmail must escape the preheader for every caller, not just this one');
});

test('the subject becomes the subject; replies come back to Westmere', async () => {
  const { mail } = await send({ subject: 'A quick introduction' });
  assert.strictEqual(mail.subject, 'A quick introduction');
  assert.ok(/bookings@westmereprivatehire\.co\.uk/.test(mail.from), 'sent from the company address');
  assert.ok(/bookings@westmereprivatehire\.co\.uk/.test(mail.reply_to || ''), 'and replies come back to it');
});

test('an incomplete letter is not sent at all', async () => {
  for (const o of [{ to: '' }, { subject: '' }, { message: '' }, { message: '   ' }]) {
    SENT = [];
    const ok = await email.sendOutreachMessage(
      o.to === undefined ? 'a@b.co' : o.to,
      o.subject === undefined ? 'Subject' : o.subject,
      o.message === undefined ? 'Body' : o.message);
    assert.strictEqual(ok, false, 'must refuse: ' + JSON.stringify(o));
    assert.strictEqual(SENT.length, 0, 'and send nothing');
  }
});

// ── 2. WHO MAY SEND ──────────────────────────────────────────────────────
console.log('\nWho may send it');

const apiSrc = read('server/api.js');
const route = routeBlock(apiSrc, "router.post('/outreach'");

test('the route is STAFF-only and audited', () => {
  assert.ok(route, 'POST /outreach is missing');
  assert.ok(/\['admin', 'owner'\]\.includes\(req\.auth\.role\)/.test(route), 'staff only');
  assert.ok(/403/.test(route));
  assert.ok(/audit_log/.test(route), 'outbound mail under the company domain must leave a trail');
});

function runAs(role, body) {
  const res = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
  const sandbox = {
    getDb: () => ({ prepare: () => ({ run() {} }) }), res,
    req: { auth: { role, id: 1 }, body: body || {}, ip: '::1' },
    require: (m) => require(path.join(ROOT, 'server', m.replace(/^\.\//, ''))),
    String, JSON, console: { log() {}, error() {} }, Promise
  };
  vm.createContext(sandbox);
  const inner = route.slice(route.indexOf('{') + 1, route.lastIndexOf('}'));
  vm.runInContext('(async function(req,res){' + inner + '})(req,res)', sandbox);
  return res;
}

test('a customer or a driver cannot send mail as Westmere', () => {
  for (const role of ['customer', 'driver', undefined]) {
    assert.strictEqual(runAs(role, { to: 'a@b.co', subject: 's', message: 'm' }).statusCode, 403,
      role + ' must be refused');
  }
});

test('a bad address is refused before anything is sent', () => {
  for (const to of ['', 'not-an-email', 'a@b', 'a b@c.co', '@nope.com']) {
    const r = runAs('owner', { to, subject: 's', message: 'm' });
    assert.strictEqual(r.statusCode, 400, 'must refuse: ' + JSON.stringify(to));
  }
});

test('a list of recipients in one box is refused, and SAYS why', () => {
  /* A personal note becomes an accidental mailshot exactly here. The address
     regex already rejects these (two @ signs), so asserting only the 400 would
     pass even with the separator check deleted — the assertion is on the REASON
     so that it can actually fail. */
  for (const to of ['a@b.co,c@d.co', 'a@b.co; c@d.co']) {
    const r = runAs('owner', { to, subject: 's', message: 'm' });
    assert.strictEqual(r.statusCode, 400, 'must refuse: ' + to);
    assert.strictEqual(r.body.error, 'One recipient at a time',
      'the separator check must be the one that catches it: ' + to);
  }
});

test('an empty subject or message is refused', () => {
  assert.strictEqual(runAs('owner', { to: 'a@b.co', subject: '', message: 'm' }).statusCode, 400);
  assert.strictEqual(runAs('owner', { to: 'a@b.co', subject: 's', message: '   ' }).statusCode, 400);
});

// ── 3. THE COMPOSE SCREEN ────────────────────────────────────────────────
console.log('\nThe compose screen');

const OWNER = read('westmere-owner.html');

test('the owner app has a Messages screen with the three fields', () => {
  /* It lives in the left drawer now rather than on the bottom bar. What matters
     here is that there IS a way in and the pane exists; which control opens it
     is owner-nav.test.js's business. */
  assert.ok(/id="sd-compose"/.test(OWNER) || /id="bn-compose"/.test(OWNER),
    'there must be a control that opens it');
  assert.ok(/id="pg-compose"/.test(OWNER), 'and its pane');
  for (const id of ['cmp-to', 'cmp-subject', 'cmp-message']) {
    assert.ok(new RegExp('id="' + id + '"').test(OWNER), 'missing field: ' + id);
  }
  assert.ok(/onclick="composeSend\(\)"/.test(OWNER), 'and a send action');
});

test('the send button locks while sending', () => {
  const fn = /async function composeSend\(\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(fn, 'composeSend is missing');
  assert.ok(/btn\.disabled=true/.test(fn[0]),
    'sending is not undoable — a second tap is a second email to a stranger');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/outreach\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
