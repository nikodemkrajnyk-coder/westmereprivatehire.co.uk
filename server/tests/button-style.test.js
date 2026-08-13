/**
 * BUTTON STYLE guardrail — run with:
 *   node server/tests/button-style.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The owner's words: the buttons looked old-fashioned — solid black fills in
 *   square boxes, on My Account ("Save Changes", "Sign Out") and on the new
 *   change-request panels. They were replaced with one outlined, rounded system.
 *
 *   THE PALETTE IS NOW THE OWNER'S FINISHED THEME, /westmere-theme.css: deep
 *   navy #102a43 on white, Cormorant throughout, no gold and no cream. Navy — not gold,
 *   not black — is the accent. /wm-buttons.css holds the same values on purpose
 *   (see the note at the top of that file), so this file pins the two together:
 *   if the theme's navy moves and the buttons' does not, that is a failure here,
 *   not a thing someone notices in a screenshot three weeks later.
 *
 *   The other risk is drift: the next person adds a button with its own inline
 *   `background:#1b1b1a` and the system quietly grows a third look, or a fourth.
 *   That is what this file prevents.
 *
 * WHAT IT PINS
 *   (a) ONE definition — /wm-buttons.css exists, is loaded by every surface,
 *       and is loaded LAST in <head> so it actually wins; and the global theme
 *       is loaded after IT, on every page, so the palette has one owner;
 *   (b) exactly two styles (primary + ghost, plus the danger accent), each with
 *       a hover AND a pressed state, and rounded corners;
 *   (c) a future colour change is ONE edit — every colour comes from tokens at
 *       the top of that file, and nothing below hard-codes one;
 *   (d) NO button anywhere uses a solid black/near-black background, in a
 *       stylesheet or in an inline style attribute;
 *   (e) the change-request panel buttons use the shared classes.
 *
 * Pure static analysis of the shipped files. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const CSS = read('wm-buttons.css');
// Every surface that shows a button to a human.
const SURFACES = [
  'westmere-rider.html',   // My Account
  'westmere-owner.html',   // owner app
  'westmere-admin.html',   // admin app
  'westmere-pay.html',     // pay page
  'book.html'              // public booking page
];

// Near-black fills — the thing the owner objected to.
const DARK = /#(1b1b1a|000000|000|111|1a1a1a|191919|0e2540|2b2a26)\b/i;

console.log('\nButtons — one modern system, defined once');

// ── (a) ONE definition, loaded everywhere, loaded last ───────────────────
test('the shared button stylesheet exists and is loaded by every surface', () => {
  assert.ok(CSS.length > 500, 'wm-buttons.css looks empty');
  for (const f of SURFACES) {
    assert.ok(/<link[^>]+wm-buttons\.css/.test(read(f)),
      f + ' does not load /wm-buttons.css — its buttons would keep the old look');
  }
});

test('it is loaded LAST in <head>, so it wins without a specificity war', () => {
  for (const f of SURFACES) {
    const src = read(f);
    // The real <head> ends at the </head> immediately before <body>.
    const low = src.toLowerCase();
    const head = src.slice(0, low.lastIndexOf('</head>', low.indexOf('<body')));
    // Match the LINK TAG, not a stylesheet comment that happens to name the file.
    const link = head.search(/<link[^>]+wm-buttons\.css/i);
    const lastStyle = head.lastIndexOf('<style');
    assert.ok(link !== -1, f + ': link not in <head>');
    assert.ok(link > lastStyle,
      f + ': /wm-buttons.css must come AFTER the page\'s own <style> block, or the page ' +
      'overrides the shared buttons and the look drifts again');
  }
});

test('My Account can still style its buttons offline (precached)', () => {
  for (const f of ['wm-buttons.css', 'westmere-theme.css']) {
    assert.ok(read('rider-sw.js').indexOf(f) !== -1,
      'the service worker must precache /' + f + ', or an offline My Account renders ' +
      'unstyled buttons and an unthemed page');
  }
});

// ── (a2) The global theme is the palette's single owner ──────────────────
// Every page in the site, not just the ones with buttons: the theme is what
// makes the whole site navy-on-white, and a page that misses it renders in the
// old cream/gold look beside pages that don't.
const ALL_PAGES = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html') && !f.startsWith('__'))
  .sort();

test('every HTML page loads the global theme', () => {
  assert.ok(ALL_PAGES.length >= 15, 'expected the full page set, found ' + ALL_PAGES.length);
  for (const f of ALL_PAGES) {
    assert.ok(/<link[^>]+westmere-theme\.css/i.test(read(f)),
      f + ' does not load /westmere-theme.css — it would keep the old cream/gold look');
  }
});

test('the theme is the LAST stylesheet on every page', () => {
  for (const f of ALL_PAGES) {
    const src = read(f);
    const low = src.toLowerCase();
    // The real <head> ends at the </head> immediately before <body>; there are
    // other </head> strings inside JS that build print windows.
    const head = src.slice(0, low.lastIndexOf('</head>', low.indexOf('<body')));
    const theme = head.search(/<link[^>]+westmere-theme\.css/i);
    assert.ok(theme !== -1, f + ': the theme link is not in <head>');
    assert.ok(theme > head.lastIndexOf('<style'),
      f + ': the theme must come AFTER the page\'s own <style> block');
    const buttons = head.search(/<link[^>]+wm-buttons\.css/i);
    if (buttons !== -1) {
      assert.ok(theme > buttons,
        f + ': the theme must load after /wm-buttons.css — the theme owns the palette');
    }
    // …and after every other stylesheet, full stop.
    const links = [...head.matchAll(/<link[^>]+rel=["']?stylesheet[^>]*>/gi)];
    const last = links[links.length - 1];
    assert.ok(/westmere-theme\.css/i.test(last[0]),
      f + ': the last stylesheet is ' + last[0].slice(0, 70) + ', not the theme');
  }
});

test('the button tokens track the theme — one palette, not two opinions', () => {
  const THEME = read('westmere-theme.css');
  const themeVal = (name) => {
    const m = THEME.match(new RegExp('--' + name + ':\\s*([^;]+);'));
    assert.ok(m, 'the theme no longer defines --' + name);
    return m[1].trim().toLowerCase();
  };
  const btnVal = (name) => {
    const m = CSS.match(new RegExp('--' + name + ':\\s*([^;]+);'));
    assert.ok(m, 'wm-buttons.css no longer defines --' + name);
    return m[1].trim().toLowerCase();
  };
  const navy = themeVal('westmere-navy');
  assert.strictEqual(btnVal('wmb-ink'), navy,
    'the button ink has drifted from the theme navy — several button selectors here ' +
    'carry :hover:not(:disabled), which OUTRANKS the theme\'s plain :hover no matter ' +
    'which file loads last, so the two must hold the same value');
  assert.strictEqual(btnVal('wmb-press'), navy, 'the pressed fill has drifted from the theme navy');
  assert.strictEqual(btnVal('wmb-line-strong'), navy, 'the primary border has drifted from the theme navy');
  assert.strictEqual(btnVal('wmb-surface'), themeVal('westmere-white'), 'the resting surface is not the theme white');
  assert.strictEqual(btnVal('wmb-on-press'), themeVal('westmere-white'), 'the pressed label is not the theme white');
});

test('navy is the accent — the buttons are neither gold nor black', () => {
  const ink = (CSS.match(/--wmb-ink:\s*([^;]+);/) || [])[1].trim();
  assert.ok(/^#102a43$/i.test(ink), 'the accent must be the theme navy (got: ' + ink + ')');
  assert.ok(!DARK.test(ink), 'the accent must not be a near-black');
});

// ── (b) Exactly two styles, each with hover + pressed, rounded ───────────
test('there are exactly TWO button styles: primary and ghost', () => {
  assert.ok(/\.wm-btn-primary\s*\{/.test(CSS), 'missing .wm-btn-primary');
  assert.ok(/\.wm-btn-ghost\s*\{/.test(CSS), 'missing .wm-btn-ghost');
  const variants = (CSS.match(/^\.wm-btn-[a-z]+\s*\{/gm) || [])
    .map(s => s.trim().replace(/\s*\{$/, ''))
    .filter(v => !['.wm-btn-sm', '.wm-btn-lg', '.wm-btn-block'].includes(v));
  assert.deepStrictEqual(variants.sort(), ['.wm-btn-ghost', '.wm-btn-primary'],
    'only primary and ghost may exist — the difference between them is WEIGHT, ' +
    'not colour (got: ' + variants.join(', ') + ')');
});

test('every style has a HOVER and a PRESSED state', () => {
  for (const v of ['primary', 'ghost']) {
    assert.ok(new RegExp('\\.wm-btn-' + v + ':hover').test(CSS), v + ' has no hover state');
    assert.ok(new RegExp('\\.wm-btn-' + v + ':active').test(CSS),
      v + ' has no pressed state — on a phone there is no hover, so a tap would give no feedback');
  }
  assert.ok(/\.wm-btn:active\s*\{[^}]*transform/.test(CSS),
    'the base button should give a physical nod on press');
});

test('corners are rounded, not square', () => {
  const m = CSS.match(/--wmb-radius:\s*([^;]+);/);
  assert.ok(m, 'no --wmb-radius token');
  const r = m[1].trim();
  assert.ok(!/^0(px|rem|em)?$/.test(r), 'the radius is square (' + r + ')');
  assert.ok(/\.wm-btn\s*\{[\s\S]*?border-radius:\s*var\(--wmb-radius\)/.test(CSS),
    '.wm-btn must take its radius from the token');
});

test('buttons are outlined on white at rest, never filled', () => {
  const base = CSS.slice(CSS.indexOf('.wm-btn {'), CSS.indexOf('.wm-btn:active'));
  assert.ok(/background-color:\s*var\(--wmb-surface\)/.test(base),
    'the base button must sit on the white surface token at rest');
  assert.ok(/border:\s*var\(--wmb-border\)/.test(base), 'the base button must carry a border');
  const surface = (CSS.match(/--wmb-surface:\s*([^;]+);/) || [])[1];
  assert.ok(/#f{3,6}/i.test((surface || '').trim()),
    'the resting surface must be white, not cream (got: ' + surface + ')');
});

// ── The palette: monochrome, per the logo ────────────────────────────────
test('the palette is MONOCHROME — no gold anywhere in the button system', () => {
  // The brand golds/ambers this system used to carry.
  const GOLD = /(#b8[0-9a-f]{4}|#c9a05a|#a37d34|#8a5a1a|#9c5800|184,\s*(144|152),\s*(69|90)|156,\s*88,\s*0)/i;
  const hit = CSS.split('\n').find(l => GOLD.test(l) && !/^\s*(\/\*|\*)/.test(l));
  assert.ok(!hit, 'wm-buttons.css still carries a gold value: ' + (hit || '').trim());
});

test('no button anywhere carries a gold accent', () => {
  const GOLD = /(#b8[0-9a-f]{4}|#c9a05a|#a37d34|#8a5a1a|#9c5800|var\(--gold2?\)|184,\s*(144|152),\s*(69|90))/i;
  for (const f of SURFACES) {
    const src = read(f);
    // Inline styles on buttons — these beat the shared stylesheet.
    const re = /<button[^>]*style="([^"]*)"/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      assert.ok(!GOLD.test(m[1]),
        f + ': an inline button style still uses gold (' + m[1].slice(0, 80) + ')');
    }
    // …and stylesheet rules whose selector names a button.
    const rules = /([^{}]*\b(?:btn|wm-btn)[^{}]*)\{([^}]*)\}/gi;
    while ((m = rules.exec(src)) !== null) {
      if (/^\s*@/.test(m[1])) continue;
      const colour = m[2].match(/(?:^|;)\s*(?:background(?:-color)?|border(?:-color)?|color)\s*:\s*([^;]+)/i);
      if (!colour) continue;
      assert.ok(!GOLD.test(colour[1]),
        f + ': "' + m[1].split('\n').pop().trim().slice(0, 60) + '" still uses gold (' + colour[1].trim() + ')');
    }
  }
});

// ── CREAM AND GOLD DO NOT EXIST IN THE CODE ──────────────────────────────
// The owner's rule, verbatim: "cream and gold should not exist in the code."
// Not overridden by a later stylesheet — ABSENT. So this does not check a list
// of the particular hexes we happened to remove; it recognises the FAMILY, and
// fails on a cream or gold nobody has written yet.
//
// A colour is cream or gold when it is warm: red > green > blue, with the hue
// in the yellow/amber/brown band (25°–65°). That band is what separates a cream
// (#f5f2ec, 40°) or a gold (#b8985a, 40°) from the reds the app legitimately
// uses for errors — #c0392b sits at 5°, the blush #fbe9e1 at 19°, both well
// outside it. A near-neutral (r-b < 5) is not warm enough to count.
const PAGES_AND_CSS = fs.readdirSync(ROOT)
  .filter(f => (f.endsWith('.html') || f.endsWith('.css')) && !f.startsWith('__'))
  .sort();

function warmHue(r, g, b) {
  if (!(r > g && g > b)) return null;      // not on the warm ramp at all
  if (r - b < 5) return null;              // a near-neutral, not a colour
  const hue = 60 * ((g - b) / (r - b));    // max is r, min is b → the red sector
  return hue >= 25 && hue <= 65 ? hue : null;
}

// Every colour literal in a file, as {value, r, g, b, line}.
function coloursIn(src) {
  const out = [];
  src.split('\n').forEach((text, i) => {
    let m;
    const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
    while ((m = hex.exec(text)) !== null) {
      const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
      out.push({ value: m[0], line: i + 1,
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) });
    }
    const rgb = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;
    while ((m = rgb.exec(text)) !== null) {
      out.push({ value: m[0] + ')', line: i + 1,
        r: +m[1], g: +m[2], b: +m[3] });
    }
  });
  return out;
}

test('NO cream or gold value exists anywhere in the code', () => {
  const found = [];
  for (const f of PAGES_AND_CSS) {
    for (const c of coloursIn(read(f))) {
      const hue = warmHue(c.r, c.g, c.b);
      if (hue !== null) {
        const kind = (c.r > 0xdf && c.g > 0xdf && c.b > 0xdf) ? 'cream' : 'gold';
        found.push(f + ':' + c.line + '  ' + c.value + '  (' + kind + ', hue ' + hue.toFixed(0) + '°)');
      }
    }
  }
  assert.deepStrictEqual(found, [],
    'cream/gold must not exist in the code — cream surfaces are white, gold accents are navy:\n      ' +
    found.slice(0, 20).join('\n      '));
});

// The sweep above walks the pages and stylesheets at the repo root, so for a
// long time the two surfaces that reach a customer OUTSIDE the browser escaped
// it entirely: the transactional emails and the invoice PDF. Both were still
// ivory-and-gold long after the site went navy-on-white — the confirmation
// email in particular, because its template was hand-built separately from the
// heroShell system and carried its own hard-coded palette. Same detector, so a
// gold nobody has written yet fails here too.
// public-api.js is in here because it SERVES two pages: the "pay your driver"
// confirm screen and the cancel/note screen. A customer reaches them by tapping
// a link in an email, so a mismatch there is the most jarring one in the system.
const SERVER_SURFACES = ['server/email.js', 'server/invoice-pdf.js', 'server/public-api.js'];

test('the emails and the invoice PDF carry no cream or gold either', () => {
  const found = [];
  for (const f of SERVER_SURFACES) {
    for (const c of coloursIn(read(f))) {
      const hue = warmHue(c.r, c.g, c.b);
      if (hue !== null) {
        const kind = (c.r > 0xdf && c.g > 0xdf && c.b > 0xdf) ? 'cream' : 'gold';
        found.push(f + ':' + c.line + '  ' + c.value + '  (' + kind + ', hue ' + hue.toFixed(0) + '°)');
      }
    }
  }
  assert.deepStrictEqual(found, [],
    'the emails and the invoice must match the site — navy on white, no gold:\n      ' +
    found.slice(0, 20).join('\n      '));
});

test('no GOLD constant survives in the email or invoice palette', () => {
  // Re-pointing a constant called GOLD at navy is not enough: the name is how a
  // gold creeps back in. Both files declare ACCENT instead.
  for (const f of ['server/email.js', 'server/invoice-pdf.js']) {
    const src = read(f);
    assert.ok(!/\bconst\s+GOLD\b/.test(src), f + ' still declares a GOLD constant');
    assert.ok(/\bconst\s+ACCENT\b/.test(src), f + ' should declare ACCENT (the navy accent) instead of GOLD');
  }
  // The served pages carry their palette as CSS custom properties instead.
  const api = read('server/public-api.js');
  assert.ok(!/--gold\b/.test(api), 'server/public-api.js still defines or uses a --gold token');
  assert.ok(!/Jost/.test(api), 'server/public-api.js still loads Jost — the brand is one face, Cormorant');
});

// The colour sweeps above read SOURCE, so the last gold in the system hid where
// no source scan could see it: the row icons in the confirmation email are PNGs,
// and every one of them was drawn in #b78635. The emails went navy while their
// own icons stayed gold. This decodes them and checks the pixels.
function pngPixels(file) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  // Only the shape these icons actually use: 8-bit truecolour+alpha.
  if (depth !== 8 || type !== 6) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, px = [];
  const prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride), o = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[o++];
    raw.copy(cur, 0, o, o + stride); o += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) px.push([cur[x * 4], cur[x * 4 + 1], cur[x * 4 + 2], cur[x * 4 + 3]]);
    cur.copy(prev);
  }
  return px;
}

test('the email row icons are navy artwork, not gold', () => {
  const icons = fs.readdirSync(path.join(ROOT, 'assets')).filter(f => /^ic-.*\.png$/.test(f)).sort();
  assert.ok(icons.length >= 8, 'expected the email row icons in assets/');
  const offenders = [];
  for (const f of icons) {
    const px = pngPixels(path.join(ROOT, 'assets', f));
    if (!px) continue;                        // not a shape this reader handles
    // Ignore near-transparent antialiasing, which carries no visible colour.
    if (px.some(([r, g, b, a]) => a > 40 && warmHue(r, g, b) !== null)) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [],
    'these email icons are still drawn in gold — the emails went navy but their ' +
    'own artwork did not: ' + offenders.join(', '));
});

// Purging the gold nearly shipped six invisible buttons. The email call-to-
// actions were gold backgrounds with dark text; mapping gold AND the dark ink
// both onto navy left `background:navy;color:navy` — a solid navy bar with a
// label nobody could read, on the payment reminder and the review request among
// others. Nothing in the suite noticed, because every colour involved was a
// legitimate brand colour. So: no button may fail contrast against its own
// background, whatever the palette becomes next.
function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function luminance([r, g, b]) { return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b); }
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, c => c + c);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function contrast(a, b) {
  const l1 = luminance(hex2rgb(a)), l2 = luminance(hex2rgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('no email button prints its label in its own background colour', () => {
  let src = read('server/email.js');
  // Resolve the palette constants so ${ACCENT}/${INK} become real values.
  const consts = {};
  for (const m of src.matchAll(/^const\s+([A-Z_]+)\s*=\s*'(#[0-9a-fA-F]{3,6})'/gm)) consts[m[1]] = m[2];
  assert.ok(Object.keys(consts).length >= 4, 'could not read the email palette constants');
  src = src.replace(/\$\{([A-Z_]+)\}/g, (whole, name) => consts[name] || whole);

  const bad = [];
  for (const m of src.matchAll(/background:(#[0-9a-fA-F]{3,6});color:(#[0-9a-fA-F]{3,6})/g)) {
    const ratio = contrast(m[1], m[2]);
    // 4.5:1 is WCAG AA for body text; these labels are small and often bold,
    // but a call-to-action a customer must find should clear the stricter bar.
    if (ratio < 4.5) bad.push(m[1] + ' on ' + m[2] + ' → ' + ratio.toFixed(2) + ':1');
  }
  assert.deepStrictEqual([...new Set(bad)], [],
    'an email button is unreadable against its own background:\n      ' + [...new Set(bad)].join('\n      '));
});

// ── NO FILLED HEADERS OR FOOTERS ─────────────────────────────────────────
// The owner's rule: "no more filled footers or headers anywhere." A header or
// footer separates itself with a hairline, never with a block of colour. The
// check is on LUMINANCE, not on a list of hexes, so a charcoal or a navy
// nobody has written yet fails too. Near-white fills pass — that is the point.
function isFilled(colour) {
  const c = colour.trim().toLowerCase();
  if (/^(transparent|none|inherit|unset|#fff|#ffffff|white)$/.test(c)) return false;
  let rgb = null, alpha = 1;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) rgb = hex2rgb(c);
  const m = c.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+))?/);
  if (m) { rgb = [+m[1], +m[2], +m[3]]; if (m[4] !== undefined) alpha = parseFloat(m[4]); }
  if (!rgb) return false;                      // a var() or a gradient — handled by the caller
  // Composite over the white page. A 3% wash is not a filled bar; a 55% navy is.
  const over = rgb.map(v => Math.round(v * alpha + 255 * (1 - alpha)));
  return luminance(over) < 0.80;
}

test('no header or footer anywhere carries a solid fill', () => {
  const offenders = [];
  const files = PAGES_AND_CSS.concat(['server/email.js', 'server/public-api.js']);
  const NAMES = /(^|[.#\s>,])(footer|header|head|topbar|top-bar|appbar|navbar|bottom-nav|tabbar|mini-foot)([.\s:,]|$)/i;
  // One pass per file. Selector and body are both length-capped: these files
  // include 380kB minified apps, and an unbounded rule pattern backtracks for
  // minutes on a single long line.
  const RULE = /([^{}();]{1,120})\{([^{}]{0,600})\}/g;
  for (const f of files) {
    const src = read(f);
    const lineAt = (idx) => src.slice(0, idx).split('\n').length;
    for (const m of src.matchAll(RULE)) {
      const sel = m[1].trim();
      if (!NAMES.test(sel)) continue;
      const bg = m[2].match(/background(?:-color)?:\s*([^;!}]{1,60})/i);
      if (!bg) continue;
      const val = bg[1].trim();
      const dark = /^var\(--(navy|dark|ink|westmere-navy[a-z-]*|westmere-text)\)$/i.test(val);
      if (dark || isFilled(val)) {
        offenders.push(f + ':' + lineAt(m.index) + '  ' + sel.slice(0, 44) + ' → ' + val);
      }
    }
    // Inline styles on an element whose class names it a header or footer.
    for (const m of src.matchAll(/class="([^"]{0,120})"[^>]{0,200}?style="([^"]{0,400})"/g)) {
      if (!NAMES.test(m[1])) continue;
      const bg = m[2].match(/background(?:-color)?:\s*([^;!}]{1,60})/i);
      if (bg && isFilled(bg[1])) offenders.push(f + ':' + lineAt(m.index) + '  .' + m[1].trim().slice(0, 30) + ' → ' + bg[1].trim());
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a header or footer is still a filled block — use a hairline instead:\n      ' + offenders.join('\n      '));
});

test('the email footer band is white, and its text is legible on white', () => {
  // Unfilling a band is only half the job: its type was light-on-navy, so it
  // has to flip in the same edit or the band renders blank. That is exactly how
  // the site footer ended up white-on-white — the theme painted it white but a
  // later rule still forced white copy, and the phone number, the contact links
  // and the licence line were invisible on every public page.
  const src = read('server/email.js');
  const start = src.indexOf('<tr><td style="padding:24px 30px;background:');
  assert.ok(start !== -1, 'could not find the email footer band');
  const end = src.indexOf('</td></tr>', start);
  const band = src.slice(start, end === -1 ? start + 1400 : end);
  const bg = band.match(/background:([^;"]+)/);
  assert.ok(bg && /^#(fff|ffffff)$/i.test(bg[1].trim()), 'the email footer band must be white, got ' + (bg || [])[1]);
  const colours = [...band.matchAll(/color:(#[0-9a-fA-F]{3,6})/g)].map(m => m[1]);
  assert.ok(colours.length >= 3, 'expected the footer band to declare its own colours');
  for (const c of colours) {
    const ratio = contrast(c, '#ffffff');
    assert.ok(ratio >= 4.5,
      'the email footer prints ' + c + ' on white at ' + ratio.toFixed(2) + ':1 — unreadable');
  }
});

test('the site footer is not simultaneously white and white-texted', () => {
  // The specific regression this whole change fixes, pinned so it cannot return:
  // the theme's "dark surfaces keep light copy" rule must NOT claim .footer.
  // Comments are stripped first: the note explaining why .footer was REMOVED
  // from this rule mentions ".footer", and scanning raw text flags the comment.
  const theme = read('westmere-theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // There are SEVERAL rules that force white copy (pressed buttons, the fleet
  // panel, the coverage scrim). Check every one of them — matching only the
  // first made this assertion pass no matter what the footer did.
  const rules = [...theme.matchAll(/([^{}]*)\{([^{}]*-webkit-text-fill-color:\s*var\(--westmere-white\)[^{}]*)\}/g)];
  assert.ok(rules.length >= 2, 'expected several light-copy rules in the theme, found ' + rules.length);
  // Every band that has been unfilled. A rule forcing WHITE copy onto any of
  // them is the white-on-white bug, whichever one it lands on: the site footer
  // lost its contact details this way, and the pay page's header very nearly
  // lost its wordmark the same way in the same change.
  const UNFILLED = [/(^|[\s,])\.footer\b/, /(^|[\s,])[^\s,]*\.head\b/, /(^|[\s,])footer\.mini-foot\b/];
  const claiming = rules
    .filter(r => UNFILLED.some(re => re.test(r[1])))
    .map(r => r[1].trim().replace(/\s+/g, ' ').slice(0, 70));
  assert.deepStrictEqual(claiming, [],
    'a header or footer that is now WHITE is still being forced to white copy — ' +
    'its contents render invisible:\n      ' + claiming.join('\n      '));
});

// ── A SELECTED PICKER ITEM MUST SHOW ITS VALUE ───────────────────────────
// The reported bug: in My Account's date picker the selected day was a solid
// navy rounded square with no number in it — the "14" was invisible. Same in
// the passengers picker. The rules were `background:var(--navy);color:#111`:
// a dark fill with near-black text. It was never readable — against the old
// charcoal --navy (#1b1b1a) #111 measures about 1.05:1, and after the redesign
// repointed --navy to #102a43 it was still only 1.2:1. A picker whose selected
// state hides the value it selected is worse than no highlight at all.
test('every selected picker item is legible against its own fill', () => {
  const rider = read('westmere-rider.html');
  // The palette these rules resolve against: the app declares --navy, and the
  // theme (loaded last) overrides it.
  const themeNavy = (read('westmere-theme.css').match(/--westmere-navy:\s*(#[0-9a-f]{3,6})/i) || [])[1] || '#102a43';
  const appNavy = (rider.match(/--navy:\s*(#[0-9a-f]{3,6})/i) || [])[1] || themeNavy;

  const offenders = [];
  // Any rule whose selector marks a selected/active state AND paints a background.
  const RULE = /(\.[a-z0-9_-]+\.[a-z0-9_-]*(?:sel|selected|active|\bon\b)[a-z0-9_-]*)\s*\{([^{}]{0,240})\}/gi;
  for (const m of rider.matchAll(RULE)) {
    const body = m[2];
    const bgM = body.match(/background(?:-color)?:\s*([^;!}]+)/i);
    const fgM = body.match(/(?<!-)\bcolor:\s*([^;!}]+)/i);
    if (!bgM || !fgM) continue;
    const resolve = (v) => {
      v = v.trim();
      if (/^var\(--navy\)$/i.test(v)) return [appNavy, themeNavy];
      if (/^var\(--westmere-navy\)$/i.test(v)) return [themeNavy];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return [v];
      return null;                       // rgba/tint/gradient — not a solid fill
    };
    const bgs = resolve(bgM[1]), fgs = resolve(fgM[1]);
    if (!bgs || !fgs) continue;
    // Fail if the pair is unreadable under ANY palette this rule can resolve to.
    for (const bg of bgs) for (const fg of fgs) {
      const ratio = contrast(bg, fg);
      if (ratio < 4.5) offenders.push(`${m[1]}  ${fg} on ${bg} → ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepStrictEqual([...new Set(offenders)], [],
    'a selected picker/menu item is invisible against its own background — the ' +
    'customer sees a solid block with no value in it:\n      ' + [...new Set(offenders)].join('\n      '));
});

// The test above reads the app's own stylesheet, and the app's own rule DOES
// say white. That was not enough, and this is the lesson: westmere-theme.css
// carries a blanket `#scr-app *{color:…!important}` legibility rule, so an
// app-level rule without !important never reaches the screen. The selected day
// stayed navy-on-navy in production while the app's CSS looked correct — and a
// file:// render could not show it, because the theme is loaded by absolute
// path and simply does not load there. So: whenever a blanket rule forces a
// colour across the whole app, every navy-FILLED selected state must appear in
// the theme's exception list, which is the only thing that can outrank it.
test('a blanket !important text rule cannot repaint a filled picker selection', () => {
  const theme = read('westmere-theme.css');
  const rider = read('westmere-rider.html');

  const blanket = [...theme.matchAll(/([^{}]*\*[^{}]*)\{([^{}]*)\}/g)].filter(m =>
    /#scr-app\s*\*/.test(m[1]) && /color:[^;]*!important/.test(m[2]));
  if (!blanket.length) return;   // no blanket rule → nothing can be overridden

  // Every selected state in the app that paints a solid navy fill.
  const filled = [...rider.matchAll(/(\.[a-z0-9_-]+\.[a-z0-9_-]*sel[a-z0-9_-]*)\s*\{([^{}]{0,200})\}/gi)]
    .filter(m => /background:\s*var\(--navy\)|background:\s*#102a43|background:\s*#1b1b1a/i.test(m[2]))
    .map(m => m[1]);
  assert.ok(filled.length >= 3, 'expected the filled picker selected-states, found ' + filled.length);

  // The theme's exception list: rules that restore white WITH !important.
  const exceptions = [...theme.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => /color:\s*var\(--westmere-white\)\s*!important/.test(m[2]))
    .map(m => m[1]).join(' ');

  const missing = filled.filter(sel => !exceptions.includes(sel));
  assert.deepStrictEqual(missing, [],
    'these navy-filled picker selections are not in westmere-theme.css\'s white-copy ' +
    'exception list, so the blanket #scr-app * rule repaints them navy-on-navy and the ' +
    'customer sees a solid block with no value in it: ' + missing.join(', '));
});

test('the picker exception restores the text FILL colour too, not just colour', () => {
  // The blanket rule sets -webkit-text-fill-color as well; an override that
  // only sets `color` loses on iOS Safari, which is the device this was
  // reported on.
  const theme = read('westmere-theme.css');
  const rule = theme.match(/#scr-app \.cal-day\.cal-sel[^{]*\{([^}]*)\}/);
  assert.ok(rule, 'the theme must carry a white-copy exception for the picker selection');
  assert.ok(/-webkit-text-fill-color:\s*var\(--westmere-white\)\s*!important/.test(rule[1]),
    'the exception must also set -webkit-text-fill-color, or iOS keeps the navy fill');
});

test('the date, time and passenger/bags pickers all declare a selected state', () => {
  // The bug hit three separate rules; if one is ever dropped the test above has
  // nothing to check, so pin that all three still exist.
  const rider = read('westmere-rider.html');
  for (const sel of ['.cal-day.cal-sel', '.time-opt.t-sel', '.pick-opt.p-sel']) {
    const re = new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*\\}');
    const m = rider.match(re);
    assert.ok(m, 'missing the selected-state rule for ' + sel);
    assert.ok(/color:\s*#f{3,6}|color:\s*#ffffff/i.test(m[0]),
      sel + ' must set white text on its navy fill: ' + m[0]);
  }
});

test('the invoice PDF embeds Cormorant rather than a base-14 serif', () => {
  const src = read('server/invoice-pdf.js');
  // pdfkit cannot fetch a web font, so the face has to ship with the app.
  assert.ok(/registerFont\(/.test(src), 'invoice-pdf.js must register the Cormorant faces');
  for (const w of ['Cormorant-Regular.ttf', 'Cormorant-SemiBold.ttf']) {
    assert.ok(src.includes(w), 'invoice-pdf.js must reference ' + w);
    const p = path.join(ROOT, 'assets', 'fonts', w);
    assert.ok(fs.existsSync(p), 'the font must ship with the app: assets/fonts/' + w);
    // Big enough to be a real font, small enough that it was subset.
    const kb = fs.statSync(p).size / 1024;
    assert.ok(kb > 20 && kb < 300, 'assets/fonts/' + w + ' is ' + kb.toFixed(0) + 'kB — expected a subset face');
  }
  // The PDF base-14 faces are what it used to draw with; none may remain.
  for (const face of ['Times-Roman', 'Times-Bold', 'Helvetica-Bold', 'Helvetica-Oblique']) {
    assert.ok(!src.includes("'" + face + "'"), 'invoice-pdf.js still draws with ' + face);
  }
  assert.ok(!/\.font\('Helvetica'\)/.test(src), 'invoice-pdf.js still draws with Helvetica');
});

test("My Account's canvas is white, not a photographic cream veil", () => {
  // The cream sweep scans declared COLOUR values, so it could never have caught
  // this one: My Account's app shell painted the Sussex coast photo behind a
  // 90–95.5% white veil, and the composite came out #f3f2f0 — hue 40°, inside
  // the cream band. The page's own comment called it a "cream veil over the
  // coast". It is why the dashboard and My Details looked like different
  // backgrounds: both had it, but the dashboard covers it with opaque cards.
  assert.ok(/\.screen::before\s*\{[^}]*background:\s*var\(--westmere-white\)\s*!important/.test(read('westmere-theme.css')),
    'westmere-theme.css must neutralise .screen::before to flat white — without it ' +
    "My Account's canvas is a warm off-white and stops matching the rest of the site");

  // …while the scenery BEHIND the sheet stays. That one is deliberate, and
  // rider-cache.test.js guards it separately.
  const rider = read('westmere-rider.html');
  assert.ok(/body::before\s*\{[^}]*sussex-coast\.webp/.test(rider),
    'the fixed backdrop behind the sheet must stay — it is the app\'s sense of place');
});

test('NO --cream or --gold token is defined or referenced', () => {
  // Re-pointing the tokens at navy was not enough: the owner wants them gone, so
  // that no future rule can reach for one and no page can degrade back to gold
  // if the theme fails to load.
  for (const f of PAGES_AND_CSS) {
    read(f).split('\n').forEach((text, i) => {
      const m = text.match(/--[a-z0-9-]*(?:gold|cream)[a-z0-9-]*/i);
      assert.ok(!m, f + ':' + (i + 1) + ' still carries the token ' + (m || [''])[0] +
        ' — cream and gold should not exist in the code');
    });
  }
});

// ── The one typeface is Cormorant ────────────────────────────────────────
// ── ONE TYPEFACE, DECLARED ONCE ──────────────────────────────────────────
// The owner's brief: the SAME font everywhere — headings and body/UI alike —
// because inconsistent type is a large part of why My Account read as a
// different product from the public site. So the stack lives in exactly one
// place and every surface inherits it.
const THEME = 'westmere-theme.css';

test('the type stack is declared ONCE, in the theme, and leads with Cormorant', () => {
  const defs = [];
  for (const f of PAGES_AND_CSS) {
    const re = /--(?:serif|sans|westmere-type):\s*([^;]+);/gi;
    let m;
    while ((m = re.exec(read(f))) !== null) defs.push({ file: f, stack: m[1].trim() });
  }
  const strays = defs.filter(d => d.file !== THEME);
  assert.deepStrictEqual(strays.map(d => d.file + ' → ' + d.stack.slice(0, 40)), [],
    'only ' + THEME + ' may define the type stack — a page that defines its own ' +
    'is exactly how My Account drifted away from the rest of the site');

  const stack = defs.find(d => /Cormorant/i.test(d.stack)).stack;
  assert.ok(/^['"]?Cormorant['"]?\s*,/i.test(stack),
    'the type stack must lead with Cormorant (got: ' + stack.slice(0, 60) + ')');
  // Cormorant is a Google web font, which is the whole point: it renders the
  // same on every device. The system faces after it are only a fetch-failure
  // safety net and must never lead.
  assert.ok(!/^['"]?Didot/i.test(stack),
    'Didot must not lead — it is an Apple system font, so the site would look ' +
    'different on the owner\'s phone than on everyone else\'s');
  assert.ok(/,\s*serif\s*$/i.test(stack), 'the stack must end in the generic `serif`');
});

test('--serif and --sans resolve to the SAME stack — one font, not two', () => {
  const theme = read(THEME);
  const serif = (theme.match(/--serif:\s*([^;]+);/) || [])[1];
  const sans = (theme.match(/--sans:\s*([^;]+);/) || [])[1];
  assert.ok(serif && sans, 'the theme must define both --serif and --sans');
  assert.strictEqual(serif.trim(), sans.trim(),
    'body/UI text must use the same face as the headings — the owner asked for ONE font ' +
    '(--serif: ' + serif + ' / --sans: ' + sans + ')');
  assert.ok(/var\(--westmere-type\)/.test(serif),
    'both should point at --westmere-type so the face changes in one edit');
});

test('NO surface declares a font-family outside the shared stack', () => {
  // `.google-g` renders Google's own "G" letterform inside the sign-in button.
  // Google's brand terms require their mark be shown in their typeface, so this
  // one declaration is a deliberate, documented exception.
  const ALLOWED_LITERAL = /^Cormorant,\s*Cormorant Garamond,\s*Didot,\s*Bodoni MT,\s*Georgia,\s*serif$/i;
  const offenders = [];
  for (const f of PAGES_AND_CSS) {
    read(f).split('\n').forEach((text, i) => {
      const re = /font-family:\s*([^;!}"'\n]+)/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        const v = m[1].trim().replace(/\s+/g, ' ');
        if (/^var\(--(serif|sans|westmere-type)\)$/.test(v)) continue;   // the tokens
        if (v === 'inherit') continue;                                    // inherits the tokens
        if (ALLOWED_LITERAL.test(v)) continue;                            // JS-string contexts
        if (/^Arial,\s*sans-serif$/i.test(v) && /google-g/.test(text)) continue;  // Google's mark
        offenders.push(f + ':' + (i + 1) + '  ' + v.slice(0, 60));
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'every surface must take its type from the theme:\n      ' + offenders.slice(0, 15).join('\n      '));
});

test('the transactional emails use the same stack', () => {
  const email = read('server/email.js');
  assert.ok(!/font-family:Georgia,\s*serif/i.test(email),
    'server/email.js still sends bare Georgia — the emails would not match the site');
  const stacks = [...new Set(email.match(/font-family:Cormorant[^;"'}]*/gi) || [])];
  assert.ok(stacks.length >= 1, 'server/email.js does not use the Cormorant stack');
  assert.strictEqual(stacks.length, 1, 'the emails use more than one stack: ' + stacks.join(' | '));
  // Email clients do not load web fonts, so Cormorant will NOT arrive there —
  // the chain has to end on something every mail client already has.
  assert.ok(/Georgia,\s*serif$/i.test(stacks[0]),
    'the email stack must end in Georgia — email clients cannot fetch a web font, ' +
    'so Georgia is what actually renders in the inbox');
});

test('the change-request views are monochrome too', () => {
  // The owner's reference is the logo: black on white. These panels used to be
  // gold-washed, which is the look he rejected.
  const GOLD = /(#b78635|#b89045|#8a5a1a|#9c5800|184,\s*152,\s*90|156,\s*88,\s*0)/i;
  for (const f of ['westmere-rider.html', 'westmere-owner.html', 'westmere-admin.html']) {
    const hit = read(f).split('\n').find(l => GOLD.test(l));
    assert.ok(!hit, f + ' still has a gold accent: ' + (hit || '').trim().slice(0, 100));
  }
});

// ── (c) A future colour change is ONE edit ───────────────────────────────
test('every colour comes from a token — nothing below hard-codes one', () => {
  const tokenBlock = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('/* ── Base'));
  const rest = CSS.slice(CSS.indexOf('/* ── Base'));
  assert.ok(/--wmb-ink:/.test(tokenBlock) && /--wmb-surface:/.test(tokenBlock), 'palette tokens missing');
  // #fff / #1b1b1a appear only as the invert pair, and only via tokens.
  const literals = (rest.match(/#[0-9a-f]{3,8}\b/gi) || []).filter(c => !/^#(fff|ffffff)$/i.test(c));
  assert.deepStrictEqual(literals, [],
    'hard-coded colours below the token block defeat "one edit changes everything": ' + literals.join(', '));
});

// ── (d) No solid black buttons anywhere ──────────────────────────────────
test('no stylesheet rule gives a button a solid black background', () => {
  for (const f of SURFACES.concat(['wm-buttons.css', 'styles.css'])) {
    const src = read(f);
    // Rules whose selector names a button and whose body sets a dark background.
    const re = /([^{}]*\b(?:btn|button|wm-btn)[^{}]*)\{([^}]*)\}/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const sel = m[1].trim(), body = m[2];
      if (/^\s*@/.test(sel)) continue;
      const bg = body.match(/background(?:-color)?:\s*([^;!]+)/i);
      if (!bg) continue;
      assert.ok(!DARK.test(bg[1]),
        f + ': "' + sel.split('\n').pop().trim().slice(0, 70) + '" fills a button with ' +
        bg[1].trim() + ' — solid black button fills are exactly what was removed');
    }
  }
});

test('no <button> carries a solid black background in an inline style', () => {
  for (const f of SURFACES) {
    const src = read(f);
    // <button …> tags plus buttons built inside JS strings.
    const re = /<button[^>]*style="([^"]*)"/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const style = m[1];
      const bg = style.match(/background(?:-color)?:\s*([^;]+)/i);
      if (!bg) continue;
      assert.ok(!DARK.test(bg[1]),
        f + ': an inline button style fills with ' + bg[1].trim() +
        ' — inline styles beat the shared stylesheet, so this would be a black button again');
    }
  }
});

test('no button declares a square radius', () => {
  for (const f of SURFACES) {
    const src = read(f);
    const re = /<button[^>]*style="([^"]*)"/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      assert.ok(!/border-radius:\s*0(px)?\b/.test(m[1]),
        f + ': an inline button style forces square corners');
    }
  }
});

// ── (e) The change-request panels use the shared classes ─────────────────
test('the change-request and fare-step buttons use the shared classes', () => {
  const owner = read('westmere-owner.html');
  for (const label of ['Accept change', 'Decline', 'Message customer',
                       'Send updated estimate', 'Keep current fare', 'Reviewed']) {
    const i = owner.indexOf('>' + label + '</button>');
    assert.ok(i !== -1, 'owner app no longer has a "' + label + '" button');
    const tag = owner.slice(owner.lastIndexOf('<button', i), i);
    assert.ok(/class="wm-btn wm-btn-(primary|ghost|danger)/.test(tag),
      '"' + label + '" must use the shared button classes (got: ' + tag.slice(0, 90) + ')');
  }
});

test('the admin equivalents go through the shared legacy map', () => {
  const admin = read('westmere-admin.html');
  for (const label of ['Accept change', 'Decline', 'Send updated estimate']) {
    const i = admin.indexOf('>' + label + '</button>');
    assert.ok(i !== -1, 'admin app no longer has a "' + label + '" button');
    const tag = admin.slice(admin.lastIndexOf('<button', i), i);
    assert.ok(/class="(btn |wm-btn )/.test(tag),
      '"' + label + '" must carry a shared button class (got: ' + tag.slice(0, 90) + ')');
  }
  // …and those legacy names really are mapped in the shared file.
  for (const cls of ['.btn-navy', '.btn-ghost', '.btn-cancel-trip']) {
    assert.ok(CSS.indexOf(cls) !== -1, cls + ' is used by the apps but not mapped in wm-buttons.css');
  }
});

test("My Account's Save Changes and Sign Out are on the shared system", () => {
  const rider = read('westmere-rider.html');
  const save = rider.slice(rider.lastIndexOf('<button', rider.indexOf('>Save Changes</button>')),
                           rider.indexOf('>Save Changes</button>'));
  assert.ok(/class="btn-main/.test(save) || /wm-btn/.test(save),
    'Save Changes must use a shared button class');
  assert.ok(CSS.indexOf('.btn-main') !== -1, '.btn-main must be mapped in wm-buttons.css');
  const out = rider.slice(rider.lastIndexOf('<button', rider.indexOf('>Sign Out</button>')),
                          rider.indexOf('>Sign Out</button>'));
  assert.ok(/wm-btn/.test(out), 'Sign Out must use the shared button classes (got: ' + out.slice(0, 90) + ')');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/button-style\.test\.js/.test(read('package.json')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
