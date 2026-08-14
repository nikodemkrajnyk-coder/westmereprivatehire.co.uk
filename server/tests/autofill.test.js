/**
 * Autofill override guardrail — run with:
 *   node server/tests/autofill.test.js   (also gated by `npm test`)
 *
 * Chrome and Safari paint an autofilled field with their own yellow
 * background. The owner's screenshot of the My Account register form showed
 * Full Name / Email / Mobile all yellow. The background of an autofilled
 * control cannot be set directly, so every form surface carries the standard
 * override: an inset box-shadow thick enough to cover the field, plus
 * -webkit-text-fill-color for the text (plain `color` is ignored while a field
 * is autofilled) and a near-infinite transition so the yellow cannot flash in
 * before the shadow paints.
 *
 * This test also pins the two mistakes made while adding it, because both were
 * invisible in the file and only showed up in a browser:
 *
 *   1. A doubled brace ("…:focus{{") from a bad template. The selectors parsed,
 *      every declaration was dropped, and the fields stayed yellow.
 *   2. A literal closing style tag inside a CSS comment. The HTML tokenizer
 *      does not read CSS comments, so it ended the stylesheet right there and
 *      dropped the rest of the page's CSS on the floor.
 *
 * Pure Node, no framework. Exit 1 on failure.
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

console.log('\nAutofill override — no browser yellow on any form');

// Each surface, and the field colours the override must match. The public
// pages all link styles.css, so one rule there covers six pages.
const SURFACES = [
  // --paper used to be the cream #fbfaf7; the navy-on-white theme made it white,
  // so the shadow that masks Chrome's yellow has to be white too or an autofilled
  // field shows as a cream patch on a white form.
  { file: 'styles.css',          bg: '#ffffff', fg: '#1b1b1a', note: 'public pages (fields are transparent over --paper)' },
  { file: 'westmere-rider.html', bg: '#ffffff', fg: '#1b1b1a', note: 'My Account (fields sit on white cards)' },
  { file: 'westmere-owner.html', bg: '#ffffff', fg: '#111111', note: 'owner app (inputs are explicitly white)' },
  { file: 'westmere-admin.html', bg: '#f7f7f7', fg: '#1b1b1a', note: 'admin app (.fi is a 3% tint over white)' },
  { file: 'westmere-pay.html',   bg: '#ffffff', fg: '#1b1b1a', note: 'pay page (Stripe iframe today, covered for later)' },
];

// Pages that get their rule from styles.css rather than their own block.
const VIA_STYLESHEET = ['index.html', 'book.html', 'contact.html', 'about.html',
  'services.html', 'airport-transfers.html'];

function autofillBlock(src) {
  const i = src.indexOf(':-webkit-autofill');
  if (i === -1) return null;
  const open = src.indexOf('{', i);
  const close = src.indexOf('}', open);
  return { selectors: src.slice(Math.max(0, src.lastIndexOf('\n', i) - 400), open), body: src.slice(open, close + 1) };
}

test('every form surface carries an autofill override', () => {
  const missing = SURFACES.filter(s => !/:-webkit-autofill/.test(read(s.file))).map(s => s.file);
  assert.strictEqual(missing.join(', '), '', 'no autofill override in: ' + missing.join(', '));
});

test('each override covers input, textarea and select — and hover/focus', () => {
  for (const s of SURFACES) {
    const src = read(s.file);
    for (const need of ['input:-webkit-autofill', 'textarea:-webkit-autofill', 'select:-webkit-autofill',
                        'input:-webkit-autofill:hover', 'input:-webkit-autofill:focus']) {
      assert.ok(src.includes(need), s.file + ' must cover ' + need +
        ' — the yellow returns on hover/focus otherwise');
    }
  }
});

test('each override uses that surface\'s real field colours', () => {
  for (const s of SURFACES) {
    const blk = autofillBlock(read(s.file));
    assert.ok(blk, s.file + ': no autofill block found');
    // The mask colour may be a TOKEN reference now — var(--token, #fff). That is
    // better than a literal: a palette change carries the autofill mask with it.
    // Flatten any var(--token, literal) to its literal, then check as before.
    const flat = blk.body.replace(/var\(\s*--[a-z0-9-]+\s*,\s*([^)]+)\)/gi, '$1');
    assert.ok(flat.includes('0 0 0 1000px ' + s.bg + ' inset'),
      s.file + ' must cover the field with ' + s.bg + ' (' + s.note + ') — ' +
      'either literally or via a token that resolves to it');
    assert.ok(flat.includes('-webkit-text-fill-color:' + s.fg),
      s.file + ' must set -webkit-text-fill-color to ' + s.fg +
      ' — `color` alone is ignored while a field is autofilled');
    assert.ok(/-webkit-box-shadow:/.test(blk.body) && /(^|[^-])box-shadow:/.test(blk.body),
      s.file + ' needs both the prefixed and unprefixed box-shadow');
    assert.ok(/transition:background-color 9999s/.test(blk.body),
      s.file + ' needs the long transition, or the yellow flashes in before the shadow paints');
    assert.ok(/caret-color:/.test(blk.body), s.file + ' should set caret-color to stay legible');
  }
});

// ── the two mistakes this cost me ────────────────────────────────────────
test('no doubled braces — the block must actually parse', () => {
  for (const s of SURFACES) {
    const src = read(s.file);
    const i = src.indexOf(':-webkit-autofill');
    const region = src.slice(i, i + 1400);
    assert.ok(!/\{\{/.test(region) && !/\}\}/.test(region),
      s.file + ': doubled braces in the autofill block — the selectors parse but every ' +
      'declaration is dropped and the fields stay yellow (this actually shipped once)');
  }
});

test('no literal closing style tag inside an inline CSS comment', () => {
  // The HTML tokenizer ends a <style> element at the first closing style tag,
  // even inside a CSS comment — it does not read CSS. That silently drops the
  // rest of the page's stylesheet.
  // Walk each <style> element from its opening tag, tracking CSS comment state
  // by hand. Scanning the whole file for /* … */ is wrong (an HTML attribute
  // like accept="image/*" opens a fake comment), and scanning PARSED <style>
  // blocks is also wrong (an injected closing tag truncates the block, hiding
  // the very comment that caused it). This walks the raw text instead.
  for (const s of SURFACES) {
    if (!s.file.endsWith('.html')) continue;
    const src = read(s.file);
    for (const open of [...src.matchAll(/<style[^>]*>/g)]) {
      let i = open.index + open[0].length;
      let inComment = false;
      while (i < src.length) {
        if (!inComment && src.startsWith('/*', i)) { inComment = true; i += 2; continue; }
        if (inComment && src.startsWith('*/', i)) { inComment = false; i += 2; continue; }
        if (src.substr(i, 7).toLowerCase() === '</style') {
          assert.ok(!inComment,
            s.file + ': a CSS comment contains a literal closing style tag — the HTML ' +
            'tokenizer does not read CSS comments, so it ends the stylesheet there and ' +
            'drops every rule after it');
          break;   // genuine end of this style element
        }
        i++;
      }
    }
  }
});

test('the override lives in the page\'s own head stylesheet, not a print window', () => {
  // owner/admin build a print window inside a JS string that contains its own
  // style tags; appending to the LAST one in the file puts the CSS inside a
  // string literal, where it styles nothing and breaks the script.
  for (const s of SURFACES) {
    if (!s.file.endsWith('.html')) continue;
    const src = read(s.file);
    const headEnd = src.indexOf('</head>');
    const at = src.indexOf(':-webkit-autofill');
    assert.ok(headEnd !== -1 && at < headEnd,
      s.file + ': the autofill rule must sit inside <head>, before </head>');
  }
});

test('every inline script still parses on the pages that were edited', () => {
  for (const s of SURFACES) {
    if (!s.file.endsWith('.html')) continue;
    const src = read(s.file);
    const blocks = src.split(/<script[^>]*>/).slice(1).map(b => b.split('</script>')[0]);
    blocks.forEach((b, i) => {
      if (b.trim().length < 40) return;
      assert.doesNotThrow(() => new Function(b),
        s.file + ': inline script block ' + i + ' no longer parses — an edit landed inside a JS string');
    });
  }
});

test('the public pages inherit the rule from styles.css', () => {
  for (const page of VIA_STYLESHEET) {
    const src = read(page);
    assert.ok(/styles\.css/.test(src),
      page + ' must link styles.css — that is where its autofill override lives');
  }
  assert.ok(/:-webkit-autofill/.test(read('styles.css')),
    'styles.css must carry the override for every page that links it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
