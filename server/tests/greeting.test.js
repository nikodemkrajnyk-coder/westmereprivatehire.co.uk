/**
 * HOW WE ADDRESS A CUSTOMER — run with:
 *   node server/tests/greeting.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   Fifteen email templates each carried their own copy of
 *   `(name || '').split(' ')[0]`. That is right only when somebody typed a bare
 *   first name, and this database is full of "Mr J Whitfield" — so every
 *   acknowledgement, estimate, confirmation, cancellation, payment reminder,
 *   invoice and review request opened "Dear Mr,". It had been going out for as
 *   long as the emails have existed.
 *
 *   Fifteen copies is why it survived: fixing one fixed one. There is now a
 *   single greetingName(), and this pins BOTH that the rule is right and that
 *   the duplication has not grown back.
 *
 * THE RULE, in the register a private-hire firm writes in:
 *   title present → Title + surname   ("Mr J Whitfield" → "Mr Whitfield")
 *   no title      → first name        ("Eleanor Whitfield" → "Eleanor")
 *   only initials → the name as given ("J Whitfield" → "J Whitfield")
 *   nothing       → the fallback      ("" → "there")
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('server/email.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// The SHIPPED helper, lifted out of the module it lives in.
const greetingName = new Function(
  SRC.slice(SRC.indexOf('const TITLES'), SRC.indexOf('function escHtml')) + '; return greetingName;'
)();

console.log('\nHow we address a customer');

test('a titled name becomes Title + surname, never the title alone', () => {
  const cases = [
    ['Mr J Whitfield', 'Mr Whitfield'],
    ['Mrs Eleanor Voss', 'Mrs Voss'],
    ['Dr A Patel', 'Dr Patel'],
    ['Ms. Sarah Kaye', 'Ms Kaye'],
    ['MISS Amelia Rowe', 'MISS Rowe'],
    ['Sir Alan Whitfield-Smythe', 'Sir Whitfield-Smythe']
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(greetingName(input), want,
      JSON.stringify(input) + ' greeted as "Dear ' + greetingName(input) + ',"');
  }
  assert.notStrictEqual(greetingName('Mr J Whitfield'), 'Mr', 'the original bug is back');
});

test('an untitled name is greeted by first name', () => {
  assert.strictEqual(greetingName('Eleanor Whitfield'), 'Eleanor');
  assert.strictEqual(greetingName('Eleanor'), 'Eleanor');
  assert.strictEqual(greetingName('  Eleanor  Whitfield '), 'Eleanor', 'extra whitespace breaks it');
});

test('a bare initial is not mistaken for a first name', () => {
  assert.strictEqual(greetingName('J Whitfield'), 'J Whitfield');
  assert.strictEqual(greetingName('J. Whitfield'), 'J. Whitfield');
});

test('an unusable name falls back rather than greeting nobody', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(greetingName(v), 'there', JSON.stringify(v) + ' produced an empty greeting');
  }
  assert.strictEqual(greetingName('Mr'), 'there', 'a title with no name must not be the greeting');
  assert.strictEqual(greetingName('', 'Driver'), 'Driver', 'the caller fallback is ignored');
});

test('every email goes through the ONE helper — no template keeps its own copy', () => {
  const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const strays = [...body.matchAll(/split\(' '\)\[0\]/g)];
  assert.strictEqual(strays.length, 0,
    'a template is back to splitting the name itself — ' + strays.length + ' occurrence(s); ' +
    'that is how "Dear Mr," survived in fifteen places');
  const uses = (body.match(/greetingName\(/g) || []).length;
  assert.ok(uses >= 15, 'expected every greeting to use greetingName(), found ' + uses);
});

test('the rendered emails really say it', async () => {
  process.env.RESEND_API_KEY = 'test_fake';
  let cap = null;
  global.fetch = async (u, o) => { cap = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  delete require.cache[require.resolve('../email')];
  const EMAIL = require('../email');

  await EMAIL.sendCustomerBookingUpdated(
    { ref: 'WPH-G1', name: 'Mr J Whitfield', email: 'a@b.c', pickup: 'A', destination: 'B',
      date: '2026-09-25', time: '04:15', fare: 42, payment: 'pending', pay_token: 't' },
    [{ key: 'time', from: '05:30', to: '04:15' }]);
  assert.ok(/Dear Mr Whitfield,/.test(cap.html), 'the booking-updated email still mis-greets');
  assert.ok(!/Dear Mr,/.test(cap.html), '"Dear Mr," is back');

  await EMAIL.sendCustomerWelcome({ full_name: 'Mrs Eleanor Voss', email: 'a@b.c' });
  assert.ok(/Dear Mrs Voss,/.test(cap.html), 'the welcome email still mis-greets');

  await EMAIL.sendCustomerCancellation(
    { ref: 'WPH-G2', name: 'Dr A Patel', email: 'a@b.c', pickup: 'A', destination: 'B',
      date: '2026-09-25', time: '04:15', fare: 42 });
  assert.ok(/Dear Dr Patel,/.test(cap.html), 'the cancellation email still mis-greets');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/greeting\.test\.js/.test(read('package.json')));
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
