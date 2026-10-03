/**
 * THE BOOKING PAGE CANNOT TURN BLACK — run with:
 *   node server/tests/booking-dark-mode.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   A customer booking on a phone in dark mode got a black rectangle where the
 *   date popup should have been: "change it from totally black to a black rim
 *   and a lighter-coloured background so I can read it… I guessed where to
 *   press to continue at the bottom of the blank box." Rendered under Chrome's
 *   Auto Dark Theme it was worse than reported — every field of the booking
 *   form (name, phone, flight number, passengers, luggage) was a black box too.
 *
 * THE CAUSE, AND IT IS ONE WORD
 *   `color-scheme: light` does not mean "render me light". It means "I CAN be
 *   shown light" — which is exactly the invitation Android Chrome's Auto Dark
 *   Theme accepts: it then repaints the element itself, and an explicit white
 *   background does NOT stop it. `only light` forbids the override.
 *
 *   8e609d1 learned this for the DOCUMENT and said element-level declarations
 *   on inputs and pickers were "a different job". They were: westmere-theme.css
 *   §7 set `color-scheme: light !important` on every input, select and textarea
 *   on the site, and being !important no page could close the hole. Three more
 *   sat on the picker surfaces in styles.css, one on book.html's own fields,
 *   four in My Account.
 *
 * WHAT IS GUARDED
 *   1. THE CASCADE, computed — for each control a customer touches, the rule
 *      that actually WINS must resolve to `only light`. A grep would pass on a
 *      page whose own good declaration is beaten by an !important one in the
 *      token layer, which is precisely what happened.
 *   2. The popup is a card: its own paper, its own ink, and a rim — asked for
 *      by the customer, and the thing that makes it read as a box at all.
 *   3. The popup says how to choose and offers a visible way out.
 *   4. Contrast of what is declared, measured.
 *   5. Rendered under a dark client with Auto Dark forced on, when a browser is
 *      available on this machine (WM_DARK_RENDER=1 to require it).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/* ── A SMALL CASCADE, because the bug lived in the cascade ────────────────
   Enough of one to answer: for this element, on this page, which
   `color-scheme` declaration wins? Importance, then specificity, then order —
   the three things that decided it. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }

function sheetsFor(page) {
  const html = read(page);
  const out = [];
  // Linked stylesheets, in document order.
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)) {
    const href = m[1].replace(/^\//, '').split('?')[0];
    if (!/^https?:/.test(href) && fs.existsSync(path.join(ROOT, href))) out.push({ name: href, css: read(href) });
  }
  // …then the page's own <style> blocks, which come after them in the file.
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push({ name: page + ' <style>', css: m[1] });
  assert.ok(out.length, page + ' loads no stylesheet this guard can read');
  return out;
}

function declarations(sheets, prop) {
  const found = [];
  let order = 0;
  for (const s of sheets) {
    const css = stripComments(s.css);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2];
      const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;!]+)(!important)?', 'i').exec(body);
      if (!d) continue;
      found.push({
        sheet: s.name,
        selectors: m[1].split(',').map((x) => x.trim()).filter(Boolean),
        value: d[1].trim().toLowerCase(),
        important: /!important/i.test(body.slice(d.index)),
        order: order++
      });
    }
  }
  return found;
}

/* An element described well enough to match the selectors that exist here. */
function matches(sel, el) {
  const parts = sel.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const self = (s, e) => {
    if (s === '*') return true;
    if (s === ':root' || s === 'html') return e.tag === 'html';
    const tag = /^[a-z]+/.exec(s);
    if (tag && e.tag !== tag[0]) return false;
    const classes = (s.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1));
    return classes.every((c) => (e.classes || []).includes(c));
  };
  if (!self(last, el)) return false;
  // Ancestors, loosely: every earlier part must match something above it.
  let pool = (el.ancestors || []).slice();
  for (let i = parts.length - 2; i >= 0; i--) {
    const want = parts[i];
    const at = pool.findIndex((a) => self(want, a));
    if (at === -1) return false;
    pool = pool.slice(at + 1);
  }
  return true;
}

function specificity(sel) {
  const ids = (sel.match(/#[A-Za-z0-9_-]+/g) || []).length;
  const cls = (sel.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:[a-z-]+\(?/g) || []).length;
  const tags = (sel.match(/(^|[\s>+~])[a-z]+/g) || []).length;
  return ids * 10000 + cls * 100 + tags;
}

function winner(decls, el) {
  let best = null;
  for (const d of decls) {
    for (const sel of d.selectors) {
      if (!matches(sel, el)) continue;
      const cand = { d, spec: specificity(sel), sel };
      if (!best) { best = cand; continue; }
      if (d.important !== best.d.important) { if (d.important) best = cand; continue; }
      if (cand.spec !== best.spec) { if (cand.spec > best.spec) best = cand; continue; }
      if (d.order >= best.d.order) best = cand;   // later wins
    }
  }
  return best;
}

const el = (tag, classes, ancestors) => ({ tag, classes: classes || [], ancestors: ancestors || [] });

/* ── 1. THE CASCADE ──────────────────────────────────────────────────────── */
console.log('\nWhat a dark phone is allowed to repaint');

const SURFACES = [
  ['book.html', 'the pickup field', el('input', [], [el('div', ['book-form-col']), el('div', ['field'])])],
  ['book.html', 'the passengers select', el('select', [], [el('div', ['book-form-col']), el('div', ['field'])])],
  ['book.html', 'the notes box', el('textarea', [], [el('div', ['book-form-col']), el('div', ['field'])])],
  ['book.html', 'the date/time field', el('button', ['wm-field'], [el('div', ['book-form-col'])])],
  ['book.html', 'the date popup', el('div', ['wm-pop'], [el('div', ['wm-pop-backdrop'])])],
  ['book.html', 'the popup scrim', el('div', ['wm-pop-backdrop'], [el('body')])],
  ['book.html', 'the document itself', el('html', [], [])],
  ['westmere-rider.html', 'a My Account field', el('input', ['fi'], [el('div', ['field'])])],
  ['westmere-rider.html', 'the My Account calendar', el('div', ['cal-drop'], [el('div', ['field'])])],
  ['westmere-rider.html', 'the My Account time list', el('div', ['time-drop'], [el('div', ['field'])])],
  ['westmere-pay.html', 'the pay page', el('html', [], [])]
];

const cache = {};
const schemeDecls = (page) => (cache[page] || (cache[page] = declarations(sheetsFor(page), 'color-scheme')));

for (const [page, what, probe] of SURFACES) {
  test(page + ': ' + what + ' refuses the repaint', () => {
    const win = winner(schemeDecls(page), probe);
    assert.ok(win, what + ' is covered by no color-scheme rule at all — the phone decides');
    assert.ok(/^only light$|^light only$/.test(win.d.value),
      what + ' resolves to `' + win.d.value + '` (from `' + win.sel + '` in ' + win.d.sheet
      + '). `light` INVITES Android Chrome\'s Auto Dark Theme to repaint it — that is the black box.');
  });
}

test('NEGATIVE: the cascade guard catches a re-introduced `light`', () => {
  /* A guard that cannot fail proves nothing. This is the exact shape of the
     bug: a page says `only light`, the token layer says `light !important`. */
  const decls = [
    { sheet: 'page', selectors: ['.book-form-col input'], value: 'only light', important: false, order: 0 },
    { sheet: 'theme', selectors: ['input'], value: 'light', important: true, order: 1 }
  ];
  const win = winner(decls, el('input', [], [el('div', ['book-form-col'])]));
  assert.strictEqual(win.d.sheet, 'theme', 'an !important declaration must beat the page');
  assert.strictEqual(win.d.value, 'light', 'and the guard must report the value that actually wins');
});

test('NEGATIVE: specificity and order are really being read', () => {
  const decls = [
    { sheet: 'a', selectors: ['input'], value: 'light', important: false, order: 0 },
    { sheet: 'b', selectors: ['.field input'], value: 'only light', important: false, order: 1 }
  ];
  assert.strictEqual(winner(decls, el('input', [], [el('div', ['field'])])).d.value, 'only light',
    'the more specific selector must win');
  const tie = [
    { sheet: 'a', selectors: ['input'], value: 'only light', important: false, order: 0 },
    { sheet: 'b', selectors: ['input'], value: 'light', important: false, order: 1 }
  ];
  assert.strictEqual(winner(tie, el('input', [], [])).d.value, 'light', 'on a tie the later rule must win');
});

/* ── 2. THE POPUP IS A CARD ──────────────────────────────────────────────── */
console.log('\nThe box the customer could not read');

function ruleFor(css, selector) {
  const m = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(stripComments(css));
  assert.ok(m, selector + ' is gone from styles.css');
  return m[1];
}

test('it declares its own paper and its own ink', () => {
  /* Inheriting either is what made the emails black, and it is what would make
     this black again on any client that recolours element by element. */
  const pop = ruleFor(read('styles.css'), '.wm-pop');
  assert.ok(/background:/.test(pop), 'the popup inherits its background');
  assert.ok(/(^|;)\s*color:/.test(pop), 'the popup inherits its text colour');
  assert.ok(/#ffffff/i.test(pop), 'and the paper must survive a missing token: ' + pop.trim().slice(0, 120));
});

test('it has a rim, which is what the customer asked for', () => {
  /* "a black rim and a lighter-coloured background so I can read it". A shadow
     is not a rim: on a dark ground the shadow is invisible and the card has no
     edge at all. */
  const pop = ruleFor(read('styles.css'), '.wm-pop');
  assert.ok(/(^|;)\s*border:\s*1px solid/.test(pop), 'the popup has no border — it is a floating white shape');
});

test('it says how to choose, and offers a way out you can see', () => {
  /* He guessed where to press. Tapping a day is the confirm and tapping the
     scrim is the escape; neither was written anywhere on the box. */
  const js = read('wm-picker.js');
  assert.ok(/wm-pop-foot/.test(js), 'the date popup has no footer');
  assert.ok(/Tap a day to choose it/.test(js), 'it does not say how to choose a date');
  assert.ok(/data-cancel/.test(js) && /\[data-cancel\][\s\S]{0,80}closePopup/.test(js),
    'the Cancel control is not wired to close it');
  const css = read('styles.css');
  const foot = ruleFor(css, '.wm-pop-cancel');
  assert.ok(/background:/.test(foot) && /border:/.test(foot) && /color:/.test(foot),
    'the Cancel button must declare paper, ink and a frame or it vanishes too: ' + foot.trim().slice(0, 120));
  /* The time wheel already had one. Both pickers, one behaviour. */
  assert.ok(/wmtw-x|Done/.test(read('wm-timewheel.js')), 'the time picker lost its visible controls');
});

/* ── 3. CONTRAST, MEASURED ───────────────────────────────────────────────── */
function lum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, 'not a colour: ' + hex);
  const n = parseInt(m[1], 16);
  const f = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the popup reads at better than 4.5:1 as declared', () => {
  const pop = ruleFor(read('styles.css'), '.wm-pop');
  const bg = /background:[^;]*?(#[0-9a-f]{6})/i.exec(pop);
  const fg = /(?:^|;)\s*color:[^;]*?(#[0-9a-f]{6})/i.exec(pop);
  assert.ok(bg && fg, 'the popup does not state both colours as literals');
  const r = ratio(fg[1], bg[1]);
  assert.ok(r >= 4.5, 'the popup reads at ' + r.toFixed(1) + ':1 (' + fg[1] + ' on ' + bg[1] + ')');
});

/* ── 4. THE PAGES STILL OPT OUT AT THE TOP ───────────────────────────────── */
test('every customer page still carries the only-light meta', () => {
  for (const p of ['book.html', 'index.html', 'westmere-pay.html', 'westmere-rider.html']) {
    const m = /<meta[^>]+name=["']color-scheme["'][^>]+content=["']([^"']+)["']/i.exec(read(p));
    assert.ok(m, p + ' has no color-scheme meta — the browser-facing one, not supported-color-schemes');
    assert.ok(/only/.test(m[1]), p + ' asks for `' + m[1] + '`, which invites the repaint');
  }
});

/* ── 5. RENDERED UNDER A DARK CLIENT ─────────────────────────────────────── */
test('rendered under forced dark, nothing on the booking page is dark-on-dark', async () => {
  const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const required = process.env.WM_DARK_RENDER === '1';
  if (!fs.existsSync(CH)) {
    if (required) throw new Error('WM_DARK_RENDER=1 but no browser at ' + CH);
    console.log('      (no browser on this machine — the cascade above is the guard that always runs)');
    return;
  }
  const { renderBookingUnderDark } = require('./_dark-render');
  const bad = await renderBookingUnderDark(path.join(ROOT, 'book.html'));
  assert.deepStrictEqual(bad, [],
    'these render dark-on-dark under Chrome Auto Dark:\n      ' + bad.join('\n      '));
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('booking-dark-mode.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
