/**
 * THE INVOICE EMAIL —
 *   node server/tests/invoice-email.test.js   (also gated by `npm test`)
 *
 * The owner's complaint was that an invoice arrived looking like a covering
 * note with a file stapled to it, while every other email from the business is
 * the branded confirmation. So both invoice emails now use that same template.
 * What has to stay true of them:
 *
 *   NO PAY BUTTONS. An invoiced booking is billed to an account. There is
 *   nothing to pay by card, no cash owed to a driver, and no "cancel" — those
 *   buttons are gated on a pay_token, and an invoice is never given one. The
 *   template refuses them a second time on the variant, so a token arriving by
 *   accident still cannot put a Pay Now in front of somebody who has been
 *   invoiced.
 *
 *   THE PAYMENT ROW SAYS SO. "Payment method — Invoice", stated rather than
 *   left to be inferred from the absence of anything else.
 *
 *   THE PDF IS ATTACHED, not linked. The email says "please find your invoice
 *   attached", and this asserts that a real PDF reaches the mailer — and that
 *   when generation failed and there is nothing to attach, the email stops
 *   claiming there is.
 *
 *   "DEAR THE,". greetingName() takes the first word of a name, which is right
 *   for Mr Ben Chan and wrong for The Grand Hotel Brighton — and an invoice is
 *   the one email routinely addressed to a company.
 *
 * Renders the REAL emails with the mailer intercepted. Nothing is sent.
 * Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('server/email.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/* THE MAILER, INTERCEPTED.
   sendEmail is replaced at compile time rather than stubbed on the exports,
   because the invoice senders call it directly by name — a stub on the module
   object would never be reached, and every assertion here would pass while the
   real function ran (or, worse, tried to send). */
function loadEmailModule() {
  const p = path.join(ROOT, 'server', 'email.js');
  const captured = [];
  const src = fs.readFileSync(p, 'utf8').replace(
    'async function sendEmail(',
    'async function sendEmail(__to, __subject, __html, __from, __preheader, __opts){\n' +
    '  global.__WM_SENT.push({to:__to, subject:__subject, html:__html, opts:__opts});\n' +
    '  return "captured";\n}\nasync function __realSendEmail('
  );
  assert.ok(src.indexOf('__realSendEmail') !== -1, 'the mailer interception did not take — refusing to run');
  global.__WM_SENT = captured;
  const m = new Module(p, null);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  return { email: m.exports, captured };
}

const SETTINGS = {
  business_name: 'Westmere Private Hire', owner_name: 'Nikodem Krajnyk',
  address_line1: '4 Fisher Street', address_line2: 'Lewes, East Sussex', postcode: 'BN7 2DG',
  phone: '07930 342593', email: 'bookings@westmereprivatehire.co.uk'
};
const BOOKINGS = [
  { ref: 'WPH-4871', date: '2026-08-03', time: '05:30', pickup: 'The Grand Hotel, Brighton', destination: 'London Gatwick Airport', fare: 75, flight: 'BA2751' },
  { ref: 'WPH-4903', date: '2026-08-18', time: '19:10', pickup: 'The Grand Hotel, Brighton', destination: 'Lewes, BN7 2AN', fare: 40, flight: '' }
];
const FAKE_PDF = Buffer.from('%PDF-1.3\n% a real enough pdf for the mailer\n%%EOF\n');

async function accountEmail(over) {
  const { email, captured } = loadEmailModule();
  const o = over || {};
  await email.sendCustomerInvoice(
    o.customer || { email: 'accounts@example.com', full_name: 'The Grand Hotel Brighton', phone: '01273 224300' },
    o.bookings || BOOKINGS,
    { label: 'August 2026', dueDate: '2026-09-09', issuedDate: '2026-08-26' },
    'INV-202608-0012', SETTINGS, 'pdf' in o ? o.pdf : FAKE_PDF);
  return captured[0];
}

async function bespokeEmail(over) {
  const { email, captured } = loadEmailModule();
  const o = over || {};
  await email.sendBespokeInvoice(
    o.recipient || { name: 'Echopoint Medical Ltd', email: 'pri@example.com', phone: '+44 7545 700837' },
    o.items || [{ description: 'Private hire journey — Pulborough to Hackney', amount: 250 }],
    {
      dueDate: '2026-09-09', issuedDate: '2026-08-26',
      journey: 'journey' in o ? o.journey : {
        ref: 'WPH-5012', date: '2026-08-26', time: '11:15',
        pickup: 'Pulborough, West Sussex', destination: '65-69 East Road, Hackney, London N1 6AH', flight: ''
      }
    },
    'INV-202608-0013', SETTINGS, 'pdf' in o ? o.pdf : FAKE_PDF);
  return captured[0];
}

console.log('\nIt is the branded email');

test('both invoice emails use the confirmation template, not a bare note', async () => {
  for (const sent of [await accountEmail(), await bespokeEmail()]) {
    assert.ok(/westmere-email-hero\.jpg/.test(sent.html), 'the hero image must be there, as on every other email');
    assert.ok(/WESTMERE<\/div>/.test(sent.html) || /WESTMERE/.test(sent.html), 'the wordmark header');
    assert.ok(/Private Hire &middot; Sussex/.test(sent.html), 'and the strapline');
    assert.ok(/Cormorant/.test(sent.html), 'set in the brand face');
    assert.ok(/With kind regards/.test(sent.html), 'and signed off the way a confirmation is');
  }
});

test('the invoice senders go through confirmationEmailHtml', () => {
  const acct = SRC.slice(SRC.indexOf('async function sendCustomerInvoice'), SRC.indexOf('async function sendBespokeInvoice'));
  assert.ok(/confirmationEmailHtml\(\{/.test(acct) && /variant: 'invoice'/.test(acct),
    'the account invoice must use the shared branded template');
  const besp = SRC.slice(SRC.indexOf('async function sendBespokeInvoice'));
  assert.ok(/confirmationEmailHtml\(\{/.test(besp) && /variant: 'invoice'/.test(besp),
    'and so must the bespoke one');
});

console.log('\nPayment method');

test('it says "Payment method — Invoice", on both shapes', async () => {
  for (const sent of [await accountEmail(), await bespokeEmail()]) {
    assert.ok(/PAYMENT\s*(<br\/?>)?\s*METHOD|Payment method/i.test(sent.html), 'the row label must be there');
    assert.ok(/Payment method<\/td>[\s\S]{0,400}?>Invoice</.test(sent.html),
      'the value must read Invoice — this booking is billed to an account, not paid by card or cash');
  }
});

test('nothing labels an invoiced booking as paid, or as cash', async () => {
  const sent = await bespokeEmail();
  assert.ok(!/Paid by card|cash to your driver|Pay your driver/i.test(sent.html),
    'an invoiced booking is none of those things');
});

console.log('\nNo way to pay online');

test('there is no pay link, no cash link and no cancel link', async () => {
  for (const sent of [await accountEmail(), await bespokeEmail()]) {
    assert.ok(!/westmere-pay\.html/.test(sent.html), 'no Pay Now link');
    assert.ok(!/\/api\/public\/pay\//.test(sent.html), 'no pay-driver link');
    assert.ok(!/\/api\/public\/cancel\//.test(sent.html), 'no cancel link');
    assert.ok(!/Pay Now|Apple Pay|Google Pay/i.test(sent.html), 'and no payment button label');
  }
});

test('the template refuses pay buttons on an invoice even WITH a token', () => {
  /* Belt and braces. The call sites pass no pay_token, but the gate is on the
     variant too, so a token arriving from anywhere cannot put a Pay Now button
     in front of somebody who has already been invoiced. */
  const gate = /if \(d\.pay_token && !d\.noActions[^)]*\)/.exec(SRC);
  assert.ok(gate, 'the pay-block gate is missing');
  assert.ok(/variant !== 'invoice'/.test(gate[0]),
    "the gate must exclude the invoice variant, not rely on the caller withholding a token");
});

console.log('\nThe attachment');

test('the PDF reaches the mailer as a real attachment', async () => {
  for (const sent of [await accountEmail(), await bespokeEmail()]) {
    const att = (sent.opts && sent.opts.attachments) || [];
    assert.strictEqual(att.length, 1, 'exactly one attachment');
    assert.ok(/\.pdf$/.test(att[0].filename), 'named as a PDF: ' + att[0].filename);
    const buf = Buffer.from(att[0].content, 'base64');
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-',
      'the attachment must BE a PDF — base64 of something else would sail through a filename check');
  }
});

test('the mailer actually forwards attachments to Resend', () => {
  assert.ok(/payload\.attachments = opts\.attachments/.test(SRC),
    'sendEmail must put them on the Resend payload, or they are assembled and dropped');
});

test('with no PDF, the email stops saying one is attached', async () => {
  const sent = await bespokeEmail({ pdf: null });
  assert.ok(!((sent.opts && sent.opts.attachments) || []).length, 'nothing to attach');
  assert.ok(!/find your invoice attached/i.test(sent.html),
    'an email with nothing attached must not tell the customer to look for a file');
  assert.ok(/This is your invoice/.test(sent.html), 'it must still be a usable email');
});

console.log('\nWhat the email shows');

test('a bespoke invoice raised from a job shows the real trip', async () => {
  const sent = await bespokeEmail();
  assert.ok(/WPH-5012/.test(sent.html), 'the booking reference');
  assert.ok(/Pulborough/.test(sent.html), 'the pickup');
  assert.ok(/Hackney/.test(sent.html), 'the destination');
  assert.ok(/26 August 2026/.test(sent.html) && /11:15/.test(sent.html), 'the date and time');
  assert.ok(/&pound;250\.00|£250\.00/.test(sent.html), 'and the fare');
});

test('the journey survives the route that carries it', () => {
  const api = read('server/api.js');
  assert.ok(/const cleanJourney = \(journey && typeof journey === 'object'\)/.test(api),
    'the bespoke route must accept an optional journey');
  assert.ok(/journey: journeyForEmail/.test(api), 'and pass it to the email');
  /* Scoped to the block itself. api.js validates YYYY-MM-DD in several other
     places, so testing the whole file for that pattern proved nothing about
     THIS field — it passed happily with the validation removed. */
  const jb = /const cleanJourney = [\s\S]*?\n  \} : null;/.exec(api);
  assert.ok(jb, 'the cleanJourney block is missing');
  assert.ok(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(jb[0]),
    'the date must be validated as a wall-clock string, not trusted from the page');
  assert.ok(/\.slice\(0, \d+\)/.test(jb[0]),
    'and every free-text field bounded — this body comes from a page and ends up in an email');
  const owner = read('westmere-owner.html');
  // Anchored: "xjourney:" contains "journey:", and a renamed key sailed past
  // the unanchored version of this assertion.
  assert.ok(/[^A-Za-z]journey:\{ref:j\.ref/.test(owner),
    '"Create Invoice" on a job card must send the journey it already has');
});

test('a bespoke invoice typed by hand falls back to its descriptions', async () => {
  const sent = await bespokeEmail({ journey: null });
  assert.ok(/Pulborough to Hackney/.test(sent.html),
    'with no structured journey the line item is all there is, and it must still be shown');
  assert.ok(/Journey<\/td>/.test(sent.html), 'labelled as the journey');
});

test('an account invoice summarises rather than repeating the PDF', async () => {
  const sent = await accountEmail();
  assert.ok(/August 2026/.test(sent.html), 'the period');
  assert.ok(/2 journeys/.test(sent.html), 'how many journeys');
  assert.ok(/&pound;115\.00|£115\.00/.test(sent.html), 'and the total');
  assert.ok(!/WPH-4871/.test(sent.html),
    'but NOT the itemised list — that is the attached invoice\'s job, and a twenty-row table in an email is a worse copy of it');
});

test('the terms are derived from the dates, not assumed to be 14 days', async () => {
  const { email, captured } = loadEmailModule();
  await email.sendBespokeInvoice(
    { name: 'Acme Ltd', email: 'a@b.co' }, [{ description: 'Journey', amount: 100 }],
    { issuedDate: '2026-08-26', dueDate: '2026-09-25' }, 'INV-1', SETTINGS, FAKE_PDF);
  assert.ok(/within 30 days/.test(captured[0].html),
    'a 30-day invoice must not be described as 14 — the owner sets the terms per invoice');
});

console.log('\nWho it is addressed to');

test('a company is addressed as it trades, never "Dear The,"', async () => {
  const acct = await accountEmail();
  assert.ok(/Dear The Grand Hotel Brighton,/.test(acct.html),
    'an account invoice to a hotel used to open "Dear The,"');
  const besp = await bespokeEmail();
  assert.ok(/Dear Echopoint Medical Ltd,/.test(besp.html), 'and a Ltd is addressed in full');
});

test('a person is still greeted as a person', async () => {
  const sent = await bespokeEmail({ recipient: { name: 'Mr Ben Chan', email: 'ben@example.com' } });
  assert.ok(/Dear Mr Chan,/.test(sent.html),
    'the company rule must not swallow the ordinary case');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-email\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
