/**
 * Design-token discipline guardrail — run with:
 *   node server/tests/design-tokens.test.js   (also gated by `npm test`)
 *
 * THE CONTRACT THIS PROTECTS
 *   Design lives in ONE layer — the token block at the top of
 *   westmere-theme.css — and logic lives in server/. A future re-skin should be
 *   a token edit, and it must be impossible for that edit to touch behaviour.
 *
 * So this file pins three things:
 *   (a) the token layer exists and covers every design decision group;
 *   (b) the files that OWN the design (the three stylesheets) take their values
 *       from tokens rather than re-declaring literals;
 *   (c) the back-end logic files carry NO design values at all, so a design
 *       change can never need to open them.
 *
 * SCOPE, STATED HONESTLY: (b) covers westmere-theme.css, wm-buttons.css and
 * styles.css — the design system and the public site. The three staff apps
 * still hold ~1,400 inline styles in JS-generated markup; those are NOT
 * tokenised yet and are deliberately not asserted here, because a guard that
 * fails on day one teaches people to disable it. See DESIGN.md for what that
 * migration involves.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const THEME = read('westmere-theme.css');
const BUTTONS = read('wm-buttons.css');
const SITE = read('styles.css');

// The token block: everything from :root to the end of the master token section.
const TOKEN_BLOCK = THEME.slice(THEME.indexOf(':root'), THEME.indexOf('2. GLOBAL RESET') !== -1
  ? THEME.indexOf('2. GLOBAL RESET') : THEME.indexOf(':root') + 6000);

console.log('\nDesign tokens — one place to change the look');

// ── (a) The token layer covers every design decision ─────────────────────
const GROUPS = {
  'colour palette':   ['--westmere-navy', '--westmere-white', '--westmere-muted', '--westmere-line', '--westmere-line-strong'],
  'state colours':    ['--westmere-danger', '--westmere-success', '--westmere-info', '--westmere-scrim'],
  'frame shape':      ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-round', '--radius-pill'],
  'border widths':    ['--border-hair', '--border-strong', '--border-heavy'],
  'typography scale': ['--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl', '--weight-medium', '--weight-semi'],
  'spacing scale':    ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6'],
  'motion':           ['--ease-ui', '--ease-panel'],
  'typeface':         ['--westmere-type', '--serif', '--sans']
};

for (const [group, tokens] of Object.entries(GROUPS)) {
  test('the token layer defines the ' + group, () => {
    for (const t of tokens) {
      assert.ok(new RegExp('\\' + t + ':\\s*[^;]+;').test(TOKEN_BLOCK),
        'missing token ' + t + ' — ' + group + ' would have to be changed in more than one place');
    }
  });
}

test('the tokens are declared ONCE, on :root', () => {
  // A second declaration elsewhere is how two sources of truth start.
  for (const t of ['--radius-lg', '--westmere-navy', '--space-4']) {
    const decls = (THEME.match(new RegExp('\\' + t + ':', 'g')) || []).length;
    assert.strictEqual(decls, 1, t + ' is declared ' + decls + ' times in the theme — it must be declared once');
  }
});

// ── (b) The design-owning stylesheets consume the tokens ─────────────────
test('the button system derives from the theme, it does not restate it', () => {
  const root = BUTTONS.slice(BUTTONS.indexOf(':root'), BUTTONS.indexOf('}', BUTTONS.indexOf(':root')));
  const literals = [...root.matchAll(/--wmb-[a-z-]+:\s*(#[0-9a-fA-F]{3,8}|\d+px)\s*;/g)].map(m => m[0].trim());
  assert.deepStrictEqual(literals, [],
    'wm-buttons.css re-declares design literals instead of pointing at the theme tokens — ' +
    'a palette change would then have to be made twice:\n      ' + literals.join('\n      '));
  assert.ok(/var\(--westmere-navy/.test(root), 'the button ink must come from the theme');
  assert.ok(/var\(--radius-lg/.test(root), 'the button radius must come from the frame-shape scale');
});

test('every token reference carries a literal fallback', () => {
  // A var() that resolves to nothing is invalid at computed-value time and the
  // whole declaration is dropped — an unstyled button. If the theme ever fails
  // to load, the fallback keeps the previous look.
  const bare = [...BUTTONS.matchAll(/var\((--(?:westmere|radius|border|ease|text|space)[a-z-]*)\)/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(bare)], [],
    'these token references have no fallback, so a missing theme unstyles them: ' + [...new Set(bare)].join(', '));
});

test('the public stylesheet takes its palette and radii from tokens', () => {
  const refs = (SITE.match(/var\(--(westmere|radius)[a-z-]*/g) || []).length;
  assert.ok(refs >= 25, 'styles.css only references ' + refs + ' tokens — the palette should come from the layer');
  // Any remaining literal must be inside a var() fallback, never standalone.
  const standalone = SITE.split('\n').flatMap((line, i) => {
    const stripped = line.replace(/var\([^)]*\)/g, '');           // drop fallbacks
    if (/^:root/.test(line) || /--(ink|dark|muted|paper|line|border):/.test(line)) return [];
    return /#[0-9a-fA-F]{3,8}\b/.test(stripped) ? [(i + 1) + ': ' + line.trim().slice(0, 80)] : [];
  });
  assert.deepStrictEqual(standalone, [],
    'styles.css has colour literals outside the token layer:\n      ' + standalone.join('\n      '));
});

test('the frame shape really is one dial', () => {
  // No stylesheet may hardcode a radius any more — that is the whole point of
  // the shape token. (The token block itself is where the numbers live.)
  for (const [name, src] of [['westmere-theme.css', THEME], ['styles.css', SITE], ['wm-buttons.css', BUTTONS]]) {
    const body = src.slice(src.indexOf('MASTER DESIGN TOKENS') !== -1 ? src.indexOf('2. GLOBAL RESET') : 0);
    const hard = [...body.matchAll(/border-radius:\s*(\d+px|\d+%)/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(hard)], [],
      name + ' hardcodes a border-radius outside the scale: ' + [...new Set(hard)].join(', '));
  }
});

// ── (c) Logic files carry no design, and design work cannot reach them ───
console.log('\nThe front/back boundary');

// Pure business logic. Design has no business being in any of these.
const LOGIC_FILES = [
  'server/fare-engine.js', 'server/api.js', 'server/db.js', 'server/intake.js',
  'server/stripe.js', 'server/payment-methods.js', 'server/reminder.js',
  'server/dead-miles.js', 'server/assistant-routes.js', 'server/google-calendar.js'
];

test('no back-end logic file contains a design value', () => {
  const offenders = [];
  for (const f of LOGIC_FILES) {
    let src;
    try { src = read(f); } catch (e) { continue; }               // optional files
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;                  // comments may mention colours
      if (/#[0-9a-fA-F]{6}\b|font-size:|border-radius:/.test(line)) {
        offenders.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'design has leaked into back-end logic — a re-skin would have to edit business code:\n      ' +
    offenders.join('\n      '));
});

test('the fare engine is untouched by design work', () => {
  // The one file where a stray edit costs real money. Pinned by content hash:
  // any change at all makes this fail, which is the point — a design task must
  // never have a reason to open it.
  const sum = crypto.createHash('sha256').update(read('server/fare-engine.js')).digest('hex');
  const PINNED = 'FARE_ENGINE_SHA';
  const recorded = (read('server/tests/design-tokens.test.js').match(/FARE_ENGINE_SHA = '([0-9a-f]{64})'/) || [])[1];
  assert.ok(recorded, 'the fare-engine hash pin is missing from this test');
  assert.strictEqual(sum, recorded,
    'server/fare-engine.js has changed.\n' +
    '      If that was deliberate (a real fare change, reviewed and tested), update the pin to:\n        ' + sum +
    '\n      If you are doing DESIGN work, this is the guardrail doing its job: stop and revert.');
});
const FARE_ENGINE_SHA = '9bd907e43ef4239b4da7dab65565162a1d6e3f4c42a62e285c9432a3de46e87a';

test('the renderers that must hold their own palette are documented and pinned', () => {
  // server/email.js, invoice-pdf.js and public-api.js DO carry colour, because
  // mail clients cannot use CSS custom properties and pdfkit has no CSS at all.
  // They are the one legitimate exception, and they must agree with the theme.
  const navy = (THEME.match(/--westmere-navy:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  assert.ok(navy, 'the theme navy is missing');
  for (const f of ['server/email.js', 'server/invoice-pdf.js']) {
    const src = read(f);
    assert.ok(src.toLowerCase().includes(navy.toLowerCase()),
      f + ' no longer uses the theme navy (' + navy + ') — the emails/invoice have drifted from the site');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
