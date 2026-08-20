/**
 * THE POST-TRIP REVIEW REQUEST — run with:
 *   node server/tests/review-links.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The email that goes out after a completed trip used to offer one place to
 *   leave a review. A customer who has a Trustpilot account and no Google one
 *   simply did not review — the ask was fine, the destination was wrong for
 *   them. It now offers both, and the thing that must not rot is that BOTH
 *   survive, both point at Westmere's own profiles, and neither arrives
 *   wearing a brand colour.
 *
 *   The Google link is the business's own profile CID. reviews.js puts the
 *   same link on the website, and payment-flow.test.js already pins the two
 *   together — so this file checks the pair, not the CID again.
 *
 * Renders the SHIPPED template through the SHIPPED sender with Resend stubbed.
 * Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.RESEND_API_KEY = 'test_fake';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('server/email.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

let HTML = '', SENT = null;
global.fetch = async (u, o) => { SENT = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };

console.log('\nThe post-trip review request offers both platforms');

test('it renders, and it is the real template', async () => {
  delete require.cache[require.resolve('../email')];
  const EMAIL = require('../email');
  const ok = await EMAIL.sendReviewRequest('a@b.c', 'Eleanor', 'WPH-REV1');
  assert.ok(ok, 'the review request did not send');
  HTML = SENT.html;
  assert.ok(HTML.length > 2000, 'the email rendered empty');
  assert.ok(/WESTMERE/.test(HTML) && /wm-pad/.test(HTML), 'it is no longer the branded hero template');
});

test('both review buttons are there, labelled for the platform', async () => {
  assert.ok(/Review us on Google/.test(HTML), 'the Google button is missing');
  assert.ok(/Review us on Trustpilot/.test(HTML), 'the Trustpilot button is missing');
});

test('they point at Westmere\'s own profiles', () => {
  assert.ok(/g\.page\/r\/Ce764VxFTR4VEAE\/review/.test(HTML),
    'the Google link is not the business profile — it must match the one reviews.js uses');
  assert.ok(/uk\.trustpilot\.com\/evaluate\/westmereprivatehire\.co\.uk/.test(HTML),
    'the Trustpilot link must be the /evaluate/ write-a-review form on the UK domain');
  // /evaluate/ opens the form; /review/ is the profile page, where the customer
  // then has to hunt for the button. The ask should cost one click.
  assert.ok(!/trustpilot\.com\/review\/[^"]*"[^>]*>\s*Review us on Trustpilot/.test(HTML),
    'the Trustpilot button points at the profile page rather than the review form');
});

test('the destinations are declared once, not inlined per use', () => {
  assert.ok(/const GOOGLE_REVIEW_LINK\s*=/.test(SRC), 'the Google link is not a named constant');
  assert.ok(/const TRUSTPILOT_REVIEW_LINK\s*=/.test(SRC), 'the Trustpilot link is not a named constant');
});

test('both are framed emailBtn buttons — no fill, no gold, and green ONLY on Trustpilot', () => {
  /* OWNER-APPROVED EXCEPTION: the Trustpilot button keeps Trustpilot's green,
     because a customer scanning an inbox finds the green mark faster than a
     navy one. Nothing else in this email may wear a brand colour — gold, the
     WhatsApp green and Instagram pink all still fail, and the green itself is
     allowed only on the Trustpilot CTA. */
  const BANNED = /#b78635|#c9a227|#d4af37|#25D366|#2D6E47|#e1306c|goldenrod/i;
  assert.ok(!BANNED.test(HTML), 'a brand or gold colour is in the review email');
  // The green appears, and only inside the Trustpilot button.
  assert.ok(/#00B67A/i.test(HTML), 'the Trustpilot button lost its brand green');
  const tpBtn = /<td[^>]*>[\s\S]{0,900}?Review us on Trustpilot[\s\S]{0,60}?<\/a>/.exec(HTML);
  assert.ok(tpBtn, 'could not isolate the Trustpilot button');
  const withoutTp = HTML.split('#00B67A').length - 1;
  const insideTp = (tpBtn[0].match(/#00B67A/gi) || []).length;
  assert.ok(insideTp >= 1, 'the green is not on the Trustpilot button itself');
  // The Google button must stay navy — the exception is one platform, not "any CTA".
  const gBtn = /<td[^>]*>[\s\S]{0,900}?Review us on Google[\s\S]{0,60}?<\/a>/.exec(HTML);
  assert.ok(gBtn && !/#00B67A/i.test(gBtn[0]),
    'the Google button has taken Trustpilot green — the exception is per-platform');
  assert.ok(withoutTp <= 6, 'the green has spread beyond the Trustpilot button (' + withoutTp + ' occurrences)');
  // The CTAs must come through emailBtn — the VML frame is only ever emitted there.
  assert.ok(/v:roundrect/.test(HTML), 'the buttons did not come through emailBtn (no Outlook frame)');
  assert.ok(/fillcolor="#ffffff"/.test(HTML), 'the Outlook frame is filled rather than outlined');
  for (const m of HTML.matchAll(/<td[^>]*style="([^"]*border:\d+px solid[^"]*)"[^>]*>\s*<a\b/g)) {
    assert.ok(/background-color:#ffffff/i.test(m[1]), 'a button cell is filled: ' + m[1].slice(0, 80));
  }
  for (const m of HTML.matchAll(/<a\b[^>]*style="([^"]*)"/g)) {
    const bg = /background(?:-color)?:\s*([^;"]+)/i.exec(m[1]);
    if (bg) assert.ok(/^(transparent|none|#fff|#ffffff|white)$/i.test(bg[1].trim()), 'a filled link: ' + bg[1]);
  }
});

test('the copy tells them either will do', () => {
  const text = HTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(/Google/.test(text) && /Trustpilot/.test(text), 'the body copy names neither platform');
  assert.ok(/whichever you already use|either/i.test(text),
    'the copy does not say that either platform is fine — which is the whole point of offering two');
});

test('the greeting fix still holds here', async () => {
  delete require.cache[require.resolve('../email')];
  const EMAIL = require('../email');
  await EMAIL.sendReviewRequest('a@b.c', 'Mr J Whitfield', 'WPH-REV2');
  assert.ok(!/Dear Mr,/.test(SENT.html), '"Dear Mr," is back in the review request');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/review-links\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
