/**
 * THE DESK IS THE POINT — run with:
 *   node server/tests/admin-full-view.test.js   (also gated by `npm test`)
 *
 * The admin app is the owner's DESKTOP system, and its driver editor was a
 * 640px column down the middle of it: the man's details, his car, his
 * licences, his login, his week's earnings and his running balance queued one
 * under another in a narrow strip, with the rest of the screen greyed out
 * behind. His words — he wants the full window, not a cramped close-up.
 *
 * So the pages he WORKS in take the window, and at desktop width the body
 * becomes two columns: what he is editing on the left, the money beside it
 * rather than a screen below it.
 *
 * NOT EVERYTHING. A small confirmation is not improved by being blown up to
 * 27 inches — "offer this booking to a driver" is one question — so this file
 * pins which surfaces take the window AND which must not.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ADMIN = read('westmere-admin.html');

const overlayOf = (id) => {
  const re = new RegExp('<div class="overlay([^"]*)" id="' + id + '"');
  const m = re.exec(ADMIN);
  assert.ok(m, 'there is no overlay called ' + id);
  return m[1];
};

// ── 1. THE WORKING SURFACES TAKE THE WINDOW ───────────────────────────────
console.log('\nThe pages he works in use the whole desk');

test('the driver editor, the journey, the customer and the booking form', () => {
  for (const id of ['modal-add-driver', 'modal-cust-detail', 'modal-book']) {
    assert.ok(/\bov-full\b/.test(overlayOf(id)), id + ' is still a column down the middle');
  }
  /* The journey page is built in JS rather than written in the markup. */
  assert.ok(/m\.className='overlay ov-full'/.test(strip(ADMIN)),
    'the journey page is still an 860px modal');
  assert.ok(!/modal" style="max-width:860px/.test(ADMIN), 'the 860px cap is still on it');
});

test('and none of them keeps a width cap that would undo it', () => {
  for (const id of ['modal-add-driver', 'modal-cust-detail']) {
    /* Bounded by the thing that ends it — the modal's own opening tag — not by
       a count of characters, which would stop covering this the day a longer
       onclick goes on the overlay. */
    const i = ADMIN.indexOf('id="' + id + '"');
    assert.ok(i !== -1, id + ' is gone');
    const k = ADMIN.indexOf('<div class="modal', i);
    const end = ADMIN.indexOf('>', k);
    assert.ok(k !== -1 && end !== -1, id + ' has no modal inside its overlay');
    const tag = ADMIN.slice(k, end + 1);
    assert.ok(!/max-width:\s*\d/.test(tag),
      id + ' is full-screen with a max-width still on its modal — the cap wins: ' + tag);
  }
});

test('a question stays a question', () => {
  /* Blowing a two-line confirmation up to the whole screen makes it harder to
     answer, not easier. These are deliberately left alone. */
  for (const id of ['modal-reassign', 'modal-inbox-compose']) {
    assert.ok(!/\bov-full\b/.test(overlayOf(id)),
      id + ' has been made full-screen — it asks one question');
  }
});

// ── 2. WHAT FULL-WIDTH ACTUALLY DOES ──────────────────────────────────────
console.log('\nWhat the extra width is used for');

test('the full-view rules fill the window rather than just widening the box', () => {
  const css = ADMIN;
  const ovRule = /\.overlay\.ov-full\{([^}]*)\}/.exec(css);
  assert.ok(ovRule && /padding:\s*0/.test(ovRule[1]),
    'the overlay still holds the page off the edges');
  assert.ok(/\.overlay\.ov-full \.modal\{max-width:none;width:100%;min-height:100vh/.test(css),
    'the page does not reach the full window');
});

test('NOTHING DARK IS REVEALED BY SCROLLING PAST THE CONTENT', () => {
  /* THE OWNER'S REPORT: scroll down the New Booking form, or the driver editor,
     and the background goes dark below the content. Measured at 1280×900 it was
     386 pixels of dark under a 1286-pixel form.

     MY OWN REGRESSION, from making these full-view. A full-view overlay is a
     flex container one viewport tall that scrolls, and `align-items:stretch`
     sizes its item to the CONTAINER — so the white sheet was exactly 100vh
     however tall the form was, min-height:100vh agreed with it, and everything
     past the fold sat on the overlay's 70%-black scrim.

     Two things, so neither alone has to hold: the item sizes to its CONTENT
     (flex-start, with min-height left to be the floor it was written as), and
     the overlay is PAPER rather than a scrim — in full view there is no page
     behind to dim, the modal is the page. */
  const css = ADMIN;
  const rule = /\.overlay\.ov-full\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the full-view overlay rule is gone');
  assert.ok(/align-items:\s*flex-start/.test(rule[1]),
    'the full-view overlay stretches its sheet to the window — a form taller than '
    + 'the window overflows the white and shows the scrim beneath it');
  assert.ok(!/align-items:\s*stretch/.test(rule[1]), 'stretch is back');
  assert.ok(/background:\s*var\(--westmere-white/.test(rule[1]),
    'the full-view overlay still carries the dark scrim behind the sheet');
  assert.ok(/color-scheme:\s*only light/.test(rule[1]),
    'nothing stops a browser repainting the full-view backdrop dark');
  /* min-height stays: a SHORT form must still fill the window, or the bottom of
     the screen is the page showing through. It is a floor, not a cap. */
  assert.ok(/\.overlay\.ov-full \.modal\{[^}]*min-height:100vh/.test(css),
    'a short form no longer fills the window');
});

test('the dialogs that are NOT full view keep their scrim', () => {
  /* The rule above is about a sheet that IS the page. A reassign dialog is a
     question asked over a page that is still there and still relevant, and
     dimming it is how that is said. */
  const base = /\n\.overlay\{([^}]*)\}/.exec(ADMIN);
  assert.ok(base, 'the base overlay rule is gone');
  assert.ok(/background:\s*rgba\(0,\s*0,\s*0/.test(base[1]),
    'the ordinary modal has lost its scrim — a dialog over a page needs one');
});

test('the admin page itself is light all the way down, and stays light', () => {
  /* The same failure one level out: a page whose background does not reach the
     bottom of the scroll shows whatever is behind it. html and body both carry
     the paper and both refuse to be repainted — in the theme, with !important,
     because the app's own stylesheet loads after it. */
  const theme = read('westmere-theme.css');
  const html = /\nhtml \{([^}]*)\}/.exec(theme);
  const body = /\nbody \{([^}]*)\}/.exec(theme);
  assert.ok(html && body, 'the theme no longer sets html/body');
  for (const [what, m] of [['html', html], ['body', body]]) {
    assert.ok(/background:\s*var\(--westmere-white\)\s*!important/.test(m[1]),
      what + ' does not paint itself the house paper');
  }
  assert.ok(/color-scheme:\s*only light\s*!important/.test(html[1]),
    'the document does not refuse a dark repaint — iOS and Chrome will paint the overscroll dark');
  /* And the app's own sheet must not take the background back off. */
  const own = /\nhtml\{([^}]*)\}/.exec(ADMIN);
  assert.ok(!own || !/background/.test(own[1]),
    "the admin stylesheet sets its own html background, which races the theme's");
});

test('no admin screen paints a dark area of its own', () => {
  /* A full-bleed dark block inside a view is the same bug by another route: it
     reads as the page going dark. The scrim on a real dialog is the exception,
     and it is listed. */
  const i = ADMIN.indexOf('<style>');
  const j = ADMIN.indexOf('</style>', i);
  const sheet = ADMIN.slice(i, j);
  const dark = [];
  for (const m of sheet.matchAll(/^(\.[\w .\-#>:]+)\{([^}]*)\}/gm)) {
    const bg = /background(?:-color)?:\s*([^;]+)/.exec(m[2]);
    if (!bg) continue;
    const v = bg[1].trim();
    const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    /* COMPOSITED OVER THE PAPER, not read off the channels. A hover wash is
       written rgba(27,27,26,.04) — near-black ink at four per cent — and
       reading its RGB alone calls it dark when what lands on the screen is
       very nearly white. What matters is what the eye receives. */
    let l = null;
    const over = (r, g, b, a) => {
      const w = 255 * (1 - a);
      return (0.299 * (r * a + w) + 0.587 * (g * a + w) + 0.114 * (b * a + w)) / 255;
    };
    if (rgba) {
      const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(v);
      l = over(+rgba[1], +rgba[2], +rgba[3], alpha ? parseFloat(alpha[1]) : 1);
    } else if (hex) {
      const n = parseInt(hex[1], 16);
      l = over((n >> 16) & 255, (n >> 8) & 255, n & 255, 1);
    }
    if (l !== null && l < 0.5) dark.push(m[1].trim() + ' { ' + v + ' }');
  }
  const ALLOWED = [
    '.overlay',          // a dialog over a page it is still showing
    '.sidebar',          // the navy rail, which is the brand and is not a page
    '.sb-item.on',
    '.btn-navy', '.btn-red', '.btn-green', '.btn-refund', '.btn-cancel-trip',
    '.tag', '.aa-msg.me', '.aa-fab', '.wm-primary',
    /* Two more controls, both small and both carrying their own white ink:
       a button inside a rendered email, and the pill on a calendar day that
       needs a driver. A chip is not a page area — what this test is about is a
       dark region appearing where the PAPER should be. */
    '.email-btn-green', '.adm-cal-pill.warn'
  ];
  const unexpected = dark.filter((d) => !ALLOWED.some((a) => d.startsWith(a)));
  assert.deepStrictEqual(unexpected, [],
    'an admin rule paints a dark area that is not a dialog scrim or a control:\n      '
    + unexpected.join('\n      '));
});

test('at desktop width the body is two columns, and one again below 1080px', () => {
  const css = ADMIN;
  const m = /@media\(min-width:1080px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'there is no desktop breakpoint for the full-view body');
  assert.ok(/\.mf-cols\{display:grid/.test(m[1]), 'the body is not split into columns');
  assert.ok(/\.mf-side\{position:sticky/.test(m[1]),
    'the money panel scrolls away from the form it belongs beside');
  /* Below the breakpoint there must be no grid at all — the same page in a
     narrower window, not a two-column layout squeezed into one. */
  assert.ok(!/^\.mf-cols\{display:grid/m.test(css),
    'the two-column grid is unconditional — it would crush the form on a laptop');
});

test('the driver editor is actually split, with the money on the side', () => {
  /* Bounded by the markup that ENDS it, not by a character count: the next
     modal's comment. Starting at the overlay's own <div so the tags balance. */
  const i = ADMIN.indexOf('<div class="overlay ov-full" id="modal-add-driver">');
  const j = ADMIN.indexOf('<!-- \u2550\u2550\u2550 MODAL: REASSIGN BOOKING', i);
  assert.ok(i !== -1 && j > i, 'the driver editor could not be bounded');
  const modal = ADMIN.slice(i, j);
  assert.ok(/<div class="mf-cols">/.test(modal), 'the editor body is not split');
  assert.ok(/<div class="mf-main">/.test(modal) && /<div class="mf-side">/.test(modal),
    'the two halves are not marked');
  /* The form on the left; his earnings, his balance and the week's transfer on
     the right, where they can be read while the form is being filled in. */
  const side = modal.slice(modal.indexOf('<div class="mf-side">'));
  for (const id of ['dm-earnings', 'dm-ledger']) {
    assert.ok(side.indexOf('id="' + id + '"') !== -1, id + ' is not in the side column');
  }
  const main = modal.slice(modal.indexOf('<div class="mf-main">'), modal.indexOf('<div class="mf-side">'));
  for (const id of ['dm-fname', 'dm-vehicle', 'dm-commission', 'dm-has-login']) {
    assert.ok(main.indexOf('id="' + id + '"') !== -1, id + ' is not in the form column');
  }
  const opens = (modal.match(/<div\b/g) || []).length;
  const closes = (modal.match(/<\/div>/g) || []).length;
  assert.strictEqual(opens, closes, 'the editor markup does not balance: ' + opens + ' open, ' + closes + ' close');
});

test('the booking form uses the width in columns, not in field length', () => {
  /* Taking the window gave every single-field row the whole of it: a postcode
     box the width of a desk, and the Email in a half row with a hand's breadth
     of nothing beside it. A field is as wide as what goes in it. The journey on
     the left, who it is for and what it costs on the right — the same split the
     driver editor uses, and one column again below 1080px. */
  const i = ADMIN.indexOf('<div class="overlay ov-full" id="modal-book">');
  const j = ADMIN.indexOf('<!-- ═══ MODAL: ADD DRIVER', i);
  assert.ok(i !== -1 && j > i, 'the booking form could not be bounded');
  const modal = ADMIN.slice(i, j);
  assert.ok(/<div class="mf-cols">/.test(modal), 'the booking form is not split into columns');
  const main = modal.slice(modal.indexOf('<div class="mf-main">'), modal.indexOf('<div class="mf-side">'));
  const side = modal.slice(modal.indexOf('<div class="mf-side">'));
  /* The journey is one job and must not be split across the fold. */
  for (const id of ['nb-date', 'nb-time', 'nb-pu', 'nb-stop', 'nb-de', 'nb-pax', 'nb-bags']) {
    assert.ok(main.indexOf('id="' + id + '"') !== -1, id + ' is not in the journey column');
  }
  for (const id of ['nb-name', 'nb-phone', 'nb-email', 'nb-pay', 'nb-fare-override']) {
    assert.ok(side.indexOf('id="' + id + '"') !== -1, id + ' is not in the passenger column');
  }
  const opens = (modal.match(/<div\b/g) || []).length;
  const closes = (modal.match(/<\/div>/g) || []).length;
  assert.strictEqual(opens, closes, 'the booking form markup does not balance');
});

test('every field submitBooking reads is still on the page', () => {
  /* Splitting a form moves markup, and a field that fell outside both columns
     would read as empty and SUBMIT as empty — a booking with no phone number
     on it, from a form that looked filled in. */
  const src = strip(ADMIN);
  const i = src.indexOf('function submitBooking');
  assert.ok(i !== -1, 'submitBooking is gone');
  const fn = src.slice(i, src.indexOf('\n}', src.indexOf('fetch(', i)) + 2);
  const ids = [...fn.matchAll(/getElementById\('(nb-[\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, 'only ' + ids.length + ' fields read by submitBooking — is it still the submitter?');
  for (const id of [...new Set(ids)]) {
    assert.ok(ADMIN.indexOf('id="' + id + '"') !== -1,
      'submitBooking reads #' + id + ', which is not on the page any more');
  }
});

test('every field the save reads is still on the page', () => {
  /* Splitting the body moved markup. A field that fell outside both columns
     would read as empty and SAVE as empty — quietly wiping a driver's licence
     number the first time he edits a phone number. */
  const src = strip(ADMIN);
  const i = src.indexOf('function saveDriver');
  assert.ok(i !== -1, 'saveDriver is gone');
  const fn = src.slice(i, src.indexOf('\n}', src.indexOf('fetch(', i)) + 2);
  const ids = [...fn.matchAll(/getElementById\('(dm-[\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, 'only ' + ids.length + ' fields read by saveDriver — is it still the saver?');
  for (const id of [...new Set(ids)]) {
    assert.ok(ADMIN.indexOf('id="' + id + '"') !== -1,
      'saveDriver reads #' + id + ', which is not on the page any more');
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/admin-full-view\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
