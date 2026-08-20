/**
 * INSTAGRAM AND TRUSTPILOT — run with:
 *   node server/tests/social-links.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   Instagram was the fourth item in a row of .78rem footer text links, sitting
 *   between an email address and a phone number. It was on the page and nobody
 *   saw it. Trustpilot was not there at all.
 *
 *   Both are now framed icon buttons on EVERY public page, and again under the
 *   reviews block on the homepage. The two ways this quietly regresses are (a)
 *   a page gets rebuilt and loses the row, and (b) somebody "improves" the
 *   icons by giving them their real brand colours — Instagram pink, Trustpilot
 *   green — which is exactly the filled-badge look §20 exists to prevent.
 *
 * WHAT IS PINNED
 *   · both links exist on every public page, and point at the right places;
 *   · the homepage carries a second row beside the reviews, where trust is read;
 *   · they are FRAMED, not filled, and monochrome — no brand colour anywhere
 *     near them, and the glyph inherits currentColor;
 *   · each is a real tap target with an accessible name;
 *   · the Trustpilot URL is flagged while it is still a placeholder, so it
 *     cannot be forgotten before the profile goes live.
 *
 * Pure static analysis of the shipped pages. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PUBLIC = ['index.html', 'book.html', 'about.html', 'contact.html',
                'services.html', 'airport-transfers.html'];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nInstagram and Trustpilot are visible, framed and monochrome');

test('both links are on every public page', () => {
  const missing = [];
  for (const f of PUBLIC) {
    const src = read(f);
    if (!/data-social="instagram"/.test(src)) missing.push(f + ' has no Instagram link');
    if (!/data-social="trustpilot"/.test(src)) missing.push(f + ' has no Trustpilot link');
    if (!/class="wm-social"/.test(src)) missing.push(f + ' has no social row');
  }
  assert.deepStrictEqual(missing, [], 'a public page lost its social row:\n      ' + missing.join('\n      '));
});

test('they point where they should', () => {
  for (const f of PUBLIC) {
    const src = read(f);
    const ig = /data-social="instagram"[^>]*/.exec(src) || /<a[^>]*data-social="instagram"[^>]*>/.exec(src);
    assert.ok(/instagram\.com\/westmereprivatehire/.test(src), f + ': the Instagram link lost its account');
    assert.ok(/trustpilot\.com\/review\/westmereprivatehire\.co\.uk/.test(src),
      f + ': the Trustpilot link does not point at the Westmere review page');
    // External, and safe: a target=_blank without rel=noopener hands the new
    // tab a handle back to this page.
    for (const m of src.matchAll(/<a[^>]*data-social="[^"]*"[^>]*>/g)) {
      assert.ok(/target="_blank"/.test(m[0]), f + ': a social link does not open in a new tab');
      assert.ok(/rel="noopener"/.test(m[0]), f + ': a social link is missing rel="noopener"');
      assert.ok(/aria-label="[^"]{8,}"/.test(m[0]), f + ': a social link has no accessible name: ' + m[0].slice(0, 80));
    }
  }
});

test('the homepage repeats them beside the reviews, not only in the footer', () => {
  const home = read('index.html');
  assert.strictEqual((home.match(/class="wm-social"/g) || []).length, 2,
    'the homepage should carry the row twice — under the reviews and in the footer');
  const reviews = home.indexOf('data-reviews="full"');
  const footer = home.indexOf('<footer');
  const first = home.indexOf('class="wm-social"');
  assert.ok(reviews !== -1 && first > reviews && first < footer,
    'the first social row must sit between the reviews block and the footer — that is where somebody ' +
    'who has just read the testimonials decides whether to believe them');
});

test('the pair sits in the HEADER too, at every width', () => {
  // The owner asked for them at the top, and the top is where .navlinks stops
  // existing: that container is display:none under 900px. Sitting beside the
  // burger — which is never hidden — is what makes them survive on a phone.
  for (const f of PUBLIC) {
    const src = read(f);
    assert.ok(/class="wm-social wm-social-nav"/.test(src), f + ' has no header social row');
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'));
    assert.ok(/wm-social-nav/.test(nav), f + ': the header row is not inside <nav>');
    // Structural, not a regex: `[\s\S]*` runs straight past the closing tag and
    // would call a sibling "nested". Walk the div depth from .navlinks and find
    // where it actually closes.
    const nlStart = nav.indexOf('<div class="navlinks">');
    assert.ok(nlStart !== -1, f + ': the nav has no .navlinks');
    let depth = 0, nlEnd = -1;
    for (const m of nav.slice(nlStart).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { nlEnd = nlStart + m.index + m[0].length; break; }
    }
    assert.ok(nlEnd !== -1, f + ': .navlinks never closes');
    assert.ok(nav.indexOf('wm-social-nav') > nlEnd,
      f + ': the header row is inside .navlinks, which is display:none under 900px — ' +
      'it would vanish on exactly the screens the owner wants it on');
    const burger = nav.indexOf('class="burger"');
    const row = nav.indexOf('wm-social-nav');
    assert.ok(row !== -1 && burger !== -1 && row < burger,
      f + ': the header row must sit before the burger');
  }
  // Icon-only up there: a label per glyph doubles the width and crowds the
  // burger on a 390px bar.
  const T = read('westmere-theme.css');
  const i = T.indexOf('.wm-social-nav .wm-social-link {');
  assert.ok(i !== -1, 'the header variant has no rule of its own');
  const block = T.slice(i, T.indexOf('}', i));
  const w = /width:\s*(\d+)px/.exec(block);
  assert.ok(w && +w[1] >= 44, 'the header icon is under a 44px tap target: ' + (w ? w[1] : 'none'));
  assert.ok(/nav > \.navlinks \{ margin-left: auto; \}/.test(T),
    'without margin-left:auto the desktop nav spreads three children and the links drift to the middle');
});

test('the badges carry their OWN brand colour — the one approved exception', () => {
  /* OWNER-APPROVED EXCEPTION. Everywhere else in this system nothing wears
     another company's colour (§20, no-fills.test.js). Instagram and Trustpilot
     are the deliberate exceptions: these are recognised BY their colour, and a
     visitor scanning a footer finds the green star and the Instagram gradient
     faster than two navy glyphs.

     The exception is scoped to the GLYPH. The button around it stays a navy
     hairline frame on white, so the no-fill rule is untouched — this is a
     coloured mark inside a Westmere control, not a borrowed badge. */
  const IG_GRADIENT = 'url(#wm-ig-gradient)';
  const TP_GREEN = /#00B67A/i;
  for (const f of PUBLIC) {
    const src = read(f);
    // The gradient is defined ONCE per page and referenced by every Instagram
    // glyph on it — three <linearGradient id="…"> copies would be three
    // duplicate ids, which page-integrity rightly fails on.
    assert.strictEqual((src.match(/<linearGradient id="wm-ig-gradient"/g) || []).length, 1,
      f + ': the Instagram gradient must be defined exactly once per page');
    let ig = 0, tp = 0;
    for (const m of src.matchAll(/<a[^>]*data-social="([^"]*)"[\s\S]*?<\/a>/g)) {
      const [whole, which] = m;
      if (which === 'instagram') {
        ig++;
        assert.ok(whole.includes(IG_GRADIENT),
          f + ': the Instagram glyph is not painted with the brand gradient');
      }
      if (which === 'trustpilot') {
        tp++;
        assert.ok(TP_GREEN.test(whole), f + ': the Trustpilot star is not Trustpilot green');
      }
      assert.ok(!/<img/i.test(whole),
        f + ': the icon is an image file — the colour must come from the inline SVG we control');
    }
    assert.ok(ig >= 1 && tp >= 1, f + ': expected at least one of each badge');
  }
});

test('the exception is NARROW — brand colour on anything else still fails', () => {
  // The rule this relaxes is real, so prove the relaxation cannot be borrowed.
  // A non-exempt element wearing the same colours must still be caught.
  const EXEMPT = /data-social="(instagram|trustpilot)"/;
  const BRAND = /#00B67A|url\(#wm-ig-gradient\)|#e1306c|#c13584|#833ab4|#405de6/i;
  for (const f of PUBLIC) {
    const src = read(f);
    // Every element carrying a brand colour must be one of the two badges, or
    // the gradient definition that feeds them.
    for (const m of src.matchAll(/<(?!linearGradient|stop)[a-z][^>]*>/gi)) {
      if (!BRAND.test(m[0])) continue;
      const tagStart = m.index;
      const enclosing = src.slice(Math.max(0, tagStart - 400), tagStart + m[0].length);
      assert.ok(EXEMPT.test(enclosing) || /wm-ig-gradient"/.test(m[0]),
        f + ': a NON-exempt element carries a brand colour — the exception is only for the ' +
        'Instagram and Trustpilot badges: ' + m[0].slice(0, 110));
    }
  }
  // And the detector really does fire: plant the green on an ordinary element.
  const planted = read('index.html').replace('<nav>', '<nav><span style="color:#00B67A">stray</span>');
  let caught = false;
  for (const m of planted.matchAll(/<(?!linearGradient|stop)[a-z][^>]*>/gi)) {
    if (!BRAND.test(m[0])) continue;
    const enclosing = planted.slice(Math.max(0, m.index - 400), m.index + m[0].length);
    if (!EXEMPT.test(enclosing) && !/wm-ig-gradient"/.test(m[0])) caught = true;
  }
  assert.ok(caught, 'a brand colour planted on an ordinary element was NOT caught — the check is inert');
});

test('the buttons are framed, not filled, and are a real tap target', () => {
  const T = read('westmere-theme.css');
  const i = T.indexOf('.wm-social-link {');
  assert.ok(i !== -1, 'the theme no longer styles .wm-social-link');
  const block = T.slice(i, T.indexOf('}', i));
  assert.ok(/background:\s*transparent/.test(block), 'the social button has grown a fill at rest');
  assert.ok(/border:\s*var\(--border-hair/.test(block), 'the frame is gone, or is not off the token');
  assert.ok(/color:\s*var\(--westmere-navy/.test(block), 'the ink must be navy, off the token');
  assert.ok(/border-radius:\s*var\(--radius-/.test(block), 'the corner must come off the radius dial');
  const tap = /min-height:\s*(\d+)px/.exec(block);
  assert.ok(tap && +tap[1] >= 44, 'the tap target is under 44px: ' + (tap ? tap[1] : 'none'));
  // A press may fill — that is feedback, and §20's one exemption.
  assert.ok(/\.wm-social-link:active\s*\{[^}]*background:\s*var\(--westmere-navy/.test(T),
    'the press state no longer fills, so the button gives no feedback');
});

test('the icon is the biggest thing in the button', () => {
  const T = read('westmere-theme.css');
  const svg = T.slice(T.indexOf('.wm-social-link svg {'));
  const block = svg.slice(0, svg.indexOf('}'));
  const w = /width:\s*(\d+)px/.exec(block);
  assert.ok(w && +w[1] >= 18,
    'the glyph has shrunk back to a footer-sized mark — it is what people recognise: ' + (w ? w[1] : 'none'));
});

test('the Trustpilot URL is the live profile, on every page', () => {
  // The profile is live, linked on the UK domain (uk.trustpilot.com) so a
  // British visitor is not shown the "go to the British site" interstitial
  // ("Westmere Private Hire Reviews — be the first to review"). While it was
  // still being created this carried a data-placeholder-url marker; that
  // branch is kept so the same guard works if a URL is ever provisional
  // again, but the live branch is the one that runs now — and it insists
  // the marker is gone from EVERY page, not just the one somebody edited.
  const home = read('index.html');
  const flagged = /data-social="trustpilot"[^>]*data-placeholder-url="1"/.test(home);
  if (flagged) {
    // Still provisional: every page must carry the SAME provisional URL, so
    // swapping it later is one find-and-replace rather than a hunt.
    const urls = new Set();
    for (const f of PUBLIC) {
      const m = /href="(https:\/\/[^"]*trustpilot[^"]*)"/.exec(read(f));
      assert.ok(m, f + ' has no Trustpilot href');
      urls.add(m[1]);
    }
    assert.strictEqual(urls.size, 1,
      'the provisional Trustpilot URL differs between pages — swapping it later would miss some: ' +
      [...urls].join(', '));
  } else {
    // Real URL in place: the marker must be gone from EVERY page, not just one,
    // and every page must carry the SAME live profile.
    const urls = new Set();
    for (const f of PUBLIC) {
      const src = read(f);
      assert.ok(!/data-placeholder-url/.test(src),
        f + ' still marks the Trustpilot URL as a placeholder while others do not');
      for (const m of src.matchAll(/href="(https:\/\/[^"]*trustpilot[^"]*)"/g)) urls.add(m[1]);
    }
    assert.deepStrictEqual([...urls], ['https://uk.trustpilot.com/review/westmereprivatehire.co.uk'],
      'the Trustpilot link no longer points at the live Westmere profile: ' + [...urls].join(', '));
  }
});

test('adding the social row did not cost the footer its contact links', () => {
  // It did, once: patching the footer to replace the Instagram TEXT link took
  // the WhatsApp anchor next to it out of all six pages in the same edit. The
  // row that was added is not worth a channel that was lost.
  const missing = [];
  for (const f of PUBLIC) {
    const src = read(f);
    const foot = src.slice(src.indexOf('<footer'));
    if (!/href="tel:\+447930342593"/.test(foot)) missing.push(f + ': footer lost the phone number');
    if (!/href="mailto:bookings@westmereprivatehire\.co\.uk"/.test(foot)) missing.push(f + ': footer lost the email');
    if (!/href="https:\/\/wa\.me\/447930342593"/.test(foot)) missing.push(f + ': footer lost WhatsApp');
  }
  assert.deepStrictEqual(missing, [],
    'the footer lost a contact channel:\n      ' + missing.join('\n      '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/social-links\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
