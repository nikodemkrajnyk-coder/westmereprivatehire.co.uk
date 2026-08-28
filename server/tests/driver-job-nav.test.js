/**
 * WAZE AND THE CALENDAR ON THE DRIVER JOB EMAILS —
 *   node server/tests/driver-job-nav.test.js   (also gated by `npm test`)
 *
 * Both driver-facing job emails — the registered offer and the ad-hoc one —
 * carry the same two affordances, and both are easy to get subtly wrong.
 *
 *   THE WAZE LINK MUST USE THE FULL ADDRESS. dispAddr() shortens an address for
 *   reading: "The Grand Hotel, Kings Road, Brighton BN1 2FW" is displayed as
 *   "The Grand Hotel, BN1 2FW". That is right on the page and wrong in a
 *   navigation link, where the street and postcode are the part that gets you
 *   there. The displayed text stays short; the link carries the whole thing.
 *
 *   THE CALENDAR ENTRY MUST BE THE RIGHT HOUR. bookings.date and bookings.time
 *   are UK WALL-CLOCK strings, and an .ics needs an instant. A 05:30 pickup in
 *   September is 04:30Z and in January it is 05:30Z; getting that wrong sends a
 *   driver an hour late in summer, which is the whole job. The offset is
 *   MEASURED for the date rather than assumed.
 *
 *   AND 'ASAP' IS NOT A TIME. `date + 'T' + time` on an ASAP booking is an
 *   Invalid Date — that has shipped here before and put "Invalid Date" into
 *   every ASAP booking's emails. An ASAP job becomes an all-day entry.
 *
 * Renders the REAL emails with the mailer intercepted. Nothing is sent.
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

function load() {
  const p = path.join(ROOT, 'server', 'email.js');
  const src = fs.readFileSync(p, 'utf8').replace('async function sendEmail(',
    'async function sendEmail(a,b,c,d,e,f){global.__N.push({to:a,subject:b,html:c,opts:f});return 1;}\nasync function __r(')
    + '\nmodule.exports.__t = { wazeUrl, londonToUtc, icsForJob, googleCalUrl };';
  assert.ok(src.indexOf('__r') !== -1, 'mailer interception failed — refusing to run');
  global.__N = [];
  const m = new Module(p, null); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  return { email: m.exports, sent: global.__N };
}

const JOB = {
  ref: 'WPH-7001',
  pickup: 'The Grand Hotel, Kings Road, Brighton BN1 2FW',
  destination: 'London Gatwick Airport, South Terminal',
  stop_address: 'Lewes Station, Station Road, Lewes BN7 2UP',
  date: '2026-09-14', time: '05:30',
  fare: 75, driver_pay: 67.5, admin_fee: 7.5,
  passengers: 3, bags: '2 large, 1 cabin', flight: 'BA2751',
  notes: 'Front door pickup.',
  customer_name: "Gavin O'Shea", customer_phone: '07700 900456',
  offer_token: 'k'.repeat(32)
};
const BOTH = [
  ['ad-hoc',     'sendAdhocJobOffer',  { driver_name: 'Sam Cole',    driver_email: 'sam@example.com' }],
  ['registered', 'sendDriverJobOffer', { driver_name: 'Dave Driver', driver_email: 'dave@example.com' }]
];
async function render(fn, extra, over) {
  const { email, sent } = load();
  await email[fn](Object.assign({}, JOB, extra, over || {}));
  return sent[0];
}

console.log('\nWaze, on every address, in both emails');

for (const [label, fn, who] of BOTH) {
  test(label + ': all three addresses are navigable', async () => {
    const s = await render(fn, who);
    const links = (s.html.match(/https:\/\/waze\.com\/ul\?q=[^"&]*/g) || [])
      .map(u => decodeURIComponent(u.replace('https://waze.com/ul?q=', '')));
    assert.strictEqual(links.length, 3, 'pickup, stop and drop-off — got ' + links.length);
    assert.ok(links.indexOf(JOB.pickup) !== -1, 'pickup link is not the pickup: ' + links[0]);
    assert.ok(links.indexOf(JOB.stop_address) !== -1, 'stop link is wrong');
    assert.ok(links.indexOf(JOB.destination) !== -1, 'drop-off link is wrong');
    assert.ok(/Navigate with Waze/.test(s.html), 'and each must be labelled');
  });

  test(label + ': the link carries the FULL address, not the shortened one', async () => {
    /* The displayed text is "The Grand Hotel, BN1 2FW". Navigating to that
       loses the street. */
    const s = await render(fn, who);
    assert.ok(/waze\.com\/ul\?q=The%20Grand%20Hotel%2C%20Kings%20Road/.test(s.html),
      'the Waze link must contain "Kings Road" — the part dispAddr drops');
    assert.ok(/The Grand Hotel, BN1 2FW/.test(s.html),
      'while the READ address stays short');
  });

  test(label + ': a job with no stop has exactly two links', async () => {
    const s = await render(fn, who, { stop_address: null });
    const links = (s.html.match(/https:\/\/waze\.com\/ul\?q=/g) || []);
    assert.strictEqual(links.length, 2, 'no phantom stop');
  });
}

test('coordinates are preferred when a booking ever carries them', async () => {
  const { email } = load();
  const w = email.__t.wazeUrl;
  assert.ok(/ll=50\.8225%2C-0\.1372/.test(w('ignored', 50.8225, -0.1372)),
    'lat/lng must win over the string');
  assert.ok(/\?q=/.test(w('Somewhere', null, null)), 'and the address is the fallback');
  assert.strictEqual(w('', null, null), '', 'a blank address gets no link at all');
  assert.ok(/navigate=yes/.test(w('Somewhere')), 'and the link should start navigating');
});

test('an address with & and ? survives encoding', async () => {
  const s = await render('sendAdhocJobOffer', BOTH[0][2], { pickup: 'Marks & Spencer, Church Rd?' });
  const m = /https:\/\/waze\.com\/ul\?q=([^"&]*)/.exec(s.html);
  assert.strictEqual(decodeURIComponent(m[1]), 'Marks & Spencer, Church Rd?',
    'the query must round-trip exactly');
});

console.log('\nThe calendar entry');

for (const [label, fn, who] of BOTH) {
  test(label + ': an .ics is attached, and it is a calendar file', async () => {
    const s = await render(fn, who);
    const att = (s.opts && s.opts.attachments) || [];
    assert.strictEqual(att.length, 1, 'exactly one attachment');
    assert.strictEqual(att[0].filename, 'WPH-7001.ics');
    assert.ok(/^text\/calendar/.test(att[0].content_type || ''), 'declared as text/calendar');
    const ics = Buffer.from(att[0].content, 'base64').toString();
    assert.ok(/^BEGIN:VCALENDAR/.test(ics) && /END:VCALENDAR/.test(ics.trim()), 'a real VCALENDAR');
    assert.ok(/BEGIN:VEVENT/.test(ics) && /UID:/.test(ics) && /DTSTAMP:/.test(ics));
  });

  test(label + ': the start time is the pickup, in the right hour', async () => {
    const s = await render(fn, who);
    const ics = Buffer.from(s.opts.attachments[0].content, 'base64').toString();
    // 05:30 on 14 Sep 2026 is BST — one hour ahead of UTC.
    assert.ok(/DTSTART:20260914T043000Z/.test(ics),
      'expected 04:30Z for an 05:30 BST pickup, got ' + (/DTSTART[^\r\n]*/.exec(ics) || [''])[0]);
  });

  test(label + ': the entry says what the job is and where it starts', async () => {
    const s = await render(fn, who);
    const ics = Buffer.from(s.opts.attachments[0].content, 'base64').toString();
    assert.ok(/SUMMARY:Westmere job —/.test(ics), 'titled as a Westmere job');
    assert.ok(/SUMMARY:[^\r\n]*Gatwick/.test(ics), 'naming where it goes');
    assert.ok(/LOCATION:The Grand Hotel\\, Kings Road/.test(ics),
      'the location is the FULL pickup address, escaped');
    assert.ok(/DESCRIPTION:[^\r\n]*WPH-7001/.test(ics), 'and carries the reference');
  });

  test(label + ': there is an add-to-calendar line the driver can see', async () => {
    const s = await render(fn, who);
    assert.ok(/Add to calendar/i.test(s.html), 'the block must be visible');
    assert.ok(/WPH-7001\.ics/.test(s.html), 'naming the file that is attached');
    assert.ok(/calendar\.google\.com\/calendar\/render\?/.test(s.html),
      'and a Google link, because an .ics in Gmail on Android is a download-then-open dance');
  });
}

test('GMT in winter, BST in summer — the offset is measured, not assumed', async () => {
  const { email } = load();
  const L = email.__t.londonToUtc;
  assert.strictEqual(L('2026-01-14', '05:30').toISOString(), '2026-01-14T05:30:00.000Z', 'January is GMT');
  assert.strictEqual(L('2026-09-14', '05:30').toISOString(), '2026-09-14T04:30:00.000Z', 'September is BST');
  assert.strictEqual(L('2026-06-21', '23:00').toISOString(), '2026-06-21T22:00:00.000Z', 'midsummer');
});

test("an ASAP job becomes an all-day entry, never an Invalid Date", async () => {
  const s = await render('sendAdhocJobOffer', BOTH[0][2], { time: 'ASAP' });
  const ics = Buffer.from(s.opts.attachments[0].content, 'base64').toString();
  assert.ok(/DTSTART;VALUE=DATE:20260914/.test(ics), 'all-day, for the right day');
  assert.ok(/DTEND;VALUE=DATE:20260915/.test(ics), 'and DTEND is the next day — it is exclusive');
  assert.ok(!/Invalid Date|NaN/.test(ics), 'nothing broken may reach a calendar');
  assert.ok(!/Invalid Date|NaN/.test(s.html), 'nor the email');
  assert.ok(/all-day entry, because this one is ASAP/.test(s.html), 'and the driver is told why');
});

test('a job with no usable date gets no attachment rather than a broken one', async () => {
  const s = await render('sendAdhocJobOffer', BOTH[0][2], { date: '', time: '' });
  const att = (s.opts && s.opts.attachments) || [];
  assert.strictEqual(att.length, 0, 'better no calendar file than an invalid one');
  assert.ok(!/Invalid Date|NaN/.test(s.html));
});

console.log('\nNothing else moved');

test('the fare split is untouched on both paths', async () => {
  const a = await render('sendAdhocJobOffer', BOTH[0][2]);
  assert.ok(/£75\.00|&pound;75\.00/.test(a.html) && !/commission/i.test(a.html),
    'the ad-hoc email still shows the full fare and no commission');
  const r = await render('sendDriverJobOffer', BOTH[1][2]);
  assert.ok(/£67\.50|&pound;67\.50/.test(r.html) && /commission/i.test(r.html),
    'the registered email still shows pay after commission');
});

test('accept and decline are still there, still tokenised', async () => {
  for (const [, fn, who] of BOTH) {
    const s = await render(fn, who);
    assert.ok(/\/offer\/WPH-7001\/accept\?t=/.test(s.html) && /\/offer\/WPH-7001\/decline\?t=/.test(s.html),
      fn + ': both actions must survive');
  }
});

test('the helpers are shared, not copied into each email', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual((code.match(/function wazeUrl\(/g) || []).length, 1, 'one wazeUrl');
  assert.strictEqual((code.match(/function icsForJob\(/g) || []).length, 1, 'one icsForJob');
  assert.strictEqual((code.match(/function navAddrRow\(/g) || []).length, 1, 'one navAddrRow');
  assert.ok(/londonToUtc/.test(code), 'and the timezone conversion is not inlined twice');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/driver-job-nav\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
