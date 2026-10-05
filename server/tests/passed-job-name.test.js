/**
 * A PASSED JOB SAYS WHO HAS IT — run with:
 *   node server/tests/passed-job-name.test.js   (also gated by `npm test`)
 *
 * The owner looked at Confirmed and could not tell which of the week was his.
 * Every confirmed booking is allocated to him on the way in, so a job he had
 * passed to Gary looked exactly like one he was driving himself: same card,
 * same chip, the driver's name nowhere on it.
 *
 * SO THE TEST IS "HAS IT BEEN PASSED", NOT "HAS IT GOT A DRIVER". Those are
 * different questions and the second one is true of nearly every job. What
 * marks a job as somebody else's is passed_at — and then who: one of his
 * drivers by name, or the firm it went to, which is not a driver job at all
 * and must not be labelled as one.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = read('westmere-owner.html');
const SRC = strip(OWNER, { html: true });
const THEME = read('westmere-theme.css');

/* The shipped function, lifted and run — not read for keywords. */
const who = new Function('escH', fnBlock(SRC, 'wmWhoIsDriving') + '; return wmWhoIsDriving;')(
  (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'));

test('his own job says nothing — the badge is for the exception', () => {
  assert.strictEqual(who({ driverId: 7, driverName: 'Westmere', driverIsDefault: true }), '',
    'a job he is driving himself is wearing a driver badge');
  assert.strictEqual(who({}), '');
  assert.strictEqual(who(null), '');
});

test('a job passed to a driver shows the driver by name', () => {
  const h = who({ passedAt: '2026-10-11', driverId: 9, driverName: 'Gary Mitchell' });
  assert.ok(/Gary Mitchell/.test(h), 'the driver is not named: ' + h);
  assert.ok(/>Driver</.test(h), 'it does not say what the name is');
  assert.ok(!/firm/.test(h), 'a driver job is labelled as a firm');
});

test('a job passed to a firm shows the FIRM, and is not called a driver', () => {
  const h = who({ passedAt: '2026-10-11', operatorId: 31, operatorName: 'Harding Executive Travel' });
  assert.ok(/Harding Executive Travel/.test(h), 'the firm is not named: ' + h);
  assert.ok(/>Firm</.test(h), 'a firm is being labelled "Driver"');
  assert.ok(/wm-who firm/.test(h), 'the firm variant is not marked, so it cannot look different');
});

test('passed, but the name never arrived — it still says somebody else has it', () => {
  // Better a true "another driver" than a card that reads as his own job.
  const d = who({ passedAt: 'x', driverId: 9 });
  assert.ok(/Another driver/.test(d), d);
  const f = who({ passedAt: 'x', operatorId: 31 });
  assert.ok(/Another firm/.test(f), f);
  // assigned_to_name is the fallback before either of those.
  assert.ok(/Lane Cars/.test(who({ passedAt: 'x', operatorId: 31, assignedToName: 'Lane Cars' })));
});

test('the name is escaped — it comes from a text field somebody typed', () => {
  const h = who({ passedAt: 'x', driverId: 1, driverName: '<script>x</script>' });
  assert.ok(!/<script>/.test(h), 'a driver name is injected raw into the card: ' + h);
});

test('the card actually calls it, on the row with the status chip', () => {
  const card = fnBlock(SRC, 'jobCardHtml');
  assert.ok(/wmWhoIsDriving\(j\)/.test(card), 'the job card never asks who is driving');
  const i = card.indexOf('wmWhoIsDriving(j)');
  // Same row as the customer's name and the status chip — the chip is written
  // immediately after it, so look both ways rather than only behind.
  const near = card.slice(Math.max(0, i - 400), i + 400);
  assert.ok(/stCls/.test(near), 'it is not beside the status chip, where the eye already goes');
  assert.ok(/escH\(j\.name\)/.test(near), 'it has drifted off the name row');
});

test('the owner app carries the fields it needs from the API', () => {
  for (const k of ['passedAt:b.passed_at', 'operatorId:b.operator_id', 'operatorName:b.operator_name']) {
    assert.ok(SRC.includes(k), 'the list does not carry ' + k + ' — the badge can never show');
  }
  const api = read('server/api.js');
  assert.ok(/COALESCE\(op\.company, op\.full_name\) as operator_name/.test(api),
    'the API does not return the operator name');
  assert.ok(/LEFT JOIN customers op ON b\.operator_id = op\.id/.test(api),
    'the operator is not joined, so the name is always empty');
});

test('it is an outline, not a slab, and the label is the house eyebrow', () => {
  const rule = THEME.slice(THEME.indexOf('.wm-who{'), THEME.indexOf('.wm-who-k{'));
  assert.ok(/border:[^;]*var\(--westmere-gold\)/.test(rule), 'the badge lost its edge');
  assert.ok(/background:\s*var\(--westmere-white\)/.test(rule), 'the badge fills — §20');
  assert.ok(/\.wm-who-k\{[\s\S]{0,260}var\(--westmere-gold-ink\)/.test(THEME),
    'the label is not the house eyebrow');
  assert.ok(/\.wm-who\.firm\{/.test(THEME), 'a firm looks identical to a driver');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/passed-job-name\.test\.js/.test(read('package.json')),
    'passed-job-name.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
