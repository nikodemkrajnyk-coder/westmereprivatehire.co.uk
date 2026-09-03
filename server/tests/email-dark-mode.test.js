/**
 * A CUSTOMER EMAIL CANNOT TURN INTO A BLACK SCREEN — run with:
 *   node server/tests/email-dark-mode.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   A customer photographed his booking acknowledgement: navy type on a near
 *   black card, unreadable. Nothing was wrong with the colours as written —
 *   #102a43 on #FFFFFF measures 14:1. The fault was what was NOT written.
 *
 *   Every word in these emails sat on a background it INHERITED. The shell
 *   painted its cells white; the paragraphs, headings and detail rows inside
 *   them declared a text colour and no background at all. A browser inherits,
 *   so it looked right in every preview. A mail client's dark mode recolours
 *   ELEMENT BY ELEMENT: it darkens the cell it is looking at and leaves an
 *   explicitly-declared `color` alone. Declared navy ink, newly dark paper.
 *
 *   Thirty-five such elements on the acknowledgement, forty-eight on the
 *   confirmation, sixty-one on the booking-updated. Not one declared both.
 *
 * WHAT IS GUARDED
 *   1. NO ELEMENT DECLARES INK WITHOUT PAPER, on any customer email. This is
 *      the fix; everything else is belt and braces.
 *   2. The contrast every element actually renders at, measured — in light
 *      mode, and under a dark client that does NOT inherit.
 *   3. paintBackgrounds() only ADDS backgrounds. If it ever alters a declared
 *      colour, the brand look has moved and this fails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.RESEND_API_KEY = 'test_fake';
process.env.SQLITE_DB = path.join(os.tmpdir(), 'wm-email-dark-' + process.pid + '.db');

const ROOT = path.join(__dirname, '..', '..');
const email = require('../email');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

let SENT = [];
global.fetch = async (u, o) => { SENT.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

// ── colour maths ─────────────────────────────────────────────────────────
function px(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  if (c === 'white') return [255, 255, 255];
  if (c === 'black') return [0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return null;
}
function lum(v) {
  const a = v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrast(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

/** Every element that declares a text colour, with what it declares. */
function inked(html) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>([^<]*)/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2] || '';
    const style = (/style\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || '';
    const colorM = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
    if (!colorM) continue;
    const bgM = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
    const sizeM = /font-size\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style);
    const weightM = /font-weight\s*:\s*(\d+|bold)/i.exec(style);
    out.push({
      tag: m[1].toLowerCase(),
      text: (m[3] || '').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, 'x').trim(),
      fg: px(colorM[1]),
      bg: bgM ? px(bgM[1].trim().split(/\s+/)[0]) : null,
      bgAttr: /bgcolor\s*=/i.test(attrs),
      size: sizeM ? parseFloat(sizeM[1]) : 16,
      bold: weightM ? (weightM[1] === 'bold' || +weightM[1] >= 600) : false,
      hidden: /display\s*:\s*none/i.test(style),
      style
    });
  }
  return out;
}

/* THE ONE DELIBERATE EXCEPTION. Trustpilot's brand green on white, on the
   review-request button — owner-approved, documented at EMAIL_BTN.trustpilot,
   and the only third-party colour in the file. It is listed here rather than
   silently skipped so that the exception is visible and countable, and so a
   SECOND one cannot appear without somebody adding it on purpose. */
const BRAND_EXCEPTIONS = ['#00B67A'];
const isException = (t) => t.fg && BRAND_EXCEPTIONS.some((h) => {
  const e = px(h); return e && e[0] === t.fg[0] && e[1] === t.fg[1] && e[2] === t.fg[2];
});

// ── the emails a customer receives ───────────────────────────────────────
const B = {
  ref: 'WPH-TEST01', name: 'Ben Carter', email: 'ben@example.com',
  pickup: '12 Cissbury Road, Worthing BN14 9LB',
  destination: 'London Gatwick Airport, South Terminal',
  date: '2026-09-18', time: '09:15', passengers: 2, bags: 2, flight: 'BA2751',
  estimated_fare: 78, fare: 78, payment: 'pending', pay_token: 'tok123'
};
const CUSTOMER_EMAILS = [
  ['acknowledgement', () => email.sendCustomerAcknowledgement(B)],
  ['estimate', () => email.sendCustomerEstimate(Object.assign({}, B, { fare: 78 }))],
  ['confirmation', () => email.sendCustomerConfirmed(Object.assign({}, B, { payment: 'card', paid: true }))],
  ['journey reminder', () => email.sendCustomerJourneyReminder(Object.assign({}, B,
    { driver_name: 'Nikodem', driver_vehicle: 'Tesla Model 3', driver_reg: 'ML68 YHC' }))],
  ['booking updated', () => email.sendCustomerBookingUpdated(B, [{ key: 'time', from: '09:15', to: '10:00' }])],
  ['cancellation', () => email.sendCustomerCancellation(B)],
  ['welcome', () => email.sendCustomerWelcome({ full_name: 'Ben Carter', email: 'ben@example.com' })],
  ['review request', () => email.sendReviewRequest('ben@example.com', 'Ben', 'WPH-TEST01')],
  ['payment reminder', () => email.sendPaymentReminder(Object.assign({}, B, { fare: 78 }))],
  ['invoice reminder', () => email.sendInvoiceReminder({ name: 'APD', email: 'a@e.com' }, 'INV-1', 616.5, 'https://x', 'tok')]
];
const RENDERED = {};
async function renderAll() {
  for (const [name, send] of CUSTOMER_EMAILS) {
    SENT = [];
    await send();
    assert.ok(SENT.length, name + ' sent nothing — the fixture is wrong, not the email');
    RENDERED[name] = SENT[SENT.length - 1].html;
  }
}

// ── 1. INK ALWAYS COMES WITH PAPER ───────────────────────────────────────
console.log('\nEvery element states the background it is standing on');

for (const [name] of CUSTOMER_EMAILS) {
  test(name + ': no element declares a colour without a background', () => {
    const bare = inked(RENDERED[name]).filter((t) => !t.bg && !t.bgAttr);
    assert.strictEqual(bare.length, 0,
      bare.length + ' element(s) declare ink and no paper — a dark-mode client will darken '
      + 'the cell and keep the text colour. First: <' + (bare[0] || {}).tag + ' style="'
      + ((bare[0] || {}).style || '').slice(0, 90) + '">');
  });
}

// ── 2. WHAT IT ACTUALLY MEASURES ─────────────────────────────────────────
console.log('\nEvery word is readable on the cell it is actually on');

for (const [name] of CUSTOMER_EMAILS) {
  test(name + ': light mode — every visible text passes AA', () => {
    const bad = inked(RENDERED[name])
      .filter((t) => t.text && t.fg && t.bg && !t.hidden && !isException(t))
      .map((t) => Object.assign(t, { ratio: contrast(t.fg, t.bg),
                                     min: (t.size >= 24 || (t.size >= 18.66 && t.bold)) ? 3 : 4.5 }))
      .filter((t) => t.ratio < t.min);
    assert.strictEqual(bad.length, 0,
      bad.map((t) => t.ratio + ':1 (needs ' + t.min + ') "' + t.text.slice(0, 40) + '"').join('; '));
  });

  test(name + ': a dark client that does not inherit still reads', () => {
    /* THE PESSIMISTIC CLIENT. It recolours element by element and gives its own
       near-black to anything that has not stated a background. Every text below
       states one, so the client has nothing to darken — which is the whole
       point of the fix. */
    const DARK = [28, 28, 30];
    const bad = inked(RENDERED[name])
      .filter((t) => t.text && t.fg && !t.hidden && !isException(t))
      .map((t) => Object.assign(t, { ratio: contrast(t.fg, t.bg || DARK) }))
      .filter((t) => t.ratio < 4.5);
    assert.strictEqual(bad.length, 0,
      bad.map((t) => t.ratio + ':1 "' + t.text.slice(0, 40) + '"').join('; '));
  });
}

// ── 3. THE LOOK DID NOT MOVE ─────────────────────────────────────────────
console.log('\nStating the background changed nothing about how it looks');

test('paintBackgrounds only ADDS backgrounds — it never repaints the ink', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/email.js'), 'utf8');
  const i = src.indexOf('function paintBackgrounds(');
  assert.ok(i !== -1, 'paintBackgrounds is gone — the emails are back to inheriting');
  const body = src.slice(i, src.indexOf('\nasync function sendEmail', i));
  assert.ok(!/color\s*:\s*['"`]#/.test(body.replace(/background-color/g, '')),
    'the pass must not write a text colour of its own');
  assert.ok(/background-color:'\s*\+\s*inherited/.test(body),
    'the background written must be the INHERITED one, or the design has moved');
});

test('the pass is run on known markup and does exactly one thing', () => {
  /* RUN, not inspected. Comparing the pass's output with its own output proves
     nothing — the first version of this test did that and a mutation that
     repainted every #102a43 walked straight through it. */
  const paint = email.paintBackgrounds;
  assert.strictEqual(typeof paint, 'function', 'paintBackgrounds is not exported');

  const before = '<table bgcolor="#FFFFFF"><tr><td style="background:#FFFFFF">'
    + '<p style="color:#102a43;font-size:17px">Dear Ben,</p>'
    + '<span style="color:#657485">Reference</span></td></tr></table>';
  const after = paint(before);
  assert.ok(/color:#102a43;font-size:17px;background-color:#FFFFFF/.test(after),
    'the paragraph did not get the white it was standing on: ' + after);
  assert.ok(/color:#657485;background-color:#FFFFFF/.test(after),
    'the span did not get one either');
  /* THE INK IS UNTOUCHED. Every colour that went in comes out, unchanged. */
  assert.deepStrictEqual(
    (after.match(/(?<!background-)color:\s*(#[0-9a-fA-F]{3,6})/g) || []).sort(),
    (before.match(/(?<!background-)color:\s*(#[0-9a-fA-F]{3,6})/g) || []).sort(),
    'the pass changed a text colour — the brand look has moved');

  /* IT PAINTS THE INHERITED COLOUR, not a favourite one. On the page tint
     outside the card, the tint is what must be written. */
  const onTint = paint('<td style="background:#EEF2F5"><p style="color:#657485">x</p></td>');
  assert.ok(/color:#657485;background-color:#EEF2F5/.test(onTint),
    'an element outside the card must keep the page tint, not turn white: ' + onTint);

  /* AN ELEMENT THAT ALREADY STATES ONE IS LEFT ALONE. */
  const already = paint('<td style="background:#FFFFFF"><p style="color:#102a43;background-color:#EEF2F5">x</p></td>');
  assert.strictEqual((already.match(/background-color/g) || []).length, 1,
    'the pass double-painted an element that already had a background');

  /* AND OUTLOOK'S VML IS NOT REWRITTEN. */
  const mso = paint('<td style="background:#FFFFFF"><!--[if mso]><v:roundrect fillcolor="#ffffff">'
    + '<center style="color:#102a43">Pay Now</center></v:roundrect><![endif]--></td>');
  assert.ok(/<center style="color:#102a43">/.test(mso),
    'the conditional comment was rewritten — Outlook\'s button lives in there');
});

// ── 4. AND THE CLIENT IS ASKED NICELY TOO ────────────────────────────────
console.log('\nThe shell also asks the client not to recolour it');

test('the shell carries the colour-scheme opt-outs and the dark overrides', () => {
  const html = RENDERED['acknowledgement'];
  assert.ok(/<meta name="color-scheme" content="light only">/.test(html), 'no color-scheme meta');
  assert.ok(/<meta name="supported-color-schemes" content="light only">/.test(html),
    'no supported-color-schemes meta');
  assert.ok(/color-scheme:light only/.test(html), 'no :root color-scheme');
  /* Gmail ignores all three, which is why the paint pass exists — but Apple
     Mail and Outlook.com read these, and without them they invert. */
  assert.ok(/@media \(prefers-color-scheme: dark\)/.test(html), 'no dark-mode media query');
  /* All four Outlook.com rules, not just the presence of the attribute
     somewhere — dropping the body rule alone still left the selector in the
     file and the first version of this assertion did not notice. */
  for (const sel of ['[data-ogsc] body', '[data-ogsc] .wm-card', '[data-ogsc] .wm-ink', '[data-ogsc] .wm-muted']) {
    assert.ok(html.indexOf(sel) !== -1, 'no Outlook.com override for ' + sel);
  }
  for (const sel of ['[data-ogsb] body', '[data-ogsb] .wm-card']) {
    assert.ok(html.indexOf(sel) !== -1, 'no Outlook.com override for ' + sel);
  }
  assert.ok(/<body[^>]*bgcolor="#EEF2F5"/.test(html), 'the body must state its own background');
});

test('the card and its cells state a background as an ATTRIBUTE too', () => {
  /* bgcolor survives clients that strip or rewrite inline CSS. */
  const html = RENDERED['acknowledgement'];
  assert.ok(/<table[^>]*class="wm-card"[^>]*bgcolor="#FFFFFF"/.test(html),
    'the letter card has no bgcolor attribute');
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  await renderAll();
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(process.env.SQLITE_DB); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
