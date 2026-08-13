/**
 * My Account resilience guardrail — run with:
 *   node server/tests/account-resilience.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS: an urgent live report that My Account "throws an error" on
 * desktop, right after the dashboard shipped. The investigation found the
 * account had two single points of failure that the dashboard work itself
 * introduced, both of the same shape — a straight-line sequence where the FIRST
 * throw silently kills every step after it:
 *
 *   bootApp():        renderTrips → initCalendar → initTimePicker →
 *                     initPaxPicker → initBagsPicker → updateProfileUI
 *                     One bad booking row, and the date/time/passenger/luggage
 *                     pickers are never built: the booking form is dead and
 *                     nothing on screen says why.
 *
 *   updateProfile():  paintIdentity() and fillMyDetails() were inserted IN
 *                     FRONT of loadServerTrips(). A throw in either means the
 *                     trip list never loads at all — the customer signs in and
 *                     sees an account with no journeys in it. That is exactly
 *                     the "my trips have disappeared" incident, reintroduced by
 *                     a different route (see rider-trips.test.js).
 *
 * The rule this pins: every panel of the account fails ALONE. Rendering is
 * wrapped per call and per row, so a hostile booking, a picker that will not
 * build, or an endpoint having a bad day costs you that one panel — never the
 * page. Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nMy Account — one failing piece must not take the page down');

const rider = read('westmere-rider.html');

function fnSource(name) {
  const start = rider.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'westmere-rider.html no longer defines ' + name + '()');
  let i = rider.indexOf('{', start), depth = 0;
  for (let j = i; j < rider.length; j++) {
    if (rider[j] === '{') depth++;
    else if (rider[j] === '}') { depth--; if (depth === 0) return rider.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name + '()');
}

// ── 1. The isolation helper exists and actually swallows ─────────────────
test('_safe() runs a step, and a throwing step does not propagate', () => {
  const src = fnSource('_safe');
  const sandbox = { console: { error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.strictEqual(sandbox._safe('ok', () => 42), 42, '_safe must return the step result');
  let after = false;
  assert.doesNotThrow(() => {
    sandbox._safe('boom', () => { throw new Error('kaboom'); });
    after = true;
  }, '_safe must not rethrow');
  assert.ok(after, 'execution must continue past a failed step');
});

// ── 2. bootApp: every start-up step is isolated ──────────────────────────
test('bootApp isolates each start-up step (one throw cannot kill the pickers)', () => {
  const boot = fnSource('bootApp');
  for (const step of ['renderTrips', 'initCalendar', 'initTimePicker', 'initPaxPicker', 'initBagsPicker', 'updateProfileUI']) {
    const bare = new RegExp('(^|[^\'"\\w])' + step + '\\s*\\([^)]*\\)\\s*;', 'm');
    const guarded = new RegExp("_safe\\('" + step + "'");
    assert.ok(guarded.test(boot),
      step + '() must run inside _safe() in bootApp — an unguarded throw there stops every ' +
      'later step, which is how a single bad row leaves the booking form with no working pickers');
    // and it must not ALSO be called bare (a leftover unguarded call)
    const withoutSafe = boot.replace(/_safe\([^]*?\}\);/g, '');
    assert.ok(!bare.test(withoutSafe), step + '() must not also be called unguarded in bootApp');
  }
});

// ── 3. updateProfile: the trip load can never be blocked ─────────────────
test('updateProfile cannot be stopped before it loads the trips', () => {
  const up = fnSource('updateProfile');
  assert.ok(/loadServerTrips\(\)/.test(up), 'updateProfile must still load the trips from the server');
  for (const risky of ['paintIdentity', 'fillMyDetails']) {
    assert.ok(new RegExp("_safe\\('" + risky + "'").test(up),
      risky + '() sits in front of loadServerTrips() and must be wrapped — otherwise a throw ' +
      'there means the customer signs in to an account with no journeys in it');
  }
  // structural: nothing unguarded may sit between the top of the function and
  // the loadServerTrips() call except plain DOM writes
  const beforeLoad = up.slice(0, up.indexOf('loadServerTrips()'));
  const bareCalls = (beforeLoad.match(/^\s*[a-zA-Z_$][\w$]*\((?!function)/gm) || [])
    .map(s => s.trim().replace('(', ''))
    .filter(n => !['_safe', 'if', 'for', 'while', 'switch', 'return', 'var'].includes(n));
  assert.deepStrictEqual(bareCalls, [],
    'unguarded call(s) before loadServerTrips(): ' + bareCalls.join(', '));
});

// ── 4. goPage: a tab that cannot populate still opens ────────────────────
test('goPage isolates each tab populate (a failing tab still opens)', () => {
  const gp = fnSource('goPage');
  for (const step of ['renderPayments', 'loadInvoices', 'fillMyDetails']) {
    assert.ok(new RegExp("_safe\\('" + step + "'").test(gp),
      step + '() must run inside _safe() in goPage — a throw there breaks the navigation itself');
  }
});

// ── 5. renderPayments: one bad row must not blank the ledger ─────────────
test('renderPayments survives hostile rows and still renders the good ones', () => {
  const listEl = { innerHTML: '' };
  const warnings = [];
  const sandbox = {
    localStorage: { getItem: () => sandbox.__stored, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: (id) => (id === 'payments-list' ? listEl : null) },
    console: { warn: (...a) => warnings.push(a), error: (...a) => warnings.push(a), log: () => {} },
    esc: (s) => (s == null ? '' : String(s)),
    _shortAddr: (a) => {
      // the real normalizer throws on a non-string; the row guard must absorb it
      if (a && typeof a === 'object') throw new TypeError('address is not a string');
      return a || '';
    },
    PAY_LABEL: { card: 'Card', cash: 'Paid to driver', account: 'On account', invoice: 'Invoiced', pending: 'Not yet chosen' },
    parseFloat, isFinite, Date, JSON, Array, String, Object, Number
  };
  sandbox.__stored = JSON.stringify([
    { ref: 'GOOD-1', from: 'A Road', dest: 'B Road', date: '2026-01-02', fare: 68, payment: 'card', paidAt: '2026-01-01' },
    { ref: 'HOSTILE', from: { not: 'a string' }, dest: ['nope'], date: {}, fare: 40, payment: 'cash', paidAt: '2026-01-01' },
    { ref: 'GOOD-2', from: 'C Road', dest: 'D Road', date: '2026-01-03', fare: 132, payment: 'cash', paidAt: '2026-01-03' }
  ]);
  vm.createContext(sandbox);
  vm.runInContext(
    fnSource('getBookings') + '\n' + fnSource('_money') + '\n' + fnSource('_niceDate') + '\n' + fnSource('renderPayments'),
    sandbox);

  assert.doesNotThrow(() => sandbox.renderPayments(), 'renderPayments must not throw on a hostile row');
  const rendered = (listEl.innerHTML.match(/class="drow"/g) || []).length;
  assert.strictEqual(rendered, 2,
    'the two good payment rows must still render (got ' + rendered + ') — one bad row may cost ' +
    'only itself, never the whole ledger');
  assert.ok(/GOOD-1/.test(listEl.innerHTML) && /GOOD-2/.test(listEl.innerHTML),
    'the good rows on either side of the bad one must both survive');
  assert.ok(warnings.length >= 1, 'a skipped row must be reported to the console, not swallowed silently');
});

// ── 6. The invoice list gets the same treatment ──────────────────────────
test('the invoice list guards each row too', () => {
  const li = fnSource('loadInvoices');
  const forEachBody = li.slice(li.indexOf('invs.forEach'));
  assert.ok(/try\s*\{/.test(forEachBody) && /catch/.test(forEachBody),
    'each invoice row must be built inside its own try/catch, like the trip and payment rows');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
