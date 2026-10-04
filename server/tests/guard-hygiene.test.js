/**
 * THE GUARDS THEMSELVES — run with:
 *   node server/tests/guard-hygiene.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   A guard that stops covering the code it was aimed at does not fail. It
 *   goes on reporting green, which is worse than having no guard at all — the
 *   suite is now actively telling you something is checked when it is not.
 *
 *   The suite had one specific way of doing that: bounding a region of source
 *   with a CHARACTER COUNT. `src.slice(i, i + 1500)`. It reads fine and it
 *   works on the day it is written. Then somebody adds a branch above the
 *   assertion, the window no longer reaches it, and the test passes forever.
 *
 *   That is not hypothetical. Three assertions silently stopped testing their
 *   own subject in one week:
 *     · two in payment-flow, when the Stripe webhook grew a balance branch and
 *       fell out of a 3000-character window;
 *     · one in payment-flow again, when the pay-info route grew six columns
 *       and its stripeReady check fell out of a 1500-character one.
 *   All three reported green while guarding nothing.
 *
 *   So the rule: bound a region by something that MEANS something — the next
 *   route declaration, the closing brace, the end of the cell. server/tests/
 *   _source.js has the helpers. This file stops the character count coming
 *   back, and stops a guard being registered but never run.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const DIR = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TESTS = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js')).sort();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nThe guards themselves');

test('no guard bounds a region of source with a character count', () => {
  const offenders = [];
  for (const f of TESTS) {
    // CODE only. This rule is written about slicing, so a scan that includes
    // prose flags the paragraph explaining it — which is how a lint rule
    // teaches people to disable the lint.
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                   .replace(/^\s*\/\/.*$/gm, m => ' '.repeat(m.length));
    for (const m of src.matchAll(/\.slice\(\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\+\s*(\d{3,6})\s*\)/g)) {
      offenders.push(f + ':' + src.slice(0, m.index).split('\n').length + '  ' + m[0]);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a guard is bounded by a character count and will silently stop covering its subject.\n' +
    '      Use regionFrom/routeBlock/fnBlock from server/tests/_source.js instead:\n      ' +
    offenders.join('\n      '));
});

test('every guard in the suite is actually registered in npm test', () => {
  const pkg = read('package.json');
  const missing = TESTS.filter(f => !pkg.includes(f));
  assert.deepStrictEqual(missing, [],
    'these guards exist but never run — they protect nothing:\n      ' + missing.join('\n      '));
});

test('every guard registered in npm test actually exists', () => {
  const pkg = read('package.json');
  const named = [...pkg.matchAll(/server\/tests\/([\w.-]+\.test\.js)/g)].map(m => m[1]);
  const gone = [...new Set(named)].filter(n => !TESTS.includes(n));
  assert.deepStrictEqual(gone, [],
    'npm test names a guard that is not on disk — the suite would abort:\n      ' + gone.join('\n      '));
});

test('the shared source helpers exist and refuse a missing boundary', () => {
  const S = require('./_source');
  for (const fn of ['regionFrom', 'routeBlock', 'braceBody', 'fnBlock']) {
    assert.strictEqual(typeof S[fn], 'function', '_source.js no longer exports ' + fn);
  }
  // A boundary that cannot be found must THROW, not quietly return the wrong
  // region — silently guarding the wrong code is the failure this replaces.
  assert.throws(() => S.regionFrom('abc def', 'zzz', []), /marker not found/);
  assert.throws(() => S.fnBlock('const x = 1;', 'nope'), /no function nope/);
  // …and it really does bound by meaning.
  const src = "router.get('/a', () => { AAA });\nrouter.post('/b', () => { BBB });";
  const a = S.routeBlock(src, "router.get('/a'");
  assert.ok(a.includes('AAA') && !a.includes('BBB'), 'routeBlock leaked into the next route');
});

test('the cross-cutting guards enumerate their surfaces, and miss none', () => {
  // Single-app guards are fine — the owner has an assistant and a name board
  // that admin does not, and admin has invoicing the owner does not. What is
  // NOT fine is a guard whose rule spans the system carrying a hand-written
  // list of screens that quietly goes stale. Those must either read the
  // directory or name every surface they are responsible for.
  const STAFF = ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html'];
  const CROSS = {
    'no-fills.test.js': 'nothing highlights by filling',
    'button-style.test.js': 'one button system',
    'page-integrity.test.js': 'nothing renders as debris'
  };
  const offenders = [];
  for (const f of Object.keys(CROSS)) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const derived = /readdirSync\(/.test(src);
    const namesAll = STAFF.every(a => src.includes(a));
    if (!derived && !namesAll) {
      offenders.push(f + ' (' + CROSS[f] + ') neither reads the directory nor names every staff surface');
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a system-wide rule is pinned to a hand-written list of screens:\n      ' + offenders.join('\n      '));
});

// ── STRIPPING COMMENTS MUST NOT EAT THE FILE ─────────────────────────────
// A guard reads the shipped source and strips the comments so it does not
// match its own explanation. Every one of them used the same blunt regex, and
// in an HTML file it is not safe: `accept="image/*"` opens a block comment
// that nothing closes for a hundred kilobytes. westmere-admin.html lost 102KB
// of its own markup that way — so every absence-assertion over that region was
// passing on text that was not in the string at all. A guard that cannot fail
// is worse than no guard.
test('the shared comment stripper leaves the markup it is handed', () => {
  const { stripComments } = require('./_source');
  // It still does its job…
  assert.ok(!stripComments('a; /* gone */ b;').includes('gone'), 'a real block comment must go');
  assert.ok(!stripComments('var a=1; // gone\nvar b=2;').includes('gone'), 'a real line comment must go');
  assert.ok(stripComments('var u = "https://x.co/y";').includes('x.co/y'), 'a URL is not a comment');
  // …without opening one inside a token.
  assert.ok(stripComments('<input accept="image/*"><div id="after"></div>').includes('id="after"'),
    'accept="image/*" must not swallow the rest of the file');
  // And on the real files, where this actually bit.
  for (const f of ['westmere-admin.html', 'westmere-owner.html', 'book.html']) {
    const raw = read(f);
    const out = stripComments(raw);
    const tags = (s) => (s.match(/<div\b/g) || []).length;
    assert.ok(tags(out) >= tags(raw) * 0.9,
      f + ': stripping comments removed ' + (tags(raw) - tags(out)) + ' of ' + tags(raw)
      + ' <div> tags — the stripper is eating markup, and every guard over it is blind');
  }
});

test('no guard strips an HTML app with a regex of its own', () => {
  /* Where it bites is an APP source: `accept="image/*"` opens a block comment
     that the blunt regex closes a hundred kilobytes later, and every assertion
     over that stretch is then reading a string the markup is not in. A guard
     that cannot fail reports green for ever.
     
     Stripping a snippet, a stylesheet or an extracted function body by hand is
     harmless and left alone — this pins the case that was actually broken. */
  const BLUNT = /replace\(\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//;
  const APP = /read\('[^']*\.html'\)|\b(OWNER|ADMIN|RIDER|APP|SRC)\b/;
  const offenders = [];
  for (const f of TESTS) {
    read(path.join('server/tests', f)).split('\n').forEach((line, i) => {
      if (BLUNT.test(line) && APP.test(line)) offenders.push(f + ':' + (i + 1));
    });
  }
  assert.deepStrictEqual(offenders, [],
    'these strip a whole app source by hand instead of _source.stripComments:\n      '
      + offenders.join('\n      '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/guard-hygiene\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
console.log('  guards inspected: ' + TESTS.length);
process.exit(failed ? 1 : 0);
