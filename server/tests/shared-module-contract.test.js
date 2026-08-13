/**
 * Shared-module contract guardrail — run with:
 *   node server/tests/shared-module-contract.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS — a real, live, customer-facing outage:
 *   westmere-rider.html shipped calling `WMAddr.flightFor(booking)`. The
 *   deployed address-normalize.js had no such export — it existed only in an
 *   uncommitted working-tree change. Result on the live site:
 *
 *       TypeError: WMAddr.flightFor is not a function
 *
 *   thrown once per trip row. The per-row guard did its job and skipped each
 *   row, so the page did not crash — it quietly rendered "No trips found" to
 *   every customer who had trips. A page can only be as deployable as the
 *   modules it calls, and HTML and its <script> dependencies are committed
 *   separately, so they can and did drift.
 *
 * THE RULE THIS PINS: every `WMAddr.x(...)` / `WMLifecycle.x(...)` any shipped
 * app calls must actually be exported by the shipped module. It also pins the
 * defensive shape — check the function, not just the module — so that a module
 * which is merely OLD (stale cache, half-rolled deploy) degrades instead of
 * throwing. Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nShared-module contract — apps may only call what the modules export');

// The browser globals and the files that provide them.
const MODULES = {
  WMAddr: 'address-normalize.js',
  WMLifecycle: 'wm-lifecycle.js'
};

// Every app that loads them.
const APPS = ['westmere-rider.html', 'westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html']
  .filter(exists);

function exportsOf(moduleFile) {
  const src = read(moduleFile);
  const names = new Set();
  // `return { a: a, b: b }` / `key: fn,` in the export object
  for (const m of src.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*\s*,?\s*$/gm)) names.add(m[1]);
  // and anything attached directly, e.g. WMAddr.foo = ...
  for (const m of src.matchAll(/(?:WMAddr|WMLifecycle)\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return names;
}

test('every shared module referenced by an app exists in the repo', () => {
  for (const [globalName, file] of Object.entries(MODULES)) {
    assert.ok(exists(file), file + ' is missing — ' + globalName + ' would be undefined in every app');
  }
});

test('every WMAddr.* / WMLifecycle.* an app calls is exported by its module', () => {
  const problems = [];
  const exportsByGlobal = {};
  for (const [globalName, file] of Object.entries(MODULES)) exportsByGlobal[globalName] = exportsOf(file);

  for (const app of APPS) {
    const src = read(app);
    for (const globalName of Object.keys(MODULES)) {
      const re = new RegExp('\\b' + globalName + '\\.([A-Za-z_$][\\w$]*)\\s*\\(', 'g');
      for (const m of src.matchAll(re)) {
        const fn = m[1];
        if (!exportsByGlobal[globalName].has(fn)) {
          problems.push(app + ' calls ' + globalName + '.' + fn + '() but ' + MODULES[globalName] + ' does not export it');
        }
      }
    }
  }
  assert.strictEqual(problems.join('\n      '), '',
    'an app calls into a shared module function that is not shipped. This is the ' +
    '"WMAddr.flightFor is not a function" outage: every trip row threw and the ' +
    'account showed "No trips found" to customers with trips.\n      ' +
    problems.join('\n      '));
});

test('the account page checks the FUNCTION, not just the module, before calling', () => {
  const rider = read('westmere-rider.html');
  for (const helper of ['_shortAddr', '_bagsText', '_flightOf']) {
    const m = rider.match(new RegExp('function ' + helper + '\\([\\s\\S]{0,400}?\\n\\}'));
    assert.ok(m, 'westmere-rider.html no longer defines ' + helper + '()');
    assert.ok(/typeof\s+WM(Addr|Lifecycle)\.[A-Za-z_$][\w$]*\s*===\s*'function'/.test(m[0]),
      helper + '() must verify the function exists before calling it. Checking only the ' +
      'module (window.WMAddr ? …) is what shipped the outage: the module was present but ' +
      'older than the page, so the call threw.');
  }
});

test('a trip row never depends on a shared helper to survive', () => {
  // Belt and braces: even if a helper throws, the row guard must catch it.
  const rider = read('westmere-rider.html');
  const rt = rider.match(/function renderTrips\([\s\S]*?\n\}/);
  assert.ok(rt, 'renderTrips() not found');
  assert.ok(/try\s*\{/.test(rt[0]) && /catch/.test(rt[0]),
    'each trip row must be built inside its own try/catch');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
