/**
 * FAVICON — run with:
 *   node server/tests/favicon.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   The owner reported the browser tab showing "a black square". It was not a
 *   caching problem and not a missing file: every page carried an INLINE
 *   data-URI SVG favicon that drew a navy letter W (#102a43) on a dark plate
 *   (#1b1b1a or #111D2C). Contrast 1.18:1 and 1.16:1 — at 16px that is a solid
 *   dark square with no discernible letter. It was invisible for as long as the
 *   redesign had been live, because the letter was recoloured to the new brand
 *   navy and the plate underneath it was never revisited.
 *
 *   That is the failure this file exists to catch: not "is there an icon" (there
 *   always was) but "can the mark actually be SEEN". A contrast assertion is the
 *   only form of that check a test can make.
 *
 *   The mark itself has since changed — it is now the capital W outlined from
 *   the same Cormorant as the WESTMERE wordmark, in the wordmark's own colour,
 *   on white. The assertions below are deliberately about legibility and format
 *   rather than about a particular shape, so new artwork can land without
 *   rewriting the guard.
 *
 * WHAT IS PINNED
 *   · the mark reads against its own ground at >= 4.5:1, so recolouring one
 *     without the other fails here rather than in the owner's tab;
 *   · the mark is the WORDMARK's colour — if the brand navy moves in the theme
 *     and the favicon does not follow, the tab stops matching the site;
 *   · every page carries the same five icon links, so a rebuilt page cannot
 *     quietly drop back to the browser's default;
 *   · no page reintroduces an inline data: URI icon — those are what drifted,
 *     precisely because they are invisible in a diff and duplicated 19 times;
 *   · every referenced icon file exists, is non-empty and is the format its
 *     link claims (the .ico is parsed as a real ICO container);
 *   · theme-color is never a dark colour. Every page body is #ffffff (forced by
 *     westmere-theme.css), so a dark theme-color paints the mobile browser
 *     chrome black around a white page — the same "black" complaint, one
 *     element higher;
 *   · the manifests declare icons that exist on disk, including a maskable one.
 *
 * Pure static analysis of the shipped files. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const bytes = (rel) => fs.readFileSync(path.join(ROOT, rel));
const PAGES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

// ── WCAG relative luminance / contrast ──────────────────────────────────
function srgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
}
function lum(hex) {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

console.log('\nFAVICON\n');

// ── 1. THE ACTUAL DEFECT ────────────────────────────────────────────────
// The mark may be a filled glyph outline or a stroked path; measure whichever
// it is against the ground rect. What must never come back is a mark and a
// ground that are the same darkness.
function markColour(svg) {
  const fill = (svg.match(/<path[^>]*\sfill=['"](#[0-9a-fA-F]{3,6})['"]/) || [])[1];
  const stroke = (svg.match(/<path[^>]*\sstroke=['"](#[0-9a-fA-F]{3,6})['"]/) || [])[1];
  return fill && fill.toLowerCase() !== 'none' ? fill : stroke;
}

test('the mark is legible against its own ground (>= 4.5:1)', () => {
  const svg = read('favicon.svg');
  const ground = (svg.match(/<rect[^>]*fill=['"](#[0-9a-fA-F]{3,6})['"]/) || [])[1];
  const mark = markColour(svg);
  assert.ok(ground, 'favicon.svg has no background <rect fill="#…"> to measure');
  assert.ok(mark, 'favicon.svg has no <path> fill or stroke colour to measure');
  const ratio = contrast(mark, ground);
  assert.ok(ratio >= 4.5,
    'the favicon mark is ' + ratio.toFixed(2) + ':1 against its ground (' + mark +
    ' on ' + ground + '). Below 4.5:1 it reads as a flat square at 16px — this is ' +
    'exactly the "black square" the owner reported. Recolour BOTH, not one.');
  console.log('      ' + mark + ' on ' + ground + ' = ' + ratio.toFixed(2) + ':1');
});

test('the mark wears the wordmark\'s own colour', () => {
  // The favicon is the WESTMERE wordmark's W. styles.css paints .brand with
  // var(--ink), which westmere-theme.css resolves to --westmere-navy. Read that
  // token rather than hard-coding a hex, so moving the brand navy moves both or
  // fails here.
  const navy = (read('westmere-theme.css').match(/--westmere-navy:\s*(#[0-9a-fA-F]{3,6})/) || [])[1];
  assert.ok(navy, 'could not read --westmere-navy out of westmere-theme.css');
  const mark = markColour(read('favicon.svg'));
  assert.strictEqual(mark.toLowerCase(), navy.toLowerCase(),
    'the favicon mark is ' + mark + ' but the wordmark is ' + navy + '. The tab ' +
    'icon is the wordmark\'s letter — they have to be the same colour.');
});

test('the mark is drawn as geometry, not as <text>', () => {
  const svg = read('favicon.svg');
  assert.ok(!/<text/i.test(svg),
    'favicon.svg draws the W with <text>. A favicon is rendered without the ' +
    "page's webfonts, so font-family is a suggestion the OS resolves however it " +
    'likes — the mark then changes shape between macOS, Windows and Android. ' +
    'Use a <path>.');
  assert.ok(/<path/i.test(svg), 'favicon.svg has no <path> — there is no mark to draw');
});

// ── 2. EVERY PAGE, THE SAME FIVE LINKS ──────────────────────────────────
const REQUIRED = [
  [/<link rel="icon" href="\/favicon\.ico"[^>]*>/, 'favicon.ico'],
  [/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/, 'favicon.svg'],
  [/<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32x32\.png">/, '32x32 png'],
  [/<link rel="icon" type="image\/png" sizes="16x16" href="\/favicon-16x16\.png">/, '16x16 png'],
  [/<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png">/, 'apple-touch-icon'],
];

test('every page links the full icon set', () => {
  const missing = [];
  for (const f of PAGES) {
    const src = read(f);
    for (const [re, label] of REQUIRED) if (!re.test(src)) missing.push(f + ': missing ' + label);
  }
  assert.deepStrictEqual(missing, [],
    'a page is not linking the icon set:\n      ' + missing.join('\n      '));
  console.log('      ' + PAGES.length + ' pages');
});

test('no page carries an inline data: URI icon', () => {
  // The drift happened because the icon was 19 copies of an unreadable base64-ish
  // blob inside <head>. Nobody reviews those, so nobody noticed the colours had
  // stopped matching. Real files are reviewable and there is one of each.
  const bad = PAGES.filter((f) => /<link[^>]*rel="(?:shortcut )?icon"[^>]*href="data:/i.test(read(f)));
  assert.deepStrictEqual(bad, [],
    'inline data: URI favicon is back on: ' + bad.join(', ') +
    '. Point at /favicon.svg instead — a file can be reviewed and is one copy, not 19.');
});

// ── 3. THE FILES EXIST AND ARE WHAT THEY CLAIM ──────────────────────────
test('every referenced icon file exists and is the right format', () => {
  const png = (rel) => {
    const b = bytes(rel);
    assert.ok(b.length > 100, rel + ' is only ' + b.length + ' bytes');
    assert.ok(b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      rel + ' is not a PNG');
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  const want = {
    'favicon-16x16.png': 16, 'favicon-32x32.png': 32, 'apple-touch-icon.png': 180,
    'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512,
  };
  for (const [rel, size] of Object.entries(want)) {
    const { w, h } = png(rel);
    assert.strictEqual(w + 'x' + h, size + 'x' + size, rel + ' is ' + w + 'x' + h + ', expected ' + size + 'px square');
  }
  assert.ok(/^<svg[^>]*viewBox=/.test(read('favicon.svg').trim()), 'favicon.svg is not an SVG with a viewBox');
});

test('favicon.ico is a real ICO container with 16/32/48 entries', () => {
  // A .ico that is secretly a renamed PNG works in Chrome and fails in the
  // places that still fetch /favicon.ico blind — feed readers, some crawlers,
  // older Windows shells. Parse the container rather than trusting the name.
  const b = bytes('favicon.ico');
  assert.strictEqual(b.readUInt16LE(0), 0, 'favicon.ico: bad reserved field — not an ICO');
  assert.strictEqual(b.readUInt16LE(2), 1, 'favicon.ico: type is not 1 (icon)');
  const count = b.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    sizes.push(b[e] === 0 ? 256 : b[e]);
    const len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    assert.ok(off + len <= b.length, 'favicon.ico entry ' + i + ' points past the end of the file');
  }
  for (const s of [16, 32, 48]) {
    assert.ok(sizes.includes(s), 'favicon.ico has no ' + s + 'px entry (has: ' + sizes.join(', ') + ')');
  }
  console.log('      ' + count + ' entries: ' + sizes.join(', ') + 'px');
});

// ── 4. THEME-COLOR ──────────────────────────────────────────────────────
test('theme-color never paints the chrome dark', () => {
  // westmere-theme.css sets `body { background: #ffffff !important }` site-wide.
  // A theme-color left over from the dark palette (#1b1b1a, #111D2C) puts a
  // black bar above a white page on Android Chrome and iOS Safari — read by the
  // owner as the same problem as the black tab icon.
  const bad = [];
  for (const f of PAGES) {
    const m = read(f).match(/<meta name="theme-color" content="(#[0-9a-fA-F]{3,6})"/i);
    if (!m) { bad.push(f + ': no theme-color at all'); continue; }
    if (lum(m[1]) < 0.5) bad.push(f + ': theme-color ' + m[1] + ' is dark (luminance ' + lum(m[1]).toFixed(3) + ')');
  }
  assert.deepStrictEqual(bad, [],
    'theme-color is wrong on:\n      ' + bad.join('\n      '));
});

// ── 5. MANIFESTS ────────────────────────────────────────────────────────
test('every manifest declares icons that exist, including a maskable one', () => {
  const manifests = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.webmanifest') || f === 'rider-manifest.json').sort();
  assert.ok(manifests.length >= 3, 'expected the owner/driver/rider manifests, found ' + manifests.length);
  const bad = [];
  for (const m of manifests) {
    const j = JSON.parse(read(m));
    const icons = j.icons || [];
    if (!icons.length) { bad.push(m + ': declares no icons — the installed app falls back to a screenshot of the page'); continue; }
    for (const i of icons) {
      if (!fs.existsSync(path.join(ROOT, i.src.replace(/^\//, '')))) bad.push(m + ': ' + i.src + ' does not exist');
    }
    if (!icons.some((i) => /maskable/.test(i.purpose || ''))) {
      bad.push(m + ': no maskable icon — Android crops the square one to a circle and clips the mark');
    }
    for (const k of ['theme_color', 'background_color']) {
      if (j[k] && lum(j[k]) < 0.5) bad.push(m + ': ' + k + ' ' + j[k] + ' is from the retired dark palette');
    }
  }
  assert.deepStrictEqual(bad, [], 'manifest problems:\n      ' + bad.join('\n      '));
  console.log('      ' + manifests.join(', '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/favicon\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
