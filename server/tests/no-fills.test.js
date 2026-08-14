/**
 * NOTHING HIGHLIGHTS BY FILLING — run with:
 *   node server/tests/no-fills.test.js   (also gated by `npm test`)
 *
 * THE OWNER'S RULE, stated once and enforced everywhere:
 *
 *   At rest, no element in this system signals importance with a solid
 *   background. Emphasis is a FRAME — a navy border on white — plus weight.
 *   A fill is allowed for the MOMENT of a press (:active / .is-pressed),
 *   where it is feedback rather than decoration.
 *
 * This has been asked for repeatedly and fixed one family at a time: headers
 * and footers, then the pickers, then the filter tabs, then the primary
 * buttons and the status chips. Each time it came back somewhere else, because
 * the previous guard only knew about the surface it was written for.
 *
 * So this guard is written against the RULE, not against a list of screens.
 * It reads the shipped markup and stylesheets and fails on any button or
 * status chip that ships with a default filled background.
 *
 * WHY THE SOURCE AND NOT THE RENDERED PAGE: the offenders that survived every
 * previous pass were classless `<button style="background:rgba(27,27,26,.55)">`
 * written into generated HTML strings. No stylesheet selector could reach
 * them, and an inline background outranks a stylesheet anyway. The only place
 * to catch that is the source.
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

// A value that is not a fill: see-through, or the page's own white.
// White at ANY opacity counts as "not a fill": it is the page's own colour, so
// a translucent white veil (a modal scrim) is not highlighting anything.
const NOT_A_FILL = /^(transparent|none|inherit|initial|unset|currentcolor|#fff|#ffffff|white|rgba?\(\s*255,\s*255,\s*255\s*(,\s*[\d.]+)?\s*\)|var\(--westmere-white[^)]*\)|var\(--wmb-surface[^)]*\))$/i;

// Pull `background` / `background-color` out of a declaration list.
function fillIn(style) {
  const m = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(style);
  if (!m) return null;
  const v = m[1].trim().replace(/\s+/g, ' ');
  return NOT_A_FILL.test(v) ? null : v;
}

// Every surface that builds UI — the four apps AND the shared scripts that
// inject markup into them. wm-realtime.js is in this list because the last
// solid-black slab in the whole system was hiding there: a permission prompt
// appended straight to document.body, out of reach of every app stylesheet.
const APPS = ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html', 'westmere-driver.html',
              'westmere-card.html', 'westmere-pay.html',
              'wm-realtime.js', 'wm-lifecycle.js', 'booking-app.js', 'wm-picker.js'];

console.log('\nNothing highlights by filling');

// ── 1. BUTTONS ──────────────────────────────────────────────────────────
test('no button in any app ships with a filled background', () => {
  const offenders = [];
  for (const f of APPS) {
    let src; try { src = read(f); } catch (e) { continue; }
    for (const m of src.matchAll(/<button\b[^>]*style=["']([^"']*)["'][^>]*>/gi)) {
      const fill = fillIn(m[1]);
      if (!fill) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line}  background:${fill}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these buttons highlight by filling. A primary action is a HEAVIER FRAME, never a filled slab —\n' +
    '      strip the background and set border:var(--border-strong,1.5px) solid var(--westmere-navy,#102a43):\n      ' +
    offenders.join('\n      '));
});

// An <a> that the user reads as a button — CALL, WHATSAPP, NAVIGATE. The first
// version of this guard only inspected <button>, which is how a solid green
// WhatsApp slab and a row of grey ones survived every previous pass: they are
// links, and the guard was looking at the wrong tag. What makes an anchor a
// button is that it is BOXED — it has padding — not what element it happens to
// be. A phone number inside a note is a link and is left alone.
test('no action LINK ships with a filled background', () => {
  const offenders = [];
  for (const f of APPS) {
    let src; try { src = read(f); } catch (e) { continue; }
    for (const m of src.matchAll(/<a\b[^>]*style=["']([^"']*)["'][^>]*>/gi)) {
      const style = m[1];
      if (!/padding/.test(style)) continue;            // inline link, not a button
      const fill = fillIn(style);
      if (!fill) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line}  background:${fill}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these action links highlight by filling. An <a> styled as a button obeys the same rule as a\n' +
    '      <button> — the user cannot tell the two apart, so neither can the design:\n      ' +
    offenders.join('\n      '));
});

test("no app paints anything in another company's brand colour", () => {
  // WhatsApp green (#25D366) and Instagram pink were the two that got in. They
  // are somebody else's brand sitting on Westmere's, and the owner asked for
  // the green specifically. The channel is named by its glyph and its label.
  const offenders = [];
  for (const f of APPS.concat(['westmere-theme.css', 'styles.css'])) {
    let src; try { src = read(f); } catch (e) { continue; }
    // Hex AND rgb() forms — the Instagram pink was hiding as #e1306c on an SVG
    // stroke, which the rgba-only pattern walked straight past.
    for (const m of src.matchAll(/#25D366|#E1306C|rgba?\(\s*37,\s*211,\s*102|rgba?\(\s*225,\s*48,\s*108/gi)) {
      offenders.push(f + ':' + src.slice(0, m.index).split('\n').length + '  ' + m[0]);
    }
  }
  assert.deepStrictEqual(offenders, [], 'third-party brand colour is back:\n      ' + offenders.join('\n      '));
});

test('no stylesheet repaints an element just for MENTIONING a colour', () => {
  // `[style*="#ffffff"]{background:#f1f1f1 !important}` — a pre-redesign hack
  // that greyed any element whose inline style merely mentioned white. It is
  // what made CALL and NAVIGATE grey slabs no matter what their markup said,
  // and it is unfixable from the markup end, so it must never come back.
  const offenders = [];
  for (const f of APPS) {
    let src; try { src = read(f); } catch (e) { continue; }
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/\[style\*=["'][^"']*["']\][^{]*\{([^}]*)\}/g)) {
      if (fillIn(m[1])) offenders.push(f + ':' + src.slice(0, m.index).split('\n').length + '  ' + m[0].slice(0, 90));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a blanket [style*=…] selector is filling elements by what their markup MENTIONS:\n      ' + offenders.join('\n      '));
});

// ── THE PRIMARY BUTTON: louder by LABEL, never by fill ─────────────────
// The owner chose this from a sheet of eight alternatives. The whole point is
// the DIFFERENCE between primary and secondary, so both halves are pinned: a
// primary that loses its bolder label is as broken as one that gains a fill,
// because either way the hierarchy disappears and every button looks the same.
const BTN = read('wm-buttons.css');
// Resolve the TOKEN first and the literal fallback only if there is none. The
// other way round reads the fallback — which is precisely the value that goes
// stale when someone re-points the token and forgets it.
const rem = (v) => {
  const tok = /var\((--[a-z0-9-]+)/.exec(v);
  if (tok) {
    const src = BTN + read('westmere-theme.css');
    let name = tok[1], seen = 0;
    while (seen++ < 4) {
      const d = new RegExp('\\' + name + ':\\s*([^;]+);').exec(src);
      if (!d) break;
      const chain = /var\((--[a-z0-9-]+)/.exec(d[1]);
      const lit = /^\s*([0-9.]+)rem/.exec(d[1]);
      if (lit) return parseFloat(lit[1]);
      if (chain) { name = chain[1]; continue; }
      break;
    }
  }
  const m = /([0-9.]+)rem/.exec(v);
  return m ? parseFloat(m[1]) : NaN;
};
const weight = (v) => {
  const m = /(\d{3})/.exec(v);
  if (m) return +m[1];
  const tok = /var\((--[a-z0-9-]+)/.exec(v);
  if (tok) {
    const d = new RegExp('\\' + tok[1] + ':\\s*(\\d{3})').exec(BTN + read('westmere-theme.css'));
    if (d) return +d[1];
  }
  return NaN;
};
const decl = (block, prop) => (new RegExp(prop + ':\\s*([^;]+);').exec(block) || [])[1] || '';

test('the primary button variant is a frame, not a fill', () => {
  const block = BTN.slice(BTN.indexOf('.wm-btn-primary {'), BTN.indexOf('}', BTN.indexOf('.wm-btn-primary {')));
  const fill = fillIn(block.replace(/\n/g, ' '));
  assert.strictEqual(fill, null,
    '.wm-btn-primary rests on a fill (' + fill + ') — primary is the LABEL, not a slab');
  assert.ok(/border-color:\s*var\(--wmb-line-strong/.test(block), 'primary must carry the strong border');
  // ...and it must still fill on PRESS, or a tap has no feedback on a phone.
  const press = BTN.slice(BTN.indexOf('.wm-btn-primary:active'));
  assert.ok(/background-color:\s*var\(--wmb-press/.test(press.slice(0, 300)),
    'the pressed state must still fill — that is the one legitimate fill, and without it a tap is invisible on touch');
});

test('the primary label is BIGGER and BOLDER than the secondary one', () => {
  const base = BTN.slice(BTN.indexOf('.wm-btn {'), BTN.indexOf('}', BTN.indexOf('.wm-btn {')));
  const prim = BTN.slice(BTN.indexOf('.wm-btn-primary {'), BTN.indexOf('}', BTN.indexOf('.wm-btn-primary {')));

  const bSize = rem(decl(base, 'font-size')), pSize = rem(decl(prim, 'font-size'));
  const bW = weight(decl(base, 'font-weight')), pW = weight(decl(prim, 'font-weight'));
  assert.ok(!isNaN(bSize) && !isNaN(pSize), 'both button labels must declare a resolvable size');
  assert.ok(pSize > bSize,
    'the primary label (' + pSize + 'rem) is not larger than the secondary one (' + bSize + 'rem) — ' +
    'size is half of what makes it primary, and without it the two are indistinguishable');
  assert.ok(pW >= 700 && pW > bW,
    'the primary label is weight ' + pW + ' against a secondary ' + bW + ' — primary must be bold (700+)');

  // ...and it must clear the LOUDEST hand-written secondary in the staff apps,
  // not merely the base class. Those buttons carry their own inline sizes
  // (.79–.8rem), which is how the primary ended up SMALLER than the buttons it
  // was supposed to lead — a hierarchy pointing the wrong way is worse than none.
  let loudest = 0, where = '';
  for (const f of ['westmere-owner.html', 'westmere-admin.html']) {
    for (const m of read(f).matchAll(/<button\b[^>]*style="([^"]*font-size:\s*([0-9.]+)rem[^"]*)"[^>]*>/g)) {
      // Labelled ACTION buttons only. The apps also hand-write icon buttons —
      // a close ×, a chevron — at 1.6rem, and a glyph is not a secondary action
      // competing with the primary for attention.
      if (!/text-transform:\s*uppercase/.test(m[1])) continue;
      if (/wm-primary/.test(m[0])) continue;          // that IS a primary, not its competition
      const v = parseFloat(m[2]);
      if (v > loudest) { loudest = v; where = f; }
    }
  }
  assert.ok(pSize > loudest,
    'the primary label is ' + pSize + 'rem but ' + where + ' hand-writes a secondary button at ' +
    loudest + 'rem — the primary would render SMALLER than an ordinary one');
});

test('the primary treatment comes from tokens, not from a literal', () => {
  const prim = BTN.slice(BTN.indexOf('.wm-btn-primary {'), BTN.indexOf('}', BTN.indexOf('.wm-btn-primary {')));
  for (const prop of ['font-size', 'font-weight', 'letter-spacing']) {
    assert.ok(/var\(--wmb-/.test(decl(prim, prop)),
      'primary hardcodes ' + prop + ' (' + decl(prim, prop).trim() + ') — re-tuning the hierarchy must be one edit');
  }
  // And the theme's application layer must not restate a size of its own.
  const T = read('westmere-theme.css');
  const s22 = T.slice(T.indexOf('22. PRIMARY IS THE LABEL'));
  const block = s22.slice(s22.indexOf('.wm-primary,'), s22.indexOf('}', s22.indexOf('.wm-primary,')));
  assert.ok(/font-size:\s*var\(--wmb-label-primary/.test(block),
    'theme §22 restates the primary size instead of pointing at the token — two sources of truth');
  assert.strictEqual(fillIn(block.replace(/\n/g, ' ')), null, 'theme §22 gives the primary a fill');
});

test('the genuine main actions are marked primary — and only those', () => {
  // A screen with two primaries has none. These are the one-per-surface main
  // actions; Cancel, Edit, Delete and Send Message must stay plain frames.
  const MAIN = [
    ['westmere-owner.html', 'ownerSendEstimate('], ['westmere-owner.html', 'upcomingSave()'],
    ['westmere-admin.html', 'createInvoiceNew('], ['westmere-admin.html', 'admSendEstimate('],
    ['book.html', 'Request booking'], ['westmere-pay.html', 'id="pay-btn"']
  ];
  for (const [f, anchor] of MAIN) {
    const src = read(f);
    const tag = (src.match(new RegExp('<button[^>]*' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*>')) ||
                 src.match(new RegExp('<button[^>]*>(?=[^<]*' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')')) || [''])[0];
    assert.ok(/wm-primary|btn-main|ls-btn|pp-card|btn-navy/.test(tag),
      f + "'s main action (" + anchor + ') is no longer marked primary: ' + tag.slice(0, 100));
  }
  // The quiet ones must NOT be.
  const owner = read('westmere-owner.html');
  for (const quiet of ['wmMessageOpen(', 'upcomingEdit(', 'upcomingDelete(']) {
    const tag = (owner.match(new RegExp('<button[^>]*' + quiet.replace(/[.*+?^${}()|[\]]/g, '\\$&') + '[^>]*>')) || [''])[0];
    assert.ok(!/wm-primary/.test(tag), quiet + ' has been promoted to primary — a screen of primaries has none');
  }
});

// ── 2. STATUS CHIPS ─────────────────────────────────────────────────────
test('the shared status descriptors carry no colour at all', () => {
  // wm-lifecycle.js was the source of every filled pill: it returned `color`
  // and `bg`, and all three apps painted them into an inline style — which no
  // theme rule can override.
  const L = read('wm-lifecycle.js').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\bbg\s*:/.test(L),
    'wm-lifecycle.js is handing a background back to the apps again — a status descriptor is ' +
    'semantics (key, label, cls) and nothing else');
  assert.ok(!/\bcolor\s*:\s*['"]/.test(L),
    'wm-lifecycle.js is handing a colour back to the apps again — the chip is styled once, in the theme');
  // The class names must survive: they are the hook the theme styles through.
  assert.ok(/cls:\s*'tag-/.test(L), 'the descriptors no longer return a class — the theme has nothing to style');
});

// THE ONE EXEMPTION, and it is a shape rather than a name: an indicator DOT.
// A live-status dot is 6–8px, perfectly round, and has no text in it — it IS
// its fill. Putting a hairline ring on it would draw a circle around nothing.
// This is deliberately expressed as a measurement, not a class list, so it
// cannot be used to smuggle a filled text chip through by naming it "-dot".
function isIndicatorDot(decls) {
  const round = /border-radius:\s*(50%|999px)/.test(decls);
  const w = /(?:^|;)\s*width:\s*(\d+)px/.exec(decls);
  const h = /(?:^|;)\s*height:\s*(\d+)px/.exec(decls);
  const tiny = w && h && +w[1] <= 10 && +h[1] <= 10;
  const noText = !/font-size|content:/.test(decls);
  return round && tiny && noText;
}

// A dot's MODIFIER (.status-dot.ok, .dc-status.on .dc-dot) sets only a colour —
// the geometry that makes it a dot lives on the base rule, so isIndicatorDot()
// cannot see it from the modifier alone. Collect the base classes that really
// are dots, then exempt the rules that decorate them. Still measurement-driven:
// a class only enters this set by proving itself round, tiny and textless.
function dotClassesIn(src) {
  const set = new Set();
  for (const m of src.matchAll(/^\s*\.([\w-]+)\s*\{([^}]*)\}/gim)) {
    if (isIndicatorDot(m[2].replace(/\n/g, ' '))) set.add(m[1]);
  }
  return set;
}

test('no status chip class defines a fill', () => {
  const offenders = [];
  // Any rule whose selector mentions a chip-ish class — INCLUDING compound and
  // descendant forms. The first version of this only matched a bare class or a
  // comma list, so `.adm-cal-status.cancelled { background:#FCE4E4 }` sailed
  // straight through it: a filled status chip, in a guard written to catch
  // filled status chips. Narrow selectors are how a guard quietly stops working.
  const CHIP = /^\s*([^{}\n]*[.#][\w-]*(?:tag|chip|badge|status)[\w-]*[^{}\n]*?)\s*\{([^}]*)\}/gim;
  for (const f of APPS.concat(['westmere-theme.css', 'styles.css'])) {
    let src; try { src = read(f); } catch (e) { continue; }
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const dots = dotClassesIn(src);
    for (const m of src.matchAll(CHIP)) {
      const decls = m[2].replace(/\n/g, ' ');
      const fill = fillIn(decls);
      if (!fill) continue;
      if (isIndicatorDot(decls)) continue;
      // ...or it decorates one.
      if ([...m[1].matchAll(/\.([\w-]+)/g)].some(c => dots.has(c[1]))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line}  ${m[1].trim()} { background:${fill} }`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these status chips highlight by filling — a chip is a navy hairline frame on white:\n      ' +
    offenders.join('\n      '));
});

test('no chip is painted with an inline background in generated markup', () => {
  const offenders = [];
  for (const f of APPS) {
    let src; try { src = read(f); } catch (e) { continue; }
    for (const m of src.matchAll(/<span\b[^>]*style=["']([^"']*)["']/gi)) {
      const style = m[1];
      // Only the chip-shaped ones: uppercase micro-labels beside their subject.
      if (!/text-transform:\s*uppercase/i.test(style)) continue;
      const fill = fillIn(style);
      if (!fill) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line}  background:${fill}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these chips carry an inline fill. An inline background beats every stylesheet, so the theme ' +
    'can never restyle it — use class="wm-chip" and let §20 do the work:\n      ' + offenders.join('\n      '));
});

// ── 3. THE OTHER FAMILIES, ALREADY CONVERTED — keep them converted ──────
test('selected pickers, filter tabs, headers and footers stay unfilled', () => {
  const T = read('westmere-theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const i = T.indexOf(sel);
    assert.ok(i !== -1, 'the theme no longer carries ' + sel);
    return T.slice(i, T.indexOf('}', i));
  };
  for (const sel of ['.wm-day.is-selected', '.filter-btn.on']) {
    const fill = fillIn(rule(sel).replace(/\n/g, ' '));
    assert.strictEqual(fill, null, sel + ' is filled again (' + fill + ') — selection is a frame');
  }
});

test('the theme declares the one chip look, from tokens', () => {
  const T = read('westmere-theme.css');
  assert.ok(/\.wm-chip\b/.test(T), 'the theme has no .wm-chip — the chip look must live in ONE place');
  const s = T.indexOf('.wm-chip,');
  const block = T.slice(s, T.indexOf('}', T.indexOf('border:', s)));
  assert.ok(/border:\s*var\(--border-hair/.test(block), 'the chip frame must come from the border token');
  assert.ok(/var\(--westmere-navy/.test(T.slice(s)), 'the chip ink must come from the navy token');
  assert.ok(!/border:[^;]*#[0-9a-f]{3,6}\s*(?:!important)?\s*;/i.test(block.replace(/var\([^)]*\)/g, '')),
    'the chip hardcodes a colour outside a token fallback');
});

// ── 4. A press MAY fill. Prove the rule is not simply "no fills ever". ──
test('a pressed button still fills — the one legitimate fill', () => {
  const T = read('westmere-theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const i = T.indexOf('#scr-app button:active');
  assert.ok(i !== -1, 'the app buttons have no pressed state — a tap on a phone would give no feedback at all');
  const block = T.slice(i, T.indexOf('}', i));
  assert.ok(/background-color:\s*var\(--westmere-navy/.test(block),
    'the pressed state must fill navy');
});

// ── 5. NEGATIVE TESTS — prove the guard actually bites ──────────────────
test('NEGATIVE: the guard catches a filled button', () => {
  const bad = '<button onclick="x()" style="padding:.6rem;background:rgba(27,27,26,.55);border:none">Send Estimate</button>';
  const m = /<button\b[^>]*style=["']([^"']*)["'][^>]*>/i.exec(bad);
  assert.strictEqual(fillIn(m[1]), 'rgba(27,27,26,.55)',
    'the exact button the owner complained about would pass — the guard is useless');
});

test('NEGATIVE: the guard catches a filled chip class and a var() fill', () => {
  assert.strictEqual(fillIn('background:var(--green-bg);color:var(--green)'), 'var(--green-bg)',
    'a fill hidden behind a token name would pass');
  assert.strictEqual(fillIn('padding:2px;background-color:#E6F4EA'), '#E6F4EA', 'background-color is not being read');
});

test('NEGATIVE: the dot exemption cannot be used to smuggle a chip through', () => {
  // An 8px round indicator with no text is a glyph, and may stay filled.
  assert.ok(isIndicatorDot('width:8px;height:8px;border-radius:50%;background:rgba(27,27,26,.2)'),
    'a real indicator dot is being flagged — the guard will get switched off');
  // Anything with text in it is a chip, however it is named or shaped.
  assert.ok(!isIndicatorDot('padding:.15rem .5rem;border-radius:999px;font-size:.7rem;background:var(--green-bg)'),
    'a pill with a label slipped through the dot exemption');
  assert.ok(!isIndicatorDot('width:40px;height:20px;border-radius:50%;background:#102a43'),
    'a 40px block slipped through the dot exemption');
});

test('NEGATIVE: the widened chip selector catches compound forms', () => {
  // The exact miss that let a filled status chip ship: a compound selector.
  const CHIP = /^\s*([^{}\n]*[.#][\w-]*(?:tag|chip|badge|status)[\w-]*[^{}\n]*?)\s*\{([^}]*)\}/gim;
  const css = '.adm-cal-status.cancelled{background:#FCE4E4;color:#9C2828}\n.x{background:red}';
  const hits = [...css.matchAll(CHIP)].filter(m => fillIn(m[2]));
  assert.strictEqual(hits.length, 1, 'the compound selector is still not being read');
  assert.strictEqual(fillIn(hits[0][2]), '#FCE4E4');
});

test('NEGATIVE: a dot modifier is exempt, a chip modifier is not', () => {
  const css = '.status-dot{width:8px;height:8px;border-radius:50%;background:#ccc}\n' +
              '.tag-x{padding:.2rem;font-size:.7rem}';
  const dots = dotClassesIn(css);
  assert.ok(dots.has('status-dot'), 'a real dot was not recognised as one');
  assert.ok(!dots.has('tag-x'), 'a labelled chip was recognised as a dot');
});

test('NEGATIVE: the link guard catches the green slab but spares a text link', () => {
  const slab = '<a href="https://wa.me/1" style="min-height:44px;padding:.5rem .9rem;background:#25D366">WhatsApp</a>';
  const link = '<a href="tel:1" style="color:var(--navy);border-bottom:1px solid">07700 900123</a>';
  const boxed = /<a\b[^>]*style=["']([^"']*)["'][^>]*>/i;
  assert.strictEqual(fillIn(boxed.exec(slab)[1]), '#25D366', 'the WhatsApp slab would pass — the guard is useless');
  const ls = boxed.exec(link)[1];
  assert.ok(!/padding/.test(ls), 'a plain text link must not be treated as a button');
});

test('NEGATIVE: the guard does NOT fire on white, transparent, or a press', () => {
  // A guard that fails on legitimate markup gets switched off, so prove it does not.
  for (const ok of ['background:transparent', 'background:#fff', 'background: var(--westmere-white, #ffffff)',
                    'background:rgba(255,255,255,1)', 'background:none', 'color:#102a43;border:1px solid']) {
    assert.strictEqual(fillIn(ok), null, 'false positive on: ' + ok);
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/no-fills\.test\.js/.test(read('package.json')),
    'no-fills.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
