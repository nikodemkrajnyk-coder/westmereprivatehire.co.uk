/**
 * EVERYTHING ON THE MONEY SCREENS IS READABLE — run with:
 *   node server/tests/legibility.test.js   (also gated by `npm test`)
 *
 * WHY THESE SCREENS IN PARTICULAR
 *   The owner app paints its own type navy through one blanket rule
 *   (westmere-theme.css §15.2: `#scr-app, #scr-app * { color: … !important }`),
 *   so whatever faint grey a card names inside the page is overridden and
 *   reads at 14:1 whether it deserves to or not.
 *
 *   The three layers he actually reads money on are NOT inside #scr-app. The
 *   driver page, the operator page and the send sheet are appended to
 *   document.body so they can cover the app, and the blanket never reaches
 *   them: what the markup names is exactly what renders. They named
 *   rgba(27,27,26,.45) and .5 for dates, references and the working under each
 *   figure — measured on the real screens, 2.84:1 and 3.27:1 against the 4.5
 *   that ten-pixel type needs.
 *
 * WHAT IS GUARDED
 *   The arithmetic, not a list of forbidden colours: every ink named in those
 *   layers is composited over the paper it sits on and must clear AA. A new
 *   faint grey fails whether or not anybody thought to add it here.
 *
 * AND THE MEASUREMENT ITSELF
 *   Two separate attempts at this sweep were wrong in ways that LOOKED
 *   rigorous: one blended the two luminances instead of compositing the
 *   channels (calling 5.3:1 "2.6:1"), the other lost its regex escapes inside
 *   a template literal and reported a clean sweep of nothing at all. Both are
 *   pinned below, because a measurement nobody checks is worse than none.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { regionFrom } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── The same arithmetic the browser sweep uses ───────────────────────────
const rgba = (r, g, b, a) => ({ r, g, b, a: a === undefined ? 1 : a });
const WHITE = rgba(255, 255, 255);

function lum(c) {
  const f = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
/* CHANNELS, then luminance. The other way round is a different answer. */
function over(f, b) {
  if (f.a >= 1) return f;
  return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 };
}
function ratio(ink, paper) {
  /* THE PAPER IS FLATTENED FIRST. A six-per-cent wash of near-black is a very
     pale grey on a white page, not a near-black surface — judging the ink
     against its raw colour called every tinted chip in My Account a 1:1
     failure. Flatten the paper onto white, then composite the ink onto that. */
  const p = over(paper, WHITE);
  const L1 = lum(over(ink, p)), L2 = lum(p);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

const CARD  = rgba(246, 248, 250);   // #F6F8FA — a settled job, and the money panel

test('the arithmetic is right — channels composited, then converted', () => {
  /* The number that caught the first wrong sweep. rgba(27,27,26,.65) on white
     composites to rgb(106,106,105), which is 5.35:1. Blending the luminances
     gives 2.58:1 — a sweep built that way condemns readable type and the
     report looks just as confident. */
  assert.strictEqual(Math.round(ratio(rgba(27, 27, 26, .65), WHITE) * 100) / 100, 5.35);
  assert.strictEqual(Math.round(ratio(rgba(27, 27, 26, .45), WHITE) * 100) / 100, 2.87);
  assert.strictEqual(Math.round(ratio(rgba(16, 42, 67), WHITE) * 100) / 100, 14.64,
    'navy on white — the figure the rest of the app measures at');
});

// ── 1. THE LAYERS OUTSIDE #scr-app ───────────────────────────────────────
console.log('\nThe screens the blanket navy does not reach');

/* Each is read as the function that builds it, bounded by the next function —
   never by a character count. */
const LAYERS = [
  ['the driver page',    'async function owDriverLoad'],
  ['the operator page',  'async function owOperatorLoad'],
  ['the send sheet',     'async function dispOpen'],
  ['its money block',    'function dispMoneyHtml'],
  ['the operator money', 'function dispOperatorMoneyHtml'],
  ['the commission choice', 'function dispCommHtml']
];
const INK = /(?:^|[:;'"\s])color\s*:\s*(rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\))/g;

for (const [what, marker] of LAYERS) {
  test(what + ': every ink it names clears AA', () => {
    const src = read('westmere-owner.html');
    const block = regionFrom(src, marker, [/\nfunction /, /\nasync function /]);
    const bad = [];
    let m;
    INK.lastIndex = 0;
    while ((m = INK.exec(block))) {
      const ink = rgba(+m[2], +m[3], +m[4], m[5] === undefined ? 1 : +m[5]);
      /* Judged against BOTH grounds these layers use: the white sheet and the
         tinted card a settled job sits on. The worse of the two is the one
         somebody reads. */
      const r = Math.min(ratio(ink, WHITE), ratio(ink, CARD));
      if (r < 4.5) bad.push(m[1] + '  →  ' + r.toFixed(2) + ':1');
    }
    assert.deepStrictEqual(bad, [],
      what + ' names ink that cannot be read on the paper it sits on. This layer is appended to '
      + 'document.body, so §15.2 never repaints it — use var(--westmere-ink-soft):\n      ' + bad.join('\n      '));
  });
}

test('the soft ink token exists and is worth using', () => {
  const T = read('westmere-theme.css');
  const m = /--westmere-ink-soft:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(T);
  assert.ok(m, 'the theme has no --westmere-ink-soft — the layers reference a token that does not exist');
  const ink = rgba(+m[1], +m[2], +m[3], +m[4]);
  assert.ok(ratio(ink, WHITE) >= 4.5, 'the soft ink fails on white: ' + ratio(ink, WHITE).toFixed(2));
  assert.ok(ratio(ink, CARD) >= 4.5, 'the soft ink fails on the tinted card: ' + ratio(ink, CARD).toFixed(2));
  assert.ok(ratio(ink, WHITE) < 9,
    'it is no longer SOFT — secondary type that measures the same as a heading is just type');
});

test('the layers use the token rather than naming a grey', () => {
  const src = read('westmere-owner.html');
  let used = 0;
  for (const [, marker] of LAYERS) {
    used += (regionFrom(src, marker, [/\nfunction /, /\nasync function /]).match(/var\(--westmere-ink-soft\)/g) || []).length;
  }
  assert.ok(used >= 10, 'only ' + used + ' uses of the token — the greys have crept back in by hand');
});

// ── 2. THE BROWSER SWEEP IT MIRRORS ──────────────────────────────────────
test('the rendered sweep composites the same way, and judges against AA', () => {
  /* _dark-render.js measures the booking page in a real browser. It had the
     luminance-blend bug too, and a 3:1 floor that let small type through. */
  const s = read('server/tests/_dark-render.js');
  assert.ok(/function over\(f,b\)\{ if\(f\.a>=1\)/.test(s.replace(/\s+/g, ' ').replace(/ \{/g, '{')),
    'the rendered sweep no longer composites alpha in channel space');
  assert.ok(/px>=18\.66&&bold/.test(s.replace(/\s/g, '')),
    'it must use the AA thresholds — 4.5, or 3 for large text — not one flat number');
  assert.ok(/ratio<need/.test(s.replace(/\s/g, '')), 'and compare against them');
});

test('NEGATIVE: the reader catches a faint grey, and passes a readable one', () => {
  const sample = "'<div style=\"color:rgba(27,27,26,.45)\">x</div>'";
  INK.lastIndex = 0;
  const m = INK.exec(sample);
  assert.ok(m, 'the ink reader does not see a colour written the way this app writes them');
  assert.ok(ratio(rgba(+m[2], +m[3], +m[4], +m[5]), WHITE) < 4.5, 'and must call .45 what it is');
  INK.lastIndex = 0;
  const ok = INK.exec("'<div style=\"color:rgba(27,27,26,.7)\">x</div>'");
  assert.ok(ratio(rgba(+ok[2], +ok[3], +ok[4], +ok[5]), WHITE) >= 4.5, 'and must not condemn a readable one');
});

// ── 3. ANYTHING THAT DECLARES BOTH MUST BE READABLE AS WRITTEN ───────────
console.log('\nNothing names an ink it cannot be read in');

/* THE BLACK BOX. The owner photographed the confirmation that an estimate had
   gone out: near-black ink on near-black paper. It was not the phone and it was
   not night mode — #toast had `background: rgba(27,27,26,.92)` with
   `color:#1a1a1a`, 1.27:1, since the restyle flipped the ink and left the
   paper. It had been that way in every mode, on every device.

   So: when a rule or an inline style names BOTH its paper and its ink, it is
   declaring a self-contained surface, and it must be readable on its own terms.
   Not "readable once §15.2's blanket repaints the ink navy" — the toast sits
   outside #scr-app where the blanket never reaches, and navy on that paper is
   1.07:1 anyway. A colour that depends on being overridden is not a colour. */
function pairs(file) {
  const src = read(file);
  const out = [];
  const chunks = [...src.matchAll(/style="([^"]*)"/g)].map((m) => [m[1], m.index])
    .concat([...src.matchAll(/\{([^{}]*)\}/g)].map((m) => [m[1], m.index]));
  for (const [decl, idx] of chunks) {
    const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(decl);
    const fg = /(?:^|;)\s*color\s*:\s*([^;!]+)/i.exec(decl);
    if (!bg || !fg) continue;
    const paper = css(bg[1]), ink = css(fg[1]);
    if (!paper || !ink) continue;          // a var() or a keyword — not ours to judge
    out.push({ line: src.slice(0, idx).split('\n').length, ink: fg[1].trim(), paper: bg[1].trim(),
               ratio: ratio(ink, paper) });
  }
  return out;
}
function css(v) {
  v = (v || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return rgba((n >> 16) & 255, (n >> 8) & 255, n & 255); }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(v);
  if (m) return rgba(+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]);
  return null;
}

for (const file of ['westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html',
                    'westmere-rider.html', 'book.html', 'index.html', 'westmere-pay.html']) {
  test(file + ': every surface can be read on its own paper', () => {
    const bad = pairs(file).filter((p) => p.ratio < 3)
      .map((p) => file + ':' + p.line + '  ' + p.ratio.toFixed(2) + ':1  ' + p.ink + ' on ' + p.paper);
    assert.deepStrictEqual(bad, [],
      'these name an ink and a paper that cannot be read together:\n      ' + bad.join('\n      '));
  });
}

test('the confirmation after an estimate is a light card', () => {
  /* The exact surface he photographed, named rather than swept for: it is the
     one the owner sees most, and it is outside the app root where nothing else
     will catch it. */
  const H = read('westmere-owner.html');
  const i = H.indexOf('#toast{');
  assert.ok(i > -1, 'the toast is gone');
  const rule = H.slice(i, H.indexOf('}', i));
  const bg = css((/background\s*:\s*[^;]*?(#[0-9a-f]{6})/i.exec(rule) || [])[1] || '');
  assert.ok(bg && lum(bg) > 0.7, 'the confirmation is not on light paper: ' + rule);
  assert.ok(/color-scheme\s*:\s*only light/.test(rule),
    'and it must refuse the phone\'s repaint like every other layer outside the app');
  assert.ok(/border\s*:\s*1px solid/.test(rule), 'a card needs a rim to read as one against the page');
  /* The tick beside the message is navy on that paper — it was navy on black. */
  assert.ok(/<div id="toast"><span style="color:var\(--navy\)/.test(H), 'the tick lost its colour');
});

test('both staff apps still have a toast at all', () => {
  /* Deleting it would pass every assertion above. */
  for (const [f, sel] of [['westmere-owner.html', '#toast{'], ['westmere-admin.html', '.toast{']]) {
    assert.ok(read(f).includes(sel), f + ' no longer has a confirmation surface');
  }
});

test('NEGATIVE: the pair reader catches the bug it was written for', () => {
  const t = pairs('westmere-owner.html');
  assert.ok(t.length > 20, 'the reader found almost no pairs — it is not reading the file');
  /* The toast as it was. */
  assert.ok(ratio(css('#1a1a1a'), css('rgba(27,27,26,.92)')) < 1.5,
    'the reader would not have called the black box a black box');
  assert.ok(ratio(css('#102a43'), css('#ffffff')) > 14, 'and it must pass the colours the app actually uses');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('legibility.test.js'),
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
